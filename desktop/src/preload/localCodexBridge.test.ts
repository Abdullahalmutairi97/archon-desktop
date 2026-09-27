import { describe, expect, it, vi } from 'vitest'
import { LOCAL_CODEX_CHANNELS } from '../shared/bridge/validation'
import { createLocalCodexBridge } from './localCodexBridge'

const project = { id: 'codex-project:fixture', name: 'Fixture', rootPath: '/tmp/workspace' }
const turn = {
  taskId: 'codex-task:fixture',
  projectId: project.id,
  sessionId: 'codex:thread-1',
  state: 'running' as const,
}

describe('local Codex preload bridge', () => {
  it('forwards only the fixed local operations and validates each result', async () => {
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case LOCAL_CODEX_CHANNELS.listProjects: return [project]
        case LOCAL_CODEX_CHANNELS.registerProject: return null
        case LOCAL_CODEX_CHANNELS.startTurn: return turn
        case LOCAL_CODEX_CHANNELS.cancelTurn:
        case LOCAL_CODEX_CHANNELS.answerApproval: return true
        default: throw new Error('Unexpected IPC channel')
      }
    })
    const bridge = createLocalCodexBridge({ invoke })

    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.keys(bridge).sort()).toEqual([
      'answerApproval', 'cancelTurn', 'listProjects', 'registerProject', 'startTurn', 'subscribe',
    ])
    await expect(bridge.listProjects()).resolves.toEqual([project])
    await expect(bridge.registerProject()).resolves.toBeNull()
    await expect(bridge.startTurn({ projectId: project.id, prompt: 'Do the task' })).resolves.toEqual(turn)
    await expect(bridge.cancelTurn({ taskId: turn.taskId })).resolves.toBe(true)
    await expect(bridge.answerApproval({ approvalId: 'approval-1', allow: false })).resolves.toBe(true)
    expect(invoke.mock.calls).toEqual([
      [LOCAL_CODEX_CHANNELS.listProjects],
      [LOCAL_CODEX_CHANNELS.registerProject],
      [LOCAL_CODEX_CHANNELS.startTurn, { projectId: project.id, prompt: 'Do the task' }],
      [LOCAL_CODEX_CHANNELS.cancelTurn, { taskId: turn.taskId }],
      [LOCAL_CODEX_CHANNELS.answerApproval, { approvalId: 'approval-1', allow: false }],
    ])
  })

  it('blocks unsafe caller payloads before IPC and rejects malformed main results', async () => {
    const invoke = vi.fn(async (channel: string) => channel === LOCAL_CODEX_CHANNELS.listProjects
      ? [{ ...project, token: 'sentinel-token' }]
      : turn)
    const bridge = createLocalCodexBridge({ invoke })
    const unsafe = bridge as unknown as {
      startTurn(input: unknown): Promise<unknown>
      cancelTurn(input: unknown): Promise<unknown>
      answerApproval(input: unknown): Promise<unknown>
    }

    expect(() => unsafe.startTurn({ projectId: project.id, prompt: 'run', command: '/bin/sh' })).toThrow(TypeError)
    expect(() => unsafe.cancelTurn({ taskId: turn.taskId, cwd: '/tmp/workspace' })).toThrow(TypeError)
    expect(() => unsafe.answerApproval({ approvalId: 'approval-1', allow: true, paths: ['/tmp/file'] })).toThrow(TypeError)
    await expect(bridge.listProjects()).rejects.toThrow(TypeError)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('validates pushed events and removes exactly its own listener', () => {
    const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
    const on = vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      listeners.set(channel, listener)
    })
    const removeListener = vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    })
    const bridge = createLocalCodexBridge({
      invoke: vi.fn(async () => undefined),
      on,
      removeListener,
    })
    const received: unknown[] = []
    const unsubscribe = bridge.subscribe((event) => received.push(event))
    const listener = listeners.get(LOCAL_CODEX_CHANNELS.event)!
    listener({}, { type: 'turn.output', taskId: turn.taskId, text: 'hello' })
    listener({}, { type: 'turn.output', taskId: turn.taskId, text: 'x'.repeat(8001) })
    listener({}, { type: 'turn.completed', taskId: turn.taskId }, 'unexpected-extra-argument')

    expect(on).toHaveBeenCalledTimes(1)
    expect(on.mock.calls[0][0]).toBe(LOCAL_CODEX_CHANNELS.event)
    expect(received).toEqual([{ type: 'turn.output', taskId: turn.taskId, text: 'hello' }])
    unsubscribe()
    unsubscribe()
    expect(removeListener).toHaveBeenCalledTimes(1)
    expect(listeners.has(LOCAL_CODEX_CHANNELS.event)).toBe(false)
  })
})
