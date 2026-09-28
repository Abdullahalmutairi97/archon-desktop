import { describe, expect, it } from 'vitest'
import {
  BRIDGE_CHANNELS,
  LANGUAGE_PROFILES_CHANNELS,
  LOCAL_CODEX_CHANNELS,
  parseLanguageProfilesBackendResponse,
  parseLanguageProfilesRequest,
  parseBridgeRequest,
  parseBridgeResponse,
  parseLocalCodexEvent,
  parseLocalCodexRequest,
  parseLocalCodexResponse,
  parseOperationRequest,
} from './validation'

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
    expect(parseOperationRequest('workspaces.list', {})).toEqual(['workspaces.list', {}])
    expect(parseOperationRequest('workspaces.get', { workspaceId: `workspace-${'a'.repeat(32)}` }))
      .toEqual(['workspaces.get', { workspaceId: `workspace-${'a'.repeat(32)}` }])
    expect(parseOperationRequest('workspaces.provision', {
      projectId: 'project-1', revision: 'a'.repeat(40),
    })).toEqual(['workspaces.provision', { projectId: 'project-1', revision: 'a'.repeat(40) }])
    expect(parseOperationRequest('projects.create', {
      name: 'Existing project', path: '/srv/archon/projects/existing',
    })).toEqual(['projects.create', { name: 'Existing project', path: '/srv/archon/projects/existing' }])
    expect(parseOperationRequest('workspaces.files.search', {
      workspaceId: `workspace-${'a'.repeat(32)}`, query: 'agent',
    })).toEqual(['workspaces.files.search', { workspaceId: `workspace-${'a'.repeat(32)}`, query: 'agent' }])
    expect(parseOperationRequest('workspaces.files.diff', {
      workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts',
    })).toEqual(['workspaces.files.diff', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts' }])
    expect(parseOperationRequest('workspaces.files.write', {
      workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts',
      expectedContent: 'before', content: 'after',
    })).toEqual(['workspaces.files.write', {
      workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts',
      expectedContent: 'before', content: 'after',
    }])
    expect(parseOperationRequest('workspaces.files.create', {
      workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/new.ts', content: 'created',
    })).toEqual(['workspaces.files.create', {
      workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/new.ts', content: 'created',
    }])
    for (const [operation, payload] of [
      ['not-an-operation', {}],
      ['readiness', { url: 'http://localhost' }],
      ['sessions.list', { projectId: 'x'.repeat(201) }],
      ['sessions.list', { limit: 501 }],
      ['tasks.list', { limit: 0 }],
      ['events.cursor', { after: 12 }],
      ['workspaces.list', { limit: 501 }],
      ['workspaces.get', { workspaceId: '../workspace' }],
      ['workspaces.get', { workspaceId: `workspace-${'a'.repeat(32)}`, root: '/etc' }],
      ['workspaces.provision', { projectId: 'project-1', revision: 'a'.repeat(39) }],
      ['workspaces.provision', { projectId: 'project-1', revision: 'a'.repeat(65) }],
      ['workspaces.provision', { projectId: 'project-1', revision: 'a'.repeat(40), root: '/tmp' }],
      ['workspaces.provision', { projectId: 'project-1', revision: 'a'.repeat(64), ownerId: 'someone' }],
      ['projects.create', { name: 'Project', path: 'relative/path' }],
      ['projects.create', { name: 'Project', path: '/srv/project/../outside' }],
      ['projects.create', { name: '   ', path: '/srv/project' }],
      ['projects.create', { name: 'x'.repeat(121), path: '/srv/project' }],
      ['projects.create', { name: 'Project', path: `/srv/${'p'.repeat(1_000)}` }],
      ['projects.create', { name: 'Project', path: '/srv/project', existing_git: true }],
      ['workspaces.files.search', { workspaceId: `workspace-${'a'.repeat(32)}`, query: '  ' }],
      ['workspaces.files.search', { workspaceId: `workspace-${'a'.repeat(32)}`, query: 'q'.repeat(129) }],
      ['workspaces.files.search', { workspaceId: `workspace-${'a'.repeat(32)}`, query: 'agent\nsecret' }],
      ['workspaces.files.diff', { workspaceId: `workspace-${'a'.repeat(32)}`, path: '../outside' }],
      ['workspaces.files.diff', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src\\main.ts' }],
      ['workspaces.files.diff', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts', extra: true }],
      ['workspaces.files.write', { workspaceId: `workspace-${'a'.repeat(32)}`, path: '../outside', expectedContent: '', content: '' }],
      ['workspaces.files.write', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts', expectedContent: 'x'.repeat(12_001), content: '' }],
      ['workspaces.files.write', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts', expectedContent: '', content: '😀'.repeat(4_097) }],
      ['workspaces.files.write', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/main.ts', expectedContent: '', content: 'bad\0text' }],
      ['workspaces.files.create', { workspaceId: `workspace-${'a'.repeat(32)}`, path: '../outside', content: '' }],
      ['workspaces.files.create', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/new.ts', content: 'x'.repeat(12_001) }],
      ['workspaces.files.create', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/new.ts', content: '😀'.repeat(4_097) }],
      ['workspaces.files.create', { workspaceId: `workspace-${'a'.repeat(32)}`, path: 'src/new.ts', content: 'bad\0text' }],
    ] as const) {
      expect(() => parseOperationRequest(operation, payload)).toThrow(TypeError)
    }
  })

  it('accepts only bounded, credential-name-safe workspace search hits', () => {
    const result = {
      hits: [{ path: 'src/main.ts', line: 9 }],
      files_scanned: 12,
      bytes_scanned: 8192,
      truncated: false,
    }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, result, 'workspaces.files.search')).toEqual(result)
    for (const path of ['.env', '.git/config', 'nested/.aws/credentials', 'terraform.tfstate.backup']) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
        ...result, hits: [{ path, line: 1 }],
      }, 'workspaces.files.search')).toThrow(TypeError)
    }
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      ...result, hits: [{ path: 'src/main.ts', line: 0 }],
    }, 'workspaces.files.search')).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      ...result, bytes_scanned: 1024 * 1024 + 1,
    }, 'workspaces.files.search')).toThrow(TypeError)
  })

  it('validates the bounded workspace file diff response', () => {
    const result = { path: 'src/main.ts', diff: '--- a/src/main.ts\n+++ b/src/main.ts\n', truncated: false }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, result, 'workspaces.files.diff')).toEqual(result)
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      path: 'src/main.ts', diff: 'x'.repeat(64 * 1024), truncated: true,
    }, 'workspaces.files.diff')).toMatchObject({ truncated: true })
    for (const unsafe of [
      { ...result, path: '../outside' },
      { ...result, diff: 'x'.repeat(64 * 1024 + 1) },
      { ...result, diff: 'bad\0diff' },
      { ...result, truncated: 0 },
      { ...result, extra: true },
    ]) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, unsafe, 'workspaces.files.diff')).toThrow(TypeError)
    }
  })

  it('validates the narrow workspace file write response', () => {
    const result = { path: 'src/main.ts', content: 'updated' }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, result, 'workspaces.files.write')).toEqual(result)
    for (const unsafe of [
      { path: '../outside', content: 'updated' },
      { path: 'src/main.ts', content: 'bad\0text' },
      { path: 'src/main.ts', content: '😀'.repeat(4_097) },
      { path: 'src/main.ts', content: 'x'.repeat(12_001) },
    ]) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, unsafe, 'workspaces.files.write')).toThrow(TypeError)
    }
  })

  it('validates the narrow workspace file create response', () => {
    const result = { path: 'src/new.ts', content: 'created' }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, result, 'workspaces.files.create')).toEqual(result)
    for (const unsafe of [
      { path: '../outside', content: 'created' },
      { path: 'src/new.ts', content: 'bad\0text' },
      { path: 'src/new.ts', content: '😀'.repeat(4_097) },
      { path: 'src/new.ts', content: 'x'.repeat(12_001) },
    ]) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, unsafe, 'workspaces.files.create')).toThrow(TypeError)
    }
  })

  it('matches backend control-character rules for new file content', () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const create = (content: string) => parseOperationRequest('workspaces.files.create', {
      workspaceId, path: 'src/new.ts', content,
    })
    expect(create('tabs\t, newlines\n, and carriage returns\r are allowed')).toEqual([
      'workspaces.files.create', {
        workspaceId, path: 'src/new.ts', content: 'tabs\t, newlines\n, and carriage returns\r are allowed',
      },
    ])
    const unsupportedControls = [
      ...Array.from({ length: 32 }, (_, code) => code).filter((code) => ![0x09, 0x0a, 0x0d].includes(code)),
      ...Array.from({ length: 33 }, (_, index) => index + 0x7f),
    ]
    for (const code of unsupportedControls) {
      expect(() => create(String.fromCharCode(code))).toThrow(TypeError)
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
    expect(parseBridgeResponse(BRIDGE_CHANNELS.connectionProbe, {
      ok: false, error: { code: 'unauthorized', message: 'The server did not accept the connection.' }, authStatus: 401,
    })).toEqual({
      ok: false, error: { code: 'unauthorized', message: 'The server did not accept the connection.' },
    })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.connectionDescribe, {
      ...description, localPairingAvailable: true,
    })).toEqual({ ...description, localPairingAvailable: true })
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
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.connectionProbe, {
      ok: false, error: { code: 'unauthorized', message: 'The server did not accept the connection.' }, authStatus: 500,
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
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      project: { id: 'project-1', name: 'Existing project', primary_path: '/srv/archon/projects/existing' },
    }, 'projects.create')).toEqual({
      project: { id: 'project-1', name: 'Existing project', primary_path: '/srv/archon/projects/existing' },
    })
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      project: { id: 'project-1', api_token: 'sentinel' },
    }, 'projects.create')).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      project: { id: 'project-1' }, extra: true,
    }, 'projects.create')).toThrow(TypeError)
  })

  it('accepts an empty auth-state request and refuses a response that carries a value', () => {
    expect(parseOperationRequest('secrets.authStates', {})).toEqual(['secrets.authStates', {}])
    expect(() => parseOperationRequest('secrets.authStates', { provider: 'prime' })).toThrow(TypeError)
    const state = {
      providers: [{
        provider: 'prime', state: 'unverified', references: 1, purpose: ['provider'],
        verifiedAt: null, lastAttemptAt: '2026-09-28T00:00:00Z', lastFailureReason: 'no call yet',
      }],
      epoch: 3, secretSource: 'process-environment', secretValuesExposed: false, note: 'never a value',
    }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, state, 'secrets.authStates')).toEqual(state)
    // A response that claims to expose values, uses an unknown state, or carries
    // a value-shaped field is refused rather than shown.
    for (const bad of [
      { ...state, secretValuesExposed: true },
      { ...state, providers: [{ ...state.providers[0], state: 'ready' }] },
      { ...state, providers: [{ ...state.providers[0], value: 'sk-live-secret' }] },
      { ...state, providers: [{ ...state.providers[0], references: -1 }] },
    ]) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, bad, 'secrets.authStates')).toThrow(TypeError)
    }
  })

  it('accepts only the narrow Prime submit/get/events/cancel payloads', () => {
    expect(parseOperationRequest('runtimes.list', {})).toEqual(['runtimes.list', {}])
    expect(parseOperationRequest('tasks.submit', { projectId: 'project-1', prompt: 'Inspect this project' })).toEqual([
      'tasks.submit', { projectId: 'project-1', prompt: 'Inspect this project' },
    ])
    expect(parseOperationRequest('tasks.submit', {
      projectId: 'project-1', prompt: 'Inspect this checkout',
      workspaceId: `workspace-${'a'.repeat(32)}`, workspaceGeneration: 1,
    })).toEqual(['tasks.submit', {
      projectId: 'project-1', prompt: 'Inspect this checkout',
      workspaceId: `workspace-${'a'.repeat(32)}`, workspaceGeneration: 1,
    }])
    expect(parseOperationRequest('tasks.get', { taskId: 'task_123-ab' })).toEqual([
      'tasks.get', { taskId: 'task_123-ab' },
    ])
    expect(parseOperationRequest('tasks.events', { taskId: 'task_123-ab', after: 14 })).toEqual([
      'tasks.events', { taskId: 'task_123-ab', after: 14 },
    ])
    expect(parseOperationRequest('tasks.cancel', { taskId: 'task_123-ab' })).toEqual([
      'tasks.cancel', { taskId: 'task_123-ab' },
    ])

    for (const [operation, payload] of [
      ['tasks.submit', { projectId: 'project-1', prompt: 'work', cwd: '/tmp' }],
      ['tasks.submit', { projectId: 'project-1', prompt: 'work', approval_mode: 'approve' }],
      ['tasks.submit', { projectId: 'project-1', prompt: 'work', idempotencyKey: 'renderer-key' }],
      ['tasks.submit', { projectId: '', prompt: 'work' }],
      ['tasks.submit', { projectId: 'project-1', prompt: '' }],
      ['tasks.submit', { projectId: 'project-1', prompt: 'x'.repeat(8_001) }],
      ['tasks.submit', { projectId: 'project-1', prompt: 'work', workspaceId: `workspace-${'a'.repeat(32)}` }],
      ['tasks.submit', { projectId: 'project-1', prompt: 'work', workspaceGeneration: 1 }],
      ['tasks.submit', { projectId: 'project-1', prompt: 'work', workspaceId: '../other', workspaceGeneration: 1 }],
      ['tasks.submit', { projectId: 'project-1', prompt: 'work', workspaceId: `workspace-${'a'.repeat(32)}`, workspaceGeneration: 0 }],
      ['tasks.get', { taskId: '../outside' }],
      ['tasks.cancel', { taskId: 'task?id=outside' }],
      ['tasks.events', { taskId: 'task_1', after: -1 }],
      ['tasks.events', { taskId: 'task_1', after: 1.5 }],
      ['tasks.events', { taskId: 'task_1', after: Number.MAX_SAFE_INTEGER + 1 }],
    ] as const) {
      expect(() => parseOperationRequest(operation, payload)).toThrow(TypeError)
    }
  })

  it('accepts conversation continuation and new-runtime submissions only in their narrow shapes', () => {
    const sessionId = 'prime-0f3c2d1e-aaaa-4bbb-8ccc-123456789abc'
    expect(parseOperationRequest('tasks.submit', { sessionId, prompt: 'Keep going' })).toEqual([
      'tasks.submit', { sessionId, prompt: 'Keep going' },
    ])
    expect(parseOperationRequest('tasks.submit', { sessionId, prompt: 'Keep going', projectId: 'project-1' })).toEqual([
      'tasks.submit', { sessionId, prompt: 'Keep going', projectId: 'project-1' },
    ])
    expect(parseOperationRequest('tasks.submit', { projectId: 'project-1', prompt: 'Start', runtime: 'pi' })).toEqual([
      'tasks.submit', { projectId: 'project-1', prompt: 'Start', runtime: 'pi' },
    ])
    expect(parseOperationRequest('tasks.submit', { projectId: 'project-1', prompt: 'Start', runtime: 'prime' })).toEqual([
      'tasks.submit', { projectId: 'project-1', prompt: 'Start', runtime: 'prime' },
    ])
    const workspace = { workspaceId: `workspace-${'a'.repeat(32)}`, workspaceGeneration: 1 }

    for (const payload of [
      { sessionId, prompt: 'work', ...workspace },
      { sessionId, prompt: 'work', projectId: 'project-1', ...workspace },
      { sessionId, prompt: 'work', runtime: 'prime' },
      { projectId: 'project-1', prompt: 'work', runtime: 'prime', ...workspace },
      { projectId: 'project-1', prompt: 'work', runtime: 'codex' },
      { projectId: 'project-1', prompt: 'work', runtime: 'Prime' },
      { projectId: 'project-1', prompt: 'work', runtime: undefined },
      { projectId: 'project-1', prompt: 'work', sessionId: undefined },
      { sessionId, prompt: 'work', projectId: undefined },
      { sessionId, prompt: 'work', projectId: '' },
      { sessionId, prompt: 'work', profile: 'pi' },
      { sessionId, prompt: 'work', approvalMode: 'approve' },
      { sessionId, prompt: '   ' },
      { sessionId, prompt: 'x'.repeat(8_001) },
      { sessionId: '', prompt: 'work' },
      { sessionId: '../other-session', prompt: 'work' },
      { sessionId: 'session/../../etc', prompt: 'work' },
      { sessionId: 'session?limit=1', prompt: 'work' },
      { sessionId: 'session:with:colons', prompt: 'work' },
      { sessionId: 's'.repeat(207), prompt: 'work' },
      { sessionId: 42, prompt: 'work' },
      { prompt: 'work' },
      { prompt: 'work', runtime: 'pi' },
    ]) {
      expect(() => parseOperationRequest('tasks.submit', payload)).toThrow(TypeError)
    }
  })

  it('accepts only a bounded session transcript request', () => {
    const sessionId = `pi-native-${'a'.repeat(32)}`
    expect(parseOperationRequest('sessions.messages', { sessionId, limit: 200 })).toEqual([
      'sessions.messages', { sessionId, limit: 200 },
    ])
    expect(parseOperationRequest('sessions.messages', { sessionId: 's', limit: 1 })[1]).toEqual({ sessionId: 's', limit: 1 })
    expect(parseOperationRequest('sessions.messages', { sessionId: 's'.repeat(206), limit: 500 })[1])
      .toEqual({ sessionId: 's'.repeat(206), limit: 500 })

    let invoked = false
    const hostile = Object.defineProperty({ limit: 10 }, 'sessionId', {
      enumerable: true,
      get() {
        invoked = true
        return 'session-1'
      },
    })
    for (const payload of [
      hostile,
      {},
      { sessionId },
      { limit: 10 },
      { sessionId, limit: 0 },
      { sessionId, limit: 501 },
      { sessionId, limit: 2.5 },
      { sessionId, limit: '10' },
      { sessionId, limit: 10, projectId: 'project-1' },
      { sessionId, limit: 10, url: 'https://evil.test' },
      { sessionId: '', limit: 10 },
      { sessionId: '../escape', limit: 10 },
      { sessionId: 'a/b', limit: 10 },
      { sessionId: 'a%2Fb', limit: 10 },
      { sessionId: 'a b', limit: 10 },
      { sessionId: 's'.repeat(207), limit: 10 },
      { sessionId: ['session-1'], limit: 10 },
      new Date(),
      null,
    ]) {
      expect(() => parseOperationRequest('sessions.messages', payload)).toThrow(TypeError)
    }
    expect(invoked).toBe(false)
  })

  it('validates bounded transcript rows and rejects hostile or malformed messages', () => {
    const message = { id: 'native-1:0', role: 'assistant', content: '<img src=x onerror=alert(1)>', kind: 'text', timestamp: 1_790_000_000 }
    const rows = [
      { id: 'task-abc-prompt', role: 'user', content: 'مرحبا — continue', kind: 'text', timestamp: 0 },
      message,
      { id: 'native-2', role: 'toolResult', content: '', kind: 'tool_result', timestamp: 1_790_000_001 },
      { id: 'native-3', role: 'assistant', content: 'Native message record (no displayable payload)', kind: 'native', timestamp: 1_790_000_002 },
    ]
    const parsed = parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { messages: rows }, 'sessions.messages')
    expect(parsed).toEqual({ messages: rows })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen((parsed as { messages: readonly unknown[] }).messages[1])).toBe(true)
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { messages: [] }, 'sessions.messages')).toEqual({ messages: [] })

    for (const bad of [
      { messages: [{ ...message, extra: true }] },
      { messages: [{ ...message, token: 'sentinel-token' }] },
      { messages: [{ id: message.id, role: message.role, content: message.content, kind: message.kind }] },
      { messages: [{ ...message, id: '' }] },
      { messages: [{ ...message, id: 7 }] },
      { messages: [{ ...message, id: 'x'.repeat(513) }] },
      { messages: [{ ...message, id: 'line\nbreak' }] },
      { messages: [{ ...message, role: '' }] },
      { messages: [{ ...message, role: 'assistant<script>' }] },
      { messages: [{ ...message, kind: null }] },
      { messages: [{ ...message, kind: 'x'.repeat(65) }] },
      { messages: [{ ...message, content: { html: '<b>x</b>' } }] },
      { messages: [{ ...message, content: 'x'.repeat(2 * 1024 * 1024 + 1) }] },
      { messages: [{ ...message, timestamp: -1 }] },
      { messages: [{ ...message, timestamp: 1.5 }] },
      { messages: [{ ...message, timestamp: '2026-09-28T00:00:00Z' }] },
      { messages: [{ ...message, timestamp: Number.MAX_SAFE_INTEGER + 1 }] },
      { messages: Array.from({ length: 501 }, () => message) },
      { messages: Array.from({ length: 3 }, () => ({ ...message, content: 'x'.repeat(1024 * 1024) })) },
      { messages: [message], cursor: 1 },
      { messages: 'not-a-list' },
      { messages: [null] },
      { messages: [new Date()] },
      {},
    ]) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, bad, 'sessions.messages')).toThrow(TypeError)
    }
  })

  it('accepts only a bounded batch of unique conversation ids to remove', () => {
    const longId = 's'.repeat(206)
    const parsed = parseOperationRequest('sessions.delete', { sessionIds: ['prime-session-1', longId] })
    expect(parsed).toEqual(['sessions.delete', { sessionIds: ['prime-session-1', longId] }])
    expect(Object.isFrozen((parsed[1] as { sessionIds: readonly string[] }).sessionIds)).toBe(true)
    const maximum = Array.from({ length: 200 }, (_, index) => `prime-${index}`)
    expect(parseOperationRequest('sessions.delete', { sessionIds: maximum })[1]).toEqual({ sessionIds: maximum })

    let invoked = false
    const hostile = Object.defineProperty({}, 'sessionIds', {
      enumerable: true,
      get() {
        invoked = true
        return ['prime-session-1']
      },
    })
    const sparse: string[] = []
    sparse[1] = 'prime-session-1'
    for (const payload of [
      hostile,
      {},
      { sessionIds: [] },
      { sessionIds: 'prime-session-1' },
      { sessionIds: [...maximum, 'prime-200'] },
      { sessionIds: ['prime-session-1', 'prime-session-1'] },
      { sessionIds: [''] },
      { sessionIds: ['../tasks'] },
      { sessionIds: ['a/b'] },
      { sessionIds: ['a%2Fb'] },
      { sessionIds: ['a b'] },
      { sessionIds: ['s'.repeat(207)] },
      { sessionIds: [7] },
      { sessionIds: [null] },
      { sessionIds: sparse },
      { sessionIds: ['prime-session-1'], confirm: true },
      { session_ids: ['prime-session-1'] },
      null,
    ]) {
      expect(() => parseOperationRequest('sessions.delete', payload)).toThrow(TypeError)
    }
    expect(invoked).toBe(false)
  })

  it('validates the exact removal acknowledgement', () => {
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { ok: true, deleted: ['prime-session-1'] }, 'sessions.delete'))
      .toEqual({ ok: true, deleted: ['prime-session-1'] })
    for (const bad of [
      { ok: true },
      { ok: false, deleted: ['prime-session-1'] },
      { ok: true, deleted: [] },
      { ok: true, deleted: ['../escape'] },
      { ok: true, deleted: ['a', 'a'] },
      { ok: true, deleted: ['prime-session-1'], token: 'sentinel' },
      { deleted: ['prime-session-1'] },
      null,
    ]) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, bad, 'sessions.delete')).toThrow(TypeError)
    }
  })

  it('validates bounded runtime, task and event responses', () => {
    const taskId = 'a'.repeat(32)
    const runtime = {
      id: 'prime', aliases: ['default', 'prime'], available: true,
      availability_check: 'executable_file', version: null, version_verified: false,
      availability_note: 'Filesystem availability is not execution verification.',
      modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }],
      chat_only: false, sandboxed: false,
    }
    const task = { id: taskId, status: 'queued', prompt: 'Inspect this project', project_id: 'project-1' }
    const event = {
      seq: 12, task_id: taskId, type: 'task.queued', data: { status: 'queued' },
      created_at: '2026-09-27T00:00:00Z', attempt_id: null,
    }

    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { runtimes: [runtime] }, 'runtimes.list'))
      .toEqual({ runtimes: [runtime] })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { task }, 'tasks.submit')).toEqual({ task })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { task }, 'tasks.get')).toEqual({ task })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { events: [event] }, 'tasks.events'))
      .toEqual({ events: [event] })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { ok: true }, 'tasks.cancel')).toEqual({ ok: true })

    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { task: { ...task, access_token: 'secret' } }, 'tasks.get'))
      .toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { events: Array.from({ length: 1001 }, () => event) }, 'tasks.events'))
      .toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { ok: false }, 'tasks.cancel')).toThrow(TypeError)
  })

  it('validates bounded server workspace identity rows for display', () => {
    const workspace = {
      workspace_id: 'workspace-123',
      root: '/srv/archon/workspaces/workspace-123',
      project_id: 'project-known',
      base_revision: 'a'.repeat(40),
      head_revision: 'b'.repeat(40),
      generation: 2,
    }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { workspaces: [workspace] }, 'workspaces.list'))
      .toEqual({ workspaces: [workspace] })
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      workspaces: [{ ...workspace, project_id: null, base_revision: null, head_revision: null }],
    }, 'workspaces.list')).toMatchObject({ workspaces: [{ project_id: null, base_revision: null, head_revision: null }] })
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      workspaces: [{ ...workspace, generation: 0 }],
    }, 'workspaces.list')).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      workspaces: [{ ...workspace, root: '../outside' }],
    }, 'workspaces.list')).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      workspaces: [{ ...workspace, token: 'sentinel-token' }],
    }, 'workspaces.list')).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, {
      workspaces: Array.from({ length: 501 }, () => workspace),
    }, 'workspaces.list')).toThrow(TypeError)
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { workspace }, 'workspaces.provision'))
      .toEqual({ workspace })
    const handoffWorkspace = { ...workspace, workspace_id: `workspace-${'a'.repeat(32)}` }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { workspace: handoffWorkspace }, 'workspaces.get'))
      .toEqual({ workspace: handoffWorkspace })
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { workspace: { ...workspace, generation: 0 } }, 'workspaces.provision'))
      .toThrow(TypeError)
  })

  it('exposes local Codex through fixed operations with bounded renderer payloads', () => {
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.listProjects, [])).toEqual({
      channel: LOCAL_CODEX_CHANNELS.listProjects,
      args: [],
    })
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.listSessions, [{ projectId: 'codex-project:fixture' }])).toEqual({
      channel: LOCAL_CODEX_CHANNELS.listSessions,
      args: [{ projectId: 'codex-project:fixture' }],
    })
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.registerProject, [])).toEqual({
      channel: LOCAL_CODEX_CHANNELS.registerProject,
      args: [],
    })
    const workspaceId = `workspace-${'b'.repeat(32)}`
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.registerWorkspace, [{ workspaceId }])).toEqual({
      channel: LOCAL_CODEX_CHANNELS.registerWorkspace,
      args: [{ workspaceId }],
    })
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.startTurn, [{
      projectId: 'codex-project:fixture', prompt: 'Review this file',
    }])).toEqual({
      channel: LOCAL_CODEX_CHANNELS.startTurn,
      args: [{ projectId: 'codex-project:fixture', prompt: 'Review this file' }],
    })
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.startTurn, [{
      projectId: 'codex-project:fixture', prompt: 'Continue', sessionId: 'codex:thread-1',
    }]).args).toEqual([{ projectId: 'codex-project:fixture', prompt: 'Continue', sessionId: 'codex:thread-1' }])
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.startTurn, [{
      projectId: 'codex-project:fixture', prompt: 'x'.repeat(8000),
    }]).args[0]).toEqual({ projectId: 'codex-project:fixture', prompt: 'x'.repeat(8000) })
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.cancelTurn, [{ taskId: 'codex-task:fixture' }]).args)
      .toEqual([{ taskId: 'codex-task:fixture' }])
    expect(parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.answerApproval, [{ approvalId: 'approval-1', allow: true }]).args)
      .toEqual([{ approvalId: 'approval-1', allow: true }])

    for (const [channel, args] of [
      [LOCAL_CODEX_CHANNELS.registerProject, [{ rootPath: '/tmp/workspace' }]],
      [LOCAL_CODEX_CHANNELS.registerWorkspace, [{ workspaceId, root: '/etc' }]],
      [LOCAL_CODEX_CHANNELS.registerWorkspace, [{ workspaceId: 'workspace-../etc' }]],
      [LOCAL_CODEX_CHANNELS.listSessions, [{ projectId: 'wrong:fixture' }]],
      [LOCAL_CODEX_CHANNELS.startTurn, [{ projectId: 'codex-project:fixture', prompt: 'work', command: '/bin/sh' }]],
      [LOCAL_CODEX_CHANNELS.startTurn, [{ projectId: 'codex-project:fixture', prompt: 'work', sessionId: 'other:thread' }]],
      [LOCAL_CODEX_CHANNELS.startTurn, [{ projectId: 'codex-project:fixture', prompt: '  ' }]],
      [LOCAL_CODEX_CHANNELS.startTurn, [{ projectId: 'codex-project:fixture', prompt: 'x'.repeat(8001) }]],
      [LOCAL_CODEX_CHANNELS.cancelTurn, [{ taskId: 'prime:task' }]],
      [LOCAL_CODEX_CHANNELS.answerApproval, [{ approvalId: 'approval-1', allow: true, paths: ['/tmp/file'] }]],
      [LOCAL_CODEX_CHANNELS.event, [{ type: 'turn.completed', taskId: 'codex-task:fixture' }]],
    ] as const) {
      expect(() => parseLocalCodexRequest(channel, args)).toThrow(TypeError)
    }
    expect(() => parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.startTurn, new Array(1))).toThrow(TypeError)
  })

  it('validates bounded local project and acknowledged turn DTOs without leaking turn cwd', () => {
    const project = { id: 'codex-project:fixture', name: 'Fixture', rootPath: '/tmp/workspace' }
    expect(parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listProjects, [project])).toEqual([project])
    const session = { id: 'codex:thread-1', title: 'Inspect project', turnCount: 2 }
    expect(parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listSessions, [session])).toEqual([session])
    expect(parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.registerProject, null)).toBeNull()
    expect(parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.registerProject, project)).toEqual(project)
    expect(parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.registerWorkspace, project)).toEqual(project)
    expect(() => parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.registerWorkspace, null)).toThrow(TypeError)
    expect(parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.startTurn, {
      taskId: 'codex-task:fixture', projectId: project.id, sessionId: 'codex:thread-1', state: 'running',
    })).toEqual({
      taskId: 'codex-task:fixture', projectId: project.id, sessionId: 'codex:thread-1', state: 'running',
    })
    expect(parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.cancelTurn, false)).toBe(false)

    expect(() => parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listProjects, [
      { ...project, token: 'sentinel' },
    ])).toThrow(TypeError)
    expect(() => parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listSessions, [{ ...session, threadId: 'thread-1' }])).toThrow(TypeError)
    expect(() => parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.registerProject, {
      ...project, rootPath: '/tmp/workspace/../outside',
    })).toThrow(TypeError)
    expect(() => parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.startTurn, {
      taskId: 'codex-task:fixture', projectId: project.id, sessionId: 'codex:thread-1',
      state: 'running', cwd: '/tmp/workspace',
    })).toThrow(TypeError)
    expect(() => parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.startTurn, {
      taskId: 'codex-task:fixture', projectId: project.id, sessionId: 'codex:thread-1', state: 'starting',
    })).toThrow(TypeError)
    expect(() => parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listProjects, Array.from({ length: 101 }, (_, index) => ({
      ...project, id: `codex-project:fixture-${index}`,
    }))))
      .toThrow(TypeError)
    const nearLimitProjectList = Array.from({ length: 4 }, (_, index) => ({
      ...project,
      id: `codex-project:fixture-${index}`,
      rootPath: `/tmp/${'p'.repeat(15_000)}`,
    }))
    expect(new TextEncoder().encode(JSON.stringify(nearLimitProjectList)).byteLength).toBeLessThan(64 * 1024)
    expect(parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listProjects, nearLimitProjectList)).toHaveLength(4)
    const oversizedProjectList = Array.from({ length: 5 }, (_, index) => ({
      ...project,
      id: `codex-project:fixture-${index}`,
      rootPath: `/tmp/${'p'.repeat(15_000)}`,
    }))
    expect(new TextEncoder().encode(JSON.stringify(oversizedProjectList)).byteLength).toBeGreaterThan(64 * 1024)
    expect(() => parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listProjects, oversizedProjectList)).toThrow(TypeError)
  })

  it('carries canonical workspace and proposed paths only in validated approval events', () => {
    const approvalEvent = {
      type: 'approval.requested',
      approval: {
        approvalId: 'approval-1',
        taskId: 'codex-task:fixture',
        projectId: 'codex-project:fixture',
        kind: 'file',
        reason: 'Update the requested source file',
        cwd: '/tmp/workspace',
        paths: ['/tmp/workspace/src/file.ts'],
        changes: [{ path: '/tmp/workspace/src/file.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n' }],
      },
    }
    expect(parseLocalCodexEvent(approvalEvent)).toEqual(approvalEvent)
    expect(parseLocalCodexEvent({ type: 'turn.output', taskId: 'codex-task:fixture', text: 'hello' }))
      .toEqual({ type: 'turn.output', taskId: 'codex-task:fixture', text: 'hello' })
    expect(parseLocalCodexEvent({ type: 'turn.output', taskId: 'codex-task:fixture', text: 'x'.repeat(8000) }))
      .toEqual({ type: 'turn.output', taskId: 'codex-task:fixture', text: 'x'.repeat(8000) })
    expect(parseLocalCodexEvent({ type: 'turn.completed', taskId: 'codex-task:fixture' }))
      .toEqual({ type: 'turn.completed', taskId: 'codex-task:fixture' })
    expect(parseLocalCodexEvent({ type: 'turn.cancelled', taskId: 'codex-task:fixture' }))
      .toEqual({ type: 'turn.cancelled', taskId: 'codex-task:fixture' })
    expect(parseLocalCodexEvent({ type: 'turn.failed', taskId: 'codex-task:fixture', message: 'Native turn failed' }))
      .toEqual({ type: 'turn.failed', taskId: 'codex-task:fixture', message: 'Native turn failed' })
    expect(parseLocalCodexEvent({ type: 'approval.requested', approval: {
      approvalId: 'approval-1', taskId: 'codex-task:fixture', projectId: 'codex-project:fixture',
      kind: 'command', reason: 'Run build', cwd: '/tmp/workspace', paths: [], command: 'npm test',
    } })).toEqual({ type: 'approval.requested', approval: {
      approvalId: 'approval-1', taskId: 'codex-task:fixture', projectId: 'codex-project:fixture',
      kind: 'command', reason: 'Run build', cwd: '/tmp/workspace', paths: [], command: 'npm test',
    } })

    expect(() => parseLocalCodexEvent({ ...approvalEvent, approval: {
      ...approvalEvent.approval, paths: ['/tmp/workspace/../outside'],
    } })).toThrow(TypeError)
    expect(() => parseLocalCodexEvent({ ...approvalEvent, approval: {
      ...approvalEvent.approval, command: '/bin/sh',
    } })).toThrow(TypeError)
    expect(() => parseLocalCodexEvent({ ...approvalEvent, approval: {
      ...approvalEvent.approval,
      paths: ['/tmp/workspace/src/other.ts'],
    } })).toThrow(TypeError)
    expect(() => parseLocalCodexEvent({ ...approvalEvent, approval: {
      ...approvalEvent.approval,
      changes: [{ path: '/tmp/workspace/src/file.ts', kind: 'copy', diff: '+new' }],
    } })).toThrow(TypeError)
    expect(() => parseLocalCodexEvent({ ...approvalEvent, approval: {
      ...approvalEvent.approval,
      changes: [{ path: '/tmp/workspace/src/file.ts', kind: 'update', diff: '' }],
    } })).toThrow(TypeError)
    expect(() => parseLocalCodexEvent({ ...approvalEvent, approval: {
      ...approvalEvent.approval,
      changes: [{ path: '/tmp/workspace/src/file.ts', kind: 'update', diff: `x${String.fromCharCode(0xd800)}` }],
    } })).toThrow(TypeError)
    expect(() => parseLocalCodexEvent({ ...approvalEvent, approval: {
      ...approvalEvent.approval,
      changes: [{ path: '/tmp/workspace/src/file.ts', kind: 'update', diff: 'x'.repeat(16_001) }],
    } })).toThrow(TypeError)
    const sparsePaths = new Array(1)
    expect(() => parseLocalCodexEvent({ ...approvalEvent, approval: {
      ...approvalEvent.approval, paths: sparsePaths,
    } })).toThrow(TypeError)
    expect(() => parseLocalCodexEvent({
      type: 'turn.output', taskId: 'codex-task:fixture', text: 'x'.repeat(8001),
    })).toThrow(TypeError)
    let invoked = false
    const hostile = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() { invoked = true; return 'turn.completed' },
    })
    expect(() => parseLocalCodexEvent(hostile)).toThrow(TypeError)
    expect(invoked).toBe(false)
  })
})


describe('language profile report validation', () => {
  const workspaceId = `workspace-${'a'.repeat(32)}`

  function extension(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      extensionId: 'ms-python.python', version: '2026.4.0', marketplace: 'open-vsx', declaredLicence: 'MIT',
      licenceSha256: 'b'.repeat(64), vsixSha256: 'c'.repeat(64), vsixBytes: 6826731,
      downloadUrl: 'https://open-vsx.org/api/ms-python/python/2026.4.0/file/x.vsix',
      targetPlatform: null, pinnedInstalledSha256: 'd'.repeat(64), state: 'installed', reason: null,
      installedVersion: '2026.4.0', installedDirectory: 'ms-python.python-2026.4.0',
      measuredSha256: 'd'.repeat(64), measuredFiles: 2381, installedLicenceField: 'MIT',
      ...overrides,
    }
  }

  function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      extensionsDirectory: '/home/user/.local/share/code-server/extensions',
      profiles: [{
        profile: 'python', label: 'Python', languageIds: ['python'], extensions: [extension()],
        debuggers: [], unsupported: [{ feature: 'pylance-language-server', reason: 'proprietary and absent' }],
      }],
      unpinnedInstalled: [],
      pinsVerified: false,
      note: 'Installed means the pinned version is present and its files still hash to the recorded digest.',
    debug: {
      adapters: [],
      unsupported: [{ profile: null, feature: 'dap-session-control', reason: 'this server cannot start a session' }],
      codeServer: null,
      sessionExercised: false,
      breakpointVerified: false,
      note: 'This block reports artefacts and gaps.',
    },
      ...overrides,
    }
  }

  it('accepts only the documented request shape for a workspace id', () => {
    expect(parseLanguageProfilesRequest(LANGUAGE_PROFILES_CHANNELS.list, [{ workspaceId }])).toEqual({ workspaceId })
    expect(() => parseLanguageProfilesRequest(LANGUAGE_PROFILES_CHANNELS.list, [])).toThrow(TypeError)
    expect(() => parseLanguageProfilesRequest(LANGUAGE_PROFILES_CHANNELS.list, [{ workspaceId, extra: 1 }])).toThrow(TypeError)
    expect(() => parseLanguageProfilesRequest(LANGUAGE_PROFILES_CHANNELS.list, [{ workspaceId: 'not-a-workspace' }])).toThrow(TypeError)
    expect(() => parseLanguageProfilesRequest('archon:workspace-services:list', [{ workspaceId }])).toThrow(TypeError)
  })

  it('accepts the documented report and rejects unknown, malformed or unbounded rows', () => {
    const parsed = parseLanguageProfilesBackendResponse(LANGUAGE_PROFILES_CHANNELS.list, report()) as {
      profiles: { extensions: { extensionId: string; state: string }[] }[]
    }
    expect(parsed.profiles[0]?.extensions[0]?.extensionId).toBe('ms-python.python')
    expect(parsed.profiles[0]?.extensions[0]?.state).toBe('installed')

    // An unknown key anywhere is refused instead of being passed to the renderer.
    expect(() => parseLanguageProfilesBackendResponse(LANGUAGE_PROFILES_CHANNELS.list, report({ extra: true }))).toThrow(TypeError)
    expect(() => parseLanguageProfilesBackendResponse(LANGUAGE_PROFILES_CHANNELS.list, report({
      profiles: [{ profile: 'python', label: 'Python', languageIds: ['python'], extensions: [extension({ injected: 1 })], debuggers: [], unsupported: [] }],
    }))).toThrow(TypeError)
    // Digests, states and URLs are bounded and typed.
    for (const bad of [
      { licenceSha256: 'short' }, { state: 'working' }, { downloadUrl: 'http://open-vsx.org/x.vsix' },
      { vsixBytes: -1 }, { reason: 'x'.repeat(2000) }, { extensionId: 'no-namespace' },
    ]) {
      expect(() => parseLanguageProfilesBackendResponse(LANGUAGE_PROFILES_CHANNELS.list, report({
        profiles: [{ profile: 'python', label: 'Python', languageIds: ['python'], extensions: [extension(bad)], debuggers: [], unsupported: [] }],
      }))).toThrow(TypeError)
    }
    expect(() => parseLanguageProfilesBackendResponse(LANGUAGE_PROFILES_CHANNELS.list, report({ pinsVerified: 'no' }))).toThrow(TypeError)
    expect(() => parseLanguageProfilesBackendResponse('archon:workspace-services:list', report())).toThrow(TypeError)
  })

  it('refuses a debug block that claims a session or a breakpoint', () => {
    const claimed = report({ debug: {
      adapters: [], unsupported: [], codeServer: null,
      sessionExercised: true, breakpointVerified: false, note: 'claimed',
    } })
    expect(() => parseLanguageProfilesBackendResponse(LANGUAGE_PROFILES_CHANNELS.list, claimed)).toThrow(TypeError)
    const verified = report({ debug: {
      adapters: [], unsupported: [], codeServer: null,
      sessionExercised: false, breakpointVerified: true, note: 'claimed',
    } })
    expect(() => parseLanguageProfilesBackendResponse(LANGUAGE_PROFILES_CHANNELS.list, verified)).toThrow(TypeError)
    const unknownKey = report({ debug: {
      adapters: [], unsupported: [], codeServer: null,
      sessionExercised: false, breakpointVerified: false, note: 'ok', extra: 1,
    } })
    expect(() => parseLanguageProfilesBackendResponse(LANGUAGE_PROFILES_CHANNELS.list, unknownKey)).toThrow(TypeError)
  })
})
