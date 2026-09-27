import { describe, expect, it, vi } from 'vitest'
import { createConnectionService } from './connectionService'

function fakeTransport() {
  let generation = 0
  return {
    get generation() { return generation },
    switchConnection: vi.fn(() => ++generation),
    disconnect: vi.fn(() => ++generation),
    probe: vi.fn(async () => ({ ok: true, readiness: { dispatch_ready: false } })),
    invoke: vi.fn(async () => ({ cursor: 8 })),
  }
}

describe('main-process connection service', () => {
  it('keeps the token out of descriptions and save results', async () => {
    const transport = fakeTransport()
    const service = createConnectionService(transport)
    expect(await service.describe()).toEqual({
      serverUrl: null, configured: false, storageMode: 'memory', generation: 0,
    })
    const result = await service.save({ serverUrl: 'http://127.0.0.1:8000', token: 'sentinel-secret' })
    expect(transport.switchConnection).toHaveBeenCalledWith({
      serverUrl: 'http://127.0.0.1:8000', token: 'sentinel-secret',
    })
    expect(result.description).toEqual({
      serverUrl: 'http://127.0.0.1:8000', configured: true, storageMode: 'memory', generation: 1,
    })
    expect(JSON.stringify(result)).not.toContain('sentinel-secret')
  })

  it('disconnects and advances the generation before later reads', async () => {
    const service = createConnectionService(fakeTransport())
    await service.save({ serverUrl: 'http://127.0.0.1:8000', token: 'fake' })
    expect(await service.disconnect()).toEqual({
      serverUrl: null, configured: false, storageMode: 'memory', generation: 2,
    })
  })
})
