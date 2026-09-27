import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexApprovalBroker, type CodexApprovalContext, type CodexApprovalPrompt } from './approvalBroker'

const directories: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archon-codex-approval-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function approval(overrides: Partial<CodexApprovalContext> = {}): CodexApprovalContext {
  return {
    requestId: 9,
    processGeneration: 2,
    sessionId: 'codex:thread-1',
    threadId: 'thread-1',
    taskId: 'codex-task:task-1',
    kind: 'command',
    command: 'npm test',
    cwd: '/workspace/project',
    paths: [],
    reason: 'Run the project tests',
    ...overrides,
  }
}

describe('one-shot Codex native approval correlation', () => {
  it('allows one decision only for the exact pending process, thread, task, command, and paths', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'a.ts'), 'fixture')
    const prompts: CodexApprovalPrompt[] = []
    const broker = new CodexApprovalBroker({ onPrompt: (value) => prompts.push(value), isTaskActive: () => true })
    broker.activateProcess(2)
    const context = approval({
      kind: 'file', command: undefined, cwd, paths: [join(cwd, 'a.ts')], startedAtMs: 7,
      changes: [{ path: join(cwd, 'a.ts'), kind: 'update', diff: '-fixture\n+approved\n' }],
    })
    const pending = broker.request(context)
    const prompt = prompts[0]

    expect(prompt.approvalId).toBeTruthy()
    expect(broker.answer({ ...prompt, command: 'other command', allow: true })).toBe(false)
    expect(broker.answer({ ...prompt, paths: ['/workspace/project/b.ts'], allow: true })).toBe(false)
    expect(broker.answer({ ...prompt, allow: true })).toBe(true)
    await expect(pending).resolves.toBe(true)
    expect(broker.answer({ ...prompt, allow: true })).toBe(false)
    broker.close()
  })

  it('declines a file approval through a symlink before showing a prompt', async () => {
    const cwd = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, 'secret.txt'), 'fixture-secret')
    await symlink(outside, join(cwd, 'linked-directory'))
    const prompts: CodexApprovalPrompt[] = []
    const broker = new CodexApprovalBroker({ onPrompt: (value) => prompts.push(value), isTaskActive: () => true })
    broker.activateProcess(2)

    await expect(broker.request(approval({
      kind: 'file',
      command: undefined,
      cwd,
      paths: [join(cwd, 'linked-directory', 'secret.txt')],
    }))).resolves.toBe(false)
    expect(prompts).toEqual([])
    broker.close()
  })

  it('revalidates approved file scope when a path becomes a symlink while the dialog is open', async () => {
    const cwd = await workspace()
    const outside = await workspace()
    const file = join(cwd, 'review.ts')
    const external = join(outside, 'secret.ts')
    await writeFile(file, 'original\n')
    await writeFile(external, 'private\n')
    const prompts: CodexApprovalPrompt[] = []
    const broker = new CodexApprovalBroker({ onPrompt: (value) => prompts.push(value), isTaskActive: () => true })
    broker.activateProcess(2)
    const pending = broker.request(approval({
      kind: 'file', command: undefined, cwd, paths: [file], startedAtMs: 101,
      changes: [{ path: file, kind: 'update', diff: '-original\n+changed\n' }],
    }))
    const prompt = prompts[0]
    await rm(file)
    await symlink(external, file)

    expect(broker.answer({ ...prompt, allow: true })).toBe(true)
    await expect(pending).resolves.toBe(false)
    broker.close()
  })

  it('defaults to deny after timeout, disconnect, replaced process, or inactive task', async () => {
    vi.useFakeTimers()
    const prompts: CodexApprovalPrompt[] = []
    let active = true
    const broker = new CodexApprovalBroker({
      timeoutMs: 50,
      isTaskActive: () => active,
      onPrompt: (value) => prompts.push(value),
    })
    broker.activateProcess(1)
    const timeout = broker.request(approval({ processGeneration: 1 }))
    await vi.advanceTimersByTimeAsync(50)
    await expect(timeout).resolves.toBe(false)

    const disconnected = broker.request(approval({ requestId: 10, processGeneration: 1 }))
    broker.disconnectProcess(1)
    await expect(disconnected).resolves.toBe(false)

    broker.activateProcess(2)
    const stale = broker.request(approval({ requestId: 11, processGeneration: 2 }))
    broker.activateProcess(3)
    await expect(stale).resolves.toBe(false)

    const inactive = broker.request(approval({ requestId: 12, processGeneration: 3 }))
    active = false
    expect(broker.answer({ ...prompts.at(-1)!, allow: true })).toBe(true)
    await expect(inactive).resolves.toBe(false)
    broker.close()
    vi.useRealTimers()
  })

  it('denies requests when there is no active process and rejects duplicate pending protocol ids', async () => {
    const broker = new CodexApprovalBroker({ onPrompt: vi.fn(), isTaskActive: () => true })
    await expect(broker.request(approval())).resolves.toBe(false)
    broker.activateProcess(2)
    const first = broker.request(approval())
    await expect(broker.request(approval())).resolves.toBe(false)
    broker.disconnectProcess(2)
    await expect(first).resolves.toBe(false)
    broker.close()
  })
})
