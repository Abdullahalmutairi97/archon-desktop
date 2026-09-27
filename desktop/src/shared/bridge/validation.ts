import type {
  BridgeError,
  ConnectionDescription,
  ConnectionProbeResult,
  ConnectionSaveResult,
  ConnectionSaveInput,
  EmptyPayload,
  JsonRecord,
  JsonValue,
  LocalCodexApprovalDto,
  LocalCodexEvent,
  LocalCodexFileChangeDto,
  LocalCodexProjectDto,
  LocalCodexSessionDto,
  LocalCodexTurnDto,
  OperationMap,
  OperationName,
  RuntimeRecord,
  SessionsListPayload,
  TaskByIdPayload,
  TaskEventRecord,
  TaskEventsPayload,
  TaskRecord,
  TaskSubmitPayload,
  TasksListPayload,
  WorkspaceRecord,
  WorkspaceProvisionPayload,
} from './types'

export const BRIDGE_CHANNELS = Object.freeze({
  connectionDescribe: 'archon:connection:describe',
  connectionSave: 'archon:connection:save',
  connectionDisconnect: 'archon:connection:disconnect',
  connectionProbe: 'archon:connection:probe',
  apiInvoke: 'archon:api:invoke',
} as const)

/** Separate fixed IPC surface for local Codex; never accepts a method or route from renderer input. */
export const LOCAL_CODEX_CHANNELS = Object.freeze({
  listProjects: 'archon:local-codex:projects:list',
  listSessions: 'archon:local-codex:sessions:list',
  registerProject: 'archon:local-codex:projects:register',
  startTurn: 'archon:local-codex:turn:start',
  cancelTurn: 'archon:local-codex:turn:cancel',
  answerApproval: 'archon:local-codex:approval:answer',
  event: 'archon:local-codex:event',
} as const)

export type LocalCodexInvokeChannel = Exclude<(typeof LOCAL_CODEX_CHANNELS)[keyof typeof LOCAL_CODEX_CHANNELS], typeof LOCAL_CODEX_CHANNELS.event>

export type BridgeChannel = (typeof BRIDGE_CHANNELS)[keyof typeof BRIDGE_CHANNELS]

const operationNames = Object.freeze([
  'readiness',
  'projects.list',
  'sessions.list',
  'tasks.list',
  'events.cursor',
  'runtimes.list',
  'tasks.submit',
  'tasks.get',
  'tasks.events',
  'tasks.cancel',
  'workspaces.list',
  'workspaces.provision',
] as const satisfies readonly OperationName[])

const channels = new Set<string>(Object.values(BRIDGE_CHANNELS))
const operations = new Set<string>(operationNames)
const MAX_SERVER_URL_LENGTH = 2048
const MAX_TOKEN_LENGTH = 8192
const MAX_PROJECT_ID_LENGTH = 200
const MAX_TASK_ID_LENGTH = 200
// Fits the 64 KiB IPC envelope even when every UTF-16 code unit encodes to four UTF-8 bytes.
const MAX_TASK_PROMPT_LENGTH = 8_000
const MAX_LIST_LIMIT = 500
const MAX_TASK_EVENT_CURSOR = Number.MAX_SAFE_INTEGER
const MAX_TASK_EVENT_RESULTS = 1_000
const MAX_RESULT_STRING_LENGTH = 100_000
const MAX_RESULT_DEPTH = 16
const MAX_RESULT_NODES = 20_000
const MAX_RESULT_ESTIMATED_BYTES = 2 * 1024 * 1024
const MAX_RESULT_OBJECT_KEYS = 512
const MAX_LOCAL_PROJECTS = 100
const MAX_LOCAL_SESSIONS = 100
const MAX_LOCAL_PROJECT_ID_LENGTH = 256
const MAX_LOCAL_TASK_ID_LENGTH = 256
const MAX_LOCAL_APPROVAL_ID_LENGTH = 128
const MAX_LOCAL_NAME_LENGTH = 300
const MAX_LOCAL_PATH_LENGTH = 16_000
const MAX_LOCAL_PROMPT_LENGTH = 8000
const MAX_LOCAL_OUTPUT_LENGTH = 8000
const MAX_LOCAL_COMMAND_LENGTH = 8000
const MAX_LOCAL_REASON_LENGTH = 4096
const MAX_LOCAL_APPROVAL_PATHS = 64
const MAX_LOCAL_FILE_CHANGES = 16
const MAX_LOCAL_FILE_DIFF_LENGTH = 16_000
const MAX_LOCAL_FILE_CHANGE_BYTES = 24 * 1024
const MAX_LOCAL_PAYLOAD_BYTES = 64 * 1024
const SENSITIVE_RESPONSE_FIELDS = new Set([
  'token',
  'apitoken',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'coordinatortoken',
  'bearertoken',
  'authorization',
  'password',
  'secret',
  'clientsecret',
  'secretkey',
  'credential',
  'credentials',
  'apikey',
  'accesskey',
  'privatekey',
])

export interface BridgeRequest {
  channel: BridgeChannel
  /** Canonical IPC args, after shape and bound checks. */
  args: readonly unknown[]
}

function fail(): never {
  throw new TypeError('Invalid desktop bridge request')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readOwnDataRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) return fail()
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of ownKeys) {
    if (typeof key !== 'string') return fail()
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail()
    result[key] = descriptor.value
  }
  return result
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
    && !value.includes('\0')
}

function validateServerUrl(value: unknown): value is string {
  if (!boundedString(value, MAX_SERVER_URL_LENGTH)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.length > 0
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
  } catch {
    return false
  }
}

function parseConnectionSave(value: unknown): ConnectionSaveInput {
  const record = readOwnDataRecord(value, ['serverUrl', 'token'])
  if (Object.keys(record).length !== 2) return fail()
  if (!validateServerUrl(record.serverUrl) || !boundedString(record.token, MAX_TOKEN_LENGTH)) return fail()
  if (!record.token.trim()) return fail()
  return Object.freeze({ serverUrl: record.serverUrl, token: record.token })
}

function parseEmptyPayload(value: unknown): EmptyPayload {
  const record = readOwnDataRecord(value, [])
  if (Object.keys(record).length !== 0) return fail()
  return Object.freeze({})
}

function parseOptionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) return fail()
  return value
}

function parseSessionsPayload(value: unknown): SessionsListPayload {
  const record = readOwnDataRecord(value, ['projectId', 'limit'])
  let projectId: string | undefined
  if (record.projectId !== undefined) {
    if (!boundedString(record.projectId, MAX_PROJECT_ID_LENGTH)) return fail()
    projectId = record.projectId
  }
  const limit = parseOptionalLimit(record.limit)
  return Object.freeze({
    ...(projectId === undefined ? {} : { projectId }),
    ...(limit === undefined ? {} : { limit }),
  })
}

function parseTasksPayload(value: unknown): TasksListPayload {
  const record = readOwnDataRecord(value, ['limit'])
  const limit = parseOptionalLimit(record.limit)
  return Object.freeze(limit === undefined ? {} : { limit })
}

function parseWorkspaceProvisionPayload(value: unknown): WorkspaceProvisionPayload {
  const record = exactObject(value, ['projectId', 'revision'])
  if (!workspaceText(record.projectId, MAX_PROJECT_ID_LENGTH)) return fail()
  if (typeof record.revision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(record.revision)) return fail()
  return Object.freeze({ projectId: record.projectId, revision: record.revision })
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_TASK_ID_LENGTH
    && /^[A-Za-z0-9_-]{1,200}$/u.test(value)
}

function parseTaskSubmitPayload(value: unknown): TaskSubmitPayload {
  const record = readOwnDataRecord(value, ['projectId', 'prompt'])
  if (Object.keys(record).length !== 2) return fail()
  if (!boundedString(record.projectId, MAX_PROJECT_ID_LENGTH)) return fail()
  if (!boundedString(record.prompt, MAX_TASK_PROMPT_LENGTH) || !record.prompt.trim()) return fail()
  return Object.freeze({ projectId: record.projectId, prompt: record.prompt })
}

function parseTaskByIdPayload(value: unknown): TaskByIdPayload {
  const record = readOwnDataRecord(value, ['taskId'])
  if (Object.keys(record).length !== 1 || !validTaskId(record.taskId)) return fail()
  return Object.freeze({ taskId: record.taskId })
}

function parseTaskEventsPayload(value: unknown): TaskEventsPayload {
  const record = readOwnDataRecord(value, ['taskId', 'after'])
  if (Object.keys(record).length !== 2 || !validTaskId(record.taskId)) return fail()
  if (typeof record.after !== 'number' || !Number.isSafeInteger(record.after) || record.after < 0 || record.after > MAX_TASK_EVENT_CURSOR) {
    return fail()
  }
  return Object.freeze({ taskId: record.taskId, after: record.after })
}

export function isOperationName(value: unknown): value is OperationName {
  return typeof value === 'string' && operations.has(value)
}

export function isBridgeChannel(value: unknown): value is BridgeChannel {
  return typeof value === 'string' && channels.has(value)
}

export function parseOperationRequest(operation: unknown, payload: unknown): readonly [OperationName, unknown] {
  if (!isOperationName(operation)) return fail()
  switch (operation) {
    case 'readiness':
    case 'projects.list':
    case 'events.cursor':
    case 'runtimes.list':
    case 'workspaces.list':
      return Object.freeze([operation, parseEmptyPayload(payload)])
    case 'workspaces.provision':
      return Object.freeze([operation, parseWorkspaceProvisionPayload(payload)])
    case 'sessions.list':
      return Object.freeze([operation, parseSessionsPayload(payload)])
    case 'tasks.list':
      return Object.freeze([operation, parseTasksPayload(payload)])
    case 'tasks.submit':
      return Object.freeze([operation, parseTaskSubmitPayload(payload)])
    case 'tasks.get':
    case 'tasks.cancel':
      return Object.freeze([operation, parseTaskByIdPayload(payload)])
    case 'tasks.events':
      return Object.freeze([operation, parseTaskEventsPayload(payload)])
  }
}

/**
 * Validate an IPC main handler's channel and all user-controlled arguments.
 * The returned `args` array is canonical and safe to pass to main services.
 */
export function parseBridgeRequest(channel: unknown, args: readonly unknown[]): BridgeRequest {
  if (!isBridgeChannel(channel) || !Array.isArray(args)) return fail()
  switch (channel) {
    case BRIDGE_CHANNELS.connectionDescribe:
    case BRIDGE_CHANNELS.connectionDisconnect:
    case BRIDGE_CHANNELS.connectionProbe:
      if (args.length !== 0) return fail()
      return Object.freeze({ channel, args: Object.freeze([]) })
    case BRIDGE_CHANNELS.connectionSave:
      if (args.length !== 1) return fail()
      return Object.freeze({ channel, args: Object.freeze([parseConnectionSave(args[0])]) })
    case BRIDGE_CHANNELS.apiInvoke: {
      if (args.length !== 2) return fail()
      const [operation, payload] = parseOperationRequest(args[0], args[1])
      return Object.freeze({ channel, args: Object.freeze([operation, payload]) })
    }
  }
}

function sensitiveFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_\s]/g, '')
  return SENSITIVE_RESPONSE_FIELDS.has(normalized)
}

interface JsonBudget {
  nodes: number
  estimatedBytes: number
  seen: WeakSet<object>
}

function addStringToBudget(value: string, budget: JsonBudget): void {
  if (value.length > MAX_RESULT_STRING_LENGTH) return fail()
  budget.estimatedBytes += value.length * 3
  if (budget.estimatedBytes > MAX_RESULT_ESTIMATED_BYTES) return fail()
}

function parseBoundedJson(value: unknown, budget: JsonBudget, depth = 0): JsonValue {
  budget.nodes += 1
  if (budget.nodes > MAX_RESULT_NODES || depth > MAX_RESULT_DEPTH) return fail()

  if (value === null || typeof value === 'boolean') {
    budget.estimatedBytes += 8
    return value
  }
  if (typeof value === 'string') {
    addStringToBudget(value, budget)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail()
    budget.estimatedBytes += 16
    return value
  }
  if (typeof value !== 'object') return fail()
  if (budget.seen.has(value)) return fail()
  budget.seen.add(value)

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_RESULT_NODES) return fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key !== 'string')) return fail()
    const result: JsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail()
      result.push(parseBoundedJson(descriptor.value, budget, depth + 1))
    }
    budget.estimatedBytes += result.length * 8
    if (budget.estimatedBytes > MAX_RESULT_ESTIMATED_BYTES) return fail()
    return Object.freeze(result)
  }

  if (!isRecord(value)) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length > MAX_RESULT_OBJECT_KEYS || ownKeys.some((key) => typeof key !== 'string')) return fail()
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const key of ownKeys) {
    if (typeof key !== 'string' || sensitiveFieldName(key)) return fail()
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail()
    addStringToBudget(key, budget)
    result[key] = parseBoundedJson(descriptor.value, budget, depth + 1)
  }
  if (budget.estimatedBytes > MAX_RESULT_ESTIMATED_BYTES) return fail()
  return Object.freeze(result)
}

function boundedJsonRecord(value: unknown): JsonRecord {
  const parsed = parseBoundedJson(value, {
    nodes: 0,
    estimatedBytes: 0,
    seen: new WeakSet<object>(),
  })
  if (!isRecord(parsed)) return fail()
  return parsed as JsonRecord
}

function parseDescription(value: unknown): ConnectionDescription {
  const record = readOwnDataRecord(value, ['serverUrl', 'configured', 'storageMode', 'generation', 'localPairingAvailable'])
  if (Object.keys(record).length !== 4 && Object.keys(record).length !== 5) return fail()
  const serverUrl = record.serverUrl
  const localPairingAvailable = record.localPairingAvailable
  if (serverUrl !== null && !validateServerUrl(serverUrl)) return fail()
  if (typeof record.configured !== 'boolean') return fail()
  if (record.storageMode !== 'memory' && record.storageMode !== 'protected' && record.storageMode !== 'unavailable') return fail()
  if (typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation) || record.generation < 0) return fail()
  if (Object.hasOwn(record, 'localPairingAvailable') && typeof localPairingAvailable !== 'boolean') return fail()
  return Object.freeze({
    serverUrl,
    configured: record.configured,
    storageMode: record.storageMode,
    generation: record.generation,
    ...(typeof localPairingAvailable === 'boolean' ? { localPairingAvailable } : {}),
  })
}

function parseBridgeError(value: unknown): BridgeError {
  const record = readOwnDataRecord(value, ['code', 'message'])
  if (Object.keys(record).length !== 2) return fail()
  if (!boundedString(record.code, 128) || !boundedString(record.message, 512)) return fail()
  if (sensitiveFieldName(record.code) || /\b(bearer|authorization|credential|password|secret)\b/i.test(record.message)) return fail()
  return Object.freeze({ code: record.code, message: record.message })
}

function parseProbeResult(value: unknown): ConnectionProbeResult {
  const record = readOwnDataRecord(value, ['ok', 'readiness', 'error', 'authStatus'])
  if (typeof record.ok !== 'boolean') return fail()
  const readiness = record.readiness === undefined ? undefined : boundedJsonRecord(record.readiness)
  const error = record.error === undefined ? undefined : parseBridgeError(record.error)
  const authStatus = record.authStatus === 401 || record.authStatus === 403 ? record.authStatus : undefined
  if (Object.hasOwn(record, 'authStatus') && authStatus === undefined) return fail()
  if (Object.hasOwn(record, 'authStatus') && error?.code !== 'unauthorized') return fail()
  if (!record.ok && !error) return fail()
  if (record.ok && !readiness) return fail()
  if (record.ok && error) return fail()
  return Object.freeze({
    ok: record.ok,
    ...(readiness === undefined ? {} : { readiness }),
    ...(error === undefined ? {} : { error }),
  })
}

function exactObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  const record = readOwnDataRecord(value, allowedKeys)
  if (Object.keys(record).length !== allowedKeys.length) return fail()
  return record
}

function parseRuntimeRecord(value: unknown): RuntimeRecord {
  const record = boundedJsonRecord(value)
  if (record.id !== 'prime' && record.id !== 'pi') return fail()
  if (!Array.isArray(record.aliases) || record.aliases.length > 200 ||
      record.aliases.some((alias) => typeof alias !== 'string' || !boundedString(alias, 128))) return fail()
  if (typeof record.available !== 'boolean' || !boundedString(record.availability_check, 128)) return fail()
  if (record.version !== null && !boundedString(record.version, 256, true)) return fail()
  if (typeof record.version_verified !== 'boolean' || !boundedString(record.availability_note, 2_000, true)) return fail()
  if (!Array.isArray(record.modes) || record.modes.length > 32 || record.modes.some((mode) =>
    !isRecord(mode) || !boundedString(mode.id, 64) || !boundedString(mode.label, 256) || typeof mode.restricted !== 'boolean'
  )) return fail()
  if (typeof record.chat_only !== 'boolean' || typeof record.sandboxed !== 'boolean') return fail()
  return record as RuntimeRecord
}

function parseTaskRecord(value: unknown): TaskRecord {
  const record = boundedJsonRecord(value)
  if (!validTaskId(record.id) || !boundedString(record.status, 64)) return fail()
  return record as TaskRecord
}

function isCanonicalWorkspaceRoot(value: unknown): value is string {
  if (!boundedString(value, MAX_LOCAL_PATH_LENGTH) || !value.startsWith('/') || /[\u0001-\u001f\u007f-\u009f]/u.test(value)) return false
  if (value === '/') return true
  if (value.endsWith('/')) return false
  return value.slice(1).split('/').every((component) => component.length > 0 && component !== '.' && component !== '..')
}

function workspaceText(value: unknown, maxLength: number): value is string {
  return boundedString(value, maxLength) && value === value.trim() && !/[\u0001-\u001f\u007f-\u009f]/u.test(value)
}

function parseWorkspaceRecord(value: unknown): WorkspaceRecord {
  const record = exactObject(value, [
    'workspace_id', 'root', 'project_id', 'base_revision', 'head_revision', 'generation',
  ])
  if (!workspaceText(record.workspace_id, 200) || !isCanonicalWorkspaceRoot(record.root)) return fail()
  if (record.project_id !== null && !workspaceText(record.project_id, MAX_PROJECT_ID_LENGTH)) return fail()
  if (record.base_revision !== null && !workspaceText(record.base_revision, 256)) return fail()
  if (record.head_revision !== null && !workspaceText(record.head_revision, 256)) return fail()
  if (typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation) || record.generation < 1) return fail()
  return Object.freeze({
    workspace_id: record.workspace_id,
    root: record.root,
    project_id: record.project_id,
    base_revision: record.base_revision,
    head_revision: record.head_revision,
    generation: record.generation,
  })
}

function parseTaskEvent(value: unknown): TaskEventRecord {
  const record = boundedJsonRecord(value)
  if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 1) return fail()
  if (!validTaskId(record.task_id) || !boundedString(record.type, 128)) return fail()
  if (!boundedString(record.created_at, 128) || !Object.prototype.hasOwnProperty.call(record, 'data')) return fail()
  if (record.attempt_id !== null && !validTaskId(record.attempt_id)) return fail()
  return record as TaskEventRecord
}

function parseOperationResponse(operation: unknown, value: unknown): OperationMap[OperationName]['result'] {
  if (!isOperationName(operation)) return fail()
  switch (operation) {
    case 'readiness':
      return boundedJsonRecord(value)
    case 'projects.list':
    case 'sessions.list':
    case 'tasks.list': {
      const key = operation === 'projects.list' ? 'projects' : operation === 'sessions.list' ? 'sessions' : 'tasks'
      const record = exactObject(value, [key])
      if (!Array.isArray(record[key]) || record[key].length > MAX_LIST_LIMIT) return fail()
      const list = parseBoundedJson(record[key], { nodes: 0, estimatedBytes: 0, seen: new WeakSet<object>() })
      if (!Array.isArray(list) || list.some((item) => !isRecord(item))) return fail()
      return Object.freeze({ [key]: list }) as OperationMap[OperationName]['result']
    }
    case 'workspaces.list': {
      const record = exactObject(value, ['workspaces'])
      if (!Array.isArray(record.workspaces) || record.workspaces.length > MAX_LIST_LIMIT) return fail()
      const list = parseBoundedJson(record.workspaces, { nodes: 0, estimatedBytes: 0, seen: new WeakSet<object>() })
      if (!Array.isArray(list)) return fail()
      return Object.freeze({ workspaces: Object.freeze(list.map(parseWorkspaceRecord)) })
    }
    case 'workspaces.provision': {
      const record = exactObject(value, ['workspace'])
      return Object.freeze({ workspace: parseWorkspaceRecord(record.workspace) })
    }
    case 'events.cursor': {
      const record = exactObject(value, ['cursor'])
      if (typeof record.cursor !== 'number' || !Number.isSafeInteger(record.cursor) || record.cursor < 0) return fail()
      return Object.freeze({ cursor: record.cursor })
    }
    case 'runtimes.list': {
      const record = exactObject(value, ['runtimes'])
      if (!Array.isArray(record.runtimes) || record.runtimes.length > 100) return fail()
      return Object.freeze({ runtimes: Object.freeze(record.runtimes.map(parseRuntimeRecord)) })
    }
    case 'tasks.submit':
    case 'tasks.get': {
      const record = exactObject(value, ['task'])
      return Object.freeze({ task: parseTaskRecord(record.task) })
    }
    case 'tasks.events': {
      const record = exactObject(value, ['events'])
      if (!Array.isArray(record.events) || record.events.length > MAX_TASK_EVENT_RESULTS) return fail()
      return Object.freeze({ events: Object.freeze(record.events.map(parseTaskEvent)) })
    }
    case 'tasks.cancel': {
      const record = exactObject(value, ['ok'])
      if (record.ok !== true) return fail()
      return Object.freeze({ ok: true })
    }
  }
}

/** Validate and sanitize a main-process service result before it reaches preload. */
export function parseBridgeResponse(channel: unknown, value: unknown, operation?: unknown): unknown {
  if (!isBridgeChannel(channel)) return fail()
  switch (channel) {
    case BRIDGE_CHANNELS.connectionDescribe:
    case BRIDGE_CHANNELS.connectionDisconnect:
      return parseDescription(value)
    case BRIDGE_CHANNELS.connectionProbe:
      return parseProbeResult(value)
    case BRIDGE_CHANNELS.connectionSave: {
      const record = exactObject(value, ['description', 'probe'])
      return Object.freeze({
        description: parseDescription(record.description),
        probe: parseProbeResult(record.probe),
      }) satisfies ConnectionSaveResult
    }
    case BRIDGE_CHANNELS.apiInvoke:
      return parseOperationResponse(operation, value)
  }
}

export function parseOperationPayload<K extends OperationName>(operation: K, payload: unknown): OperationMap[K]['payload'] {
  return parseOperationRequest(operation, payload)[1] as OperationMap[K]['payload']
}

export interface LocalCodexBridgeRequest {
  channel: LocalCodexInvokeChannel
  args: readonly unknown[]
}

function isLocalProjectId(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('codex-project:')
    && value.length <= MAX_LOCAL_PROJECT_ID_LENGTH
    && /^[A-Za-z0-9._:-]+$/.test(value.slice('codex-project:'.length))
    && value.length > 'codex-project:'.length
}

function isLocalTaskId(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('codex-task:')
    && value.length <= MAX_LOCAL_TASK_ID_LENGTH
    && /^[A-Za-z0-9._:-]+$/.test(value.slice('codex-task:'.length))
    && value.length > 'codex-task:'.length
}

function isLocalSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('codex:')
    && value.length <= MAX_LOCAL_TASK_ID_LENGTH
    && /^[A-Za-z0-9._:-]+$/.test(value.slice('codex:'.length))
    && value.length > 'codex:'.length
}

function isLocalApprovalId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_LOCAL_APPROVAL_ID_LENGTH
    && /^[A-Za-z0-9._:-]+$/.test(value)
}

/** Local Codex runs only on the Linux desktop build; require a normalized absolute path. */
function isCanonicalAbsolutePath(value: unknown): value is string {
  if (!boundedString(value, MAX_LOCAL_PATH_LENGTH) || !value.startsWith('/') || /[\u0001-\u001f\u007f]/.test(value)) return false
  if (value === '/') return true
  if (value.endsWith('/')) return false
  const components = value.slice(1).split('/')
  return components.every((component) => component.length > 0 && component !== '.' && component !== '..')
}

function readLocalArray(value: unknown, maxLength: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== 'string')) return fail()
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail()
    result.push(descriptor.value)
  }
  return result
}

function parseLocalProject(value: unknown): LocalCodexProjectDto {
  const record = exactObject(value, ['id', 'name', 'rootPath'])
  if (!isLocalProjectId(record.id)
    || !boundedString(record.name, MAX_LOCAL_NAME_LENGTH)
    || !isCanonicalAbsolutePath(record.rootPath)) return fail()
  return Object.freeze({ id: record.id, name: record.name, rootPath: record.rootPath })
}

function parseLocalSession(value: unknown): LocalCodexSessionDto {
  const record = exactObject(value, ['id', 'title', 'turnCount'])
  if (!isLocalSessionId(record.id) || !boundedString(record.title, 500)
    || typeof record.turnCount !== 'number' || !Number.isSafeInteger(record.turnCount)
    || record.turnCount < 1 || record.turnCount > 5000) return fail()
  return Object.freeze({ id: record.id, title: record.title, turnCount: record.turnCount })
}

function parseLocalTurn(value: unknown): LocalCodexTurnDto {
  const record = exactObject(value, ['taskId', 'projectId', 'sessionId', 'state'])
  if (!isLocalTaskId(record.taskId) || !isLocalProjectId(record.projectId)
    || !isLocalSessionId(record.sessionId) || record.state !== 'running') return fail()
  return Object.freeze({
    taskId: record.taskId,
    projectId: record.projectId,
    sessionId: record.sessionId,
    state: 'running',
  })
}

function parseLocalApproval(value: unknown): LocalCodexApprovalDto {
  const record = readOwnDataRecord(value, ['approvalId', 'taskId', 'projectId', 'kind', 'reason', 'cwd', 'paths', 'command', 'changes'])
  if (!isLocalApprovalId(record.approvalId) || !isLocalTaskId(record.taskId)
    || !isLocalProjectId(record.projectId) || (record.kind !== 'command' && record.kind !== 'file')
    || !boundedString(record.reason, MAX_LOCAL_REASON_LENGTH, true)
    || !isCanonicalAbsolutePath(record.cwd)) return fail()

  const rawPaths = readLocalArray(record.paths, MAX_LOCAL_APPROVAL_PATHS)
  const paths = rawPaths.map((path) => {
    if (!isCanonicalAbsolutePath(path)) return fail()
    return path
  })
  const command = record.command
  let changes: LocalCodexFileChangeDto[] | undefined
  if (record.kind === 'command') {
    if (!boundedString(command, MAX_LOCAL_COMMAND_LENGTH) || paths.length !== 0 || record.changes !== undefined) return fail()
  } else if (command !== undefined || paths.length < 1) {
    return fail()
  } else {
    const rawChanges = readLocalArray(record.changes, MAX_LOCAL_FILE_CHANGES)
    if (rawChanges.length < 1) return fail()
    changes = rawChanges.map((value) => {
      const change = readOwnDataRecord(value, ['path', 'kind', 'diff', 'movePath'])
      if (!isCanonicalAbsolutePath(change.path) || (change.kind !== 'add' && change.kind !== 'delete' && change.kind !== 'update')
        || !isRepresentableLocalDiff(change.diff)) return fail()
      const movePath = change.movePath
      if (movePath !== undefined && (change.kind !== 'update' || !isCanonicalAbsolutePath(movePath))) return fail()
      return Object.freeze({
        path: change.path,
        kind: change.kind,
        diff: change.diff,
        ...(movePath === undefined ? {} : { movePath }),
      })
    })
    const changedPaths: string[] = []
    const uniquePaths = new Set<string>()
    for (const change of changes) {
      for (const path of [change.path, ...(change.movePath === undefined ? [] : [change.movePath])]) {
        if (uniquePaths.has(path)) return fail()
        uniquePaths.add(path)
        changedPaths.push(path)
      }
    }
    if (paths.length !== changedPaths.length || paths.some((path, index) => path !== changedPaths[index])) return fail()
    try {
      if (new TextEncoder().encode(JSON.stringify(changes)).byteLength > MAX_LOCAL_FILE_CHANGE_BYTES) return fail()
    } catch {
      return fail()
    }
  }

  return Object.freeze({
    approvalId: record.approvalId,
    taskId: record.taskId,
    projectId: record.projectId,
    kind: record.kind,
    reason: record.reason,
    cwd: record.cwd,
    paths: Object.freeze(paths),
    ...(command === undefined ? {} : { command }),
    ...(changes === undefined ? {} : { changes: Object.freeze(changes) }),
  }) as LocalCodexApprovalDto
}

function isWellFormedLocalText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function isRepresentableLocalDiff(value: unknown): value is string {
  if (!boundedString(value, MAX_LOCAL_FILE_DIFF_LENGTH) || !isWellFormedLocalText(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return false
  }
  return true
}

function parseLocalPrompt(value: unknown): { projectId: string; prompt: string; sessionId?: string } {
  const record = readOwnDataRecord(value, ['projectId', 'prompt', 'sessionId'])
  if (!isLocalProjectId(record.projectId) || !boundedString(record.prompt, MAX_LOCAL_PROMPT_LENGTH)
    || !record.prompt.trim()) return fail()
  if (record.sessionId !== undefined && !isLocalSessionId(record.sessionId)) return fail()
  return Object.freeze({ projectId: record.projectId, prompt: record.prompt,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }) })
}

function parseLocalSessionsPayload(value: unknown): { projectId: string } {
  const record = exactObject(value, ['projectId'])
  if (!isLocalProjectId(record.projectId)) return fail()
  return Object.freeze({ projectId: record.projectId })
}

function parseLocalTaskPayload(value: unknown): { taskId: string } {
  const record = exactObject(value, ['taskId'])
  if (!isLocalTaskId(record.taskId)) return fail()
  return Object.freeze({ taskId: record.taskId })
}

function parseLocalApprovalAnswer(value: unknown): { approvalId: string; allow: boolean } {
  const record = exactObject(value, ['approvalId', 'allow'])
  if (!isLocalApprovalId(record.approvalId) || typeof record.allow !== 'boolean') return fail()
  return Object.freeze({ approvalId: record.approvalId, allow: record.allow })
}

function withinLocalPayloadLimit(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' && new TextEncoder().encode(serialized).byteLength <= MAX_LOCAL_PAYLOAD_BYTES
  } catch {
    return false
  }
}

function makeLocalCodexRequest(channel: LocalCodexInvokeChannel, args: readonly unknown[]): LocalCodexBridgeRequest {
  if (!withinLocalPayloadLimit(args)) return fail()
  return Object.freeze({ channel, args: Object.freeze([...args]) })
}

function boundedLocalResult<T>(value: T): T {
  if (!withinLocalPayloadLimit(value)) return fail()
  return value
}

/** Parse only the fixed local Codex invocation channels and canonicalize each payload. */
export function parseLocalCodexRequest(channel: unknown, args: readonly unknown[]): LocalCodexBridgeRequest {
  const safeArgs = readLocalArray(args, 1)
  switch (channel) {
    case LOCAL_CODEX_CHANNELS.listProjects:
    case LOCAL_CODEX_CHANNELS.registerProject:
      if (safeArgs.length !== 0) return fail()
      return makeLocalCodexRequest(channel, [])
    case LOCAL_CODEX_CHANNELS.listSessions:
      if (safeArgs.length !== 1) return fail()
      return makeLocalCodexRequest(channel, [parseLocalSessionsPayload(safeArgs[0])])
    case LOCAL_CODEX_CHANNELS.startTurn:
      if (safeArgs.length !== 1) return fail()
      return makeLocalCodexRequest(channel, [parseLocalPrompt(safeArgs[0])])
    case LOCAL_CODEX_CHANNELS.cancelTurn:
      if (safeArgs.length !== 1) return fail()
      return makeLocalCodexRequest(channel, [parseLocalTaskPayload(safeArgs[0])])
    case LOCAL_CODEX_CHANNELS.answerApproval:
      if (safeArgs.length !== 1) return fail()
      return makeLocalCodexRequest(channel, [parseLocalApprovalAnswer(safeArgs[0])])
    default:
      return fail()
  }
}

/** Validate and copy local Codex service results before they reach the renderer. */
export function parseLocalCodexResponse(channel: unknown, value: unknown): unknown {
  switch (channel) {
    case LOCAL_CODEX_CHANNELS.listProjects: {
      const rawProjects = readLocalArray(value, MAX_LOCAL_PROJECTS)
      const projects = rawProjects.map((item) => {
        return parseLocalProject(item)
      })
      if (new Set(projects.map((project) => project.id)).size !== projects.length) return fail()
      return boundedLocalResult(Object.freeze(projects))
    }
    case LOCAL_CODEX_CHANNELS.listSessions: {
      const rawSessions = readLocalArray(value, MAX_LOCAL_SESSIONS)
      const sessions = rawSessions.map(parseLocalSession)
      if (new Set(sessions.map((session) => session.id)).size !== sessions.length) return fail()
      return boundedLocalResult(Object.freeze(sessions))
    }
    case LOCAL_CODEX_CHANNELS.registerProject:
      return value === null ? null : boundedLocalResult(parseLocalProject(value))
    case LOCAL_CODEX_CHANNELS.startTurn:
      return boundedLocalResult(parseLocalTurn(value))
    case LOCAL_CODEX_CHANNELS.cancelTurn:
    case LOCAL_CODEX_CHANNELS.answerApproval:
      if (typeof value !== 'boolean') return fail()
      return boundedLocalResult(value)
    default:
      return fail()
  }
}

/** Validate event payloads before dispatching them to any renderer listener. */
export function parseLocalCodexEvent(value: unknown): LocalCodexEvent {
  const envelope = readOwnDataRecord(value, ['type', 'taskId', 'text', 'message', 'approval'])
  switch (envelope.type) {
    case 'turn.output': {
      const record = exactObject(value, ['type', 'taskId', 'text'])
      if (!isLocalTaskId(record.taskId) || !boundedString(record.text, MAX_LOCAL_OUTPUT_LENGTH, true)) return fail()
      return boundedLocalResult(Object.freeze({ type: 'turn.output', taskId: record.taskId, text: record.text }))
    }
    case 'turn.completed':
    case 'turn.cancelled': {
      const record = exactObject(value, ['type', 'taskId'])
      if (!isLocalTaskId(record.taskId)) return fail()
      return boundedLocalResult(Object.freeze({ type: envelope.type, taskId: record.taskId }))
    }
    case 'turn.failed': {
      const record = exactObject(value, ['type', 'taskId', 'message'])
      if (!isLocalTaskId(record.taskId) || !boundedString(record.message, 512)) return fail()
      return boundedLocalResult(Object.freeze({ type: 'turn.failed', taskId: record.taskId, message: record.message }))
    }
    case 'approval.requested': {
      const record = exactObject(value, ['type', 'approval'])
      return boundedLocalResult(Object.freeze({ type: 'approval.requested', approval: parseLocalApproval(record.approval) }))
    }
    default:
      return fail()
  }
}
