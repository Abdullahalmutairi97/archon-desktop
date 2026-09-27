import { describe, expect, it, vi } from 'vitest'
import type { ConnectionSaveInput } from '../shared/bridge/types'
import { createConnectionService } from './connectionService'
import type { CredentialDescription, StoredConnectionInput } from './storage/credentialStore'

const firstPair = { serverUrl: 'http://127.0.0.1:8000', token: 'first-secret' }
const secondPair = { serverUrl: 'https://archon.example.test', token: 'second-secret' }

function fakeTransport() {
  let generation = 0
  let active: ConnectionSaveInput | undefined
  return {
    get generation() { return generation },
    get active() { return active },
    switchConnection: vi.fn((input: ConnectionSaveInput) => {
      active = input
      return ++generation
    }),
    disconnect: vi.fn(() => {
      active = undefined
      return ++generation
    }),
    probe: vi.fn(async () => ({ ok: true as const, readiness: { dispatch_ready: false } })),
    invoke: vi.fn(async () => ({ cursor: 8 })),
  }
}

function fakeCredentials(options: {
  saved?: StoredConnectionInput
  storageMode?: CredentialDescription['storageMode']
  restoreOnStartup?: boolean
} = {}) {
  let saved = options.saved
  let storageMode = options.storageMode ?? 'protected'
  const credentials = {
    loadConnectionForMainTransport: vi.fn(async () => options.restoreOnStartup === false ? undefined : saved),
    saveConnection: vi.fn(async (input: StoredConnectionInput): Promise<CredentialDescription> => {
      saved = { ...input }
      return { configured: true, storageMode }
    }),
    describe: vi.fn(async (): Promise<CredentialDescription> => ({ configured: saved !== undefined, storageMode })),
    clear: vi.fn(async (): Promise<CredentialDescription> => {
      saved = undefined
      return { configured: false, storageMode }
    }),
    setStorageMode(mode: CredentialDescription['storageMode']) { storageMode = mode },
    currentPair() { return saved },
  }
  return credentials
}

describe('main-process connection service', () => {
  it('restores one protected URL and token pair without probing at startup', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials({ saved: firstPair, storageMode: 'protected' })
    const service = await createConnectionService(transport, credentials)

    expect(transport.switchConnection).toHaveBeenCalledTimes(1)
    expect(transport.switchConnection).toHaveBeenCalledWith(firstPair)
    expect(transport.probe).not.toHaveBeenCalled()
    expect(await service.describe()).toEqual({
      serverUrl: firstPair.serverUrl, configured: true, storageMode: 'protected', generation: 1,
    })
    expect(JSON.stringify(await service.describe())).not.toContain(firstPair.token)
  })

  it('does not restore a memory-only pair after a basic_text restart', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials({ storageMode: 'memory', restoreOnStartup: false })
    const service = await createConnectionService(transport, credentials)

    expect(transport.switchConnection).not.toHaveBeenCalled()
    expect(transport.probe).not.toHaveBeenCalled()
    expect(await service.describe()).toEqual({
      serverUrl: null, configured: false, storageMode: 'memory', generation: 0,
    })
  })

  it('keeps the current connection when persistence of a replacement fails', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials({ saved: firstPair })
    const service = await createConnectionService(transport, credentials)
    credentials.saveConnection.mockRejectedValueOnce(new Error('fixture write failure'))

    await expect(service.save(secondPair)).rejects.toThrow(/fixture write failure/i)
    expect(transport.switchConnection).toHaveBeenCalledTimes(1)
    expect(transport.active).toEqual(firstPair)
    expect(transport.generation).toBe(1)
    expect(transport.probe).not.toHaveBeenCalled()
  })

  it('prevalidates the pair before asking storage to save it', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    const service = await createConnectionService(transport, credentials)

    await expect(service.save({ serverUrl: 'http://192.0.2.1:8000', token: 'invalid-route-token' }))
      .rejects.toThrow(/invalid/i)
    expect(credentials.saveConnection).not.toHaveBeenCalled()
    expect(transport.switchConnection).not.toHaveBeenCalled()
    expect(transport.generation).toBe(0)
  })

  it('switches only after the pair is stored and fences a stale probe from the prior connection', async () => {
    const transport = fakeTransport()
    let resolveFirstProbe: ((value: { ok: true; readiness: { dispatch_ready: boolean } }) => void) | undefined
    transport.probe
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstProbe = resolve }))
      .mockResolvedValueOnce({ ok: true, readiness: { dispatch_ready: true } })
    const credentials = fakeCredentials({ storageMode: 'memory' })
    const service = await createConnectionService(transport, credentials)

    const firstSave = service.save(firstPair)
    await new Promise((resolve) => setImmediate(resolve))
    expect(credentials.currentPair()).toEqual(firstPair)
    expect(transport.active).toEqual(firstPair)
    expect(transport.generation).toBe(1)
    expect(credentials.saveConnection.mock.invocationCallOrder[0])
      .toBeLessThan(transport.switchConnection.mock.invocationCallOrder[0])

    const secondSave = service.save(secondPair)
    await expect(secondSave).resolves.toMatchObject({
      description: { serverUrl: secondPair.serverUrl, storageMode: 'memory', generation: 2 },
      probe: { ok: true },
    })
    expect(credentials.currentPair()).toEqual(secondPair)
    resolveFirstProbe?.({ ok: true, readiness: { dispatch_ready: false } })
    await expect(firstSave).rejects.toThrow(/changed/i)
  })

  it('rejects a result if a second connection switches while its description is pending', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    let resolveDescription: ((value: CredentialDescription) => void) | undefined
    credentials.describe.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDescription = resolve
    }))
    const service = await createConnectionService(transport, credentials)

    const firstSave = service.save(firstPair)
    await new Promise((resolve) => setImmediate(resolve))
    expect(credentials.describe).toHaveBeenCalledTimes(1)
    await expect(service.save(secondPair)).resolves.toMatchObject({
      description: { serverUrl: secondPair.serverUrl, generation: 2 },
    })
    resolveDescription?.({ configured: true, storageMode: 'protected' })
    await expect(firstSave).rejects.toThrow(/changed/i)
  })

  it('clears the saved pair before disconnecting and omits tokens from results', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials({ storageMode: 'memory' })
    const service = await createConnectionService(transport, credentials)
    const result = await service.save(firstPair)
    expect(JSON.stringify(result)).not.toContain(firstPair.token)

    const disconnected = await service.disconnect()
    expect(transport.disconnect).toHaveBeenCalledTimes(1)
    expect(credentials.clear).toHaveBeenCalledTimes(1)
    expect(credentials.clear.mock.invocationCallOrder[0])
      .toBeLessThan(transport.disconnect.mock.invocationCallOrder[0])
    expect(credentials.currentPair()).toBeUndefined()
    expect(disconnected).toEqual({
      serverUrl: null, configured: false, storageMode: 'memory', generation: 2,
    })
  })

  it('keeps the connection active and accurately described when durable clear fails', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials({ saved: firstPair })
    const service = await createConnectionService(transport, credentials)
    credentials.clear.mockRejectedValueOnce(new Error('fixture remove failure'))

    await expect(service.disconnect()).rejects.toThrow(/fixture remove failure/i)
    expect(transport.disconnect).not.toHaveBeenCalled()
    expect(transport.active).toEqual(firstPair)
    expect(transport.generation).toBe(1)
    expect(credentials.currentPair()).toEqual(firstPair)
    expect(await service.describe()).toEqual({
      serverUrl: firstPair.serverUrl, configured: true, storageMode: 'protected', generation: 1,
    })
  })

  it('keeps the transport disconnected when paired storage is corrupt or from a future version', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    credentials.loadConnectionForMainTransport.mockRejectedValueOnce(new Error('fixture corrupt pair'))
    const service = await createConnectionService(transport, credentials)

    expect(transport.switchConnection).not.toHaveBeenCalled()
    expect(transport.probe).not.toHaveBeenCalled()
    expect(await service.describe()).toEqual({
      serverUrl: null, configured: false, storageMode: 'unavailable', generation: 0,
    })
  })
})
