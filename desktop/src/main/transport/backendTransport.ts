import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import type {
  ConnectionProbeResult,
  JsonRecord,
  OperationMap,
  OperationName,
} from '../../shared/bridge/types'
import type { LocalCodexProxyRequest } from '../localCodexProxy'
import { BRIDGE_CHANNELS, isOperationName, parseBridgeResponse, parseOperationPayload } from '../../shared/bridge/validation'
import {
  ipcPayloadLimitsForOperation,
  isBoundedIpcPayload,
  type BoundedPayloadLimits,
} from '../security/TrustedShellFrameGuard'

export const READ_ONLY_OPERATIONS: readonly OperationName[] = Object.freeze([
  'readiness',
  'projects.list',
  'projects.head',
  'sessions.list',
  'sessions.messages',
  'tasks.list',
  'events.cursor',
  'secrets.authStates',
  'workspaces.list',
  'workspaces.get',
  'workspaces.files.list',
  'workspaces.files.read',
  'workspaces.files.diff',
  'workspaces.files.search',
])

export const PROJECT_OPERATIONS: readonly OperationName[] = Object.freeze([
  'projects.create',
])

export const TASK_OPERATIONS: readonly OperationName[] = Object.freeze([
  'runtimes.list',
  'tasks.submit',
  'tasks.get',
  'tasks.events',
  'tasks.cancel',
])

/** Permanent removal of server conversations; the renderer confirms it first. */
export const SESSION_OPERATIONS: readonly OperationName[] = Object.freeze([
  'sessions.delete',
])

export const WORKSPACE_OPERATIONS: readonly OperationName[] = Object.freeze([
  'workspaces.provision',
  'workspaces.files.write',
  'workspaces.files.create',
])

/** Operations pages. Every mutation here carries an explicit renderer confirmation and is sent once. */
export const OPERATIONS_PAGE_OPERATIONS: readonly OperationName[] = Object.freeze([
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
])

/** Composer support: Prime's model catalog, and server speech-to-text for review before sending. */
export const COMPOSER_OPERATIONS: readonly OperationName[] = Object.freeze([
  'models.catalog',
  'audio.status',
  'audio.transcribe',
])

const OPERATION_METHODS: Readonly<Record<OperationName, 'GET' | 'POST' | 'PUT' | 'DELETE'>> = Object.freeze({
  readiness: 'GET',
  'projects.list': 'GET',
  'projects.create': 'POST',
  'projects.head': 'GET',
  'sessions.list': 'GET',
  'sessions.messages': 'GET',
  'sessions.delete': 'DELETE',
  'tasks.list': 'GET',
  'events.cursor': 'GET',
  'runtimes.list': 'GET',
  'secrets.authStates': 'GET',
  'tasks.submit': 'POST',
  'tasks.get': 'GET',
  'tasks.events': 'GET',
  'tasks.cancel': 'POST',
  'workspaces.list': 'GET',
  'workspaces.get': 'GET',
  'workspaces.provision': 'POST',
  'workspaces.files.list': 'GET',
  'workspaces.files.read': 'GET',
  'workspaces.files.diff': 'GET',
  'workspaces.files.search': 'GET',
  'workspaces.files.write': 'POST',
  'workspaces.files.create': 'POST',
  // Operations pages
  'status.get': 'GET',
  'logs.list': 'GET',
  'models.list': 'GET',
  'models.setDefault': 'PUT',
  'skills.list': 'GET',
  'skills.get': 'GET',
  'skills.toggle': 'PUT',
  'cron.list': 'GET',
  'cron.create': 'POST',
  'cron.update': 'PUT',
  'cron.action': 'POST',
  'backups.list': 'GET',
  'backups.create': 'POST',
  'backups.schedule.get': 'GET',
  'backups.schedule.set': 'PUT',
  'backups.inspect': 'POST',
  'backups.restore': 'POST',
  // Composer
  'models.catalog': 'GET',
  'audio.status': 'GET',
  'audio.transcribe': 'POST',
})

export const MAX_BACKEND_RESPONSE_BYTES = 2 * 1024 * 1024

const RESPONSE_PAYLOAD_LIMITS: BoundedPayloadLimits = Object.freeze({
  maxBytes: MAX_BACKEND_RESPONSE_BYTES,
  maxDepth: 32,
  maxNodes: 50_000,
  maxStringLength: MAX_BACKEND_RESPONSE_BYTES,
  maxArrayLength: 2_000,
  maxObjectKeys: 2_000,
})

const OPERATION_PATHS: Readonly<Record<OperationName, string>> = Object.freeze({
  readiness: '/api/readiness',
  'projects.list': '/api/projects',
  'projects.create': '/api/projects',
  'projects.head': '/api/projects',
  'sessions.list': '/api/sessions',
  'sessions.messages': '/api/sessions',
  'sessions.delete': '/api/sessions',
  'tasks.list': '/api/tasks',
  'events.cursor': '/api/events/cursor',
  'runtimes.list': '/api/runtimes',
  'secrets.authStates': '/api/local/secrets/auth-states',
  'tasks.submit': '/api/tasks',
  'tasks.get': '/api/tasks',
  'tasks.events': '/api/tasks',
  'tasks.cancel': '/api/tasks',
  'workspaces.list': '/api/workspaces',
  'workspaces.get': '/api/workspaces',
  'workspaces.provision': '/api/workspaces',
  'workspaces.files.list': '/api/workspaces',
  'workspaces.files.read': '/api/workspaces',
  'workspaces.files.diff': '/api/workspaces',
  'workspaces.files.search': '/api/workspaces',
  'workspaces.files.write': '/api/workspaces',
  'workspaces.files.create': '/api/workspaces',
  // Operations pages
  'status.get': '/api/status',
  'logs.list': '/api/logs',
  'models.list': '/api/models',
  'models.setDefault': '/api/models/default',
  'skills.list': '/api/skills',
  'skills.get': '/api/skills',
  'skills.toggle': '/api/skills/toggle',
  'cron.list': '/api/cron',
  'cron.create': '/api/cron',
  'cron.update': '/api/cron',
  'cron.action': '/api/cron',
  'backups.list': '/api/backups',
  'backups.create': '/api/backups',
  'backups.schedule.get': '/api/backups/schedule',
  'backups.schedule.set': '/api/backups/schedule',
  'backups.inspect': '/api/backups/inspect',
  'backups.restore': '/api/backups/restore',
  // Composer
  'models.catalog': '/api/models',
  'audio.status': '/api/audio/status',
  'audio.transcribe': '/api/audio/transcribe',
})

const SAFE_MESSAGES = Object.freeze({
  invalid_connection: 'The server connection settings are invalid.',
  not_connected: 'No server connection is configured.',
  invalid_payload: 'The request is invalid or too large.',
  unsupported_operation: 'This operation is not available.',
  unauthorized: 'The server did not accept the connection.',
  http_error: 'The server could not complete the request.',
  network_error: 'Could not reach the configured server.',
  redirect_rejected: 'The server returned an unsafe redirect.',
  response_too_large: 'The server response is too large.',
  invalid_response: 'The server returned an invalid response.',
  connection_changed: 'The server connection changed while this request was running.',
  binary_file: 'Binary files cannot be previewed as text.',
  write_conflict: 'The file changed on the server. Reload it before saving again.',
  session_busy: 'A selected conversation has a queued or running task. Cancel its task first.',
  session_not_found: 'A selected conversation no longer exists on the server. Refresh the list.',
} as const)

export type BackendTransportErrorCode = keyof typeof SAFE_MESSAGES

export class BackendTransportError extends Error {
  readonly code: BackendTransportErrorCode
  readonly httpStatus?: 401 | 403

  constructor(code: BackendTransportErrorCode, httpStatus?: 401 | 403) {
    super(SAFE_MESSAGES[code])
    this.name = 'BackendTransportError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface BackendConnectionInput {
  serverUrl: string
  token: string
}

export type BackendFetch = (input: URL, init: RequestInit) => Promise<Response>

export interface BackendTransportOptions {
  /** Omit both values for a disconnected transport at startup. */
  serverUrl?: string
  token?: string
  /** Required only for tests; production uses Node/Electron's built-in fetch. */
  fetch?: BackendFetch
}

interface ActiveConnection {
  readonly origin: string
  readonly basePath: string
  readonly token: string
  readonly generation: number
}

function invalidConnection(): never {
  throw new BackendTransportError('invalid_connection')
}

function isLoopbackHost(hostname: string): boolean {
  const unwrapped = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (unwrapped === 'localhost') return true
  const ipVersion = isIP(unwrapped)
  if (ipVersion === 4) return Number(unwrapped.split('.')[0]) === 127
  return ipVersion === 6 && unwrapped === '::1'
}

function safeBasePath(serverUrl: string): string | undefined {
  const schemeEnd = serverUrl.indexOf('://')
  if (schemeEnd < 0) return undefined
  const afterScheme = serverUrl.slice(schemeEnd + 3)
  const firstSlash = afterScheme.indexOf('/')
  const rawPath = firstSlash < 0 ? '' : afterScheme.slice(firstSlash)
  if (rawPath === '' || rawPath === '/') return ''
  if (!rawPath.startsWith('/') || rawPath.includes('\\')) return undefined

  const segments = rawPath.slice(1).split('/')
  if (segments.at(-1) === '') segments.pop()
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) return undefined
  for (const segment of segments) {
    let decoded = segment
    for (let pass = 0; pass < 6; pass += 1) {
      let next: string
      try {
        next = decodeURIComponent(decoded)
      } catch {
        return undefined
      }
      const unchanged = next === decoded
      decoded = next
      if (
        decoded === '.' ||
        decoded === '..' ||
        /[\\/?#\u0000-\u001f\u007f]/u.test(decoded)
      ) {
        return undefined
      }
      if (unchanged) break
    }
    // Do not accept multiply-encoded path syntax that a downstream proxy could
    // decode differently from the URL implementation here.
    if (/%[0-9a-f]{2}/iu.test(decoded)) return undefined
  }
  return rawPath
}

function validateConnection(input: BackendConnectionInput): { origin: string; basePath: string; token: string } {
  const { serverUrl, token } = input
  if (
    typeof serverUrl !== 'string' ||
    serverUrl.length === 0 ||
    serverUrl.length > 2048 ||
    serverUrl !== serverUrl.trim() ||
    /[\u0000-\u0020\u007f-\u009f]/u.test(serverUrl) ||
    serverUrl.includes('?') ||
    serverUrl.includes('#') ||
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 8192 ||
    token !== token.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(token)
  ) {
    return invalidConnection()
  }

  try {
    const url = new URL(serverUrl)
    const basePath = safeBasePath(serverUrl)
    const authority = serverUrl.slice(serverUrl.indexOf('://') + 3).split(/[/?#]/u, 1)[0]
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !url.hostname ||
      url.username ||
      url.password ||
      authority.includes('@') ||
      host.includes('%') ||
      host.endsWith('.') ||
      basePath === undefined
    ) {
      return invalidConnection()
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return invalidConnection()
    return { origin: url.origin, basePath: url.pathname.replace(/\/+$/u, ''), token }
  } catch {
    return invalidConnection()
  }
}

/** Validate before any credential persistence or transport mutation occurs. */
export function validateBackendConnectionInput(input: BackendConnectionInput): void {
  validateConnection(input)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isReadinessResponse(value: unknown): value is JsonRecord {
  if (
    !isRecord(value) ||
    typeof value.dispatch_ready !== 'boolean' ||
    typeof value.execution_verified !== 'boolean' ||
    typeof value.credentials_verified !== 'boolean' ||
    typeof value.native_conformance_verified !== 'boolean' ||
    !isRecord(value.storage) ||
    (value.storage.status !== 'ready' && value.storage.status !== 'unavailable') ||
    typeof value.storage.readable !== 'boolean' ||
    typeof value.storage.writable !== 'boolean' ||
    !isRecord(value.workers) ||
    !isNonNegativeInteger(value.workers.configured) ||
    typeof value.workers.enabled !== 'boolean' ||
    !isNonNegativeInteger(value.workers.live) ||
    !isNonNegativeInteger(value.workers.busy) ||
    value.workers.scope !== 'server_process' ||
    !Array.isArray(value.workers.items) ||
    value.workers.items.length > 2_000 ||
    !isRecord(value.queue) ||
    !(value.queue.queued === null || isNonNegativeInteger(value.queue.queued)) ||
    !(value.queue.running === null || isNonNegativeInteger(value.queue.running)) ||
    !Array.isArray(value.runtimes) ||
    value.runtimes.length > 100 ||
    !isRecord(value.transport) ||
    (value.transport.mode !== 'disabled' && value.transport.mode !== 'private_tls_proxy') ||
    typeof value.transport.configuration_verified !== 'boolean' ||
    typeof value.transport.private_tls_verified !== 'boolean' ||
    value.transport.verification_level !== 'configuration_only'
  ) {
    return false
  }

  const workersHaveExpectedShape = value.workers.items.every((worker) =>
    isRecord(worker) &&
    typeof worker.id === 'string' &&
    typeof worker.state === 'string' &&
    typeof worker.live === 'boolean' &&
    typeof worker.busy === 'boolean',
  )
  const runtimesHaveExpectedShape = value.runtimes.every((runtime) =>
    isRecord(runtime) &&
    typeof runtime.id === 'string' &&
    typeof runtime.available === 'boolean' &&
    typeof runtime.dispatch_ready === 'boolean' &&
    typeof runtime.check_type === 'string' &&
    typeof runtime.version_verified === 'boolean',
  )
  return workersHaveExpectedShape && runtimesHaveExpectedShape
}

function operationUrl(
  origin: string,
  basePath: string,
  operation: OperationName,
  payload: OperationMap[OperationName]['payload'],
): URL {
  let path = `${basePath}${OPERATION_PATHS[operation]}`
  if (operation === 'tasks.submit' && (payload as OperationMap['tasks.submit']['payload']).workspaceId !== undefined) {
    // An older backend must reject this route rather than silently ignoring
    // workspace fields and running against the registered project source.
    path = `${basePath}/api/workspace-tasks`
  } else if (operation === 'projects.head') {
    const headPayload = payload as OperationMap['projects.head']['payload']
    path += `/${encodeURIComponent(headPayload.projectId)}/head`
  } else if (operation === 'sessions.messages') {
    const messagesPayload = payload as OperationMap['sessions.messages']['payload']
    path += `/${encodeURIComponent(messagesPayload.sessionId)}/messages`
  } else if (operation === 'tasks.get' || operation === 'tasks.events' || operation === 'tasks.cancel') {
    const taskPayload = payload as OperationMap['tasks.get']['payload']
    const taskId = encodeURIComponent(taskPayload.taskId)
    path += `/${taskId}`
    if (operation === 'tasks.events') path += '/events'
    if (operation === 'tasks.cancel') path += '/cancel'
  } else if (operation === 'workspaces.get') {
    const workspacePayload = payload as OperationMap['workspaces.get']['payload']
    path += `/${encodeURIComponent(workspacePayload.workspaceId)}`
  } else if (operation === 'workspaces.files.list' || operation === 'workspaces.files.read') {
    const workspacePayload = payload as OperationMap['workspaces.files.list']['payload']
    path += `/${encodeURIComponent(workspacePayload.workspaceId)}/files`
    if (operation === 'workspaces.files.read') path += '/read'
  } else if (operation === 'workspaces.files.diff') {
    const workspacePayload = payload as OperationMap['workspaces.files.diff']['payload']
    path += `/${encodeURIComponent(workspacePayload.workspaceId)}/files/diff`
  } else if (operation === 'workspaces.files.search') {
    const workspacePayload = payload as OperationMap['workspaces.files.search']['payload']
    path += `/${encodeURIComponent(workspacePayload.workspaceId)}/files/search`
  } else if (operation === 'workspaces.files.write') {
    const workspacePayload = payload as OperationMap['workspaces.files.write']['payload']
    path += `/${encodeURIComponent(workspacePayload.workspaceId)}/files/write`
  } else if (operation === 'workspaces.files.create') {
    const workspacePayload = payload as OperationMap['workspaces.files.create']['payload']
    path += `/${encodeURIComponent(workspacePayload.workspaceId)}/files/create`
  } else if (operation === 'skills.get') {
    path += `/${encodeURIComponent((payload as OperationMap['skills.get']['payload']).name)}`
  } else if (operation === 'cron.update' || operation === 'cron.action') {
    path += `/${encodeURIComponent((payload as OperationMap['cron.update']['payload']).jobId)}`
    if (operation === 'cron.action') path += '/action'
  }
  const url = new URL(path, origin)
  if (operation === 'workspaces.list' || operation === 'workspaces.get') {
    // Ask for the recorded owner and the checkout's HEAD state; an older server
    // ignores the parameter and returns the identity alone.
    url.searchParams.set('include', 'checkout')
  }
  if (operation === 'sessions.list') {
    const listPayload = payload as OperationMap['sessions.list']['payload']
    if (listPayload.projectId !== undefined) url.searchParams.set('project_id', listPayload.projectId)
    if (listPayload.limit !== undefined) url.searchParams.set('limit', String(listPayload.limit))
  } else if (operation === 'sessions.messages') {
    const messagesPayload = payload as OperationMap['sessions.messages']['payload']
    url.searchParams.set('limit', String(messagesPayload.limit))
  } else if (operation === 'tasks.list') {
    const listPayload = payload as OperationMap['tasks.list']['payload']
    if (listPayload.limit !== undefined) url.searchParams.set('limit', String(listPayload.limit))
  } else if (operation === 'tasks.events') {
    const eventPayload = payload as OperationMap['tasks.events']['payload']
    url.searchParams.set('after', String(eventPayload.after))
  } else if (operation === 'workspaces.files.list') {
    const filePayload = payload as OperationMap['workspaces.files.list']['payload']
    url.searchParams.set('path', filePayload.path)
    url.searchParams.set('limit', String(filePayload.limit))
  } else if (operation === 'workspaces.files.read') {
    const filePayload = payload as OperationMap['workspaces.files.read']['payload']
    url.searchParams.set('path', filePayload.path)
    url.searchParams.set('max_bytes', String(filePayload.maxBytes))
  } else if (operation === 'workspaces.files.diff') {
    const filePayload = payload as OperationMap['workspaces.files.diff']['payload']
    url.searchParams.set('path', filePayload.path)
  } else if (operation === 'workspaces.files.search') {
    const searchPayload = payload as OperationMap['workspaces.files.search']['payload']
    url.searchParams.set('q', searchPayload.query)
  } else if (operation === 'logs.list') {
    const logsPayload = payload as OperationMap['logs.list']['payload']
    url.searchParams.set('limit', String(logsPayload.limit))
    if (logsPayload.level !== undefined) url.searchParams.set('level', logsPayload.level)
  }
  return url
}

function isSupportedResult(
  operation: OperationName,
  payload: OperationMap[OperationName]['payload'],
  value: unknown,
): value is JsonRecord {
  if (!isBoundedIpcPayload(value, RESPONSE_PAYLOAD_LIMITS) || !isRecord(value)) return false
  if (operation === 'readiness') return isReadinessResponse(value)
  try {
    const parsed = parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, value, operation)
    if (operation === 'tasks.get') {
      const requestedTaskId = (payload as OperationMap['tasks.get']['payload']).taskId
      return isRecord(value.task) && value.task.id === requestedTaskId
    }
    if (operation === 'tasks.events') {
      const { taskId, after } = payload as OperationMap['tasks.events']['payload']
      return Array.isArray(value.events) && value.events.every((event) =>
        isRecord(event) &&
        event.task_id === taskId &&
        typeof event.seq === 'number' &&
        Number.isSafeInteger(event.seq) &&
        event.seq > after,
      )
    }
    if (operation === 'sessions.messages') {
      const requested = payload as OperationMap['sessions.messages']['payload']
      return Array.isArray(value.messages) && value.messages.length <= requested.limit
    }
    if (operation === 'sessions.delete') {
      // The server confirms exactly the batch it was asked to remove.
      const requested = (payload as OperationMap['sessions.delete']['payload']).sessionIds
      return Array.isArray(value.deleted) && value.deleted.length === requested.length &&
        value.deleted.every((sessionId, index) => sessionId === requested[index])
    }
    if (operation === 'workspaces.get') {
      const requestedWorkspaceId = (payload as OperationMap['workspaces.get']['payload']).workspaceId
      return isRecord(value.workspace) && value.workspace.workspace_id === requestedWorkspaceId
    }
    if (operation === 'workspaces.files.list') {
      const requested = payload as OperationMap['workspaces.files.list']['payload']
      return value.path === requested.path && Array.isArray(value.entries) && value.entries.length <= requested.limit
    }
    if (operation === 'workspaces.files.read') {
      const requested = payload as OperationMap['workspaces.files.read']['payload']
      return value.path === requested.path && typeof value.content === 'string' &&
        new TextEncoder().encode(value.content).byteLength <= requested.maxBytes
    }
    if (operation === 'workspaces.files.diff') {
      const requested = payload as OperationMap['workspaces.files.diff']['payload']
      return value.path === requested.path && typeof value.diff === 'string' &&
        new TextEncoder().encode(value.diff).byteLength <= 64 * 1024
    }
    if (operation === 'workspaces.files.search') {
      if (!isRecord(parsed)) return false
      const result = parsed as Record<string, unknown>
      if (!Array.isArray(result.hits) || typeof result.files_scanned !== 'number' ||
          typeof result.bytes_scanned !== 'number') return false
      return result.hits.length <= 100 && result.files_scanned <= 200 && result.bytes_scanned <= 1024 * 1024
    }
    if (operation === 'workspaces.files.write') {
      const requested = payload as OperationMap['workspaces.files.write']['payload']
      return value.path === requested.path && value.content === requested.content &&
        typeof value.content === 'string' &&
        value.content.length <= 12_000 && !value.content.includes('\0') &&
        new TextEncoder().encode(value.content).byteLength <= 16 * 1024
    }
    if (operation === 'workspaces.files.create') {
      const requested = payload as OperationMap['workspaces.files.create']['payload']
      return value.path === requested.path && value.content === requested.content &&
        typeof value.content === 'string' &&
        value.content.length <= 12_000 && !value.content.includes('\0') &&
        new TextEncoder().encode(value.content).byteLength <= 16 * 1024
    }
    // Operations pages: the committed state must be the one requested.
    if (operation === 'logs.list') {
      return Array.isArray(value.logs) && value.logs.length <= (payload as OperationMap['logs.list']['payload']).limit
    }
    if (operation === 'models.setDefault') {
      const requested = payload as OperationMap['models.setDefault']['payload']
      return isRecord(value.current) && value.current.provider === requested.provider && value.current.model === requested.model
    }
    if (operation === 'skills.get') {
      return value.name === (payload as OperationMap['skills.get']['payload']).name
    }
    if (operation === 'skills.toggle') {
      const requested = payload as OperationMap['skills.toggle']['payload']
      return value.name === requested.name && value.enabled === requested.enabled
    }
    if (operation === 'backups.schedule.set') {
      return value.calendar === (payload as OperationMap['backups.schedule.set']['payload']).calendar
    }
    return true
  } catch {
    return false
  }
}

function checkResponseStatus(operation: OperationName, response: Response): void {
  if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new BackendTransportError('redirect_rejected')
  }
  if (response.status === 401 || response.status === 403) {
    throw new BackendTransportError('unauthorized', response.status)
  }
  if (operation === 'workspaces.files.read' && response.status === 415) {
    throw new BackendTransportError('binary_file')
  }
  if (operation === 'workspaces.files.write' && response.status === 409) {
    throw new BackendTransportError('write_conflict')
  }
  if (operation === 'workspaces.files.create' && response.status === 409) {
    throw new BackendTransportError('write_conflict')
  }
  if (operation === 'sessions.delete') {
    if (response.status === 200) return
    if (response.status === 409) throw new BackendTransportError('session_busy')
    if (response.status === 404) throw new BackendTransportError('session_not_found')
    throw new BackendTransportError('http_error')
  }
  if (operation === 'readiness' && (response.status === 200 || response.status === 503)) return
  if (operation === 'tasks.submit') {
    if (response.status === 202) return
    throw new BackendTransportError('http_error')
  }
  if (operation === 'workspaces.provision') {
    if (response.status === 404 || response.status === 405) {
      throw new BackendTransportError('unsupported_operation')
    }
    if (response.status === 200) return
    throw new BackendTransportError('http_error')
  }
  if (operation === 'workspaces.files.write') {
    if (response.status === 200) return
    throw new BackendTransportError('http_error')
  }
  if (operation === 'workspaces.files.create') {
    if (response.status === 200) return
    throw new BackendTransportError('http_error')
  }
  if (operation !== 'readiness' && response.status === 200) return
  throw new BackendTransportError('http_error')
}

function requestBody(operation: OperationName, payload: OperationMap[OperationName]['payload']): string | undefined {
  if (operation === 'projects.create') {
    const projectPayload = payload as OperationMap['projects.create']['payload']
    return JSON.stringify({ name: projectPayload.name, path: projectPayload.path, existing_git: true })
  }
  if (operation === 'tasks.submit') {
    const submitPayload = payload as OperationMap['tasks.submit']['payload']
    if (submitPayload.sessionId !== undefined) {
      // The server continues under the session's recorded runtime and cwd, so
      // no profile is sent; a project id, when given, must match the session.
      return JSON.stringify({
        prompt: submitPayload.prompt,
        session_id: submitPayload.sessionId,
        ...(submitPayload.projectId === undefined ? {} : { project_id: submitPayload.projectId }),
        ...(submitPayload.model === undefined ? {} : { model: submitPayload.model, provider: submitPayload.provider }),
        approval_mode: 'auto',
        chat_only: false,
      })
    }
    if (submitPayload.workspaceId !== undefined) {
      return JSON.stringify({
        prompt: submitPayload.prompt,
        workspace_id: submitPayload.workspaceId,
        workspace_generation: submitPayload.workspaceGeneration,
      })
    }
    return JSON.stringify({
      prompt: submitPayload.prompt,
      project_id: submitPayload.projectId,
      profile: submitPayload.runtime ?? 'prime',
      ...(submitPayload.model === undefined ? {} : { model: submitPayload.model, provider: submitPayload.provider }),
      approval_mode: 'auto',
      chat_only: false,
    })
  }
  if (operation === 'sessions.delete') {
    const deletePayload = payload as OperationMap['sessions.delete']['payload']
    return JSON.stringify({ session_ids: deletePayload.sessionIds })
  }
  if (operation === 'workspaces.provision') {
    const provisionPayload = payload as OperationMap['workspaces.provision']['payload']
    return JSON.stringify({ project_id: provisionPayload.projectId, revision: provisionPayload.revision })
  }
  if (operation === 'workspaces.files.write') {
    const writePayload = payload as OperationMap['workspaces.files.write']['payload']
    return JSON.stringify({ path: writePayload.path, expected_content: writePayload.expectedContent, content: writePayload.content })
  }
  if (operation === 'workspaces.files.create') {
    const createPayload = payload as OperationMap['workspaces.files.create']['payload']
    return JSON.stringify({ path: createPayload.path, content: createPayload.content })
  }
  if (operation === 'audio.transcribe') {
    const audioPayload = payload as OperationMap['audio.transcribe']['payload']
    return JSON.stringify({ data_url: audioPayload.dataUrl, mime_type: audioPayload.mimeType })
  }
  return operationsPageRequestBody(operation, payload)
}

/** Fixed request bodies for the operations pages; the confirmation flag is sent only after renderer confirmation. */
function operationsPageRequestBody(operation: OperationName, payload: OperationMap[OperationName]['payload']): string | undefined {
  switch (operation) {
    case 'models.setDefault': {
      const modelPayload = payload as OperationMap['models.setDefault']['payload']
      return JSON.stringify({ provider: modelPayload.provider, model: modelPayload.model })
    }
    case 'skills.toggle': {
      const skillPayload = payload as OperationMap['skills.toggle']['payload']
      return JSON.stringify({ name: skillPayload.name, enabled: skillPayload.enabled })
    }
    case 'cron.create': {
      const cronPayload = payload as OperationMap['cron.create']['payload']
      return JSON.stringify({
        schedule: cronPayload.schedule, prompt: cronPayload.prompt, name: cronPayload.name,
        deliver: cronPayload.deliver, confirm: cronPayload.confirm,
      })
    }
    case 'cron.update': {
      const cronPayload = payload as OperationMap['cron.update']['payload']
      return JSON.stringify({ fields: cronPayload.fields, confirm: cronPayload.confirm })
    }
    case 'cron.action': {
      const cronPayload = payload as OperationMap['cron.action']['payload']
      return JSON.stringify({ action: cronPayload.action, confirm: cronPayload.confirm })
    }
    case 'backups.create':
      return JSON.stringify({ confirm: (payload as OperationMap['backups.create']['payload']).confirm })
    case 'backups.schedule.set': {
      const schedulePayload = payload as OperationMap['backups.schedule.set']['payload']
      return JSON.stringify({ calendar: schedulePayload.calendar, confirm: schedulePayload.confirm })
    }
    case 'backups.inspect':
      return JSON.stringify({ source: (payload as OperationMap['backups.inspect']['payload']).source })
    case 'backups.restore': {
      const restorePayload = payload as OperationMap['backups.restore']['payload']
      return JSON.stringify({
        source: restorePayload.source, paths: restorePayload.paths,
        all_files: restorePayload.allFiles, confirm: restorePayload.confirm,
      })
    }
    default:
      return undefined
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw new BackendTransportError('invalid_response')
    if (Number(declaredLength) > MAX_BACKEND_RESPONSE_BYTES) {
      throw new BackendTransportError('response_too_large')
    }
  }

  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_BACKEND_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new BackendTransportError('response_too_large')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof BackendTransportError) throw error
    throw new BackendTransportError('invalid_response')
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The stream may already have been cancelled as oversized.
    }
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function parseJsonResponse(bytes: Uint8Array, contentType: string | null): unknown {
  if (contentType) {
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
    if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
      throw new BackendTransportError('invalid_response')
    }
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value: unknown = JSON.parse(text)
    if (!isBoundedIpcPayload(value, RESPONSE_PAYLOAD_LIMITS)) {
      throw new BackendTransportError('invalid_response')
    }
    return value
  } catch (error) {
    if (error instanceof BackendTransportError) throw error
    throw new BackendTransportError('invalid_response')
  }
}

const LOCAL_CODEX_REQUEST_LIMITS: BoundedPayloadLimits = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 2_000,
  maxStringLength: 32 * 1024,
  maxArrayLength: 256,
  maxObjectKeys: 64,
})

function localCodexId(value: unknown, prefix: string, maxLength: number): value is string {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length
    && value.length <= maxLength && /^[A-Za-z0-9._:-]+$/u.test(value.slice(prefix.length))
}

function localCodexRequestDetails(request: LocalCodexProxyRequest): {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: string
  expectedStatus?: 201
} {
  const api = '/api/local/codex'
  switch (request.operation) {
    case 'projects.list':
      return { method: 'GET', path: `${api}/projects` }
    case 'sessions.list':
      if (!localCodexId(request.projectId, 'codex-project:', 256)) break
      return { method: 'GET', path: `${api}/projects/${encodeURIComponent(request.projectId)}/sessions` }
    case 'workspaces.register':
      if (typeof request.rootPath !== 'string' || !request.rootPath.startsWith('/') || request.rootPath.length > 16_000) break
      return { method: 'POST', path: `${api}/workspaces/register`, body: JSON.stringify({ rootPath: request.rootPath }) }
    case 'turns.start':
      if (!localCodexId(request.projectId, 'codex-project:', 256)
        || typeof request.prompt !== 'string' || request.prompt.length > 8_000 || !request.prompt.trim()
        || (request.sessionId !== undefined && !localCodexId(request.sessionId, 'codex:', 256))) break
      return {
        method: 'POST', path: `${api}/turns`,
        body: JSON.stringify({
          projectId: request.projectId,
          prompt: request.prompt,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        }),
      }
    case 'turns.cancel':
      if (!localCodexId(request.taskId, 'codex-task:', 256)) break
      return { method: 'POST', path: `${api}/turns/${encodeURIComponent(request.taskId)}/cancel`, body: '{}' }
    case 'turns.list':
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 16) break
      return { method: 'GET', path: `${api}/turns?limit=${request.limit}` }
    case 'turns.status':
      if (!localCodexId(request.taskId, 'codex-task:', 256)) break
      return { method: 'GET', path: `${api}/turns/${encodeURIComponent(request.taskId)}` }
    case 'approvals.answer':
      if (typeof request.approvalId !== 'string' || request.approvalId.length > 128
        || !/^[A-Za-z0-9._:-]+$/u.test(request.approvalId) || typeof request.allow !== 'boolean') break
      return {
        method: 'POST', path: `${api}/approvals/${encodeURIComponent(request.approvalId)}`,
        body: JSON.stringify({ allow: request.allow }),
      }
    case 'events.list': {
      if (!Number.isSafeInteger(request.after) || request.after < 0
        || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 64) break
      const params = new URLSearchParams({ after: String(request.after), limit: String(request.limit) })
      return { method: 'GET', path: `${api}/events?${params.toString()}` }
    }
    case 'workspace.terminals.list':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)) break
      return { method: 'GET', path: `/api/local/workspaces/${request.workspaceId}/terminals` }
    case 'workspace.terminals.create':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 1) break
      return { method: 'POST', path: `/api/local/workspaces/${request.workspaceId}/terminals`, body: JSON.stringify({ expectedGeneration: request.expectedGeneration }), expectedStatus: 201 }
    case 'workspace.terminals.screen':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)
        || !Number.isInteger(request.lines) || request.lines < 1 || request.lines > 120) break
      return { method: 'GET', path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}/screen?lines=${request.lines}` }
    case 'workspace.terminals.input':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)
        || typeof request.line !== 'string' || request.line.length === 0
        || /[\u0000-\u001f\u007f]/u.test(request.line)
        || new TextEncoder().encode(request.line).byteLength > 4096) break
      return { method: 'POST', path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}/input`, body: JSON.stringify({ line: request.line }) }
    case 'workspace.terminals.interrupt':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)) break
      return { method: 'POST', path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}/interrupt` }
    case 'workspace.terminals.stop':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)) break
      return { method: 'DELETE', path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}`, body: JSON.stringify({ confirm: true }) }
    case 'workspace.terminals.attach.open':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)
        || !Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 1
        || (request.mode !== 'control' && request.mode !== 'read-only')) break
      return {
        method: 'POST',
        path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}/attach`,
        body: JSON.stringify({ expectedGeneration: request.expectedGeneration, mode: request.mode }),
        expectedStatus: 201,
      }
    case 'workspace.terminals.attach.claim':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)
        || !/^watt-[0-9a-f]{32}$/u.test(request.ticket)) break
      return { method: 'POST', path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}/attach/${request.ticket}/claim` }
    case 'workspace.terminals.attach.screen':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)
        || !/^watt-[0-9a-f]{32}$/u.test(request.attachId)
        || !Number.isInteger(request.lines) || request.lines < 1 || request.lines > 120) break
      return { method: 'GET', path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}/attach/${request.attachId}/screen?lines=${request.lines}` }
    case 'workspace.terminals.attach.input': {
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)
        || !/^watt-[0-9a-f]{32}$/u.test(request.attachId)
        || !Array.isArray(request.events) || request.events.length < 1 || request.events.length > 32) break
      const namedKeys = new Set(['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
        'BSpace', 'Tab', 'BTab', 'DC', 'IC', 'Escape', 'Enter', 'Space',
        'C-c', 'C-d', 'C-z', 'C-l', 'C-a', 'C-e', 'C-u', 'C-k', 'C-w'])
      let total = 0
      let valid = true
      for (const event of request.events) {
        if (!event || typeof event !== 'object' || Object.keys(event).length !== 2
          || (event.type !== 'text' && event.type !== 'key')) { valid = false; break }
        if (event.type === 'text') {
          if (typeof event.value !== 'string' || event.value.length === 0
            || /[\u0000-\u001f\u007f]/u.test(event.value)) { valid = false; break }
          total += new TextEncoder().encode(event.value).byteLength
          if (total > 1024) { valid = false; break }
        } else if (typeof event.value !== 'string' || !namedKeys.has(event.value)) { valid = false; break }
      }
      if (!valid) break
      return {
        method: 'POST',
        path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}/attach/${request.attachId}/input`,
        body: JSON.stringify({ events: request.events }),
      }
    }
    case 'workspace.terminals.attach.detach':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^wterm-[0-9a-f]{32}$/u.test(request.sessionId)
        || !/^watt-[0-9a-f]{32}$/u.test(request.attachId)) break
      return { method: 'DELETE', path: `/api/local/workspaces/${request.workspaceId}/terminals/${request.sessionId}/attach/${request.attachId}` }
    case 'workspace.services.list':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)) break
      return { method: 'GET', path: `/api/local/workspaces/${request.workspaceId}/services` }
    case 'workspace.languageProfiles.list':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)) break
      return { method: 'GET', path: `/api/local/workspaces/${request.workspaceId}/language-profiles` }
    case 'workspace.services.define':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^[a-z][a-z0-9-]{0,31}$/u.test(request.definition.name)) break
      return {
        method: 'PUT',
        path: `/api/local/workspaces/${request.workspaceId}/services/${request.definition.name}`,
        body: JSON.stringify(request.definition),
      }
    case 'workspace.services.codeServer':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)) break
      // The IDE binds a private unix socket; no loopback port is chosen or sent.
      return {
        method: 'POST',
        path: `/api/local/workspaces/${request.workspaceId}/services/code-server`,
        body: JSON.stringify({}),
        expectedStatus: 201,
      }
    case 'workspace.services.remove':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^[a-z][a-z0-9-]{0,31}$/u.test(request.name)) break
      return { method: 'DELETE', path: `/api/local/workspaces/${request.workspaceId}/services/${request.name}`, body: JSON.stringify({ confirm: request.confirm }) }
    case 'workspace.services.start':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^[a-z][a-z0-9-]{0,31}$/u.test(request.name)) break
      return { method: 'POST', path: `/api/local/workspaces/${request.workspaceId}/services/${request.name}/start` }
    case 'workspace.services.stop':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^[a-z][a-z0-9-]{0,31}$/u.test(request.name)) break
      return { method: 'POST', path: `/api/local/workspaces/${request.workspaceId}/services/${request.name}/stop`, body: JSON.stringify({ confirm: request.confirm }) }
    case 'workspace.services.logs':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^[a-z][a-z0-9-]{0,31}$/u.test(request.name)
        || !Number.isInteger(request.lines) || request.lines < 1 || request.lines > 400) break
      return { method: 'GET', path: `/api/local/workspaces/${request.workspaceId}/services/${request.name}/logs?lines=${request.lines}` }
    case 'workspace.services.preview.open':
      if (!/^workspace-[0-9a-f]{32}$/u.test(request.workspaceId)
        || !/^[a-z][a-z0-9-]{0,31}$/u.test(request.name)
        || !Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 1
        || (request.portName !== null && !/^[a-z][a-z0-9-]{0,15}$/u.test(request.portName))) break
      return {
        method: 'POST',
        path: `/api/local/workspaces/${request.workspaceId}/services/${request.name}/preview`,
        body: JSON.stringify({ expectedGeneration: request.expectedGeneration, portName: request.portName }),
        expectedStatus: 201,
      }
  }
  throw new BackendTransportError('invalid_payload')
}

function generationChanged(transport: BackendTransport, generation: number): boolean {
  return transport.generation !== generation
}

/** Fixed-route, memory-only transport for read-only state plus narrow task, workspace and conversation-removal actions. */
export class BackendTransport {
  private readonly fetchImpl: BackendFetch
  private activeConnection: ActiveConnection | undefined
  private readonly pending = new Set<AbortController>()
  private currentGeneration = 0

  constructor(options: BackendTransportOptions = {}) {
    const hasServerUrl = options.serverUrl !== undefined
    const hasToken = options.token !== undefined
    if (hasServerUrl !== hasToken) invalidConnection()

    const fetchImplementation = options.fetch ?? globalThis.fetch
    if (typeof fetchImplementation !== 'function') {
      throw new BackendTransportError('network_error')
    }
    this.fetchImpl = fetchImplementation

    if (hasServerUrl && hasToken) {
      this.switchConnection({ serverUrl: options.serverUrl as string, token: options.token as string })
    }
  }

  get generation(): number {
    return this.currentGeneration
  }

  /** Replace the in-memory credential and abort every request from its prior generation. */
  switchConnection(input: BackendConnectionInput): number {
    const validated = validateConnection(input)
    this.abortPending()
    this.currentGeneration += 1
    this.activeConnection = {
      ...validated,
      generation: this.currentGeneration,
    }
    return this.currentGeneration
  }

  /** Clear the credential, abort requests, and advance the stale-response fence. */
  disconnect(): number {
    this.abortPending()
    this.activeConnection = undefined
    this.currentGeneration += 1
    return this.currentGeneration
  }

  async invoke<K extends OperationName>(
    operation: K,
    payload: OperationMap[K]['payload'],
  ): Promise<OperationMap[K]['result']> {
    let normalizedPayload: OperationMap[K]['payload']
    if (!isOperationName(operation)) throw new BackendTransportError('unsupported_operation')
    try {
      if (!isBoundedIpcPayload(payload, ipcPayloadLimitsForOperation(operation))) throw new BackendTransportError('invalid_payload')
      normalizedPayload = parseOperationPayload(operation, payload)
    } catch (error) {
      if (error instanceof BackendTransportError) throw error
      throw new BackendTransportError('invalid_payload')
    }

    const connection = this.activeConnection
    if (!connection) throw new BackendTransportError('not_connected')

    const controller = new AbortController()
    this.pending.add(controller)
    try {
      const url = operationUrl(
        connection.origin,
        connection.basePath,
        operation,
        normalizedPayload as OperationMap[OperationName]['payload'],
      )
      const body = requestBody(operation, normalizedPayload as OperationMap[OperationName]['payload'])
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${connection.token}`,
      }
      if (operation === 'projects.create' || operation === 'tasks.submit' || operation === 'workspaces.provision' ||
          operation === 'workspaces.files.write' || operation === 'workspaces.files.create' || operation === 'sessions.delete' ||
          operation === 'audio.transcribe') {
        headers['Content-Type'] = 'application/json'
      }
      if (body !== undefined && OPERATIONS_PAGE_OPERATIONS.includes(operation)) {
        headers['Content-Type'] = 'application/json'
      }
      if (operation === 'tasks.submit') {
        // Generate once per user invocation. This transport never retries an
        // ambiguous POST, and the renderer never chooses or receives this key.
        headers['Idempotency-Key'] = randomUUID()
      }
      const response = await this.fetchImpl(url, {
        method: OPERATION_METHODS[operation],
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: controller.signal,
      })
      if (generationChanged(this, connection.generation)) {
        throw new BackendTransportError('connection_changed')
      }

      checkResponseStatus(operation, response)
      const bytes = await readBoundedBody(response)
      if (generationChanged(this, connection.generation)) {
        throw new BackendTransportError('connection_changed')
      }
      const result = parseJsonResponse(bytes, response.headers.get('content-type'))
      if (!isSupportedResult(operation, normalizedPayload as OperationMap[OperationName]['payload'], result)) {
        throw new BackendTransportError('invalid_response')
      }
      if (
        operation === 'readiness' &&
        ((response.status === 503 && result.dispatch_ready !== false) ||
          (response.status === 200 && result.dispatch_ready !== true))
      ) {
        throw new BackendTransportError('invalid_response')
      }
      return result as OperationMap[K]['result']
    } catch (error) {
      if (generationChanged(this, connection.generation)) {
        throw new BackendTransportError('connection_changed')
      }
      if (error instanceof BackendTransportError) throw error
      throw new BackendTransportError('network_error')
    } finally {
      this.pending.delete(controller)
    }
  }

  /** Main-process-only local owner routes; retries are left to no caller, especially for startTurn. */
  async invokeLocalCodex(request: LocalCodexProxyRequest): Promise<unknown> {
    if (!isBoundedIpcPayload(request, LOCAL_CODEX_REQUEST_LIMITS)) {
      throw new BackendTransportError('invalid_payload')
    }
    const details = localCodexRequestDetails(request)
    const connection = this.activeConnection
    if (!connection) throw new BackendTransportError('not_connected')

    const controller = new AbortController()
    this.pending.add(controller)
    try {
      const url = new URL(`${connection.basePath}${details.path}`, connection.origin)
      const response = await this.fetchImpl(url, {
        method: details.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${connection.token}`,
          ...(details.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(details.body === undefined ? {} : { body: details.body }),
        redirect: 'manual',
        signal: controller.signal,
      })
      if (generationChanged(this, connection.generation)) {
        throw new BackendTransportError('connection_changed')
      }
      if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw new BackendTransportError('redirect_rejected')
      }
      if (response.status === 401 || response.status === 403) {
        throw new BackendTransportError('unauthorized', response.status)
      }
      if (response.status !== 200 && response.status !== details.expectedStatus) throw new BackendTransportError('http_error')
      const bytes = await readBoundedBody(response)
      if (generationChanged(this, connection.generation)) {
        throw new BackendTransportError('connection_changed')
      }
      return parseJsonResponse(bytes, response.headers.get('content-type'))
    } catch (error) {
      if (generationChanged(this, connection.generation)) {
        throw new BackendTransportError('connection_changed')
      }
      if (error instanceof BackendTransportError) throw error
      throw new BackendTransportError('network_error')
    } finally {
      this.pending.delete(controller)
    }
  }

  /** Probe auth and readiness without treating dispatch-unavailable HTTP 503 as auth failure. */
  async probe(): Promise<ConnectionProbeResult> {
    try {
      const readiness = await this.invoke('readiness', {})
      return { ok: true, readiness }
    } catch (error) {
      const failure = error instanceof BackendTransportError
        ? error
        : new BackendTransportError('network_error')
      return {
        ok: false,
        error: { code: failure.code, message: failure.message },
        ...(failure.code === 'unauthorized' && failure.httpStatus !== undefined
          ? { authStatus: failure.httpStatus }
          : {}),
      }
    }
  }

  private abortPending(): void {
    for (const controller of this.pending) controller.abort()
    this.pending.clear()
  }
}
