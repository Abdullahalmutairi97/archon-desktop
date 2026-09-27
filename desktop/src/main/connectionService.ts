import type {
  ConnectionDescription,
  ConnectionProbeResult,
  ConnectionSaveInput,
  ConnectionSaveResult,
  OperationMap,
  OperationName,
} from '../shared/bridge/types'

/** The transport and its credential remain exclusively in the main process. */
export interface ConnectionTransportPort {
  readonly generation: number
  switchConnection(input: ConnectionSaveInput): number
  disconnect(): number
  probe(): Promise<ConnectionProbeResult>
  invoke(operation: OperationName, payload: OperationMap[OperationName]['payload']): Promise<unknown>
}

export function createConnectionService(transport: ConnectionTransportPort) {
  let serverUrl: string | null = null

  const describe = async (): Promise<ConnectionDescription> => ({
    serverUrl,
    configured: serverUrl !== null,
    storageMode: 'memory',
    generation: transport.generation,
  })

  return {
    describe,
    async save(input: ConnectionSaveInput): Promise<ConnectionSaveResult> {
      const generation = transport.switchConnection(input)
      serverUrl = input.serverUrl
      const probe = await transport.probe()
      if (generation !== transport.generation) throw new Error('Connection changed')
      return { description: await describe(), probe }
    },
    async disconnect(): Promise<ConnectionDescription> {
      transport.disconnect()
      serverUrl = null
      return describe()
    },
    probe: (): Promise<ConnectionProbeResult> => transport.probe(),
    invoke: <K extends OperationName>(operation: K, payload: OperationMap[K]['payload']): Promise<unknown> =>
      transport.invoke(operation, payload),
  }
}
