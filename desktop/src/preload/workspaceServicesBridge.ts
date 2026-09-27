import type { WorkspaceServicesBridge, WorkspaceServiceDto, WorkspaceServiceLogsDto } from '../shared/bridge/types'
import { WORKSPACE_SERVICES_CHANNELS, parseWorkspaceServicesRequest, parseWorkspaceServicesResponse } from '../shared/bridge/validation'
import type { LocalCodexIpcInvoker } from './localCodexBridge'

function invoke<T>(ipc: LocalCodexIpcInvoker, channel: string, input: unknown): Promise<T> {
  const request = parseWorkspaceServicesRequest(channel, [input])
  return ipc.invoke(channel, request).then((value) => parseWorkspaceServicesResponse(channel, value) as T)
}

/** Renderer-visible service methods are finite; no argv, cwd or route API is exposed directly. */
export function createWorkspaceServicesBridge(ipc: LocalCodexIpcInvoker): WorkspaceServicesBridge {
  return Object.freeze({
    list: (input: Parameters<WorkspaceServicesBridge['list']>[0]) => invoke<readonly WorkspaceServiceDto[]>(ipc, WORKSPACE_SERVICES_CHANNELS.list, input),
    define: (input: Parameters<WorkspaceServicesBridge['define']>[0]) => invoke<WorkspaceServiceDto>(ipc, WORKSPACE_SERVICES_CHANNELS.define, input),
    remove: (input: Parameters<WorkspaceServicesBridge['remove']>[0]) => invoke<boolean>(ipc, WORKSPACE_SERVICES_CHANNELS.remove, input),
    start: (input: Parameters<WorkspaceServicesBridge['start']>[0]) => invoke<WorkspaceServiceDto>(ipc, WORKSPACE_SERVICES_CHANNELS.start, input),
    stop: (input: Parameters<WorkspaceServicesBridge['stop']>[0]) => invoke<boolean>(ipc, WORKSPACE_SERVICES_CHANNELS.stop, input),
    logs: (input: Parameters<WorkspaceServicesBridge['logs']>[0]) => invoke<WorkspaceServiceLogsDto>(ipc, WORKSPACE_SERVICES_CHANNELS.logs, input),
  }) satisfies WorkspaceServicesBridge
}
