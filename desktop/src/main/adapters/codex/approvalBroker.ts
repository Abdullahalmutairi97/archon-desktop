import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fromCodexSessionId, isCodexSessionId, isCodexTaskId } from './ids'
import { isProtectedCodexPath } from './pathAccess'
import type { CodexServerRequest } from './appServer'

export type CodexApprovalKind = 'command' | 'file'
export type CodexProtocolRequestId = string | number

export interface CodexApprovalContext {
  requestId: CodexProtocolRequestId
  processGeneration: number
  sessionId: string
  threadId: string
  taskId: string
  kind: CodexApprovalKind
  command?: string
  cwd: string
  paths: readonly string[]
  reason: string
}

export interface CodexApprovalPrompt extends CodexApprovalContext {
  approvalId: string
}

export interface CodexApprovalAnswer extends CodexApprovalPrompt {
  allow: boolean
}

interface PendingApproval {
  prompt: CodexApprovalPrompt
  key: string
  resolve: (allow: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface CodexApprovalBrokerOptions {
  timeoutMs?: number
  onPrompt: (prompt: CodexApprovalPrompt) => void
  isTaskActive: (taskId: string, sessionId: string, processGeneration: number) => boolean
}

export type ResolvedCodexApprovalContext = Omit<CodexApprovalContext, 'requestId' | 'processGeneration'>

export interface CodexApprovalHooks {
  onProcessStart(processGeneration: number): void
  onDisconnect(processGeneration: number): void
  onServerRequest(request: CodexServerRequest): Promise<{ decision: 'accept' | 'decline' }>
}

const MAX_APPROVAL_COMMAND_LENGTH = 8192
const MAX_APPROVAL_REASON_LENGTH = 4096
const MAX_APPROVAL_PATHS = 64

function requestKey(generation: number, id: CodexProtocolRequestId): string {
  return `${generation}:${typeof id}:${String(id)}`
}

function validProtocolId(value: unknown): value is CodexProtocolRequestId {
  return typeof value === 'string'
    ? value.length > 0 && value.length <= 128 && !value.includes('\0')
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function freezeContext(context: CodexApprovalContext): CodexApprovalContext {
  if (!validProtocolId(context.requestId)
    || !Number.isSafeInteger(context.processGeneration) || context.processGeneration < 1
    || !isCodexSessionId(context.sessionId) || !isCodexTaskId(context.taskId)
    || fromCodexSessionId(context.sessionId) !== context.threadId
    || (context.kind !== 'command' && context.kind !== 'file')
    || !isAbsolute(context.cwd) || context.cwd.includes('\0')
    || typeof context.reason !== 'string' || context.reason.length > MAX_APPROVAL_REASON_LENGTH
    || context.reason.includes('\0') || !Array.isArray(context.paths) || context.paths.length > MAX_APPROVAL_PATHS) {
    throw new TypeError('Invalid Codex approval request context.')
  }

  const lexicalCwd = resolve(context.cwd)
  const cwd = context.kind === 'file' ? realOwnedDirectory(lexicalCwd) : lexicalCwd
  if (context.kind === 'command') {
    if (typeof context.command !== 'string' || context.command.length < 1
      || context.command.length > MAX_APPROVAL_COMMAND_LENGTH || context.command.includes('\0')
      || context.paths.length !== 0) throw new TypeError('Invalid Codex command approval context.')
  } else if (context.command !== undefined || context.paths.length < 1) {
    throw new TypeError('Invalid Codex file approval context.')
  }

  const paths = context.paths.map((item) => {
    if (typeof item !== 'string' || !isAbsolute(item) || item.length > 4096 || item.includes('\0')) {
      throw new TypeError('Invalid Codex approval path.')
    }
    const normalized = resolve(item)
    if (context.kind === 'file') {
      const realPath = canonicalApprovalPath(lexicalCwd, cwd, normalized)
      if (isProtectedCodexPath(realPath)) throw new TypeError('Codex approval path is protected.')
      return realPath
    }
    if (!isWithin(cwd, normalized) || isProtectedCodexPath(normalized)) {
      throw new TypeError('Codex approval path is outside the owned workspace.')
    }
    return normalized
  })
  return Object.freeze({
    requestId: context.requestId,
    processGeneration: context.processGeneration,
    sessionId: context.sessionId,
    threadId: context.threadId,
    taskId: context.taskId,
    kind: context.kind,
    ...(context.command === undefined ? {} : { command: context.command }),
    cwd,
    paths: Object.freeze(paths),
    reason: context.reason,
  })
}

function realOwnedDirectory(path: string): string {
  try {
    const details = lstatSync(path)
    if (details.isSymbolicLink() || !details.isDirectory()) throw new TypeError('Codex approval cwd is not an owned directory.')
    return realpathSync(path)
  } catch {
    throw new TypeError('Codex approval cwd is unavailable.')
  }
}

function canonicalApprovalPath(lexicalCwd: string, realCwd: string, path: string): string {
  if (!isWithin(lexicalCwd, path)) throw new TypeError('Codex approval path is outside the owned workspace.')
  const rel = relative(lexicalCwd, path)
  const parts = rel ? rel.split(sep).filter(Boolean) : []
  let cursor = realCwd
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index])
    let details
    try {
      details = lstatSync(cursor)
    } catch (error) {
      if (index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return cursor
      throw new TypeError('Codex approval path is unavailable.')
    }
    if (details.isSymbolicLink() || (index < parts.length - 1 && !details.isDirectory())) {
      throw new TypeError('Codex approval path contains an unsafe component.')
    }
    const canonical = realpathSync(cursor)
    if (!isWithin(realCwd, canonical)) throw new TypeError('Codex approval path is outside the owned workspace.')
    cursor = canonical
  }
  if (!isWithin(realCwd, cursor)) throw new TypeError('Codex approval path is outside the owned workspace.')
  return cursor
}

function sameBinding(expected: CodexApprovalPrompt, answer: CodexApprovalAnswer): boolean {
  return expected.approvalId === answer.approvalId
    && expected.requestId === answer.requestId
    && expected.processGeneration === answer.processGeneration
    && expected.sessionId === answer.sessionId
    && expected.threadId === answer.threadId
    && expected.taskId === answer.taskId
    && expected.kind === answer.kind
    && expected.command === answer.command
    && expected.cwd === answer.cwd
    && expected.reason === answer.reason
    && expected.paths.length === answer.paths.length
    && expected.paths.every((path, index) => path === answer.paths[index])
}

/** Couple app-server lifecycle and approvals so old prompts die with their process. */
export function createCodexApprovalHooks(
  broker: CodexApprovalBroker,
  resolveContext: (request: CodexServerRequest) => ResolvedCodexApprovalContext | undefined,
): CodexApprovalHooks {
  return {
    onProcessStart: (generation) => broker.activateProcess(generation),
    onDisconnect: (generation) => broker.disconnectProcess(generation),
    onServerRequest: async (request) => {
      if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
        throw new Error('Unsupported Codex app-server request.')
      }
      let context: ResolvedCodexApprovalContext | undefined
      try {
        context = resolveContext(request)
      } catch {
        return { decision: 'decline' }
      }
      if (!context) return { decision: 'decline' }
      const expectedKind = request.method === 'item/commandExecution/requestApproval' ? 'command' : 'file'
      if (context.kind !== expectedKind) return { decision: 'decline' }
      const allow = await broker.request({
        ...context,
        requestId: request.id,
        processGeneration: request.processGeneration,
      })
      return { decision: allow ? 'accept' : 'decline' }
    },
  }
}

export class CodexApprovalBroker {
  private readonly timeoutMs: number
  private readonly pendingById = new Map<string, PendingApproval>()
  private readonly pendingByRequest = new Map<string, PendingApproval>()
  private currentProcessGeneration: number | undefined
  private closed = false

  constructor(private readonly options: CodexApprovalBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new TypeError('Codex approval timeout must be between 1 and 300000 milliseconds.')
    }
  }

  activateProcess(processGeneration: number): void {
    if (this.closed || !Number.isSafeInteger(processGeneration) || processGeneration < 1) return
    if (this.currentProcessGeneration === processGeneration) return
    this.denyGeneration(this.currentProcessGeneration)
    this.currentProcessGeneration = processGeneration
  }

  request(context: CodexApprovalContext): Promise<boolean> {
    let safe: CodexApprovalContext
    try {
      safe = freezeContext(context)
    } catch {
      return Promise.resolve(false)
    }
    if (this.closed || safe.processGeneration !== this.currentProcessGeneration) return Promise.resolve(false)
    if (!this.isTaskActive(safe)) return Promise.resolve(false)

    const key = requestKey(safe.processGeneration, safe.requestId)
    if (this.pendingByRequest.has(key)) return Promise.resolve(false)

    return new Promise((resolveApproval) => {
      const prompt = Object.freeze({ ...safe, approvalId: randomUUID() })
      const pending: PendingApproval = {
        prompt,
        key,
        resolve: resolveApproval,
        timeout: setTimeout(() => this.consume(pending, false), this.timeoutMs),
      }
      this.pendingById.set(prompt.approvalId, pending)
      this.pendingByRequest.set(key, pending)
      try {
        this.options.onPrompt(prompt)
      } catch {
        this.consume(pending, false)
      }
    })
  }

  answer(answer: CodexApprovalAnswer): boolean {
    if (this.closed || !answer || typeof answer.approvalId !== 'string' || typeof answer.allow !== 'boolean'
      || !Array.isArray(answer.paths)) return false
    const pending = this.pendingById.get(answer.approvalId)
    if (!pending || !sameBinding(pending.prompt, answer)) return false
    const canAllow = answer.allow
      && answer.processGeneration === this.currentProcessGeneration
      && this.isTaskActive(pending.prompt)
    this.consume(pending, canAllow)
    return true
  }

  disconnectProcess(processGeneration: number): void {
    if (this.currentProcessGeneration !== processGeneration) return
    this.currentProcessGeneration = undefined
    this.denyGeneration(processGeneration)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.currentProcessGeneration = undefined
    for (const entry of [...this.pendingById.values()]) this.consume(entry, false)
  }

  private isTaskActive(context: CodexApprovalContext): boolean {
    try {
      return this.options.isTaskActive(context.taskId, context.sessionId, context.processGeneration) === true
    } catch {
      return false
    }
  }

  private denyGeneration(processGeneration: number | undefined): void {
    if (processGeneration === undefined) return
    for (const entry of [...this.pendingById.values()]) {
      if (entry.prompt.processGeneration === processGeneration) this.consume(entry, false)
    }
  }

  private consume(entry: PendingApproval, allow: boolean): void {
    if (this.pendingById.get(entry.prompt.approvalId) !== entry) return
    clearTimeout(entry.timeout)
    this.pendingById.delete(entry.prompt.approvalId)
    this.pendingByRequest.delete(entry.key)
    entry.resolve(allow)
  }
}
