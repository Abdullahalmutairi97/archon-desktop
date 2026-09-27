import type { WorkspaceConsoleBridge, WorkspaceConsoleScreenDto, WorkspaceConsoleTerminalDto } from '../shared/bridge/types'
import { WORKSPACE_CONSOLE_CHANNELS, parseWorkspaceConsoleRequest, parseWorkspaceConsoleResponse } from '../shared/bridge/validation'
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
    stop: (input: Parameters<WorkspaceConsoleBridge['stop']>[0]) => invoke<boolean>(ipc, WORKSPACE_CONSOLE_CHANNELS.stop, input),
  }) satisfies WorkspaceConsoleBridge
}
