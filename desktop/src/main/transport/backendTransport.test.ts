import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_CHANNELS, parseBridgeResponse } from '../../shared/bridge/validation'
import {
  BackendTransport,
  BackendTransportError,
  READ_ONLY_OPERATIONS,
  type BackendFetch,
} from './backendTransport'

const localConnection = { serverUrl: 'http://127.0.0.1:8000', token: 'TOKEN_SENTINEL' }

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function readinessResult(dispatchReady: boolean): Record<string, unknown> {
  return {
    dispatch_ready: dispatchReady,
    execution_verified: false,
    credentials_verified: false,
    native_conformance_verified: false,
    storage: { status: 'ready', readable: true, writable: true },
    workers: {
      configured: 1,
      enabled: true,
      live: dispatchReady ? 1 : 0,
      busy: 0,
      items: [],
      scope: 'server_process',
    },
    queue: { queued: 0, running: 0 },
    runtimes: [{
      id: 'prime',
      available: dispatchReady,
      dispatch_ready: dispatchReady,
      check_type: 'executable_file',
      version_verified: false,
    }],
    transport: {
      mode: 'disabled',
      configuration_verified: true,
      private_tls_verified: false,
      verification_level: 'configuration_only',
    },
  }
}

function fetchStub(implementation: BackendFetch = vi.fn(async () => response({ ok: true }))): BackendFetch {
  return implementation
}

describe('backend transport', () => {
  it('exposes only the reviewed read-only operation set', () => {
    expect(READ_ONLY_OPERATIONS).toEqual([
      'readiness',
      'projects.list',
      'sessions.list',
      'tasks.list',
      'events.cursor',
    ])
  })

  it('maps operations to fixed GET routes and keeps bearer credentials in main-process fetch headers', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ projects: [] }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await transport.invoke('projects.list', {})

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [requestUrl, init] = fetcher.mock.calls[0]
    expect(String(requestUrl)).toBe('http://127.0.0.1:8000/api/projects')
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
  })

  it('normalizes only bounded list filters into fixed query parameters', async () => {
    const fetcher = vi.fn<BackendFetch>(async (url: URL) =>
      response(url.pathname === '/api/sessions' ? { sessions: [] } : { tasks: [] }),
    )
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await transport.invoke('sessions.list', { projectId: 'project-1', limit: 37 })
    const requestUrl = new URL(String(fetcher.mock.calls[0][0]))
    expect(requestUrl.pathname).toBe('/api/sessions')
    expect(requestUrl.searchParams.get('project_id')).toBe('project-1')
    expect(requestUrl.searchParams.get('limit')).toBe('37')

    await transport.invoke('tasks.list', { limit: 42 })
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('limit')).toBe('42')
  })

  it('rejects arbitrary operations, URL-shaped input, and invalid list filters before fetch', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ ok: true }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(
      transport.invoke('projects.delete' as never, {} as never),
    ).rejects.toMatchObject({ code: 'unsupported_operation' })
    await expect(transport.invoke('projects.list', { url: 'https://evil.test' } as never)).rejects.toMatchObject(
      { code: 'invalid_payload' },
    )
    await expect(transport.invoke('sessions.list', { projectId: 'x'.repeat(201), limit: 10 } as never)).rejects.toMatchObject(
      { code: 'invalid_payload' },
    )
    await expect(transport.invoke('tasks.list', { limit: 0 } as never)).rejects.toMatchObject({
      code: 'invalid_payload',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts HTTPS endpoints and loopback HTTP only, with no URL credentials, query, or fragment', () => {
    expect(() => new BackendTransport({ serverUrl: 'https://archon.example.test', token: 'x', fetch: fetchStub() })).not.toThrow()
    expect(() => new BackendTransport({ serverUrl: 'http://localhost:8000', token: 'x', fetch: fetchStub() })).not.toThrow()
    expect(() => new BackendTransport({ serverUrl: 'http://[::1]:8000', token: 'x', fetch: fetchStub() })).not.toThrow()

    for (const serverUrl of [
      'http://archon.example.test',
      'http://192.168.1.8:8000',
      'https://user:pass@archon.example.test',
      'https://archon.example.test?token=x',
      'https://archon.example.test/#fragment',
      'https://archon.example.test/prefix/../admin',
      'https://archon.example.test/prefix/%2e%2e/admin',
      'https://archon.example.test/prefix/%252e%252e/admin',
      'https://archon.example.test/prefix/%2fadmin',
      ' https://archon.example.test',
    ]) {
      expect(() => new BackendTransport({ serverUrl, token: 'x', fetch: fetchStub() })).toThrow(
        BackendTransportError,
      )
    }
  })

  it('keeps fixed API routes under a configured HTTPS proxy path prefix', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ projects: [] }))
    const transport = new BackendTransport({
      serverUrl: 'https://archon.example.test/private/archon/',
      token: 'TOKEN_SENTINEL',
      fetch: fetcher,
    })

    await transport.invoke('projects.list', {})

    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://archon.example.test/private/archon/api/projects',
    )
  })

  it('does not follow redirects and returns a token-free error for any redirect response', async () => {
    const fetcher = vi.fn<BackendFetch>(async () =>
      new Response('redirect to https://attacker.test and TOKEN_SENTINEL', {
        status: 302,
        headers: { Location: 'https://attacker.test/collect' },
      }),
    )
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    const failure = await transport.invoke('readiness', {}).catch((error: unknown) => error)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual')
    expect(failure).toMatchObject({ code: 'redirect_rejected' })
    expect(String(failure)).not.toContain('TOKEN_SENTINEL')
    expect(String(failure)).not.toContain('attacker.test')
  })

  it('preserves 503 readiness data as a valid not-ready result', async () => {
    const readiness = readinessResult(false)
    const transport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response(readiness, 503)),
    })

    await expect(transport.invoke('readiness', {})).resolves.toEqual(readiness)
    await expect(transport.probe()).resolves.toEqual({ ok: true, readiness })
  })

  it('does not mistake a generic 503 error body for authenticated readiness', async () => {
    const transport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ detail: 'unexpected failure' }, 503)),
    })

    await expect(transport.invoke('readiness', {})).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(transport.probe()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_response', message: expect.any(String) },
    })
  })

  it('sanitizes server and network errors without exposing bodies, URLs, or credentials', async () => {
    const transport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () =>
        new Response('private detail TOKEN_SENTINEL', { status: 500 }),
      ),
    })
    const serverFailure = await transport.invoke('projects.list', {}).catch((error: unknown) => error)
    expect(serverFailure).toMatchObject({ code: 'http_error' })
    expect(String(serverFailure)).not.toContain('private detail')
    expect(String(serverFailure)).not.toContain('TOKEN_SENTINEL')

    const networkTransport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => {
        throw new Error('fetch failed for https://secret.example with TOKEN_SENTINEL')
      }),
    })
    const networkFailure = await networkTransport.invoke('projects.list', {}).catch((error: unknown) => error)
    expect(networkFailure).toMatchObject({ code: 'network_error' })
    expect(String(networkFailure)).not.toContain('secret.example')
    expect(String(networkFailure)).not.toContain('TOKEN_SENTINEL')
  })

  it('keeps a 401 probe error valid across the main-to-preload response boundary', async () => {
    const transport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ detail: 'TOKEN_SENTINEL' }, 401)),
    })
    const probe = await transport.probe()
    expect(probe).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.connectionProbe, probe)).not.toThrow()
    expect(JSON.stringify(probe)).not.toContain('TOKEN_SENTINEL')
  })

  it('rejects oversized JSON responses before parsing them', async () => {
    const transport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => new Response(`{"value":"${'x'.repeat(2 * 1024 * 1024)}"}`)),
    })

    await expect(transport.invoke('projects.list', {})).rejects.toMatchObject({
      code: 'response_too_large',
    })
  })

  it('aborts and discards in-flight responses when the connection generation changes', async () => {
    let resolveFetch: ((value: Response) => void) | undefined
    let observedSignal: AbortSignal | undefined
    const fetcher: BackendFetch = (_url, init) => {
      observedSignal = init?.signal ?? undefined
      return new Promise((resolve) => {
        resolveFetch = resolve
      })
    }
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    const previousGeneration = transport.generation
    const pending = transport.invoke('projects.list', {})

    transport.switchConnection({ serverUrl: 'https://archon.example.test', token: 'NEXT_TOKEN' })
    expect(transport.generation).toBe(previousGeneration + 1)
    expect(observedSignal?.aborted).toBe(true)
    resolveFetch?.(response({ projects: ['stale'] }))

    await expect(pending).rejects.toMatchObject({ code: 'connection_changed' })
  })

  it('rejects a response whose body cannot be bounded JSON', async () => {
    const transport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => new Response('{"unfinished":')),
    })

    await expect(transport.invoke('projects.list', {})).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
})
