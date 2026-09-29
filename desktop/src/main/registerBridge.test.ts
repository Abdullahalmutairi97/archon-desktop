import { describe, expect, it, vi } from 'vitest'
import { registerBridgeHandlers } from './registerBridge'

function fixture() {
  const handlers = new Map<string, (event: object, ...args: unknown[]) => Promise<unknown>>()
  const ipc = {
    handle: vi.fn((name: string, handler: (event: object, ...args: unknown[]) => Promise<unknown>) => {
      handlers.set(name, handler)
    }),
    removeHandler: vi.fn((name: string) => { handlers.delete(name) }),
  }
  const service = {
    describe: vi.fn(async () => ({ serverUrl: null, configured: false, generation: 0, storageMode: 'memory' as const })),
    save: vi.fn(async () => ({ description: { serverUrl: 'http://127.0.0.1:8000', configured: true, generation: 1, storageMode: 'memory' as const }, probe: { ok: true, readiness: { dispatch_ready: false } } })),
    disconnect: vi.fn(async () => ({ serverUrl: null, configured: false, generation: 2, storageMode: 'memory' as const })),
    probe: vi.fn(async () => ({ ok: false, error: { code: 'disconnected', message: 'No server configured' } })),
    invoke: vi.fn(async () => ({ cursor: 7 })),
  }
  const trusted = { marker: 'top-frame' }
  const guard = vi.fn((event: unknown) => event === trusted)
  const dispose = registerBridgeHandlers(ipc, guard, service)
  return { handlers, ipc, service, trusted, guard, dispose }
}

describe('finite desktop IPC registration', () => {
  it('registers only the five approved channels and unregisters them on disposal', () => {
    const { handlers, dispose } = fixture()
    expect([...handlers.keys()].sort()).toEqual([
      'archon:api:invoke', 'archon:connection:describe', 'archon:connection:disconnect',
      'archon:connection:probe', 'archon:connection:save',
    ])
    dispose()
    expect(handlers.size).toBe(0)
  })

  it('rejects an untrusted frame before reading connection state or receiving a token', async () => {
    const { handlers, service } = fixture()
    await expect(handlers.get('archon:connection:describe')!({},)).rejects.toThrow()
    await expect(handlers.get('archon:connection:save')!({}, { serverUrl: 'http://127.0.0.1:8000', token: 'sentinel' })).rejects.toThrow()
    expect(service.describe).not.toHaveBeenCalled()
    expect(service.save).not.toHaveBeenCalled()
  })

  it('rejects unknown operations and excess arguments before invoking the backend', async () => {
    const { handlers, service, trusted } = fixture()
    await expect(handlers.get('archon:api:invoke')!(trusted, 'arbitrary.fetch', {})).rejects.toThrow()
    await expect(handlers.get('archon:connection:describe')!(trusted, 'extra')).rejects.toThrow()
    expect(service.invoke).not.toHaveBeenCalled()
    expect(service.describe).not.toHaveBeenCalled()
  })

  it('passes a valid bounded operation through the trusted channel', async () => {
    const { handlers, service, trusted } = fixture()
    await expect(handlers.get('archon:api:invoke')!(trusted, 'events.cursor', {})).resolves.toEqual({ cursor: 7 })
    expect(service.invoke).toHaveBeenCalledWith('events.cursor', {})
  })

  it('rejects a token accidentally returned by a main service', async () => {
    const { handlers, service, trusted } = fixture()
    service.describe.mockResolvedValueOnce({
      serverUrl: 'http://127.0.0.1:8000', configured: true, storageMode: 'memory',
      generation: 1, token: 'sentinel',
    } as never)
    await expect(handlers.get('archon:connection:describe')!(trusted)).rejects.toThrow()
  })

  it('allows the audio envelope only for a bounded transcription invoke', async () => {
    const { handlers, service, trusted } = fixture()
    const transcript = { success: true, transcript: 'hello', provider: 'stt' }
    service.invoke.mockResolvedValue(transcript as never)
    const upload = { dataUrl: `data:audio/webm;base64,${Buffer.alloc(200_000, 1).toString('base64')}`, mimeType: 'audio/webm' }
    await expect(handlers.get('archon:api:invoke')!(trusted, 'audio.transcribe', upload)).resolves.toEqual(transcript)
    expect(service.invoke).toHaveBeenCalledTimes(1)

    // The same size under any other operation is refused before the backend.
    await expect(handlers.get('archon:api:invoke')!(trusted, 'tasks.submit', { projectId: 'p', prompt: upload.dataUrl })).rejects.toThrow()
    await expect(handlers.get('archon:connection:save')!(trusted, { serverUrl: 'http://127.0.0.1:8000', token: upload.dataUrl })).rejects.toThrow()
    const oversized = { dataUrl: `data:audio/webm;base64,${Buffer.alloc(25 * 1024 * 1024 + 3, 1).toString('base64')}`, mimeType: 'audio/webm' }
    await expect(handlers.get('archon:api:invoke')!(trusted, 'audio.transcribe', oversized)).rejects.toThrow()
    expect(service.invoke).toHaveBeenCalledTimes(1)
  })

  it('revokes an in-flight response when the trusted frame navigates', async () => {
    const { handlers, service, trusted, guard } = fixture()
    let trustedNow = true
    guard.mockImplementation(() => trustedNow)
    let resolve!: (value: { cursor: number }) => void
    service.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const request = handlers.get('archon:api:invoke')!(trusted, 'events.cursor', {})
    trustedNow = false
    resolve({ cursor: 9 })
    await expect(request).rejects.toThrow()
  })
})
