import type {
  ConnectionDescription,
  ConnectionProbeResult,
  ConnectionSaveInput,
  ConnectionSaveResult,
  OperationMap,
  OperationName,
} from '../shared/bridge/types'
import type { CredentialDescription, CredentialStore } from './storage/credentialStore'
import { BackendTransportError, validateBackendConnectionInput } from './transport/backendTransport'

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

export interface LocalPairingPort {
  pair(): Promise<{ serverUrl: string; token: string; expiresAt: number }>
}

export interface ConnectionServiceOptions {
  localPairing?: LocalPairingPort
}

export async function createConnectionService(
  transport: ConnectionTransportPort,
  credentials: ConnectionCredentialPort,
  options: ConnectionServiceOptions = {},
) {
  let serverUrl: string | null = null
  let localPairingExpiresAt: number | undefined
  let localPairingGeneration: number | undefined
  let localPairingEnabled = false
  let unavailableOverride = false
  let transitionQueue: Promise<void> = Promise.resolve()

  const serializeTransition = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = transitionQueue.then(operation, operation)
    transitionQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const activateLocalPairing = async (): Promise<void> => {
    if (!localPairingEnabled || !options.localPairing) return
    const hadActiveLocalConnection = localPairingExpiresAt !== undefined
    let switchAttempted = false
    try {
      const paired = await options.localPairing.pair()
      const nowSeconds = Math.floor(Date.now() / 1000)
      if (!Number.isSafeInteger(paired.expiresAt) || paired.expiresAt <= nowSeconds
        || paired.expiresAt > nowSeconds + 24 * 60 * 60 + 60) {
        throw new Error('The local Archon service could not be paired.')
      }
      const input = { serverUrl: paired.serverUrl, token: paired.token }
      validateBackendConnectionInput(input)
      switchAttempted = true
      localPairingGeneration = transport.switchConnection(input)
      serverUrl = paired.serverUrl
      localPairingExpiresAt = paired.expiresAt
    } catch {
      if (hadActiveLocalConnection || switchAttempted) {
        transport.disconnect()
        serverUrl = null
        localPairingExpiresAt = undefined
        localPairingGeneration = undefined
      }
    }
  }

  const ensureLocalPairing = async (retryDisconnected: boolean): Promise<void> => {
    if (!localPairingEnabled || !options.localPairing) return
    const expired = localPairingExpiresAt !== undefined
      && localPairingExpiresAt <= Math.floor(Date.now() / 1000)
    if (!expired && (serverUrl !== null || !retryDisconnected)) return
    await serializeTransition(async () => {
      const stillExpired = localPairingExpiresAt !== undefined
        && localPairingExpiresAt <= Math.floor(Date.now() / 1000)
      if (localPairingEnabled && (stillExpired || (retryDisconnected && serverUrl === null))) {
        await activateLocalPairing()
      }
    })
  }

  const activeLocalPairingGeneration = (): number | undefined => {
    if (!localPairingEnabled || localPairingExpiresAt === undefined || serverUrl === null
      || localPairingGeneration !== transport.generation) return undefined
    return localPairingGeneration
  }

  const refreshAfterUnauthorized = (requestGeneration: number): Promise<number | undefined> =>
    serializeTransition(async () => {
      const activeGeneration = activeLocalPairingGeneration()
      if (activeGeneration === undefined) return undefined
      if (activeGeneration !== requestGeneration) {
        // Another unauthorized local request already completed the refresh.
        return activeGeneration
      }
      await activateLocalPairing()
      const refreshedGeneration = activeLocalPairingGeneration()
      return refreshedGeneration !== undefined && refreshedGeneration !== requestGeneration
        ? refreshedGeneration
        : undefined
    })

  let noSavedConnection = false
  try {
    const saved = await credentials.loadConnectionForMainTransport()
    if (saved) {
      validateBackendConnectionInput(saved)
      transport.switchConnection(saved)
      serverUrl = saved.serverUrl
    } else {
      noSavedConnection = true
    }
  } catch {
    // A corrupt, future, or otherwise unreadable pair must never partially activate.
    unavailableOverride = true
  }

  if (noSavedConnection && options.localPairing) {
    localPairingEnabled = true
    // Local pairing is optional at startup; failure leaves the app disconnected.
    await activateLocalPairing()
  }

  const describe = async (): Promise<ConnectionDescription> => {
    await ensureLocalPairing(false)
    let storage: CredentialDescription
    if (localPairingEnabled) {
      storage = { configured: true, storageMode: 'memory' }
    } else {
      try {
        storage = unavailableOverride
          ? { configured: false, storageMode: 'unavailable' }
          : await credentials.describe()
      } catch {
        storage = { configured: false, storageMode: 'unavailable' }
      }
    }
    return {
      serverUrl,
      configured: serverUrl !== null,
      storageMode: storage.storageMode,
      generation: transport.generation,
      ...(localPairingEnabled ? { localPairingAvailable: true } : {}),
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
        localPairingEnabled = false
        try {
          const nextGeneration = transport.switchConnection(input)
          serverUrl = input.serverUrl
          localPairingExpiresAt = undefined
          localPairingGeneration = undefined
          unavailableOverride = false
          return nextGeneration
        } catch (error) {
          transport.disconnect()
          serverUrl = null
          localPairingExpiresAt = undefined
          localPairingGeneration = undefined
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
        localPairingExpiresAt = undefined
        localPairingGeneration = undefined
        localPairingEnabled = false
        unavailableOverride = false
        return describe()
      })
    },
    probe: async (): Promise<ConnectionProbeResult> => {
      await ensureLocalPairing(true)
      const requestGeneration = transport.generation
      const result = await transport.probe()
      if (result.ok || result.error?.code !== 'unauthorized' || result.authStatus !== 401) return result
      const retryGeneration = await refreshAfterUnauthorized(requestGeneration)
      if (retryGeneration === undefined || !localPairingEnabled) {
        return transport.generation === requestGeneration ? result : {
          ok: false,
          error: { code: 'connection_changed', message: 'The server connection changed while this request was running.' },
        }
      }
      if (transport.generation !== retryGeneration || activeLocalPairingGeneration() !== retryGeneration) {
        return {
          ok: false,
          error: { code: 'connection_changed', message: 'The server connection changed while this request was running.' },
        }
      }
      return transport.probe()
    },
    invoke: async <K extends OperationName>(operation: K, payload: OperationMap[K]['payload']): Promise<unknown> => {
      await ensureLocalPairing(true)
      const requestGeneration = transport.generation
      try {
        return await transport.invoke(operation, payload)
      } catch (error) {
        if (!(error instanceof BackendTransportError) || error.code !== 'unauthorized' || error.httpStatus !== 401) {
          throw error
        }
        const retryGeneration = await refreshAfterUnauthorized(requestGeneration)
        if (retryGeneration === undefined) throw error
        if (transport.generation !== retryGeneration || activeLocalPairingGeneration() !== retryGeneration) {
          throw new BackendTransportError('connection_changed')
        }
        return transport.invoke(operation, payload)
      }
    },
  }
}
