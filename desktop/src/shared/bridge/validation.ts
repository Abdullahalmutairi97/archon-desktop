import type {
  BridgeError,
  BrowserViewState,
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
  LocalCodexTurnStatusDto,
  OperationMap,
  OperationName,
  ProjectHeadPayload,
  ProjectCreatePayload,
  RuntimeRecord,
  SessionMessageRecord,
  SessionMessagesPayload,
  SessionsDeletePayload,
  SessionsListPayload,
  AudioStatusResult,
  AudioTranscribePayload,
  AudioTranscribeResult,
  ModelCatalogResult,
  TaskByIdPayload,
  TaskEventRecord,
  TaskEventsPayload,
  TaskRecord,
  TaskModelProvider,
  TaskSubmitPayload,
  TasksListPayload,
  WorkspaceCheckoutState,
  WorkspaceRecord,
  WorkspaceProvisionPayload,
  WorkspaceFileEntry,
  WorkspaceFileDiffPayload,
  WorkspaceFileListPayload,
  WorkspaceFileReadPayload,
  WorkspaceFileSearchPayload,
  WorkspaceFileWritePayload,
  WorkspaceConsoleTerminalDto,
  WorkspaceConsoleScreenDto,
  WorkspaceConsoleAttachTicketDto,
  WorkspaceConsoleAttachLeaseDto,
  WorkspaceConsoleKeyEvent,
  WorkspaceConsoleNamedKey,
  WorkspaceConsoleAttachEventDto,
  WorkspaceServiceDto,
  WorkspaceServicePortDto,
  ResolvedWorkspaceServiceDefinition,
  WorkspaceServiceDefinitionInput,
  LanguageProfileExtensionDto,
  LanguageProfilesDto,
  DebugAdapterDto,
  DebugCodeServerDto,
  DebugReadinessDto,
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
  registerWorkspace: 'archon:local-codex:projects:register-workspace',
  startTurn: 'archon:local-codex:turn:start',
  latestTurnStatus: 'archon:local-codex:turn:latest-status',
  turnStatus: 'archon:local-codex:turn:status',
  cancelTurn: 'archon:local-codex:turn:cancel',
  answerApproval: 'archon:local-codex:approval:answer',
  event: 'archon:local-codex:event',
} as const)

export const WORKSPACE_CONSOLE_CHANNELS = Object.freeze({
  list: 'archon:workspace-console:list',
  create: 'archon:workspace-console:create',
  screen: 'archon:workspace-console:screen',
  sendLine: 'archon:workspace-console:send-line',
  interrupt: 'archon:workspace-console:interrupt',
  stop: 'archon:workspace-console:stop',
  attachOpen: 'archon:workspace-console:attach-open',
  attachClaim: 'archon:workspace-console:attach-claim',
  attachScreen: 'archon:workspace-console:attach-screen',
  attachInput: 'archon:workspace-console:attach-input',
  attachDetach: 'archon:workspace-console:attach-detach',
  attachWatch: 'archon:workspace-console:attach-watch',
  attachUnwatch: 'archon:workspace-console:attach-unwatch',
  attachEvent: 'archon:workspace-console:attach-event',
} as const)

export type WorkspaceConsoleInvokeChannel = (typeof WORKSPACE_CONSOLE_CHANNELS)[keyof typeof WORKSPACE_CONSOLE_CHANNELS]

export const WORKSPACE_SERVICES_CHANNELS = Object.freeze({
  list: 'archon:workspace-services:list',
  define: 'archon:workspace-services:define',
  codeServer: 'archon:workspace-services:code-server',
  remove: 'archon:workspace-services:remove',
  start: 'archon:workspace-services:start',
  stop: 'archon:workspace-services:stop',
  logs: 'archon:workspace-services:logs',
} as const)

export type WorkspaceServicesInvokeChannel = (typeof WORKSPACE_SERVICES_CHANNELS)[keyof typeof WORKSPACE_SERVICES_CHANNELS]

export const LANGUAGE_PROFILES_CHANNELS = Object.freeze({
  list: 'archon:language-profiles:list',
} as const)

export type LanguageProfilesInvokeChannel = (typeof LANGUAGE_PROFILES_CHANNELS)[keyof typeof LANGUAGE_PROFILES_CHANNELS]

export const WORKSPACE_PREVIEW_CHANNELS = Object.freeze({
  open: 'archon:workspace-preview:open',
  bounds: 'archon:workspace-preview:bounds',
  close: 'archon:workspace-preview:close',
} as const)

export type WorkspacePreviewInvokeChannel = (typeof WORKSPACE_PREVIEW_CHANNELS)[keyof typeof WORKSPACE_PREVIEW_CHANNELS]

/** Fixed IPC surface for the in-app browser view; `state` is the main-to-renderer event. */
export const BROWSER_CHANNELS = Object.freeze({
  open: 'archon:browser:open',
  navigate: 'archon:browser:navigate',
  back: 'archon:browser:back',
  forward: 'archon:browser:forward',
  reload: 'archon:browser:reload',
  bounds: 'archon:browser:bounds',
  close: 'archon:browser:close',
  openExternal: 'archon:browser:open-external',
  state: 'archon:browser:state',
} as const)

export type BrowserInvokeChannel = Exclude<(typeof BROWSER_CHANNELS)[keyof typeof BROWSER_CHANNELS], typeof BROWSER_CHANNELS.state>

export type LocalCodexInvokeChannel = Exclude<(typeof LOCAL_CODEX_CHANNELS)[keyof typeof LOCAL_CODEX_CHANNELS], typeof LOCAL_CODEX_CHANNELS.event>

export type BridgeChannel = (typeof BRIDGE_CHANNELS)[keyof typeof BRIDGE_CHANNELS]

const operationNames = Object.freeze([
  'readiness',
  'projects.list',
  'projects.create',
  'projects.head',
  'sessions.list',
  'sessions.messages',
  'sessions.delete',
  'tasks.list',
  'events.cursor',
  'runtimes.list',
  'secrets.authStates',
  'tasks.submit',
  'tasks.get',
  'tasks.events',
  'tasks.cancel',
  'workspaces.list',
  'workspaces.get',
  'workspaces.provision',
  'workspaces.files.list',
  'workspaces.files.read',
  'workspaces.files.diff',
  'workspaces.files.search',
  'workspaces.files.write',
  'workspaces.files.create',
  // Operations pages
  'status.get',
  'logs.list',
  'models.list',
  'models.setDefault',
  'skills.list',
  'skills.get',
  'skills.toggle',
  'cron.list',
  'cron.create',
  'cron.update',
  'cron.action',
  'backups.list',
  'backups.create',
  'backups.schedule.get',
  'backups.schedule.set',
  'backups.inspect',
  'backups.restore',
  // Composer
  'models.catalog',
  'audio.status',
  'audio.transcribe',
  // Server files (ARCHON_ROOT)
  'files.list',
  'files.read',
  'files.writeText',
  'files.mkdir',
  'files.rename',
  'files.copy',
  'files.pickUpload',
  'files.upload',
  'files.download',
  'files.delete',
] as const satisfies readonly OperationName[])

const channels = new Set<string>(Object.values(BRIDGE_CHANNELS))
const operations = new Set<string>(operationNames)
const MAX_SERVER_URL_LENGTH = 2048
const MAX_TOKEN_LENGTH = 8192
const MAX_PROJECT_ID_LENGTH = 200
const MAX_TASK_ID_LENGTH = 200
// The server's safe id alphabet; a conversation id is at most 206 characters
// ('prime-' plus a 200-character request key).
const MAX_SESSION_ID_LENGTH = 206
const MAX_SESSION_MESSAGES = 500
// One removal request; the live session list asks for at most 200 rows.
const MAX_SESSION_DELETE_IDS = 200
const MAX_SESSION_MESSAGE_ID_LENGTH = 512
// Matches the transport's backend response cap; content is never truncated here.
const MAX_SESSION_MESSAGE_CONTENT_TOTAL = 2 * 1024 * 1024
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
const MAX_WORKSPACE_FILE_PATH_LENGTH = 1_000
const MAX_WORKSPACE_FILE_LIST_LIMIT = 200
const MAX_WORKSPACE_FILE_READ_BYTES = 64 * 1024
const MAX_WORKSPACE_FILE_DIFF_BYTES = 64 * 1024
const MAX_WORKSPACE_SEARCH_QUERY_BYTES = 128
const MAX_WORKSPACE_SEARCH_FILES = 200
const MAX_WORKSPACE_SEARCH_BYTES = 1024 * 1024
const MAX_WORKSPACE_SEARCH_HITS = 100
const MAX_WORKSPACE_FILE_WRITE_LENGTH = 12_000
const MAX_WORKSPACE_FILE_WRITE_BYTES = 16 * 1024
// Composer
/** The server's decoded audio ceiling (`services/voice.py`); the desktop never uploads more. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024
/** `AudioTranscriptionRequest.mime_type` is at most 100 characters on the server. */
const MAX_AUDIO_MIME_TYPE_LENGTH = 100
const MAX_AUDIO_BASE64_LENGTH = 4 * Math.ceil(MAX_AUDIO_BYTES / 3)
/** Longest `data:<mime>;base64,<audio>` URL that can carry at most MAX_AUDIO_BYTES. */
export const MAX_AUDIO_DATA_URL_LENGTH = 'data:'.length + MAX_AUDIO_MIME_TYPE_LENGTH + ';base64,'.length + MAX_AUDIO_BASE64_LENGTH
const MAX_AUDIO_TRANSCRIPT_LENGTH = 100_000
const AUDIO_MIME_TYPE = /^audio\/[a-z0-9][a-z0-9.+-]{0,62}(?:;[a-z0-9-]{1,32}=[a-z0-9.,+-]{1,64})*$/u
const AUDIO_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
/** The only provider the server's Prime runner forwards (`prime_runner.py`). */
const TASK_MODEL_PROVIDER: TaskModelProvider = 'openai-codex'
// `TaskCreate.model` and `.provider` are at most 100 characters on the server.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u
const MODEL_PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/u
const MAX_MODEL_PROVIDERS = 16
const MAX_MODELS_PER_PROVIDER = 200
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

function parseWorkspaceByIdPayload(value: unknown): { workspaceId: string } {
  const record = exactObject(value, ['workspaceId'])
  if (!workspaceFileId(record.workspaceId)) return fail()
  return Object.freeze({ workspaceId: record.workspaceId })
}

function parseProjectHeadPayload(value: unknown): ProjectHeadPayload {
  const record = exactObject(value, ['projectId'])
  if (!workspaceText(record.projectId, MAX_PROJECT_ID_LENGTH)) return fail()
  return Object.freeze({ projectId: record.projectId })
}

function parseProjectCreatePayload(value: unknown): ProjectCreatePayload {
  const record = exactObject(value, ['name', 'path'])
  if (!workspaceText(record.name, 120)) return fail()
  if (!isCanonicalAbsoluteProjectPath(record.path)) return fail()
  return Object.freeze({ name: record.name, path: record.path })
}

function isCanonicalAbsoluteProjectPath(value: unknown): value is string {
  if (!boundedString(value, 1_000) || !value.startsWith('/') || /[\u0001-\u001f\u007f-\u009f]/u.test(value)) return false
  if (value === '/') return true
  if (value.endsWith('/')) return false
  return value.slice(1).split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function workspaceFilePath(value: unknown, allowRoot: boolean): value is string {
  if (typeof value !== 'string' || value.length > MAX_WORKSPACE_FILE_PATH_LENGTH) return false
  if (value === '') return allowRoot
  if (value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false
  const parts = value.split('/')
  return parts.length <= 64 && parts.every((part) =>
    part.length > 0 && part !== '.' && part !== '..' && new TextEncoder().encode(part).byteLength <= 255)
}

function workspaceFileId(value: unknown): value is string {
  return typeof value === 'string' && /^workspace-[0-9a-f]{32}$/u.test(value)
}

function workspaceSearchQuery(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WORKSPACE_SEARCH_QUERY_BYTES &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= MAX_WORKSPACE_SEARCH_QUERY_BYTES
}

function workspaceSearchPath(value: unknown): value is string {
  if (!workspaceFilePath(value, false)) return false
  const protectedNames = new Set([
    '.netrc', '.npmrc', '.pypirc', '.ssh', '.aws', '.gnupg', '.docker', '.kube',
    'credentials', 'credential', 'secrets', 'secret', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts.old',
  ])
  return (value as string).split('/').every((component) => {
    const lowered = component.toLowerCase()
    return lowered !== '.git' && !lowered.startsWith('.env') && !protectedNames.has(lowered) &&
      !/\.(?:pem|key|p12|pfx|p7b|p7c|jks|keystore)$/u.test(lowered) &&
      !/(?:service[-_]account|credentials?[-_]?|secret[-_]?|token[-_]?|private[-_]key)/iu.test(lowered) &&
      !(lowered === 'terraform.tfstate' || lowered.startsWith('terraform.tfstate.'))
  })
}

function parseWorkspaceFileListPayload(value: unknown): WorkspaceFileListPayload {
  const record = exactObject(value, ['workspaceId', 'path', 'limit'])
  if (!workspaceFileId(record.workspaceId) || !workspaceFilePath(record.path, true) ||
      typeof record.limit !== 'number' || !Number.isInteger(record.limit) ||
      record.limit < 1 || record.limit > MAX_WORKSPACE_FILE_LIST_LIMIT) return fail()
  return Object.freeze({ workspaceId: record.workspaceId, path: record.path, limit: record.limit })
}

function parseWorkspaceFileReadPayload(value: unknown): WorkspaceFileReadPayload {
  const record = exactObject(value, ['workspaceId', 'path', 'maxBytes'])
  if (!workspaceFileId(record.workspaceId) || !workspaceFilePath(record.path, false) ||
      typeof record.maxBytes !== 'number' || !Number.isInteger(record.maxBytes) ||
      record.maxBytes < 1 || record.maxBytes > MAX_WORKSPACE_FILE_READ_BYTES) return fail()
  return Object.freeze({ workspaceId: record.workspaceId, path: record.path, maxBytes: record.maxBytes })
}

function parseWorkspaceFileDiffPayload(value: unknown): WorkspaceFileDiffPayload {
  const record = exactObject(value, ['workspaceId', 'path'])
  if (!workspaceFileId(record.workspaceId) || !workspaceFilePath(record.path, false)) return fail()
  return Object.freeze({ workspaceId: record.workspaceId, path: record.path })
}

function parseWorkspaceFileSearchPayload(value: unknown): WorkspaceFileSearchPayload {
  const record = exactObject(value, ['workspaceId', 'query'])
  if (!workspaceFileId(record.workspaceId) || !workspaceSearchQuery(record.query)) return fail()
  return Object.freeze({ workspaceId: record.workspaceId, query: record.query })
}

function workspaceFileWriteText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_WORKSPACE_FILE_WRITE_LENGTH &&
    !value.includes('\0') && new TextEncoder().encode(value).byteLength <= MAX_WORKSPACE_FILE_WRITE_BYTES
}

function workspaceFileCreateText(value: unknown): value is string {
  return workspaceFileWriteText(value) && !/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
}

function parseWorkspaceFileWritePayload(value: unknown): WorkspaceFileWritePayload {
  const record = exactObject(value, ['workspaceId', 'path', 'expectedContent', 'content'])
  if (!workspaceFileId(record.workspaceId) || !workspaceFilePath(record.path, false) ||
      !workspaceFileWriteText(record.expectedContent) || !workspaceFileWriteText(record.content)) return fail()
  return Object.freeze({
    workspaceId: record.workspaceId,
    path: record.path,
    expectedContent: record.expectedContent,
    content: record.content,
  })
}

function parseWorkspaceFileCreatePayload(value: unknown): OperationMap['workspaces.files.create']['payload'] {
  const record = exactObject(value, ['workspaceId', 'path', 'content'])
  if (!workspaceFileId(record.workspaceId) || !workspaceFilePath(record.path, false) ||
      !workspaceFileCreateText(record.content)) return fail()
  return Object.freeze({ workspaceId: record.workspaceId, path: record.path, content: record.content })
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_TASK_ID_LENGTH
    && /^[A-Za-z0-9_-]{1,200}$/u.test(value)
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_SESSION_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/u.test(value)
}

function parseTaskSubmitPayload(value: unknown): TaskSubmitPayload {
  const record = readOwnDataRecord(value, ['projectId', 'prompt', 'workspaceId', 'workspaceGeneration', 'sessionId', 'runtime', 'model', 'provider'])
  const hasProject = Object.hasOwn(record, 'projectId')
  const hasWorkspace = Object.hasOwn(record, 'workspaceId')
  const hasSession = Object.hasOwn(record, 'sessionId')
  const hasRuntime = Object.hasOwn(record, 'runtime')
  const hasModel = Object.hasOwn(record, 'model')
  if (hasWorkspace !== Object.hasOwn(record, 'workspaceGeneration')) return fail()
  if (!boundedString(record.prompt, MAX_TASK_PROMPT_LENGTH) || !record.prompt.trim()) return fail()
  if (hasProject && !boundedString(record.projectId, MAX_PROJECT_ID_LENGTH)) return fail()
  // A model travels only with the one provider Prime forwards; Prime silently
  // drops any other pair, so accepting it would promise a choice that never runs.
  if (hasModel !== Object.hasOwn(record, 'provider')) return fail()
  if (hasModel && (record.provider !== TASK_MODEL_PROVIDER || typeof record.model !== 'string' || !MODEL_ID.test(record.model))) return fail()
  const modelChoice = hasModel ? { model: record.model as string, provider: TASK_MODEL_PROVIDER } : {}

  if (hasSession) {
    // A continuation runs under the session's recorded runtime and cwd, so it
    // never carries a runtime choice or a checkout identity. The server does
    // pass a follow-up's model to the runner.
    if (hasWorkspace || hasRuntime || !validSessionId(record.sessionId)) return fail()
    return Object.freeze({ sessionId: record.sessionId, prompt: record.prompt,
      ...(hasProject ? { projectId: record.projectId as string } : {}),
      ...modelChoice,
    })
  }

  if (!hasProject) return fail()
  if (hasWorkspace) {
    // The checkout route forbids extra fields and always runs Prime's default.
    if (hasRuntime || hasModel || !workspaceFileId(record.workspaceId) ||
        typeof record.workspaceGeneration !== 'number' || !Number.isSafeInteger(record.workspaceGeneration) ||
        record.workspaceGeneration < 1) return fail()
    return Object.freeze({ projectId: record.projectId as string, prompt: record.prompt,
      workspaceId: record.workspaceId as string, workspaceGeneration: record.workspaceGeneration,
    })
  }
  if (hasRuntime && record.runtime !== 'prime' && record.runtime !== 'pi') return fail()
  // The server's model catalog lists Prime's signed-in providers only.
  if (hasModel && record.runtime === 'pi') return fail()
  return Object.freeze({ projectId: record.projectId as string, prompt: record.prompt,
    ...(hasRuntime ? { runtime: record.runtime as 'prime' | 'pi' } : {}),
    ...modelChoice,
  })
}

function parseAudioTranscribePayload(value: unknown): AudioTranscribePayload {
  const record = exactObject(value, ['dataUrl', 'mimeType'])
  const { dataUrl, mimeType } = record
  if (typeof mimeType !== 'string' || mimeType.length > MAX_AUDIO_MIME_TYPE_LENGTH || !AUDIO_MIME_TYPE.test(mimeType)) return fail()
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_AUDIO_DATA_URL_LENGTH) return fail()
  const prefix = `data:${mimeType};base64,`
  if (!dataUrl.startsWith(prefix)) return fail()
  const encoded = dataUrl.slice(prefix.length)
  if (encoded.length % 4 !== 0 || !AUDIO_BASE64.test(encoded)) return fail()
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const bytes = (encoded.length / 4) * 3 - padding
  if (bytes < 1 || bytes > MAX_AUDIO_BYTES) return fail()
  return Object.freeze({ dataUrl, mimeType })
}

function parseSessionMessagesPayload(value: unknown): SessionMessagesPayload {
  const record = exactObject(value, ['sessionId', 'limit'])
  if (!validSessionId(record.sessionId)) return fail()
  if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) ||
      record.limit < 1 || record.limit > MAX_SESSION_MESSAGES) return fail()
  return Object.freeze({ sessionId: record.sessionId, limit: record.limit })
}

function parseSessionsDeletePayload(value: unknown): SessionsDeletePayload {
  const record = exactObject(value, ['sessionIds'])
  const sessionIds = readLocalArray(record.sessionIds, MAX_SESSION_DELETE_IDS)
  if (sessionIds.length === 0 || !sessionIds.every(validSessionId)) return fail()
  if (new Set(sessionIds).size !== sessionIds.length) return fail()
  return Object.freeze({ sessionIds: Object.freeze(sessionIds) })
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

// Operations pages: status, logs, models, skills, cron and backups.
// Every response is read with exact key sets, so a sensitive field name can
// never pass; free-text command output is additionally redacted.
const MAX_OPS_LOG_ROWS = 2_000
const MAX_OPS_SKILLS = 1_000
const MAX_OPS_CRON_JOBS = 500
const MAX_OPS_BACKUPS = 1_000
const MAX_OPS_PATH_LENGTH = 4_096
const MAX_OPS_TEXT_OUTPUT = 1_000_000
const MAX_OPS_CRON_PROMPT_INPUT = 8_000
const MAX_OPS_CRON_PROMPT_RESULT = 100_000
const MAX_OPS_RESTORE_PATHS = 200
const OPS_LOG_LEVELS = new Set(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'])
const OPS_CRON_ACTIONS = new Set(['pause', 'resume', 'run', 'remove'])
const OPS_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u
const OPS_CRON_JOB_ID = /^[a-f0-9]{12}$/u
const OPS_CRON_LISTED_ID = /^[A-Za-z0-9_-]{1,64}$/u
const OPS_CRON_DELIVER = /^[A-Za-z0-9][A-Za-z0-9_:.@+-]{0,63}$/u
const OPS_BACKUP_ID = /^\d{8}_\d{6}$/u
const OPS_BACKUP_FILE = /^archon-backup-\d{8}_\d{6}\.tar\.gz(?:\.age)?$/u
// The server's own systemd calendar alphabet.
const OPS_BACKUP_CALENDAR = /^[A-Za-z0-9*,:./+_@~ -]{3,120}$/u
const OPS_SECRET_ASSIGNMENT = /\b(token|api[_-]?key|authorization|password|secret)\b(\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/giu
const OPS_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gu
const OPS_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu
// ANSI escape sequences and every control character except tab, newline and carriage return.
const OPS_TERMINAL_NOISE = /\u001b\[[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu

function redactSecretText(text: string): string {
  return text
    .replace(OPS_PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(OPS_SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
    .replace(OPS_BEARER, 'Bearer [REDACTED]')
}

/** Single-line display text: bounded and free of control characters. */
function opsText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return boundedString(value, maxLength, allowEmpty) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function opsNullableText(value: unknown, maxLength: number): value is string | null {
  return value === null || opsText(value, maxLength, true)
}

function opsCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function opsPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function opsLoad(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
}

function opsServerPath(value: unknown): value is string {
  return isCanonicalAbsolutePath(value) && value.length <= MAX_OPS_PATH_LENGTH
}

/** Command output and archive listings: text only, redacted, never markup. */
function opsCommandOutput(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_OPS_TEXT_OUTPUT) return fail()
  return redactSecretText(value.replace(OPS_TERMINAL_NOISE, ''))
}

/** A value the server hands to its scheduler CLI as an argument; never option-shaped. */
function opsCliArgument(value: unknown, maxLength: number, allowEmpty: boolean): value is string {
  return opsText(value, maxLength, allowEmpty) && value === value.trim() && !value.startsWith('-')
}

function opsCronSchedule(value: unknown): value is string {
  return opsCliArgument(value, 120, false)
}

function opsCronPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_OPS_CRON_PROMPT_INPUT && value.trim().length > 0 &&
    !/^-\S/u.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
}

function opsCronName(value: unknown): value is string {
  return opsCliArgument(value, 300, true)
}

function opsCronDeliver(value: unknown): value is string {
  return typeof value === 'string' && OPS_CRON_DELIVER.test(value)
}

function opsBackupCalendar(value: unknown): value is string {
  return typeof value === 'string' && OPS_BACKUP_CALENDAR.test(value) && value === value.trim()
}

function opsBackupSource(value: unknown): value is string {
  return isCanonicalAbsolutePath(value) && value.length <= 1_000 && OPS_BACKUP_FILE.test(value.slice(value.lastIndexOf('/') + 1))
}

function opsSkillName(value: unknown): value is string {
  return opsText(value, 200) && value === value.trim() && value !== '.' && value !== '..' &&
    !value.includes('/') && !value.includes('\\')
}

function opsConfirm(record: Record<string, unknown>): void {
  if (record.confirm !== true) fail()
}

function parseLogsListPayload(value: unknown): OperationMap['logs.list']['payload'] {
  const record = readOwnDataRecord(value, ['limit', 'level'])
  if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 1 || record.limit > MAX_OPS_LOG_ROWS) return fail()
  if (Object.hasOwn(record, 'level') && (typeof record.level !== 'string' || !OPS_LOG_LEVELS.has(record.level))) return fail()
  return Object.freeze({
    limit: record.limit,
    ...(Object.hasOwn(record, 'level') ? { level: record.level as OperationMap['logs.list']['payload']['level'] } : {}),
  })
}

function parseModelRefPayload(value: unknown): OperationMap['models.setDefault']['payload'] {
  const record = exactObject(value, ['provider', 'model'])
  if (typeof record.provider !== 'string' || !OPS_MODEL_ID.test(record.provider) ||
      typeof record.model !== 'string' || !OPS_MODEL_ID.test(record.model)) return fail()
  return Object.freeze({ provider: record.provider, model: record.model })
}

function parseSkillByNamePayload(value: unknown): OperationMap['skills.get']['payload'] {
  const record = exactObject(value, ['name'])
  if (!opsSkillName(record.name)) return fail()
  return Object.freeze({ name: record.name })
}

function parseSkillTogglePayload(value: unknown): OperationMap['skills.toggle']['payload'] {
  const record = exactObject(value, ['name', 'enabled'])
  if (!opsSkillName(record.name) || typeof record.enabled !== 'boolean') return fail()
  return Object.freeze({ name: record.name, enabled: record.enabled })
}

function parseCronCreatePayload(value: unknown): OperationMap['cron.create']['payload'] {
  const record = exactObject(value, ['schedule', 'prompt', 'name', 'deliver', 'confirm'])
  opsConfirm(record)
  if (!opsCronSchedule(record.schedule) || !opsCronPrompt(record.prompt) ||
      !opsCronName(record.name) || !opsCronDeliver(record.deliver)) return fail()
  return Object.freeze({ schedule: record.schedule, prompt: record.prompt, name: record.name, deliver: record.deliver, confirm: true as const })
}

function parseCronUpdatePayload(value: unknown): OperationMap['cron.update']['payload'] {
  const record = exactObject(value, ['jobId', 'fields', 'confirm'])
  opsConfirm(record)
  if (typeof record.jobId !== 'string' || !OPS_CRON_JOB_ID.test(record.jobId)) return fail()
  const fields = readOwnDataRecord(record.fields, ['schedule', 'prompt', 'name', 'deliver'])
  if (Object.keys(fields).length === 0) return fail()
  if (Object.hasOwn(fields, 'schedule') && !opsCronSchedule(fields.schedule)) return fail()
  if (Object.hasOwn(fields, 'prompt') && !opsCronPrompt(fields.prompt)) return fail()
  if (Object.hasOwn(fields, 'name') && !opsCronName(fields.name)) return fail()
  if (Object.hasOwn(fields, 'deliver') && !opsCronDeliver(fields.deliver)) return fail()
  const copy: Record<string, string> = {}
  for (const key of ['schedule', 'prompt', 'name', 'deliver'] as const) {
    if (Object.hasOwn(fields, key)) copy[key] = fields[key] as string
  }
  return Object.freeze({ jobId: record.jobId, fields: Object.freeze(copy), confirm: true as const })
}

function parseCronActionPayload(value: unknown): OperationMap['cron.action']['payload'] {
  const record = exactObject(value, ['jobId', 'action', 'confirm'])
  opsConfirm(record)
  if (typeof record.jobId !== 'string' || !OPS_CRON_JOB_ID.test(record.jobId) ||
      typeof record.action !== 'string' || !OPS_CRON_ACTIONS.has(record.action)) return fail()
  return Object.freeze({ jobId: record.jobId, action: record.action as OperationMap['cron.action']['payload']['action'], confirm: true as const })
}

function parseBackupConfirmPayload(value: unknown): OperationMap['backups.create']['payload'] {
  const record = exactObject(value, ['confirm'])
  opsConfirm(record)
  return Object.freeze({ confirm: true as const })
}

function parseBackupScheduleSetPayload(value: unknown): OperationMap['backups.schedule.set']['payload'] {
  const record = exactObject(value, ['calendar', 'confirm'])
  opsConfirm(record)
  if (!opsBackupCalendar(record.calendar)) return fail()
  return Object.freeze({ calendar: record.calendar, confirm: true as const })
}

function parseBackupInspectPayload(value: unknown): OperationMap['backups.inspect']['payload'] {
  const record = exactObject(value, ['source'])
  if (!opsBackupSource(record.source)) return fail()
  return Object.freeze({ source: record.source })
}

function parseBackupRestorePayload(value: unknown): OperationMap['backups.restore']['payload'] {
  const record = exactObject(value, ['source', 'allFiles', 'paths', 'confirm'])
  opsConfirm(record)
  if (!opsBackupSource(record.source) || typeof record.allFiles !== 'boolean') return fail()
  const paths = readLocalArray(record.paths, MAX_OPS_RESTORE_PATHS)
  if (record.allFiles ? paths.length !== 0 : paths.length === 0) return fail()
  for (const path of paths) {
    if (!opsCliArgument(path, 1_000, false) || path.split('/').some((part) => part === '..')) return fail()
  }
  if (new Set(paths).size !== paths.length) return fail()
  return Object.freeze({ source: record.source, allFiles: record.allFiles, paths: Object.freeze(paths as string[]), confirm: true as const })
}

function parseStatusSnapshot(value: unknown): OperationMap['status.get']['result'] {
  const record = exactObject(value, ['hostname', 'system', 'architecture', 'kernel', 'uptime_seconds', 'cpu', 'memory', 'swap', 'disk', 'archon'])
  if (!opsText(record.hostname, 255) || !opsText(record.system, 64, true) || !opsText(record.architecture, 64, true) ||
      !opsText(record.kernel, 256, true) || !opsCount(record.uptime_seconds)) return fail()
  const cpu = exactObject(record.cpu, ['percent', 'cores', 'load_1', 'load_5', 'load_15'])
  if (!opsPercent(cpu.percent) || !opsCount(cpu.cores) || cpu.cores < 1 ||
      !opsLoad(cpu.load_1) || !opsLoad(cpu.load_5) || !opsLoad(cpu.load_15)) return fail()
  const memory = exactObject(record.memory, ['total', 'used', 'available', 'percent'])
  if (!opsCount(memory.total) || !opsCount(memory.used) || !opsCount(memory.available) || !opsPercent(memory.percent)) return fail()
  const swap = exactObject(record.swap, ['total', 'used', 'percent'])
  if (!opsCount(swap.total) || !opsCount(swap.used) || !opsPercent(swap.percent)) return fail()
  const disk = exactObject(record.disk, ['path', 'total', 'used', 'free', 'percent'])
  if (!opsServerPath(disk.path) || !opsCount(disk.total) || !opsCount(disk.used) || !opsCount(disk.free) || !opsPercent(disk.percent)) return fail()
  const archon = exactObject(record.archon, ['cpu_percent', 'memory_used', 'memory_percent', 'processes', 'accounting'])
  if (!opsPercent(archon.cpu_percent) || !opsCount(archon.memory_used) || !opsPercent(archon.memory_percent) ||
      !opsCount(archon.processes) || (archon.accounting !== 'systemd-cgroup' && archon.accounting !== 'process-tree')) return fail()
  return Object.freeze({
    hostname: record.hostname,
    system: record.system,
    architecture: record.architecture,
    kernel: record.kernel,
    uptime_seconds: record.uptime_seconds,
    cpu: Object.freeze({ percent: cpu.percent, cores: cpu.cores, load_1: cpu.load_1, load_5: cpu.load_5, load_15: cpu.load_15 }),
    memory: Object.freeze({ total: memory.total, used: memory.used, available: memory.available, percent: memory.percent }),
    swap: Object.freeze({ total: swap.total, used: swap.used, percent: swap.percent }),
    disk: Object.freeze({ path: disk.path, total: disk.total, used: disk.used, free: disk.free, percent: disk.percent }),
    archon: Object.freeze({
      cpu_percent: archon.cpu_percent,
      memory_used: archon.memory_used,
      memory_percent: archon.memory_percent,
      processes: archon.processes,
      accounting: archon.accounting,
    }),
  })
}

function parseLogEntry(value: unknown): OperationMap['logs.list']['result']['logs'][number] {
  const record = exactObject(value, ['id', 'timestamp', 'level', 'source', 'component', 'message'])
  if (!opsText(record.id, 256) || !opsText(record.timestamp, 64, true) ||
      typeof record.level !== 'string' || !OPS_LOG_LEVELS.has(record.level) ||
      !opsText(record.source, 64) || !opsText(record.component, 256, true) ||
      typeof record.message !== 'string' || record.message.length > 16_000) return fail()
  return Object.freeze({
    id: record.id,
    timestamp: record.timestamp,
    level: record.level as OperationMap['logs.list']['result']['logs'][number]['level'],
    source: record.source,
    component: record.component,
    message: redactSecretText(record.message.replace(OPS_TERMINAL_NOISE, '')),
  })
}

function parseModelCatalog(value: unknown): OperationMap['models.list']['result'] {
  const record = exactObject(value, ['current', 'fallback', 'providers', 'choices'])
  const current = exactObject(record.current, ['provider', 'model', 'base_url_configured'])
  const modelOrNull = (item: unknown): item is string | null => item === null || (typeof item === 'string' && OPS_MODEL_ID.test(item))
  if (!modelOrNull(current.provider) || !modelOrNull(current.model) || typeof current.base_url_configured !== 'boolean') return fail()
  if (record.fallback !== null) return fail()
  const providers = readLocalArray(record.providers, 32).map((item) => {
    const provider = exactObject(item, ['id', 'models'])
    if (typeof provider.id !== 'string' || !OPS_MODEL_ID.test(provider.id)) return fail()
    const models = readLocalArray(provider.models, 256)
    if (models.some((model) => typeof model !== 'string' || !OPS_MODEL_ID.test(model)) || new Set(models).size !== models.length) return fail()
    return Object.freeze({ id: provider.id, models: Object.freeze(models as string[]) })
  })
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) return fail()
  const choices = readLocalArray(record.choices, 2_048).map((item) => {
    const choice = exactObject(item, ['provider', 'model'])
    if (typeof choice.provider !== 'string' || !OPS_MODEL_ID.test(choice.provider) ||
        typeof choice.model !== 'string' || !OPS_MODEL_ID.test(choice.model)) return fail()
    return Object.freeze({ provider: choice.provider, model: choice.model })
  })
  return Object.freeze({
    current: Object.freeze({ provider: current.provider, model: current.model, base_url_configured: current.base_url_configured }),
    fallback: null,
    providers: Object.freeze(providers),
    choices: Object.freeze(choices),
  })
}

function parseSkillRecord(value: unknown, withContent: true): OperationMap['skills.get']['result']
function parseSkillRecord(value: unknown, withContent: false): OperationMap['skills.toggle']['result']
function parseSkillRecord(value: unknown, withContent: boolean): OperationMap['skills.get']['result'] | OperationMap['skills.toggle']['result'] {
  const keys = ['name', 'description', 'category', 'enabled', 'path']
  const record = exactObject(value, withContent ? [...keys, 'content'] : keys)
  if (!opsText(record.name, 200) || !boundedString(record.description, 4_000, true) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(record.description) ||
      !opsText(record.category, 200, true) || typeof record.enabled !== 'boolean' || !opsServerPath(record.path)) return fail()
  const base = { name: record.name, description: record.description, category: record.category, enabled: record.enabled, path: record.path }
  if (!withContent) return Object.freeze(base)
  if (typeof record.content !== 'string' || record.content.length > MAX_OPS_TEXT_OUTPUT || record.content.includes('\0')) return fail()
  return Object.freeze({ ...base, content: record.content })
}

function parseCronJobs(value: unknown): OperationMap['cron.list']['result']['jobs'] {
  const jobs = readLocalArray(value, MAX_OPS_CRON_JOBS).map((item) => {
    const record = exactObject(item, [
      'id', 'name', 'enabled', 'state', 'schedule', 'next_run_at', 'last_run_at', 'last_status', 'last_error',
      'deliver', 'prompt', 'skills', 'model', 'provider', 'script', 'no_agent',
    ])
    if (typeof record.id !== 'string' || !OPS_CRON_LISTED_ID.test(record.id) || !opsText(record.name, 300) ||
        typeof record.enabled !== 'boolean' || typeof record.no_agent !== 'boolean' ||
        !opsNullableText(record.state, 64) || !opsNullableText(record.schedule, 200) ||
        !opsNullableText(record.next_run_at, 64) || !opsNullableText(record.last_run_at, 64) ||
        !opsNullableText(record.last_status, 64) || !opsNullableText(record.deliver, 200) ||
        !opsNullableText(record.model, 200) || !opsNullableText(record.provider, 200) ||
        !(record.script === null || opsText(record.script, MAX_OPS_PATH_LENGTH, true))) return fail()
    if (record.last_error !== null && (typeof record.last_error !== 'string' || record.last_error.length > 16_000)) return fail()
    if (typeof record.prompt !== 'string' || record.prompt.length > MAX_OPS_CRON_PROMPT_RESULT || record.prompt.includes('\0')) return fail()
    const skills = readLocalArray(record.skills, 64)
    if (skills.some((skill) => !opsText(skill, 200))) return fail()
    return Object.freeze({
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      state: record.state,
      schedule: record.schedule,
      next_run_at: record.next_run_at,
      last_run_at: record.last_run_at,
      last_status: record.last_status,
      last_error: record.last_error === null ? null : redactSecretText(record.last_error.replace(OPS_TERMINAL_NOISE, '')),
      deliver: record.deliver,
      prompt: record.prompt,
      skills: Object.freeze(skills as string[]),
      model: record.model,
      provider: record.provider,
      script: record.script,
      no_agent: record.no_agent,
    })
  })
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) return fail()
  return Object.freeze(jobs)
}

function parseBackupRecords(value: unknown): OperationMap['backups.list']['result']['backups'] {
  const backups = readLocalArray(value, MAX_OPS_BACKUPS).map((item) => {
    const record = exactObject(item, ['id', 'created_at', 'plain_path', 'encrypted_path', 'plain_size', 'encrypted_size', 'encrypted'])
    if (typeof record.id !== 'string' || !OPS_BACKUP_ID.test(record.id) || !opsText(record.created_at, 64) ||
        typeof record.encrypted !== 'boolean') return fail()
    for (const [path, size] of [['plain_path', 'plain_size'], ['encrypted_path', 'encrypted_size']] as const) {
      if (record[path] === null ? record[size] !== null : !opsServerPath(record[path]) || !opsCount(record[size])) return fail()
    }
    if (record.encrypted !== (record.encrypted_path !== null)) return fail()
    return Object.freeze({
      id: record.id,
      created_at: record.created_at,
      plain_path: record.plain_path as string | null,
      encrypted_path: record.encrypted_path as string | null,
      plain_size: record.plain_size as number | null,
      encrypted_size: record.encrypted_size as number | null,
      encrypted: record.encrypted,
    })
  })
  if (new Set(backups.map((backup) => backup.id)).size !== backups.length) return fail()
  return Object.freeze(backups)
}

function parseBackupSchedule(value: unknown): OperationMap['backups.schedule.get']['result'] {
  const optional = ['ActiveState', 'UnitFileState', 'NextElapseUSecRealtime', 'LastTriggerUSec'] as const
  const record = readOwnDataRecord(value, ['calendar', ...optional])
  if (!Object.hasOwn(record, 'calendar') || !opsNullableText(record.calendar, 200)) return fail()
  const result: OperationMap['backups.schedule.get']['result'] = { calendar: record.calendar }
  for (const key of optional) {
    if (!Object.hasOwn(record, key)) continue
    if (!opsText(record[key], 256, true)) return fail()
    result[key] = record[key] as string
  }
  return Object.freeze(result)
}

// Server files (ARCHON_ROOT) --------------------------------------------------

/** The server's `max_length` for every file path it accepts. */
export const SERVER_FILE_PATH_MAX_LENGTH = 1_000
/** Largest text window the editor reads; a longer file opens truncated and read-only. */
export const SERVER_FILE_READ_MAX_BYTES = 1024 * 1024
/**
 * Largest text the editor saves, measured as JSON-encoded UTF-8. The server
 * echoes the saved file back, so this keeps that reply inside the transport's
 * 2 MiB response cap.
 */
export const SERVER_FILE_TEXT_MAX_BYTES = 1024 * 1024
/** The server refuses uploads over 100 MiB; downloads are held to the same bound. */
export const SERVER_FILE_TRANSFER_MAX_BYTES = 100 * 1024 * 1024
/** Matches the transport's response array bound. */
export const SERVER_FILE_LIST_MAX_ITEMS = 2_000
const SERVER_FILE_PICK_ID = /^upload-[0-9a-f]{32}$/u

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/**
 * A path relative to the server's file root: no absolute or home-relative
 * form (the server expands a leading `~`), no `.`/`..` segment, no backslash,
 * control character, NUL or unpaired surrogate. `''` is the root itself.
 */
export function isServerFilePath(value: unknown, allowRoot = false): value is string {
  if (typeof value !== 'string' || value.length > SERVER_FILE_PATH_MAX_LENGTH) return false
  if (value === '') return allowRoot
  if (value.startsWith('/') || value.startsWith('~') || value.includes('\\') ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value) || !isWellFormedLocalText(value)) return false
  const parts = value.split('/')
  return parts.length <= 128 && parts.every((part) =>
    part.length > 0 && part !== '.' && part !== '..' && utf8ByteLength(part) <= 255)
}

/** Text the server can store and echo back unchanged within the bridge bounds. */
export function isServerFileText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SERVER_FILE_TEXT_MAX_BYTES &&
    !value.includes('\0') && isWellFormedLocalText(value) &&
    utf8ByteLength(JSON.stringify(value)) <= SERVER_FILE_TEXT_MAX_BYTES
}

function parseServerFileListPayload(value: unknown): OperationMap['files.list']['payload'] {
  const record = exactObject(value, ['path'])
  if (!isServerFilePath(record.path, true)) return fail()
  return Object.freeze({ path: record.path })
}

function parseServerFilePathPayload(value: unknown): OperationMap['files.mkdir']['payload'] {
  const record = exactObject(value, ['path'])
  if (!isServerFilePath(record.path)) return fail()
  return Object.freeze({ path: record.path })
}

function parseServerFileReadPayload(value: unknown): OperationMap['files.read']['payload'] {
  const record = exactObject(value, ['path', 'maxBytes'])
  if (!isServerFilePath(record.path) || typeof record.maxBytes !== 'number' || !Number.isSafeInteger(record.maxBytes) ||
      record.maxBytes < 1 || record.maxBytes > SERVER_FILE_READ_MAX_BYTES) return fail()
  return Object.freeze({ path: record.path, maxBytes: record.maxBytes })
}

function parseServerFileWritePayload(value: unknown): OperationMap['files.writeText']['payload'] {
  const record = exactObject(value, ['path', 'content'])
  if (!isServerFilePath(record.path) || !isServerFileText(record.content)) return fail()
  return Object.freeze({ path: record.path, content: record.content })
}

function parseServerFileMovePayload(value: unknown): OperationMap['files.rename']['payload'] {
  const record = exactObject(value, ['path', 'destination'])
  if (!isServerFilePath(record.path) || !isServerFilePath(record.destination) || record.path === record.destination) return fail()
  return Object.freeze({ path: record.path, destination: record.destination })
}

function parseServerFileUploadPayload(value: unknown): OperationMap['files.upload']['payload'] {
  const record = exactObject(value, ['pickId', 'path', 'replace'])
  if (typeof record.pickId !== 'string' || !SERVER_FILE_PICK_ID.test(record.pickId) ||
      !isServerFilePath(record.path) || typeof record.replace !== 'boolean') return fail()
  return Object.freeze({ pickId: record.pickId, path: record.path, replace: record.replace })
}

function parseServerFileDeletePayload(value: unknown): OperationMap['files.delete']['payload'] {
  const record = exactObject(value, ['path', 'confirm'])
  if (!isServerFilePath(record.path) || record.confirm !== true) return fail()
  return Object.freeze({ path: record.path, confirm: true as const })
}

function serverFileCount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}

/** Display text from the server: bounded, NUL-free. Names may still be unaddressable. */
function serverFileDisplayText(value: unknown, maxLength: number): value is string {
  return boundedString(value, maxLength)
}

function parseServerFileItem(value: unknown): OperationMap['files.list']['result']['items'][number] {
  const record = exactObject(value, ['name', 'path', 'is_dir', 'is_symlink', 'restricted', 'size', 'modified_at', 'mime'])
  if (!serverFileDisplayText(record.name, 1_024) || record.name.includes('/') ||
      !serverFileDisplayText(record.path, 4_096) ||
      typeof record.is_dir !== 'boolean' || typeof record.is_symlink !== 'boolean' || typeof record.restricted !== 'boolean' ||
      !serverFileCount(record.size) || !boundedString(record.modified_at, 64) ||
      (record.mime !== null && !boundedString(record.mime, 256)) ||
      (record.is_dir && record.mime !== null)) return fail()
  return Object.freeze({
    name: record.name,
    path: record.path,
    is_dir: record.is_dir,
    is_symlink: record.is_symlink,
    restricted: record.restricted,
    size: record.size,
    modified_at: record.modified_at,
    mime: record.mime as string | null,
  })
}

function parseServerFileRead(value: unknown): OperationMap['files.read']['result'] {
  const record = exactObject(value, ['path', 'content', 'size', 'read', 'truncated', 'binary'])
  // Undecodable bytes arrive as U+FFFD, one code unit per byte at most.
  if (!serverFileDisplayText(record.path, 4_096) || typeof record.content !== 'string' ||
      record.content.includes('\0') ||
      !serverFileCount(record.size) || !serverFileCount(record.read, SERVER_FILE_READ_MAX_BYTES) ||
      record.content.length > record.read || record.read > record.size || typeof record.truncated !== 'boolean' ||
      record.truncated !== (record.size > record.read) || record.binary !== false) return fail()
  return Object.freeze({
    path: record.path,
    content: record.content,
    size: record.size,
    read: record.read,
    truncated: record.truncated,
    binary: false as const,
  })
}

function parseServerFileOperationResponse(
  operation: 'files.list' | 'files.read' | 'files.writeText' | 'files.mkdir' | 'files.rename' | 'files.copy' |
    'files.pickUpload' | 'files.upload' | 'files.download' | 'files.delete',
  value: unknown,
): OperationMap[OperationName]['result'] {
  switch (operation) {
    case 'files.list': {
      const record = exactObject(value, ['root', 'path', 'items'])
      if (!serverFileDisplayText(record.root, 4_096) || !serverFileDisplayText(record.path, SERVER_FILE_PATH_MAX_LENGTH)) return fail()
      const items = readLocalArray(record.items, SERVER_FILE_LIST_MAX_ITEMS).map(parseServerFileItem)
      return Object.freeze({ root: record.root, path: record.path, items: Object.freeze(items) })
    }
    case 'files.read':
    case 'files.writeText': {
      const parsed = parseServerFileRead(value)
      if (operation === 'files.writeText' && parsed.truncated) return fail()
      return parsed
    }
    case 'files.mkdir': {
      const record = exactObject(value, ['path', 'created'])
      if (!serverFileDisplayText(record.path, 4_096) || typeof record.created !== 'boolean') return fail()
      return Object.freeze({ path: record.path, created: record.created })
    }
    case 'files.rename':
    case 'files.copy': {
      const record = exactObject(value, ['path'])
      if (!serverFileDisplayText(record.path, 4_096)) return fail()
      return Object.freeze({ path: record.path })
    }
    case 'files.pickUpload': {
      if (isRecord(value) && value.cancelled === true) {
        exactObject(value, ['cancelled'])
        return Object.freeze({ cancelled: true as const })
      }
      const record = exactObject(value, ['cancelled', 'pickId', 'name', 'size'])
      if (record.cancelled !== false || typeof record.pickId !== 'string' || !SERVER_FILE_PICK_ID.test(record.pickId) ||
          !serverFileDisplayText(record.name, 1_024) || !serverFileCount(record.size, SERVER_FILE_TRANSFER_MAX_BYTES)) return fail()
      return Object.freeze({ cancelled: false as const, pickId: record.pickId, name: record.name, size: record.size })
    }
    case 'files.upload': {
      const record = exactObject(value, ['path', 'size'])
      if (!serverFileDisplayText(record.path, 4_096) || !serverFileCount(record.size, SERVER_FILE_TRANSFER_MAX_BYTES)) return fail()
      return Object.freeze({ path: record.path, size: record.size })
    }
    case 'files.download': {
      if (isRecord(value) && value.saved === false) {
        exactObject(value, ['saved'])
        return Object.freeze({ saved: false as const })
      }
      const record = exactObject(value, ['saved', 'name', 'size'])
      if (record.saved !== true || !serverFileDisplayText(record.name, 1_024) ||
          !serverFileCount(record.size, SERVER_FILE_TRANSFER_MAX_BYTES)) return fail()
      return Object.freeze({ saved: true as const, name: record.name, size: record.size })
    }
    case 'files.delete': {
      const record = exactObject(value, ['ok'])
      if (record.ok !== true) return fail()
      return Object.freeze({ ok: true as const })
    }
  }
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
    case 'secrets.authStates':
    case 'workspaces.list':
      return Object.freeze([operation, parseEmptyPayload(payload)])
    case 'workspaces.provision':
      return Object.freeze([operation, parseWorkspaceProvisionPayload(payload)])
    case 'workspaces.get':
      return Object.freeze([operation, parseWorkspaceByIdPayload(payload)])
    case 'projects.head':
      return Object.freeze([operation, parseProjectHeadPayload(payload)])
    case 'projects.create':
      return Object.freeze([operation, parseProjectCreatePayload(payload)])
    case 'workspaces.files.list':
      return Object.freeze([operation, parseWorkspaceFileListPayload(payload)])
    case 'workspaces.files.read':
      return Object.freeze([operation, parseWorkspaceFileReadPayload(payload)])
    case 'workspaces.files.diff':
      return Object.freeze([operation, parseWorkspaceFileDiffPayload(payload)])
    case 'workspaces.files.search':
      return Object.freeze([operation, parseWorkspaceFileSearchPayload(payload)])
    case 'workspaces.files.write':
      return Object.freeze([operation, parseWorkspaceFileWritePayload(payload)])
    case 'workspaces.files.create':
      return Object.freeze([operation, parseWorkspaceFileCreatePayload(payload)])
    case 'sessions.list':
      return Object.freeze([operation, parseSessionsPayload(payload)])
    case 'sessions.messages':
      return Object.freeze([operation, parseSessionMessagesPayload(payload)])
    case 'sessions.delete':
      return Object.freeze([operation, parseSessionsDeletePayload(payload)])
    case 'tasks.list':
      return Object.freeze([operation, parseTasksPayload(payload)])
    case 'tasks.submit':
      return Object.freeze([operation, parseTaskSubmitPayload(payload)])
    case 'tasks.get':
    case 'tasks.cancel':
      return Object.freeze([operation, parseTaskByIdPayload(payload)])
    case 'tasks.events':
      return Object.freeze([operation, parseTaskEventsPayload(payload)])
    // Operations pages
    case 'status.get':
    case 'models.list':
    case 'skills.list':
    case 'cron.list':
    case 'backups.list':
    case 'backups.schedule.get':
      return Object.freeze([operation, parseEmptyPayload(payload)])
    case 'logs.list':
      return Object.freeze([operation, parseLogsListPayload(payload)])
    case 'models.setDefault':
      return Object.freeze([operation, parseModelRefPayload(payload)])
    case 'skills.get':
      return Object.freeze([operation, parseSkillByNamePayload(payload)])
    case 'skills.toggle':
      return Object.freeze([operation, parseSkillTogglePayload(payload)])
    case 'cron.create':
      return Object.freeze([operation, parseCronCreatePayload(payload)])
    case 'cron.update':
      return Object.freeze([operation, parseCronUpdatePayload(payload)])
    case 'cron.action':
      return Object.freeze([operation, parseCronActionPayload(payload)])
    case 'backups.create':
      return Object.freeze([operation, parseBackupConfirmPayload(payload)])
    case 'backups.schedule.set':
      return Object.freeze([operation, parseBackupScheduleSetPayload(payload)])
    case 'backups.inspect':
      return Object.freeze([operation, parseBackupInspectPayload(payload)])
    case 'backups.restore':
      return Object.freeze([operation, parseBackupRestorePayload(payload)])
    // Composer
    case 'models.catalog':
    case 'audio.status':
      return Object.freeze([operation, parseEmptyPayload(payload)])
    case 'audio.transcribe':
      return Object.freeze([operation, parseAudioTranscribePayload(payload)])
    // Server files (ARCHON_ROOT)
    case 'files.list':
      return Object.freeze([operation, parseServerFileListPayload(payload)])
    case 'files.read':
      return Object.freeze([operation, parseServerFileReadPayload(payload)])
    case 'files.writeText':
      return Object.freeze([operation, parseServerFileWritePayload(payload)])
    case 'files.mkdir':
    case 'files.download':
      return Object.freeze([operation, parseServerFilePathPayload(payload)])
    case 'files.rename':
    case 'files.copy':
      return Object.freeze([operation, parseServerFileMovePayload(payload)])
    case 'files.pickUpload':
      return Object.freeze([operation, parseEmptyPayload(payload)])
    case 'files.upload':
      return Object.freeze([operation, parseServerFileUploadPayload(payload)])
    case 'files.delete':
      return Object.freeze([operation, parseServerFileDeletePayload(payload)])
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


const AUTH_STATES = new Set(['unavailable', 'unverified', 'verified'])

/**
 * Per-provider authentication state. The server contract is that no secret value
 * is ever present, so a response carrying anything value-shaped is refused here
 * rather than displayed.
 */
function parseSecretAuthStates(value: unknown): OperationMap['secrets.authStates']['result'] {
  const record = exactObject(value, ['providers', 'epoch', 'secretSource', 'secretValuesExposed', 'note'])
  if (record.secretValuesExposed !== false) return fail()
  if (!boundedString(record.secretSource, 64) || !boundedString(record.note, 2_000)) return fail()
  if (typeof record.epoch !== 'number' || !Number.isSafeInteger(record.epoch) || record.epoch < 0) return fail()
  if (!Array.isArray(record.providers) || record.providers.length > 64) return fail()
  const providers = record.providers.map((item) => {
    const row = exactObject(item, [
      'provider', 'state', 'references', 'purpose', 'verifiedAt', 'lastAttemptAt', 'lastFailureReason',
    ])
    if (!boundedString(row.provider, 128) || typeof row.state !== 'string' || !AUTH_STATES.has(row.state)) return fail()
    if (typeof row.references !== 'number' || !Number.isSafeInteger(row.references) || row.references < 0) return fail()
    if (!Array.isArray(row.purpose) || row.purpose.length > 16
      || row.purpose.some((entry) => !boundedString(entry, 64))) return fail()
    for (const key of ['verifiedAt', 'lastAttemptAt', 'lastFailureReason'] as const) {
      if (row[key] !== null && !boundedString(row[key], 512, true)) return fail()
    }
    return Object.freeze({
      provider: row.provider,
      state: row.state as 'unavailable' | 'unverified' | 'verified',
      references: row.references,
      purpose: Object.freeze(row.purpose as string[]),
      verifiedAt: row.verifiedAt as string | null,
      lastAttemptAt: row.lastAttemptAt as string | null,
      lastFailureReason: row.lastFailureReason as string | null,
    })
  })
  return Object.freeze({
    providers: Object.freeze(providers),
    epoch: record.epoch,
    secretSource: record.secretSource,
    secretValuesExposed: false as const,
    note: record.note,
  })
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

const WORKSPACE_RECORD_KEYS = ['workspace_id', 'root', 'project_id', 'base_revision', 'head_revision', 'generation'] as const
const WORKSPACE_CHECKOUT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u
const WORKSPACE_CHECKOUT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

function parseWorkspaceCheckout(value: unknown): WorkspaceCheckoutState {
  const record = exactObject(value, ['state', 'branch', 'commit', 'at_head_revision'])
  const { state, branch, commit, at_head_revision: atHeadRevision } = record
  if (state === 'branch') {
    if (typeof branch !== 'string' || !WORKSPACE_CHECKOUT_BRANCH.test(branch) || branch.includes('..') ||
        commit !== null || atHeadRevision !== null) return fail()
  } else if (state === 'detached') {
    if (branch !== null || typeof commit !== 'string' || !WORKSPACE_CHECKOUT_COMMIT.test(commit) ||
        typeof atHeadRevision !== 'boolean') return fail()
  } else if (state === 'unknown') {
    if (branch !== null || commit !== null || atHeadRevision !== null) return fail()
  } else {
    return fail()
  }
  return Object.freeze({
    state,
    branch: branch as string | null,
    commit: commit as string | null,
    at_head_revision: atHeadRevision as boolean | null,
  })
}

function parseWorkspaceRecord(value: unknown): WorkspaceRecord {
  // An older server sends only the identity; a current one may add the recorded
  // owner and the checkout's HEAD state, and then must send both.
  const extended = isRecord(value) && Object.hasOwn(value, 'owner_id')
  const record = exactObject(value, extended
    ? [...WORKSPACE_RECORD_KEYS, 'owner_id', 'checkout']
    : WORKSPACE_RECORD_KEYS)
  if (!workspaceText(record.workspace_id, 200) || !isCanonicalWorkspaceRoot(record.root)) return fail()
  if (record.project_id !== null && !workspaceText(record.project_id, MAX_PROJECT_ID_LENGTH)) return fail()
  if (record.base_revision !== null && !workspaceText(record.base_revision, 256)) return fail()
  if (record.head_revision !== null && !workspaceText(record.head_revision, 256)) return fail()
  if (typeof record.generation !== 'number' || !Number.isSafeInteger(record.generation) || record.generation < 1) return fail()
  if (extended && !workspaceText(record.owner_id, 200)) return fail()
  return Object.freeze({
    workspace_id: record.workspace_id,
    root: record.root,
    project_id: record.project_id,
    base_revision: record.base_revision,
    head_revision: record.head_revision,
    generation: record.generation,
    ...(extended ? { owner_id: record.owner_id as string, checkout: parseWorkspaceCheckout(record.checkout) } : {}),
  })
}

function parseWorkspaceFileEntry(value: unknown, parentPath: string): WorkspaceFileEntry {
  const record = exactObject(value, ['name', 'path', 'kind', 'size'])
  if (!workspaceFilePath(record.name, false) || record.name.includes('/') ||
      !workspaceFilePath(record.path, false) ||
      record.path !== (parentPath ? `${parentPath}/${record.name}` : record.name) ||
      (record.kind !== 'file' && record.kind !== 'directory') ||
      (record.kind === 'directory' && record.size !== null) ||
      (record.kind === 'file' && (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0))) return fail()
  return Object.freeze({ name: record.name, path: record.path, kind: record.kind, size: record.size }) as WorkspaceFileEntry
}

function parseTaskEvent(value: unknown): TaskEventRecord {
  const record = boundedJsonRecord(value)
  if (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 1) return fail()
  if (!validTaskId(record.task_id) || !boundedString(record.type, 128)) return fail()
  if (!boundedString(record.created_at, 128) || !Object.prototype.hasOwnProperty.call(record, 'data')) return fail()
  if (record.attempt_id !== null && !validTaskId(record.attempt_id)) return fail()
  return record as TaskEventRecord
}

function parseSessionMessage(value: unknown): SessionMessageRecord {
  const record = exactObject(value, ['id', 'role', 'content', 'kind', 'timestamp'])
  if (!boundedString(record.id, MAX_SESSION_MESSAGE_ID_LENGTH) || /[\u0001-\u001f\u007f-\u009f]/u.test(record.id)) return fail()
  if (typeof record.role !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(record.role)) return fail()
  if (typeof record.kind !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(record.kind)) return fail()
  if (typeof record.content !== 'string' || record.content.length > MAX_SESSION_MESSAGE_CONTENT_TOTAL) return fail()
  if (typeof record.timestamp !== 'number' || !Number.isSafeInteger(record.timestamp) || record.timestamp < 0) return fail()
  return Object.freeze({
    id: record.id,
    role: record.role,
    content: record.content,
    kind: record.kind,
    timestamp: record.timestamp,
  })
}

function parseComposerModelCatalog(value: unknown): ModelCatalogResult {
  const record = exactObject(value, ['current', 'fallback', 'providers', 'choices'])
  const current = exactObject(record.current, ['provider', 'model', 'base_url_configured'])
  if (current.provider !== null && (typeof current.provider !== 'string' || !MODEL_PROVIDER_ID.test(current.provider))) return fail()
  if (current.model !== null && (typeof current.model !== 'string' || !MODEL_ID.test(current.model))) return fail()
  if (typeof current.base_url_configured !== 'boolean') return fail()
  const fallback = record.fallback === null ? null : boundedJsonRecord(record.fallback)
  const offered = new Set<string>()
  const providers = readLocalArray(record.providers, MAX_MODEL_PROVIDERS).map((item) => {
    const provider = exactObject(item, ['id', 'models'])
    const id = provider.id
    if (typeof id !== 'string' || !MODEL_PROVIDER_ID.test(id)) return fail()
    const models = readLocalArray(provider.models, MAX_MODELS_PER_PROVIDER).map((model) => {
      if (typeof model !== 'string' || !MODEL_ID.test(model)) return fail()
      const key = `${id}\u0000${model}`
      if (offered.has(key)) return fail()
      offered.add(key)
      return model
    })
    return Object.freeze({ id, models: Object.freeze(models) })
  })
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) return fail()
  // Every choice must name a model that the providers list offers.
  const choices = readLocalArray(record.choices, MAX_MODEL_PROVIDERS * MAX_MODELS_PER_PROVIDER).map((item) => {
    const choice = exactObject(item, ['provider', 'model'])
    if (typeof choice.provider !== 'string' || typeof choice.model !== 'string' ||
        !offered.has(`${choice.provider}\u0000${choice.model}`)) return fail()
    return Object.freeze({ provider: choice.provider, model: choice.model })
  })
  return Object.freeze({
    current: Object.freeze({
      provider: current.provider as string | null,
      model: current.model as string | null,
      base_url_configured: current.base_url_configured,
    }),
    fallback,
    providers: Object.freeze(providers),
    choices: Object.freeze(choices),
  })
}

function parseAudioEngine(value: unknown): { available: boolean; provider: string } {
  const record = exactObject(value, ['available', 'provider'])
  if (typeof record.available !== 'boolean' || !workspaceText(record.provider, 128)) return fail()
  return Object.freeze({ available: record.available, provider: record.provider })
}

function parseAudioStatus(value: unknown): AudioStatusResult {
  const record = exactObject(value, ['available', 'stt', 'tts'])
  if (typeof record.available !== 'boolean') return fail()
  return Object.freeze({ available: record.available, stt: parseAudioEngine(record.stt), tts: parseAudioEngine(record.tts) })
}

function parseAudioTranscribeResult(value: unknown): AudioTranscribeResult {
  const record = exactObject(value, ['success', 'transcript', 'provider'])
  if (record.success !== true || !boundedString(record.transcript, MAX_AUDIO_TRANSCRIPT_LENGTH, true)) return fail()
  if (!workspaceText(record.provider, 128)) return fail()
  return Object.freeze({ success: true as const, transcript: record.transcript, provider: record.provider })
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
    case 'sessions.messages': {
      const record = exactObject(value, ['messages'])
      const messages = readLocalArray(record.messages, MAX_SESSION_MESSAGES).map(parseSessionMessage)
      let contentLength = 0
      for (const message of messages) {
        contentLength += message.content.length
        if (contentLength > MAX_SESSION_MESSAGE_CONTENT_TOTAL) return fail()
      }
      return Object.freeze({ messages: Object.freeze(messages) })
    }
    case 'sessions.delete': {
      const record = exactObject(value, ['ok', 'deleted'])
      if (record.ok !== true) return fail()
      const deleted = readLocalArray(record.deleted, MAX_SESSION_DELETE_IDS)
      if (deleted.length === 0 || !deleted.every(validSessionId) || new Set(deleted).size !== deleted.length) return fail()
      return Object.freeze({ ok: true, deleted: Object.freeze(deleted) })
    }
    case 'projects.create': {
      const record = exactObject(value, ['project'])
      return Object.freeze({ project: boundedJsonRecord(record.project) })
    }
    case 'workspaces.list': {
      const record = exactObject(value, ['workspaces'])
      if (!Array.isArray(record.workspaces) || record.workspaces.length > MAX_LIST_LIMIT) return fail()
      const list = parseBoundedJson(record.workspaces, { nodes: 0, estimatedBytes: 0, seen: new WeakSet<object>() })
      if (!Array.isArray(list)) return fail()
      return Object.freeze({ workspaces: Object.freeze(list.map(parseWorkspaceRecord)) })
    }
    case 'workspaces.get': {
      const record = exactObject(value, ['workspace'])
      return Object.freeze({ workspace: parseWorkspaceRecord(record.workspace) })
    }
    case 'workspaces.provision': {
      const record = exactObject(value, ['workspace'])
      return Object.freeze({ workspace: parseWorkspaceRecord(record.workspace) })
    }
    case 'projects.head': {
      const record = exactObject(value, ['revision'])
      if (typeof record.revision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(record.revision)) return fail()
      return Object.freeze({ revision: record.revision })
    }
    case 'workspaces.files.list': {
      const record = exactObject(value, ['path', 'entries', 'truncated'])
      if (!workspaceFilePath(record.path, true) || !Array.isArray(record.entries) ||
          record.entries.length > MAX_WORKSPACE_FILE_LIST_LIMIT || typeof record.truncated !== 'boolean') return fail()
      const entries = record.entries.map((entry) => parseWorkspaceFileEntry(entry, record.path as string))
      if (new Set(entries.map((entry) => entry.path)).size !== entries.length) return fail()
      return Object.freeze({ path: record.path, entries: Object.freeze(entries), truncated: record.truncated })
    }
    case 'workspaces.files.read': {
      const record = exactObject(value, ['path', 'content', 'truncated'])
      if (!workspaceFilePath(record.path, false) || !boundedString(record.content, MAX_WORKSPACE_FILE_READ_BYTES, true) ||
          typeof record.truncated !== 'boolean' || record.content.includes('\0')) return fail()
      return Object.freeze({ path: record.path, content: record.content, truncated: record.truncated })
    }
    case 'workspaces.files.diff': {
      const record = exactObject(value, ['path', 'diff', 'truncated'])
      if (!workspaceFilePath(record.path, false) || typeof record.diff !== 'string' ||
          new TextEncoder().encode(record.diff).byteLength > MAX_WORKSPACE_FILE_DIFF_BYTES ||
          record.diff.includes('\0') || typeof record.truncated !== 'boolean') return fail()
      return Object.freeze({ path: record.path, diff: record.diff, truncated: record.truncated })
    }
    case 'workspaces.files.search': {
      const record = exactObject(value, ['hits', 'files_scanned', 'bytes_scanned', 'truncated'])
      if (!Array.isArray(record.hits) || record.hits.length > MAX_WORKSPACE_SEARCH_HITS ||
          !Number.isSafeInteger(record.files_scanned) || (record.files_scanned as number) < 0 ||
          (record.files_scanned as number) > MAX_WORKSPACE_SEARCH_FILES ||
          !Number.isSafeInteger(record.bytes_scanned) || (record.bytes_scanned as number) < 0 ||
          (record.bytes_scanned as number) > MAX_WORKSPACE_SEARCH_BYTES || typeof record.truncated !== 'boolean') return fail()
      const hits = record.hits.map((hit) => {
        const parsed = exactObject(hit, ['path', 'line'])
        if (!workspaceSearchPath(parsed.path) || !Number.isSafeInteger(parsed.line) ||
            (parsed.line as number) < 1) return fail()
        return Object.freeze({ path: parsed.path, line: parsed.line as number })
      })
      return Object.freeze({
        hits: Object.freeze(hits),
        files_scanned: record.files_scanned as number,
        bytes_scanned: record.bytes_scanned as number,
        truncated: record.truncated,
      })
    }
    case 'workspaces.files.write':
    case 'workspaces.files.create': {
      const record = exactObject(value, ['path', 'content'])
      if (!workspaceFilePath(record.path, false) || !workspaceFileWriteText(record.content)) return fail()
      return Object.freeze({ path: record.path, content: record.content })
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
    case 'secrets.authStates':
      return parseSecretAuthStates(value)
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
    // Operations pages
    case 'status.get':
      return parseStatusSnapshot(value)
    case 'logs.list': {
      const record = exactObject(value, ['logs'])
      return Object.freeze({ logs: Object.freeze(readLocalArray(record.logs, MAX_OPS_LOG_ROWS).map(parseLogEntry)) })
    }
    case 'models.list':
    case 'models.setDefault':
      return parseModelCatalog(value)
    case 'skills.list': {
      const record = exactObject(value, ['skills'])
      return Object.freeze({ skills: Object.freeze(readLocalArray(record.skills, MAX_OPS_SKILLS).map((item) => parseSkillRecord(item, false))) })
    }
    case 'skills.get':
      return parseSkillRecord(value, true)
    case 'skills.toggle':
      return parseSkillRecord(value, false)
    case 'cron.list': {
      const record = exactObject(value, ['jobs'])
      return Object.freeze({ jobs: parseCronJobs(record.jobs) })
    }
    case 'cron.create':
    case 'cron.update':
    case 'cron.action': {
      const record = exactObject(value, ['ok', 'output', 'jobs'])
      if (record.ok !== true) return fail()
      return Object.freeze({ ok: true as const, output: opsCommandOutput(record.output), jobs: parseCronJobs(record.jobs) })
    }
    case 'backups.list': {
      const record = exactObject(value, ['backups'])
      return Object.freeze({ backups: parseBackupRecords(record.backups) })
    }
    case 'backups.create': {
      const record = exactObject(value, ['ok', 'output', 'backups'])
      if (record.ok !== true) return fail()
      return Object.freeze({ ok: true as const, output: opsCommandOutput(record.output), backups: parseBackupRecords(record.backups) })
    }
    case 'backups.schedule.get':
      return parseBackupSchedule(value)
    case 'backups.schedule.set': {
      const record = exactObject(value, ['calendar', 'updated'])
      if (!opsBackupCalendar(record.calendar) || record.updated !== true) return fail()
      return Object.freeze({ calendar: record.calendar, updated: true as const })
    }
    case 'backups.inspect': {
      const record = exactObject(value, ['source', 'contents'])
      if (!isCanonicalAbsolutePath(record.source) || record.source.length > MAX_OPS_PATH_LENGTH) return fail()
      return Object.freeze({ source: record.source, contents: opsCommandOutput(record.contents) })
    }
    case 'backups.restore': {
      const record = exactObject(value, ['ok', 'output'])
      if (record.ok !== true) return fail()
      return Object.freeze({ ok: true as const, output: opsCommandOutput(record.output) })
    }
    // Composer
    case 'models.catalog':
      return parseComposerModelCatalog(value)
    case 'audio.status':
      return parseAudioStatus(value)
    case 'audio.transcribe':
      return parseAudioTranscribeResult(value)
    // Server files (ARCHON_ROOT)
    case 'files.list':
    case 'files.read':
    case 'files.writeText':
    case 'files.mkdir':
    case 'files.rename':
    case 'files.copy':
    case 'files.pickUpload':
    case 'files.upload':
    case 'files.download':
    case 'files.delete':
      return parseServerFileOperationResponse(operation, value)
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

function parseLocalWorkspacePayload(value: unknown): { workspaceId: string } {
  const record = exactObject(value, ['workspaceId'])
  if (!workspaceFileId(record.workspaceId)) return fail()
  return Object.freeze({ workspaceId: record.workspaceId })
}

function parseLocalTaskPayload(value: unknown): { taskId: string } {
  const record = exactObject(value, ['taskId'])
  if (!isLocalTaskId(record.taskId)) return fail()
  return Object.freeze({ taskId: record.taskId })
}

function parseLocalTurnStatus(value: unknown): LocalCodexTurnStatusDto {
  const record = exactObject(value, ['taskId', 'projectId', 'sessionId', 'state'])
  if (!isLocalTaskId(record.taskId) || !isLocalProjectId(record.projectId) || !isLocalSessionId(record.sessionId)
    || typeof record.state !== 'string'
    || !['running', 'completed', 'cancelled', 'failed', 'outcome_unknown'].includes(record.state)) return fail()
  return Object.freeze({
    taskId: record.taskId,
    projectId: record.projectId,
    sessionId: record.sessionId,
    state: record.state as LocalCodexTurnStatusDto['state'],
  })
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

const MAX_WORKSPACE_CONSOLE_TERMINALS = 16
const MAX_WORKSPACE_CONSOLE_SCREEN_BYTES = 24 * 1024
const MAX_WORKSPACE_CONSOLE_LINE_BYTES = 4096
const MAX_WORKSPACE_CONSOLE_ATTACH_EVENTS = 32
const MAX_WORKSPACE_CONSOLE_ATTACH_BYTES = 1024
const WORKSPACE_CONSOLE_NAMED_KEYS = new Set<string>([
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'BSpace', 'Tab', 'BTab', 'DC', 'IC', 'Escape', 'Enter', 'Space',
  'C-c', 'C-d', 'C-z', 'C-l', 'C-a', 'C-e', 'C-u', 'C-k', 'C-w',
])
const MAX_WORKSPACE_SERVICES = 8
const MAX_WORKSPACE_SERVICE_ARGV = 32
const MAX_WORKSPACE_SERVICE_ARG_LENGTH = 1024
const MAX_WORKSPACE_SERVICE_PORTS = 4
const MAX_WORKSPACE_SERVICE_ENV = 16
const MAX_WORKSPACE_SERVICE_DEPENDS = 4
const MAX_WORKSPACE_SERVICE_LOGS_BYTES = 16 * 1024
const WORKSPACE_SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/u
const WORKSPACE_SERVICE_PORT_NAME = /^[a-z][a-z0-9-]{0,15}$/u
const WORKSPACE_SERVICE_ENV_REFS = new Set<string>(['NODE_ENV', 'PYTHONUNBUFFERED'])
const WORKSPACE_SERVICE_STATES = new Set<string>(['registered', 'starting', 'running', 'stopped', 'exited', 'failed'])
const WORKSPACE_SERVICE_HEALTH = new Set<string>(['unknown', 'starting', 'healthy', 'unhealthy'])
const MAX_WORKSPACE_PREVIEW_COORDINATE = 20000

function workspacePreviewBounds(value: unknown): { x: number; y: number; width: number; height: number } {
  const record = exactObject(value, ['x', 'y', 'width', 'height'])
  const numbers = ['x', 'y', 'width', 'height'].map((key) => record[key])
  if (numbers.some((item) => typeof item !== 'number' || !Number.isInteger(item))) return fail()
  const [x, y, width, height] = numbers as number[]
  if (Math.abs(x) > MAX_WORKSPACE_PREVIEW_COORDINATE || Math.abs(y) > MAX_WORKSPACE_PREVIEW_COORDINATE
    || width < 1 || height < 1 || width > MAX_WORKSPACE_PREVIEW_COORDINATE || height > MAX_WORKSPACE_PREVIEW_COORDINATE) return fail()
  return Object.freeze({ x, y, width, height })
}

/** Validate fixed preview IPC input before main opens the native preview view. */
export function parseWorkspacePreviewRequest(channel: unknown, args: readonly unknown[]): Readonly<Record<string, unknown>> {
  const safeArgs = readLocalArray(args, 1)
  if (safeArgs.length !== 1 || !Object.values(WORKSPACE_PREVIEW_CHANNELS).includes(channel as WorkspacePreviewInvokeChannel)) return fail()
  const value = safeArgs[0]
  switch (channel) {
    case WORKSPACE_PREVIEW_CHANNELS.open: {
      const record = exactObject(value, ['workspaceId', 'name', 'expectedGeneration', 'portName', 'bounds'])
      if (!workspaceFileId(record.workspaceId) || typeof record.expectedGeneration !== 'number'
        || !Number.isSafeInteger(record.expectedGeneration) || record.expectedGeneration < 1) return fail()
      if (record.portName !== null && (typeof record.portName !== 'string' || !/^[a-z][a-z0-9-]{0,15}$/u.test(record.portName))) return fail()
      return Object.freeze({
        workspaceId: record.workspaceId,
        name: workspaceServiceName(record.name),
        expectedGeneration: record.expectedGeneration,
        portName: record.portName as string | null,
        bounds: workspacePreviewBounds(record.bounds),
      })
    }
    case WORKSPACE_PREVIEW_CHANNELS.bounds:
      return Object.freeze({ bounds: workspacePreviewBounds(value) })
    case WORKSPACE_PREVIEW_CHANNELS.close:
      if (value !== undefined && value !== null && Object.keys(value as object).length !== 0) return fail()
      return Object.freeze({})
    default:
      return fail()
  }
}

/** Normalize preview results returned by the main process. */
export function parseWorkspacePreviewResponse(channel: unknown, value: unknown): unknown {
  switch (channel) {
    case WORKSPACE_PREVIEW_CHANNELS.open: {
      const record = exactObject(value, ['ticket', 'url', 'mode', 'expiresAt'])
      if (typeof record.ticket !== 'string' || !/^wprev-[0-9a-f]{32}$/u.test(record.ticket)) return fail()
      if (typeof record.url !== 'string' || record.url.length > 2048
        || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\/local\/preview\//u.test(record.url)) return fail()
      if (record.mode !== 'read-only') return fail()
      if (typeof record.expiresAt !== 'string' || record.expiresAt.length > 64 || !Number.isFinite(Date.parse(record.expiresAt))) return fail()
      return Object.freeze({ ticket: record.ticket, url: record.url, mode: 'read-only' as const, expiresAt: record.expiresAt })
    }
    case WORKSPACE_PREVIEW_CHANNELS.bounds:
    case WORKSPACE_PREVIEW_CHANNELS.close:
      if (value !== true) return fail()
      return true
    default:
      return fail()
  }
}

export const MAX_BROWSER_URL_LENGTH = 2048
export const MAX_BROWSER_TITLE_LENGTH = 300
export const MAX_BROWSER_ERROR_LENGTH = 200
const BROWSER_URL_FORBIDDEN = /[\u0000-\u0020\u007f-\u009f]/u

/**
 * The only addresses the in-app browser may load or navigate to: bounded,
 * absolute http(s) URLs with a host and no embedded credentials. Returns the
 * canonical href, or null for anything else (javascript:, file:, data:, blob:…).
 */
export function browserHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BROWSER_URL_LENGTH) return null
  if (BROWSER_URL_FORBIDDEN.test(value)) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null
  if (parsed.username || parsed.password) return null
  const href = parsed.href
  return href.length <= MAX_BROWSER_URL_LENGTH ? href : null
}

function browserUrlField(value: unknown): string {
  return browserHttpUrl(value) ?? fail()
}

function emptyBrowserArgument(value: unknown): Readonly<Record<string, never>> {
  if (value !== undefined) exactObject(value, [])
  return Object.freeze({})
}

/** Validate fixed browser IPC input; main re-validates every URL it is given. */
export function parseBrowserRequest(channel: unknown, args: readonly unknown[]): Readonly<Record<string, unknown>> {
  const safeArgs = readLocalArray(args, 1)
  if (safeArgs.length !== 1 || channel === BROWSER_CHANNELS.state
    || !Object.values(BROWSER_CHANNELS).includes(channel as BrowserInvokeChannel)) return fail()
  const value = safeArgs[0]
  switch (channel) {
    case BROWSER_CHANNELS.open: {
      const record = exactObject(value, ['url', 'bounds'])
      return Object.freeze({ url: browserUrlField(record.url), bounds: workspacePreviewBounds(record.bounds) })
    }
    case BROWSER_CHANNELS.navigate:
    case BROWSER_CHANNELS.openExternal: {
      const record = exactObject(value, ['url'])
      return Object.freeze({ url: browserUrlField(record.url) })
    }
    case BROWSER_CHANNELS.bounds:
      return Object.freeze({ bounds: workspacePreviewBounds(value) })
    case BROWSER_CHANNELS.back:
    case BROWSER_CHANNELS.forward:
    case BROWSER_CHANNELS.reload:
    case BROWSER_CHANNELS.close:
      return emptyBrowserArgument(value)
    default:
      return fail()
  }
}

/** Validate one browser view state before it crosses to the renderer. */
export function parseBrowserState(value: unknown): BrowserViewState {
  const record = exactObject(value, ['open', 'url', 'title', 'canGoBack', 'canGoForward', 'loading', 'error'])
  if (typeof record.open !== 'boolean' || typeof record.canGoBack !== 'boolean'
    || typeof record.canGoForward !== 'boolean' || typeof record.loading !== 'boolean') return fail()
  if (record.url !== '' && browserHttpUrl(record.url) === null) return fail()
  if (typeof record.title !== 'string' || record.title.length > MAX_BROWSER_TITLE_LENGTH) return fail()
  if (record.error !== null && (typeof record.error !== 'string' || record.error.length > MAX_BROWSER_ERROR_LENGTH)) return fail()
  return Object.freeze({
    open: record.open,
    url: record.url as string,
    title: record.title,
    canGoBack: record.canGoBack,
    canGoForward: record.canGoForward,
    loading: record.loading,
    error: record.error as string | null,
  })
}

/** Normalize browser results returned by the main process. */
export function parseBrowserResponse(channel: unknown, value: unknown): unknown {
  switch (channel) {
    case BROWSER_CHANNELS.open:
    case BROWSER_CHANNELS.navigate:
    case BROWSER_CHANNELS.back:
    case BROWSER_CHANNELS.forward:
    case BROWSER_CHANNELS.reload:
      return parseBrowserState(value)
    case BROWSER_CHANNELS.bounds:
    case BROWSER_CHANNELS.close:
    case BROWSER_CHANNELS.openExternal:
      if (typeof value !== 'boolean') return fail()
      return value
    default:
      return fail()
  }
}

function workspaceServiceName(value: unknown): string {
  if (typeof value !== 'string' || !WORKSPACE_SERVICE_NAME.test(value)) return fail()
  return value
}

function parseWorkspaceServicePorts(value: unknown): readonly WorkspaceServicePortDto[] {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_SERVICE_PORTS) return fail()
  return Object.freeze(value.map((item) => {
    // A declared target is either a loopback TCP port or a private unix socket the
    // server bound; the socket form only ever arrives from the server.
    if (typeof item !== 'object' || item === null || Array.isArray(item)
      || !('unixSocket' in (item as Record<string, unknown>))) {
      const port = exactObject(item, ['name', 'port'])
      if (typeof port.name !== 'string' || !WORKSPACE_SERVICE_PORT_NAME.test(port.name)
        || typeof port.port !== 'number' || !Number.isInteger(port.port) || port.port < 1 || port.port > 65535) return fail()
      return Object.freeze({ name: port.name, port: port.port })
    }
    const socket = exactObject(item, ['name', 'unixSocket'])
    if (typeof socket.name !== 'string' || !WORKSPACE_SERVICE_PORT_NAME.test(socket.name)) return fail()
    if (typeof socket.unixSocket !== 'string' || !socket.unixSocket.startsWith('/')
      || socket.unixSocket.length > 512 || /[\u0000-\u001f\u007f]/u.test(socket.unixSocket)) return fail()
    return Object.freeze({ name: socket.name, unixSocket: socket.unixSocket })
  }))
}

const WORKSPACE_SERVICE_CONTROL_DEFAULTS = Object.freeze({
  cpuQuotaPercent: null, tasksMax: null, filesystemIsolation: 'none', networkIsolation: 'host',
})

function parseWorkspaceServiceDefinition(value: unknown): ResolvedWorkspaceServiceDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail()
  // Resource and isolation controls are optional for older callers and default
  // to the uncontrolled profile, so an omitted field never implies enforcement.
  const record = exactObject(
    { ...WORKSPACE_SERVICE_CONTROL_DEFAULTS, ...(value as Record<string, unknown>) },
    ['name', 'argv', 'cwd', 'env', 'ports', 'health', 'dependsOn', 'restart', 'memoryLimitMb',
      'cpuQuotaPercent', 'tasksMax', 'filesystemIsolation', 'networkIsolation'],
  )
  const name = workspaceServiceName(record.name)
  if (!Array.isArray(record.argv) || record.argv.length < 1 || record.argv.length > MAX_WORKSPACE_SERVICE_ARGV) return fail()
  const argv = Object.freeze(record.argv.map((item) => {
    if (typeof item !== 'string' || !item || item.length > MAX_WORKSPACE_SERVICE_ARG_LENGTH || /[\u0000-\u001f\u007f]/u.test(item)) return fail()
    return item
  }))
  if (typeof record.cwd !== 'string' || !record.cwd || record.cwd.length > 512 || record.cwd.startsWith('/')
    || /[\u0000-\u001f]/u.test(record.cwd)) return fail()
  if (!Array.isArray(record.env) || record.env.length > MAX_WORKSPACE_SERVICE_ENV) return fail()
  const env = Object.freeze(record.env.map((item) => {
    if (typeof item !== 'string' || !WORKSPACE_SERVICE_ENV_REFS.has(item)) return fail()
    return item
  }))
  const ports = parseWorkspaceServicePorts(record.ports)
  let health: { port: string; path: string } | null = null
  if (record.health !== null) {
    const candidate = exactObject(record.health, ['port', 'path'])
    if (typeof candidate.port !== 'string' || !WORKSPACE_SERVICE_PORT_NAME.test(candidate.port)) return fail()
    if (typeof candidate.path !== 'string' || !candidate.path.startsWith('/') || candidate.path.length > 256
      || /[\u0000-\u001f]/u.test(candidate.path)) return fail()
    health = Object.freeze({ port: candidate.port, path: candidate.path })
  }
  if (!Array.isArray(record.dependsOn) || record.dependsOn.length > MAX_WORKSPACE_SERVICE_DEPENDS) return fail()
  const dependsOn = Object.freeze(record.dependsOn.map((item) => workspaceServiceName(item)))
  if (record.restart !== 'never' && record.restart !== 'on-failure') return fail()
  if (record.memoryLimitMb !== null && (typeof record.memoryLimitMb !== 'number'
    || !Number.isInteger(record.memoryLimitMb) || record.memoryLimitMb < 16 || record.memoryLimitMb > 65536)) return fail()
  if (record.cpuQuotaPercent !== null && (typeof record.cpuQuotaPercent !== 'number'
    || !Number.isInteger(record.cpuQuotaPercent) || record.cpuQuotaPercent < 1 || record.cpuQuotaPercent > 1600)) return fail()
  if (record.tasksMax !== null && (typeof record.tasksMax !== 'number'
    || !Number.isInteger(record.tasksMax) || record.tasksMax < 4 || record.tasksMax > 4096)) return fail()
  if (record.filesystemIsolation !== 'none' && record.filesystemIsolation !== 'workspace-only') return fail()
  if (record.networkIsolation !== 'host' && record.networkIsolation !== 'isolated') return fail()
  if (record.networkIsolation === 'isolated'
    && ((record.ports as readonly unknown[]).length > 0 || record.health !== null)) {
    // An isolated service has no network, so a declared port or health target
    // could never answer; refuse it here rather than let the server reject it.
    return fail()
  }
  return Object.freeze({
    name, argv, cwd: record.cwd, env, ports, health, dependsOn,
    restart: record.restart, memoryLimitMb: record.memoryLimitMb as number | null,
    cpuQuotaPercent: record.cpuQuotaPercent as number | null,
    tasksMax: record.tasksMax as number | null,
    filesystemIsolation: record.filesystemIsolation as ResolvedWorkspaceServiceDefinition['filesystemIsolation'],
    networkIsolation: record.networkIsolation as ResolvedWorkspaceServiceDefinition['networkIsolation'],
  }) satisfies WorkspaceServiceDefinitionInput
}

function parseWorkspaceServiceDto(value: unknown): WorkspaceServiceDto {
  const record = exactObject(value, [
    'name', 'argv', 'cwd', 'ports', 'restart', 'state', 'exitCode', 'restarts', 'health',
    'memoryLimitMb', 'cpuQuotaPercent', 'tasksMax', 'filesystemIsolation', 'networkIsolation',
  ])
  const name = workspaceServiceName(record.name)
  if (!Array.isArray(record.argv)
    || record.argv.some((item) => typeof item !== 'string' || item.length > MAX_WORKSPACE_SERVICE_ARG_LENGTH)) return fail()
  if (typeof record.cwd !== 'string' || record.cwd.length > 512) return fail()
  const ports = parseWorkspaceServicePorts(record.ports)
  if (record.restart !== 'never' && record.restart !== 'on-failure') return fail()
  if (typeof record.state !== 'string' || !WORKSPACE_SERVICE_STATES.has(record.state)) return fail()
  if (record.exitCode !== null && (typeof record.exitCode !== 'number' || !Number.isInteger(record.exitCode))) return fail()
  if (typeof record.restarts !== 'number' || !Number.isInteger(record.restarts) || record.restarts < 0) return fail()
  if (typeof record.health !== 'string' || !WORKSPACE_SERVICE_HEALTH.has(record.health)) return fail()
  if (record.memoryLimitMb !== null && (typeof record.memoryLimitMb !== 'number'
    || !Number.isInteger(record.memoryLimitMb) || record.memoryLimitMb < 16 || record.memoryLimitMb > 65536)) return fail()
  if (record.cpuQuotaPercent !== null && (typeof record.cpuQuotaPercent !== 'number'
    || !Number.isInteger(record.cpuQuotaPercent) || record.cpuQuotaPercent < 1 || record.cpuQuotaPercent > 1600)) return fail()
  if (record.tasksMax !== null && (typeof record.tasksMax !== 'number'
    || !Number.isInteger(record.tasksMax) || record.tasksMax < 4 || record.tasksMax > 4096)) return fail()
  if (record.filesystemIsolation !== 'none' && record.filesystemIsolation !== 'workspace-only') return fail()
  if (record.networkIsolation !== 'host' && record.networkIsolation !== 'isolated') return fail()
  return Object.freeze({
    name, argv: Object.freeze(record.argv as string[]), cwd: record.cwd, ports,
    restart: record.restart, state: record.state as WorkspaceServiceDto['state'],
    exitCode: record.exitCode as number | null, restarts: record.restarts,
    health: record.health as WorkspaceServiceDto['health'],
    memoryLimitMb: record.memoryLimitMb as number | null,
    cpuQuotaPercent: record.cpuQuotaPercent as number | null,
    tasksMax: record.tasksMax as number | null,
    filesystemIsolation: record.filesystemIsolation as WorkspaceServiceDto['filesystemIsolation'],
    networkIsolation: record.networkIsolation as WorkspaceServiceDto['networkIsolation'],
  })
}

function parseWorkspaceConsoleTerminal(value: unknown): WorkspaceConsoleTerminalDto {
  const record = exactObject(value, ['sessionId', 'state', 'createdAt'])
  if (typeof record.sessionId !== 'string' || !/^wterm-[0-9a-f]{32}$/u.test(record.sessionId)
    || (record.state !== 'starting' && record.state !== 'running')
    || typeof record.createdAt !== 'string' || record.createdAt.length > 64
    || !Number.isFinite(Date.parse(record.createdAt))) return fail()
  return Object.freeze({ sessionId: record.sessionId, state: record.state, createdAt: record.createdAt })
}

/** Validate one normalized attach stream frame before it reaches the renderer. */
export function parseWorkspaceConsoleEvent(value: unknown): WorkspaceConsoleAttachEventDto {
  const record = exactObject(value, ['attachId', 'text', 'truncated'])
  if (typeof record.attachId !== 'string' || !/^watt-[0-9a-f]{32}$/u.test(record.attachId)) return fail()
  if (typeof record.text !== 'string'
    || new TextEncoder().encode(record.text).byteLength > MAX_WORKSPACE_CONSOLE_SCREEN_BYTES) return fail()
  if (typeof record.truncated !== 'boolean') return fail()
  return Object.freeze({ attachId: record.attachId, text: record.text, truncated: record.truncated })
}

function parseWorkspaceConsoleAttachTicket(value: unknown): WorkspaceConsoleAttachTicketDto {
  const record = exactObject(value, ['ticket', 'mode', 'expiresAt'])
  if (typeof record.ticket !== 'string' || !/^watt-[0-9a-f]{32}$/u.test(record.ticket)
    || (record.mode !== 'control' && record.mode !== 'read-only')
    || typeof record.expiresAt !== 'string' || record.expiresAt.length > 64
    || !Number.isFinite(Date.parse(record.expiresAt))) return fail()
  return Object.freeze({ ticket: record.ticket, mode: record.mode, expiresAt: record.expiresAt })
}

function parseWorkspaceConsoleAttachLease(value: unknown): WorkspaceConsoleAttachLeaseDto {
  const record = exactObject(value, ['attachId', 'mode', 'expiresAt'])
  if (typeof record.attachId !== 'string' || !/^watt-[0-9a-f]{32}$/u.test(record.attachId)
    || (record.mode !== 'control' && record.mode !== 'read-only')
    || typeof record.expiresAt !== 'string' || record.expiresAt.length > 64
    || !Number.isFinite(Date.parse(record.expiresAt))) return fail()
  return Object.freeze({ attachId: record.attachId, mode: record.mode, expiresAt: record.expiresAt })
}

function workspaceConsoleKeyEvents(value: unknown): readonly WorkspaceConsoleKeyEvent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WORKSPACE_CONSOLE_ATTACH_EVENTS) return fail()
  let total = 0
  const events = value.map((item) => {
    const event = exactObject(item, ['type', 'value'])
    if (event.type === 'text') {
      if (typeof event.value !== 'string' || event.value.length === 0
        || /[\u0000-\u001f\u007f]/u.test(event.value)) return fail()
      total += new TextEncoder().encode(event.value).byteLength
      if (total > MAX_WORKSPACE_CONSOLE_ATTACH_BYTES) return fail()
      return Object.freeze({ type: 'text' as const, value: event.value })
    }
    if (event.type === 'key') {
      if (typeof event.value !== 'string' || !WORKSPACE_CONSOLE_NAMED_KEYS.has(event.value)) return fail()
      return Object.freeze({ type: 'key' as const, value: event.value as WorkspaceConsoleNamedKey })
    }
    return fail()
  })
  return Object.freeze(events)
}

function workspaceConsoleInput(channel: unknown, value: unknown): Record<string, unknown> {
  switch (channel) {
    case WORKSPACE_CONSOLE_CHANNELS.list: {
      const record = exactObject(value, ['workspaceId'])
      if (!workspaceFileId(record.workspaceId)) return fail()
      return { workspaceId: record.workspaceId }
    }
    case WORKSPACE_CONSOLE_CHANNELS.create: {
      const record = exactObject(value, ['workspaceId', 'expectedGeneration'])
      if (!workspaceFileId(record.workspaceId) || typeof record.expectedGeneration !== 'number'
        || !Number.isSafeInteger(record.expectedGeneration) || record.expectedGeneration < 1) return fail()
      return { workspaceId: record.workspaceId, expectedGeneration: record.expectedGeneration }
    }
    case WORKSPACE_CONSOLE_CHANNELS.screen:
    case WORKSPACE_CONSOLE_CHANNELS.stop:
    case WORKSPACE_CONSOLE_CHANNELS.interrupt:
    case WORKSPACE_CONSOLE_CHANNELS.sendLine: {
      const allowed = channel === WORKSPACE_CONSOLE_CHANNELS.screen ? ['workspaceId', 'sessionId', 'lines']
        : channel === WORKSPACE_CONSOLE_CHANNELS.sendLine ? ['workspaceId', 'sessionId', 'line']
          : ['workspaceId', 'sessionId']
      const record = exactObject(value, allowed)
      if (!workspaceFileId(record.workspaceId) || typeof record.sessionId !== 'string'
        || !/^wterm-[0-9a-f]{32}$/u.test(record.sessionId)) return fail()
      if (channel === WORKSPACE_CONSOLE_CHANNELS.screen) {
        if (typeof record.lines !== 'number' || !Number.isInteger(record.lines) || record.lines < 1 || record.lines > 120) return fail()
        return { workspaceId: record.workspaceId, sessionId: record.sessionId, lines: record.lines }
      }
      if (channel === WORKSPACE_CONSOLE_CHANNELS.sendLine) {
        if (typeof record.line !== 'string' || record.line.length === 0 || /[\u0000-\u001f\u007f]/u.test(record.line)
          || new TextEncoder().encode(record.line).byteLength > MAX_WORKSPACE_CONSOLE_LINE_BYTES) return fail()
        return { workspaceId: record.workspaceId, sessionId: record.sessionId, line: record.line }
      }
      return { workspaceId: record.workspaceId, sessionId: record.sessionId }
    }
    case WORKSPACE_CONSOLE_CHANNELS.attachOpen: {
      const record = exactObject(value, ['workspaceId', 'sessionId', 'expectedGeneration', 'mode'])
      if (!workspaceFileId(record.workspaceId) || typeof record.sessionId !== 'string'
        || !/^wterm-[0-9a-f]{32}$/u.test(record.sessionId)
        || typeof record.expectedGeneration !== 'number' || !Number.isSafeInteger(record.expectedGeneration)
        || record.expectedGeneration < 1
        || (record.mode !== 'control' && record.mode !== 'read-only')) return fail()
      return {
        workspaceId: record.workspaceId, sessionId: record.sessionId,
        expectedGeneration: record.expectedGeneration, mode: record.mode,
      }
    }
    case WORKSPACE_CONSOLE_CHANNELS.attachClaim:
    case WORKSPACE_CONSOLE_CHANNELS.attachScreen:
    case WORKSPACE_CONSOLE_CHANNELS.attachWatch:
    case WORKSPACE_CONSOLE_CHANNELS.attachInput:
    case WORKSPACE_CONSOLE_CHANNELS.attachDetach:
    case WORKSPACE_CONSOLE_CHANNELS.attachUnwatch: {
      const allowed = channel === WORKSPACE_CONSOLE_CHANNELS.attachScreen || channel === WORKSPACE_CONSOLE_CHANNELS.attachWatch
        ? ['workspaceId', 'sessionId', 'attachId', 'lines']
        : channel === WORKSPACE_CONSOLE_CHANNELS.attachInput ? ['workspaceId', 'sessionId', 'attachId', 'events']
          : ['workspaceId', 'sessionId', channel === WORKSPACE_CONSOLE_CHANNELS.attachClaim ? 'ticket' : 'attachId']
      const record = exactObject(value, allowed)
      if (!workspaceFileId(record.workspaceId) || typeof record.sessionId !== 'string'
        || !/^wterm-[0-9a-f]{32}$/u.test(record.sessionId)) return fail()
      if (channel === WORKSPACE_CONSOLE_CHANNELS.attachClaim) {
        if (typeof record.ticket !== 'string' || !/^watt-[0-9a-f]{32}$/u.test(record.ticket)) return fail()
        return { workspaceId: record.workspaceId, sessionId: record.sessionId, ticket: record.ticket }
      }
      if (typeof record.attachId !== 'string' || !/^watt-[0-9a-f]{32}$/u.test(record.attachId)) return fail()
      if (channel === WORKSPACE_CONSOLE_CHANNELS.attachScreen || channel === WORKSPACE_CONSOLE_CHANNELS.attachWatch) {
        if (typeof record.lines !== 'number' || !Number.isInteger(record.lines) || record.lines < 1 || record.lines > 120) return fail()
        return { workspaceId: record.workspaceId, sessionId: record.sessionId, attachId: record.attachId, lines: record.lines }
      }
      if (channel === WORKSPACE_CONSOLE_CHANNELS.attachInput) {
        return {
          workspaceId: record.workspaceId, sessionId: record.sessionId,
          attachId: record.attachId, events: workspaceConsoleKeyEvents(record.events),
        }
      }
      return { workspaceId: record.workspaceId, sessionId: record.sessionId, attachId: record.attachId }
    }
    default:
      return fail()
  }
}

/** Validate fixed console IPC input before main forwards it to the owner-only API. */
export function parseWorkspaceConsoleRequest(channel: unknown, args: readonly unknown[]): Readonly<Record<string, unknown>> {
  const safeArgs = readLocalArray(args, 1)
  if (safeArgs.length !== 1 || !Object.values(WORKSPACE_CONSOLE_CHANNELS).includes(channel as WorkspaceConsoleInvokeChannel)) return fail()
  return Object.freeze(workspaceConsoleInput(channel, safeArgs[0]))
}

/** Normalize only the documented backend envelopes before they cross into the renderer. */
export function parseWorkspaceConsoleBackendResponse(channel: unknown, value: unknown): unknown {
  switch (channel) {
    case WORKSPACE_CONSOLE_CHANNELS.list: {
      const record = exactObject(value, ['terminals'])
      if (!Array.isArray(record.terminals) || record.terminals.length > MAX_WORKSPACE_CONSOLE_TERMINALS) return fail()
      const terminals = record.terminals.map(parseWorkspaceConsoleTerminal)
      if (new Set(terminals.map((terminal) => terminal.sessionId)).size !== terminals.length) return fail()
      return Object.freeze(terminals)
    }
    case WORKSPACE_CONSOLE_CHANNELS.create: {
      const record = exactObject(value, ['terminal'])
      return parseWorkspaceConsoleTerminal(record.terminal)
    }
    case WORKSPACE_CONSOLE_CHANNELS.screen:
    case WORKSPACE_CONSOLE_CHANNELS.attachScreen: {
      const record = exactObject(value, ['text', 'truncated'])
      if (typeof record.text !== 'string' || new TextEncoder().encode(record.text).byteLength > MAX_WORKSPACE_CONSOLE_SCREEN_BYTES
        || typeof record.truncated !== 'boolean') return fail()
      return Object.freeze({ text: record.text, truncated: record.truncated }) satisfies WorkspaceConsoleScreenDto
    }
    case WORKSPACE_CONSOLE_CHANNELS.attachOpen:
      return parseWorkspaceConsoleAttachTicket(exactObject(value, ['attachment']).attachment)
    case WORKSPACE_CONSOLE_CHANNELS.attachClaim:
      return parseWorkspaceConsoleAttachLease(exactObject(value, ['attachment']).attachment)
    case WORKSPACE_CONSOLE_CHANNELS.sendLine: {
      const record = exactObject(value, ['sent'])
      if (record.sent !== true) return fail()
      return true
    }
    case WORKSPACE_CONSOLE_CHANNELS.attachInput: {
      const record = exactObject(value, ['sent'])
      if (record.sent !== true) return fail()
      return true
    }
    case WORKSPACE_CONSOLE_CHANNELS.attachDetach: {
      const record = exactObject(value, ['ok'])
      if (record.ok !== true) return fail()
      return true
    }
    case WORKSPACE_CONSOLE_CHANNELS.stop: {
      const record = exactObject(value, ['ok'])
      if (record.ok !== true) return fail()
      return true
    }
    case WORKSPACE_CONSOLE_CHANNELS.interrupt: {
      const record = exactObject(value, ['sent'])
      if (record.sent !== true) return fail()
      return true
    }
    default:
      return fail()
  }
}

/** Validate normalized console results returned by the preload bridge. */
export function parseWorkspaceConsoleResponse(channel: unknown, value: unknown): unknown {
  switch (channel) {
    case WORKSPACE_CONSOLE_CHANNELS.list:
      return parseWorkspaceConsoleBackendResponse(channel, { terminals: value })
    case WORKSPACE_CONSOLE_CHANNELS.create:
      return parseWorkspaceConsoleBackendResponse(channel, { terminal: value })
    case WORKSPACE_CONSOLE_CHANNELS.screen:
    case WORKSPACE_CONSOLE_CHANNELS.attachScreen:
      return parseWorkspaceConsoleBackendResponse(channel, value)
    case WORKSPACE_CONSOLE_CHANNELS.sendLine:
    case WORKSPACE_CONSOLE_CHANNELS.interrupt:
    case WORKSPACE_CONSOLE_CHANNELS.stop:
    case WORKSPACE_CONSOLE_CHANNELS.attachInput:
    case WORKSPACE_CONSOLE_CHANNELS.attachDetach:
      if (value !== true) return fail()
      return true
    case WORKSPACE_CONSOLE_CHANNELS.attachWatch:
    case WORKSPACE_CONSOLE_CHANNELS.attachUnwatch:
      if (value !== true) return fail()
      return true
    case WORKSPACE_CONSOLE_CHANNELS.attachOpen:
    case WORKSPACE_CONSOLE_CHANNELS.attachClaim:
      return parseWorkspaceConsoleBackendResponse(channel, { attachment: value })
    default:
      return fail()
  }
}

/** Validate fixed service IPC input before main forwards it to the owner-only API. */
export function parseWorkspaceServicesRequest(channel: unknown, args: readonly unknown[]): Readonly<Record<string, unknown>> {
  const safeArgs = readLocalArray(args, 1)
  if (safeArgs.length !== 1 || !Object.values(WORKSPACE_SERVICES_CHANNELS).includes(channel as WorkspaceServicesInvokeChannel)) return fail()
  const value = safeArgs[0]
  switch (channel) {
    case WORKSPACE_SERVICES_CHANNELS.list: {
      const record = exactObject(value, ['workspaceId'])
      if (!workspaceFileId(record.workspaceId)) return fail()
      return Object.freeze({ workspaceId: record.workspaceId })
    }
    case WORKSPACE_SERVICES_CHANNELS.define: {
      const record = exactObject(value, ['workspaceId', 'definition'])
      if (!workspaceFileId(record.workspaceId)) return fail()
      return Object.freeze({ workspaceId: record.workspaceId, definition: parseWorkspaceServiceDefinition(record.definition) })
    }
    case WORKSPACE_SERVICES_CHANNELS.codeServer: {
      // The IDE binds a private unix socket, so no loopback port is chosen here.
      const record = exactObject(value, ['workspaceId'])
      if (!workspaceFileId(record.workspaceId)) return fail()
      return Object.freeze({ workspaceId: record.workspaceId })
    }
    case WORKSPACE_SERVICES_CHANNELS.remove:
    case WORKSPACE_SERVICES_CHANNELS.stop: {
      const record = exactObject(value, ['workspaceId', 'name', 'confirm'])
      if (!workspaceFileId(record.workspaceId) || typeof record.confirm !== 'boolean') return fail()
      return Object.freeze({ workspaceId: record.workspaceId, name: workspaceServiceName(record.name), confirm: record.confirm })
    }
    case WORKSPACE_SERVICES_CHANNELS.start: {
      const record = exactObject(value, ['workspaceId', 'name'])
      if (!workspaceFileId(record.workspaceId)) return fail()
      return Object.freeze({ workspaceId: record.workspaceId, name: workspaceServiceName(record.name) })
    }
    case WORKSPACE_SERVICES_CHANNELS.logs: {
      const record = exactObject(value, ['workspaceId', 'name', 'lines'])
      if (!workspaceFileId(record.workspaceId) || typeof record.lines !== 'number'
        || !Number.isInteger(record.lines) || record.lines < 1 || record.lines > 400) return fail()
      return Object.freeze({ workspaceId: record.workspaceId, name: workspaceServiceName(record.name), lines: record.lines })
    }
    default:
      return fail()
  }
}

const LANGUAGE_PROFILE_STATES = new Set(['installed', 'modified', 'unverified', 'missing'])
const LANGUAGE_EXTENSION_REQUIRED = Object.freeze([
  'extensionId', 'version', 'marketplace', 'declaredLicence', 'licenceSha256', 'vsixSha256', 'vsixBytes',
  'downloadUrl', 'targetPlatform', 'pinnedInstalledSha256', 'state', 'reason',
])
const LANGUAGE_EXTENSION_OPTIONAL = Object.freeze([
  'installedVersion', 'installedDirectory', 'measuredSha256', 'measuredFiles', 'installedLicenceField',
])
const MAX_LANGUAGE_PROFILES = 8
const MAX_LANGUAGE_EXTENSIONS = 16
const MAX_LANGUAGE_TEXT = 512

function boundedRecord(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail()
  const record = value as Record<string, unknown>
  if (!required.every((key) => Object.prototype.hasOwnProperty.call(record, key))) return fail()
  if (Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))) return fail()
  return record
}

function boundedLanguageText(value: unknown, { allowNull = false }: { allowNull?: boolean } = {}): string | null {
  if (value === null && allowNull) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LANGUAGE_TEXT
    || /[\u0000-\u001f\u007f]/u.test(value)) return fail()
  return value
}

function parseLanguageProfileExtension(value: unknown): LanguageProfileExtensionDto {
  const record = boundedRecord(value, LANGUAGE_EXTENSION_REQUIRED, LANGUAGE_EXTENSION_OPTIONAL)
  const extensionId = boundedLanguageText(record.extensionId) as string
  if (!/^[A-Za-z0-9-]+\.[A-Za-z0-9-]+$/u.test(extensionId)) return fail()
  const version = boundedLanguageText(record.version) as string
  const marketplace = boundedLanguageText(record.marketplace) as string
  const declaredLicence = boundedLanguageText(record.declaredLicence) as string
  const licenceSha256 = boundedLanguageText(record.licenceSha256) as string
  const vsixSha256 = boundedLanguageText(record.vsixSha256) as string
  const pinnedInstalledSha256 = boundedLanguageText(record.pinnedInstalledSha256) as string
  if (![licenceSha256, vsixSha256, pinnedInstalledSha256].every((digest) => /^[0-9a-f]{64}$/u.test(digest))) return fail()
  if (typeof record.vsixBytes !== 'number' || !Number.isInteger(record.vsixBytes) || record.vsixBytes < 0) return fail()
  const downloadUrl = boundedLanguageText(record.downloadUrl) as string
  if (!downloadUrl.startsWith('https://')) return fail()
  const targetPlatform = record.targetPlatform === null
    ? null
    : boundedLanguageText(record.targetPlatform, { allowNull: true }) as string
  if (typeof record.state !== 'string' || !LANGUAGE_PROFILE_STATES.has(record.state)) return fail()
  const reason = record.reason === null ? null : boundedLanguageText(record.reason, { allowNull: true }) as string
  const installedVersion = 'installedVersion' in record && record.installedVersion !== null
    ? boundedLanguageText(record.installedVersion, { allowNull: true }) as string
    : null
  const installedDirectory = 'installedDirectory' in record && record.installedDirectory !== null
    ? boundedLanguageText(record.installedDirectory, { allowNull: true }) as string
    : null
  const measuredSha256 = 'measuredSha256' in record && record.measuredSha256 !== null
    ? boundedLanguageText(record.measuredSha256, { allowNull: true }) as string
    : null
  const measuredFiles = 'measuredFiles' in record && record.measuredFiles !== null
    ? (typeof record.measuredFiles === 'number' && Number.isInteger(record.measuredFiles) && record.measuredFiles >= 0
        ? record.measuredFiles : fail())
    : null
  const installedLicenceField = 'installedLicenceField' in record && record.installedLicenceField !== null
    ? boundedLanguageText(record.installedLicenceField, { allowNull: true }) as string
    : null
  return Object.freeze({
    extensionId, version, marketplace, declaredLicence, licenceSha256, vsixSha256,
    vsixBytes: record.vsixBytes, downloadUrl, targetPlatform,
    pinnedInstalledSha256, state: record.state as LanguageProfileExtensionDto['state'], reason,
    installedVersion, installedDirectory, measuredSha256, measuredFiles, installedLicenceField,
  })
}

function parseDebugAdapter(value: unknown): DebugAdapterDto {
  const record = exactObject(value, [
    'profile', 'extensionId', 'version', 'state', 'reason', 'declaredLicence', 'pinnedInstalledSha256',
  ])
  const optionalText = (item: unknown) => item === null ? null : boundedLanguageText(item, { allowNull: true }) as string
  return Object.freeze({
    profile: boundedLanguageText(record.profile) as string,
    extensionId: optionalText(record.extensionId),
    version: optionalText(record.version),
    state: optionalText(record.state),
    reason: optionalText(record.reason),
    declaredLicence: optionalText(record.declaredLicence),
    pinnedInstalledSha256: optionalText(record.pinnedInstalledSha256),
  })
}

function parseDebugCodeServer(value: unknown): DebugCodeServerDto {
  const record = exactObject(value, [
    'registered', 'state', 'argv', 'ports', 'authMode', 'bindAddress', 'resourceControls', 'accountNote',
  ])
  if (record.registered !== true) return fail()
  if (!Array.isArray(record.argv) || record.argv.length > 64) return fail()
  const argv = Object.freeze(record.argv.map((item) => boundedLanguageText(item) as string))
  const ports = parseWorkspaceServicePorts(record.ports)
  const controls = boundedRecord(record.resourceControls, ['memoryLimitMb', 'cpuQuotaPercent', 'tasksMax',
    'filesystemIsolation', 'networkIsolation'], [])
  return Object.freeze({
    registered: true,
    state: record.state === null ? null : boundedLanguageText(record.state, { allowNull: true }) as string,
    argv,
    ports,
    authMode: boundedLanguageText(record.authMode) as string,
    bindAddress: record.bindAddress === null ? null : boundedLanguageText(record.bindAddress, { allowNull: true }) as string,
    resourceControls: Object.freeze({ ...controls }),
    accountNote: boundedLanguageText(record.accountNote) as string,
  })
}

function parseDebugReadiness(value: unknown): DebugReadinessDto {
  const record = exactObject(value, [
    'adapters', 'unsupported', 'codeServer', 'sessionExercised', 'breakpointVerified', 'note',
  ])
  if (!Array.isArray(record.adapters) || record.adapters.length > 32) return fail()
  if (!Array.isArray(record.unsupported) || record.unsupported.length > 32) return fail()
  const unsupported = Object.freeze(record.unsupported.map((item) => {
    const row = exactObject(item, ['profile', 'feature', 'reason'])
    return Object.freeze({
      profile: row.profile === null ? null : boundedLanguageText(row.profile, { allowNull: true }) as string,
      feature: boundedLanguageText(row.feature) as string,
      reason: boundedLanguageText(row.reason) as string,
    })
  }))
  // The verified flags are constants: a payload that claims a session or a breakpoint
  // is refused instead of forwarded to the renderer.
  if (record.sessionExercised !== false || record.breakpointVerified !== false) return fail()
  return Object.freeze({
    adapters: Object.freeze(record.adapters.map(parseDebugAdapter)),
    unsupported,
    codeServer: record.codeServer === null ? null : parseDebugCodeServer(record.codeServer),
    sessionExercised: false,
    breakpointVerified: false,
    note: boundedLanguageText(record.note) as string,
  })
}

function parseLanguageProfilesReport(value: unknown): LanguageProfilesDto {
  const record = exactObject(value, ['extensionsDirectory', 'profiles', 'unpinnedInstalled', 'pinsVerified', 'note', 'debug'])
  const extensionsDirectory = boundedLanguageText(record.extensionsDirectory) as string
  if (!extensionsDirectory.startsWith('/')) return fail()
  if (!Array.isArray(record.profiles) || record.profiles.length > MAX_LANGUAGE_PROFILES) return fail()
  const profiles = record.profiles.map((candidate) => {
    const profile = exactObject(candidate, ['profile', 'label', 'languageIds', 'extensions', 'debuggers', 'unsupported'])
    const id = boundedLanguageText(profile.profile) as string
    const label = boundedLanguageText(profile.label) as string
    if (!Array.isArray(profile.languageIds) || profile.languageIds.length > MAX_LANGUAGE_EXTENSIONS) return fail()
    const languageIds = Object.freeze(profile.languageIds.map((item) => boundedLanguageText(item) as string))
    if (!Array.isArray(profile.extensions) || profile.extensions.length > MAX_LANGUAGE_EXTENSIONS) return fail()
    if (!Array.isArray(profile.debuggers) || profile.debuggers.length > MAX_LANGUAGE_EXTENSIONS) return fail()
    if (!Array.isArray(profile.unsupported) || profile.unsupported.length > MAX_LANGUAGE_EXTENSIONS) return fail()
    const unsupported = Object.freeze(profile.unsupported.map((item) => {
      const row = exactObject(item, ['feature', 'reason'])
      return Object.freeze({
        feature: boundedLanguageText(row.feature) as string,
        reason: boundedLanguageText(row.reason) as string,
      })
    }))
    return Object.freeze({
      profile: id, label, languageIds,
      extensions: Object.freeze(profile.extensions.map(parseLanguageProfileExtension)),
      debuggers: Object.freeze(profile.debuggers.map(parseLanguageProfileExtension)),
      unsupported,
    })
  })
  if (!Array.isArray(record.unpinnedInstalled) || record.unpinnedInstalled.length > MAX_LANGUAGE_EXTENSIONS) return fail()
  const unpinnedInstalled = Object.freeze(record.unpinnedInstalled.map((item) => {
    const row = exactObject(item, ['extensionId', 'installedVersion', 'installedLicenceField', 'measuredSha256', 'state', 'reason'])
    if (row.state !== 'unpinned') return fail()
    return Object.freeze({
      extensionId: boundedLanguageText(row.extensionId) as string,
      installedVersion: row.installedVersion === null ? null : boundedLanguageText(row.installedVersion, { allowNull: true }) as string,
      installedLicenceField: row.installedLicenceField === null
        ? null : boundedLanguageText(row.installedLicenceField, { allowNull: true }) as string,
      measuredSha256: row.measuredSha256 === null ? null : boundedLanguageText(row.measuredSha256, { allowNull: true }) as string,
      state: 'unpinned' as const,
      reason: boundedLanguageText(row.reason) as string,
    })
  }))
  if (typeof record.pinsVerified !== 'boolean') return fail()
  return Object.freeze({
    extensionsDirectory,
    profiles: Object.freeze(profiles),
    unpinnedInstalled,
    pinsVerified: record.pinsVerified,
    note: boundedLanguageText(record.note) as string,
    debug: parseDebugReadiness(record.debug),
  })
}

/** Normalize only the documented language-profile envelope before it reaches the renderer. */
export function parseLanguageProfilesBackendResponse(channel: unknown, value: unknown): unknown {
  if (channel !== LANGUAGE_PROFILES_CHANNELS.list) return fail()
  return parseLanguageProfilesReport(value)
}

export function parseLanguageProfilesRequest(
  channel: unknown,
  args: readonly unknown[],
): Readonly<{ workspaceId: string }> {
  const safeArgs = readLocalArray(args, 1)
  if (safeArgs.length !== 1 || channel !== LANGUAGE_PROFILES_CHANNELS.list) return fail()
  const record = exactObject(safeArgs[0], ['workspaceId'])
  if (!workspaceFileId(record.workspaceId)) return fail()
  return Object.freeze({ workspaceId: record.workspaceId })
}

/** Validate the normalized report returned by the preload bridge. */
export function parseLanguageProfilesResponse(channel: unknown, value: unknown): unknown {
  if (channel !== LANGUAGE_PROFILES_CHANNELS.list) return fail()
  return parseLanguageProfilesReport(value)
}

/** Normalize only the documented service envelopes before they cross into the renderer. */
export function parseWorkspaceServicesBackendResponse(channel: unknown, value: unknown): unknown {
  switch (channel) {
    case WORKSPACE_SERVICES_CHANNELS.list: {
      const record = exactObject(value, ['services'])
      if (!Array.isArray(record.services) || record.services.length > MAX_WORKSPACE_SERVICES) return fail()
      const services = record.services.map(parseWorkspaceServiceDto)
      if (new Set(services.map((service) => service.name)).size !== services.length) return fail()
      return Object.freeze(services)
    }
    case WORKSPACE_SERVICES_CHANNELS.define:
    case WORKSPACE_SERVICES_CHANNELS.codeServer:
    case WORKSPACE_SERVICES_CHANNELS.start:
      return parseWorkspaceServiceDto(exactObject(value, ['service']).service)
    case WORKSPACE_SERVICES_CHANNELS.remove:
    case WORKSPACE_SERVICES_CHANNELS.stop: {
      const record = exactObject(value, ['ok'])
      if (record.ok !== true) return fail()
      return true
    }
    case WORKSPACE_SERVICES_CHANNELS.logs: {
      const record = exactObject(value, ['text', 'truncated'])
      if (typeof record.text !== 'string'
        || new TextEncoder().encode(record.text).byteLength > MAX_WORKSPACE_SERVICE_LOGS_BYTES
        || typeof record.truncated !== 'boolean') return fail()
      return Object.freeze({ text: record.text, truncated: record.truncated })
    }
    default:
      return fail()
  }
}

/** Validate normalized service results returned by the preload bridge. */
export function parseWorkspaceServicesResponse(channel: unknown, value: unknown): unknown {
  switch (channel) {
    case WORKSPACE_SERVICES_CHANNELS.list:
      return parseWorkspaceServicesBackendResponse(channel, { services: value })
    case WORKSPACE_SERVICES_CHANNELS.define:
    case WORKSPACE_SERVICES_CHANNELS.codeServer:
    case WORKSPACE_SERVICES_CHANNELS.start:
      return parseWorkspaceServicesBackendResponse(channel, { service: value })
    case WORKSPACE_SERVICES_CHANNELS.remove:
    case WORKSPACE_SERVICES_CHANNELS.stop:
      if (value !== true) return fail()
      return true
    case WORKSPACE_SERVICES_CHANNELS.logs:
      return parseWorkspaceServicesBackendResponse(channel, value)
    default:
      return fail()
  }
}

/** Parse only the fixed local Codex invocation channels and canonicalize each payload. */
export function parseLocalCodexRequest(channel: unknown, args: readonly unknown[]): LocalCodexBridgeRequest {
  const safeArgs = readLocalArray(args, 1)
  switch (channel) {
    case LOCAL_CODEX_CHANNELS.listProjects:
    case LOCAL_CODEX_CHANNELS.registerProject:
      if (safeArgs.length !== 0) return fail()
      return makeLocalCodexRequest(channel, [])
    case LOCAL_CODEX_CHANNELS.registerWorkspace:
      if (safeArgs.length !== 1) return fail()
      return makeLocalCodexRequest(channel, [parseLocalWorkspacePayload(safeArgs[0])])
    case LOCAL_CODEX_CHANNELS.listSessions:
      if (safeArgs.length !== 1) return fail()
      return makeLocalCodexRequest(channel, [parseLocalSessionsPayload(safeArgs[0])])
    case LOCAL_CODEX_CHANNELS.startTurn:
      if (safeArgs.length !== 1) return fail()
      return makeLocalCodexRequest(channel, [parseLocalPrompt(safeArgs[0])])
    case LOCAL_CODEX_CHANNELS.latestTurnStatus:
      if (safeArgs.length !== 0) return fail()
      return makeLocalCodexRequest(channel, [])
    case LOCAL_CODEX_CHANNELS.turnStatus:
      if (safeArgs.length !== 1) return fail()
      return makeLocalCodexRequest(channel, [parseLocalTaskPayload(safeArgs[0])])
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
    case LOCAL_CODEX_CHANNELS.registerWorkspace:
      return boundedLocalResult(parseLocalProject(value))
    case LOCAL_CODEX_CHANNELS.startTurn:
      return boundedLocalResult(parseLocalTurn(value))
    case LOCAL_CODEX_CHANNELS.latestTurnStatus:
      return value === null ? null : boundedLocalResult(parseLocalTurnStatus(value))
    case LOCAL_CODEX_CHANNELS.turnStatus:
      return boundedLocalResult(parseLocalTurnStatus(value))
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
