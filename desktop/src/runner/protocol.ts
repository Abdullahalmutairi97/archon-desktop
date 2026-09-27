import type {
  LocalCodexEvent,
  LocalCodexProjectDto,
  LocalCodexSessionDto,
  LocalCodexTurnDto,
} from '../shared/bridge/types'
import {
  LOCAL_CODEX_CHANNELS,
  parseLocalCodexEvent,
  parseLocalCodexRequest,
  parseLocalCodexResponse,
} from '../shared/bridge/validation'

export const MAX_RUNNER_FRAME_BYTES = 128 * 1024
export const MAX_RUNNER_EVENT_HISTORY = 256
const MAX_IN_FLIGHT = 32
const MAX_EVENT_BATCH = 64

export type RunnerMethod =
  | 'listProjects'
  | 'listSessions'
  | 'registerWorkspaceRoot'
  | 'startTurn'
  | 'cancelTurn'
  | 'answerApproval'
  | 'events'

export interface RunnerEventRecord {
  readonly seq: number
  readonly event: LocalCodexEvent
}

export interface LocalCodexRunnerController {
  readonly hasActiveWork?: boolean
  listProjects(): Promise<readonly LocalCodexProjectDto[]>
  listSessions(projectId: string): Promise<readonly LocalCodexSessionDto[]>
  registerWorkspaceRoot(rootPath: string): Promise<LocalCodexProjectDto>
  startTurn(input: { projectId: string; prompt: string; sessionId?: string }): Promise<LocalCodexTurnDto>
  cancelTurn(input: { taskId: string }): Promise<boolean>
  answerApproval(input: { approvalId: string; allow: boolean }): boolean
  subscribe(listener: (event: LocalCodexEvent) => void): () => void
  close?(): void
}

export interface RunnerMessageSink {
  (message: RunnerWireMessage): void
}

export type RunnerWireMessage =
  | { id: string | number; ok: true; result: unknown }
  | { id: string | number | null; ok: false; error: { code: string; message: string } }
  | { event: RunnerEventRecord }

interface ParsedRequest {
  id: string | number
  method: string
  params: Record<string, unknown>
}

interface RunnerRpcError {
  code: string
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownDataRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Invalid request.')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new TypeError('Invalid request.')
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError('Invalid request.')
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Invalid request.')
    result[key] = descriptor.value
  }
  return result
}

function exactRecord(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  const result = ownDataRecord(value, keys)
  if (required.some((key) => !(key in result))) throw new TypeError('Invalid request.')
  return result
}

function validRpcId(value: unknown): value is string | number {
  if (typeof value === 'string') return value.length > 0 && value.length <= 128 && !value.includes('\0')
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseRequest(value: unknown): ParsedRequest {
  const envelope = exactRecord(value, ['id', 'method', 'params'])
  if (!validRpcId(envelope.id) || typeof envelope.method !== 'string' || envelope.method.length < 1
    || envelope.method.length > 64 || envelope.method.includes('\0') || !isRecord(envelope.params)) {
    throw new TypeError('Invalid request.')
  }
  return { id: envelope.id, method: envelope.method, params: envelope.params }
}

function parseEventsParams(value: unknown): { after: number; limit: number } {
  const params = exactRecord(value, ['after', 'limit'], [])
  const after = params.after ?? 0
  const limit = params.limit ?? 32
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0
    || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_BATCH) {
    throw new TypeError('Invalid event cursor.')
  }
  return { after, limit }
}

function errorResponse(id: string | number | null, error: RunnerRpcError): RunnerWireMessage {
  return { id, ok: false, error }
}

function resultForController(channel: string, value: unknown): unknown {
  return parseLocalCodexResponse(channel, value)
}

/** Fixed, bounded RPC surface over a LocalCodexController-compatible owner. */
export class LocalCodexRunnerProtocol {
  private readonly eventHistory: RunnerEventRecord[] = []
  private readonly inFlightIds = new Set<string>()
  private readonly unsubscribe: () => void
  private nextEventSequence = 0
  private inputEnded = false
  private closed = false

  constructor(
    private readonly controller: LocalCodexRunnerController,
    private readonly send: RunnerMessageSink,
    private readonly onClosed: () => void = () => undefined,
  ) {
    this.unsubscribe = controller.subscribe((event) => this.recordEvent(event))
  }

  /** Handle one decoded JSON value. Responses may resolve out of order; IDs correlate them. */
  async handle(value: unknown): Promise<RunnerWireMessage> {
    let request: ParsedRequest
    try {
      request = parseRequest(value)
    } catch {
      return errorResponse(null, { code: 'invalid_request', message: 'Invalid runner request.' })
    }

    const idKey = `${typeof request.id}:${String(request.id)}`
    if (this.inFlightIds.has(idKey)) {
      return errorResponse(request.id, { code: 'duplicate_id', message: 'Request id is already in use.' })
    }
    if (this.inFlightIds.size >= MAX_IN_FLIGHT) {
      return errorResponse(request.id, { code: 'busy', message: 'Runner is busy.' })
    }
    this.inFlightIds.add(idKey)
    try {
      const result = await this.dispatch(request.method, request.params)
      return { id: request.id, ok: true, result }
    } catch (error) {
      if (error instanceof UnknownMethodError) {
        return errorResponse(request.id, { code: 'method_not_found', message: 'Unknown runner method.' })
      }
      if (error instanceof TypeError) {
        return errorResponse(request.id, { code: 'invalid_params', message: 'Invalid request parameters.' })
      }
      return errorResponse(request.id, { code: 'request_failed', message: 'Local Codex request failed.' })
    } finally {
      this.inFlightIds.delete(idKey)
      this.closeIfIdle()
    }
  }

  /** Deliver a completed RPC response through the same bounded JSONL sink as events. */
  async receive(line: string): Promise<void> {
    if (Buffer.byteLength(line, 'utf8') > MAX_RUNNER_FRAME_BYTES) {
      this.sendBounded(errorResponse(null, { code: 'frame_too_large', message: 'Runner frame exceeds the size limit.' }))
      return
    }
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      this.sendBounded(errorResponse(null, { code: 'invalid_json', message: 'Invalid JSON request.' }))
      return
    }
    this.sendBounded(await this.handle(value))
  }

  receiveOversizedFrame(): void {
    this.sendBounded(errorResponse(null, { code: 'frame_too_large', message: 'Runner frame exceeds the size limit.' }))
  }

  /** Input EOF is a detach signal. Keep the controller alive until its active turn ends. */
  inputClosed(): void {
    this.inputEnded = true
    this.closeIfIdle()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    this.controller.close?.()
    this.onClosed()
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method as RunnerMethod) {
      case 'listProjects': {
        exactRecord(params, [])
        const request = parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.listProjects, [])
        const projects = await this.controller.listProjects()
        return resultForController(request.channel, projects)
      }
      case 'listSessions': {
        const request = parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.listSessions, [params])
        const projectId = (request.args[0] as { projectId: string }).projectId
        return resultForController(request.channel, await this.controller.listSessions(projectId))
      }
      case 'registerWorkspaceRoot': {
        const record = exactRecord(params, ['rootPath'])
        if (typeof record.rootPath !== 'string' || !record.rootPath.startsWith('/')
          || record.rootPath.length > 16_000 || /[\u0000-\u001f\u007f]/.test(record.rootPath)) {
          throw new TypeError('Invalid project root.')
        }
        return resultForController(
          LOCAL_CODEX_CHANNELS.registerWorkspace,
          await this.controller.registerWorkspaceRoot(record.rootPath),
        )
      }
      case 'startTurn': {
        const request = parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.startTurn, [params])
        const input = request.args[0] as { projectId: string; prompt: string; sessionId?: string }
        return resultForController(request.channel, await this.controller.startTurn(input))
      }
      case 'cancelTurn': {
        const request = parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.cancelTurn, [params])
        return resultForController(request.channel, await this.controller.cancelTurn(request.args[0] as { taskId: string }))
      }
      case 'answerApproval': {
        const request = parseLocalCodexRequest(LOCAL_CODEX_CHANNELS.answerApproval, [params])
        return resultForController(request.channel, this.controller.answerApproval(
          request.args[0] as { approvalId: string; allow: boolean },
        ))
      }
      case 'events':
        return this.readEvents(params)
      default:
        throw new UnknownMethodError()
    }
  }

  private readEvents(params: Record<string, unknown>): unknown {
    const { after, limit } = parseEventsParams(params)
    const latest = this.nextEventSequence
    const oldest = this.eventHistory[0]?.seq ?? latest + 1
    const reset = after > latest || after < oldest - 1
    const start = after > latest ? latest : after
    const candidates = this.eventHistory.filter((record) => record.seq > start).slice(0, limit)
    const events: RunnerEventRecord[] = []
    for (const candidate of candidates) {
      const next = [...events, candidate]
      const cursor = candidate.seq
      const result = { cursor, latest, oldest, reset, events: next }
      const worstCaseResponse = { id: 'x'.repeat(128), ok: true, result }
      if (Buffer.byteLength(JSON.stringify(worstCaseResponse), 'utf8') > MAX_RUNNER_FRAME_BYTES) break
      events.push(candidate)
    }
    const cursor = events.at(-1)?.seq ?? start
    return Object.freeze({
      cursor,
      latest,
      oldest,
      reset,
      events: Object.freeze(events),
    })
  }

  private recordEvent(value: LocalCodexEvent): void {
    let event: LocalCodexEvent
    try {
      event = parseLocalCodexEvent(value)
    } catch {
      return
    }
    const record: RunnerEventRecord = Object.freeze({ seq: ++this.nextEventSequence, event })
    this.eventHistory.push(record)
    if (this.eventHistory.length > MAX_RUNNER_EVENT_HISTORY) this.eventHistory.shift()
    this.sendBounded({ event: record })
    this.closeIfIdle()
  }

  private sendBounded(message: RunnerWireMessage): void {
    try {
      if (Buffer.byteLength(JSON.stringify(message), 'utf8') > MAX_RUNNER_FRAME_BYTES) {
        if ('id' in message) {
          this.send(errorResponse(message.id, { code: 'result_too_large', message: 'Runner response exceeds the size limit.' }))
        }
        return
      }
      this.send(message)
    } catch {
      // A closed or failing parent output stream must not stop an active Codex turn.
    }
  }

  private closeIfIdle(): void {
    if (this.inputEnded && !this.closed && this.inFlightIds.size === 0 && this.controller.hasActiveWork !== true) {
      this.close()
    }
  }
}

class UnknownMethodError extends Error {}
