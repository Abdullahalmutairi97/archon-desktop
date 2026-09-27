import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS, parseBridgeRequest, parseBridgeResponse, parseOperationRequest } from './validation'

describe('finite desktop bridge validation', () => {
  it('accepts only the five frozen IPC channels', () => {
    expect(Object.values(BRIDGE_CHANNELS)).toEqual([
      'archon:connection:describe',
      'archon:connection:save',
      'archon:connection:disconnect',
      'archon:connection:probe',
      'archon:api:invoke',
    ])
    expect(parseBridgeRequest(BRIDGE_CHANNELS.connectionDescribe, [])).toEqual({
      channel: BRIDGE_CHANNELS.connectionDescribe,
      args: [],
    })
    expect(() => parseBridgeRequest('anything:else', [])).toThrow(TypeError)
    expect(() => parseBridgeRequest(BRIDGE_CHANNELS.connectionDescribe, ['extra'])).toThrow(TypeError)
  })

  it('validates and copies a credential request without allowing URL credential injection', () => {
    const input = { serverUrl: 'https://archon.example/base', token: 'sentinel-token' }
    const parsed = parseBridgeRequest(BRIDGE_CHANNELS.connectionSave, [input])
    expect(parsed.args).toEqual([input])
    expect(parsed.args[0]).not.toBe(input)
    expect(Object.isFrozen(parsed.args[0])).toBe(true)
    expect(() => parseBridgeRequest(BRIDGE_CHANNELS.connectionSave, [
      { serverUrl: 'https://user:pass@archon.example', token: 'sentinel-token' },
    ])).toThrow(TypeError)
    expect(() => parseBridgeRequest(BRIDGE_CHANNELS.connectionSave, [
      { serverUrl: 'https://archon.example?token=sentinel', token: 'sentinel-token' },
    ])).toThrow(TypeError)
  })

  it('freezes operation names and accepts only bounded known payloads', () => {
    expect(parseOperationRequest('sessions.list', { projectId: 'p-1', limit: 500 })[1]).toEqual({
      projectId: 'p-1', limit: 500,
    })
    expect(parseOperationRequest('tasks.list', { limit: 1 })).toEqual(['tasks.list', { limit: 1 }])
    for (const [operation, payload] of [
      ['not-an-operation', {}],
      ['readiness', { url: 'http://localhost' }],
      ['sessions.list', { projectId: 'x'.repeat(201) }],
      ['sessions.list', { limit: 501 }],
      ['tasks.list', { limit: 0 }],
      ['events.cursor', { after: 12 }],
    ] as const) {
      expect(() => parseOperationRequest(operation, payload)).toThrow(TypeError)
    }
  })

  it('rejects accessors and non-plain objects instead of invoking caller code', () => {
    let invoked = false
    const hostile = Object.defineProperty({}, 'limit', {
      enumerable: true,
      get() {
        invoked = true
        return 10
      },
    })
    expect(() => parseOperationRequest('tasks.list', hostile)).toThrow(TypeError)
    expect(invoked).toBe(false)
    expect(() => parseOperationRequest('tasks.list', new Date())).toThrow(TypeError)
  })

  it('allows only token-free connection response fields and valid probe state', () => {
    const description = {
      serverUrl: 'https://archon.example',
      configured: true,
      storageMode: 'memory',
      generation: 2,
    }
    const readiness = { dispatch_ready: false, credentials_verified: false }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.connectionDescribe, description)).toEqual(description)
    expect(parseBridgeResponse(BRIDGE_CHANNELS.connectionProbe, { ok: true, readiness })).toEqual({ ok: true, readiness })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.connectionSave, {
      description,
      probe: { ok: true, readiness },
    })).toEqual({ description, probe: { ok: true, readiness } })
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.connectionDescribe, {
      ...description,
      token: 'sentinel-token',
    })).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.connectionSave, {
      description: { ...description, access_token: 'sentinel-token' },
      probe: { ok: true, readiness },
    })).toThrow(TypeError)
    expect(parseBridgeResponse(BRIDGE_CHANNELS.connectionProbe, {
      ok: false,
      error: { code: 'probe_failed', message: 'Server is unavailable' },
    })).toEqual({ ok: false, error: { code: 'probe_failed', message: 'Server is unavailable' } })
  })

  it('bounds and copies fixed API result shapes, rejecting credential fields', () => {
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      projects: [{ id: 'p1', name: 'Project', token_count: 2 }],
    }, 'projects.list')).toEqual({ projects: [{ id: 'p1', name: 'Project', token_count: 2 }] })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      dispatch_ready: false,
      credentials_verified: false,
    }, 'readiness')).toEqual({ dispatch_ready: false, credentials_verified: false })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { cursor: 12 }, 'events.cursor')).toEqual({ cursor: 12 })
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      tasks: [{ id: 'task-1', api_token: 'sentinel-token' }],
    }, 'tasks.list')).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      projects: Array.from({ length: 501 }, () => ({ id: 'p' })),
    }, 'projects.list')).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { cursor: -1 }, 'events.cursor')).toThrow(TypeError)
  })
})
