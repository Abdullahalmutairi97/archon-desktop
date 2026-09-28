import { describe, expect, it, vi } from 'vitest'
import { createDesktopBridge } from './bridge'
import { BRIDGE_CHANNELS, LANGUAGE_PROFILES_CHANNELS, WORKSPACE_CONSOLE_CHANNELS, WORKSPACE_PREVIEW_CHANNELS, WORKSPACE_SERVICES_CHANNELS } from '../shared/bridge/validation'

describe('preload bridge', () => {
  it('exposes only frozen finite methods and forwards canonical IPC calls', async () => {
    const invoke = vi.fn(async () => ({}))
    const bridge = createDesktopBridge({ invoke })

    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.isFrozen(bridge.connection)).toBe(true)
    expect(Object.isFrozen(bridge.api)).toBe(true)
    expect(Object.isFrozen(bridge.localCodex)).toBe(true)
    expect(Object.keys(bridge).sort()).toEqual([
      'api', 'connection', 'languageProfiles', 'localCodex', 'workspaceConsole', 'workspacePreview', 'workspaceServices',
    ])
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

  it('exposes fixed interactive attach calls and rejects malformed frames', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const attachId = `watt-${'c'.repeat(32)}`
    const invoke = vi.fn(async (channel: string) => {
      if (channel === WORKSPACE_CONSOLE_CHANNELS.attachOpen) return { ticket: attachId, mode: 'control', expiresAt: '2026-09-27T00:00:30Z' }
      if (channel === WORKSPACE_CONSOLE_CHANNELS.attachClaim) return { attachId, mode: 'control', expiresAt: '2026-09-27T00:02:00Z' }
      return true
    })
    const bridge = createDesktopBridge({ invoke })

    await expect(bridge.workspaceConsole.attach({ workspaceId, sessionId, expectedGeneration: 3, mode: 'control' }))
      .resolves.toEqual({ ticket: attachId, mode: 'control', expiresAt: '2026-09-27T00:00:30Z' })
    await expect(bridge.workspaceConsole.claim({ workspaceId, sessionId, ticket: attachId }))
      .resolves.toEqual({ attachId, mode: 'control', expiresAt: '2026-09-27T00:02:00Z' })
    await expect(bridge.workspaceConsole.attachInput({
      workspaceId, sessionId, attachId, events: [{ type: 'text', value: 'ls' }, { type: 'key', value: 'Up' }],
    })).resolves.toBe(true)
    await expect(bridge.workspaceConsole.detach({ workspaceId, sessionId, attachId })).resolves.toBe(true)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      WORKSPACE_CONSOLE_CHANNELS.attachOpen,
      WORKSPACE_CONSOLE_CHANNELS.attachClaim,
      WORKSPACE_CONSOLE_CHANNELS.attachInput,
      WORKSPACE_CONSOLE_CHANNELS.attachDetach,
    ])

    expect(() => bridge.workspaceConsole.attachInput({
      workspaceId, sessionId, attachId, events: [{ type: 'key', value: 'F13' as never }],
    })).toThrow(TypeError)
    expect(() => bridge.workspaceConsole.attachInput({
      workspaceId, sessionId, attachId, events: [{ type: 'text', value: 'bad\nframe' }],
    })).toThrow(TypeError)
    expect(() => bridge.workspaceConsole.attach({
      workspaceId, sessionId, expectedGeneration: 3, mode: 'write' as never,
    })).toThrow(TypeError)
    expect(invoke).toHaveBeenCalledTimes(4)
  })

  it('exposes fixed workspace service calls and rejects malformed definitions', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const service = {
      name: 'web', argv: ['/bin/echo', 'hi'], cwd: '.', ports: [{ name: 'http', port: 4173 }],
      restart: 'never', state: 'registered', exitCode: null, restarts: 0, health: 'unknown',
      memoryLimitMb: null, cpuQuotaPercent: null, tasksMax: null, filesystemIsolation: 'none', networkIsolation: 'host',
    }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === WORKSPACE_SERVICES_CHANNELS.list) return [service]
      if (channel === WORKSPACE_SERVICES_CHANNELS.logs) return { text: 'line', truncated: false }
      if (channel === WORKSPACE_SERVICES_CHANNELS.define || channel === WORKSPACE_SERVICES_CHANNELS.start || channel === WORKSPACE_SERVICES_CHANNELS.codeServer) return service
      return true
    })
    const bridge = createDesktopBridge({ invoke })
    const definition = {
      name: 'web', argv: ['/bin/echo', 'hi'], cwd: '.', env: [],
      ports: [{ name: 'http', port: 4173 }], health: null, dependsOn: [], restart: 'never' as const, memoryLimitMb: null,
    }
    await expect(bridge.workspaceServices.list({ workspaceId })).resolves.toEqual([service])
    await expect(bridge.workspaceServices.define({ workspaceId, definition })).resolves.toEqual(service)
    await expect(bridge.workspaceServices.start({ workspaceId, name: 'web' })).resolves.toEqual(service)
    await expect(bridge.workspaceServices.codeServer({ workspaceId, port: 4173 })).resolves.toEqual(service)
    await expect(bridge.workspaceServices.logs({ workspaceId, name: 'web', lines: 50 })).resolves.toEqual({ text: 'line', truncated: false })
    await expect(bridge.workspaceServices.stop({ workspaceId, name: 'web', confirm: true })).resolves.toBe(true)
    await expect(bridge.workspaceServices.remove({ workspaceId, name: 'web', confirm: true })).resolves.toBe(true)

    expect(() => bridge.workspaceServices.define({
      workspaceId,
      definition: { ...definition, argv: ['/bin/echo'] as unknown as readonly string[], name: 'Web' },
    })).toThrow(TypeError)
    expect(() => bridge.workspaceServices.define({
      workspaceId,
      definition: { ...definition, env: ['ARCHON_TOKEN'] },
    })).toThrow(TypeError)
    expect(() => bridge.workspaceServices.logs({ workspaceId, name: 'web', lines: 999 })).toThrow(TypeError)
  })

  it('exposes attach-stream watch/unwatch and a validated subscription', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const attachId = `watt-${'c'.repeat(32)}`
    let emitted: ((event: unknown, ...args: unknown[]) => void) | undefined
    const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => true)
    const bridge = createDesktopBridge({
      invoke,
      on: (_channel: string, listener: (event: unknown, ...args: unknown[]) => void) => { emitted = listener },
      removeListener: vi.fn(),
    })
    await expect(bridge.workspaceConsole.watch({ workspaceId, sessionId, attachId, lines: 80 })).resolves.toBe(true)
    await expect(bridge.workspaceConsole.unwatch({ workspaceId, sessionId, attachId })).resolves.toBe(true)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      WORKSPACE_CONSOLE_CHANNELS.attachWatch,
      WORKSPACE_CONSOLE_CHANNELS.attachUnwatch,
    ])
    const received: unknown[] = []
    const unsubscribe = bridge.workspaceConsole.subscribe((event) => received.push(event))
    emitted?.({}, { attachId, text: 'pane', truncated: false })
    emitted?.({}, { attachId, text: 'pane', truncated: 'no' })
    emitted?.({}, { attachId: 'bad', text: 'pane', truncated: false })
    expect(received).toEqual([{ attachId, text: 'pane', truncated: false }])
    unsubscribe()
  })

  it('exposes fixed preview calls and rejects malformed bounds', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const ticket = `wprev-${'d'.repeat(32)}`
    const invoke = vi.fn(async (channel: string) => {
      if (channel === WORKSPACE_PREVIEW_CHANNELS.open) {
        return { ticket, url: `http://127.0.0.1:9000/api/local/preview/${ticket}/`, mode: 'read-only', expiresAt: '2026-09-27T00:10:00Z' }
      }
      return true
    })
    const bridge = createDesktopBridge({ invoke })
    const bounds = { x: 10, y: 20, width: 640, height: 480 }
    await expect(bridge.workspacePreview.open({ workspaceId, name: 'web', expectedGeneration: 3, portName: null, bounds }))
      .resolves.toEqual({ ticket, url: `http://127.0.0.1:9000/api/local/preview/${ticket}/`, mode: 'read-only', expiresAt: '2026-09-27T00:10:00Z' })
    await expect(bridge.workspacePreview.bounds(bounds)).resolves.toBe(true)
    await expect(bridge.workspacePreview.close()).resolves.toBe(true)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      WORKSPACE_PREVIEW_CHANNELS.open,
      WORKSPACE_PREVIEW_CHANNELS.bounds,
      WORKSPACE_PREVIEW_CHANNELS.close,
    ])
    expect(() => bridge.workspacePreview.open({ workspaceId, name: 'web', expectedGeneration: 3, portName: 'Bad', bounds })).toThrow(TypeError)
    expect(() => bridge.workspacePreview.bounds({ x: 0, y: 0, width: 0, height: 10 })).toThrow(TypeError)
  })

  it('rejects unlisted operations and malformed payloads before IPC', async () => {
    const invoke = vi.fn(async () => ({}))
    const bridge = createDesktopBridge({ invoke })
    const unsafeBridge = bridge as unknown as { api: { invoke(operation: string, payload: unknown): Promise<unknown> } }

    expect(() => unsafeBridge.api.invoke('arbitrary.path', {})).toThrow(TypeError)
    expect(() => unsafeBridge.api.invoke('tasks.list', { limit: 10000 })).toThrow(TypeError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('exposes the read-only language profile report with a validated request', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const report = {
      extensionsDirectory: '/home/user/.local/share/code-server/extensions',
      profiles: [{
        profile: 'python', label: 'Python', languageIds: ['python'],
        extensions: [{
          extensionId: 'ms-python.python', version: '2026.4.0', marketplace: 'open-vsx', declaredLicence: 'MIT',
          licenceSha256: 'b'.repeat(64), vsixSha256: 'c'.repeat(64), vsixBytes: 6826731,
          downloadUrl: 'https://open-vsx.org/api/ms-python/python/2026.4.0/file/x.vsix',
          targetPlatform: null, pinnedInstalledSha256: 'd'.repeat(64), state: 'installed', reason: null,
          installedVersion: '2026.4.0', installedDirectory: 'ms-python.python-2026.4.0',
          measuredSha256: 'd'.repeat(64), measuredFiles: 2381, installedLicenceField: 'MIT',
        }],
        debuggers: [],
        unsupported: [{ feature: 'pylance-language-server', reason: 'proprietary and absent' }],
      }],
      unpinnedInstalled: [],
      pinsVerified: false,
      note: 'artefact record',
    debug: {
      adapters: [],
      unsupported: [{ profile: null, feature: 'dap-session-control', reason: 'this server cannot start a session' }],
      codeServer: null,
      sessionExercised: false,
      breakpointVerified: false,
      note: 'This block reports artefacts and gaps.',
    },
    }
    const invoke = vi.fn(async () => report)
    const bridge = createDesktopBridge({ invoke })

    await expect(bridge.languageProfiles.list({ workspaceId })).resolves.toMatchObject({ pinsVerified: false })
    expect(invoke).toHaveBeenCalledWith(LANGUAGE_PROFILES_CHANNELS.list, { workspaceId })

    // A malformed request never reaches IPC, and the bridge fails before it
    // returns a promise so a renderer cannot treat the call as in flight.
    invoke.mockClear()
    expect(() => bridge.languageProfiles.list({ workspaceId: 'nope' })).toThrow(TypeError)
    expect(() => bridge.languageProfiles.list({ workspaceId, extra: 1 } as unknown as { workspaceId: string }))
      .toThrow(TypeError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects an unvalidated language profile response instead of passing it on', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const invoke = vi.fn(async () => ({ extensionsDirectory: '/x', profiles: [], unpinnedInstalled: [], pinsVerified: false, note: 'x', injected: true }))
    const bridge = createDesktopBridge({ invoke })
    await expect(bridge.languageProfiles.list({ workspaceId })).rejects.toThrow(TypeError)
  })
})
