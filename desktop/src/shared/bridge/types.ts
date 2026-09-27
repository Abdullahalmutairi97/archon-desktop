/**
 * The finite renderer/main contract for the authored desktop build.
 *
 * Operations are finite reviewed API surfaces. Task submission and cancellation
 * are the only bounded mutations; renderer payloads never accept paths,
 * commands, channels, backend URLs, or idempotency keys.
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

export type RuntimeModeRecord = JsonRecord & {
  id: string
  label: string
  restricted: boolean
}

export type RuntimeRecord = JsonRecord & {
  id: 'prime' | 'pi'
  aliases: readonly string[]
  available: boolean
  availability_check: string
  version: string | null
  version_verified: boolean
  availability_note: string
  modes: readonly RuntimeModeRecord[]
  chat_only: boolean
  sandboxed: boolean
}

export type TaskRecord = JsonRecord & {
  id: string
  status: string
}

export type TaskEventRecord = JsonRecord & {
  seq: number
  task_id: string
  type: string
  data: JsonValue
  created_at: string
  attempt_id: string | null
}

export interface TaskSubmitPayload {
  projectId: string
  prompt: string
}

export interface TaskByIdPayload {
  taskId: string
}

export interface TaskEventsPayload extends TaskByIdPayload {
  after: number
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
  'runtimes.list': {
    payload: EmptyPayload
    result: { runtimes: readonly RuntimeRecord[] }
  }
  'tasks.submit': {
    payload: TaskSubmitPayload
    result: { task: TaskRecord }
  }
  'tasks.get': {
    payload: TaskByIdPayload
    result: { task: TaskRecord }
  }
  'tasks.events': {
    payload: TaskEventsPayload
    result: { events: readonly TaskEventRecord[] }
  }
  'tasks.cancel': {
    payload: TaskByIdPayload
    result: { ok: true }
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
