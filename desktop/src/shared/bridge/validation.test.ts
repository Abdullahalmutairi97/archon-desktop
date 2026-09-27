import { describe, expect, it } from 'vitest'
import {
  BRIDGE_CHANNELS,
  LOCAL_CODEX_CHANNELS,
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
    for (const [operation, payload] of [
      ['not-an-operation', {}],
      ['readiness', { url: 'http://localhost' }],
      ['sessions.list', { projectId: 'x'.repeat(201) }],
      ['sessions.list', { limit: 501 }],
      ['tasks.list', { limit: 0 }],
      ['events.cursor', { after: 12 }],
      ['workspaces.list', { limit: 501 }],
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
  })

  it('accepts only the narrow Prime submit/get/events/cancel payloads', () => {
    expect(parseOperationRequest('runtimes.list', {})).toEqual(['runtimes.list', {}])
    expect(parseOperationRequest('tasks.submit', { projectId: 'project-1', prompt: 'Inspect this project' })).toEqual([
      'tasks.submit', { projectId: 'project-1', prompt: 'Inspect this project' },
    ])
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
      ['tasks.get', { taskId: '../outside' }],
      ['tasks.cancel', { taskId: 'task?id=outside' }],
      ['tasks.events', { taskId: 'task_1', after: -1 }],
      ['tasks.events', { taskId: 'task_1', after: 1.5 }],
      ['tasks.events', { taskId: 'task_1', after: Number.MAX_SAFE_INTEGER + 1 }],
    ] as const) {
      expect(() => parseOperationRequest(operation, payload)).toThrow(TypeError)
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
