// @vitest-environment node
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { CodexApprovalBroker } from './approvalBroker'
import type { CodexServerRequest } from './appServer'
import type { OwnedCodexMetadataV1 } from './metadata'
import { CodexDesktopService, MAX_CODEX_PROMPT_CHARS, MAX_CODEX_RESULT_CHARS } from './desktopService'
import { MAX_CODEX_FILE_DIFF_CHARS } from './fileChanges'

class FakeServer {
  processGeneration = 1
  connected = true
  calls: { method: string; params: Record<string, unknown> }[] = []
  listeners = new Set<(method: string, params: Record<string, unknown>, generation: number) => void>()
  handler: ((method: string) => Promise<unknown>) | undefined
  private turnSequence = 0
  constructor(readonly cwd: string) {}
  async start() { return this.processGeneration }
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params })
    if (this.handler) return this.handler(method)
    if (method === 'thread/start') return this.thread()
    if (method === 'thread/resume') return this.thread({ type: 'idle' })
    if (method === 'turn/start') return { turn: { id: `turn-${++this.turnSequence}`, status: 'inProgress', items: [] } }
    return {}
  }
  thread(status?: Record<string, unknown>) { return { thread: { id: 'thread-1', sessionId: 'thread-1', cwd: this.cwd, ...(status ? { status } : {}) }, cwd: this.cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [this.cwd] } } }
  onNotification(listener: (method: string, params: Record<string, unknown>, generation: number) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(method: string, params: Record<string, unknown>, generation = 1) { for (const listener of this.listeners) listener(method, params, generation) }
  close = vi.fn(() => { this.connected = false })
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes }); return { promise, resolve } }

describe('finite main-owned Codex turns', () => {
  let cwd: string
  let server: FakeServer
  let state: OwnedCodexMetadataV1
  let metadata: { read: Mock<() => Promise<OwnedCodexMetadataV1>>; replace: Mock<(next: unknown) => Promise<OwnedCodexMetadataV1>> }
  let approvals: CodexApprovalBroker
  let service: CodexDesktopService
  let prompts: unknown[]
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'archon-codex-turn-'))
    server = new FakeServer(cwd)
    state = { version: 1, projects: [], sessions: [] }
    metadata = { read: vi.fn(async () => structuredClone(state)), replace: vi.fn(async (next: unknown) => { state = structuredClone(next as OwnedCodexMetadataV1); return state }) }
    prompts = []
    approvals = new CodexApprovalBroker({ onPrompt: (prompt) => prompts.push(prompt), isTaskActive: (...args) => service.isTaskActive(...args) })
    service = new CodexDesktopService({ project: { id: 'codex-project:configured', cwd, name: 'Configured' }, appServer: server, metadata, approvals })
  })
  afterEach(async () => { service.close(); vi.useRealTimers(); await rm(cwd, { recursive: true, force: true }) })

  it('does no protocol work during construction or for invalid prompts', async () => {
    expect(service.snapshot()).toBeNull()
    for (const prompt of ['', '  ', 'bad\0input', 'x'.repeat(MAX_CODEX_PROMPT_CHARS + 1)]) await expect(service.startTurn(prompt)).rejects.toThrow(/prompt/i)
    expect(server.calls).toEqual([])
  })
  it('creates and persists one bound turn, ignores stale messages, and caps renderer output', async () => {
    const turn = await service.startTurn('Inspect fixture')
    expect(turn.status).toBe('running')
    expect(server.calls.map((call) => call.method)).toEqual(['thread/start', 'turn/start'])
    expect(server.calls[1].params).toMatchObject({ threadId: 'thread-1', cwd, input: [{ type: 'text', text: 'Inspect fixture', text_elements: [] }], approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } })
    expect(state.sessions[0].turns).toEqual([{ id: turn.taskId, turnId: 'turn-1' }])
    expect(service.activeBinding).toMatchObject({ projectId: turn.projectId, sessionId: turn.sessionId, taskId: turn.taskId, threadId: 'thread-1', cwd, processGeneration: 1 })
    expect(turn).not.toHaveProperty('cwd')
    expect(turn).not.toHaveProperty('threadId')
    await expect(service.startTurn('second')).rejects.toThrow(/active/i)
    server.emit('item/agentMessage/delta', { threadId: 'other', turnId: 'turn-1', itemId: 'answer', delta: 'wrong' })
    server.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'stale' }, 2)
    expect(service.snapshot()?.text).toBe('')
    server.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'x'.repeat(MAX_CODEX_RESULT_CHARS + 200) })
    expect(service.snapshot()?.text.length).toBeLessThanOrEqual(MAX_CODEX_RESULT_CHARS)
    expect(service.snapshot()?.truncated).toBe(true)
    server.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', text: 'Final answer' }] } })
    expect(service.snapshot()).toMatchObject({ status: 'completed', text: 'Final answer' })
    expect(service.activeBinding).toBeNull()
  })
  it('resumes a completed owned conversation with the same approval and workspace policy', async () => {
    const first = await service.startTurn('Inspect fixture')
    server.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } })
    expect(service.snapshot()?.status).toBe('completed')

    const next = await service.startTurn('Continue the work', first.sessionId!)
    expect(next).toMatchObject({ status: 'running', sessionId: first.sessionId })
    expect(server.calls.map((call) => call.method)).toEqual(['thread/start', 'turn/start', 'thread/resume', 'turn/start'])
    expect(server.calls[2]).toEqual({ method: 'thread/resume', params: {
      threadId: 'thread-1', cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write', excludeTurns: true,
    } })
    expect(server.calls[3].params).toMatchObject({
      threadId: 'thread-1', cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
    })
    expect(state.sessions[0].turns).toEqual([
      { id: first.taskId, turnId: 'turn-1' },
      { id: next.taskId, turnId: 'turn-2' },
    ])
  })
  it.each(['cwd', 'sandbox', 'approvalPolicy'])('rejects a changed thread %s before submitting prompt', async (field) => {
    server.handler = async () => ({ ...server.thread(), [field]: field === 'cwd' ? '/' : field === 'sandbox' ? { type: 'dangerFullAccess' } : 'never' })
    expect((await service.startTurn('work')).status).toBe('failed')
    expect(server.calls.map((call) => call.method)).toEqual(['thread/start'])
  })
  it('does not replay a turn across process generations', async () => {
    server.handler = async (method) => { if (method === 'thread/start') return server.thread(); server.processGeneration = 2; return { turn: { id: 'turn-1', status: 'inProgress', items: [] } } }
    expect((await service.startTurn('work')).status).toBe('failed')
    expect(server.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
    expect(service.activeBinding).toBeNull()
  })
  it('sends one bound cancellation and waits for interruption confirmation', async () => {
    const turn = await service.startTurn('work')
    await expect(service.cancel('codex-task:other')).rejects.toThrow(/active/i)
    await Promise.all([service.cancel(turn.taskId), service.cancel(turn.taskId)])
    expect(service.snapshot()?.status).toBe('cancelling')
    expect(server.calls.filter((call) => call.method === 'turn/interrupt')).toEqual([{ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } }])
    expect(service.isTaskActive(turn.taskId, turn.sessionId!, 1)).toBe(false)
    server.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } })
    expect(service.snapshot()?.status).toBe('cancelled')
  })
  it('cancels while thread/start is pending without launching a turn', async () => {
    const gate = deferred<unknown>(); server.handler = async () => gate.promise
    const starting = service.startTurn('work')
    await vi.waitFor(() => expect(server.calls).toHaveLength(1))
    await service.cancel(service.snapshot()!.taskId)
    gate.resolve(server.thread())
    expect((await starting).status).toBe('cancelled')
    expect(server.calls.map((call) => call.method)).toEqual(['thread/start'])
  })
  it('handles completion notification arriving before turn/start response', async () => {
    server.handler = async (method) => {
      if (method === 'thread/start') return server.thread()
      server.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } })
      server.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', id: 'answer', text: 'Already done' }] } })
      return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
    }
    expect(await service.startTurn('work')).toMatchObject({ status: 'completed', text: 'Already done' })
    expect(state.sessions[0].turns).toHaveLength(1)
  })
  it('binds approvals to cached main-owned items and rejects mismatches or broad grants', async () => {
    const turn = await service.startTurn('work')
    const request: CodexServerRequest = { id: 12, method: 'item/commandExecution/requestApproval', processGeneration: 1, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', command: 'git status', cwd } }
    expect(service.resolveApprovalContext(request)).toBeUndefined()
    server.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command-1', command: 'git status', cwd, status: 'inProgress' } })
    expect(service.resolveApprovalContext(request)).toMatchObject({ kind: 'command', taskId: turn.taskId, sessionId: turn.sessionId, cwd, command: 'git status', paths: [] })
    for (const mutation of [{ turnId: 'other' }, { threadId: 'other' }, { command: 'rm -rf .' }, { cwd: '/' }, { networkApprovalContext: { host: 'example.com' } }]) expect(service.resolveApprovalContext({ ...request, params: { ...request.params, ...mutation } })).toBeUndefined()
    expect(service.resolveApprovalContext({ ...request, processGeneration: 2 })).toBeUndefined()
    const pending = approvals.request({ ...service.resolveApprovalContext(request)!, requestId: request.id, processGeneration: 1 })
    expect(prompts).toHaveLength(1)
    await service.cancel(turn.taskId)
    expect(await pending).toBe(false)
    expect(service.resolveApprovalContext(request)).toBeUndefined()
  })
  it('binds file consent to the exact bounded diff and performs no hidden writes', async () => {
    const file = join(cwd, 'review.ts')
    await writeFile(file, 'original content\n')
    const diff = '--- a/review.ts\n+++ b/review.ts\n@@ -1 +1 @@\n-original content\n+approved content\n'
    const turn = await service.startTurn('work')
    server.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 100, item: {
      id: 'patch', type: 'fileChange', status: 'inProgress',
      changes: [{ path: file, kind: { type: 'update', move_path: null }, diff }],
    } })
    const request: CodexServerRequest = { id: 5, method: 'item/fileChange/requestApproval', processGeneration: 1, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch', startedAtMs: 101 } }
    const context = service.resolveApprovalContext(request)
    expect(context).toMatchObject({
      kind: 'file', taskId: turn.taskId, sessionId: turn.sessionId, cwd,
      paths: [file], changes: [{ path: file, kind: 'update', diff }], startedAtMs: 101,
    })
    expect(await readFile(file, 'utf8')).toBe('original content\n')

    const pending = approvals.request({ ...context!, requestId: request.id, processGeneration: 1 })
    const prompt = prompts[0] as import('./approvalBroker').CodexApprovalPrompt
    expect(prompt.changes?.[0]?.diff).toBe(diff)
    expect(approvals.answer({ ...prompt, changes: [{ ...prompt.changes![0]!, diff: 'different patch' }], allow: true })).toBe(false)
    expect(approvals.answer({ ...prompt, allow: true })).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(await readFile(file, 'utf8')).toBe('original content\n')

    server.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 102, item: {
      id: 'patch', type: 'fileChange', status: 'inProgress',
      changes: [{ path: file, kind: { type: 'update' }, diff }],
    } })
    const omittedMovePath = service.resolveApprovalContext({
      ...request, id: 7, params: { ...request.params, startedAtMs: 103 },
    })
    expect(omittedMovePath?.changes).toEqual([{ path: file, kind: 'update', diff }])
  })

  it('denies oversized, protected, symlinked, unknown, or mismatched file changes', async () => {
    const turn = await service.startTurn('work')
    const path = join(cwd, 'candidate.ts')
    const request: CodexServerRequest = { id: 6, method: 'item/fileChange/requestApproval', processGeneration: 1, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch', startedAtMs: 101 } }
    const start = (change: Record<string, unknown>, id = 'patch') => server.emit('item/started', {
      threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 100, item: { id, type: 'fileChange', status: 'inProgress', changes: [change] },
    })

    start({ path, kind: { type: 'add' }, diff: '+new content\n' })
    expect(service.resolveApprovalContext({ ...request, params: { ...request.params, grantRoot: cwd } })).toBeUndefined()
    expect(service.resolveApprovalContext({ ...request, params: { ...request.params, additionalPermissions: { fullAccess: true } } })).toBeUndefined()
    expect(service.resolveApprovalContext({ ...request, params: { ...request.params, paths: [join(cwd, 'other.ts')] } })).toBeUndefined()
    expect(service.resolveApprovalContext({ ...request, params: { ...request.params, changes: [{ path, kind: { type: 'add' }, diff: '+tampered' }] } })).toBeUndefined()
    expect(service.resolveApprovalContext({ ...request, params: { ...request.params, startedAtMs: 99 } })).toBeUndefined()
    expect(service.resolveApprovalContext({ ...request, processGeneration: 2 })).toBeUndefined()

    start({ path, kind: { type: 'add' }, diff: 'x'.repeat(MAX_CODEX_FILE_DIFF_CHARS + 1) })
    expect(service.resolveApprovalContext(request)).toBeUndefined()
    start({ path, kind: { type: 'add' }, diff: '' })
    expect(service.resolveApprovalContext(request)).toBeUndefined()
    start({ path, kind: { type: 'add' }, diff: `x${String.fromCharCode(0xd800)}` })
    expect(service.resolveApprovalContext(request)).toBeUndefined()
    start({ path: join(cwd, '.ssh', 'id_ed25519'), kind: { type: 'add' }, diff: '+secret' })
    expect(service.resolveApprovalContext(request)).toBeUndefined()
    start({ path, kind: { type: 'copy' }, diff: '+unknown kind' })
    expect(service.resolveApprovalContext(request)).toBeUndefined()

    const target = join(cwd, 'real-target.ts')
    await writeFile(target, 'fixture\n')
    const link = join(cwd, 'linked.ts')
    await symlink(target, link)
    start({ path: link, kind: { type: 'update' }, diff: '+symlink' })
    expect(service.resolveApprovalContext(request)).toBeUndefined()
    expect(service.resolveApprovalContext({ ...request, params: { ...request.params, itemId: 'missing-item' } })).toBeUndefined()
    expect(service.snapshot()?.taskId).toBe(turn.taskId)
  })
  it('never launches a turn when metadata write fails and hides raw errors', async () => {
    metadata.replace.mockRejectedValue(new Error('private raw detail'))
    expect((await service.startTurn('work')).status).toBe('failed')
    expect(server.calls.map((call) => call.method)).toEqual(['thread/start'])
    expect(JSON.stringify(service.snapshot())).not.toContain('private raw detail')
  })
  it('bounds an unresponsive turn and closes its transport without claiming cancellation', async () => {
    vi.useFakeTimers(); service.close(); server = new FakeServer(cwd)
    approvals = new CodexApprovalBroker({ onPrompt: vi.fn(), isTaskActive: () => false })
    service = new CodexDesktopService({ project: { id: 'codex-project:configured', cwd }, appServer: server, metadata, approvals, turnTimeoutMs: 100 })
    await service.startTurn('work'); await vi.advanceTimersByTimeAsync(101)
    expect(service.snapshot()?.status).toBe('failed')
    expect(server.close).toHaveBeenCalled()
    expect(service.activeBinding).toBeNull()
  })

  it('does not publish terminal success until the owned turn mapping is durable', async () => {
    const gate = deferred<void>()
    const savedReplace = metadata.replace.getMockImplementation()!
    metadata.replace.mockImplementation(async (next) => {
      if ((next as OwnedCodexMetadataV1).sessions[0]?.turns.length) await gate.promise
      return savedReplace(next)
    })
    server.handler = async (method) => {
      if (method === 'thread/start') return server.thread()
      server.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } })
      server.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } })
      return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
    }
    const starting = service.startTurn('work')
    await vi.waitFor(() => expect(metadata.replace).toHaveBeenCalledTimes(2))
    expect(service.snapshot()?.status).toBe('starting')
    gate.resolve()
    expect((await starting).status).toBe('completed')
  })
  it('denies early approvals until the accepted turn mapping is durable', async () => {
    const gate = deferred<void>()
    const savedReplace = metadata.replace.getMockImplementation()!
    metadata.replace.mockImplementation(async (next) => {
      if ((next as OwnedCodexMetadataV1).sessions[0]?.turns.length) await gate.promise
      return savedReplace(next)
    })
    server.handler = async (method) => {
      if (method === 'thread/start') return server.thread()
      server.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } })
      return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
    }
    const starting = service.startTurn('work')
    await vi.waitFor(() => expect(metadata.replace).toHaveBeenCalledTimes(2))
    server.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command-1', command: 'git status', cwd, status: 'inProgress' } })
    const request: CodexServerRequest = { id: 12, method: 'item/commandExecution/requestApproval', processGeneration: 1, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', command: 'git status', cwd } }
    expect(service.resolveApprovalContext(request)).toBeUndefined()
    gate.resolve()
    const turn = await starting
    expect(turn.status).toBe('running')
    expect(service.resolveApprovalContext(request)).toMatchObject({ taskId: turn.taskId, command: 'git status' })
  })
  it('settles a stalled thread request when the finite service deadline expires', async () => {
    vi.useFakeTimers(); service.close(); server = new FakeServer(cwd)
    const gate = deferred<unknown>(); server.handler = async () => gate.promise
    approvals = new CodexApprovalBroker({ onPrompt: vi.fn(), isTaskActive: () => false })
    service = new CodexDesktopService({ project: { id: 'codex-project:configured', cwd }, appServer: server, metadata, approvals, turnTimeoutMs: 100 })
    const starting = service.startTurn('work')
    await vi.advanceTimersByTimeAsync(101)
    expect((await starting).status).toBe('failed')
    gate.resolve(server.thread())
    await Promise.resolve()
    expect(server.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0)
  })

  it('does not report fast completion if saving the accepted turn mapping fails', async () => {
    const savedReplace = metadata.replace.getMockImplementation()!
    metadata.replace.mockImplementation(async (next) => {
      if ((next as OwnedCodexMetadataV1).sessions[0]?.turns.length) throw new Error('fixture write failure')
      return savedReplace(next)
    })
    server.handler = async (method) => {
      if (method === 'thread/start') return server.thread()
      server.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } })
      server.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } })
      return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
    }
    expect((await service.startTurn('work')).status).toBe('failed')
    expect(server.close).toHaveBeenCalled()
  })
  it('invalidates an active binding on disconnect and rejects stale progress', async () => {
    await service.startTurn('work')
    server.connected = false
    service.onDisconnect(1)
    expect(service.snapshot()).toMatchObject({ status: 'failed' })
    expect(service.activeBinding).toBeNull()
    server.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'late' })
    expect(service.snapshot()?.text).toBe('')
  })

  it('interrupts as soon as a turn id arrives after an earlier cancellation', async () => {
    const gate = deferred<unknown>()
    server.handler = async (method) => method === 'thread/start' ? server.thread() : method === 'turn/start' ? gate.promise : {}
    const starting = service.startTurn('work')
    await vi.waitFor(() => expect(server.calls).toHaveLength(2))
    await service.cancel(service.snapshot()!.taskId)
    server.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } })
    await vi.waitFor(() => expect(server.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1))
    gate.resolve({ turn: { id: 'turn-1', status: 'inProgress', items: [] } })
    await starting
    expect(server.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1)
  })
  it('rejects symlinked configured cwd and has no generic request surface', async () => {
    const link = join(cwd, 'link'); await symlink(cwd, link)
    expect(() => new CodexDesktopService({ project: { id: 'codex-project:configured', cwd: link }, appServer: server, metadata, approvals })).toThrow(/directory/i)
    expect(service).not.toHaveProperty('request')
  })
})
