import { describe, expect, it } from 'vitest'
import type { RuntimeRecord } from '../../shared/bridge/types'
import {
  advanceTask,
  continuationBlocker,
  liveProjects,
  liveSessions,
  liveTasks,
  runtimeChoices,
  trackTask,
  transcriptEntries,
} from './liveModels'

const verified = {
  id: 'prime-session-1', source: 'prime', title: 'Refactor the queue', model: 'prime-agent', cwd: '/srv/work',
  project_id: 'project-1', started_at: 1_790_000_000, last_active: 1_790_000_600, message_count: 4, active: false,
  preview: 'Latest ask', ownership_state: 'verified', ownership_reason: null, runtime: 'prime', read_only: false, can_delete: true,
}

describe('live server view models', () => {
  it('keeps server session identity opaque and fails closed on ownership and write access', () => {
    const { read_only: _readOnly, ...withoutReadOnly } = verified
    const sessions = liveSessions([
      verified,
      { ...verified, id: 'prime-session-1', title: 'Duplicate id is dropped' },
      { ...verified, id: '../escape' },
      { ...verified, id: 'pi-native-abc', runtime: 'pi', read_only: false },
      { ...withoutReadOnly, id: 'missing-read-only' },
      { ...verified, id: 'review', ownership_state: 'review_required', ownership_reason: 'Runtime\nchanged', runtime: null },
      { ...verified, id: 'ambiguous', project_ownership_ambiguous: true },
      { ...verified, id: 'odd-state', ownership_state: 'something-new', runtime: 'prime' },
      { ...verified, id: 'bad-runtime', runtime: 'codex' },
    ])
    expect(sessions.map((session) => session.id)).toEqual([
      'prime-session-1', 'pi-native-abc', 'missing-read-only', 'review', 'ambiguous', 'odd-state', 'bad-runtime',
    ])
    const [first, nativePi, missingReadOnly, review, ambiguous, oddState, badRuntime] = sessions
    expect(first).toMatchObject({ title: 'Refactor the queue', runtime: 'prime', readOnly: false, ownership: 'verified', lastActive: 1_790_000_600, messageCount: 4 })
    expect(continuationBlocker(first)).toBeNull()
    expect(nativePi.readOnly).toBe(true)
    expect(continuationBlocker(nativePi)).toMatch(/read-only/)
    expect(missingReadOnly.readOnly).toBe(true)
    expect(review).toMatchObject({ ownership: 'review_required', runtime: null, ownershipReason: 'Runtime changed' })
    expect(continuationBlocker(review)).toMatch(/requires review: Runtime changed/)
    expect(ambiguous).toMatchObject({ ownership: 'review_required', runtime: null })
    expect(oddState).toMatchObject({ ownership: 'unverified', runtime: null })
    expect(continuationBlocker(oddState)).toMatch(/not verified/)
    expect(badRuntime.runtime).toBeNull()
    expect(continuationBlocker(badRuntime)).toMatch(/not verified/)
  })

  it('projects only well-formed server projects, without merging by name', () => {
    expect(liveProjects([
      { id: 'project-1', name: 'Same name', primary_path: '/srv/one' },
      { id: 'project-2', name: 'Same name', primary_path: 'relative/path' },
      { id: 'project-1', name: 'Duplicate id' },
      { id: ' padded ', name: 'Bad id' },
      { id: 7, name: 'Numeric id' },
      { id: 'project-3', name: '   ' },
    ])).toEqual([
      { id: 'project-1', name: 'Same name', primaryPath: '/srv/one' },
      { id: 'project-2', name: 'Same name', primaryPath: null },
      { id: 'project-3', name: 'project-3', primaryPath: null },
    ])
  })

  it('shows user and assistant text in full and collapses reasoning, tool and native records', () => {
    const entries = transcriptEntries([
      { id: 'a', role: 'user', content: 'Question', kind: 'text', timestamp: 1 },
      { id: 'b', role: 'assistant', content: 'x'.repeat(20_005), kind: 'text', timestamp: 2 },
      { id: 'c', role: 'assistant', content: 'private reasoning', kind: 'thinking', timestamp: 3 },
      { id: 'd', role: 'assistant', content: 'read_file\n{}', kind: 'tool', timestamp: 4 },
      { id: 'e', role: 'toolResult', content: 'output', kind: 'tool_result', timestamp: 5 },
      { id: 'f', role: 'assistant', content: 'Native message record', kind: 'native', timestamp: 6 },
      { id: 'a', role: 'system', content: 'duplicate id', kind: 'text', timestamp: 7 },
    ], 'pi')
    expect(entries.map((entry) => [entry.label, entry.primary])).toEqual([
      ['You', true], ['Pi', true], ['Reasoning', false], ['Tool call', false], ['Tool result', false], ['Native record', false],
      ['Other record (text)', false],
    ])
    expect(entries[1].content).toHaveLength(20_000)
    expect(entries[1].hiddenCharacters).toBe(5)
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length)
  })

  it('labels task status truthfully and keeps review-required work separate', () => {
    const tasks = liveTasks([
      { id: 'task-running', status: 'running', runtime_id: 'prime', session_id: 'prime-session-1', prompt: 'Do\nwork' },
      { id: 'task-queued', status: 'queued', profile: 'pi' },
      { id: 'task-cancelling', status: 'cancelling', runtime_id: 'pi' },
      { id: 'task-interrupted', status: 'interrupted', result: { recovery: { review_required: true } } },
      { id: 'task-mystery', status: 'teleported' },
      { id: 'task-failed', status: 'failed', error: 'Runtime unavailable', session_id: '../bad' },
      { id: 'task/../bad', status: 'completed' },
      { status: 'completed' },
    ])
    expect(tasks.map((task) => [task.id, task.statusLabel, task.recoveryLabel, task.runtime])).toEqual([
      ['task-running', 'Running', null, 'prime'],
      ['task-queued', 'Queued', null, 'pi'],
      ['task-cancelling', 'Cancelling', null, 'pi'],
      ['task-interrupted', 'Interrupted', 'Review required', null],
      ['task-mystery', 'Unknown status', null, null],
      ['task-failed', 'Failed', null, null],
    ])
    expect(tasks[0]).toMatchObject({ sessionId: 'prime-session-1', prompt: 'Do work', rawStatus: 'running' })
    expect(tasks[5]).toMatchObject({ sessionId: null, error: 'Runtime unavailable' })
  })

  it('offers only available runtimes and labels unverified versions honestly', () => {
    const runtime = (id: 'prime' | 'pi', available: boolean, version: string | null, versionVerified: boolean): RuntimeRecord => ({
      id, aliases: [id], available, availability_check: 'executable_file', version, version_verified: versionVerified,
      availability_note: '', modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }], chat_only: false, sandboxed: false,
    })
    expect(runtimeChoices([runtime('prime', true, '1.2.3', false), runtime('pi', false, null, false)])).toEqual([
      { id: 'prime', label: 'Prime · version unverified' },
    ])
    expect(runtimeChoices([runtime('pi', true, '0.9', true)])).toEqual([{ id: 'pi', label: 'Pi · version 0.9' }])
  })

  it('streams assistant deltas and tool names without exposing tool arguments or unknown events', () => {
    const tracked = trackTask({ id: 'task-1', status: 'queued', session_id: 'prime-session-1' })
    const next = advanceTask(tracked, { id: 'task-1', status: 'running' }, [
      { seq: 3, task_id: 'task-1', type: 'message.delta', data: { text: 'Hello ' }, created_at: 'now', attempt_id: null },
      { seq: 4, task_id: 'task-1', type: 'tool', data: { phase: 'start', tool: 'read_file', arguments: 'ARG_SECRET' }, created_at: 'now', attempt_id: null },
      { seq: 5, task_id: 'task-1', type: 'output', data: { text: 'THINKING_SECRET' }, created_at: 'now', attempt_id: null },
      { seq: 6, task_id: 'task-1', type: 'message.delta', data: { text: 'world' }, created_at: 'now', attempt_id: null },
    ], true)
    expect(next).toMatchObject({ status: 'running', after: 6, polls: 1, replyText: 'Hello world', toolNote: 'Started read_file', sessionId: 'prime-session-1' })
    expect(JSON.stringify(next)).not.toContain('ARG_SECRET')
    expect(JSON.stringify(next)).not.toContain('THINKING_SECRET')
    const failed = advanceTask(next, null, null, true)
    expect(failed).toMatchObject({ status: 'running', statusCheckFailed: true, eventsCheckFailed: true, polls: 2 })
  })
})
