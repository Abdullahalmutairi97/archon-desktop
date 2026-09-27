import type { WorkspaceConsoleBridge, WorkspaceConsoleScreenDto, WorkspaceConsoleTerminalDto, WorkspaceConsoleAttachTicketDto, WorkspaceConsoleAttachLeaseDto, WorkspaceConsoleAttachEventDto } from '../shared/bridge/types'
import { WORKSPACE_CONSOLE_CHANNELS, parseWorkspaceConsoleEvent, parseWorkspaceConsoleRequest, parseWorkspaceConsoleResponse } from '../shared/bridge/validation'
import type { LocalCodexIpcInvoker } from './localCodexBridge'

function invoke<T>(ipc: LocalCodexIpcInvoker, channel: string, input: unknown): Promise<T> {
  const request = parseWorkspaceConsoleRequest(channel, [input])
  return ipc.invoke(channel, request).then((value) => parseWorkspaceConsoleResponse(channel, value) as T)
}

/** Renderer-visible console methods are finite; no terminal command or route API is exposed. */
export function createWorkspaceConsoleBridge(ipc: LocalCodexIpcInvoker): WorkspaceConsoleBridge {
  return Object.freeze({
    list: (input: Parameters<WorkspaceConsoleBridge['list']>[0]) => invoke<readonly WorkspaceConsoleTerminalDto[]>(ipc, WORKSPACE_CONSOLE_CHANNELS.list, input),
    create: (input: Parameters<WorkspaceConsoleBridge['create']>[0]) => invoke<WorkspaceConsoleTerminalDto>(ipc, WORKSPACE_CONSOLE_CHANNELS.create, input),
    screen: (input: Parameters<WorkspaceConsoleBridge['screen']>[0]) => invoke<WorkspaceConsoleScreenDto>(ipc, WORKSPACE_CONSOLE_CHANNELS.screen, input),
    sendLine: (input: Parameters<WorkspaceConsoleBridge['sendLine']>[0]) => invoke<boolean>(ipc, WORKSPACE_CONSOLE_CHANNELS.sendLine, input),
    interrupt: (input: Parameters<WorkspaceConsoleBridge['interrupt']>[0]) => invoke<boolean>(ipc, WORKSPACE_CONSOLE_CHANNELS.interrupt, input),
    stop: (input: Parameters<WorkspaceConsoleBridge['stop']>[0]) => invoke<boolean>(ipc, WORKSPACE_CONSOLE_CHANNELS.stop, input),
    attach: (input: Parameters<WorkspaceConsoleBridge['attach']>[0]) => invoke<WorkspaceConsoleAttachTicketDto>(ipc, WORKSPACE_CONSOLE_CHANNELS.attachOpen, input),
    claim: (input: Parameters<WorkspaceConsoleBridge['claim']>[0]) => invoke<WorkspaceConsoleAttachLeaseDto>(ipc, WORKSPACE_CONSOLE_CHANNELS.attachClaim, input),
    attachScreen: (input: Parameters<WorkspaceConsoleBridge['attachScreen']>[0]) => invoke<WorkspaceConsoleScreenDto>(ipc, WORKSPACE_CONSOLE_CHANNELS.attachScreen, input),
    attachInput: (input: Parameters<WorkspaceConsoleBridge['attachInput']>[0]) => invoke<boolean>(ipc, WORKSPACE_CONSOLE_CHANNELS.attachInput, input),
    detach: (input: Parameters<WorkspaceConsoleBridge['detach']>[0]) => invoke<boolean>(ipc, WORKSPACE_CONSOLE_CHANNELS.attachDetach, input),
    watch: (input: Parameters<WorkspaceConsoleBridge['watch']>[0]) => invoke<boolean>(ipc, WORKSPACE_CONSOLE_CHANNELS.attachWatch, input),
    unwatch: (input: Parameters<WorkspaceConsoleBridge['unwatch']>[0]) => invoke<boolean>(ipc, WORKSPACE_CONSOLE_CHANNELS.attachUnwatch, input),
    subscribe: (listener: (event: WorkspaceConsoleAttachEventDto) => void): (() => void) => {
      if (typeof listener !== 'function' || !ipc.on || !ipc.removeListener) {
        throw new TypeError('Console attach subscription is unavailable.')
      }
      const onEvent = (_event: unknown, ...args: unknown[]) => {
        if (args.length !== 1) return
        let safeEvent: WorkspaceConsoleAttachEventDto
        try {
          safeEvent = parseWorkspaceConsoleEvent(args[0])
        } catch {
          return
        }
        listener(safeEvent)
      }
      ipc.on(WORKSPACE_CONSOLE_CHANNELS.attachEvent, onEvent)
      let active = true
      return () => {
        if (!active) return
        active = false
        ipc.removeListener?.(WORKSPACE_CONSOLE_CHANNELS.attachEvent, onEvent)
      }
    },
  }) satisfies WorkspaceConsoleBridge
}
