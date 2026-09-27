import type {
  ConnectionDescription,
  ConnectionProbeResult,
  ConnectionSaveInput,
  ConnectionSaveResult,
  OperationMap,
  OperationName,
} from '../shared/bridge/types'
import type { CredentialDescription, CredentialStore } from './storage/credentialStore'
import { validateBackendConnectionInput } from './transport/backendTransport'

/** The transport and its credential remain exclusively in the main process. */
export interface ConnectionTransportPort {
  readonly generation: number
  switchConnection(input: ConnectionSaveInput): number
  disconnect(): number
  probe(): Promise<ConnectionProbeResult>
  invoke(operation: OperationName, payload: OperationMap[OperationName]['payload']): Promise<unknown>
}

export type ConnectionCredentialPort = Pick<CredentialStore,
  'describe' | 'saveConnection' | 'loadConnectionForMainTransport' | 'clear'>

export async function createConnectionService(
  transport: ConnectionTransportPort,
  credentials: ConnectionCredentialPort,
) {
  let serverUrl: string | null = null
  let unavailableOverride = false
  let transitionQueue: Promise<void> = Promise.resolve()

  const serializeTransition = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = transitionQueue.then(operation, operation)
    transitionQueue = result.then(() => undefined, () => undefined)
    return result
  }

  try {
    const saved = await credentials.loadConnectionForMainTransport()
    if (saved) {
      validateBackendConnectionInput(saved)
      transport.switchConnection(saved)
      serverUrl = saved.serverUrl
    }
  } catch {
    // A corrupt, future, or otherwise unreadable pair must never partially activate.
    unavailableOverride = true
  }

  const describe = async (): Promise<ConnectionDescription> => {
    let storage: CredentialDescription
    try {
      storage = unavailableOverride
        ? { configured: false, storageMode: 'unavailable' }
        : await credentials.describe()
    } catch {
      storage = { configured: false, storageMode: 'unavailable' }
    }
    return {
      serverUrl,
      configured: serverUrl !== null,
      storageMode: storage.storageMode,
      generation: transport.generation,
    }
  }

  return {
    describe,
    async save(input: ConnectionSaveInput): Promise<ConnectionSaveResult> {
      validateBackendConnectionInput(input)
      const generation = await serializeTransition(async () => {
        const saved = await credentials.saveConnection(input)
        if (!saved.configured) {
          try {
            await credentials.clear()
            unavailableOverride = false
          } catch {
            unavailableOverride = true
          }
          throw new Error('The connection pair could not be stored.')
        }
        try {
          const nextGeneration = transport.switchConnection(input)
          serverUrl = input.serverUrl
          unavailableOverride = false
          return nextGeneration
        } catch (error) {
          transport.disconnect()
          serverUrl = null
          try {
            await credentials.clear()
            unavailableOverride = false
          } catch {
            unavailableOverride = true
          }
          throw error
        }
      })
      const probe = await transport.probe()
      if (generation !== transport.generation) throw new Error('Connection changed')
      const description = await describe()
      if (generation !== transport.generation || description.generation !== generation) {
        throw new Error('Connection changed')
      }
      return { description, probe }
    },
    async disconnect(): Promise<ConnectionDescription> {
      return serializeTransition(async () => {
        await credentials.clear()
        transport.disconnect()
        serverUrl = null
        unavailableOverride = false
        return describe()
      })
    },
    probe: (): Promise<ConnectionProbeResult> => transport.probe(),
    invoke: <K extends OperationName>(operation: K, payload: OperationMap[K]['payload']): Promise<unknown> =>
      transport.invoke(operation, payload),
  }
}
