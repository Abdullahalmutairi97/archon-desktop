import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createProfilePaths,
  ProfileStore,
  ProfileStoreError,
} from './profileStore'

let fixtureRoot: string

beforeEach(async () => {
  fixtureRoot = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), 'archon-profile-store-')),
  )
})

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

describe('ProfileStore', () => {
  it('derives every persistent path from the injected profile root', () => {
    const root = join(fixtureRoot, 'isolated-profile')
    const paths = createProfilePaths(root)

    expect(paths.profileRoot).toBe(resolve(root))
    expect(paths.settingsFile).toBe(join(resolve(root), 'settings.json'))
    expect(paths.assetsDirectory).toBe(join(resolve(root), 'assets'))
    expect(paths.chromiumUserDataDirectory).toBe(join(resolve(root), 'chromium-user-data'))
    expect(paths.connectionDirectory).toBe(join(resolve(root), 'connection'))
    expect(paths.connectionFile).toBe(join(resolve(root), 'connection', 'connection.json'))
    expect(paths.codexMetadataDirectory).toBe(join(resolve(root), 'codex'))
    expect(paths.codexMetadataFile).toBe(join(resolve(root), 'codex', 'metadata.json'))
  })

  it('does not create a profile or scan a home directory when read before setup', async () => {
    const root = join(fixtureRoot, 'not-created')
    const store = new ProfileStore({ profileRoot: root })

    await expect(store.readSettings()).resolves.toEqual({})
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes atomically with private permissions and preserves unknown nonsecret settings', async () => {
    const root = join(fixtureRoot, 'profile')
    const store = new ProfileStore({ profileRoot: root })
    const first = await store.mergeSettings({
      theme: 'sandstone',
      unknownPreference: { preserved: true, nestedName: 'future-setting' },
      localCodexId: 'codex-task:fixture-1',
      readOnly: true,
      token: 'SECRET_SENTINEL',
      apiKey: 'SECOND_SECRET_SENTINEL',
    })

    expect(first).toEqual({
      theme: 'sandstone',
      unknownPreference: { preserved: true, nestedName: 'future-setting' },
      localCodexId: 'codex-task:fixture-1',
      readOnly: true,
    })
    await store.mergeSettings({ fontScale: 1.25 })
    expect(await store.readSettings()).toEqual({
      theme: 'sandstone',
      unknownPreference: { preserved: true, nestedName: 'future-setting' },
      localCodexId: 'codex-task:fixture-1',
      readOnly: true,
      fontScale: 1.25,
    })

    const settingsText = await readFile(store.paths.settingsFile, 'utf8')
    expect(settingsText).not.toContain('SECRET_SENTINEL')
    expect(settingsText).not.toContain('SECOND_SECRET_SENTINEL')
    expect(await readFile(store.paths.profileManifestFile, 'utf8')).toContain('"version": 1')
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(store.paths.settingsFile)).mode & 0o777).toBe(0o600)
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('omits cookie, bearer, inline auth and credential-bearing URL values in merges and migration previews', async () => {
    const root = join(fixtureRoot, 'profile')
    const store = new ProfileStore({ profileRoot: root })
    const secretSettings = {
      keepThisUnknownPreference: { marker: 'still-here' },
      sessionCookie: 'COOKIE_SECRET_SENTINEL',
      sessionAuth: 'SESSION_AUTH_SECRET_SENTINEL',
      requestDescription: 'Authorization: Bearer INLINE_BEARER_SECRET_SENTINEL',
      remoteEndpoint: 'https://user:URL_PASSWORD_SECRET_SENTINEL@api.example.test/path?access_token=URL_TOKEN_SECRET_SENTINEL',
      safeEndpoint: 'https://api.example.test/readiness',
    }

    const merged = await store.mergeSettings(secretSettings)
    expect(merged).toEqual({
      keepThisUnknownPreference: { marker: 'still-here' },
      safeEndpoint: 'https://api.example.test/readiness',
    })
    const persisted = await readFile(store.paths.settingsFile, 'utf8')
    for (const sentinel of Object.values(secretSettings).filter((value): value is string => typeof value === 'string')) {
      if (sentinel !== secretSettings.safeEndpoint) expect(persisted).not.toContain(sentinel)
    }

    const source = join(fixtureRoot, 'synthetic-legacy')
    await mkdir(source)
    await writeFile(join(source, 'settings.json'), JSON.stringify(secretSettings))
    const migrationPreview = await new ProfileStore({ profileRoot: join(fixtureRoot, 'migration-target') })
      .previewMigration(source)

    expect(migrationPreview.settingsKeys).toEqual(['keepThisUnknownPreference', 'safeEndpoint'])
    expect(migrationPreview.omittedSecretFields).toBe(4)
    for (const sentinel of [
      'COOKIE_SECRET_SENTINEL',
      'SESSION_AUTH_SECRET_SENTINEL',
      'INLINE_BEARER_SECRET_SENTINEL',
      'URL_PASSWORD_SECRET_SENTINEL',
      'URL_TOKEN_SECRET_SENTINEL',
    ]) {
      expect(JSON.stringify(migrationPreview)).not.toContain(sentinel)
    }
  })

  it('rejects symlinked ancestor directories before reading or writing a profile', async () => {
    const realParent = join(fixtureRoot, 'real-parent')
    const linkedParent = join(fixtureRoot, 'linked-parent')
    await mkdir(realParent)
    await symlink(realParent, linkedParent)
    const store = new ProfileStore({ profileRoot: join(linkedParent, 'profile') })

    await expect(store.readSettings()).rejects.toMatchObject({ code: 'profile_root_invalid' })
    await expect(store.mergeSettings({ theme: 'fixture' })).rejects.toMatchObject({ code: 'profile_root_invalid' })
    expect(await readdir(realParent)).toEqual([])
  })

  it('keeps a failed first settings write retryable after the manifest commit marker is created', async () => {
    const root = join(fixtureRoot, 'profile')
    let failSettingsWrite = true
    const store = new ProfileStore({
      profileRoot: root,
      writeAtomic: async (path, bytes) => {
        if (path === join(root, 'settings.json') && failSettingsWrite) {
          failSettingsWrite = false
          throw new Error('synthetic write fault')
        }
        await writeFile(path, bytes, { mode: 0o600 })
      },
    })

    await expect(store.mergeSettings({ theme: 'fixture-retry' })).rejects.toMatchObject({
      code: 'profile_root_invalid',
    })
    expect(await readFile(store.paths.profileManifestFile, 'utf8')).toContain('"version": 1')
    await expect(store.readSettings()).resolves.toEqual({})
    await expect(store.mergeSettings({ theme: 'fixture-retry' })).resolves.toEqual({ theme: 'fixture-retry' })
    await expect(store.readSettings()).resolves.toEqual({ theme: 'fixture-retry' })
  })

  it('fails clearly on corrupt or future profile records without resetting their bytes', async () => {
    const root = join(fixtureRoot, 'profile')
    await mkdir(root, { recursive: true })
    const manifestPath = join(root, 'profile.json')
    const settingsPath = join(root, 'settings.json')
    const store = new ProfileStore({ profileRoot: root })

    await writeFile(manifestPath, '{broken', { mode: 0o600 })
    await expect(store.readSettings()).rejects.toMatchObject({ code: 'profile_manifest_corrupt' })
    expect(await readFile(manifestPath, 'utf8')).toBe('{broken')

    await writeFile(manifestPath, JSON.stringify({ format: 'archon-desktop-profile', version: 42 }))
    const futureBytes = await readFile(manifestPath, 'utf8')
    await writeFile(settingsPath, '{"keep":"as-is"}')
    await expect(store.readSettings()).rejects.toMatchObject({ code: 'future_profile_version' })
    expect(await readFile(manifestPath, 'utf8')).toBe(futureBytes)
    expect(await readFile(settingsPath, 'utf8')).toBe('{"keep":"as-is"}')
  })

  it('does not silently replace corrupt settings or accept a legacy file without explicit migration', async () => {
    const root = join(fixtureRoot, 'profile')
    await mkdir(root, { recursive: true })
    const store = new ProfileStore({ profileRoot: root })
    const legacyBytes = '{"theme":"old"}'
    await writeFile(store.paths.settingsFile, legacyBytes)

    await expect(store.readSettings()).rejects.toMatchObject({ code: 'legacy_profile_requires_migration' })
    expect(await readFile(store.paths.settingsFile, 'utf8')).toBe(legacyBytes)

    await writeFile(store.paths.profileManifestFile, JSON.stringify({
      format: 'archon-desktop-profile', version: 1,
    }))
    const corruptBytes = '{"theme":'
    await writeFile(store.paths.settingsFile, corruptBytes)
    await expect(store.readSettings()).rejects.toMatchObject({ code: 'settings_corrupt' })
    expect(await readFile(store.paths.settingsFile, 'utf8')).toBe(corruptBytes)
  })

  it('previews an explicit synthetic legacy source without changing either tree or returning secret values', async () => {
    const source = join(fixtureRoot, 'synthetic-legacy')
    const target = join(fixtureRoot, 'target-profile')
    await mkdir(join(source, 'backgrounds'), { recursive: true })
    await mkdir(join(source, 'brand'), { recursive: true })
    await writeFile(join(source, 'settings.json'), JSON.stringify({
      theme: 'ember',
      preservedUnknown: { enabled: true, marker: 'keep-me' },
      taskId: 'codex-task:local-only',
      readOnly: true,
      accessToken: 'MIGRATION_SECRET_SENTINEL',
      backgroundFile: join(source, 'backgrounds', 'plate.webp'),
      backgroundLibrary: [{
        id: 'plate-1',
        file: join(source, 'backgrounds', 'plate.webp'),
        url: 'archon-asset://local/backgrounds/plate.webp',
      }],
      customMarkFile: join(source, 'brand', 'mark.svg'),
    }), { mode: 0o600 })
    await writeFile(join(source, 'backgrounds', 'plate.webp'), Buffer.from('fixture-background'))
    await writeFile(join(source, 'brand', 'mark.svg'), '<svg></svg>')
    await writeFile(join(source, 'connection.json'), '{"token":"DO_NOT_IMPORT"}')
    const sourceFilesBefore = await Promise.all([
      readFile(join(source, 'settings.json'), 'utf8'),
      readFile(join(source, 'connection.json'), 'utf8'),
      readFile(join(source, 'backgrounds', 'plate.webp')),
      readFile(join(source, 'brand', 'mark.svg'), 'utf8'),
    ])
    const store = new ProfileStore({ profileRoot: target })

    const preview = await store.previewMigration(source)

    expect(preview.sourceVersion).toBe('legacy-unversioned')
    expect(preview.targetVersion).toBe(1)
    expect(preview.settingsKeys).toContain('preservedUnknown')
    expect(preview.settingsKeys).not.toContain('accessToken')
    expect(preview.omittedSecretFields).toBe(1)
    expect(preview.assets.map((asset) => asset.relativePath).sort()).toEqual([
      'backgrounds/plate.webp',
      'brand/mark.svg',
    ])
    expect(preview.connectionCredentials).toBe('not-imported')
    expect(JSON.stringify(preview)).not.toContain('MIGRATION_SECRET_SENTINEL')
    expect(JSON.stringify(preview)).not.toContain('DO_NOT_IMPORT')
    await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await Promise.all([
      readFile(join(source, 'settings.json'), 'utf8'),
      readFile(join(source, 'connection.json'), 'utf8'),
      readFile(join(source, 'backgrounds', 'plate.webp')),
      readFile(join(source, 'brand', 'mark.svg'), 'utf8'),
    ])).toEqual(sourceFilesBefore)
  })

  it('copies only the previewed synthetic fixture, rebases asset references, and leaves the source unchanged', async () => {
    const source = join(fixtureRoot, 'synthetic-legacy')
    const target = join(fixtureRoot, 'target-profile')
    await mkdir(join(source, 'backgrounds'), { recursive: true })
    await writeFile(join(source, 'settings.json'), JSON.stringify({
      theme: 'graphite',
      unknownSavedValue: ['future', 8, false],
      backgroundFile: join(source, 'backgrounds', 'plate.webp'),
      backgroundLibrary: [{
        id: 'plate-1',
        file: join(source, 'backgrounds', 'plate.webp'),
        url: 'archon-asset://local/backgrounds/plate.webp',
      }],
      token: 'NOT_COPIED_SENTINEL',
    }), { mode: 0o600 })
    const assetBytes = Buffer.from('synthetic image bytes')
    await writeFile(join(source, 'backgrounds', 'plate.webp'), assetBytes)
    const before = await readFile(join(source, 'settings.json'), 'utf8')
    const store = new ProfileStore({ profileRoot: target })
    const preview = await store.previewMigration(source)

    const result = await store.copyMigration(preview.previewId)

    expect(result).toMatchObject({
      sourceVersion: 'legacy-unversioned',
      targetVersion: 1,
      copiedAssetCount: 1,
      omittedSecretFields: 1,
    })
    const settings = JSON.parse(await readFile(store.paths.settingsFile, 'utf8')) as Record<string, unknown>
    expect(settings.theme).toBe('graphite')
    expect(settings.unknownSavedValue).toEqual(['future', 8, false])
    expect(settings.token).toBeUndefined()
    expect(settings.backgroundFile).toBe(join(store.paths.assetsDirectory, 'backgrounds', 'plate.webp'))
    expect(await readFile(join(store.paths.assetsDirectory, 'backgrounds', 'plate.webp'))).toEqual(assetBytes)
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe(before)
    expect(await readFile(join(source, 'backgrounds', 'plate.webp'))).toEqual(assetBytes)
    expect(await readFile(store.paths.connectionFile, 'utf8').catch(() => '')).toBe('')
  })

  it('rejects source changes after preview and refuses to overwrite an initialized target', async () => {
    const source = join(fixtureRoot, 'synthetic-legacy')
    const target = join(fixtureRoot, 'target-profile')
    await mkdir(source)
    const sourceSettings = join(source, 'settings.json')
    await writeFile(sourceSettings, '{"theme":"original"}')
    const store = new ProfileStore({ profileRoot: target })
    const preview = await store.previewMigration(source)
    await writeFile(sourceSettings, '{"theme":"changed"}')

    await expect(store.copyMigration(preview.previewId)).rejects.toMatchObject({
      code: 'migration_source_changed',
    })
    await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' })

    await store.mergeSettings({ existing: true })
    const nextPreview = await store.previewMigration(source)
    await expect(store.copyMigration(nextPreview.previewId)).rejects.toMatchObject({
      code: 'migration_target_not_empty',
    })
  })

  it('rejects a profile-root symlink instead of following it', async () => {
    const actualRoot = join(fixtureRoot, 'actual-profile')
    const linkedRoot = join(fixtureRoot, 'linked-profile')
    await mkdir(actualRoot)
    await symlink(actualRoot, linkedRoot)
    await chmod(actualRoot, 0o700)
    const store = new ProfileStore({ profileRoot: linkedRoot })

    await expect(store.mergeSettings({ theme: 'blue' })).rejects.toBeInstanceOf(ProfileStoreError)
    expect(await readdir(actualRoot)).toEqual([])
  })
})
