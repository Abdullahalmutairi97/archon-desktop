import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient, type CodexChildProcess, type CodexSpawnOptions } from './appServer'
import { CodexApprovalBroker, createCodexApprovalHooks, type CodexApprovalPrompt } from './approvalBroker'

function fakeAppServer() {
  const child = new EventEmitter() as CodexChildProcess & { kill: ReturnType<typeof vi.fn> }
  child.stdin = new PassThrough()
  const output = new PassThrough()
  child.stdout = output
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => {
    child.emit('exit', 0, null)
    return true
  })
  const received: Array<Record<string, unknown>> = []
  let input = ''
  child.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    let newline = input.indexOf('\n')
    while (newline >= 0) {
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      const message = JSON.parse(line) as Record<string, unknown>
      received.push(message)
      if (message.method === 'initialize') {
        queueMicrotask(() => output.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex/fake' } })}\n`))
      } else if (message.id !== undefined && message.method !== 'slow/test') {
        queueMicrotask(() => output.write(`${JSON.stringify({ id: message.id, result: { echoed: message.method } })}\n`))
      }
      newline = input.indexOf('\n')
    }
  })
  return { child, output, received }
}

describe('injected Codex app-server client', () => {
  it('requires an explicit child environment before accepting a spawner', () => {
    const f = fakeAppServer()
    expect(() => new CodexAppServerClient({
      command: 'fixture',
      env: undefined as unknown as Record<string, string>,
      spawn: () => f.child,
    })).toThrow(/explicit Codex child environment/i)
  })

  it('initializes the fake protocol process and correlates request responses', async () => {
    const f = fakeAppServer()
    const spawn = vi.fn((_command: string, _args: string[], _options: CodexSpawnOptions) => f.child)
    const env = { PATH: '/fixture/bin', HOME: '/fixture/home', CODEX_HOME: '/fixture/codex-home' }
    const client = new CodexAppServerClient({ command: '/fixture/codex', env, spawn, requestTimeoutMs: 100 })
    try {
      expect(await client.request('model/list', { limit: 5 })).toEqual({ echoed: 'model/list' })
      expect(spawn).toHaveBeenCalledWith('/fixture/codex', ['app-server'], expect.objectContaining({ env }))
      expect(Object.keys(spawn.mock.calls[0][2].env)).toEqual(Object.keys(env))
      expect(f.received[0]).toMatchObject({ method: 'initialize' })
      expect(f.received.some((message) => message.method === 'initialized')).toBe(true)
      expect(client.processGeneration).toBe(1)
    } finally {
      client.close()
    }
  })

  it('routes notifications and denies approval requests when no approval handler is present', async () => {
    const f = fakeAppServer()
    const client = new CodexAppServerClient({ command: 'fixture', env: { PATH: '/fixture/bin' }, spawn: () => f.child, requestTimeoutMs: 100 })
    const notifications: Array<{ method: string; params: unknown }> = []
    client.onNotification((method, params) => notifications.push({ method, params }))
    try {
      await client.start()
      f.output.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } })}\n`)
      f.output.write(`${JSON.stringify({ id: 88, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } })}\n`)
      await new Promise((resolve) => setImmediate(resolve))
      expect(notifications).toEqual([{ method: 'turn/completed', params: { threadId: 'thread-1' } }])
      expect(f.received.at(-1)).toEqual({ id: 88, result: { decision: 'decline' } })
    } finally {
      client.close()
    }
  })

  it('times out unanswered calls and rejects in-flight calls when the process disconnects', async () => {
    const f = fakeAppServer()
    const client = new CodexAppServerClient({ command: 'fixture', env: { PATH: '/fixture/bin' }, spawn: () => f.child, requestTimeoutMs: 25 })
    await expect(client.request('slow/test')).rejects.toThrow(/time/i)

    const pending = client.request('slow/test')
    await new Promise((resolve) => setImmediate(resolve))
    f.child.emit('exit', 1, null)
    await expect(pending).rejects.toThrow(/closed|disconnected/i)
    client.close()
  })

  it('denies a late approval after its app-server process has been replaced', async () => {
    const first = fakeAppServer()
    const second = fakeAppServer()
    const spawned = [first, second]
    const prompts: CodexApprovalPrompt[] = []
    const broker = new CodexApprovalBroker({
      onPrompt: (prompt) => prompts.push(prompt),
      isTaskActive: () => true,
      timeoutMs: 500,
    })
    const hooks = createCodexApprovalHooks(broker, (request) => {
      const threadId = request.params.threadId
      if (typeof threadId !== 'string') return undefined
      return {
        sessionId: `codex:${threadId}`,
        threadId,
        taskId: 'codex-task:task-1',
        kind: 'command',
        command: String(request.params.command ?? ''),
        cwd: '/workspace/project',
        paths: [],
        reason: 'Codex requested a command.',
      }
    })
    const client = new CodexAppServerClient({
      command: 'fixture',
      env: { PATH: '/fixture/bin' },
      spawn: () => spawned.shift()!.child,
      requestTimeoutMs: 100,
      ...hooks,
    })
    try {
      await client.start()
      first.output.write(`${JSON.stringify({
        id: 91,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', command: 'npm test' },
      })}\n`)
      await new Promise((resolve) => setImmediate(resolve))
      const prompt = prompts[0]
      expect(prompt).toBeDefined()

      first.child.emit('exit', 1, null)
      await expect(client.request('model/list')).resolves.toEqual({ echoed: 'model/list' })
      expect(client.processGeneration).toBe(2)
      expect(broker.answer({ ...prompt, allow: true })).toBe(false)
      await new Promise((resolve) => setImmediate(resolve))
      expect(first.received.some((message) => message.id === 91
        && typeof message.result === 'object' && message.result !== null
        && 'decision' in message.result && message.result.decision === 'accept')).toBe(false)
    } finally {
      client.close()
      broker.close()
    }
  })
})
