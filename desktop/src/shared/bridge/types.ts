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

/** What a checkout's HEAD points at, read by the server from the checkout now. */
export type WorkspaceCheckoutState = JsonRecord & {
  state: 'branch' | 'detached' | 'unknown'
  branch: string | null
  commit: string | null
  /** Detached HEAD still at the provisioned revision; null when not detached. */
  at_head_revision: boolean | null
}

/** Server-owned Git checkout identity. Paths are authoritative server paths, for display only. */
export type WorkspaceRecord = JsonRecord & {
  workspace_id: string
  root: string
  project_id: string | null
  base_revision: string | null
  head_revision: string | null
  generation: number
  /** Present only when the server reports it; an older server omits both. */
  owner_id?: string
  checkout?: WorkspaceCheckoutState
}

/**
 * A new conversation in a registered project (Prime unless `runtime` says Pi),
 * or a Prime task in a provisioned checkout. `runtime` and the checkout fields
 * are mutually exclusive.
 */
export interface TaskSubmitProjectPayload {
  projectId: string
  prompt: string
  runtime?: 'prime' | 'pi'
  workspaceId?: string
  workspaceGeneration?: number
  sessionId?: never
  /**
   * A Prime model choice from the server catalog. Sent only together with
   * `provider`, never with Pi or the checkout route, which do not honour it.
   */
  model?: string
  provider?: TaskModelProvider
}

/**
 * Continue an existing server conversation. The server keeps the runtime the
 * conversation recorded; an optional project id must match the session's.
 */
export interface TaskSubmitSessionPayload {
  sessionId: string
  prompt: string
  projectId?: string
  runtime?: never
  workspaceId?: never
  workspaceGeneration?: never
  /** The server passes a follow-up's model to the Prime runner on resume. */
  model?: string
  provider?: TaskModelProvider
}

/** The only provider the server's Prime runner forwards; it drops any other. */
export type TaskModelProvider = 'openai-codex'

export type TaskSubmitPayload = TaskSubmitProjectPayload | TaskSubmitSessionPayload

export interface SessionMessagesPayload {
  sessionId: string
  limit: number
}

/**
 * Permanently remove server conversations and their Archon task history. The
 * ids are unique; the server refuses the whole batch when any is unknown or has
 * a queued or running task.
 */
export interface SessionsDeletePayload {
  sessionIds: readonly string[]
}

/** One server transcript row. `content` is display text and is never markup. */
export interface SessionMessageRecord {
  id: string
  role: string
  content: string
  kind: string
  /** Epoch seconds; 0 when the server has no timestamp. */
  timestamp: number
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

export interface WorkspaceConsoleAttachEventDto {
  attachId: string
  text: string
  truncated: boolean
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
  watch(input: { workspaceId: string; sessionId: string; attachId: string; lines: number }): Promise<boolean>
  unwatch(input: { workspaceId: string; sessionId: string; attachId: string }): Promise<boolean>
  subscribe(listener: (event: WorkspaceConsoleAttachEventDto) => void): () => void
}

/**
 * A declared previewable target. A loopback TCP port is what a user declares; a
 * unix socket is what this server binds for a gateway-only listener such as the
 * IDE, and it is reachable only by an account that can open the socket file.
 */
export type WorkspaceServicePortDto =
  | { name: string; port: number; unixSocket?: never }
  | { name: string; unixSocket: string; port?: never }

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
  /** Optional for older callers: an omitted control defaults to the uncontrolled profile. */
  cpuQuotaPercent?: number | null
  tasksMax?: number | null
  filesystemIsolation?: 'none' | 'workspace-only'
  networkIsolation?: 'host' | 'isolated'
}

/** A definition with every control resolved, as the preload bridge hands it to main. */
export interface ResolvedWorkspaceServiceDefinition extends WorkspaceServiceDefinitionInput {
  cpuQuotaPercent: number | null
  tasksMax: number | null
  filesystemIsolation: 'none' | 'workspace-only'
  networkIsolation: 'host' | 'isolated'
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
  /** Declared controls the server applied; each was probe-verified before a start. */
  memoryLimitMb: number | null
  cpuQuotaPercent: number | null
  tasksMax: number | null
  filesystemIsolation: 'none' | 'workspace-only'
  networkIsolation: 'host' | 'isolated'
}

export type LanguageProfileExtensionState = 'installed' | 'modified' | 'unverified' | 'missing'

export interface LanguageProfileExtensionDto {
  extensionId: string
  version: string
  marketplace: string
  declaredLicence: string
  licenceSha256: string
  vsixSha256: string
  vsixBytes: number
  downloadUrl: string
  targetPlatform: string | null
  pinnedInstalledSha256: string
  state: LanguageProfileExtensionState
  reason: string | null
  installedVersion: string | null
  installedDirectory: string | null
  measuredSha256: string | null
  measuredFiles: number | null
  installedLicenceField: string | null
}

export interface LanguageProfileUnsupportedDto {
  feature: string
  reason: string
}

export interface LanguageProfileDto {
  profile: string
  label: string
  languageIds: readonly string[]
  extensions: readonly LanguageProfileExtensionDto[]
  debuggers: readonly LanguageProfileExtensionDto[]
  unsupported: readonly LanguageProfileUnsupportedDto[]
}

export interface LanguageProfileUnpinnedDto {
  extensionId: string
  installedVersion: string | null
  installedLicenceField: string | null
  measuredSha256: string | null
  state: 'unpinned'
  reason: string
}

export interface DebugAdapterDto {
  profile: string
  extensionId: string | null
  version: string | null
  state: string | null
  reason: string | null
  declaredLicence: string | null
  pinnedInstalledSha256: string | null
}

export interface DebugUnsupportedDto {
  profile: string | null
  feature: string
  reason: string
}

export interface DebugCodeServerDto {
  registered: boolean
  state: string | null
  argv: readonly string[]
  ports: readonly WorkspaceServicePortDto[]
  authMode: string
  bindAddress: string | null
  resourceControls: Readonly<Record<string, unknown>>
  accountNote: string
}

/** Debug facts and gaps. The two verified flags are constants and stay false. */
export interface DebugReadinessDto {
  adapters: readonly DebugAdapterDto[]
  unsupported: readonly DebugUnsupportedDto[]
  codeServer: DebugCodeServerDto | null
  sessionExercised: boolean
  breakpointVerified: boolean
  note: string
}

/** Owner-scoped, read-only artefact report; it never claims a working feature. */
export interface LanguageProfilesDto {
  extensionsDirectory: string
  profiles: readonly LanguageProfileDto[]
  unpinnedInstalled: readonly LanguageProfileUnpinnedDto[]
  pinsVerified: boolean
  note: string
  debug: DebugReadinessDto
}

export interface LanguageProfilesBridge {
  list(input: { workspaceId: string }): Promise<LanguageProfilesDto>
}

export interface WorkspaceServiceLogsDto {
  text: string
  truncated: boolean
}

/** Host resource snapshot from `GET /api/status`. Byte counts are integers. */
export interface StatusSnapshot {
  hostname: string
  system: string
  architecture: string
  kernel: string
  uptime_seconds: number
  cpu: { percent: number; cores: number; load_1: number; load_5: number; load_15: number }
  memory: { total: number; used: number; available: number; percent: number }
  swap: { total: number; used: number; percent: number }
  disk: { path: string; total: number; used: number; free: number; percent: number }
  archon: {
    cpu_percent: number
    memory_used: number
    memory_percent: number
    processes: number
    accounting: 'systemd-cgroup' | 'process-tree'
  }
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'

export interface LogsListPayload {
  limit: number
  /** Minimum level the server returns; omitted means every level. */
  level?: LogLevel
}

/** One log row. `message` is display text only and never markup. */
export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  source: string
  component: string
  message: string
}

export interface ModelRef {
  provider: string
  model: string
}

export interface ModelCatalog {
  current: { provider: string | null; model: string | null; base_url_configured: boolean }
  fallback: null
  providers: readonly { id: string; models: readonly string[] }[]
  choices: readonly ModelRef[]
}

export interface SkillRecord {
  name: string
  description: string
  category: string
  enabled: boolean
  /** Server path, for display only. */
  path: string
}

export interface SkillDetail extends SkillRecord {
  content: string
}

export interface SkillByNamePayload {
  name: string
}

export interface SkillTogglePayload {
  name: string
  enabled: boolean
}

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  state: string | null
  schedule: string | null
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  deliver: string | null
  prompt: string
  skills: readonly string[]
  model: string | null
  provider: string | null
  script: string | null
  no_agent: boolean
}

export type CronAction = 'pause' | 'resume' | 'run' | 'remove'

/** Every cron mutation carries the renderer's explicit confirmation. */
export interface CronCreatePayload {
  schedule: string
  prompt: string
  name: string
  deliver: string
  confirm: true
}

export interface CronUpdateFields {
  schedule?: string
  prompt?: string
  name?: string
  deliver?: string
}

export interface CronUpdatePayload {
  jobId: string
  fields: CronUpdateFields
  confirm: true
}

export interface CronActionPayload {
  jobId: string
  action: CronAction
  confirm: true
}

export interface CronMutationResult {
  ok: true
  output: string
  jobs: readonly CronJob[]
}

export interface BackupRecord {
  id: string
  created_at: string
  plain_path: string | null
  encrypted_path: string | null
  plain_size: number | null
  encrypted_size: number | null
  encrypted: boolean
}

export interface BackupSchedule {
  calendar: string | null
  ActiveState?: string
  UnitFileState?: string
  NextElapseUSecRealtime?: string
  LastTriggerUSec?: string
}

export interface BackupConfirmPayload {
  confirm: true
}

export interface BackupScheduleSetPayload {
  calendar: string
  confirm: true
}

export interface BackupInspectPayload {
  source: string
}

/** `allFiles` restores everything and then `paths` is empty; otherwise `paths` names archive entries. */
export interface BackupRestorePayload {
  source: string
  allFiles: boolean
  paths: readonly string[]
  confirm: true
}

export interface WorkspacePreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WorkspacePreviewOpenResult {
  ticket: string
  url: string
  mode: 'read-only'
  expiresAt: string
}

export interface WorkspacePreviewBridge {
  open(input: { workspaceId: string; name: string; expectedGeneration: number; portName: string | null; bounds: WorkspacePreviewBounds }): Promise<WorkspacePreviewOpenResult>
  bounds(input: WorkspacePreviewBounds): Promise<boolean>
  close(): Promise<boolean>
}

/** What the renderer may know about the native browser view; never page content. */
export interface BrowserViewState {
  /** False once main has closed the view (tab hidden, preview opened, window change). */
  open: boolean
  /** The current http(s) address, or '' when none is known or it exceeds the bound. */
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** A bounded description of the last failed main-frame load, or null. */
  error: string | null
}

/** One sandboxed in-app browser page rendered by main in its own WebContentsView. */
export interface BrowserViewBridge {
  open(input: { url: string; bounds: WorkspacePreviewBounds }): Promise<BrowserViewState>
  navigate(input: { url: string }): Promise<BrowserViewState>
  back(): Promise<BrowserViewState>
  forward(): Promise<BrowserViewState>
  reload(): Promise<BrowserViewState>
  bounds(input: WorkspacePreviewBounds): Promise<boolean>
  close(): Promise<boolean>
  /** Hand an http(s) address to the system browser. */
  openExternal(input: { url: string }): Promise<boolean>
  subscribe(listener: (state: BrowserViewState) => void): () => void
}

export interface WorkspaceServicesBridge {
  list(input: { workspaceId: string }): Promise<readonly WorkspaceServiceDto[]>
  define(input: { workspaceId: string; definition: WorkspaceServiceDefinitionInput }): Promise<WorkspaceServiceDto>
  codeServer(input: { workspaceId: string }): Promise<WorkspaceServiceDto>
  remove(input: { workspaceId: string; name: string; confirm: boolean }): Promise<boolean>
  start(input: { workspaceId: string; name: string }): Promise<WorkspaceServiceDto>
  stop(input: { workspaceId: string; name: string; confirm: boolean }): Promise<boolean>
  logs(input: { workspaceId: string; name: string; lines: number }): Promise<WorkspaceServiceLogsDto>
}

/** One signed-in provider and the models the server lets Prime run through it. */
export interface ModelCatalogProvider {
  id: string
  models: readonly string[]
}

export interface ModelCatalogChoice {
  provider: string
  model: string
}

/** `GET /api/models`: Prime's signed-in providers only; it says nothing about Pi. */
export interface ModelCatalogResult {
  current: { provider: string | null; model: string | null; base_url_configured: boolean }
  fallback: JsonRecord | null
  providers: readonly ModelCatalogProvider[]
  choices: readonly ModelCatalogChoice[]
}

export interface AudioStatusResult {
  available: boolean
  stt: { available: boolean; provider: string }
  tts: { available: boolean; provider: string }
}

/** A base64 `data:audio/...` URL whose header media type equals `mimeType`. */
export interface AudioTranscribePayload {
  dataUrl: string
  mimeType: string
}

export interface AudioTranscribeResult {
  success: true
  transcript: string
  provider: string
}

// Server files (ARCHON_ROOT). Paths are relative to the server's file root;
// '' names the root itself and is accepted only where listing it makes sense.

export interface ServerFileListPayload {
  path: string
}

export interface ServerFilePathPayload {
  path: string
}

export interface ServerFileReadPayload {
  path: string
  maxBytes: number
}

export interface ServerFileWritePayload {
  path: string
  content: string
}

export interface ServerFileMovePayload {
  path: string
  destination: string
}

export interface ServerFileDeletePayload {
  path: string
  confirm: true
}

/** Uploads the local file picked by `files.pickUpload`; the renderer never names a local path. */
export interface ServerFileUploadPayload {
  pickId: string
  path: string
  /** False refuses to overwrite an existing server file with `already_exists`. */
  replace: boolean
}

/** One directory entry exactly as the server lists it. Names are display text. */
export type ServerFileItem = JsonRecord & {
  name: string
  path: string
  is_dir: boolean
  is_symlink: boolean
  restricted: boolean
  size: number
  modified_at: string
  mime: string | null
}

export type ServerFileListResult = JsonRecord & {
  /** The server's absolute file root, for display only. */
  root: string
  path: string
  items: readonly ServerFileItem[]
}

export type ServerFileReadResult = JsonRecord & {
  path: string
  content: string
  size: number
  read: number
  truncated: boolean
  binary: false
}

export type ServerFileUploadPick =
  | { cancelled: true }
  | { cancelled: false; pickId: string; name: string; size: number }

export type ServerFileDownloadResult =
  | { saved: false }
  | { saved: true; name: string; size: number }

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
  'sessions.messages': {
    payload: SessionMessagesPayload
    result: { messages: readonly SessionMessageRecord[] }
  }
  'sessions.delete': {
    payload: SessionsDeletePayload
    result: { ok: true; deleted: readonly string[] }
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
  /** Honest per-provider authentication state. The server never returns a value. */
  'secrets.authStates': {
    payload: EmptyPayload
    result: {
      providers: readonly {
        provider: string
        state: 'unavailable' | 'unverified' | 'verified'
        references: number
        purpose: readonly string[]
        verifiedAt: string | null
        lastAttemptAt: string | null
        lastFailureReason: string | null
      }[]
      epoch: number
      /** Where the broker reads credentials from, e.g. `process-environment`. */
      secretSource: string
      secretValuesExposed: false
      note: string
    }
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
  // Operations pages
  'status.get': {
    payload: EmptyPayload
    result: StatusSnapshot
  }
  'logs.list': {
    payload: LogsListPayload
    result: { logs: readonly LogEntry[] }
  }
  'models.list': {
    payload: EmptyPayload
    result: ModelCatalog
  }
  'models.setDefault': {
    payload: ModelRef
    result: ModelCatalog
  }
  'skills.list': {
    payload: EmptyPayload
    result: { skills: readonly SkillRecord[] }
  }
  'skills.get': {
    payload: SkillByNamePayload
    result: SkillDetail
  }
  'skills.toggle': {
    payload: SkillTogglePayload
    result: SkillRecord
  }
  'cron.list': {
    payload: EmptyPayload
    result: { jobs: readonly CronJob[] }
  }
  'cron.create': {
    payload: CronCreatePayload
    result: CronMutationResult
  }
  'cron.update': {
    payload: CronUpdatePayload
    result: CronMutationResult
  }
  'cron.action': {
    payload: CronActionPayload
    result: CronMutationResult
  }
  'backups.list': {
    payload: EmptyPayload
    result: { backups: readonly BackupRecord[] }
  }
  'backups.create': {
    payload: BackupConfirmPayload
    result: { ok: true; output: string; backups: readonly BackupRecord[] }
  }
  'backups.schedule.get': {
    payload: EmptyPayload
    result: BackupSchedule
  }
  'backups.schedule.set': {
    payload: BackupScheduleSetPayload
    result: { calendar: string; updated: true }
  }
  'backups.inspect': {
    payload: BackupInspectPayload
    result: { source: string; contents: string }
  }
  'backups.restore': {
    payload: BackupRestorePayload
    result: { ok: true; output: string }
  }
  // Composer
  'models.catalog': {
    payload: EmptyPayload
    result: ModelCatalogResult
  }
  'audio.status': {
    payload: EmptyPayload
    result: AudioStatusResult
  }
  'audio.transcribe': {
    payload: AudioTranscribePayload
    result: AudioTranscribeResult
  }
  // Server files (ARCHON_ROOT)
  'files.list': {
    payload: ServerFileListPayload
    result: ServerFileListResult
  }
  'files.read': {
    payload: ServerFileReadPayload
    result: ServerFileReadResult
  }
  'files.writeText': {
    payload: ServerFileWritePayload
    result: ServerFileReadResult
  }
  'files.mkdir': {
    payload: ServerFilePathPayload
    result: { path: string; created: boolean }
  }
  'files.rename': {
    payload: ServerFileMovePayload
    result: { path: string }
  }
  'files.copy': {
    payload: ServerFileMovePayload
    result: { path: string }
  }
  /** Opens a native file picker in the main process; only a one-use pick id crosses the bridge. */
  'files.pickUpload': {
    payload: EmptyPayload
    result: ServerFileUploadPick
  }
  'files.upload': {
    payload: ServerFileUploadPayload
    result: { path: string; size: number }
  }
  /** Saves through a native save dialog in the main process; no local path crosses the bridge. */
  'files.download': {
    payload: ServerFilePathPayload
    result: ServerFileDownloadResult
  }
  'files.delete': {
    payload: ServerFileDeletePayload
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
  readonly languageProfiles: LanguageProfilesBridge
  readonly workspacePreview: WorkspacePreviewBridge
  /** Absent in an older preload; the renderer then says the browser is unavailable. */
  readonly browser?: BrowserViewBridge
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
