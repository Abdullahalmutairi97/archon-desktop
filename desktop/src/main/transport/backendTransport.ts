import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import type {
  ConnectionProbeResult,
  JsonRecord,
  OperationMap,
  OperationName,
} from '../../shared/bridge/types'
import { BRIDGE_CHANNELS, isOperationName, parseBridgeResponse, parseOperationPayload } from '../../shared/bridge/validation'
import {
  isBoundedIpcPayload,
  type BoundedPayloadLimits,
} from '../security/TrustedShellFrameGuard'

export const READ_ONLY_OPERATIONS: readonly OperationName[] = Object.freeze([
  'readiness',
  'projects.list',
  'sessions.list',
  'tasks.list',
  'events.cursor',
  'workspaces.list',
])

export const TASK_OPERATIONS: readonly OperationName[] = Object.freeze([
  'runtimes.list',
  'tasks.submit',
  'tasks.get',
  'tasks.events',
  'tasks.cancel',
])

const OPERATION_METHODS: Readonly<Record<OperationName, 'GET' | 'POST'>> = Object.freeze({
  readiness: 'GET',
  'projects.list': 'GET',
  'sessions.list': 'GET',
  'tasks.list': 'GET',
  'events.cursor': 'GET',
  'runtimes.list': 'GET',
  'tasks.submit': 'POST',
  'tasks.get': 'GET',
  'tasks.events': 'GET',
  'tasks.cancel': 'POST',
  'workspaces.list': 'GET',
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
  'sessions.list': '/api/sessions',
  'tasks.list': '/api/tasks',
  'events.cursor': '/api/events/cursor',
  'runtimes.list': '/api/runtimes',
  'tasks.submit': '/api/tasks',
  'tasks.get': '/api/tasks',
  'tasks.events': '/api/tasks',
  'tasks.cancel': '/api/tasks',
  'workspaces.list': '/api/workspaces',
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
  if (operation === 'tasks.get' || operation === 'tasks.events' || operation === 'tasks.cancel') {
    const taskPayload = payload as OperationMap['tasks.get']['payload']
    const taskId = encodeURIComponent(taskPayload.taskId)
    path += `/${taskId}`
    if (operation === 'tasks.events') path += '/events'
    if (operation === 'tasks.cancel') path += '/cancel'
  }
  const url = new URL(path, origin)
  if (operation === 'sessions.list') {
    const listPayload = payload as OperationMap['sessions.list']['payload']
    if (listPayload.projectId !== undefined) url.searchParams.set('project_id', listPayload.projectId)
    if (listPayload.limit !== undefined) url.searchParams.set('limit', String(listPayload.limit))
  } else if (operation === 'tasks.list') {
    const listPayload = payload as OperationMap['tasks.list']['payload']
    if (listPayload.limit !== undefined) url.searchParams.set('limit', String(listPayload.limit))
  } else if (operation === 'tasks.events') {
    const eventPayload = payload as OperationMap['tasks.events']['payload']
    url.searchParams.set('after', String(eventPayload.after))
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
    parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, value, operation)
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
  if (operation === 'readiness' && (response.status === 200 || response.status === 503)) return
  if (operation === 'tasks.submit') {
    if (response.status === 202) return
    throw new BackendTransportError('http_error')
  }
  if (operation !== 'readiness' && response.status === 200) return
  throw new BackendTransportError('http_error')
}

function requestBody(operation: OperationName, payload: OperationMap[OperationName]['payload']): string | undefined {
  if (operation !== 'tasks.submit') return undefined
  const submitPayload = payload as OperationMap['tasks.submit']['payload']
  return JSON.stringify({
    prompt: submitPayload.prompt,
    project_id: submitPayload.projectId,
    profile: 'prime',
    approval_mode: 'auto',
    chat_only: false,
  })
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

function generationChanged(transport: BackendTransport, generation: number): boolean {
  return transport.generation !== generation
}

/** Fixed-route, memory-only transport for read-only state plus narrow Prime task actions. */
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
      if (!isBoundedIpcPayload(payload)) throw new BackendTransportError('invalid_payload')
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
      if (operation === 'tasks.submit') {
        headers['Content-Type'] = 'application/json'
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
