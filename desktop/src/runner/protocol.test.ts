import { describe, expect, it, vi } from 'vitest'
import type { LocalCodexEvent, LocalCodexProjectDto, LocalCodexTurnDto } from '../shared/bridge/types'
import { LocalCodexRunnerProtocol, MAX_RUNNER_EVENT_HISTORY } from './protocol'
import { parseWorkerConfig } from './worker'

class FakeController {
  hasActiveWork = false
  readonly close = vi.fn()
  private readonly listeners = new Set<(event: LocalCodexEvent) => void>()
  readonly project: LocalCodexProjectDto = {
    id: 'codex-project:fixture',
    name: 'fixture',
    rootPath: '/tmp/fixture',
  }

  async listProjects(): Promise<readonly LocalCodexProjectDto[]> {
    return [this.project]
  }

  async listSessions(): Promise<[]> {
    return []
  }

  async registerWorkspaceRoot(): Promise<LocalCodexProjectDto> {
    return this.project
  }

  async startTurn(): Promise<LocalCodexTurnDto> {
    this.hasActiveWork = true
    return {
      taskId: 'codex-task:fixture',
      projectId: this.project.id,
      sessionId: 'codex:fixture',
      state: 'running',
    }
  }

  async cancelTurn(): Promise<boolean> {
    return true
  }

  answerApproval(): boolean {
    return true
  }

  subscribe(listener: (event: LocalCodexEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: LocalCodexEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

describe('LocalCodexRunnerProtocol', () => {
  it('dispatches only the fixed, validated project and turn methods', async () => {
    const controller = new FakeController()
    const protocol = new LocalCodexRunnerProtocol(controller, () => undefined)

    await expect(protocol.handle({ id: 1, method: 'listProjects', params: {} })).resolves.toEqual({
      id: 1,
      ok: true,
      result: [controller.project],
    })
    await expect(protocol.handle({
      id: 'turn',
      method: 'startTurn',
      params: { projectId: controller.project.id, prompt: 'continue' },
    })).resolves.toEqual({
      id: 'turn',
      ok: true,
      result: {
        taskId: 'codex-task:fixture',
        projectId: controller.project.id,
        sessionId: 'codex:fixture',
        state: 'running',
      },
    })
    await expect(protocol.handle({ id: 2, method: 'startTurn', params: { projectId: controller.project.id, prompt: 'x', extra: true } }))
      .resolves.toMatchObject({ id: 2, ok: false, error: { code: 'invalid_params' } })
    await expect(protocol.handle({ id: 3, method: 'arbitrary', params: {} }))
      .resolves.toMatchObject({ id: 3, ok: false, error: { code: 'method_not_found' } })
    await expect(protocol.handle({ id: 4, method: 'registerWorkspaceRoot', params: { rootPath: '../../etc' } }))
      .resolves.toMatchObject({ id: 4, ok: false, error: { code: 'invalid_params' } })
  })

  it('retains ordered events in a bounded ring and reports a replay gap', async () => {
    const controller = new FakeController()
    const output: unknown[] = []
    const protocol = new LocalCodexRunnerProtocol(controller, (message) => output.push(message))
    const event: LocalCodexEvent = { type: 'turn.completed', taskId: 'codex-task:fixture' }
    for (let index = 0; index < MAX_RUNNER_EVENT_HISTORY + 4; index += 1) controller.emit(event)

    const page = await protocol.handle({ id: 'replay', method: 'events', params: { after: 0, limit: 3 } })
    expect(page).toMatchObject({
      id: 'replay',
      ok: true,
      result: {
        cursor: 7,
        latest: MAX_RUNNER_EVENT_HISTORY + 4,
        oldest: 5,
        reset: true,
      },
    })
    if ('ok' in page && page.ok) {
      const replay = page.result as { events: readonly { seq: number }[] }
      expect(replay.events.map((record) => record.seq)).toEqual([5, 6, 7])
    }
    expect(output).toHaveLength(MAX_RUNNER_EVENT_HISTORY + 4)
    expect(output[0]).toMatchObject({ event: { seq: 1, event } })
    expect(output.at(-1)).toMatchObject({ event: { seq: MAX_RUNNER_EVENT_HISTORY + 4, event } })
  })

  it('keeps the controller after input EOF while a turn is active, then closes it at terminal', () => {
    const controller = new FakeController()
    const protocol = new LocalCodexRunnerProtocol(controller, () => undefined)
    controller.hasActiveWork = true
    protocol.inputClosed()
    expect(controller.close).not.toHaveBeenCalled()

    controller.hasActiveWork = false
    controller.emit({ type: 'turn.completed', taskId: 'codex-task:fixture' })
    expect(controller.close).toHaveBeenCalledOnce()
  })

  it('requires the parent to pass absolute profile and Codex paths', () => {
    expect(parseWorkerConfig([
      '--metadata-root', '/profile/local-codex',
      '--home-directory', '/home/user',
      '--codex-home-directory', '/home/user/.codex',
      '--codex-executable', '/usr/bin/codex',
    ])).toEqual({
      metadataRoot: '/profile/local-codex',
      homeDirectory: '/home/user',
      codexHomeDirectory: '/home/user/.codex',
      codexExecutable: '/usr/bin/codex',
    })
    expect(() => parseWorkerConfig(['--metadata-root', 'relative'])).toThrow()
    expect(() => parseWorkerConfig([
      '--metadata-root', '/profile', '--metadata-root', '/other',
      '--home-directory', '/home/user', '--codex-home-directory', '/home/user/.codex',
    ])).toThrow()
  })
})
