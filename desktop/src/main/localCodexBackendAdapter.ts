import type {
  LocalCodexEvent,
  LocalCodexProjectDto,
  LocalCodexSessionDto,
  LocalCodexTurnDto,
} from '../shared/bridge/types'
import { LOCAL_CODEX_CHANNELS, parseLocalCodexEvent, parseLocalCodexResponse } from '../shared/bridge/validation'
import type { LocalCodexIpcController } from './registerLocalCodex'
import type { LocalCodexProxyRequest } from './localCodexProxy'

export interface LocalCodexBackendConnection {
  invokePairedLocalCodex(request: LocalCodexProxyRequest): Promise<unknown>
}

export interface LocalCodexBackendAdapterOptions {
  connection: LocalCodexBackendConnection
  /** Main-process directory picker; the returned path is submitted only over local pairing. */
  pickProjectDirectory?: () => Promise<string | null>
  /** Poll interval while connected and retry delay after a transient failure. */
  pollIntervalMs?: number
  retryIntervalMs?: number
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid Local Codex response')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Invalid Local Codex response')
  const actual = Reflect.ownKeys(value)
  if (actual.some((key) => typeof key !== 'string' || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError('Invalid Local Codex response')
  return value as Record<string, unknown>
}

function parseEventBatch(value: unknown): {
  cursor: number
  latest: number
  oldest: number
  reset: boolean
  events: readonly { seq: number; event: LocalCodexEvent }[]
} {
  const envelope = record(value, ['cursor', 'latest', 'oldest', 'reset', 'events'])
  if (!Number.isSafeInteger(envelope.cursor) || (envelope.cursor as number) < 0
    || !Number.isSafeInteger(envelope.latest) || (envelope.latest as number) < 0
    || !Number.isSafeInteger(envelope.oldest) || (envelope.oldest as number) < 0
    || (envelope.cursor as number) > (envelope.latest as number)
    || (envelope.oldest as number) > (envelope.latest as number) + 1
    || typeof envelope.reset !== 'boolean' || !Array.isArray(envelope.events) || envelope.events.length > 64) {
    throw new TypeError('Invalid Local Codex event batch')
  }
  const events = envelope.events.map((item) => {
    const entry = record(item, ['seq', 'event'])
    if (!Number.isSafeInteger(entry.seq) || (entry.seq as number) < 1 || (entry.seq as number) > (envelope.latest as number)) {
      throw new TypeError('Invalid Local Codex event sequence')
    }
    return { seq: entry.seq as number, event: parseLocalCodexEvent(entry.event) }
  })
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].seq <= events[index - 1].seq) throw new TypeError('Unordered Local Codex events')
  }
  return {
    cursor: envelope.cursor as number,
    latest: envelope.latest as number,
    oldest: envelope.oldest as number,
    reset: envelope.reset,
    events,
  }
}

function unwrapArray(value: unknown, name: 'projects' | 'sessions'): unknown[] {
  const envelope = record(value, [name])
  if (!Array.isArray(envelope[name])) throw new TypeError('Invalid Local Codex response')
  return envelope[name] as unknown[]
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** Main-process controller backed by the fixed local owner API. */
export class LocalCodexBackendAdapter implements LocalCodexIpcController {
  private readonly listeners = new Set<(event: LocalCodexEvent) => void>()
  private readonly pollIntervalMs: number
  private readonly retryIntervalMs: number
  private cursor = 0
  private pollEpoch = 0
  private closed = false

  constructor(private readonly options: LocalCodexBackendAdapterOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    this.retryIntervalMs = options.retryIntervalMs ?? 1_500
  }

  async listProjects(): Promise<readonly LocalCodexProjectDto[]> {
    const result = await this.options.connection.invokePairedLocalCodex({ operation: 'projects.list' })
    return parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listProjects, unwrapArray(result, 'projects')) as readonly LocalCodexProjectDto[]
  }

  async listSessions(projectId: string): Promise<readonly LocalCodexSessionDto[]> {
    const result = await this.options.connection.invokePairedLocalCodex({ operation: 'sessions.list', projectId })
    return parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.listSessions, unwrapArray(result, 'sessions')) as readonly LocalCodexSessionDto[]
  }

  /** The backend owner has no native folder picker; workspace registration is the supported path. */
  async registerProject(): Promise<LocalCodexProjectDto | null> {
    if (!this.options.pickProjectDirectory) throw new Error('Local Codex project picker is unavailable.')
    const rootPath = await this.options.pickProjectDirectory()
    if (rootPath === null) return null
    return this.registerWorkspaceRoot(rootPath)
  }

  async registerWorkspaceRoot(rootPath: string): Promise<LocalCodexProjectDto> {
    const result = await this.options.connection.invokePairedLocalCodex({ operation: 'workspaces.register', rootPath })
    return parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.registerWorkspace, result) as LocalCodexProjectDto
  }

  async startTurn(input: { projectId: string; prompt: string; sessionId?: string }): Promise<LocalCodexTurnDto> {
    const result = await this.options.connection.invokePairedLocalCodex({ operation: 'turns.start', ...input })
    const turn = parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.startTurn, result) as LocalCodexTurnDto
    if (turn.projectId !== input.projectId || (input.sessionId !== undefined && turn.sessionId !== input.sessionId)) {
      throw new TypeError('Local Codex returned a turn for a different project or session')
    }
    return turn
  }

  async cancelTurn(input: { taskId: string }): Promise<boolean> {
    const result = await this.options.connection.invokePairedLocalCodex({ operation: 'turns.cancel', taskId: input.taskId })
    return parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.cancelTurn, record(result, ['cancelled']).cancelled) as boolean
  }

  async answerApproval(input: { approvalId: string; allow: boolean }): Promise<boolean> {
    const result = await this.options.connection.invokePairedLocalCodex({ operation: 'approvals.answer', ...input })
    return parseLocalCodexResponse(LOCAL_CODEX_CHANNELS.answerApproval, record(result, ['answered']).answered) as boolean
  }

  subscribe(listener: (event: LocalCodexEvent) => void): () => void {
    if (this.closed) throw new Error('Local Codex adapter is closed')
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      const epoch = ++this.pollEpoch
      void this.poll(epoch)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.pollEpoch += 1
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pollEpoch += 1
    this.listeners.clear()
  }

  private async poll(epoch: number): Promise<void> {
    while (!this.closed && epoch === this.pollEpoch && this.listeners.size > 0) {
      let delay = this.pollIntervalMs
      try {
        const response = await this.options.connection.invokePairedLocalCodex({
          operation: 'events.list', after: this.cursor, limit: 64,
        })
        if (this.closed || epoch !== this.pollEpoch || this.listeners.size === 0) return
        const batch = parseEventBatch(response)
        if (batch.reset) this.cursor = Math.max(0, batch.oldest - 1)
        for (const item of batch.events) {
          if (item.seq <= this.cursor) continue
          this.cursor = item.seq
          for (const listener of [...this.listeners]) {
            try { listener(item.event) } catch { /* One renderer subscriber cannot break event delivery. */ }
          }
        }
        if ((batch.events.length === 0 && !batch.reset) || (batch.events.length > 0 && batch.events.length < 64)) {
          this.cursor = Math.max(this.cursor, batch.cursor)
        }
      } catch {
        delay = this.retryIntervalMs
      }
      await wait(delay)
    }
  }
}
