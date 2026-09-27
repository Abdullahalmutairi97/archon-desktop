/**
 * The finite renderer/main contract for the authored desktop build.
 *
 * Operations deliberately describe read-only API surfaces only. Additions must
 * be reviewed with the main-process transport and must not accept paths,
 * commands, channels, or backend URLs from the renderer.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonRecord = Readonly<Record<string, JsonValue>>

export interface ConnectionDescription {
  serverUrl: string | null
  configured: boolean
  storageMode: 'memory' | 'protected' | 'unavailable'
  /** Monotonically changes whenever the active connection is replaced/cleared. */
  generation: number
}

export interface ConnectionSaveInput {
  serverUrl: string
  token: string
}

export interface BridgeError {
  code: string
  message: string
}

export interface ConnectionProbeResult {
  /** True means the server accepted the configured credential. */
  ok: boolean
  /** Readiness is present for both HTTP 200 and HTTP 503 dispatch states. */
  readiness?: JsonRecord
  error?: BridgeError
}

export interface ConnectionSaveResult {
  description: ConnectionDescription
  probe: ConnectionProbeResult
}

export interface EmptyPayload {
  readonly [key: string]: never
}

export interface SessionsListPayload {
  projectId?: string
  limit?: number
}

export interface TasksListPayload {
  limit?: number
}

export interface OperationMap {
  readiness: {
    payload: EmptyPayload
    result: JsonRecord
  }
  'projects.list': {
    payload: EmptyPayload
    result: { projects: readonly JsonRecord[] }
  }
  'sessions.list': {
    payload: SessionsListPayload
    result: { sessions: readonly JsonRecord[] }
  }
  'tasks.list': {
    payload: TasksListPayload
    result: { tasks: readonly JsonRecord[] }
  }
  'events.cursor': {
    payload: EmptyPayload
    result: { cursor: number }
  }
}

export type OperationName = keyof OperationMap
export type OperationPayload<K extends OperationName> = OperationMap[K]['payload']
export type OperationResult<K extends OperationName> = OperationMap[K]['result']

export interface DesktopBridge {
  readonly connection: {
    describe(): Promise<ConnectionDescription>
    save(input: ConnectionSaveInput): Promise<ConnectionSaveResult>
    disconnect(): Promise<ConnectionDescription>
    probe(): Promise<ConnectionProbeResult>
  }
  readonly api: {
    invoke<K extends OperationName>(operation: K, payload: OperationPayload<K>): Promise<OperationResult<K>>
  }
}

declare global {
  interface Window {
    /** Available only to the registered trusted top-level application frame. */
    archon: DesktopBridge
  }
}
