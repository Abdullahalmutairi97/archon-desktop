import type { LocalCodexProxyRequest } from './localCodexProxy'
import type { WorkspaceConsoleKeyEvent } from '../shared/bridge/types'
import { WORKSPACE_CONSOLE_CHANNELS, parseWorkspaceConsoleBackendResponse, parseWorkspaceConsoleRequest } from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import { assertBoundedIpcPayload } from './security/TrustedShellFrameGuard'

interface ConsoleWindowLike {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
  }
}

export interface RegisterWorkspaceConsoleOptions {
  ipc: IpcRegistrar
  guard(event: unknown): boolean | void
  invokePairedLocalCodex(request: LocalCodexProxyRequest): Promise<unknown>
  getWindow(): ConsoleWindowLike | undefined
}

const proxiedChannels = Object.freeze([
  WORKSPACE_CONSOLE_CHANNELS.list,
  WORKSPACE_CONSOLE_CHANNELS.create,
  WORKSPACE_CONSOLE_CHANNELS.screen,
  WORKSPACE_CONSOLE_CHANNELS.sendLine,
  WORKSPACE_CONSOLE_CHANNELS.interrupt,
  WORKSPACE_CONSOLE_CHANNELS.stop,
  WORKSPACE_CONSOLE_CHANNELS.attachOpen,
  WORKSPACE_CONSOLE_CHANNELS.attachClaim,
  WORKSPACE_CONSOLE_CHANNELS.attachScreen,
  WORKSPACE_CONSOLE_CHANNELS.attachInput,
  WORKSPACE_CONSOLE_CHANNELS.attachDetach,
])

const WATCH_INTERVAL_MS = 600

function assertTrusted(guard: RegisterWorkspaceConsoleOptions['guard'], event: unknown): void {
  if (guard(event) === false) throw new Error('Untrusted desktop frame')
}

function proxyRequest(channel: string, input: Readonly<Record<string, unknown>>): LocalCodexProxyRequest {
  switch (channel) {
    case WORKSPACE_CONSOLE_CHANNELS.list:
      return { operation: 'workspace.terminals.list', workspaceId: input.workspaceId as string }
    case WORKSPACE_CONSOLE_CHANNELS.create:
      return { operation: 'workspace.terminals.create', workspaceId: input.workspaceId as string, expectedGeneration: input.expectedGeneration as number }
    case WORKSPACE_CONSOLE_CHANNELS.screen:
      return { operation: 'workspace.terminals.screen', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string, lines: input.lines as number }
    case WORKSPACE_CONSOLE_CHANNELS.sendLine:
      return { operation: 'workspace.terminals.input', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string, line: input.line as string }
    case WORKSPACE_CONSOLE_CHANNELS.interrupt:
      return { operation: 'workspace.terminals.interrupt', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string }
    case WORKSPACE_CONSOLE_CHANNELS.stop:
      return { operation: 'workspace.terminals.stop', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string }
    case WORKSPACE_CONSOLE_CHANNELS.attachOpen:
      return { operation: 'workspace.terminals.attach.open', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string, expectedGeneration: input.expectedGeneration as number, mode: input.mode as 'control' | 'read-only' }
    case WORKSPACE_CONSOLE_CHANNELS.attachClaim:
      return { operation: 'workspace.terminals.attach.claim', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string, ticket: input.ticket as string }
    case WORKSPACE_CONSOLE_CHANNELS.attachScreen:
      return { operation: 'workspace.terminals.attach.screen', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string, attachId: input.attachId as string, lines: input.lines as number }
    case WORKSPACE_CONSOLE_CHANNELS.attachInput:
      return { operation: 'workspace.terminals.attach.input', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string, attachId: input.attachId as string, events: input.events as readonly WorkspaceConsoleKeyEvent[] }
    case WORKSPACE_CONSOLE_CHANNELS.attachDetach:
      return { operation: 'workspace.terminals.attach.detach', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string, attachId: input.attachId as string }
    default:
      throw new TypeError('Unsupported workspace console operation.')
  }
}

/** Fixed main-process IPC surface for the trusted same-user console and its attach stream. */
export function registerWorkspaceConsole(options: RegisterWorkspaceConsoleOptions): () => void {
  let watch: { workspaceId: string; sessionId: string; attachId: string; lines: number; timer: ReturnType<typeof setInterval>; cancelled: boolean } | undefined

  function stopWatch(): void {
    if (!watch) return
    clearInterval(watch.timer)
    watch.cancelled = true
    watch = undefined
  }

  function emit(event: unknown): void {
    const window = options.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(WORKSPACE_CONSOLE_CHANNELS.attachEvent, event)
  }

  for (const channel of proxiedChannels) {
    options.ipc.handle(channel, async (event, ...args) => {
      assertTrusted(options.guard, event)
      assertBoundedIpcPayload(args)
      const input = parseWorkspaceConsoleRequest(channel, args)
      try {
        const response = await options.invokePairedLocalCodex(proxyRequest(channel, input))
        assertTrusted(options.guard, event)
        assertBoundedIpcPayload(response)
        return parseWorkspaceConsoleBackendResponse(channel, response)
      } catch {
        assertTrusted(options.guard, event)
        // Do not include backend errors, paths, credentials, or command contents in IPC errors.
        const ambiguousAction = channel === WORKSPACE_CONSOLE_CHANNELS.interrupt ? 'interrupt' : 'action'
        throw new Error(`Workspace console ${ambiguousAction} outcome may be unknown. Refresh the session list and screen before any manual retry; the app will not retry requests.`)
      }
    })
  }

  options.ipc.handle(WORKSPACE_CONSOLE_CHANNELS.attachWatch, async (event, ...args) => {
    assertTrusted(options.guard, event)
    assertBoundedIpcPayload(args)
    const input = parseWorkspaceConsoleRequest(WORKSPACE_CONSOLE_CHANNELS.attachWatch, args)
    stopWatch()
    const state = {
      workspaceId: input.workspaceId as string,
      sessionId: input.sessionId as string,
      attachId: input.attachId as string,
      lines: input.lines as number,
      cancelled: false,
      timer: undefined as unknown as ReturnType<typeof setInterval>,
    }
    state.timer = setInterval(() => {
      if (state.cancelled) return
      void (async () => {
        try {
          const response = await options.invokePairedLocalCodex({
            operation: 'workspace.terminals.attach.screen',
            workspaceId: state.workspaceId,
            sessionId: state.sessionId,
            attachId: state.attachId,
            lines: state.lines,
          })
          if (state.cancelled) return
          const screen = parseWorkspaceConsoleBackendResponse(
            WORKSPACE_CONSOLE_CHANNELS.attachScreen, response,
          ) as { text: string; truncated: boolean }
          emit({ attachId: state.attachId, text: screen.text, truncated: screen.truncated })
        } catch {
          // A missed tick is not surfaced; the renderer keeps the last good frame.
        }
      })()
    }, WATCH_INTERVAL_MS)
    watch = state
    return true
  })

  options.ipc.handle(WORKSPACE_CONSOLE_CHANNELS.attachUnwatch, async (event, ...args) => {
    assertTrusted(options.guard, event)
    assertBoundedIpcPayload(args)
    parseWorkspaceConsoleRequest(WORKSPACE_CONSOLE_CHANNELS.attachUnwatch, args)
    stopWatch()
    return true
  })

  return () => {
    stopWatch()
    for (const channel of proxiedChannels) options.ipc.removeHandler(channel)
    options.ipc.removeHandler(WORKSPACE_CONSOLE_CHANNELS.attachWatch)
    options.ipc.removeHandler(WORKSPACE_CONSOLE_CHANNELS.attachUnwatch)
  }
}
