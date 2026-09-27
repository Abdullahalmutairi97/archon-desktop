import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const PROFILE_FORMAT = 'archon-desktop-profile'
const PROFILE_VERSION = 1
const MAX_SETTINGS_BYTES = 1024 * 1024
const MAX_ASSET_BYTES = 5 * 1024 * 1024
const MAX_MIGRATION_ASSETS_BYTES = 20 * 1024 * 1024
const MAX_MIGRATION_ASSETS = 256
const MAX_JSON_DEPTH = 40
const MAX_JSON_NODES = 30_000
const ALLOWED_ASSET_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])

export interface ProfilePaths {
  profileRoot: string
  profileManifestFile: string
  settingsFile: string
  assetsDirectory: string
  chromiumUserDataDirectory: string
  connectionDirectory: string
  connectionFile: string
  codexMetadataDirectory: string
  codexMetadataFile: string
}

export function createProfilePaths(profileRoot: string): ProfilePaths {
  const root = resolve(profileRoot)
  return {
    profileRoot: root,
    profileManifestFile: join(root, 'profile.json'),
    settingsFile: join(root, 'settings.json'),
    assetsDirectory: join(root, 'assets'),
    chromiumUserDataDirectory: join(root, 'chromium-user-data'),
    connectionDirectory: join(root, 'connection'),
    connectionFile: join(root, 'connection', 'connection.json'),
    codexMetadataDirectory: join(root, 'codex'),
    codexMetadataFile: join(root, 'codex', 'metadata.json'),
  }
}

export type ProfileStoreErrorCode =
  | 'profile_root_invalid'
  | 'profile_manifest_corrupt'
  | 'future_profile_version'
  | 'legacy_profile_requires_migration'
  | 'settings_corrupt'
  | 'settings_invalid'
  | 'settings_too_large'
  | 'migration_source_invalid'
  | 'migration_source_changed'
  | 'migration_target_not_empty'
  | 'migration_preview_invalid'
  | 'migration_asset_invalid'

export class ProfileStoreError extends Error {
  readonly code: ProfileStoreErrorCode

  constructor(code: ProfileStoreErrorCode, message: string) {
    super(message)
    this.name = 'ProfileStoreError'
    this.code = code
  }
}

export interface MigrationAssetPreview {
  relativePath: string
  bytes: number
}

export interface MigrationPreview {
  previewId: string
  sourceVersion: string
  targetVersion: number
  settingsKeys: string[]
  omittedSecretFields: number
  assets: MigrationAssetPreview[]
  connectionCredentials: 'not-imported'
}

export interface MigrationCopyResult {
  sourceVersion: string
  targetVersion: number
  copiedAssetCount: number
  omittedSecretFields: number
}

interface JsonRecord {
  [key: string]: JsonValue
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord

interface SourceFile {
  relativePath: string
  bytes: Buffer
  sha256: string
}

interface MigrationSnapshot {
  sourceRoot: string
  sourceVersion: string
  settings: JsonRecord
  assets: SourceFile[]
  omittedSecretFields: number
  signature: string
}

interface PendingPreview {
  snapshot: MigrationSnapshot
  createdAt: number
}

export interface ProfileStoreOptions {
  profileRoot: string
  /** A narrow fault-injection seam for verifying first-write recovery. */
  writeAtomic?: (path: string, bytes: Buffer) => Promise<void>
}

export class ProfileStore {
  readonly paths: ProfilePaths
  private readonly previews = new Map<string, PendingPreview>()
  private readonly writeAtomic: (path: string, bytes: Buffer) => Promise<void>

  constructor(options: ProfileStoreOptions) {
    this.paths = createProfilePaths(options.profileRoot)
    const write = options.writeAtomic ?? atomicWrite
    this.writeAtomic = async (path, bytes) => {
      try {
        await write(path, bytes)
      } catch (error) {
        if (error instanceof ProfileStoreError) throw error
        throw new ProfileStoreError('profile_root_invalid', 'A profile file could not be written atomically.')
      }
    }
  }

  async readSettings(): Promise<JsonRecord> {
    const rootExists = await ensureRootDirectoryIfPresent(this.paths.profileRoot)
    if (!rootExists) return {}

    const manifestBytes = await readOptionalFile(this.paths.profileManifestFile, 16 * 1024)
    const settingsBytes = await readOptionalFile(this.paths.settingsFile, MAX_SETTINGS_BYTES)
    if (manifestBytes === null) {
      if (settingsBytes !== null) {
        throw new ProfileStoreError(
          'legacy_profile_requires_migration',
          'This profile has unversioned settings. Preview and copy a synthetic migration before using it.',
        )
      }
      return {}
    }

    validateProfileManifest(manifestBytes)
    if (settingsBytes === null) return {}
    return sanitizeSettings(parseSettings(settingsBytes))
  }

  async mergeSettings(patch: unknown): Promise<JsonRecord> {
    const cleanPatch = sanitizeSettings(patch)
    const current = await this.readSettings()
    const merged = deepMerge(current, cleanPatch)
    const serialized = serializeSettings(merged)

    await mkdirPrivate(this.paths.profileRoot)
    const existingManifest = await readOptionalFile(this.paths.profileManifestFile, 16 * 1024)
    if (existingManifest !== null) validateProfileManifest(existingManifest)
    if (existingManifest === null) {
      // Publish the marker first so a failed initial settings write remains an empty, retryable profile.
      await this.writeAtomic(this.paths.profileManifestFile, Buffer.from(JSON.stringify({
        format: PROFILE_FORMAT,
        version: PROFILE_VERSION,
      }, null, 2)))
    }
    await this.writeAtomic(this.paths.settingsFile, serialized)
    return merged
  }

  async previewMigration(sourceRoot: string): Promise<MigrationPreview> {
    const snapshot = await readMigrationSnapshot(sourceRoot, this.paths.profileRoot)
    const previewId = randomUUID()
    this.previews.set(previewId, { snapshot, createdAt: Date.now() })
    return {
      previewId,
      sourceVersion: snapshot.sourceVersion,
      targetVersion: PROFILE_VERSION,
      settingsKeys: Object.keys(snapshot.settings).sort(),
      omittedSecretFields: snapshot.omittedSecretFields,
      assets: snapshot.assets.map(({ relativePath, bytes }) => ({
        relativePath,
        bytes: bytes.byteLength,
      })),
      connectionCredentials: 'not-imported',
    }
  }

  async copyMigration(previewId: string): Promise<MigrationCopyResult> {
    const pending = this.previews.get(previewId)
    if (!pending || Date.now() - pending.createdAt > 30 * 60 * 1000) {
      this.previews.delete(previewId)
      throw new ProfileStoreError('migration_preview_invalid', 'The migration preview is missing or expired.')
    }

    const current = await readMigrationSnapshot(pending.snapshot.sourceRoot, this.paths.profileRoot)
    if (current.signature !== pending.snapshot.signature) {
      throw new ProfileStoreError('migration_source_changed', 'The migration source changed after preview; create a new preview.')
    }
    await assertMigrationTargetAbsent(this.paths.profileRoot)

    const targetParent = dirname(this.paths.profileRoot)
    await assertNoSymlinkSegments(targetParent).catch(() => {
      throw new ProfileStoreError('profile_root_invalid', 'The configured profile path contains a symbolic link.')
    })
    await mkdir(targetParent, { recursive: true, mode: 0o700 })
    await assertNoSymlinkSegments(targetParent).catch(() => {
      throw new ProfileStoreError('profile_root_invalid', 'The configured profile path contains a symbolic link.')
    })
    const canonicalParent = await realpath(targetParent).catch(() => null)
    if (canonicalParent !== targetParent) {
      throw new ProfileStoreError('profile_root_invalid', 'The configured profile path contains a symbolic link.')
    }

    const stagingRoot = join(targetParent, `.${this.paths.profileRoot.split(sep).at(-1)}.migration-${randomUUID()}`)
    try {
      await mkdir(stagingRoot, { mode: 0o700 })
      const targetAssetMap = new Map<string, string>()
      for (const asset of pending.snapshot.assets) {
        const assetPath = asset.relativePath.split('/').join(sep)
        const destination = join(stagingRoot, 'assets', assetPath)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await atomicWrite(destination, asset.bytes)
        const sourcePath = resolve(pending.snapshot.sourceRoot, assetPath)
        targetAssetMap.set(sourcePath, join(this.paths.assetsDirectory, assetPath))
      }

      const settings = rebaseAssetReferences(pending.snapshot.settings, pending.snapshot.sourceRoot, targetAssetMap)
      if (!isRecord(settings)) throw new ProfileStoreError('settings_invalid', 'Migrated settings must remain a JSON object.')
      await atomicWrite(join(stagingRoot, 'settings.json'), serializeSettings(settings))
      // The manifest is the commit marker, so a partially written profile is never treated as initialized.
      await atomicWrite(join(stagingRoot, 'profile.json'), Buffer.from(JSON.stringify({
        format: PROFILE_FORMAT,
        version: PROFILE_VERSION,
      }, null, 2)))
      await chmod(stagingRoot, 0o700)
      await rename(stagingRoot, this.paths.profileRoot)
      this.previews.delete(previewId)
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof ProfileStoreError) throw error
      if (isExistsError(error)) {
        throw new ProfileStoreError('migration_target_not_empty', 'The migration target already exists.')
      }
      throw new ProfileStoreError('profile_root_invalid', 'The profile could not be copied safely.')
    }

    return {
      sourceVersion: pending.snapshot.sourceVersion,
      targetVersion: PROFILE_VERSION,
      copiedAssetCount: pending.snapshot.assets.length,
      omittedSecretFields: pending.snapshot.omittedSecretFields,
    }
  }
}

function isExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST'
}

function hash(bytes: Buffer | null): string {
  return createHash('sha256').update(bytes ?? Buffer.from('<absent>')).digest('hex')
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent))
}

async function readMigrationSnapshot(sourceRootValue: string, targetRoot: string): Promise<MigrationSnapshot> {
  if (typeof sourceRootValue !== 'string' || sourceRootValue.trim() === '') {
    throw new ProfileStoreError('migration_source_invalid', 'Choose an explicit source directory for migration preview.')
  }
  const sourceRoot = resolve(sourceRootValue)
  if (isWithin(sourceRoot, targetRoot) || isWithin(targetRoot, sourceRoot)) {
    throw new ProfileStoreError('migration_source_invalid', 'The migration source and target must be separate directories.')
  }
  try {
    await assertNoSymlinkSegments(sourceRoot)
    const rootStat = await lstat(sourceRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('bad root')
  } catch {
    throw new ProfileStoreError('migration_source_invalid', 'The selected migration source is not a safe directory.')
  }

  const manifestBytes = await readOptionalFile(join(sourceRoot, 'profile.json'), 16 * 1024, 'migration_source_invalid')
  let sourceVersion = 'legacy-unversioned'
  if (manifestBytes !== null) {
    let manifest: unknown
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown
    } catch {
      throw new ProfileStoreError('migration_source_invalid', 'The selected profile manifest is corrupt.')
    }
    if (!isRecord(manifest) || manifest.format !== PROFILE_FORMAT || !Number.isInteger(manifest.version) || (manifest.version as number) < 1) {
      throw new ProfileStoreError('migration_source_invalid', 'The selected profile manifest is not recognized.')
    }
    if ((manifest.version as number) > PROFILE_VERSION) {
      throw new ProfileStoreError('future_profile_version', 'The selected profile was created by a newer version and cannot be migrated safely.')
    }
    sourceVersion = `v${manifest.version as number}`
  }

  const settingsBytes = await readOptionalFile(join(sourceRoot, 'settings.json'), MAX_SETTINGS_BYTES, 'migration_source_invalid')
  const sourceSettings = settingsBytes === null ? {} : parseSettings(settingsBytes, 'migration_source_invalid')
  const sanitized = sanitizeSettingsWithCount(sourceSettings)
  const assets = await readMigrationAssets(sourceRoot)
  const signatureData = JSON.stringify({
    sourceVersion,
    manifest: hash(manifestBytes),
    settings: hash(settingsBytes),
    assets: assets.map(({ relativePath, sha256 }) => [relativePath, sha256]),
  })
  return {
    sourceRoot,
    sourceVersion,
    settings: sanitized.value,
    assets,
    omittedSecretFields: sanitized.omittedSecretFields,
    signature: createHash('sha256').update(signatureData).digest('hex'),
  }
}

async function readMigrationAssets(sourceRoot: string): Promise<SourceFile[]> {
  const assets: SourceFile[] = []
  let totalBytes = 0
  for (const folder of ['backgrounds', 'brand']) {
    const directory = join(sourceRoot, folder)
    let entries: string[]
    try {
      await assertNoSymlinkSegments(directory)
      const directoryStat = await lstat(directory)
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new ProfileStoreError('migration_asset_invalid', 'A migration asset directory is not safe.')
      }
      entries = await readdir(directory)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) continue
      if (error instanceof ProfileStoreError) throw error
      throw new ProfileStoreError('migration_asset_invalid', 'A migration asset directory could not be read safely.')
    }
    for (const entry of entries.sort()) {
      if (entry === '.' || entry === '..' || entry !== entry.trim() || entry.includes('/') || entry.includes('\\')) continue
      if (!ALLOWED_ASSET_EXTENSIONS.has(extname(entry).toLowerCase())) continue
      if (assets.length >= MAX_MIGRATION_ASSETS) {
        throw new ProfileStoreError('migration_asset_invalid', 'The migration contains too many assets.')
      }
      const assetPath = join(directory, entry)
      let metadata
      try {
        await assertNoSymlinkSegments(assetPath)
        metadata = await lstat(assetPath)
      } catch {
        throw new ProfileStoreError('migration_asset_invalid', 'A migration asset could not be inspected.')
      }
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ASSET_BYTES) {
        throw new ProfileStoreError('migration_asset_invalid', 'A migration asset is not a bounded regular file.')
      }
      totalBytes += metadata.size
      if (totalBytes > MAX_MIGRATION_ASSETS_BYTES) {
        throw new ProfileStoreError('migration_asset_invalid', 'The migration asset collection is too large.')
      }
      let bytes: Buffer
      try {
        bytes = await readFile(assetPath)
      } catch {
        throw new ProfileStoreError('migration_asset_invalid', 'A migration asset could not be read.')
      }
      if (bytes.byteLength !== metadata.size) {
        throw new ProfileStoreError('migration_source_changed', 'A migration asset changed while it was previewed.')
      }
      const relativePath = `${folder}/${entry}`
      assets.push({ relativePath, bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  return assets
}

function rebaseAssetReferences(value: JsonValue, sourceRoot: string, assets: Map<string, string>): JsonValue {
  if (typeof value === 'string') {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
    const possiblePath = resolve(isAbsolute(value) ? value : join(sourceRoot, value))
    const rebased = assets.get(possiblePath)
    return rebased ?? value
  }
  if (Array.isArray(value)) return value.map((item) => rebaseAssetReferences(item, sourceRoot, assets))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      rebaseAssetReferences(item, sourceRoot, assets),
    ]))
  }
  return value
}

function validateProfileManifest(bytes: Buffer): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new ProfileStoreError('profile_manifest_corrupt', 'The profile manifest is corrupt; existing files were left untouched.')
  }
  if (!isRecord(parsed) || parsed.format !== PROFILE_FORMAT || !Number.isInteger(parsed.version) || (parsed.version as number) < 1) {
    throw new ProfileStoreError('profile_manifest_corrupt', 'The profile manifest is not recognized; existing files were left untouched.')
  }
  if ((parsed.version as number) > PROFILE_VERSION) {
    throw new ProfileStoreError('future_profile_version', 'This profile was created by a newer version; existing files were left untouched.')
  }
}

function parseSettings(bytes: Buffer, code: 'settings_corrupt' | 'migration_source_invalid' = 'settings_corrupt'): JsonRecord {
  if (bytes.byteLength > MAX_SETTINGS_BYTES) {
    throw new ProfileStoreError('settings_too_large', 'Settings exceed the supported size limit; existing files were left untouched.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new ProfileStoreError(code, 'Settings are corrupt; existing files were left untouched.')
  }
  if (!isRecord(parsed)) {
    throw new ProfileStoreError(code, 'Settings must contain a JSON object; existing files were left untouched.')
  }
  try {
    assertJsonBounded(parsed)
  } catch {
    throw new ProfileStoreError('settings_invalid', 'Settings exceed supported structural limits; existing files were left untouched.')
  }
  return parsed
}

function serializeSettings(settings: JsonRecord): Buffer {
  try {
    assertJsonBounded(settings)
    const bytes = Buffer.from(JSON.stringify(settings))
    if (bytes.byteLength > MAX_SETTINGS_BYTES) {
      throw new ProfileStoreError('settings_too_large', 'Settings exceed the supported size limit.')
    }
    return bytes
  } catch (error) {
    if (error instanceof ProfileStoreError) throw error
    throw new ProfileStoreError('settings_invalid', 'Settings must be bounded JSON data.')
  }
}

function sanitizeSettings(value: unknown): JsonRecord {
  return sanitizeSettingsWithCount(value).value
}

function sanitizeSettingsWithCount(value: unknown): { value: JsonRecord; omittedSecretFields: number } {
  if (!isRecord(value)) {
    throw new ProfileStoreError('settings_invalid', 'Settings updates must be a JSON object.')
  }
  let omittedSecretFields = 0
  let nodes = 0
  const visit = (current: unknown, depth: number): JsonValue | undefined => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new ProfileStoreError('settings_invalid', 'Settings exceed supported structural limits.')
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      if (typeof current === 'string' && current.length > 256 * 1024) {
        throw new ProfileStoreError('settings_invalid', 'A setting value exceeds the supported size limit.')
      }
      if (typeof current === 'string' && isCredentialBearingValue(current)) {
        omittedSecretFields += 1
        return undefined
      }
      return current
    }
    if (typeof current === 'number' && Number.isFinite(current)) return current
    if (Array.isArray(current)) {
      const clean: JsonValue[] = []
      for (const item of current) {
        const safeItem = visit(item, depth + 1)
        if (safeItem !== undefined) clean.push(safeItem)
      }
      return clean
    }
    if (isRecord(current)) {
      const clean: JsonRecord = {}
      for (const [key, item] of Object.entries(current)) {
        if (key.length > 256) throw new ProfileStoreError('settings_invalid', 'A setting key exceeds the supported size limit.')
        if (isSecretKey(key)) {
          omittedSecretFields += 1
          continue
        }
        const safeItem = visit(item, depth + 1)
        if (safeItem !== undefined) clean[key] = safeItem
      }
      return clean
    }
    throw new ProfileStoreError('settings_invalid', 'Settings must be JSON-compatible values.')
  }
  const clean = visit(value, 0)
  if (!isRecord(clean)) throw new ProfileStoreError('settings_invalid', 'Settings updates must be a JSON object.')
  return { value: clean, omittedSecretFields }
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return /(?:token|secret|password|passphrase|credential|authorization|apikey|privatekey|cookie|cookies|bearer|auth)$/.test(normalized)
    || ['auth', 'bearer', 'credentials', 'clientkey', 'sessionkey', 'setcookie'].includes(normalized)
}

function isCredentialBearingValue(value: string): boolean {
  if (/\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+\S+/iu.test(value)
    || /\b(?:bearer|basic)\s+\S+/iu.test(value)
    || /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]*=/iu.test(value)) {
    return true
  }

  const urls = value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu) ?? []
  for (const candidate of urls) {
    try {
      const url = new URL(candidate.replace(/[),.;\]}]+$/u, ''))
      if (url.username !== '' || url.password !== '') return true
      for (const name of url.searchParams.keys()) {
        if (isCredentialQueryName(name)) return true
      }
      const fragment = url.hash.slice(1)
      const fragmentParams = new URLSearchParams(fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment)
      for (const name of fragmentParams.keys()) {
        if (isCredentialQueryName(name)) return true
      }
    } catch {
      // Malformed URL-like strings are retained as unknown data; valid credential URLs are filtered above.
    }
  }
  return false
}

function isCredentialQueryName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return isSecretKey(normalized)
    || ['session', 'sessionid', 'sid', 'code', 'key', 'auth'].includes(normalized)
}

function assertJsonBounded(value: unknown): void {
  let nodeCount = 0
  const visit = (current: unknown, depth: number): void => {
    nodeCount += 1
    if (nodeCount > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('too many')
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return
    if (typeof current === 'number' && Number.isFinite(current)) return
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1)
      return
    }
    if (isRecord(current)) {
      for (const item of Object.values(current)) visit(item, depth + 1)
      return
    }
    throw new Error('not JSON')
  }
  visit(value, 0)
}

function deepMerge(current: JsonRecord, patch: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(merged[key])) merged[key] = deepMerge(merged[key] as JsonRecord, value)
    else merged[key] = value
  }
  return merged
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function ensureRootDirectoryIfPresent(root: string): Promise<boolean> {
  try {
    await assertNoSymlinkSegments(root)
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ProfileStoreError('profile_root_invalid', 'The configured profile root must be a real directory.')
    }
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false
    if (error instanceof ProfileStoreError) throw error
    throw new ProfileStoreError('profile_root_invalid', 'The configured profile root could not be inspected safely.')
  }
}

async function mkdirPrivate(root: string): Promise<void> {
  try {
    await assertNoSymlinkSegments(root)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await assertNoSymlinkSegments(root)
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('not a directory')
    await chmod(root, 0o700)
  } catch {
    throw new ProfileStoreError('profile_root_invalid', 'The configured profile root could not be created safely.')
  }
}

async function readOptionalFile(path: string, maxBytes: number, errorCode?: ProfileStoreErrorCode): Promise<Buffer | null> {
  let metadata
  try {
    await assertNoSymlinkSegments(path)
    metadata = await lstat(path)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw new ProfileStoreError(errorCode ?? 'profile_root_invalid', 'A profile file could not be inspected safely.')
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    const code = metadata.size > maxBytes && path.endsWith('settings.json') ? 'settings_too_large' : (errorCode ?? 'profile_root_invalid')
    throw new ProfileStoreError(code, 'A profile file is not a bounded regular file.')
  }
  try {
    const bytes = await readFile(path)
    if (bytes.byteLength > maxBytes) {
      const code = path.endsWith('settings.json') ? 'settings_too_large' : (errorCode ?? 'profile_root_invalid')
      throw new ProfileStoreError(code, 'A profile file exceeds the supported size limit.')
    }
    return bytes
  } catch (error) {
    if (error instanceof ProfileStoreError) throw error
    throw new ProfileStoreError(errorCode ?? 'profile_root_invalid', 'A profile file could not be read safely.')
  }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  try {
    await assertNoSymlinkSegments(dirname(path))
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await assertNoSymlinkSegments(path)
  } catch {
    throw new ProfileStoreError('profile_root_invalid', 'A profile directory contains a symbolic link or unsafe path segment.')
  }
  const existing = await lstat(path).catch((error: unknown) => hasErrorCode(error, 'ENOENT') ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new ProfileStoreError('profile_root_invalid', 'A profile destination is not a safe regular file.')
  }
  const temporary = `${path}.tmp-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    if (error instanceof ProfileStoreError) throw error
    throw new ProfileStoreError('profile_root_invalid', 'A profile file could not be written atomically.')
  }
}

async function assertMigrationTargetAbsent(targetRoot: string): Promise<void> {
  try {
    await assertNoSymlinkSegments(targetRoot)
    await lstat(targetRoot)
    throw new ProfileStoreError('migration_target_not_empty', 'The migration target already exists and will not be overwritten.')
  } catch (error) {
    if (error instanceof ProfileStoreError) throw error
    if (!hasErrorCode(error, 'ENOENT')) {
      throw new ProfileStoreError('profile_root_invalid', 'The migration target could not be inspected safely.')
    }
  }
}

async function assertNoSymlinkSegments(path: string): Promise<void> {
  const absolutePath = resolve(path)
  const root = parse(absolutePath).root
  const segments = relative(root, absolutePath).split(sep).filter(Boolean)
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return
      throw error
    }
    if (metadata.isSymbolicLink() || (index < segments.length - 1 && !metadata.isDirectory())) {
      throw new Error('Symbolic link or non-directory path segment')
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
