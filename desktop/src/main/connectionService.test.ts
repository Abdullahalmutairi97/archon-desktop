import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProbeResult, ConnectionSaveInput } from '../shared/bridge/types'
import { createConnectionService } from './connectionService'
import type { CredentialDescription, StoredConnectionInput } from './storage/credentialStore'
import { BackendTransportError } from './transport/backendTransport'

const firstPair = { serverUrl: 'http://127.0.0.1:8000', token: 'first-secret' }
const secondPair = { serverUrl: 'https://archon.example.test', token: 'second-secret' }
const pairedLocal = { serverUrl: 'http://127.0.0.1:43123', token: 'ephemeral-local-secret', expiresAt: Math.floor(Date.now() / 1000) + 86400 }

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
    probe: vi.fn(async (): Promise<ConnectionProbeResult> => active
      ? ({ ok: true as const, readiness: { dispatch_ready: false } })
      : ({ ok: false as const, error: { code: 'not_connected', message: 'No connection.' } })),
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

  it('pairs locally only without a saved remote and keeps its bearer out of credential storage', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials({ storageMode: 'protected' })
    const localPairing = { pair: vi.fn(async () => pairedLocal) }
    const service = await createConnectionService(transport, credentials, { localPairing })

    expect(localPairing.pair).toHaveBeenCalledOnce()
    expect(transport.switchConnection).toHaveBeenCalledWith({ serverUrl: pairedLocal.serverUrl, token: pairedLocal.token })
    expect(credentials.saveConnection).not.toHaveBeenCalled()
    expect(credentials.currentPair()).toBeUndefined()
    expect(await service.describe()).toEqual({
      serverUrl: pairedLocal.serverUrl, configured: true, storageMode: 'memory', generation: 1,
      localPairingAvailable: true,
    })
    expect(JSON.stringify(await service.describe())).not.toContain(pairedLocal.token)
  })

  it('keeps a saved remote authoritative and treats an absent local socket as optional', async () => {
    const remoteTransport = fakeTransport()
    const savedCredentials = fakeCredentials({ saved: firstPair })
    const localPairing = { pair: vi.fn(async () => pairedLocal) }
    await createConnectionService(remoteTransport, savedCredentials, { localPairing })
    expect(localPairing.pair).not.toHaveBeenCalled()
    expect(remoteTransport.active).toEqual(firstPair)

    const disconnectedTransport = fakeTransport()
    const disconnectedCredentials = fakeCredentials()
    const absentPairing = { pair: vi.fn(async () => { throw new Error('socket unavailable') }) }
    const service = await createConnectionService(disconnectedTransport, disconnectedCredentials, { localPairing: absentPairing })
    expect(disconnectedTransport.switchConnection).not.toHaveBeenCalled()
    expect(await service.describe()).toEqual({
      serverUrl: null, configured: false, storageMode: 'memory', generation: 0, localPairingAvailable: true,
    })
  })

  it('rejects workspace handoff on a saved remote loopback connection', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials({ saved: firstPair })
    const localPairing = { pair: vi.fn(async () => pairedLocal) }
    const service = await createConnectionService(transport, credentials, { localPairing })

    await expect(service.getPairedLocalWorkspace(`workspace-${'a'.repeat(32)}`))
      .rejects.toThrow(/active local archon pairing/i)
    expect(localPairing.pair).not.toHaveBeenCalled()
    expect(transport.invoke).not.toHaveBeenCalled()
  })

  it('uses the active same-user pairing for a workspace GET and rejects a mismatched identity', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    const localPairing = { pair: vi.fn(async () => pairedLocal) }
    const service = await createConnectionService(transport, credentials, { localPairing })
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const workspace = {
      workspace_id: workspaceId, root: '/srv/archon/workspaces/workspace-a', project_id: null,
      base_revision: null, head_revision: null, generation: 1,
    }
    transport.invoke.mockImplementationOnce(async () => ({ workspace }) as never)

    await expect(service.getPairedLocalWorkspace(workspaceId)).resolves.toEqual(workspace)
    expect(transport.invoke).toHaveBeenCalledWith('workspaces.get', { workspaceId })

    transport.invoke.mockImplementationOnce(async () => ({
      workspace: { ...workspace, workspace_id: `workspace-${'b'.repeat(32)}` },
    }) as never)
    await expect(service.getPairedLocalWorkspace(workspaceId)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('rejects a workspace response when the local pairing generation changes in flight', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    const localPairing = { pair: vi.fn(async () => pairedLocal) }
    const service = await createConnectionService(transport, credentials, { localPairing })
    const workspaceId = `workspace-${'e'.repeat(32)}`
    const workspace = {
      workspace_id: workspaceId, root: '/srv/archon/workspaces/workspace-e', project_id: null,
      base_revision: null, head_revision: null, generation: 1,
    }
    let resolveFetch: ((value: unknown) => void) | undefined
    transport.invoke.mockImplementationOnce(() => new Promise<unknown>((resolve) => { resolveFetch = resolve }) as never)
    const pending = service.getPairedLocalWorkspace(workspaceId)
    await new Promise((resolve) => setImmediate(resolve))

    await expect(service.save(secondPair)).resolves.toMatchObject({ description: { generation: 2 } })
    resolveFetch?.({ workspace })
    await expect(pending).rejects.toMatchObject({ code: 'connection_changed' })
    expect(transport.active).toEqual(secondPair)
  })

  it('disconnects an expired local bearer when renewal fails and permits a later retry', async () => {
    vi.useFakeTimers()
    try {
      const nowMs = Date.now()
      vi.setSystemTime(nowMs)
      const expiry = Math.floor(nowMs / 1000) + 1
      const transport = fakeTransport()
      const credentials = fakeCredentials()
      const localPairing = { pair: vi.fn()
        .mockResolvedValueOnce({ ...pairedLocal, expiresAt: expiry })
        .mockRejectedValueOnce(new Error('local service unavailable'))
        .mockResolvedValueOnce({ ...pairedLocal, token: 'renewed-local-secret', expiresAt: expiry + 86_400 }) }
      const service = await createConnectionService(transport, credentials, { localPairing })

      vi.setSystemTime((expiry + 1) * 1000)
      await expect(service.probe()).resolves.toMatchObject({ ok: false, error: { code: 'not_connected' } })
      expect(await service.describe()).toMatchObject({
        serverUrl: null, configured: false, storageMode: 'memory', localPairingAvailable: true,
      })
      expect(transport.disconnect).toHaveBeenCalledOnce()

      await expect(service.probe()).resolves.toMatchObject({ ok: true })
      expect(localPairing.pair).toHaveBeenCalledTimes(3)
      expect(transport.active).toEqual({ serverUrl: pairedLocal.serverUrl, token: 'renewed-local-secret' })
      expect(await service.describe()).toMatchObject({
        serverUrl: pairedLocal.serverUrl, configured: true, storageMode: 'memory', localPairingAvailable: true,
      })
      expect(JSON.stringify(await service.describe())).not.toContain('renewed-local-secret')
    } finally {
      vi.useRealTimers()
    }
  })

  it('pairs again and retries one invoke after an explicit local HTTP 401', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    const localPairing = { pair: vi.fn()
      .mockResolvedValueOnce({ ...pairedLocal, token: 'old-local-token-123456789', expiresAt: pairedLocal.expiresAt })
      .mockResolvedValueOnce({ ...pairedLocal, token: 'fresh-local-token-123456789', expiresAt: pairedLocal.expiresAt })
      .mockResolvedValueOnce({ ...pairedLocal, token: 'refreshed-local-token-123456789', expiresAt: pairedLocal.expiresAt }) }
    const service = await createConnectionService(transport, credentials, { localPairing })
    transport.invoke
      .mockRejectedValueOnce(new BackendTransportError('unauthorized', 401))
      .mockResolvedValueOnce({ cursor: 12 })

    await expect(service.invoke('events.cursor', {})).resolves.toEqual({ cursor: 12 })
    expect(localPairing.pair).toHaveBeenCalledTimes(2)
    expect(transport.invoke).toHaveBeenCalledTimes(2)
    expect(transport.active).toEqual({ serverUrl: pairedLocal.serverUrl, token: 'fresh-local-token-123456789' })
    expect(credentials.saveConnection).not.toHaveBeenCalled()
    expect(JSON.stringify(await service.describe())).not.toContain('fresh-local-token-123456789')

    transport.invoke
      .mockRejectedValueOnce(new BackendTransportError('unauthorized', 401))
      .mockRejectedValueOnce(new BackendTransportError('unauthorized', 401))
    await expect(service.invoke('events.cursor', {})).rejects.toMatchObject({ code: 'unauthorized' })
    expect(localPairing.pair).toHaveBeenCalledTimes(3)
    expect(transport.invoke).toHaveBeenCalledTimes(4)
    expect(transport.active).toEqual({ serverUrl: pairedLocal.serverUrl, token: 'refreshed-local-token-123456789' })
  })

  it('retries a probe after HTTP 401 but does not pair again for HTTP 403', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    const localPairing = { pair: vi.fn()
      .mockResolvedValueOnce({ ...pairedLocal, token: 'old-local-token-123456789', expiresAt: pairedLocal.expiresAt })
      .mockResolvedValueOnce({ ...pairedLocal, token: 'fresh-local-token-123456789', expiresAt: pairedLocal.expiresAt }) }
    const service = await createConnectionService(transport, credentials, { localPairing })
    transport.probe
      .mockResolvedValueOnce({ ok: false, error: { code: 'unauthorized', message: 'Auth rejected' }, authStatus: 401 })
      .mockResolvedValueOnce({ ok: true, readiness: { dispatch_ready: true } })

    await expect(service.probe()).resolves.toMatchObject({ ok: true })
    expect(localPairing.pair).toHaveBeenCalledTimes(2)
    expect(transport.probe).toHaveBeenCalledTimes(2)

    transport.probe.mockResolvedValueOnce({
      ok: false, error: { code: 'unauthorized', message: 'Auth rejected' }, authStatus: 403,
    })
    await expect(service.probe()).resolves.toMatchObject({ ok: false, authStatus: 403 })
    expect(localPairing.pair).toHaveBeenCalledTimes(2)
    expect(transport.probe).toHaveBeenCalledTimes(3)
  })

  it('disconnects the local transport when a 401-triggered pairing attempt fails', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    const localPairing = { pair: vi.fn()
      .mockResolvedValueOnce(pairedLocal)
      .mockRejectedValueOnce(new Error('service restarted during pairing')) }
    const service = await createConnectionService(transport, credentials, { localPairing })
    transport.invoke.mockRejectedValueOnce(new BackendTransportError('unauthorized', 401))

    await expect(service.invoke('events.cursor', {})).rejects.toMatchObject({ code: 'unauthorized' })
    expect(localPairing.pair).toHaveBeenCalledTimes(2)
    expect(transport.disconnect).toHaveBeenCalledOnce()
    expect(transport.active).toBeUndefined()
    expect(await service.describe()).toMatchObject({
      serverUrl: null, configured: false, localPairingAvailable: true,
    })
  })

  it('does not renew for network or unknown invoke failures', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    const localPairing = { pair: vi.fn(async () => pairedLocal) }
    const service = await createConnectionService(transport, credentials, { localPairing })
    transport.invoke
      .mockRejectedValueOnce(new BackendTransportError('network_error'))
      .mockRejectedValueOnce(new BackendTransportError('unauthorized', 403))
      .mockRejectedValueOnce(new Error('unknown failure'))

    await expect(service.invoke('events.cursor', {})).rejects.toMatchObject({ code: 'network_error' })
    await expect(service.invoke('events.cursor', {})).rejects.toMatchObject({ code: 'unauthorized', httpStatus: 403 })
    await expect(service.invoke('events.cursor', {})).rejects.toThrow('unknown failure')
    expect(localPairing.pair).toHaveBeenCalledOnce()
    expect(transport.invoke).toHaveBeenCalledTimes(3)
  })

  it('does not re-pair an old local request after an explicit remote save', async () => {
    const transport = fakeTransport()
    const credentials = fakeCredentials()
    const localPairing = { pair: vi.fn(async () => pairedLocal) }
    const service = await createConnectionService(transport, credentials, { localPairing })
    let rejectInvoke: ((error: Error) => void) | undefined
    transport.invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectInvoke = reject }))

    const pending = service.invoke('events.cursor', {})
    await new Promise((resolve) => setImmediate(resolve))
    await expect(service.save(secondPair)).resolves.toMatchObject({
      description: { serverUrl: secondPair.serverUrl, configured: true },
    })
    rejectInvoke?.(new BackendTransportError('unauthorized', 401))

    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    expect(localPairing.pair).toHaveBeenCalledOnce()
    expect(transport.active).toEqual(secondPair)
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
    const localPairing = { pair: vi.fn(async () => pairedLocal) }
    credentials.loadConnectionForMainTransport.mockRejectedValueOnce(new Error('fixture corrupt pair'))
    const service = await createConnectionService(transport, credentials, { localPairing })

    expect(transport.switchConnection).not.toHaveBeenCalled()
    expect(localPairing.pair).not.toHaveBeenCalled()
    expect(transport.probe).not.toHaveBeenCalled()
    expect(await service.describe()).toEqual({
      serverUrl: null, configured: false, storageMode: 'unavailable', generation: 0,
    })
  })
})
