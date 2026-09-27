import { describe, expect, it, vi } from 'vitest'
import { createDesktopBridge } from './bridge'
import { BRIDGE_CHANNELS, WORKSPACE_CONSOLE_CHANNELS } from '../shared/bridge/validation'

describe('preload bridge', () => {
  it('exposes only frozen finite methods and forwards canonical IPC calls', async () => {
    const invoke = vi.fn(async () => ({}))
    const bridge = createDesktopBridge({ invoke })

    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.isFrozen(bridge.connection)).toBe(true)
    expect(Object.isFrozen(bridge.api)).toBe(true)
    expect(Object.isFrozen(bridge.localCodex)).toBe(true)
    expect(Object.keys(bridge).sort()).toEqual(['api', 'connection', 'localCodex', 'workspaceConsole'])
    expect(Object.keys(bridge.connection).sort()).toEqual(['describe', 'disconnect', 'probe', 'save'])
    expect(Object.keys(bridge.api)).toEqual(['invoke'])
    expect(Object.isFrozen(bridge.workspaceConsole)).toBe(true)

    await bridge.connection.describe()
    await bridge.connection.save({ serverUrl: 'https://archon.example', token: 'fake-token' })
    await bridge.connection.disconnect()
    await bridge.connection.probe()
    await bridge.api.invoke('sessions.list', { projectId: 'project-1', limit: 20 })

    expect(invoke.mock.calls).toEqual([
      [BRIDGE_CHANNELS.connectionDescribe],
      [BRIDGE_CHANNELS.connectionSave, { serverUrl: 'https://archon.example', token: 'fake-token' }],
      [BRIDGE_CHANNELS.connectionDisconnect],
      [BRIDGE_CHANNELS.connectionProbe],
      [BRIDGE_CHANNELS.apiInvoke, 'sessions.list', { projectId: 'project-1', limit: 20 }],
    ])
  })

  it('exposes only fixed, validated workspace console calls', async () => {
    const invoke = vi.fn(async (channel: string) => channel === WORKSPACE_CONSOLE_CHANNELS.list ? [] : true)
    const bridge = createDesktopBridge({ invoke })
    const workspaceId = `workspace-${'a'.repeat(32)}`

    await expect(bridge.workspaceConsole.list({ workspaceId })).resolves.toEqual([])
    await expect(bridge.workspaceConsole.sendLine({ workspaceId, sessionId: `wterm-${'b'.repeat(32)}`, line: 'status' })).resolves.toBe(true)
    await expect(bridge.workspaceConsole.interrupt({ workspaceId, sessionId: `wterm-${'b'.repeat(32)}` })).resolves.toBe(true)
    expect(invoke.mock.calls).toEqual([
      [WORKSPACE_CONSOLE_CHANNELS.list, { workspaceId }],
      [WORKSPACE_CONSOLE_CHANNELS.sendLine, { workspaceId, sessionId: `wterm-${'b'.repeat(32)}`, line: 'status' }],
      [WORKSPACE_CONSOLE_CHANNELS.interrupt, { workspaceId, sessionId: `wterm-${'b'.repeat(32)}` }],
    ])

    expect(() => bridge.workspaceConsole.sendLine({ workspaceId, sessionId: `wterm-${'b'.repeat(32)}`, line: 'bad\ncommand' })).toThrow(TypeError)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('rejects unlisted operations and malformed payloads before IPC', async () => {
    const invoke = vi.fn(async () => ({}))
    const bridge = createDesktopBridge({ invoke })
    const unsafeBridge = bridge as unknown as { api: { invoke(operation: string, payload: unknown): Promise<unknown> } }

    expect(() => unsafeBridge.api.invoke('arbitrary.path', {})).toThrow(TypeError)
    expect(() => unsafeBridge.api.invoke('tasks.list', { limit: 10000 })).toThrow(TypeError)
    expect(invoke).not.toHaveBeenCalled()
  })
})
