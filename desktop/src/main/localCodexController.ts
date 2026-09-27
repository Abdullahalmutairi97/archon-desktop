import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CodexAppServerClient } from './adapters/codex/appServer'
import type { CodexAppServerClientOptions, CodexProcessSpawner, CodexServerRequest } from './adapters/codex/appServer'
import { CodexApprovalBroker, createCodexApprovalHooks } from './adapters/codex/approvalBroker'
import type { CodexApprovalPrompt, ResolvedCodexApprovalContext } from './adapters/codex/approvalBroker'
import { CodexDesktopService } from './adapters/codex/desktopService'
import type { CodexDesktopTurn } from './adapters/codex/desktopService'
import { isCodexProjectId, makeCodexProjectId } from './adapters/codex/ids'
import type { OwnedCodexMetadataStore } from './adapters/codex/metadata'
import { isProtectedCodexPath } from './adapters/codex/pathAccess'
import type { LocalCodexApprovalDto, LocalCodexEvent, LocalCodexProjectDto, LocalCodexTurnDto } from '../shared/bridge/types'
import { parseLocalCodexEvent } from '../shared/bridge/validation'

const CODEX_APPROVAL_TIMEOUT_MS = 30_000
const APPROVAL_MAP_TIMEOUT_MS = 29_000
const MAX_PENDING_APPROVALS = 64
const MAX_START_EVENTS = 128
const MAX_PROJECTS = 100
const MAX_PROJECT_PATH_LENGTH = 16_000
const CODEX_HOME_DEFAULT_SUFFIX = '.codex'
const SAFE_START_FAILURE = 'Local Codex could not start. Check that Codex is installed and signed in, then try again.'

export const PINNED_CODEX_EXECUTABLE = '/usr/bin/codex'

/** Development-only seam for the fake app-server smoke harness. */
export async function resolveCodexExecutable(override: string | undefined, isPackaged: boolean): Promise<string> {
  if (isPackaged || override === undefined || override === '') return PINNED_CODEX_EXECUTABLE
  if (!isAbsolute(override) || override.length > 4096 || /[\u0000-\u001f\u007f]/.test(override)) {
    throw new TypeError('The development Codex executable must be an absolute path.')
  }
  const details = await lstat(override).catch(() => undefined)
  if (!details?.isFile() || details.isSymbolicLink()) throw new TypeError('The development Codex executable is unavailable.')
  await access(override, constants.X_OK).catch(() => {
    throw new TypeError('The development Codex executable is not executable.')
  })
  return realpath(override)
}

export interface CodexChildEnvironmentInput {
  homeDirectory: string
  codexHomeDirectory?: string
}

/** Build the small child environment needed by the installed CLI, using its native auth home without reading it here. */
export function createCodexChildEnvironment(input: CodexChildEnvironmentInput): Readonly<Record<string, string>> {
  const home = input.homeDirectory
  const codexHome = input.codexHomeDirectory ?? join(home, CODEX_HOME_DEFAULT_SUFFIX)
  if (!isAbsolute(home) || home.includes('\0') || !isAbsolute(codexHome) || codexHome.includes('\0')) {
    throw new TypeError('Codex home directories must be absolute paths.')
  }
  return Object.freeze({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    CODEX_HOME: codexHome,
    LANG: 'C.UTF-8',
  })
}

export interface LocalCodexRuntimeProject extends LocalCodexProjectDto {}

export interface LocalCodexRuntimeHandlers {
  onTurn(turn: Readonly<CodexDesktopTurn>): void
  onApproval(prompt: CodexApprovalPrompt): void
  isTaskActive(taskId: string, sessionId: string, processGeneration: number): boolean
  resolveApprovalContext(request: CodexServerRequest): ResolvedCodexApprovalContext | undefined
}

export interface LocalCodexRuntime {
  project: Readonly<LocalCodexRuntimeProject>
  service: Pick<CodexDesktopService,
    'snapshot' | 'startTurn' | 'cancel' | 'isTaskActive' | 'resolveApprovalContext' | 'onDisconnect' | 'close'>
  approvals: Pick<CodexApprovalBroker, 'answer'>
  close(): void
}

export type LocalCodexRuntimeFactory = (
  project: Readonly<LocalCodexRuntimeProject>,
  handlers: LocalCodexRuntimeHandlers,
) => LocalCodexRuntime

export interface LocalCodexRuntimeFactoryOptions {
  metadata: Pick<OwnedCodexMetadataStore, 'read' | 'replace'>
  command: string
  env: Readonly<Record<string, string>>
  spawn: CodexProcessSpawner
  requestTimeoutMs?: number
  turnTimeoutMs?: number
}

/** Compose the app-server, approval broker and service with a generation-fenced disconnect callback. */
export function createLocalCodexRuntimeFactory(options: LocalCodexRuntimeFactoryOptions): LocalCodexRuntimeFactory {
  return (project, handlers) => {
    let service!: CodexDesktopService
    const approvals = new CodexApprovalBroker({
      timeoutMs: CODEX_APPROVAL_TIMEOUT_MS,
      onPrompt: handlers.onApproval,
      isTaskActive: handlers.isTaskActive,
    })
    const approvalHooks = createCodexApprovalHooks(approvals, handlers.resolveApprovalContext)
    const appServerOptions: Omit<CodexAppServerClientOptions, 'onProcessStart' | 'onDisconnect' | 'onServerRequest'> = {
      command: options.command,
      args: ['app-server'],
      env: options.env,
      spawn: options.spawn,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    }
    const appServer = new CodexAppServerClient({
      ...appServerOptions,
      onProcessStart: approvalHooks.onProcessStart,
      onServerRequest: approvalHooks.onServerRequest,
      onDisconnect: (generation) => {
        // The broker revokes pending requests first; the service then fails its active turn.
        approvalHooks.onDisconnect(generation)
        service?.onDisconnect(generation)
      },
    })
    service = new CodexDesktopService({
      project: { id: project.id, name: project.name, cwd: project.rootPath },
      appServer,
      metadata: options.metadata,
      approvals,
      onEvent: handlers.onTurn,
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    })
    return Object.freeze({
      project: Object.freeze({ ...project }),
      service,
      approvals,
      close: () => service.close(),
    })
  }
}

export interface LocalCodexControllerOptions {
  metadata: Pick<OwnedCodexMetadataStore, 'read' | 'replace'>
  pickProjectDirectory(): Promise<string | null>
  createRuntime: LocalCodexRuntimeFactory
  /** Prevent a workspace from containing or pointing inside the native Codex auth home. */
  protectedRoots?: readonly string[]
}

interface ActiveRuntime {
  token: symbol
  runtime: LocalCodexRuntime
  lastText: string
}

interface PendingApproval {
  token: symbol
  runtime: LocalCodexRuntime
  prompt: CodexApprovalPrompt
  timeout: ReturnType<typeof setTimeout>
}

interface StartEventBuffer {
  token: symbol
  events: LocalCodexEvent[]
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function terminalStatus(status: CodexDesktopTurn['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}

function safeProjectName(path: string): string {
  const name = basename(path) || 'Local Codex project'
  return name.length > 300 ? name.slice(0, 300) : name
}

/** Canonicalize a native-picked directory and keep native Codex auth out of the workspace. */
export async function canonicalizeLocalCodexProjectRoot(
  value: unknown,
  protectedRoots: readonly string[] = [],
): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > MAX_PROJECT_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Choose a valid Codex project directory.')
  }
  const info = await lstat(value).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new TypeError('Codex project directory is unavailable.')
  const canonical = await realpath(value).catch(() => undefined)
  if (!canonical || canonical.length > MAX_PROJECT_PATH_LENGTH || isProtectedCodexPath(canonical)) {
    throw new TypeError('Codex project directory is not allowed.')
  }
  const canonicalInfo = await lstat(canonical).catch(() => undefined)
  if (!canonicalInfo?.isDirectory() || canonicalInfo.isSymbolicLink()) throw new TypeError('Codex project directory is unavailable.')

  for (const protectedPath of protectedRoots) {
    if (typeof protectedPath !== 'string' || !isAbsolute(protectedPath) || protectedPath.includes('\0')) {
      throw new TypeError('Invalid protected Codex directory.')
    }
    const protectedCanonical = await realpath(protectedPath).catch(() => resolve(protectedPath))
    if (isWithin(canonical, protectedCanonical) || isWithin(protectedCanonical, canonical)) {
      throw new TypeError('Codex project directory overlaps native Codex authentication.')
    }
  }
  return canonical
}

/** Main-owned project registry and one-at-a-time turn controller. */
export class LocalCodexController {
  private readonly listeners = new Set<(event: LocalCodexEvent) => void>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly runtimesByToken = new Map<symbol, LocalCodexRuntime>()
  private readonly protectedRoots: readonly string[]
  private active: ActiveRuntime | undefined
  private startBuffer: StartEventBuffer | undefined
  private startReserved = false
  private registrationReserved = false
  private closed = false

  constructor(private readonly options: LocalCodexControllerOptions) {
    this.protectedRoots = Object.freeze([...(options.protectedRoots ?? [])])
    for (const path of this.protectedRoots) {
      if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('Protected Codex directories must be absolute.')
    }
  }

  async listProjects(): Promise<readonly LocalCodexProjectDto[]> {
    this.assertOpen()
    const metadata = await this.options.metadata.read()
    this.assertOpen()
    const projects: LocalCodexProjectDto[] = []
    for (const project of metadata.projects) {
      if (!isCodexProjectId(project.id) || !project.name.trim() || project.name.length > 300) continue
      try {
        const rootPath = await canonicalizeLocalCodexProjectRoot(project.primary_path, this.protectedRoots)
        this.assertOpen()
        if (rootPath !== project.primary_path) continue
        projects.push(Object.freeze({ id: project.id, name: project.name, rootPath }))
      } catch {
        // Stale or unsafe registered roots are hidden until selected again through the native picker.
      }
      if (projects.length >= MAX_PROJECTS) break
    }
    return Object.freeze(projects)
  }

  async registerProject(): Promise<LocalCodexProjectDto | null> {
    this.assertOpen()
    if (this.registrationReserved || this.startReserved || this.hasActiveTurn()) {
      throw new Error('Finish the active local Codex turn before registering a project.')
    }
    // Reserve before yielding to the native picker so concurrent IPC calls cannot
    // race the registry read/replace or start a turn from stale metadata.
    this.registrationReserved = true
    try {
      const selected = await this.options.pickProjectDirectory()
      this.assertOpen()
      if (selected === null) return null
      if (this.startReserved || this.hasActiveTurn()) {
        throw new Error('Finish the active local Codex turn before registering a project.')
      }
      const rootPath = await canonicalizeLocalCodexProjectRoot(selected, this.protectedRoots)
      this.assertOpen()
      const metadata = await this.options.metadata.read()
      this.assertOpen()
      const existing = metadata.projects.find((project) => project.primary_path === rootPath)
      if (existing) {
        return Object.freeze({ id: existing.id, name: existing.name, rootPath })
      }
      if (metadata.projects.length >= MAX_PROJECTS) throw new Error('The local Codex project limit has been reached.')
      const project: LocalCodexProjectDto = Object.freeze({
        id: makeCodexProjectId(),
        name: safeProjectName(rootPath),
        rootPath,
      })
      this.assertOpen()
      await this.options.metadata.replace({
        ...metadata,
        projects: [...metadata.projects, {
          id: project.id,
          name: project.name,
          primary_path: project.rootPath,
          runtime: 'codex',
        }],
      })
      return project
    } finally {
      this.registrationReserved = false
    }
  }

  async startTurn(input: { projectId: string; prompt: string }): Promise<LocalCodexTurnDto> {
    this.assertOpen()
    if (this.registrationReserved) throw new Error('A local Codex project is being registered.')
    if (this.startReserved) throw new Error('A local Codex turn is already starting.')
    this.startReserved = true
    let runtime: LocalCodexRuntime | undefined
    let token: symbol | undefined
    const buffer: StartEventBuffer = { token: Symbol('codex-start'), events: [] }
    this.startBuffer = buffer
    try {
      if (typeof input.projectId !== 'string' || !isCodexProjectId(input.projectId)
        || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000 || input.prompt.includes('\0')) {
        throw new TypeError('Invalid local Codex turn request.')
      }
      if (this.hasActiveTurn()) throw new Error('A local Codex turn is already active.')
      if (this.active) this.disposeActive(this.active)

      const metadata = await this.options.metadata.read()
      this.assertOpen()
      const stored = metadata.projects.find((project) => project.id === input.projectId)
      if (!stored) throw new Error('Unknown local Codex project.')
      const rootPath = await canonicalizeLocalCodexProjectRoot(stored.primary_path, this.protectedRoots)
      this.assertOpen()
      if (rootPath !== stored.primary_path) throw new Error('Local Codex project location changed.')
      const project = Object.freeze({ id: stored.id, name: stored.name, rootPath })
      token = buffer.token
      const callbacks = this.runtimeHandlers(token)
      this.assertOpen()
      runtime = this.options.createRuntime(project, callbacks)
      this.runtimesByToken.set(token, runtime)
      this.active = { token, runtime, lastText: '' }

      this.assertOpen()
      const result = await runtime.service.startTurn(input.prompt)
      this.assertOpen()
      const persisted = await this.options.metadata.read()
      this.assertOpen()
      const acknowledged = result.sessionId !== null && persisted.sessions.some((session) =>
        session.id === result.sessionId && session.projectId === project.id && session.cwd === project.rootPath
        && session.turns.some((turn) => turn.id === result.taskId),
      )
      if (!acknowledged) {
        this.ensureFailureEvent(buffer.events, result.taskId)
        this.flushStartEvents(buffer)
        this.releaseRuntime(token, runtime)
        throw new Error('Local Codex did not durably acknowledge the turn.')
      }

      // A fast terminal notification can arrive before startTurn resolves. The DTO records
      // the native start acknowledgement; its terminal event is sent just after this reply.
      const response: LocalCodexTurnDto = Object.freeze({
        taskId: result.taskId,
        projectId: project.id,
        sessionId: result.sessionId!,
        state: 'running',
      })
      this.flushStartEvents(buffer)
      return response
    } catch {
      if (runtime && token) {
        const snapshot = runtime.service.snapshot()
        if (snapshot && terminalStatus(snapshot.status)) this.ensureFailureEvent(buffer.events, snapshot.taskId)
        this.flushStartEvents(buffer)
        this.releaseRuntime(token, runtime)
      } else if (this.startBuffer === buffer) {
        this.startBuffer = undefined
      }
      throw new Error(SAFE_START_FAILURE)
    } finally {
      this.startReserved = false
    }
  }

  async cancelTurn(input: { taskId: string }): Promise<boolean> {
    this.assertOpen()
    const active = this.active
    if (!active || typeof input.taskId !== 'string' || active.runtime.service.snapshot()?.taskId !== input.taskId) return false
    const snapshot = active.runtime.service.snapshot()
    if (!snapshot || terminalStatus(snapshot.status)) return false
    try {
      await active.runtime.service.cancel(input.taskId)
      return true
    } catch {
      return false
    }
  }

  answerApproval(input: { approvalId: string; allow: boolean }): boolean {
    this.assertOpen()
    const pending = this.pendingApprovals.get(input.approvalId)
    if (!pending) return false
    this.forgetApproval(pending)
    const active = this.active
    const current = active?.token === pending.token && active.runtime.service.isTaskActive(
      pending.prompt.taskId,
      pending.prompt.sessionId,
      pending.prompt.processGeneration,
    )
    const isCurrent = current === true
    const consumed = pending.runtime.approvals.answer({ ...pending.prompt, allow: input.allow && isCurrent })
    return consumed && isCurrent
  }

  subscribe(listener: (event: LocalCodexEvent) => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of [...this.pendingApprovals.values()]) {
      pending.runtime.approvals.answer({ ...pending.prompt, allow: false })
      this.forgetApproval(pending)
    }
    if (this.active) this.disposeActive(this.active)
    this.startBuffer = undefined
    this.listeners.clear()
    this.runtimesByToken.clear()
  }

  private runtimeHandlers(token: symbol): LocalCodexRuntimeHandlers {
    return {
      onTurn: (turn) => this.onTurn(token, turn),
      onApproval: (prompt) => this.onApproval(token, prompt),
      isTaskActive: (taskId, sessionId, generation) => {
        const active = this.active
        return active?.token === token && active.runtime.service.isTaskActive(taskId, sessionId, generation)
      },
      resolveApprovalContext: (request) => {
        const active = this.active
        return active?.token === token ? active.runtime.service.resolveApprovalContext(request) : undefined
      },
    }
  }

  private onTurn(token: symbol, turn: Readonly<CodexDesktopTurn>): void {
    const active = this.active
    if (!active || active.token !== token || this.closed) return
    if (turn.text && turn.text !== active.lastText) {
      active.lastText = turn.text
      this.queueOrPublish(token, { type: 'turn.output', taskId: turn.taskId, text: turn.text })
    }
    if (!terminalStatus(turn.status)) return
    this.denyTaskApprovals(token, turn.taskId)
    if (turn.status === 'completed') this.queueOrPublish(token, { type: 'turn.completed', taskId: turn.taskId })
    else if (turn.status === 'cancelled') this.queueOrPublish(token, { type: 'turn.cancelled', taskId: turn.taskId })
    else this.queueOrPublish(token, { type: 'turn.failed', taskId: turn.taskId, message: SAFE_START_FAILURE })
  }

  private onApproval(token: symbol, prompt: CodexApprovalPrompt): void {
    const runtime = this.runtimesByToken.get(token)
    const active = this.active
    if (!runtime) return
    if (!active || active.token !== token || this.closed || !runtime.service.isTaskActive(
      prompt.taskId, prompt.sessionId, prompt.processGeneration,
    )) {
      runtime.approvals.answer({ ...prompt, allow: false })
      return
    }
    if (this.pendingApprovals.size >= MAX_PENDING_APPROVALS) {
      runtime.approvals.answer({ ...prompt, allow: false })
      return
    }
    const approval: LocalCodexApprovalDto = Object.freeze({
      approvalId: prompt.approvalId,
      taskId: prompt.taskId,
      projectId: active.runtime.project.id,
      kind: prompt.kind,
      reason: prompt.reason,
      cwd: prompt.cwd,
      paths: Object.freeze([...prompt.paths]),
      ...(prompt.command === undefined ? {} : { command: prompt.command }),
    })
    let event: LocalCodexEvent
    try {
      event = parseLocalCodexEvent({ type: 'approval.requested', approval })
    } catch {
      runtime.approvals.answer({ ...prompt, allow: false })
      return
    }
    const pending: PendingApproval = {
      token,
      runtime,
      prompt,
      timeout: setTimeout(() => {
        pending.runtime.approvals.answer({ ...pending.prompt, allow: false })
        this.forgetApproval(pending)
      }, APPROVAL_MAP_TIMEOUT_MS),
    }
    this.pendingApprovals.set(prompt.approvalId, pending)
    this.queueOrPublish(token, event)
  }

  private queueOrPublish(token: symbol, event: LocalCodexEvent): void {
    let validated: LocalCodexEvent
    try {
      validated = parseLocalCodexEvent(event)
    } catch {
      return
    }
    const buffer = this.startBuffer
    if (buffer?.token === token) {
      if (validated.type === 'turn.output') {
        const existing = buffer.events.findIndex((queued) => queued.type === 'turn.output' && queued.taskId === validated.taskId)
        if (existing >= 0) buffer.events[existing] = validated
        else buffer.events.push(validated)
      } else {
        if (buffer.events.length >= MAX_START_EVENTS) {
          const output = buffer.events.findIndex((queued) => queued.type === 'turn.output')
          if (output >= 0) buffer.events.splice(output, 1)
          else buffer.events.shift()
        }
        buffer.events.push(validated)
      }
      return
    }
    this.publish(validated)
  }

  private ensureFailureEvent(events: LocalCodexEvent[], taskId: string): void {
    if (events.some((event) => event.type !== 'approval.requested' && event.taskId === taskId && (
      event.type === 'turn.completed' || event.type === 'turn.cancelled' || event.type === 'turn.failed'
    ))) return
    events.push({ type: 'turn.failed', taskId, message: SAFE_START_FAILURE })
  }

  private flushStartEvents(buffer: StartEventBuffer): void {
    if (this.startBuffer === buffer) this.startBuffer = undefined
    const events = [...buffer.events]
    if (events.length === 0) return
    // Let the invoke handler return its running-only acknowledgement before a fast terminal event.
    setTimeout(() => {
      for (const event of events) this.publish(event)
    }, 10)
  }

  private publish(event: LocalCodexEvent): void {
    if (this.closed) return
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Event consumers cannot affect local task execution. */ }
    }
  }

  private denyTaskApprovals(token: symbol, taskId: string): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.token !== token || pending.prompt.taskId !== taskId) continue
      pending.runtime.approvals.answer({ ...pending.prompt, allow: false })
      this.forgetApproval(pending)
    }
  }

  private forgetApproval(pending: PendingApproval): void {
    if (this.pendingApprovals.get(pending.prompt.approvalId) !== pending) return
    clearTimeout(pending.timeout)
    this.pendingApprovals.delete(pending.prompt.approvalId)
  }

  private hasActiveTurn(): boolean {
    const snapshot = this.active?.runtime.service.snapshot()
    return !!snapshot && !terminalStatus(snapshot.status)
  }

  private releaseRuntime(token: symbol, runtime: LocalCodexRuntime): void {
    if (this.active?.token === token) this.active = undefined
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.token !== token) continue
      pending.runtime.approvals.answer({ ...pending.prompt, allow: false })
      this.forgetApproval(pending)
    }
    this.runtimesByToken.delete(token)
    runtime.close()
  }

  private disposeActive(active: ActiveRuntime): void {
    this.releaseRuntime(active.token, active.runtime)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Local Codex controller is closed.')
  }
}
