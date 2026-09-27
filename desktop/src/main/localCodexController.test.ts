// @vitest-environment node
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalCodexEvent } from '../shared/bridge/types'
import { makeCodexProjectId, makeCodexTaskId } from './adapters/codex/ids'
import type { OwnedCodexMetadataV1 } from './adapters/codex/metadata'
import {
  LocalCodexController,
  PINNED_CODEX_EXECUTABLE,
  resolveCodexExecutable,
} from './localCodexController'
import type { LocalCodexRuntime } from './localCodexController'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('main-owned local Codex controller', () => {
  let root: string
  let state: OwnedCodexMetadataV1
  let metadata: {
    read: ReturnType<typeof vi.fn<() => Promise<OwnedCodexMetadataV1>>>
    replace: ReturnType<typeof vi.fn<(next: unknown) => Promise<OwnedCodexMetadataV1>>>
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archon-local-controller-'))
    state = { version: 1, projects: [], sessions: [] }
    metadata = {
      read: vi.fn(async () => structuredClone(state)),
      replace: vi.fn(async (next: unknown) => {
        state = structuredClone(next as OwnedCodexMetadataV1)
        return structuredClone(state)
      }),
    }
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const createController = (pickProjectDirectory: () => Promise<string | null>, createRuntime = vi.fn()) =>
    new LocalCodexController({ metadata, pickProjectDirectory, createRuntime })

  it('reserves registration before opening the picker and serializes registry writes', async () => {
    const picker = deferred<string | null>()
    const pickProjectDirectory = vi.fn(() => picker.promise)
    const controller = createController(pickProjectDirectory)
    const first = controller.registerProject()
    await expect(controller.registerProject()).rejects.toThrow(/active local codex turn/i)
    expect(pickProjectDirectory).toHaveBeenCalledTimes(1)

    picker.resolve(root)
    await expect(first).resolves.toMatchObject({ rootPath: root, name: root.split('/').at(-1) })
    expect(metadata.replace).toHaveBeenCalledTimes(1)
    expect(state.projects).toHaveLength(1)
    controller.close()
  })

  it('does not write a project when the controller closes while the native picker is open', async () => {
    const picker = deferred<string | null>()
    const controller = createController(() => picker.promise)
    const registration = controller.registerProject()
    controller.close()
    picker.resolve(root)

    await expect(registration).rejects.toThrow(/closed/i)
    expect(metadata.replace).not.toHaveBeenCalled()
  })

  it('does not create or launch a runtime when close wins a pending metadata read', async () => {
    const projectId = makeCodexProjectId('close-during-read')
    state.projects = [{ id: projectId, name: 'Fixture', primary_path: root, runtime: 'codex' }]
    const read = deferred<OwnedCodexMetadataV1>()
    metadata.read.mockImplementationOnce(() => read.promise)
    const createRuntime = vi.fn()
    const controller = createController(async () => null, createRuntime)
    const start = controller.startTurn({ projectId, prompt: 'Do not start after close.' })
    expect(controller.hasActiveWork).toBe(true)
    controller.close()
    expect(controller.hasActiveWork).toBe(false)
    read.resolve(structuredClone(state))

    await expect(start).rejects.toThrow(/could not start/i)
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('caps the main-owned project registry before append', async () => {
    state.projects = Array.from({ length: 100 }, (_, index) => ({
      id: makeCodexProjectId(`existing-${index}`),
      name: `Existing ${index}`,
      primary_path: `/tmp/existing-${index}`,
      runtime: 'codex',
    }))
    const controller = createController(async () => root)
    await expect(controller.registerProject()).rejects.toThrow(/limit/i)
    expect(metadata.replace).not.toHaveBeenCalled()
    controller.close()
  })

  it('returns the running acknowledgement before a buffered terminal event', async () => {
    const projectId = makeCodexProjectId('terminal-race')
    const taskId = makeCodexTaskId('terminal-race')
    const sessionId = 'codex:terminal-race'
    state.projects = [{ id: projectId, name: 'Fixture', primary_path: root, runtime: 'codex' }]
    state.sessions = [{
      id: sessionId,
      threadId: 'terminal-race',
      title: 'Fixture',
      cwd: root,
      projectId,
      turns: [{ id: taskId, turnId: 'native-turn' }],
    }]
    const runtimeFactory = vi.fn((_project, handlers) => {
      let snapshot: Record<string, unknown> | null = null
      const turn = {
        projectId,
        sessionId,
        taskId,
        status: 'completed',
        text: 'Finished',
        progress: '',
        truncated: false,
        error: null,
      }
      const runtime = {
        project: { id: projectId, name: 'Fixture', rootPath: root },
        service: {
          snapshot: () => snapshot,
          startTurn: async () => { snapshot = turn; handlers.onTurn(turn); return turn },
          cancel: async () => undefined,
          isTaskActive: () => false,
          resolveApprovalContext: () => undefined,
          onDisconnect: () => undefined,
          close: () => undefined,
        },
        approvals: { answer: () => false },
        close: () => undefined,
      }
      return runtime as unknown as LocalCodexRuntime
    })
    const controller = createController(async () => root, runtimeFactory)
    const events: LocalCodexEvent[] = []
    controller.subscribe((event) => events.push(event))

    const acknowledgement = await controller.startTurn({ projectId, prompt: 'Complete this fixture turn.' })
    expect(acknowledgement).toMatchObject({ taskId, projectId, sessionId, state: 'running' })
    expect(events).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toContainEqual({ type: 'turn.completed', taskId })
    controller.close()
  })

  it('validates development executable overrides and ignores them when packaged', async () => {
    const executable = join(root, 'fake-codex')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o700)
    await expect(resolveCodexExecutable(executable, false)).resolves.toBe(executable)
    await expect(resolveCodexExecutable('/tmp/missing-codex', true)).resolves.toBe(PINNED_CODEX_EXECUTABLE)
    await expect(resolveCodexExecutable('relative-codex', false)).rejects.toThrow(/absolute path/i)
  })
})
