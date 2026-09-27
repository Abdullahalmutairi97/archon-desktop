import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_CHANNELS, parseBridgeResponse } from '../../shared/bridge/validation'
import {
  BackendTransport,
  BackendTransportError,
  PROJECT_OPERATIONS,
  READ_ONLY_OPERATIONS,
  TASK_OPERATIONS,
  WORKSPACE_OPERATIONS,
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
  it('maps the main-only Local Codex route to a fixed authenticated owner endpoint', async () => {
    const result = {
      taskId: 'codex-task:fixture', projectId: 'codex-project:fixture',
      sessionId: 'codex:session-1', state: 'running',
    }
    const fetcher = vi.fn<BackendFetch>(async () => response(result))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invokeLocalCodex({
      operation: 'turns.start', projectId: result.projectId, prompt: 'inspect',
    })).resolves.toEqual(result)
    const [url, init] = fetcher.mock.calls[0]
    expect(url.pathname).toBe('/api/local/codex/turns')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${localConnection.token}` })
    expect(init?.body).toBe(JSON.stringify({ projectId: result.projectId, prompt: 'inspect' }))
  })

  it('never retries a Local Codex start after an ambiguous network failure', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => { throw new Error('connection lost after request') })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invokeLocalCodex({
      operation: 'turns.start', projectId: 'codex-project:fixture', prompt: 'run once',
    })).rejects.toMatchObject({ code: 'network_error' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('exposes only the reviewed read-only operation set', () => {
    expect(READ_ONLY_OPERATIONS).toEqual([
      'readiness',
      'projects.list',
      'projects.head',
      'sessions.list',
      'tasks.list',
      'events.cursor',
      'workspaces.list',
      'workspaces.get',
      'workspaces.files.list',
      'workspaces.files.read',
      'workspaces.files.diff',
      'workspaces.files.search',
    ])
    expect(TASK_OPERATIONS).toEqual([
      'runtimes.list', 'tasks.submit', 'tasks.get', 'tasks.events', 'tasks.cancel',
    ])
    expect(PROJECT_OPERATIONS).toEqual(['projects.create'])
  })

  it('keeps checkout creation in its own narrow operation set', () => {
    expect(WORKSPACE_OPERATIONS).toEqual([
      'workspaces.provision', 'workspaces.files.write', 'workspaces.files.create',
    ])
  })

  it('maps the bounded Prime task flow to fixed routes and main-owned POST policy', async () => {
    const taskId = 'task_123-ab'
    const task = { id: taskId, status: 'queued', prompt: 'Inspect this project', project_id: 'project-1' }
    const runtime = {
      id: 'prime', aliases: ['default', 'prime'], available: true,
      availability_check: 'executable_file', version: null, version_verified: false,
      availability_note: 'Not a provider or native conformance check.',
      modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }],
      chat_only: false, sandboxed: false,
    }
    const event = {
      seq: 13, task_id: taskId, type: 'task.queued', data: { status: 'queued' },
      created_at: '2026-09-27T00:00:00Z', attempt_id: null,
    }
    const fetcher = vi.fn<BackendFetch>(async (url, init) => {
      if (url.pathname.endsWith('/api/runtimes')) return response({ runtimes: [runtime] })
      if ((url.pathname.endsWith('/api/tasks') || url.pathname.endsWith('/api/workspace-tasks')) && init?.method === 'POST') {
        return response({ task }, 202)
      }
      if (url.pathname.endsWith(`/api/tasks/${taskId}/events`)) return response({ events: [event] })
      if (url.pathname.endsWith(`/api/tasks/${taskId}/cancel`)) return response({ ok: true })
      if (url.pathname.endsWith(`/api/tasks/${taskId}`)) return response({ task })
      return response({ detail: 'not found' }, 404)
    })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('runtimes.list', {})).resolves.toEqual({ runtimes: [runtime] })
    await expect(transport.invoke('tasks.submit', {
      projectId: 'project-1', prompt: 'Inspect this project',
    })).resolves.toEqual({ task })
    await expect(transport.invoke('tasks.get', { taskId })).resolves.toEqual({ task })
    await expect(transport.invoke('tasks.events', { taskId, after: 12 })).resolves.toEqual({ events: [event] })
    await expect(transport.invoke('tasks.cancel', { taskId })).resolves.toEqual({ ok: true })

    expect(fetcher).toHaveBeenCalledTimes(5)
    const [runtimeUrl, runtimeInit] = fetcher.mock.calls[0]
    expect(String(runtimeUrl)).toBe('http://127.0.0.1:8000/api/runtimes')
    expect(runtimeInit?.method).toBe('GET')

    const [submitUrl, submitInit] = fetcher.mock.calls[1]
    expect(String(submitUrl)).toBe('http://127.0.0.1:8000/api/tasks')
    expect(submitInit?.method).toBe('POST')
    expect(submitInit?.redirect).toBe('manual')
    expect(new Headers(submitInit?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(submitInit?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
    expect(new Headers(submitInit?.headers).get('idempotency-key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    )
    const submitBody = JSON.parse(String(submitInit?.body))
    expect(submitBody).toEqual({
      prompt: 'Inspect this project', project_id: 'project-1', profile: 'prime',
      approval_mode: 'auto', chat_only: false,
    })
    expect(submitBody).not.toHaveProperty('cwd')
    expect(submitBody).not.toHaveProperty('session_id')
    expect(submitBody).not.toHaveProperty('model')
    expect(submitBody).not.toHaveProperty('provider')
    expect(submitBody).not.toHaveProperty('skills')
    expect(submitBody).not.toHaveProperty('idempotency_key')

    expect(String(fetcher.mock.calls[2][0])).toBe(`http://127.0.0.1:8000/api/tasks/${taskId}`)
    const eventsUrl = new URL(String(fetcher.mock.calls[3][0]))
    expect(eventsUrl.pathname).toBe(`/api/tasks/${taskId}/events`)
    expect(eventsUrl.searchParams.get('after')).toBe('12')
    expect(String(fetcher.mock.calls[4][0])).toBe(`http://127.0.0.1:8000/api/tasks/${taskId}/cancel`)
    expect(fetcher.mock.calls[4][1]?.method).toBe('POST')

    await transport.invoke('tasks.submit', {
      projectId: 'project-1', prompt: 'Inspect this checkout',
      workspaceId: `workspace-${'a'.repeat(32)}`, workspaceGeneration: 1,
    })
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toBe('http://127.0.0.1:8000/api/workspace-tasks')
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({
      prompt: 'Inspect this checkout',
      workspace_id: `workspace-${'a'.repeat(32)}`, workspace_generation: 1,
    })
  })

  it('rejects unsafe task inputs before fetch', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ ok: true }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('tasks.submit', { projectId: 'project-1', prompt: '' }))
      .rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(transport.invoke('tasks.submit', {
      projectId: 'project-1', prompt: 'x'.repeat(100_001),
    })).rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(transport.invoke('tasks.submit', {
      projectId: 'project-1', prompt: 'work', cwd: '/tmp',
    } as never)).rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(transport.invoke('tasks.get', { taskId: '../outside' }))
      .rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(transport.invoke('tasks.cancel', { taskId: 'task?next=host' }))
      .rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(transport.invoke('tasks.events', { taskId: 'task-1', after: -1 }))
      .rejects.toMatchObject({ code: 'invalid_payload' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not retry an ambiguous task submission failure', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => { throw new Error('connection dropped') })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    const failure = await transport.invoke('tasks.submit', {
      projectId: 'project-1', prompt: 'Do not retry automatically',
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'network_error' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(failure)).not.toContain('TOKEN_SENTINEL')
  })

  it('accepts task submission only when the backend returns HTTP 202', async () => {
    const transport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ task: { id: 'task-1', status: 'queued' } }, 200)),
    })

    await expect(transport.invoke('tasks.submit', {
      projectId: 'project-1', prompt: 'Create a task',
    })).rejects.toMatchObject({ code: 'http_error' })
  })

  it('rejects task reads and events that do not match the requested task and cursor', async () => {
    const wrongTaskTransport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ task: { id: 'different-task', status: 'running' } })),
    })
    await expect(wrongTaskTransport.invoke('tasks.get', { taskId: 'task-1' }))
      .rejects.toMatchObject({ code: 'invalid_response' })

    const mismatchedEventTransport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ events: [{
        seq: 11, task_id: 'different-task', type: 'task.updated', data: {},
        created_at: '2026-09-27T00:00:00Z', attempt_id: null,
      }] })),
    })
    await expect(mismatchedEventTransport.invoke('tasks.events', { taskId: 'task-1', after: 10 }))
      .rejects.toMatchObject({ code: 'invalid_response' })

    const staleEventTransport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ events: [{
        seq: 10, task_id: 'task-1', type: 'task.updated', data: {},
        created_at: '2026-09-27T00:00:00Z', attempt_id: null,
      }] })),
    })
    await expect(staleEventTransport.invoke('tasks.events', { taskId: 'task-1', after: 10 }))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('rejects cross-origin redirects on task submission without following or exposing redirect data', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => new Response('TOKEN_SENTINEL private redirect body', {
      status: 302,
      headers: { Location: 'https://attacker.example/collect' },
    }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    const failure = await transport.invoke('tasks.submit', {
      projectId: 'project-1', prompt: 'Send only to the configured server',
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 'redirect_rejected' })
    expect(String(failure)).not.toContain('attacker.example')
    expect(String(failure)).not.toContain('TOKEN_SENTINEL')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:8000/api/tasks')
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual')
  })

  it('aborts and discards an in-flight task submission when the connection generation changes', async () => {
    let resolveFetch: ((value: Response) => void) | undefined
    let observedSignal: AbortSignal | undefined
    const fetcher = vi.fn<BackendFetch>((_url, init) => {
      observedSignal = init?.signal ?? undefined
      return new Promise((resolve) => { resolveFetch = resolve })
    })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    const pending = transport.invoke('tasks.submit', { projectId: 'project-1', prompt: 'Work' })

    transport.switchConnection({ serverUrl: 'https://archon.example.test', token: 'NEXT_TOKEN' })
    expect(observedSignal?.aborted).toBe(true)
    resolveFetch?.(response({ task: { id: 'task-1', status: 'queued' } }, 202))

    await expect(pending).rejects.toMatchObject({ code: 'connection_changed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
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

  it('registers an existing Git project through the fixed authenticated POST route', async () => {
    const project = { id: 'project-1', name: 'Existing project', primary_path: '/srv/archon/projects/existing' }
    const fetcher = vi.fn<BackendFetch>(async () => response({ project }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('projects.create', {
      name: 'Existing project', path: project.primary_path,
    })).resolves.toEqual({ project })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:8000/api/projects')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${localConnection.token}`)
    expect(headers.get('content-type')).toBe('application/json')
    expect(init?.body).toBe(JSON.stringify({
      name: 'Existing project', path: project.primary_path, existing_git: true,
    }))
  })

  it('loads server-managed workspaces through one fixed read-only route', async () => {
    const workspace = {
      workspace_id: 'workspace-123', root: '/srv/archon/workspaces/workspace-123',
      project_id: 'project-1', base_revision: 'a'.repeat(40), head_revision: 'a'.repeat(40), generation: 1,
    }
    const fetcher = vi.fn<BackendFetch>(async () => response({ workspaces: [workspace] }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.list', {})).resolves.toEqual({ workspaces: [workspace] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:8000/api/workspaces')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
  })

  it('fetches one owner-scoped workspace through the fixed encoded GET route', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const workspace = {
      workspace_id: workspaceId, root: '/srv/archon/workspaces/workspace-a',
      project_id: 'project-1', base_revision: 'a'.repeat(40), head_revision: 'b'.repeat(40), generation: 1,
    }
    const fetcher = vi.fn<BackendFetch>(async () => response({ workspace }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.get', { workspaceId })).resolves.toEqual({ workspace })
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe(`http://127.0.0.1:8000/api/workspaces/${workspaceId}`)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
    await expect(transport.invoke('workspaces.get', { workspaceId: `${workspaceId}/files` } as never))
      .rejects.toMatchObject({ code: 'invalid_payload' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a workspace response for an identity other than the requested id', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const workspace = {
      workspace_id: `workspace-${'b'.repeat(32)}`, root: '/srv/archon/workspaces/workspace-b',
      project_id: 'project-1', base_revision: 'a'.repeat(40), head_revision: 'b'.repeat(40), generation: 1,
    }
    const fetcher = vi.fn<BackendFetch>(async () => response({ workspace }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.get', { workspaceId })).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('resolves a registered project current commit through a fixed GET route', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ revision: 'a'.repeat(40) }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await expect(transport.invoke('projects.head', { projectId: 'project-1' }))
      .resolves.toEqual({ revision: 'a'.repeat(40) })
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:8000/api/projects/project-1/head')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
  })

  it('posts only project id and full revision to the fixed workspace route', async () => {
    const workspace = {
      workspace_id: 'workspace-123', root: '/srv/archon/workspaces/workspace-123',
      project_id: 'project-1', base_revision: 'a'.repeat(40), head_revision: 'a'.repeat(40), generation: 1,
    }
    const fetcher = vi.fn<BackendFetch>(async () => response({ workspace }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.provision', {
      projectId: 'project-1', revision: 'a'.repeat(40),
    })).resolves.toEqual({ workspace })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:8000/api/workspaces')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
    expect(new Headers(init?.headers).has('idempotency-key')).toBe(false)
    expect(JSON.parse(String(init?.body))).toEqual({ project_id: 'project-1', revision: 'a'.repeat(40) })
  })

  it('rejects incomplete checkout revisions before network access', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ ok: true }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.provision', {
      projectId: 'project-1', revision: 'main',
    })).rejects.toMatchObject({ code: 'invalid_payload' })
    await expect(transport.invoke('workspaces.provision', {
      projectId: 'project-1', revision: 'a'.repeat(40), root: '/tmp',
    } as never)).rejects.toMatchObject({ code: 'invalid_payload' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not retry workspace creation after an ambiguous network failure', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => { throw new Error('connection dropped') })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.provision', {
      projectId: 'project-1', revision: 'a'.repeat(40),
    })).rejects.toMatchObject({ code: 'network_error' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports a legacy server without the checkout route as unsupported', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ detail: 'not found' }, 404))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.provision', {
      projectId: 'project-1', revision: 'a'.repeat(40),
    })).rejects.toMatchObject({ code: 'unsupported_operation' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('maps bounded workspace file reads to fixed owner-scoped GET routes', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const fetcher = vi.fn<BackendFetch>(async (url) => url.pathname.endsWith('/read')
      ? response({ path: 'src/main.ts', content: 'hello', truncated: false })
      : response({ path: 'src', entries: [{ name: 'main.ts', path: 'src/main.ts', kind: 'file', size: 5 }], truncated: false }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.files.list', { workspaceId, path: 'src', limit: 100 }))
      .resolves.toMatchObject({ entries: [{ path: 'src/main.ts' }] })
    await expect(transport.invoke('workspaces.files.read', { workspaceId, path: 'src/main.ts', maxBytes: 65_536 }))
      .resolves.toMatchObject({ content: 'hello' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const listUrl = new URL(String(fetcher.mock.calls[0][0]))
    expect(listUrl.pathname).toBe(`/api/workspaces/${workspaceId}/files`)
    expect(listUrl.searchParams.get('path')).toBe('src')
    expect(listUrl.searchParams.get('limit')).toBe('100')
    const readUrl = new URL(String(fetcher.mock.calls[1][0]))
    expect(readUrl.pathname).toBe(`/api/workspaces/${workspaceId}/files/read`)
    expect(readUrl.searchParams.get('max_bytes')).toBe('65536')
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.method).toBe('GET')
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
    }
  })

  it('maps bounded workspace search to a fixed owner-scoped GET route and validates hits', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const result = {
      hits: [{ path: 'src/main.ts', line: 12 }],
      files_scanned: 4,
      bytes_scanned: 1234,
      truncated: false,
    }
    const fetcher = vi.fn<BackendFetch>(async () => response(result))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.files.search', { workspaceId, query: 'agent' })).resolves.toEqual(result)
    const requestUrl = new URL(String(fetcher.mock.calls[0][0]))
    expect(requestUrl.pathname).toBe(`/api/workspaces/${workspaceId}/files/search`)
    expect(requestUrl.searchParams.get('q')).toBe('agent')
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET')
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined()

    const unsafeResponse = new BackendTransport({
      ...localConnection,
      fetch: vi.fn(async () => response({ ...result, hits: [{ path: '.env', line: 1 }] })),
    })
    await expect(unsafeResponse.invoke('workspaces.files.search', { workspaceId, query: 'agent' }))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('maps a bounded workspace file diff to an encoded owner-scoped GET and checks response identity', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const path = 'src/feature #1?.ts'
    const result = { path, diff: '--- a/src/feature\n+++ b/src/feature\n', truncated: false }
    const fetcher = vi.fn<BackendFetch>(async () => response(result))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.files.diff', { workspaceId, path })).resolves.toEqual(result)
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(url.pathname).toBe(`/api/workspaces/${workspaceId}/files/diff`)
    expect(url.searchParams.get('path')).toBe(path)
    expect(String(url)).toContain('path=src%2Ffeature+%231%3F.ts')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')

    const mismatchedPath = new BackendTransport({
      ...localConnection,
      fetch: vi.fn(async () => response({ ...result, path: 'src/other.ts' })),
    })
    await expect(mismatchedPath.invoke('workspaces.files.diff', { workspaceId, path }))
      .rejects.toMatchObject({ code: 'invalid_response' })

    const oversizedDiff = new BackendTransport({
      ...localConnection,
      fetch: vi.fn(async () => response({ ...result, diff: 'x'.repeat(64 * 1024 + 1) })),
    })
    await expect(oversizedDiff.invoke('workspaces.files.diff', { workspaceId, path }))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('does not retry a workspace diff after an ambiguous network failure', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => { throw new Error('connection lost after request') })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.files.diff', {
      workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts',
    })).rejects.toMatchObject({ code: 'network_error' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('maps compare-and-write to a fixed owner-scoped POST and validates the returned file', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const payload = { workspaceId, path: 'src/main.ts', expectedContent: 'before', content: 'after' }
    const fetcher = vi.fn<BackendFetch>(async () => response({ path: payload.path, content: payload.content }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.files.write', payload)).resolves.toEqual({
      path: payload.path, content: payload.content,
    })
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe(`http://127.0.0.1:8000/api/workspaces/${workspaceId}/files/write`)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({
      path: payload.path, expected_content: payload.expectedContent, content: payload.content,
    })

    const mismatchedResult = new BackendTransport({
      ...localConnection,
      fetch: vi.fn(async () => response({ path: payload.path, content: 'different' })),
    })
    await expect(mismatchedResult.invoke('workspaces.files.write', payload))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('returns a distinct stale-file conflict and never retries an ambiguous write', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const payload = { workspaceId, path: 'src/main.ts', expectedContent: 'before', content: 'after' }
    const conflictFetch = vi.fn<BackendFetch>(async () => response({ detail: 'private server detail' }, 409))
    const conflictTransport = new BackendTransport({ ...localConnection, fetch: conflictFetch })
    const conflict = await conflictTransport.invoke('workspaces.files.write', payload).catch((error: unknown) => error)
    expect(conflict).toMatchObject({ code: 'write_conflict' })
    expect(String(conflict)).not.toContain('private server detail')
    expect(conflictFetch).toHaveBeenCalledOnce()

    const failedFetch = vi.fn<BackendFetch>(async () => { throw new Error('connection lost after request') })
    const failedTransport = new BackendTransport({ ...localConnection, fetch: failedFetch })
    await expect(failedTransport.invoke('workspaces.files.write', payload))
      .rejects.toMatchObject({ code: 'network_error' })
    expect(failedFetch).toHaveBeenCalledOnce()
  })

  it('rejects oversized or unsafe file writes before network access', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ path: 'src/main.ts', content: 'after' }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    const workspaceId = `workspace-${'a'.repeat(32)}`
    for (const payload of [
      { workspaceId, path: '../outside', expectedContent: 'before', content: 'after' },
      { workspaceId, path: 'src/main.ts', expectedContent: 'before', content: 'bad\0text' },
      { workspaceId, path: 'src/main.ts', expectedContent: '', content: '😀'.repeat(4_097) },
    ]) {
      await expect(transport.invoke('workspaces.files.write', payload as never))
        .rejects.toMatchObject({ code: 'invalid_payload' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('creates a bounded text file through a fixed owner-scoped POST without retries', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const payload = { workspaceId, path: 'src/new.ts', content: 'created' }
    const fetcher = vi.fn<BackendFetch>(async () => response({ path: payload.path, content: payload.content }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('workspaces.files.create', payload)).resolves.toEqual({
      path: payload.path, content: payload.content,
    })
    const [url, init] = fetcher.mock.calls[0]
    expect(String(url)).toBe(`http://127.0.0.1:8000/api/workspaces/${workspaceId}/files/create`)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(init?.headers).get('idempotency-key')).toBeNull()
    expect(JSON.parse(String(init?.body))).toEqual({ path: payload.path, content: payload.content })
    expect(fetcher).toHaveBeenCalledOnce()

    const mismatchedResult = new BackendTransport({
      ...localConnection,
      fetch: vi.fn(async () => response({ path: payload.path, content: 'different' })),
    })
    await expect(mismatchedResult.invoke('workspaces.files.create', payload))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('maps file create collisions to a stable conflict and never retries network failures', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const payload = { workspaceId, path: 'src/new.ts', content: 'created' }
    const conflictFetch = vi.fn<BackendFetch>(async () => response({ detail: 'private server detail' }, 409))
    const conflictTransport = new BackendTransport({ ...localConnection, fetch: conflictFetch })
    const conflict = await conflictTransport.invoke('workspaces.files.create', payload).catch((error: unknown) => error)
    expect(conflict).toMatchObject({ code: 'write_conflict' })
    expect(String(conflict)).not.toContain('private server detail')
    expect(conflictFetch).toHaveBeenCalledOnce()

    const failedFetch = vi.fn<BackendFetch>(async () => { throw new Error('connection lost after request') })
    const failedTransport = new BackendTransport({ ...localConnection, fetch: failedFetch })
    await expect(failedTransport.invoke('workspaces.files.create', payload))
      .rejects.toMatchObject({ code: 'network_error' })
    expect(failedFetch).toHaveBeenCalledOnce()
  })

  it('rejects oversized or unsafe file creates before network access', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ path: 'src/new.ts', content: 'created' }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    const workspaceId = `workspace-${'a'.repeat(32)}`
    for (const payload of [
      { workspaceId, path: '../outside', content: 'created' },
      { workspaceId, path: 'src/new.ts', content: 'bad\0text' },
      { workspaceId, path: 'src/new.ts', content: '😀'.repeat(4_097) },
    ]) {
      await expect(transport.invoke('workspaces.files.create', payload as never))
        .rejects.toMatchObject({ code: 'invalid_payload' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('blocks workspace path escape and mismatched file responses', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const fetcher = vi.fn<BackendFetch>(async () => response({ path: 'other', entries: [], truncated: false }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await expect(transport.invoke('workspaces.files.list', { workspaceId, path: '../outside', limit: 100 }))
      .rejects.toMatchObject({ code: 'invalid_payload' })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(transport.invoke('workspaces.files.list', { workspaceId, path: 'src', limit: 100 }))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('reports binary workspace files distinctly', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const fetcher = vi.fn<BackendFetch>(async () => response({ detail: 'binary' }, 415))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await expect(transport.invoke('workspaces.files.read', { workspaceId, path: 'image.png', maxBytes: 65_536 }))
      .rejects.toMatchObject({ code: 'binary_file' })
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

  it('keeps auth status available to main-process renewal without exposing response bodies', async () => {
    const transport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ detail: 'TOKEN_SENTINEL' }, 401)),
    })
    const probe = await transport.probe()
    expect(probe).toMatchObject({ ok: false, error: { code: 'unauthorized' }, authStatus: 401 })
    const rendererProbe = parseBridgeResponse(BRIDGE_CHANNELS.connectionProbe, probe)
    expect(rendererProbe).toEqual({ ok: false, error: { code: 'unauthorized', message: 'The server did not accept the connection.' } })
    expect(rendererProbe).not.toHaveProperty('authStatus')
    expect(JSON.stringify(probe)).not.toContain('TOKEN_SENTINEL')

    const forbiddenTransport = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ detail: 'TOKEN_SENTINEL' }, 403)),
    })
    const forbiddenProbe = await forbiddenTransport.probe()
    expect(forbiddenProbe).toMatchObject({ ok: false, error: { code: 'unauthorized' }, authStatus: 403 })
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.connectionProbe, forbiddenProbe)).not.toThrow()
    expect(JSON.stringify(forbiddenProbe)).not.toContain('TOKEN_SENTINEL')
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
