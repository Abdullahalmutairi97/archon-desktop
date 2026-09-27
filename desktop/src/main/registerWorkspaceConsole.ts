import type { LocalCodexProxyRequest } from './localCodexProxy'
import { WORKSPACE_CONSOLE_CHANNELS, parseWorkspaceConsoleBackendResponse, parseWorkspaceConsoleRequest } from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import { assertBoundedIpcPayload } from './security/TrustedShellFrameGuard'

export interface RegisterWorkspaceConsoleOptions {
  ipc: IpcRegistrar
  guard(event: unknown): boolean | void
  invokePairedLocalCodex(request: LocalCodexProxyRequest): Promise<unknown>
}

const channels = Object.freeze(Object.values(WORKSPACE_CONSOLE_CHANNELS))

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
    case WORKSPACE_CONSOLE_CHANNELS.stop:
      return { operation: 'workspace.terminals.stop', workspaceId: input.workspaceId as string, sessionId: input.sessionId as string }
    default:
      throw new TypeError('Unsupported workspace console operation.')
  }
}

/** Fixed main-process IPC surface for the trusted same-user line console. */
export function registerWorkspaceConsole(options: RegisterWorkspaceConsoleOptions): () => void {
  for (const channel of channels) {
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
        throw new Error('Workspace console outcome may be unknown. Refresh the session list and screen before any manual retry; the app will not retry lines.')
      }
    })
  }
  return () => { for (const channel of channels) options.ipc.removeHandler(channel) }
}
