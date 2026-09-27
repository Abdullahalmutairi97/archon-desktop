import type { WorkspacePreviewBridge, WorkspacePreviewOpenResult } from '../shared/bridge/types'
import { WORKSPACE_PREVIEW_CHANNELS, parseWorkspacePreviewRequest, parseWorkspacePreviewResponse } from '../shared/bridge/validation'
import type { LocalCodexIpcInvoker } from './localCodexBridge'

function invoke<T>(ipc: LocalCodexIpcInvoker, channel: string, input: unknown): Promise<T> {
  const request = parseWorkspacePreviewRequest(channel, [input])
  return ipc.invoke(channel, request).then((value) => parseWorkspacePreviewResponse(channel, value) as T)
}

/** Renderer-visible preview methods are finite; the renderer never builds a preview URL itself. */
export function createWorkspacePreviewBridge(ipc: LocalCodexIpcInvoker): WorkspacePreviewBridge {
  return Object.freeze({
    open: (input: Parameters<WorkspacePreviewBridge['open']>[0]) => invoke<WorkspacePreviewOpenResult>(ipc, WORKSPACE_PREVIEW_CHANNELS.open, input),
    bounds: (input: Parameters<WorkspacePreviewBridge['bounds']>[0]) => invoke<boolean>(ipc, WORKSPACE_PREVIEW_CHANNELS.bounds, input),
    close: () => invoke<boolean>(ipc, WORKSPACE_PREVIEW_CHANNELS.close, {}),
  }) satisfies WorkspacePreviewBridge
}
