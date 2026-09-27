import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CredentialStore,
  CredentialStoreError,
  type SafeStoragePort,
} from './credentialStore'

let fixtureRoot: string
const keyring = new Map<string, string>()

beforeEach(async () => {
  fixtureRoot = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), 'archon-credential-store-')),
  )
  keyring.clear()
})

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

function safeStorage(backend: string, available: boolean): SafeStoragePort {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (plainText) => {
      const id = `fixture-cipher-${keyring.size + 1}`
      keyring.set(id, plainText)
      return Buffer.from(id, 'utf8')
    },
    decryptString: (encrypted) => {
      const value = keyring.get(encrypted.toString('utf8'))
      if (value === undefined) throw new Error('fake decryption failed')
      return value
    },
  }
}

describe('CredentialStore', () => {
  it('keeps tokens in main-process memory when encryption is unavailable', async () => {
    const profileRoot = join(fixtureRoot, 'profile')
    const store = new CredentialStore({
      profileRoot,
      platform: 'linux',
      safeStorage: safeStorage('gnome_libsecret', false),
    })

    await store.saveToken('fixture-memory-token')

    expect(await store.loadTokenForMainTransport()).toBe('fixture-memory-token')
    expect(await store.describe()).toEqual({ configured: true, storageMode: 'memory' })
    expect(JSON.stringify(await store.describe())).not.toContain('fixture-memory-token')
    await expect(readdir(join(profileRoot, 'connection'))).rejects.toMatchObject({ code: 'ENOENT' })

    const afterRestart = new CredentialStore({
      profileRoot,
      platform: 'linux',
      safeStorage: safeStorage('gnome_libsecret', false),
    })
    expect(await afterRestart.loadTokenForMainTransport()).toBeUndefined()
  })

  it('never persists when Linux selects basic_text even if encryption reports available', async () => {
    const profileRoot = join(fixtureRoot, 'profile')
    const store = new CredentialStore({
      profileRoot,
      platform: 'linux',
      safeStorage: safeStorage('basic_text', true),
    })

    await store.saveToken('fixture-plaintext-fallback-token')

    expect(await store.describe()).toEqual({ configured: true, storageMode: 'memory' })
    expect(await store.loadTokenForMainTransport()).toBe('fixture-plaintext-fallback-token')
    await expect(readdir(join(profileRoot, 'connection'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists only a protected backend ciphertext and restores it for main transport', async () => {
    const profileRoot = join(fixtureRoot, 'profile')
    const protectedStorage = safeStorage('gnome_libsecret', true)
    const store = new CredentialStore({ profileRoot, platform: 'linux', safeStorage: protectedStorage })

    await store.saveToken('fixture-protected-token')

    const fileBytes = await readFile(store.paths.connectionFile, 'utf8')
    expect(fileBytes).not.toContain('fixture-protected-token')
    expect(JSON.parse(fileBytes)).toMatchObject({
      format: 'archon-desktop-credential',
      version: 1,
      algorithm: 'electron-safeStorage',
    })
    expect(await store.describe()).toEqual({ configured: true, storageMode: 'protected' })
    expect(JSON.stringify(await store.describe())).not.toContain('fixture-protected-token')

    const afterRestart = new CredentialStore({ profileRoot, platform: 'linux', safeStorage: protectedStorage })
    expect(await afterRestart.loadTokenForMainTransport()).toBe('fixture-protected-token')
  })

  it('fails closed for unknown Linux backends and unsupported platforms', async () => {
    const linuxRoot = join(fixtureRoot, 'linux-profile')
    const linuxStore = new CredentialStore({
      profileRoot: linuxRoot,
      platform: 'linux',
      safeStorage: safeStorage('unknown', true),
    })
    await linuxStore.saveToken('fixture-unknown-backend-token')
    expect(await linuxStore.describe()).toEqual({ configured: true, storageMode: 'memory' })
    await expect(readdir(join(linuxRoot, 'connection'))).rejects.toMatchObject({ code: 'ENOENT' })

    const otherRoot = join(fixtureRoot, 'other-profile')
    const otherStore = new CredentialStore({
      profileRoot: otherRoot,
      platform: 'freebsd',
      safeStorage: safeStorage('gnome_libsecret', true),
    })
    await otherStore.saveToken('fixture-unsupported-platform-token')
    expect(await otherStore.describe()).toEqual({ configured: true, storageMode: 'memory' })
    await expect(readdir(join(otherRoot, 'connection'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects corrupt and future credential records without changing their bytes', async () => {
    const profileRoot = join(fixtureRoot, 'profile')
    const connectionDirectory = join(profileRoot, 'connection')
    await mkdir(connectionDirectory, { recursive: true })
    const store = new CredentialStore({
      profileRoot,
      platform: 'linux',
      safeStorage: safeStorage('kwallet6', true),
    })

    await writeFile(store.paths.connectionFile, '{broken', { mode: 0o600 })
    await expect(store.loadTokenForMainTransport()).rejects.toMatchObject({ code: 'credential_corrupt' })
    expect(await readFile(store.paths.connectionFile, 'utf8')).toBe('{broken')

    const future = JSON.stringify({
      format: 'archon-desktop-credential', version: 9, algorithm: 'electron-safeStorage', ciphertext: 'fixture',
    })
    await writeFile(store.paths.connectionFile, future, { mode: 0o600 })
    await expect(store.loadTokenForMainTransport()).rejects.toMatchObject({ code: 'future_credential_version' })
    expect(await readFile(store.paths.connectionFile, 'utf8')).toBe(future)
  })

  it('does not overwrite a corrupt or future record while saving a new token', async () => {
    const profileRoot = join(fixtureRoot, 'profile')
    const connectionDirectory = join(profileRoot, 'connection')
    await mkdir(connectionDirectory, { recursive: true })
    const store = new CredentialStore({
      profileRoot,
      platform: 'linux',
      safeStorage: safeStorage('kwallet', true),
    })
    const future = JSON.stringify({
      format: 'archon-desktop-credential', version: 12, algorithm: 'electron-safeStorage', ciphertext: 'fixture',
    })
    await writeFile(store.paths.connectionFile, future, { mode: 0o600 })

    await expect(store.saveToken('fixture-new-token')).rejects.toMatchObject({ code: 'future_credential_version' })
    expect(await readFile(store.paths.connectionFile, 'utf8')).toBe(future)
  })

  it('rejects symlinked ancestor directories before credential read, write or removal', async () => {
    const realParent = join(fixtureRoot, 'real-parent')
    const linkedParent = join(fixtureRoot, 'linked-parent')
    await mkdir(realParent)
    await symlink(realParent, linkedParent)
    const store = new CredentialStore({
      profileRoot: join(linkedParent, 'profile'),
      platform: 'linux',
      safeStorage: safeStorage('gnome_libsecret', true),
    })

    await expect(store.saveToken('fixture-synthetic-token')).rejects.toMatchObject({ code: 'credential_storage_failed' })
    await expect(store.clear()).rejects.toMatchObject({ code: 'credential_storage_failed' })
    expect(await readdir(realParent)).toEqual([])
  })

  it('removes previous persisted credentials before switching to memory-only mode', async () => {
    const profileRoot = join(fixtureRoot, 'profile')
    const protectedStorage = safeStorage('gnome_libsecret', true)
    const store = new CredentialStore({ profileRoot, platform: 'linux', safeStorage: protectedStorage })
    await store.saveToken('fixture-old-protected-token')

    const memoryOnlyStore = new CredentialStore({
      profileRoot,
      platform: 'linux',
      safeStorage: safeStorage('basic_text', true),
    })
    await memoryOnlyStore.saveToken('fixture-current-memory-token')

    expect(await memoryOnlyStore.loadTokenForMainTransport()).toBe('fixture-current-memory-token')
    await expect(readFile(memoryOnlyStore.paths.connectionFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects empty, whitespace-padded, oversized and control-character tokens', async () => {
    const store = new CredentialStore({
      profileRoot: join(fixtureRoot, 'profile'),
      platform: 'linux',
      safeStorage: safeStorage('basic_text', true),
    })

    for (const invalid of ['', ' padded ', `line\nfeed`, `x${'a'.repeat(8192)}`]) {
      await expect(store.saveToken(invalid)).rejects.toBeInstanceOf(CredentialStoreError)
    }
  })
})
