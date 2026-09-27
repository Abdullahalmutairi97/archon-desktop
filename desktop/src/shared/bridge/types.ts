/**
 * The finite renderer/main contract for the authored desktop build.
 *
 * Operations are finite reviewed API surfaces. Task and workspace mutations
 * are separately bounded; renderer payloads never accept commands, channels,
 * backend URLs, idempotency keys, or arbitrary filesystem roots.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonRecord = Readonly<Record<string, JsonValue>>

export interface ConnectionDescription {
  serverUrl: string | null
  configured: boolean
  storageMode: 'memory' | 'protected' | 'unavailable'
  /** Present when the main process can retry protected local Unix-socket pairing. */
  localPairingAvailable?: boolean
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
  /** Main-process hint used to renew process-local pairing only after HTTP 401. */
  authStatus?: 401 | 403
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

/** Server-owned Git checkout identity. Paths are authoritative server paths, for display only. */
export type WorkspaceRecord = JsonRecord & {
  workspace_id: string
  root: string
  project_id: string | null
  base_revision: string | null
  head_revision: string | null
  generation: number
}

export interface TaskSubmitPayload {
  projectId: string
  prompt: string
  workspaceId?: string
  workspaceGeneration?: number
}

export interface TaskByIdPayload {
  taskId: string
}

export interface TaskEventsPayload extends TaskByIdPayload {
  after: number
}

export interface WorkspaceProvisionPayload {
  projectId: string
  revision: string
}

export interface WorkspaceByIdPayload {
  workspaceId: string
}

export interface ProjectHeadPayload {
  projectId: string
}

/** Registers an existing absolute backend-side Git project directory. */
export interface ProjectCreatePayload {
  name: string
  path: string
}

export interface WorkspaceFileListPayload {
  workspaceId: string
  path: string
  limit: number
}

export interface WorkspaceFileReadPayload {
  workspaceId: string
  path: string
  maxBytes: number
}

export interface WorkspaceFileDiffPayload {
  workspaceId: string
  path: string
}

export interface WorkspaceFileSearchPayload {
  workspaceId: string
  query: string
}

export interface WorkspaceFileWritePayload {
  workspaceId: string
  path: string
  expectedContent: string
  content: string
}

export interface WorkspaceFileCreatePayload {
  workspaceId: string
  path: string
  content: string
}

export interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number | null
}

export interface WorkspaceFileListResult {
  path: string
  entries: readonly WorkspaceFileEntry[]
  truncated: boolean
}

export interface WorkspaceFileReadResult {
  path: string
  content: string
  truncated: boolean
}

export interface WorkspaceFileDiffResult {
  path: string
  diff: string
  truncated: boolean
}

export interface WorkspaceFileSearchHit {
  path: string
  line: number
}

export interface WorkspaceFileSearchResult {
  hits: readonly WorkspaceFileSearchHit[]
  files_scanned: number
  bytes_scanned: number
  truncated: boolean
}

export interface WorkspaceFileWriteResult {
  path: string
  content: string
}

export interface WorkspaceConsoleTerminalDto {
  sessionId: string
  state: 'starting' | 'running'
  createdAt: string
}

export interface WorkspaceConsoleScreenDto {
  text: string
  truncated: boolean
}

export type WorkspaceConsoleNamedKey =
  | 'Up' | 'Down' | 'Left' | 'Right' | 'Home' | 'End' | 'PageUp' | 'PageDown'
  | 'BSpace' | 'Tab' | 'BTab' | 'DC' | 'IC' | 'Escape' | 'Enter' | 'Space'
  | 'C-c' | 'C-d' | 'C-z' | 'C-l' | 'C-a' | 'C-e' | 'C-u' | 'C-k' | 'C-w'

export type WorkspaceConsoleKeyEvent =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'key'; readonly value: WorkspaceConsoleNamedKey }

export interface WorkspaceConsoleAttachTicketDto {
  ticket: string
  mode: 'control' | 'read-only'
  expiresAt: string
}

export interface WorkspaceConsoleAttachLeaseDto {
  attachId: string
  mode: 'control' | 'read-only'
  expiresAt: string
}

export interface WorkspaceConsoleBridge {
  list(input: { workspaceId: string }): Promise<readonly WorkspaceConsoleTerminalDto[]>
  create(input: { workspaceId: string; expectedGeneration: number }): Promise<WorkspaceConsoleTerminalDto>
  screen(input: { workspaceId: string; sessionId: string; lines: number }): Promise<WorkspaceConsoleScreenDto>
  sendLine(input: { workspaceId: string; sessionId: string; line: string }): Promise<boolean>
  interrupt(input: { workspaceId: string; sessionId: string }): Promise<boolean>
  stop(input: { workspaceId: string; sessionId: string }): Promise<boolean>
  attach(input: { workspaceId: string; sessionId: string; expectedGeneration: number; mode: 'control' | 'read-only' }): Promise<WorkspaceConsoleAttachTicketDto>
  claim(input: { workspaceId: string; sessionId: string; ticket: string }): Promise<WorkspaceConsoleAttachLeaseDto>
  attachScreen(input: { workspaceId: string; sessionId: string; attachId: string; lines: number }): Promise<WorkspaceConsoleScreenDto>
  attachInput(input: { workspaceId: string; sessionId: string; attachId: string; events: readonly WorkspaceConsoleKeyEvent[] }): Promise<boolean>
  detach(input: { workspaceId: string; sessionId: string; attachId: string }): Promise<boolean>
}

export interface WorkspaceServicePortDto {
  name: string
  port: number
}

export interface WorkspaceServiceDefinitionInput {
  name: string
  argv: readonly string[]
  cwd: string
  env: readonly string[]
  ports: readonly WorkspaceServicePortDto[]
  health: { port: string; path: string } | null
  dependsOn: readonly string[]
  restart: 'never' | 'on-failure'
  memoryLimitMb: number | null
}

export interface WorkspaceServiceDto {
  name: string
  argv: readonly string[]
  cwd: string
  ports: readonly WorkspaceServicePortDto[]
  restart: 'never' | 'on-failure'
  state: 'registered' | 'starting' | 'running' | 'stopped' | 'exited' | 'failed'
  exitCode: number | null
  restarts: number
  health: 'unknown' | 'starting' | 'healthy' | 'unhealthy'
}

export interface WorkspaceServiceLogsDto {
  text: string
  truncated: boolean
}

export interface WorkspaceServicesBridge {
  list(input: { workspaceId: string }): Promise<readonly WorkspaceServiceDto[]>
  define(input: { workspaceId: string; definition: WorkspaceServiceDefinitionInput }): Promise<WorkspaceServiceDto>
  remove(input: { workspaceId: string; name: string; confirm: boolean }): Promise<boolean>
  start(input: { workspaceId: string; name: string }): Promise<WorkspaceServiceDto>
  stop(input: { workspaceId: string; name: string; confirm: boolean }): Promise<boolean>
  logs(input: { workspaceId: string; name: string; lines: number }): Promise<WorkspaceServiceLogsDto>
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
  'projects.create': {
    payload: ProjectCreatePayload
    result: { project: JsonRecord }
  }
  'projects.head': {
    payload: ProjectHeadPayload
    result: { revision: string }
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
  'workspaces.list': {
    payload: EmptyPayload
    result: { workspaces: readonly WorkspaceRecord[] }
  }
  'workspaces.get': {
    payload: WorkspaceByIdPayload
    result: { workspace: WorkspaceRecord }
  }
  'workspaces.provision': {
    payload: WorkspaceProvisionPayload
    result: { workspace: WorkspaceRecord }
  }
  'workspaces.files.list': {
    payload: WorkspaceFileListPayload
    result: WorkspaceFileListResult
  }
  'workspaces.files.read': {
    payload: WorkspaceFileReadPayload
    result: WorkspaceFileReadResult
  }
  'workspaces.files.diff': {
    payload: WorkspaceFileDiffPayload
    result: WorkspaceFileDiffResult
  }
  'workspaces.files.search': {
    payload: WorkspaceFileSearchPayload
    result: WorkspaceFileSearchResult
  }
  'workspaces.files.write': {
    payload: WorkspaceFileWritePayload
    result: WorkspaceFileWriteResult
  }
  'workspaces.files.create': {
    payload: WorkspaceFileCreatePayload
    result: WorkspaceFileWriteResult
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
  readonly localCodex: LocalCodexBridge
  readonly workspaceConsole: WorkspaceConsoleBridge
  readonly workspaceServices: WorkspaceServicesBridge
}

/** Renderer-safe projection of a main-owned project registration. */
export interface LocalCodexProjectDto {
  id: string
  name: string
  /** Canonical workspace root selected and owned by the main process. */
  rootPath: string
}

/** Renderer-safe projection of a persisted session owned by a registered project. */
export interface LocalCodexSessionDto {
  id: string
  title: string
  turnCount: number
}

/** Only returned after the native app-server acknowledges `turn/start`. */
export interface LocalCodexTurnDto {
  taskId: string
  projectId: string
  sessionId: string
  state: 'running'
}

export interface LocalCodexTurnStatusDto {
  taskId: string
  projectId: string
  sessionId: string
  state: 'running' | 'completed' | 'cancelled' | 'failed' | 'outcome_unknown'
}

export type LocalCodexFileChangeKind = 'add' | 'delete' | 'update'

export interface LocalCodexFileChangeDto {
  path: string
  kind: LocalCodexFileChangeKind
  diff: string
  movePath?: string
}

export interface LocalCodexApprovalDto {
  approvalId: string
  taskId: string
  projectId: string
  kind: 'command' | 'file'
  reason: string
  /** Canonical workspace directory in which the proposed operation runs. */
  cwd: string
  /** Canonical absolute paths, provided for display only. */
  paths: readonly string[]
  /** Display-only command context for command approvals. */
  command?: string
  /** Exact bounded patch content sourced from the correlated main-owned item/started notification. */
  changes?: readonly LocalCodexFileChangeDto[]
}

export type LocalCodexEvent =
  | { type: 'turn.output'; taskId: string; text: string }
  | { type: 'turn.completed' | 'turn.cancelled'; taskId: string }
  | { type: 'turn.failed'; taskId: string; message: string }
  | { type: 'approval.requested'; approval: LocalCodexApprovalDto }

export interface LocalCodexBridge {
  listProjects(): Promise<readonly LocalCodexProjectDto[]>
  listSessions(projectId: string): Promise<readonly LocalCodexSessionDto[]>
  /** Opens a native directory picker; the renderer cannot supply a path. */
  registerProject(): Promise<LocalCodexProjectDto | null>
  /** Registers a server-provisioned workspace by its opaque identity; the renderer cannot supply a path. */
  registerWorkspace(input: WorkspaceByIdPayload): Promise<LocalCodexProjectDto>
  startTurn(input: { projectId: string; prompt: string; sessionId?: string }): Promise<LocalCodexTurnDto>
  /** Available when the paired backend owns Local Codex; it restores the latest accepted task without its prompt or output. */
  getLatestTurnStatus?(): Promise<LocalCodexTurnStatusDto | null>
  getTurnStatus?(input: { taskId: string }): Promise<LocalCodexTurnStatusDto>
  cancelTurn(input: { taskId: string }): Promise<boolean>
  subscribe(listener: (event: LocalCodexEvent) => void): () => void
  answerApproval(input: { approvalId: string; allow: boolean }): Promise<boolean>
}

declare global {
  interface Window {
    /** Available only to the registered trusted top-level application frame. */
    archon: DesktopBridge
  }
}
