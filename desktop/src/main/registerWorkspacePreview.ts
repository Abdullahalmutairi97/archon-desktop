import type { LocalCodexProxyRequest } from './localCodexProxy'
import type { WorkspacePreviewBounds } from '../shared/bridge/types'
import { WORKSPACE_PREVIEW_CHANNELS, parseWorkspacePreviewRequest, parseWorkspacePreviewResponse } from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import { assertBoundedIpcPayload } from './security/TrustedShellFrameGuard'

export interface RegisterWorkspacePreviewOptions {
  ipc: IpcRegistrar
  guard(event: unknown): boolean | void
  invokePairedLocalCodex(request: LocalCodexProxyRequest): Promise<unknown>
  serverUrl(): Promise<string | null>
  open(url: string, bounds: WorkspacePreviewBounds): Promise<void>
  setBounds(bounds: WorkspacePreviewBounds): boolean
  close(): boolean
}

const channels = Object.freeze(Object.values(WORKSPACE_PREVIEW_CHANNELS))

function assertTrusted(guard: RegisterWorkspacePreviewOptions['guard'], event: unknown): void {
  if (guard(event) === false) throw new Error('Untrusted desktop frame')
}

/** Fixed main-process IPC surface for the sandboxed native preview view. */
export function registerWorkspacePreview(options: RegisterWorkspacePreviewOptions): () => void {
  options.ipc.handle(WORKSPACE_PREVIEW_CHANNELS.open, async (event, ...args) => {
    assertTrusted(options.guard, event)
    assertBoundedIpcPayload(args)
    const input = parseWorkspacePreviewRequest(WORKSPACE_PREVIEW_CHANNELS.open, args)
    const base = await options.serverUrl()
    if (!base) throw new Error('A paired local connection is required for a preview')
    const response = await options.invokePairedLocalCodex({
      operation: 'workspace.services.preview.open',
      workspaceId: input.workspaceId as string,
      name: input.name as string,
      expectedGeneration: input.expectedGeneration as number,
      portName: input.portName as string | null,
    })
    const preview = (response as { preview?: unknown }).preview
    if (typeof preview !== 'object' || preview === null) throw new Error('Preview was not authorized')
    const record = preview as Record<string, unknown>
    const ticket = record.ticket
    const expiresAt = record.expiresAt
    if (typeof ticket !== 'string' || !/^wprev-[0-9a-f]{32}$/u.test(ticket)
      || record.mode !== 'read-only'
      || typeof expiresAt !== 'string') {
      throw new Error('Preview was not authorized')
    }
    const url = new URL(`/api/local/preview/${ticket}/`, base).toString()
    assertTrusted(options.guard, event)
    await options.open(url, input.bounds as WorkspacePreviewBounds)
    return parseWorkspacePreviewResponse(WORKSPACE_PREVIEW_CHANNELS.open, {
      ticket, url, mode: 'read-only', expiresAt,
    })
  })

  options.ipc.handle(WORKSPACE_PREVIEW_CHANNELS.bounds, async (event, ...args) => {
    assertTrusted(options.guard, event)
    assertBoundedIpcPayload(args)
    const input = parseWorkspacePreviewRequest(WORKSPACE_PREVIEW_CHANNELS.bounds, args)
    return options.setBounds(input.bounds as WorkspacePreviewBounds)
  })

  options.ipc.handle(WORKSPACE_PREVIEW_CHANNELS.close, async (event, ...args) => {
    assertTrusted(options.guard, event)
    assertBoundedIpcPayload(args)
    parseWorkspacePreviewRequest(WORKSPACE_PREVIEW_CHANNELS.close, args)
    return options.close()
  })

  return () => { for (const channel of channels) options.ipc.removeHandler(channel) }
}
