import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from 'node:fs/promises'
import { dirname, parse, relative, resolve, sep, join } from 'node:path'
import { createProfilePaths, type ProfilePaths } from './profileStore'

const CREDENTIAL_FORMAT = 'archon-desktop-credential'
const CONNECTION_CREDENTIAL_FORMAT = 'archon-desktop-connection-credential'
const CREDENTIAL_VERSION = 1
const MAX_TOKEN_LENGTH = 8192
const MAX_SERVER_URL_LENGTH = 4096
const MAX_CREDENTIAL_FILE_BYTES = 32 * 1024
const LINUX_PROTECTED_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export type CredentialStorageMode = 'memory' | 'protected' | 'unavailable'

export interface CredentialDescription {
  configured: boolean
  storageMode: CredentialStorageMode
}

export type CredentialStoreErrorCode =
  | 'credential_invalid'
  | 'credential_corrupt'
  | 'future_credential_version'
  | 'credential_storage_failed'

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode

  constructor(code: CredentialStoreErrorCode, message: string) {
    super(message)
    this.name = 'CredentialStoreError'
    this.code = code
  }
}

export interface CredentialStoreOptions {
  profileRoot: string
  safeStorage: SafeStoragePort | null
  platform?: NodeJS.Platform | string
  /** A narrow fault-injection seam for verifying protected-write fallback. */
  writeCredential?: (path: string, bytes: Buffer) => Promise<void>
}

export type StoredConnectionInput = {
  serverUrl: string
  token: string
}

interface StoredCiphertext {
  version: number
  algorithm: 'electron-safeStorage'
  ciphertext: string
}

interface StoredTokenCredential extends StoredCiphertext {
  format: typeof CREDENTIAL_FORMAT
}

interface StoredConnectionCredential extends StoredCiphertext {
  format: typeof CONNECTION_CREDENTIAL_FORMAT
}

type StoredCredential = StoredTokenCredential | StoredConnectionCredential

type MemoryCredential =
  | { kind: 'token'; token: string }
  | ({ kind: 'connection' } & StoredConnectionInput)

export class CredentialStore {
  readonly paths: ProfilePaths
  private readonly safeStorage: SafeStoragePort | null
  private readonly platform: string
  private readonly writeCredential: (path: string, bytes: Buffer) => Promise<void>
  private memoryCredential: MemoryCredential | null = null
  private memoryOnlyOverride = false

  constructor(options: CredentialStoreOptions) {
    this.paths = createProfilePaths(options.profileRoot)
    this.safeStorage = options.safeStorage
    this.platform = options.platform ?? process.platform
    this.writeCredential = options.writeCredential ?? writeCredentialFile
  }

  async describe(): Promise<CredentialDescription> {
    const protectedBackend = this.isProtectedBackend() && !this.memoryOnlyOverride
    const inMemory = this.memoryCredential !== null
    let persisted = false
    if (!inMemory) {
      persisted = await this.hasCredentialFile()
    }
    return {
      configured: inMemory || (protectedBackend && persisted),
      storageMode: !protectedBackend && persisted ? 'unavailable' : protectedBackend ? 'protected' : 'memory',
    }
  }

  async loadTokenForMainTransport(): Promise<string | undefined> {
    if (this.memoryCredential !== null) return this.memoryCredential.token
    if (!this.isProtectedBackend() || this.memoryOnlyOverride) {
      if (await this.hasCredentialFile()) {
        throw new CredentialStoreError('credential_storage_failed', 'A protected credential exists but its storage backend is unavailable.')
      }
      return undefined
    }

    const bytes = await readCredentialFile(this.paths.connectionFile)
    if (bytes === null) return undefined
    const record = parseCredential(bytes)
    const plaintext = decryptCredential(this.safeStorage!, record)
    if (record.format === CREDENTIAL_FORMAT) {
      const token = parseDecryptedToken(plaintext)
      this.memoryCredential = { kind: 'token', token }
      return token
    }
    const connection = parseConnectionPayload(plaintext)
    this.memoryCredential = { kind: 'connection', ...connection }
    return connection.token
  }

  async loadConnectionForMainTransport(): Promise<StoredConnectionInput | undefined> {
    if (this.memoryCredential !== null) {
      return this.memoryCredential.kind === 'connection'
        ? { serverUrl: this.memoryCredential.serverUrl, token: this.memoryCredential.token }
        : undefined
    }
    if (!this.isProtectedBackend() || this.memoryOnlyOverride) {
      if (await this.hasCredentialFile()) {
        throw new CredentialStoreError('credential_storage_failed', 'A protected connection exists but its storage backend is unavailable.')
      }
      return undefined
    }

    const bytes = await readCredentialFile(this.paths.connectionFile)
    if (bytes === null) return undefined
    const record = parseCredential(bytes)
    if (record.format === CREDENTIAL_FORMAT) return undefined
    const connection = parseConnectionPayload(decryptCredential(this.safeStorage!, record))
    this.memoryCredential = { kind: 'connection', ...connection }
    return { ...connection }
  }

  async saveToken(token: string): Promise<CredentialDescription> {
    validateToken(token)
    await this.validateCurrentCredentialRecord()
    if (!this.isProtectedBackend()) {
      await removeCredentialFile(this.paths.connectionFile)
      this.memoryCredential = { kind: 'token', token }
      this.memoryOnlyOverride = false
      return this.describe()
    }

    try {
      const encrypted = this.safeStorage!.encryptString(token)
      if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0 || encrypted.byteLength > MAX_CREDENTIAL_FILE_BYTES) {
        throw new Error('invalid encrypted payload')
      }
      const record: StoredCredential = {
        format: CREDENTIAL_FORMAT,
        version: CREDENTIAL_VERSION,
        algorithm: 'electron-safeStorage',
        ciphertext: encrypted.toString('base64'),
      }
      const bytes = Buffer.from(JSON.stringify(record))
      await this.writeCredential(this.paths.connectionFile, bytes)
      this.memoryCredential = { kind: 'token', token }
      this.memoryOnlyOverride = false
      return this.describe()
    } catch {
      // If encryption/storage fails, retire any previous token before retaining this one in memory.
      await removeCredentialFile(this.paths.connectionFile)
      this.memoryCredential = { kind: 'token', token }
      this.memoryOnlyOverride = true
      return this.describe()
    }
  }

  async saveConnection(input: StoredConnectionInput): Promise<CredentialDescription> {
    validateConnectionInput(input)
    await this.validateCurrentCredentialRecord()
    const connection: StoredConnectionInput = { serverUrl: input.serverUrl, token: input.token }
    if (!this.isProtectedBackend()) {
      await removeCredentialFile(this.paths.connectionFile)
      this.memoryCredential = { kind: 'connection', ...connection }
      this.memoryOnlyOverride = false
      return this.describe()
    }

    try {
      const payload = JSON.stringify(connection)
      const encrypted = this.safeStorage!.encryptString(payload)
      if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0 || encrypted.byteLength > MAX_CREDENTIAL_FILE_BYTES) {
        throw new Error('invalid encrypted payload')
      }
      const record: StoredConnectionCredential = {
        format: CONNECTION_CREDENTIAL_FORMAT,
        version: CREDENTIAL_VERSION,
        algorithm: 'electron-safeStorage',
        ciphertext: encrypted.toString('base64'),
      }
      await this.writeCredential(this.paths.connectionFile, Buffer.from(JSON.stringify(record)))
      this.memoryCredential = { kind: 'connection', ...connection }
      this.memoryOnlyOverride = false
      return this.describe()
    } catch {
      // Keep URL and token together in memory and retire any earlier record on fallback.
      await removeCredentialFile(this.paths.connectionFile)
      this.memoryCredential = { kind: 'connection', ...connection }
      this.memoryOnlyOverride = true
      return this.describe()
    }
  }

  async clear(): Promise<CredentialDescription> {
    this.memoryCredential = null
    this.memoryOnlyOverride = false
    await removeCredentialFile(this.paths.connectionFile)
    return this.describe()
  }

  private isProtectedBackend(): boolean {
    if (!this.safeStorage) return false
    let available = false
    try {
      available = this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
    if (!available) return false
    if (this.platform === 'linux') {
      try {
        return LINUX_PROTECTED_BACKENDS.has(this.safeStorage.getSelectedStorageBackend())
      } catch {
        return false
      }
    }
    // Electron uses the OS keychain on macOS and DPAPI on Windows. Other platforms are fail-closed.
    return this.platform === 'darwin' || this.platform === 'win32'
  }

  private async hasCredentialFile(): Promise<boolean> {
    try {
      await assertNoSymlinkSegments(this.paths.connectionFile)
      const metadata = await lstat(this.paths.connectionFile)
      return metadata.isFile() && !metadata.isSymbolicLink()
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return false
      throw new CredentialStoreError('credential_storage_failed', 'The saved credential file could not be inspected safely.')
    }
  }

  private async validateCurrentCredentialRecord(): Promise<void> {
    const bytes = await readCredentialFile(this.paths.connectionFile)
    if (bytes === null) return
    const record = parseCredential(bytes)
    if (!this.isProtectedBackend()) return
    const plaintext = decryptCredential(this.safeStorage!, record)
    if (record.format === CREDENTIAL_FORMAT) parseDecryptedToken(plaintext)
    else parseConnectionPayload(plaintext)
  }
}

function validateToken(token: unknown): asserts token is string {
  if (typeof token !== 'string'
    || token.length === 0
    || token.length > MAX_TOKEN_LENGTH
    || token.trim() !== token
    || /[\u0000-\u001f\u007f-\u009f]/u.test(token)) {
    throw new CredentialStoreError('credential_invalid', 'The credential value is invalid or outside supported limits.')
  }
}

function validateConnectionInput(input: unknown): asserts input is StoredConnectionInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CredentialStoreError('credential_invalid', 'The connection details are invalid.')
  }
  const candidate = input as Record<string, unknown>
  const serverUrl = candidate.serverUrl
  if (typeof serverUrl !== 'string'
    || serverUrl.length === 0
    || serverUrl.length > MAX_SERVER_URL_LENGTH
    || serverUrl.trim() !== serverUrl
    || /[\u0000-\u0020\u007f-\u009f\\]/u.test(serverUrl)
    || serverUrl.includes('?')
    || serverUrl.includes('#')) {
    throw new CredentialStoreError('credential_invalid', 'The server URL is invalid or outside supported limits.')
  }
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    throw new CredentialStoreError('credential_invalid', 'The server URL is invalid or outside supported limits.')
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname))) {
    throw new CredentialStoreError('credential_invalid', 'The server URL must use HTTPS or a loopback HTTP address without embedded credentials.')
  }
  validateToken(candidate.token)
}

function isLoopbackHost(hostnameValue: string): boolean {
  const hostname = hostnameValue.toLowerCase().replace(/^\[|\]$/gu, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') return true
  const octets = hostname.split('.')
  if (octets.length !== 4 || octets[0] !== '127') return false
  return octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
}

function parseCredential(bytes: Buffer): StoredCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new CredentialStoreError('credential_corrupt', 'The saved credential record is corrupt; it was left unchanged.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialStoreError('credential_corrupt', 'The saved credential record is not recognized; it was left unchanged.')
  }
  const record = parsed as Record<string, unknown>
  if ((record.format !== CREDENTIAL_FORMAT && record.format !== CONNECTION_CREDENTIAL_FORMAT)
    || !Number.isInteger(record.version)
    || (record.version as number) < 1) {
    throw new CredentialStoreError('credential_corrupt', 'The saved credential record is not recognized; it was left unchanged.')
  }
  if ((record.version as number) > CREDENTIAL_VERSION) {
    throw new CredentialStoreError('future_credential_version', 'The saved credential was created by a newer version; it was left unchanged.')
  }
  if (record.algorithm !== 'electron-safeStorage'
    || typeof record.ciphertext !== 'string'
    || record.ciphertext.length === 0
    || record.ciphertext.length > MAX_CREDENTIAL_FILE_BYTES * 2
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(record.ciphertext)
    || Object.keys(record).length !== 4) {
    throw new CredentialStoreError('credential_corrupt', 'The saved credential record is not recognized; it was left unchanged.')
  }
  return {
    format: record.format as typeof CREDENTIAL_FORMAT | typeof CONNECTION_CREDENTIAL_FORMAT,
    version: record.version as number,
    algorithm: 'electron-safeStorage',
    ciphertext: record.ciphertext,
  } as StoredCredential
}

function decryptCredential(safeStorage: SafeStoragePort, record: StoredCredential): string {
  try {
    return safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64'))
  } catch {
    throw new CredentialStoreError('credential_corrupt', 'The saved credential could not be opened safely; it was left unchanged.')
  }
}

function parseDecryptedToken(plaintext: string): string {
  try {
    validateToken(plaintext)
    return plaintext
  } catch {
    throw new CredentialStoreError('credential_corrupt', 'The saved credential could not be opened safely; it was left unchanged.')
  }
}

function parseConnectionPayload(plaintext: string): StoredConnectionInput {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext) as unknown
  } catch {
    throw new CredentialStoreError('credential_corrupt', 'The saved connection record is corrupt; it was left unchanged.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialStoreError('credential_corrupt', 'The saved connection record is not recognized; it was left unchanged.')
  }
  const payload = parsed as Record<string, unknown>
  if (Object.keys(payload).length !== 2) {
    throw new CredentialStoreError('credential_corrupt', 'The saved connection record is not recognized; it was left unchanged.')
  }
  try {
    validateConnectionInput({ serverUrl: payload.serverUrl, token: payload.token })
  } catch {
    throw new CredentialStoreError('credential_corrupt', 'The saved connection record is invalid; it was left unchanged.')
  }
  return { serverUrl: payload.serverUrl as string, token: payload.token as string }
}

async function readCredentialFile(path: string): Promise<Buffer | null> {
  try {
    await assertNoSymlinkSegments(path)
    await validateExistingDirectory(dirname(path))
  } catch {
    throw new CredentialStoreError('credential_storage_failed', 'The credential path contains an unsafe symbolic link.')
  }
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw new CredentialStoreError('credential_storage_failed', 'The saved credential file could not be inspected safely.')
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CREDENTIAL_FILE_BYTES) {
    throw new CredentialStoreError('credential_corrupt', 'The saved credential file is not a bounded regular file; it was left unchanged.')
  }
  try {
    const bytes = await readFile(path)
    if (bytes.byteLength > MAX_CREDENTIAL_FILE_BYTES) {
      throw new CredentialStoreError('credential_corrupt', 'The saved credential file exceeds the supported size; it was left unchanged.')
    }
    return bytes
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error
    throw new CredentialStoreError('credential_storage_failed', 'The saved credential file could not be read safely.')
  }
}

async function writeCredentialFile(path: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength > MAX_CREDENTIAL_FILE_BYTES) {
    throw new CredentialStoreError('credential_storage_failed', 'The encrypted credential exceeds the supported size.')
  }
  const directory = dirname(path)
  await assertNoSymlinkSegments(directory).catch(() => {
    throw new CredentialStoreError('credential_storage_failed', 'The credential path contains an unsafe symbolic link.')
  })
  await mkdirPrivateDirectory(dirname(directory))
  await mkdirPrivateDirectory(directory)
  await assertNoSymlinkSegments(path).catch(() => {
    throw new CredentialStoreError('credential_storage_failed', 'The credential path contains an unsafe symbolic link.')
  })
  const existing = await lstat(path).catch((error: unknown) => hasErrorCode(error, 'ENOENT') ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new CredentialStoreError('credential_storage_failed', 'The saved credential destination is not a safe regular file.')
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
  } catch {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw new CredentialStoreError('credential_storage_failed', 'The encrypted credential could not be written safely.')
  }
}

async function removeCredentialFile(path: string): Promise<void> {
  try {
    await assertNoSymlinkSegments(path)
    await validateExistingDirectory(dirname(path))
  } catch {
    throw new CredentialStoreError('credential_storage_failed', 'The credential path contains an unsafe symbolic link.')
  }
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw new CredentialStoreError('credential_storage_failed', 'The saved credential could not be inspected safely.')
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CredentialStoreError('credential_storage_failed', 'The saved credential is not a safe regular file.')
  }
  try {
    await unlink(path)
  } catch {
    throw new CredentialStoreError('credential_storage_failed', 'The saved credential could not be removed safely.')
  }
}

async function validateExistingDirectory(path: string): Promise<void> {
  try {
    await assertNoSymlinkSegments(path)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new CredentialStoreError('credential_storage_failed', 'The credential directory is not a safe real directory.')
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    if (error instanceof CredentialStoreError) throw error
    throw new CredentialStoreError('credential_storage_failed', 'The credential directory could not be inspected safely.')
  }
}

async function mkdirPrivateDirectory(path: string): Promise<void> {
  try {
    await assertNoSymlinkSegments(path)
    await mkdir(path, { recursive: true, mode: 0o700 })
    await assertNoSymlinkSegments(path)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('unsafe directory')
    const canonical = await realpath(path)
    if (canonical !== path) throw new Error('linked directory')
    await chmod(path, 0o700)
  } catch {
    throw new CredentialStoreError('credential_storage_failed', 'The credential directory could not be created safely.')
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
