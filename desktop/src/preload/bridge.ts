import type {
  ConnectionDescription,
  ConnectionProbeResult,
  ConnectionSaveInput,
  ConnectionSaveResult,
  DesktopBridge,
  OperationName,
  OperationPayload,
  OperationResult,
} from '../shared/bridge/types'
import { BRIDGE_CHANNELS, parseBridgeRequest } from '../shared/bridge/validation'
import { createBrowserBridge } from './browserBridge'
import { createLocalCodexBridge } from './localCodexBridge'
import type { LocalCodexIpcInvoker } from './localCodexBridge'
import { createLanguageProfilesBridge } from './languageProfilesBridge'
import { createWorkspaceConsoleBridge } from './workspaceConsoleBridge'
import { createWorkspacePreviewBridge } from './workspacePreviewBridge'
import { createWorkspaceServicesBridge } from './workspaceServicesBridge'

export interface BridgeIpcInvoker extends LocalCodexIpcInvoker {}

/** Build the only API surface that the preload may expose to the renderer. */
export function createDesktopBridge(ipc: BridgeIpcInvoker): DesktopBridge {
  const connection = Object.freeze({
    describe: (): Promise<ConnectionDescription> => ipc.invoke(BRIDGE_CHANNELS.connectionDescribe) as Promise<ConnectionDescription>,
    save: (input: ConnectionSaveInput): Promise<ConnectionSaveResult> => {
      const request = parseBridgeRequest(BRIDGE_CHANNELS.connectionSave, [input])
      return ipc.invoke(request.channel, ...request.args) as Promise<ConnectionSaveResult>
    },
    disconnect: (): Promise<ConnectionDescription> => ipc.invoke(BRIDGE_CHANNELS.connectionDisconnect) as Promise<ConnectionDescription>,
    probe: (): Promise<ConnectionProbeResult> => ipc.invoke(BRIDGE_CHANNELS.connectionProbe) as Promise<ConnectionProbeResult>,
  })

  const api = Object.freeze({
    invoke: <K extends OperationName>(operation: K, payload: OperationPayload<K>): Promise<OperationResult<K>> => {
      const request = parseBridgeRequest(BRIDGE_CHANNELS.apiInvoke, [operation, payload])
      return ipc.invoke(request.channel, ...request.args) as Promise<OperationResult<K>>
    },
  })

  return Object.freeze({
    connection,
    api,
    localCodex: createLocalCodexBridge(ipc),
    workspaceConsole: createWorkspaceConsoleBridge(ipc),
    workspaceServices: createWorkspaceServicesBridge(ipc),
    languageProfiles: createLanguageProfilesBridge(ipc),
    workspacePreview: createWorkspacePreviewBridge(ipc),
    browser: createBrowserBridge(ipc),
  })
}
