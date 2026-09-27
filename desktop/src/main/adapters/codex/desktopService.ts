import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CodexAppServerClient, CodexServerRequest } from './appServer'
import type { CodexApprovalBroker, ResolvedCodexApprovalContext } from './approvalBroker'
import { isCodexProjectId, makeCodexTaskId, toCodexSessionId } from './ids'
import type { OwnedCodexMetadataStore } from './metadata'

export const MAX_CODEX_PROMPT_CHARS = 8_000
export const MAX_CODEX_RESULT_CHARS = 8_000
const MAX_ITEMS = 64
const MAX_UPDATES = 1_000

type Status = 'starting' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
export interface CodexDesktopTurn {
  projectId: string
  sessionId: string | null
  taskId: string
  status: Status
  text: string
  progress: string
  truncated: boolean
  error: string | null
}
export interface CodexActiveBinding {
  projectId: string
  sessionId: string
  taskId: string
  threadId: string
  cwd: string
  processGeneration: number
  turnId?: string
}
export interface CodexDesktopServiceOptions {
  /** Supplied by trusted main-process project registration, never an IPC payload. */
  project: Readonly<{ id: string; cwd: string; name?: string }>
  appServer: Pick<CodexAppServerClient, 'start' | 'request' | 'onNotification' | 'processGeneration' | 'connected' | 'close'>
  metadata: Pick<OwnedCodexMetadataStore, 'read' | 'replace'>
  approvals: Pick<CodexApprovalBroker, 'activateProcess' | 'disconnectProcess' | 'close'>
  onEvent?: (turn: Readonly<CodexDesktopTurn>) => void
  turnTimeoutMs?: number
}
interface CachedItem { kind: 'command' | 'file'; command?: string; cwd: string; paths: string[] }
interface Operation {
  dto: CodexDesktopTurn
  generation?: number
  binding?: CodexActiveBinding
  turnId?: string
  launching: boolean
  mapped: boolean
  pendingTerminal?: Record<string, unknown>
  pendingTruncated?: boolean
  stopped: Promise<void>
  stop(): void
  cancelRequested: boolean
  interrupt?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  updates: number
  messages: Map<string, string>
  items: Map<string, CachedItem>
}
const terminal = (status: Status) => status === 'completed' || status === 'cancelled' || status === 'failed'
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,240}$/.test(value)
function directory(value: string): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !isAbsolute(value)
    || resolve(value) !== value || !lstatSync(value).isDirectory() || realpathSync(value) !== value) {
    throw new TypeError('Configured Codex directory must be an existing canonical directory.')
  }
  return value
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Finite main-process orchestration; neither this client nor its protocol is exposed by preload. */
export class CodexDesktopService {
  private readonly project: Readonly<{ id: string; cwd: string; name: string }>
  private readonly timeoutMs: number
  private readonly unsubscribe: () => void
  private current: Operation | undefined
  private starting = false
  private closed = false

  constructor(private readonly options: CodexDesktopServiceOptions) {
    if (!isCodexProjectId(options.project.id)) throw new TypeError('Invalid configured Codex project identity.')
    const name = options.project.name ?? 'Local Codex project'
    if (typeof name !== 'string' || !name.trim() || name.length > 300 || name.includes('\0')) throw new TypeError('Invalid configured project name.')
    this.project = Object.freeze({ id: options.project.id, cwd: directory(options.project.cwd), name })
    this.timeoutMs = options.turnTimeoutMs ?? 15 * 60_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60 * 60_000) throw new TypeError('Invalid Codex turn deadline.')
    this.unsubscribe = options.appServer.onNotification((method, params, generation) => this.receive(method, params, generation))
  }

  snapshot(): Readonly<CodexDesktopTurn> | null {
    return this.current ? Object.freeze({ ...this.current.dto }) : null
  }

  get activeBinding(): Readonly<CodexActiveBinding> | null {
    const op = this.current
    return op?.binding && !terminal(op.dto.status) ? Object.freeze({ ...op.binding, ...(op.turnId ? { turnId: op.turnId } : {}) }) : null
  }

  isTaskActive(taskId: string, sessionId: string, generation: number): boolean {
    const op = this.current
    return !!op?.binding && !!op.turnId && op.mapped && !op.pendingTerminal && !op.cancelRequested && !terminal(op.dto.status)
      && op.dto.taskId === taskId && op.binding.sessionId === sessionId && op.generation === generation
      && this.options.appServer.connected && this.options.appServer.processGeneration === generation
  }

  async startTurn(prompt: string): Promise<Readonly<CodexDesktopTurn>> {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_CODEX_PROMPT_CHARS || prompt.includes('\0')) throw new TypeError('Invalid or oversized Codex prompt.')
    if (this.closed) throw new Error('Local Codex service is closed.')
    if (this.starting || (this.current && !terminal(this.current.dto.status))) throw new Error('A local Codex task is already active.')
    directory(this.project.cwd)
    this.starting = true
    let stop!: () => void
    const stopped = new Promise<void>((resolveStop) => { stop = resolveStop })
    const op: Operation = { stopped, stop, mapped: false, dto: { projectId: this.project.id, sessionId: null, taskId: makeCodexTaskId(), status: 'starting', text: '', progress: 'Starting local Codex', truncated: false, error: null }, launching: false, cancelRequested: false, updates: 0, messages: new Map(), items: new Map() }
    this.current = op
    op.timer = setTimeout(() => this.abort(op, 'Codex did not finish before the turn deadline. Its outcome may be incomplete.'), this.timeoutMs)
    this.publish(op)
    try {
      op.generation = await this.waitFor(op, this.options.appServer.start())
      this.connection(op)
      this.options.approvals.activateProcess(op.generation)
      if (op.cancelRequested) { this.finish(op, 'cancelled'); return this.snapshot()! }
      const response = await this.waitFor(op, this.options.appServer.request('thread/start', {
        cwd: this.project.cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write',
      }))
      this.connection(op)
      const threadId = this.threadIdentity(response)
      const sessionId = toCodexSessionId(threadId)
      op.binding = { projectId: this.project.id, sessionId, taskId: op.dto.taskId, threadId, cwd: this.project.cwd, processGeneration: op.generation }
      op.dto.sessionId = sessionId
      await this.persistSession(op, prompt)
      this.connection(op)
      if (op.cancelRequested) { this.finish(op, 'cancelled'); return this.snapshot()! }
      directory(this.project.cwd)
      op.launching = true
      const started = await this.waitFor(op, this.options.appServer.request('turn/start', {
        threadId, cwd: this.project.cwd, input: [{ type: 'text', text: prompt, text_elements: [] }],
        approvalPolicy: 'untrusted', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.project.cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
      }))
      this.connection(op)
      if (!record(started) || !record(started.turn) || !nativeId(started.turn.id)
        || !['inProgress', 'completed', 'interrupted', 'failed'].includes(String(started.turn.status))) throw new Error('Invalid turn response.')
      if (op.turnId && op.turnId !== started.turn.id) throw new Error('Turn identity changed.')
      op.turnId = started.turn.id
      op.launching = false
      await this.persistTurn(op)
      op.mapped = true
      if (op.pendingTerminal) this.complete(op, op.pendingTerminal)
      if (!terminal(op.dto.status)) {
        this.connection(op)
        if (op.cancelRequested) await this.interrupt(op)
        else if (started.turn.status !== 'inProgress') this.complete(op, started.turn)
        else { op.dto.status = 'running'; op.dto.progress = 'Codex is working'; this.publish(op) }
      }
    } catch {
      if (!terminal(op.dto.status)) {
        if (op.launching || op.turnId) this.abort(op, 'Could not safely track the Codex turn. Its outcome may be incomplete.')
        else this.finish(op, 'failed', 'Could not start the local Codex turn safely.')
      }
    } finally {
      this.starting = false
    }
    return Object.freeze({ ...op.dto })
  }

  async cancel(taskId: string): Promise<void> {
    const op = this.current
    if (!op || op.dto.taskId !== taskId || terminal(op.dto.status)) throw new Error('No matching active Codex task.')
    op.cancelRequested = true
    op.dto.status = 'cancelling'
    op.dto.progress = 'Waiting for Codex to confirm interruption'
    if (op.generation) this.options.approvals.disconnectProcess(op.generation)
    this.publish(op)
    if (op.turnId) await this.interrupt(op)
  }

  onDisconnect(generation: number): void {
    const op = this.current
    this.options.approvals.disconnectProcess(generation)
    if (op?.generation === generation && !terminal(op.dto.status)) this.finish(op, 'failed', 'Codex disconnected. Its execution outcome is unknown; the turn will not be replayed.')
  }

  resolveApprovalContext(request: CodexServerRequest): ResolvedCodexApprovalContext | undefined {
    // A path list is not enough to review file content. Decline file approvals until
    // an exact bounded diff can be shown in the trusted approval dialog.
    if (request.method === 'item/fileChange/requestApproval') return undefined
    const op = this.current
    if (!op?.binding || !this.isTaskActive(op.dto.taskId, op.binding.sessionId, request.processGeneration)) return undefined
    const params = request.params
    if (params.threadId !== op.binding.threadId || params.turnId !== op.turnId || !nativeId(params.itemId)) return undefined
    const item = op.items.get(params.itemId)
    if (!item || (params.reason != null && (typeof params.reason !== 'string' || params.reason.length > 4096 || params.reason.includes('\0')))) return undefined
    try { directory(this.project.cwd) } catch { return undefined }
    const common = { sessionId: op.binding.sessionId, taskId: op.dto.taskId, threadId: op.binding.threadId, cwd: item.cwd, reason: typeof params.reason === 'string' ? params.reason : 'Codex requests approval for this operation.' }
    if (request.method === 'item/commandExecution/requestApproval' && item.kind === 'command') {
      if ((params.command != null && params.command !== item.command) || (params.cwd != null && params.cwd !== item.cwd)
        || (params.kind != null && params.kind !== 'command') || params.networkApprovalContext != null
        || params.additionalPermissions != null || params.proposedNetworkPolicyAmendments != null || params.environmentId != null) return undefined
      try { if (!within(this.project.cwd, directory(item.cwd))) return undefined } catch { return undefined }
      return this.boundedApproval({ ...common, kind: 'command', command: item.command!, paths: [] })
    }
    return undefined
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.current && !terminal(this.current.dto.status)) this.finish(this.current, 'failed', 'Local Codex was closed. Its execution outcome may be incomplete.')
    this.unsubscribe()
    this.options.approvals.close()
    this.options.appServer.close()
  }

  private boundedApproval(context: ResolvedCodexApprovalContext): ResolvedCodexApprovalContext | undefined {
    // Leave room for broker/IPC identifiers; do not truncate an approval's scope.
    return Buffer.byteLength(JSON.stringify(context), 'utf8') <= 48 * 1024 ? context : undefined
  }

  private waitFor<T>(op: Operation, pending: Promise<T>): Promise<T> {
    if (this.closed || terminal(op.dto.status)) return Promise.reject(new Error('Codex operation ended.'))
    return Promise.race([pending, op.stopped.then(() => { throw new Error('Codex operation ended.') })])
  }

  private connection(op: Operation): void {
    if (this.closed || this.current !== op || !Number.isSafeInteger(op.generation) || !op.generation
      || !this.options.appServer.connected || this.options.appServer.processGeneration !== op.generation) throw new Error('Codex connection changed.')
  }

  private threadIdentity(value: unknown): string {
    if (!record(value) || !record(value.thread) || !nativeId(value.thread.id) || value.cwd !== this.project.cwd
      || value.thread.cwd !== this.project.cwd || value.thread.sessionId !== value.thread.id
      || value.approvalPolicy !== 'untrusted' || value.approvalsReviewer !== 'user' || !record(value.sandbox)
      || value.sandbox.type !== 'workspaceWrite' || (value.sandbox.networkAccess !== undefined && value.sandbox.networkAccess !== false)) throw new Error('Unexpected Codex thread configuration.')
    const roots = value.sandbox.writableRoots ?? []
    if (!Array.isArray(roots) || roots.length > 64 || roots.some((root) => typeof root !== 'string' || !within(this.project.cwd, directory(root)))) throw new Error('Unexpected Codex writable roots.')
    return value.thread.id
  }

  private async persistSession(op: Operation, prompt: string): Promise<void> {
    const saved = await this.waitFor(op, this.options.metadata.read())
    const existing = saved.projects.find((project) => project.id === this.project.id)
    if (existing && existing.primary_path !== this.project.cwd) throw new Error('Configured project identity changed.')
    if (saved.sessions.some((session) => session.id === op.binding!.sessionId)) throw new Error('New thread identity already exists.')
    await this.waitFor(op, this.options.metadata.replace({ ...saved,
      projects: existing ? saved.projects : [...saved.projects, { id: this.project.id, name: this.project.name, primary_path: this.project.cwd, runtime: 'codex' }],
      sessions: [...saved.sessions, { id: op.binding!.sessionId, threadId: op.binding!.threadId, title: prompt.trim().slice(0, 120), cwd: this.project.cwd, projectId: this.project.id, turns: [] }],
    }))
  }

  private async persistTurn(op: Operation): Promise<void> {
    const saved = await this.waitFor(op, this.options.metadata.read())
    const session = saved.sessions.find((entry) => entry.id === op.binding!.sessionId)
    if (!session || session.cwd !== this.project.cwd || session.projectId !== this.project.id || session.threadId !== op.binding!.threadId) throw new Error('Owned session identity changed.')
    if (session.turns.some((turn) => turn.id === op.dto.taskId || turn.turnId === op.turnId)) throw new Error('Turn identity already exists.')
    await this.waitFor(op, this.options.metadata.replace({ ...saved, sessions: saved.sessions.map((entry) => entry === session ? { ...entry, turns: [...entry.turns, { id: op.dto.taskId, turnId: op.turnId! }] } : entry) }))
  }

  private interrupt(op: Operation): Promise<void> {
    if (op.interrupt) return op.interrupt
    op.interrupt = (async () => {
      try {
        this.connection(op)
        await this.waitFor(op, this.options.appServer.request('turn/interrupt', { threadId: op.binding!.threadId, turnId: op.turnId! }))
        this.connection(op)
      } catch { this.abort(op, 'Codex interruption could not be confirmed. Its execution outcome is unknown.') }
    })()
    return op.interrupt
  }

  private receive(method: string, params: Record<string, unknown>, generation: number): void {
    const op = this.current
    if (!op?.binding || terminal(op.dto.status) || op.pendingTerminal || !this.options.appServer.connected || op.generation !== generation || this.options.appServer.processGeneration !== generation || params.threadId !== op.binding.threadId) return
    if (method === 'turn/started' && op.launching && !op.turnId && record(params.turn) && nativeId(params.turn.id)) {
      op.turnId = params.turn.id
      if (op.cancelRequested) void this.interrupt(op)
    }
    const turnId = record(params.turn) ? params.turn.id : params.turnId
    if (!op.turnId || turnId !== op.turnId) return
    if (method === 'turn/completed' && record(params.turn)) { this.complete(op, params.turn); return }
    if (method === 'item/agentMessage/delta' && nativeId(params.itemId) && typeof params.delta === 'string') this.message(op, params.itemId, params.delta, true)
    else if (method === 'item/started' && record(params.item)) this.cacheItem(op, params.item)
    else if (method === 'item/completed' && record(params.item)) {
      if (params.item.type === 'agentMessage' && nativeId(params.item.id) && typeof params.item.text === 'string') this.message(op, params.item.id, params.item.text, false)
      if (nativeId(params.item.id)) op.items.delete(params.item.id)
    } else if (method === 'error') op.dto.progress = params.willRetry === true ? 'Codex is retrying a transient operation' : 'Codex reported an error'
    else return
    this.publish(op)
  }

  private cacheItem(op: Operation, item: Record<string, unknown>): void {
    if (!nativeId(item.id) || op.items.size >= MAX_ITEMS || item.status !== 'inProgress') return
    if (item.type === 'commandExecution' && typeof item.command === 'string' && item.command.length > 0 && item.command.length <= 8000 && !item.command.includes('\0') && typeof item.cwd === 'string') {
      try { if (!within(this.project.cwd, directory(item.cwd))) return } catch { return }
      op.items.set(item.id, { kind: 'command', command: item.command, cwd: item.cwd, paths: [] })
      op.dto.progress = 'Codex is running a command'
    } else if (item.type === 'fileChange' && Array.isArray(item.changes) && item.changes.length > 0 && item.changes.length <= 64) {
      const paths: string[] = []
      for (const change of item.changes) {
        if (!record(change) || !record(change.kind) || !['add', 'delete', 'update'].includes(String(change.kind.type)) || typeof change.diff !== 'string' || typeof change.path !== 'string' || change.path.length > 4096 || /[\u0000-\u001f\u007f]/.test(change.path) || !isAbsolute(change.path) || !within(this.project.cwd, resolve(change.path))) return
        paths.push(resolve(change.path))
        if (record(change.kind) && change.kind.move_path != null) {
          const target = change.kind.move_path
          if (change.kind.type !== 'update' || typeof target !== 'string' || target.length > 4096 || /[\u0000-\u001f\u007f]/.test(target) || !isAbsolute(target) || !within(this.project.cwd, resolve(target))) return
          paths.push(resolve(target))
        }
        if (paths.length > 64) return
      }
      op.items.set(item.id, { kind: 'file', cwd: this.project.cwd, paths })
      op.dto.progress = 'Codex is preparing file changes'
    }
  }

  private message(op: Operation, id: string, text: string, append: boolean): void {
    if (!op.messages.has(id) && op.messages.size >= MAX_ITEMS) { op.dto.truncated = true; return }
    const previous = op.messages.get(id) ?? ''
    const usedElsewhere = [...op.messages.values()].reduce((sum, value) => sum + value.length, 0) - previous.length
    const room = Math.max(0, MAX_CODEX_RESULT_CHARS - usedElsewhere)
    const candidate = append ? previous + text.slice(0, MAX_CODEX_RESULT_CHARS) : text
    if (candidate.length > room || text.length > MAX_CODEX_RESULT_CHARS) op.dto.truncated = true
    op.messages.set(id, candidate.slice(0, room))
    op.dto.text = [...op.messages.values()].join('\n').slice(0, MAX_CODEX_RESULT_CHARS)
  }

  private complete(op: Operation, turn: Record<string, unknown>): void {
    if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) { this.abort(op, 'Codex returned an invalid terminal state.'); return }
    if (!op.mapped) {
      // A fast turn may finish before turn/start returns. Never publish success
      // before the native-to-owned turn mapping is durably saved.
      if (op.pendingTerminal) return
      op.pendingTruncated = Array.isArray(turn.items) && (turn.items.length > MAX_ITEMS || turn.items.some((item) => record(item) && item.type === 'agentMessage' && typeof item.text === 'string' && item.text.length > MAX_CODEX_RESULT_CHARS))
      if (op.generation) this.options.approvals.disconnectProcess(op.generation)
      op.pendingTerminal = { id: turn.id, status: turn.status, items: Array.isArray(turn.items) ? turn.items.slice(0, MAX_ITEMS).flatMap((item) => record(item) && item.type === 'agentMessage' && nativeId(item.id) && typeof item.text === 'string' ? [{ type: 'agentMessage', id: item.id, text: item.text.slice(0, MAX_CODEX_RESULT_CHARS) }] : []) : [] }
      return
    }
    if (Array.isArray(turn.items) && turn.items.length > 0) {
      op.messages.clear(); op.dto.text = ''; op.dto.truncated = !!op.pendingTruncated || turn.items.length > MAX_ITEMS
      for (const item of turn.items.slice(0, MAX_ITEMS)) if (record(item) && item.type === 'agentMessage' && nativeId(item.id) && typeof item.text === 'string') this.message(op, item.id, item.text, false)
    }
    this.finish(op, turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'cancelled' : 'failed', turn.status === 'failed' ? 'Codex could not complete this turn.' : undefined)
  }

  private finish(op: Operation, status: Status, error?: string): void {
    if (terminal(op.dto.status)) return
    clearTimeout(op.timer)
    op.stop()
    op.dto.status = status
    op.dto.error = error ?? null
    op.dto.progress = status === 'completed' ? 'Codex finished' : status === 'cancelled' ? (op.turnId ? 'Codex confirmed interruption' : 'Task cancelled before execution') : 'Codex stopped with an unresolved outcome'
    op.items.clear()
    if (op.generation) this.options.approvals.disconnectProcess(op.generation)
    this.publish(op, true)
  }

  private abort(op: Operation, reason: string): void {
    if (terminal(op.dto.status)) return
    this.finish(op, 'failed', reason)
    this.close()
  }

  private publish(op: Operation, final = false): void {
    if (this.current !== op || (!final && op.updates++ >= MAX_UPDATES)) return
    try { this.options.onEvent?.(Object.freeze({ ...op.dto })) } catch { /* UI observers cannot change execution. */ }
  }
}
