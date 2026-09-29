import { BRIDGE_CHANNELS, parseBridgeRequest, parseBridgeResponse } from '../shared/bridge/validation'
import type { ConnectionSaveInput, OperationName, OperationMap } from '../shared/bridge/types'
import { assertBoundedIpcPayload, IPC_PAYLOAD_LIMITS, ipcPayloadLimitsForOperation } from './security/TrustedShellFrameGuard'

type InvokeHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

export interface IpcRegistrar {
  handle(channel: string, handler: InvokeHandler): void
  removeHandler(channel: string): void
}

export interface DesktopBridgeService {
  describe(): Promise<unknown>
  save(input: ConnectionSaveInput): Promise<unknown>
  disconnect(): Promise<unknown>
  probe(): Promise<unknown>
  invoke<K extends OperationName>(operation: K, payload: OperationMap[K]['payload']): Promise<unknown>
}

export function registerBridgeHandlers(
  ipc: IpcRegistrar,
  guard: (event: unknown) => boolean | void,
  service: DesktopBridgeService,
): () => void {
  for (const channel of Object.values(BRIDGE_CHANNELS)) {
    ipc.handle(channel, async (event, ...args) => {
      if (guard(event) === false) throw new Error('Untrusted desktop frame')
      // Only an `audio.transcribe` invoke may use the larger audio envelope; the
      // operation name is read from a data property, never through an accessor.
      assertBoundedIpcPayload(args, channel === BRIDGE_CHANNELS.apiInvoke && Array.isArray(args)
        ? ipcPayloadLimitsForOperation(Object.getOwnPropertyDescriptor(args, 0)?.value)
        : IPC_PAYLOAD_LIMITS)
      const request = parseBridgeRequest(channel, args)
      let result: unknown
      switch (request.channel) {
        case 'archon:connection:describe':
          result = await service.describe()
          break
        case 'archon:connection:save':
          result = await service.save(request.args[0] as ConnectionSaveInput)
          break
        case 'archon:connection:disconnect':
          result = await service.disconnect()
          break
        case 'archon:connection:probe':
          result = await service.probe()
          break
        case 'archon:api:invoke':
          result = await service.invoke(
            request.args[0] as OperationName,
            request.args[1] as OperationMap[OperationName]['payload'],
          )
          break
      }
      if (guard(event) === false) throw new Error('Untrusted desktop frame')
      return parseBridgeResponse(request.channel, result,
        request.channel === BRIDGE_CHANNELS.apiInvoke ? request.args[0] : undefined)
    })
  }
  return () => {
    for (const channel of Object.values(BRIDGE_CHANNELS)) ipc.removeHandler(channel)
  }
}
