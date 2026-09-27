// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { LocalCodexEvent, LocalCodexProjectDto } from '../shared/bridge/types'
import { LOCAL_CODEX_CHANNELS } from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import { registerLocalCodex } from './registerLocalCodex'
import type { LocalCodexIpcController, LocalCodexWindowLike } from './registerLocalCodex'

function createIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const ipc: IpcRegistrar = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: (channel) => { handlers.delete(channel) },
  }
  return { ipc, handlers }
}

function project(): LocalCodexProjectDto {
  return { id: 'codex-project:test', name: 'Fixture', rootPath: '/tmp/fixture' }
}

describe('fixed local Codex IPC registrar', () => {
  it('registers only the five fixed invokes and rejects extra renderer path input', async () => {
    const { ipc, handlers } = createIpc()
    const startTurn = vi.fn(async () => ({
      taskId: 'codex-task:test', projectId: 'codex-project:test', sessionId: 'codex:thread', state: 'running' as const,
    }))
    const controller: LocalCodexIpcController = {
      listProjects: async () => [project()],
      listSessions: async () => [],
      registerProject: async () => null,
      registerWorkspaceRoot: vi.fn(async (rootPath) => ({ ...project(), rootPath })),
      startTurn,
      cancelTurn: async () => false,
      answerApproval: () => false,
      subscribe: () => () => undefined,
    }
    const registration = registerLocalCodex({
      ipc,
      guard: () => true,
      trustedFrame: { assertTrusted: () => undefined },
      controller,
      getWorkspaceRoot: async () => '/tmp/server-workspace',
      getWindow: () => undefined,
    })
    expect([...handlers.keys()].sort()).toEqual(Object.values(LOCAL_CODEX_CHANNELS)
      .filter((channel) => channel !== LOCAL_CODEX_CHANNELS.event).sort())

    await expect(handlers.get(LOCAL_CODEX_CHANNELS.startTurn)!(
      {}, { projectId: 'codex-project:test', prompt: 'inspect', path: '/etc/passwd' },
    )).rejects.toThrow(/invalid desktop bridge request/i)
    expect(startTurn).not.toHaveBeenCalled()
    registration()
    expect(handlers.size).toBe(0)
  })

  it('resolves workspace handoff from only a validated identity and never accepts a renderer path', async () => {
    const { ipc, handlers } = createIpc()
    const workspaceId = `workspace-${'c'.repeat(32)}`
    const registerWorkspaceRoot = vi.fn(async (rootPath: string) => ({ ...project(), rootPath }))
    const getWorkspaceRoot = vi.fn(async (id: string) => `/srv/workspaces/${id}`)
    const controller: LocalCodexIpcController = {
      listProjects: async () => [],
      listSessions: async () => [],
      registerProject: async () => null,
      registerWorkspaceRoot,
      startTurn: async () => { throw new Error('unused') },
      cancelTurn: async () => false,
      answerApproval: () => false,
      subscribe: () => () => undefined,
    }
    const unregister = registerLocalCodex({
      ipc,
      guard: () => true,
      trustedFrame: { assertTrusted: () => undefined },
      controller,
      getWorkspaceRoot,
      getWindow: () => undefined,
    })
    const handoff = handlers.get(LOCAL_CODEX_CHANNELS.registerWorkspace)!

    await expect(handoff({}, { workspaceId })).resolves.toEqual({
      ...project(), rootPath: `/srv/workspaces/${workspaceId}`,
    })
    expect(getWorkspaceRoot).toHaveBeenCalledWith(workspaceId)
    expect(registerWorkspaceRoot).toHaveBeenCalledWith(`/srv/workspaces/${workspaceId}`)

    await expect(handoff({}, { workspaceId, rootPath: '/etc' })).rejects.toThrow(/invalid desktop bridge request/i)
    await expect(handoff({}, { workspaceId: 'workspace-../../etc' })).rejects.toThrow(/invalid desktop bridge request/i)
    expect(getWorkspaceRoot).toHaveBeenCalledOnce()
    expect(registerWorkspaceRoot).toHaveBeenCalledOnce()
    unregister()
  })

  it('rechecks trust after an async invoke and validates outbound events before send', async () => {
    const { ipc, handlers } = createIpc()
    const listProjects = vi.fn(async () => [project()])
    let onEvent: ((event: LocalCodexEvent) => void) | undefined
    const controller: LocalCodexIpcController = {
      listProjects,
      listSessions: async () => [],
      registerProject: async () => null,
      registerWorkspaceRoot: vi.fn(async (rootPath) => ({ ...project(), rootPath })),
      startTurn: async () => { throw new Error('unused') },
      cancelTurn: async () => false,
      answerApproval: () => false,
      subscribe: (listener) => { onEvent = listener; return () => { onEvent = undefined } },
    }
    const guard = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    const trust = vi.fn()
    const send = vi.fn()
    const window: LocalCodexWindowLike = {
      isDestroyed: () => false,
      webContents: {
        id: 4,
        isDestroyed: () => false,
        mainFrame: { url: 'file:///app/index.html', parent: null },
        send,
      },
    }
    const unregister = registerLocalCodex({ ipc, guard, trustedFrame: { assertTrusted: trust }, controller,
      getWorkspaceRoot: async () => '/tmp/server-workspace', getWindow: () => window })
    await expect(handlers.get(LOCAL_CODEX_CHANNELS.listProjects)!({})).rejects.toThrow(/untrusted desktop frame/i)
    expect(listProjects).toHaveBeenCalledTimes(1)

    trust.mockReset().mockImplementation(() => undefined)
    onEvent?.({ type: 'turn.output', taskId: 'codex-task:test', text: 'safe output' })
    expect(send).toHaveBeenCalledWith(LOCAL_CODEX_CHANNELS.event, {
      type: 'turn.output', taskId: 'codex-task:test', text: 'safe output',
    })
    onEvent?.({ type: 'turn.output', taskId: 'bad task', text: 'not validated' })
    expect(send).toHaveBeenCalledTimes(1)
    unregister()
  })
})
