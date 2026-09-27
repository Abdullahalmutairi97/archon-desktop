import type { LocalCodexProxyRequest } from './localCodexProxy'
import type { WorkspaceServiceDefinitionInput } from '../shared/bridge/types'
import { WORKSPACE_SERVICES_CHANNELS, parseWorkspaceServicesBackendResponse, parseWorkspaceServicesRequest } from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import { assertBoundedIpcPayload } from './security/TrustedShellFrameGuard'

export interface RegisterWorkspaceServicesOptions {
  ipc: IpcRegistrar
  guard(event: unknown): boolean | void
  invokePairedLocalCodex(request: LocalCodexProxyRequest): Promise<unknown>
}

const channels = Object.freeze(Object.values(WORKSPACE_SERVICES_CHANNELS))

function assertTrusted(guard: RegisterWorkspaceServicesOptions['guard'], event: unknown): void {
  if (guard(event) === false) throw new Error('Untrusted desktop frame')
}

function proxyRequest(channel: string, input: Readonly<Record<string, unknown>>): LocalCodexProxyRequest {
  switch (channel) {
    case WORKSPACE_SERVICES_CHANNELS.list:
      return { operation: 'workspace.services.list', workspaceId: input.workspaceId as string }
    case WORKSPACE_SERVICES_CHANNELS.define:
      return {
        operation: 'workspace.services.define',
        workspaceId: input.workspaceId as string,
        definition: input.definition as WorkspaceServiceDefinitionInput,
      }
    case WORKSPACE_SERVICES_CHANNELS.remove:
      return {
        operation: 'workspace.services.remove',
        workspaceId: input.workspaceId as string,
        name: input.name as string,
        confirm: input.confirm as boolean,
      }
    case WORKSPACE_SERVICES_CHANNELS.start:
      return { operation: 'workspace.services.start', workspaceId: input.workspaceId as string, name: input.name as string }
    case WORKSPACE_SERVICES_CHANNELS.stop:
      return {
        operation: 'workspace.services.stop',
        workspaceId: input.workspaceId as string,
        name: input.name as string,
        confirm: input.confirm as boolean,
      }
    case WORKSPACE_SERVICES_CHANNELS.logs:
      return {
        operation: 'workspace.services.logs',
        workspaceId: input.workspaceId as string,
        name: input.name as string,
        lines: input.lines as number,
      }
    default:
      throw new TypeError('Unsupported workspace service operation.')
  }
}

/** Fixed main-process IPC surface for the managed workspace service registry. */
export function registerWorkspaceServices(options: RegisterWorkspaceServicesOptions): () => void {
  for (const channel of channels) {
    options.ipc.handle(channel, async (event, ...args) => {
      assertTrusted(options.guard, event)
      assertBoundedIpcPayload(args)
      const input = parseWorkspaceServicesRequest(channel, args)
      try {
        const response = await options.invokePairedLocalCodex(proxyRequest(channel, input))
        assertTrusted(options.guard, event)
        assertBoundedIpcPayload(response)
        return parseWorkspaceServicesBackendResponse(channel, response)
      } catch {
        assertTrusted(options.guard, event)
        // Do not leak backend errors, paths or argv through IPC errors.
        throw new Error('Workspace service action may not have been applied. Refresh the service list before any manual retry; the app will not retry requests.')
      }
    })
  }
  return () => { for (const channel of channels) options.ipc.removeHandler(channel) }
}
