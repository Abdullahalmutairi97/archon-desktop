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

  it('maps trusted workspace console calls to fixed routes without retrying input', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const attachId = `watt-${'c'.repeat(32)}`
    const fetcher = vi.fn<BackendFetch>(async (url, init) => response({ terminals: [] },
      (url.pathname.endsWith('/terminals') || url.pathname.endsWith('/attach')) && init.method === 'POST' ? 201 : 200))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    const requests = [
      { operation: 'workspace.terminals.list', workspaceId } as const,
      { operation: 'workspace.terminals.create', workspaceId, expectedGeneration: 4 } as const,
      { operation: 'workspace.terminals.screen', workspaceId, sessionId, lines: 80 } as const,
      { operation: 'workspace.terminals.input', workspaceId, sessionId, line: 'pwd' } as const,
      { operation: 'workspace.terminals.interrupt', workspaceId, sessionId } as const,
      { operation: 'workspace.terminals.stop', workspaceId, sessionId } as const,
      { operation: 'workspace.terminals.attach.open', workspaceId, sessionId, expectedGeneration: 4, mode: 'control' } as const,
      { operation: 'workspace.terminals.attach.claim', workspaceId, sessionId, ticket: attachId } as const,
      { operation: 'workspace.terminals.attach.screen', workspaceId, sessionId, attachId, lines: 40 } as const,
      { operation: 'workspace.terminals.attach.input', workspaceId, sessionId, attachId, events: [{ type: 'text', value: 'ls' }, { type: 'key', value: 'Enter' }] } as const,
      { operation: 'workspace.terminals.attach.detach', workspaceId, sessionId, attachId } as const,
    ]
    for (const request of requests) await transport.invokeLocalCodex(request)

    expect(fetcher.mock.calls.map(([url, init]) => [url.pathname + url.search, init?.method, init?.body])).toEqual([
      [`/api/local/workspaces/${workspaceId}/terminals`, 'GET', undefined],
      [`/api/local/workspaces/${workspaceId}/terminals`, 'POST', JSON.stringify({ expectedGeneration: 4 })],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}/screen?lines=80`, 'GET', undefined],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}/input`, 'POST', JSON.stringify({ line: 'pwd' })],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}/interrupt`, 'POST', undefined],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}`, 'DELETE', JSON.stringify({ confirm: true })],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}/attach`, 'POST', JSON.stringify({ expectedGeneration: 4, mode: 'control' })],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}/attach/${attachId}/claim`, 'POST', undefined],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}/attach/${attachId}/screen?lines=40`, 'GET', undefined],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}/attach/${attachId}/input`, 'POST', JSON.stringify({ events: [{ type: 'text', value: 'ls' }, { type: 'key', value: 'Enter' }] })],
      [`/api/local/workspaces/${workspaceId}/terminals/${sessionId}/attach/${attachId}`, 'DELETE', undefined],
    ])
    expect(fetcher.mock.calls.every(([, init]) => (init?.headers as Record<string, string>).Authorization === `Bearer ${localConnection.token}`)).toBe(true)
  })

  it('rejects disallowed interactive key frames before any request', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ sent: true }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await expect(transport.invokeLocalCodex({
      operation: 'workspace.terminals.attach.input',
      workspaceId: `workspace-${'a'.repeat(32)}`,
      sessionId: `wterm-${'b'.repeat(32)}`,
      attachId: `watt-${'c'.repeat(32)}`,
      events: [{ type: 'key', value: 'F13' }],
    } as never)).rejects.toMatchObject({ code: 'invalid_payload' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps workspace service calls to fixed owner-only routes', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const service = { name: 'web', argv: ['/bin/echo'], cwd: '.', ports: [], restart: 'never', state: 'registered', exitCode: null, restarts: 0, health: 'unknown', memoryLimitMb: null, cpuQuotaPercent: null, tasksMax: null, filesystemIsolation: 'none', networkIsolation: 'host' }
    const fetcher = vi.fn<BackendFetch>(async (url, init) => response(
      url.pathname.endsWith('/preview') ? { preview: { ticket: `wprev-${'d'.repeat(32)}`, mode: 'read-only', expiresAt: '2026-09-27T00:10:00Z' } }
        : url.pathname.endsWith('/logs') ? { text: 'x', truncated: false }
          : init?.method === 'GET' ? { services: [service] }
            : url.pathname.endsWith('/start') || init?.method === 'PUT' ? { service } : { ok: true },
      url.pathname.endsWith('/preview') ? 201 : 200))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    const definition = {
      name: 'web', argv: ['/bin/echo'], cwd: '.', env: [], ports: [], health: null,
      dependsOn: [], restart: 'never' as const, memoryLimitMb: null,
    }
    await transport.invokeLocalCodex({ operation: 'workspace.services.list', workspaceId })
    await transport.invokeLocalCodex({ operation: 'workspace.services.define', workspaceId, definition })
    await transport.invokeLocalCodex({ operation: 'workspace.services.start', workspaceId, name: 'web' })
    await transport.invokeLocalCodex({ operation: 'workspace.services.stop', workspaceId, name: 'web', confirm: true })
    await transport.invokeLocalCodex({ operation: 'workspace.services.remove', workspaceId, name: 'web', confirm: true })
    await transport.invokeLocalCodex({ operation: 'workspace.services.logs', workspaceId, name: 'web', lines: 200 })
    await transport.invokeLocalCodex({ operation: 'workspace.services.preview.open', workspaceId, name: 'web', expectedGeneration: 4, portName: null })
    expect(fetcher.mock.calls.map(([url, init]) => [url.pathname + url.search, init?.method, init?.body])).toEqual([
      [`/api/local/workspaces/${workspaceId}/services`, 'GET', undefined],
      [`/api/local/workspaces/${workspaceId}/services/web`, 'PUT', JSON.stringify(definition)],
      [`/api/local/workspaces/${workspaceId}/services/web/start`, 'POST', undefined],
      [`/api/local/workspaces/${workspaceId}/services/web/stop`, 'POST', JSON.stringify({ confirm: true })],
      [`/api/local/workspaces/${workspaceId}/services/web`, 'DELETE', JSON.stringify({ confirm: true })],
      [`/api/local/workspaces/${workspaceId}/services/web/logs?lines=200`, 'GET', undefined],
      [`/api/local/workspaces/${workspaceId}/services/web/preview`, 'POST', JSON.stringify({ expectedGeneration: 4, portName: null })],
    ])
  })

  it('reads the language profile report from one fixed owner-only route', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const report = {
      extensionsDirectory: '/home/user/.local/share/code-server/extensions', profiles: [],
      unpinnedInstalled: [], pinsVerified: false, note: 'artefact record',
    }
    const fetcher = vi.fn<BackendFetch>(async () => response({ ...report }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invokeLocalCodex({
      operation: 'workspace.languageProfiles.list', workspaceId,
    })).resolves.toMatchObject({ pinsVerified: false })
    expect(fetcher.mock.calls.map(([url, init]) => [url.pathname, init?.method])).toEqual([
      [`/api/local/workspaces/${workspaceId}/language-profiles`, 'GET'],
    ])

    // An invalid workspace id never reaches the network.
    fetcher.mockClear()
    await expect(transport.invokeLocalCodex({
      operation: 'workspace.languageProfiles.list', workspaceId: 'nope',
    })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not retry ambiguous line input', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => { throw new Error('request may have reached server') })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await expect(transport.invokeLocalCodex({
      operation: 'workspace.terminals.input', workspaceId: `workspace-${'a'.repeat(32)}`,
      sessionId: `wterm-${'b'.repeat(32)}`, line: 'write data',
    })).rejects.toMatchObject({ code: 'network_error' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('uses fixed read-only routes to discover and refresh the latest Local Codex turn', async () => {
    const status = {
      taskId: 'codex-task:fixture', projectId: 'codex-project:fixture',
      sessionId: 'codex:session-1', state: 'outcome_unknown',
    }
    const fetcher = vi.fn<BackendFetch>(async () => response({ turns: [status] }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invokeLocalCodex({ operation: 'turns.list', limit: 1 })).resolves.toEqual({ turns: [status] })
    expect(fetcher.mock.calls[0]?.[0].pathname).toBe('/api/local/codex/turns')
    expect(fetcher.mock.calls[0]?.[0].search).toBe('?limit=1')
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')

    fetcher.mockImplementationOnce(async () => response(status))
    await expect(transport.invokeLocalCodex({ operation: 'turns.status', taskId: status.taskId })).resolves.toEqual(status)
    expect(fetcher.mock.calls[1]?.[0].pathname).toBe(`/api/local/codex/turns/${encodeURIComponent(status.taskId)}`)
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET')
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
      'sessions.messages',
      'tasks.list',
      'events.cursor',
      'secrets.authStates',
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

  it('continues a server conversation without a runtime choice and starts new ones with an explicit runtime', async () => {
    const task = { id: 'task-continue', status: 'queued', session_id: 'prime-session-1' }
    const fetcher = vi.fn<BackendFetch>(async () => response({ task }, 202))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('tasks.submit', { sessionId: 'prime-session-1', prompt: 'Continue' }))
      .resolves.toEqual({ task })
    await transport.invoke('tasks.submit', { sessionId: 'prime-session-1', prompt: 'Continue here', projectId: 'project-1' })
    await transport.invoke('tasks.submit', { projectId: 'project-1', prompt: 'Start with Pi', runtime: 'pi' })
    await transport.invoke('tasks.submit', { projectId: 'project-1', prompt: 'Start with Prime', runtime: 'prime' })

    expect(fetcher).toHaveBeenCalledTimes(4)
    const requests = fetcher.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: JSON.parse(String(init?.body)),
      key: new Headers(init?.headers).get('idempotency-key'),
    }))
    expect(requests.map(({ url, method }) => [url, method])).toEqual(Array.from({ length: 4 }, () => [
      'http://127.0.0.1:8000/api/tasks', 'POST',
    ]))
    expect(requests.map(({ body }) => body)).toEqual([
      { prompt: 'Continue', session_id: 'prime-session-1', approval_mode: 'auto', chat_only: false },
      { prompt: 'Continue here', session_id: 'prime-session-1', project_id: 'project-1', approval_mode: 'auto', chat_only: false },
      { prompt: 'Start with Pi', project_id: 'project-1', profile: 'pi', approval_mode: 'auto', chat_only: false },
      { prompt: 'Start with Prime', project_id: 'project-1', profile: 'prime', approval_mode: 'auto', chat_only: false },
    ])
    expect(requests[0].body).not.toHaveProperty('profile')
    expect(requests[1].body).not.toHaveProperty('profile')
    expect(new Set(requests.map(({ key }) => key)).size).toBe(4)
    expect(requests.every(({ key }) => typeof key === 'string' && key.length === 36)).toBe(true)
  })

  it('rejects continuation shapes that mix a session with a runtime or checkout before fetch', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ task: { id: 'task-1', status: 'queued' } }, 202))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    const workspace = { workspaceId: `workspace-${'a'.repeat(32)}`, workspaceGeneration: 1 }

    for (const payload of [
      { sessionId: 'prime-session-1', prompt: 'work', runtime: 'pi' },
      { sessionId: 'prime-session-1', prompt: 'work', projectId: 'project-1', ...workspace },
      { projectId: 'project-1', prompt: 'work', runtime: 'pi', ...workspace },
      { projectId: 'project-1', prompt: 'work', runtime: 'codex' },
      { sessionId: '../../api/admin', prompt: 'work' },
      { sessionId: 'prime-session-1', prompt: 'work', profile: 'pi' },
    ]) {
      await expect(transport.invoke('tasks.submit', payload as never)).rejects.toMatchObject({ code: 'invalid_payload' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not retry an ambiguous conversation continuation', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => { throw new Error('connection dropped') })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('tasks.submit', { sessionId: 'prime-session-1', prompt: 'Only once' }))
      .rejects.toMatchObject({ code: 'network_error' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected continuation, such as a read-only session, as an HTTP error', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ detail: 'Native Pi history is read-only here.' }, 409))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    const failure = await transport.invoke('tasks.submit', { sessionId: 'pi-native-abc', prompt: 'Continue' })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'http_error' })
    expect(String(failure)).not.toContain('read-only here')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reads a bounded session transcript through one fixed encoded GET route', async () => {
    const messages = [
      { id: 'task-1-prompt', role: 'user', content: 'Hello', kind: 'text', timestamp: 1_790_000_000 },
      { id: 'native-9:1', role: 'assistant', content: 'Hi there', kind: 'text', timestamp: 1_790_000_001 },
    ]
    const fetcher = vi.fn<BackendFetch>(async () => response({ messages }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('sessions.messages', { sessionId: 'pi-native-session_1', limit: 2 }))
      .resolves.toEqual({ messages })
    const [url, init] = fetcher.mock.calls[0]
    expect(url.pathname).toBe('/api/sessions/pi-native-session_1/messages')
    expect(url.searchParams.get('limit')).toBe('2')
    expect([...url.searchParams.keys()]).toEqual(['limit'])
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
  })

  it('rejects transcripts that exceed the requested limit or carry malformed rows', async () => {
    const message = { id: 'm-1', role: 'assistant', content: 'text', kind: 'text', timestamp: 1 }
    const tooMany = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ messages: [message, { ...message, id: 'm-2' }] })),
    })
    await expect(tooMany.invoke('sessions.messages', { sessionId: 'session-1', limit: 1 }))
      .rejects.toMatchObject({ code: 'invalid_response' })

    const malformed = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ messages: [{ ...message, content: { html: '<b>x</b>' } }] })),
    })
    await expect(malformed.invoke('sessions.messages', { sessionId: 'session-1', limit: 5 }))
      .rejects.toMatchObject({ code: 'invalid_response' })

    const missing = new BackendTransport({
      ...localConnection,
      fetch: fetchStub(async () => response({ detail: 'Session not found' }, 404)),
    })
    await expect(missing.invoke('sessions.messages', { sessionId: 'session-1', limit: 5 }))
      .rejects.toMatchObject({ code: 'http_error' })

    const fetcher = vi.fn<BackendFetch>(async () => response({ messages: [] }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    for (const payload of [
      { sessionId: '../tasks', limit: 5 },
      { sessionId: 'session-1', limit: 0 },
      { sessionId: 'session-1', limit: 501 },
      { sessionId: 'session-1' },
      { sessionId: 'session-1', limit: 5, after: 3 },
    ]) {
      await expect(transport.invoke('sessions.messages', payload as never)).rejects.toMatchObject({ code: 'invalid_payload' })
    }
    expect(fetcher).not.toHaveBeenCalled()
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
    expect(String(url)).toBe('http://127.0.0.1:8000/api/workspaces?include=checkout')
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
    expect(String(url)).toBe(`http://127.0.0.1:8000/api/workspaces/${workspaceId}?include=checkout`)
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
    await expect(transport.invoke('workspaces.get', { workspaceId: `${workspaceId}/files` } as never))
      .rejects.toMatchObject({ code: 'invalid_payload' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('accepts the recorded owner and checkout state, and refuses a malformed one', async () => {
    const base = {
      workspace_id: 'workspace-123', root: '/srv/archon/workspaces/workspace-123',
      project_id: 'project-1', base_revision: 'a'.repeat(40), head_revision: 'a'.repeat(40), generation: 1,
    }
    const detached = { ...base, owner_id: 'local-uid:1000', checkout: { state: 'detached', branch: null, commit: 'a'.repeat(40), at_head_revision: true } }
    const branch = { ...base, owner_id: 'local-uid:1000', checkout: { state: 'branch', branch: 'feature/review', commit: null, at_head_revision: null } }
    const unknown = { ...base, owner_id: 'local-uid:1000', checkout: { state: 'unknown', branch: null, commit: null, at_head_revision: null } }
    for (const workspace of [base, detached, branch, unknown]) {
      const transport = new BackendTransport({ ...localConnection, fetch: vi.fn<BackendFetch>(async () => response({ workspaces: [workspace] })) })
      await expect(transport.invoke('workspaces.list', {})).resolves.toEqual({ workspaces: [workspace] })
    }
    const malformed = [
      { ...base, owner_id: 'local-uid:1000' },
      { ...base, checkout: detached.checkout },
      { ...detached, checkout: { ...detached.checkout, at_head_revision: null } },
      { ...detached, checkout: { ...detached.checkout, commit: 'a'.repeat(12) } },
      { ...branch, checkout: { ...branch.checkout, branch: '../escape' } },
      { ...branch, checkout: { ...branch.checkout, branch: '-option' } },
      { ...branch, checkout: { ...branch.checkout, commit: 'a'.repeat(40) } },
      { ...unknown, checkout: { ...unknown.checkout, state: 'attached' } },
      { ...unknown, checkout: { ...unknown.checkout, extra: true } },
      { ...unknown, owner_id: ' spaced ' },
    ]
    for (const workspace of malformed) {
      const transport = new BackendTransport({ ...localConnection, fetch: vi.fn<BackendFetch>(async () => response({ workspaces: [workspace] })) })
      await expect(transport.invoke('workspaces.list', {})).rejects.toMatchObject({ code: 'invalid_response' })
    }
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
