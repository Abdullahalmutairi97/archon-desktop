// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { LocalCodexProxyRequest } from './localCodexProxy'
import { LocalCodexBackendAdapter } from './localCodexBackendAdapter'

const project = { id: 'codex-project:fixture', name: 'Fixture', rootPath: '/tmp/fixture' }

describe('backend-owned Local Codex adapter', () => {
  it('maps owner API response envelopes into the existing renderer DTO contract', async () => {
    const invokePairedLocalCodex = vi.fn(async (request: LocalCodexProxyRequest): Promise<unknown> => {
      switch (request.operation) {
        case 'projects.list': return { projects: [project] }
        case 'sessions.list': return { sessions: [{ id: 'codex:session-1', title: 'Chat', turnCount: 1 }] }
        case 'workspaces.register': return { ...project, rootPath: request.rootPath }
        case 'turns.start': return {
          taskId: 'codex-task:fixture', projectId: request.projectId,
          sessionId: request.sessionId ?? 'codex:session-1', state: 'running',
        }
        case 'turns.cancel': return { cancelled: true }
        case 'approvals.answer': return { answered: true }
        case 'events.list': return { cursor: request.after, latest: request.after, oldest: request.after + 1, reset: false, events: [] }
      }
    })
    const adapter = new LocalCodexBackendAdapter({
      connection: { invokePairedLocalCodex },
      pickProjectDirectory: async () => '/tmp/selected',
    })

    await expect(adapter.listProjects()).resolves.toEqual([project])
    await expect(adapter.listSessions(project.id)).resolves.toEqual([
      { id: 'codex:session-1', title: 'Chat', turnCount: 1 },
    ])
    await expect(adapter.registerProject()).resolves.toEqual({ ...project, rootPath: '/tmp/selected' })
    await expect(adapter.startTurn({ projectId: project.id, prompt: 'inspect' })).resolves.toEqual({
      taskId: 'codex-task:fixture', projectId: project.id, sessionId: 'codex:session-1', state: 'running',
    })
    await expect(adapter.cancelTurn({ taskId: 'codex-task:fixture' })).resolves.toBe(true)
    await expect(adapter.answerApproval({ approvalId: 'approval-1', allow: true })).resolves.toBe(true)
    expect(invokePairedLocalCodex.mock.calls.map(([request]) => request.operation)).toEqual([
      'projects.list', 'sessions.list', 'workspaces.register', 'turns.start', 'turns.cancel', 'approvals.answer',
    ])
    adapter.close()
  })

  it('keeps turns single-attempt when the paired route reports an unknown outcome', async () => {
    const invokePairedLocalCodex = vi.fn(async () => { throw new Error('Local Codex start outcome is unknown') })
    const adapter = new LocalCodexBackendAdapter({ connection: { invokePairedLocalCodex } })

    await expect(adapter.startTurn({ projectId: project.id, prompt: 'run once' }))
      .rejects.toThrow(/outcome is unknown/i)
    expect(invokePairedLocalCodex).toHaveBeenCalledOnce()
    adapter.close()
  })

  it('delivers validated events in sequence and stops polling after unsubscribe', async () => {
    const invokePairedLocalCodex = vi.fn(async (request: LocalCodexProxyRequest): Promise<unknown> => {
      if (request.operation !== 'events.list') throw new Error('unexpected route')
      if (request.after === 0) return {
        cursor: 1,
        latest: 1,
        oldest: 1,
        reset: false,
        events: [{ seq: 1, event: { type: 'turn.output', taskId: 'codex-task:fixture', text: 'hello' } }],
      }
      return { cursor: request.after, latest: request.after, oldest: request.after + 1, reset: false, events: [] }
    })
    const adapter = new LocalCodexBackendAdapter({
      connection: { invokePairedLocalCodex }, pollIntervalMs: 2, retryIntervalMs: 2,
    })
    const events: unknown[] = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))
    await vi.waitFor(() => expect(events).toEqual([
      { type: 'turn.output', taskId: 'codex-task:fixture', text: 'hello' },
    ]))
    expect(invokePairedLocalCodex.mock.calls[0]?.[0]).toMatchObject({ operation: 'events.list', limit: 64 })
    unsubscribe()
    const callsAtUnsubscribe = invokePairedLocalCodex.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(invokePairedLocalCodex.mock.calls.length).toBeLessThanOrEqual(callsAtUnsubscribe + 1)
    adapter.close()
  })

  it('replays retained events after the owner worker resets its sequence', async () => {
    const observedAfter: number[] = []
    const invokePairedLocalCodex = vi.fn(async (request: LocalCodexProxyRequest): Promise<unknown> => {
      if (request.operation !== 'events.list') throw new Error('unexpected route')
      observedAfter.push(request.after)
      if (observedAfter.length === 1) return {
        cursor: 10, latest: 10, oldest: 5, reset: false, events: [],
      }
      if (request.after === 10) return {
        cursor: 1, latest: 1, oldest: 1, reset: true, events: [],
      }
      return {
        cursor: 1,
        latest: 1,
        oldest: 1,
        reset: false,
        events: [{ seq: 1, event: { type: 'turn.completed', taskId: 'codex-task:after-restart' } }],
      }
    })
    const adapter = new LocalCodexBackendAdapter({ connection: { invokePairedLocalCodex }, pollIntervalMs: 2 })
    const events: unknown[] = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))
    await vi.waitFor(() => expect(events).toEqual([
      { type: 'turn.completed', taskId: 'codex-task:after-restart' },
    ]))
    expect(observedAfter.slice(0, 3)).toEqual([0, 10, 0])
    unsubscribe()
    adapter.close()
  })
})
