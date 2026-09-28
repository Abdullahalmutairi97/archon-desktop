import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, JsonRecord, TaskEventRecord, WorkspaceRecord } from '../../shared/bridge/types'
import { LiveChatView } from './LiveChat'
import { liveProjects, liveSessions } from './liveModels'
import { activityRows, activityView, appendActivity, checkoutChoices, defaultCheckout, EMPTY_ACTIVITY, LiveWorkbench } from './LiveWorkbench'
import type { LiveScope, LiveServer } from './useLiveServer'

afterEach(() => cleanup())

const ROOT = '/srv/archon/workspaces/workspace-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const project: JsonRecord = { id: 'project-1', name: 'Archon backend', primary_path: '/srv/work/archon', folders: [] }
const checkout: WorkspaceRecord = {
  workspace_id: `workspace-${'a'.repeat(32)}`, root: ROOT, project_id: 'project-1',
  base_revision: 'b'.repeat(40), head_revision: 'b'.repeat(40), generation: 2,
  owner_id: 'local-uid:1000', checkout: { state: 'branch', branch: 'feature/queue', commit: null, at_head_revision: null },
}
const other: WorkspaceRecord = { ...checkout, workspace_id: `workspace-${'c'.repeat(32)}`, root: '/srv/archon/workspaces/other', project_id: 'project-2' }
const sessionRow: JsonRecord = {
  id: 'prime-session-1', title: 'Refactor the queue', cwd: ROOT, project_id: 'project-1', last_active: 1_790_000_600,
  message_count: 2, active: false, ownership_state: 'verified', runtime: 'prime', read_only: false,
}

function bridgeFor(handler: (operation: string, payload: Record<string, unknown>) => unknown) {
  const invoke = vi.fn((operation: string, payload: Record<string, unknown>) => Promise.resolve().then(() => handler(operation, payload)))
  const bridge = {
    api: { invoke },
    workspaceConsole: { list: vi.fn(async () => []), subscribe: vi.fn(() => () => undefined) },
    workspaceServices: { list: vi.fn(async () => []) },
    workspacePreview: { close: vi.fn(async () => true) },
  } as unknown as DesktopBridge
  return { bridge, invoke }
}

function scopeFor(bridge: DesktopBridge, localPairingAvailable = true): LiveScope {
  return { bridge, generation: 3, serverUrl: 'http://127.0.0.1:9700', localPairingAvailable }
}

describe('live workbench models', () => {
  it('opens the checkout the conversation runs in, then one of its project, else none', () => {
    const choices = checkoutChoices([other, checkout], liveProjects([project]))
    expect(choices.map((choice) => choice.label)).toEqual(['project-2 · feature/queue', 'Archon backend · feature/queue'])
    const [session] = liveSessions([sessionRow])
    expect(defaultCheckout(session, choices)?.id).toBe(checkout.workspace_id)
    const [elsewhere] = liveSessions([{ ...sessionRow, cwd: '/srv/work/archon' }])
    expect(defaultCheckout(elsewhere, choices)?.id).toBe(checkout.workspace_id)
    const [unrelated] = liveSessions([{ ...sessionRow, cwd: '/srv/else', project_id: 'project-9' }])
    expect(defaultCheckout(unrelated, choices)).toBeNull()
    // An unverified conversation has no trusted cwd.
    const [unverified] = liveSessions([{ ...sessionRow, ownership_state: 'unverified' }])
    expect(unverified.cwd).toBeNull()
  })

  it('follows the event cursor across pages', () => {
    const event = (seq: number, text: string): TaskEventRecord => ({ seq, task_id: 't', type: 'message.delta', data: { text }, created_at: '', attempt_id: null })
    const first = appendActivity(EMPTY_ACTIVITY, [event(1, 'Hello '), event(2, 'there')])
    const second = appendActivity(first, [event(1001, ', page two')])
    expect(first.cursor).toBe(2)
    // A repeated page is ignored.
    expect(appendActivity(first, [event(2, 'there')])).toEqual(first)
    expect(second.cursor).toBe(1001)
    expect(activityView(second).at(-1)).toEqual({ key: 'answer', kind: 'answer', text: 'Hello there, page two' })
  })

  it('turns task events into bounded activity with the streamed answer last', () => {
    const event = (seq: number, type: string, data: JsonRecord): TaskEventRecord => ({ seq, task_id: 't', type, data, created_at: '', attempt_id: null })
    const rows = activityRows([
      event(1, 'tool', { phase: 'start', tool: 'bash', target: '{"command":"npm test"}' }),
      event(2, 'tool', { phase: 'end', tool: 'bash', exit_code: 1 }),
      event(3, 'message.delta', { text: 'Tests ' }),
      event(4, 'message.delta', { text: 'fail.' }),
      event(5, 'diagnostic', { detail: 'unhandled record' }),
    ])
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ['tool', 'bash · {"command":"npm test"}'],
      ['tool-end', 'Failed · bash'],
      ['diagnostic', 'unhandled record'],
      ['answer', 'Tests fail.'],
    ])
  })
})

describe('live workbench', () => {
  it('browses the files of the checkout the conversation runs in', async () => {
    const { bridge, invoke } = bridgeFor((operation) => {
      if (operation === 'workspaces.list') return { workspaces: [checkout] }
      if (operation === 'workspaces.files.list') return { path: '', entries: [{ name: 'README.md', path: 'README.md', kind: 'file', size: 12 }], truncated: false }
      if (operation === 'tasks.list') return { tasks: [] }
      throw new Error(operation)
    })
    const [session] = liveSessions([sessionRow])
    render(<LiveWorkbench scope={scopeFor(bridge)} session={session} projects={liveProjects([project])} active="files" onSelect={vi.fn()} onClose={vi.fn()} onOpenServerWork={vi.fn()} />)

    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(screen.getByLabelText('Checkout')).toHaveValue(checkout.workspace_id)
    expect(invoke).toHaveBeenCalledWith('workspaces.files.list', expect.objectContaining({ workspaceId: checkout.workspace_id, path: '' }))
  })

  it('says when a conversation has no checkout and links to Server work', async () => {
    const { bridge } = bridgeFor((operation) => {
      if (operation === 'workspaces.list') return { workspaces: [] }
      throw new Error(operation)
    })
    const openServerWork = vi.fn()
    const [session] = liveSessions([{ ...sessionRow, cwd: '/srv/work/archon' }])
    render(<LiveWorkbench scope={scopeFor(bridge)} session={session} projects={liveProjects([project])} active="files" onSelect={vi.fn()} onClose={vi.fn()} onOpenServerWork={openServerWork} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Create a checkout in Server work' }))
    expect(openServerWork).toHaveBeenCalled()
  })

  it('keeps terminals disabled without same-user pairing', async () => {
    const { bridge } = bridgeFor((operation) => {
      if (operation === 'workspaces.list') return { workspaces: [checkout] }
      throw new Error(operation)
    })
    const [session] = liveSessions([sessionRow])
    render(<LiveWorkbench scope={scopeFor(bridge, false)} session={session} projects={liveProjects([project])} active="terminal" onSelect={vi.fn()} onClose={vi.fn()} onOpenServerWork={vi.fn()} />)

    expect(await screen.findByText(/Terminals need same-user pairing/)).toBeInTheDocument()
    expect(bridge.workspaceConsole.list).not.toHaveBeenCalled()
  })

  it('lists only this conversation\'s tasks and their activity', async () => {
    const { bridge } = bridgeFor((operation, payload) => {
      if (operation === 'tasks.events' && Number(payload.after) >= 1) return { events: [] }
      if (operation === 'workspaces.list') return { workspaces: [] }
      if (operation === 'tasks.list') return { tasks: [
        { id: 'task-1', status: 'completed', session_id: 'prime-session-1', prompt: 'Split the loop', runtime_id: 'prime' },
        { id: 'task-2', status: 'completed', session_id: 'prime-other', prompt: 'Someone else', runtime_id: 'prime' },
      ] }
      if (operation === 'tasks.events') return { events: [
        { seq: 1, task_id: 'task-1', type: 'tool', data: { phase: 'start', tool: 'edit', target: 'worker.py' }, created_at: '', attempt_id: null },
      ] }
      throw new Error(operation)
    })
    const [session] = liveSessions([sessionRow])
    render(<LiveWorkbench scope={scopeFor(bridge)} session={session} projects={[]} active="activity" onSelect={vi.fn()} onClose={vi.fn()} onOpenServerWork={vi.fn()} />)

    expect(await screen.findByText('edit · worker.py')).toBeInTheDocument()
    expect(screen.getByText('Split the loop')).toBeInTheDocument()
    expect(screen.queryByText('Someone else')).not.toBeInTheDocument()
  })
})

describe('new conversation in a checkout', () => {
  it('submits to the checkout route with Prime when a checkout is chosen', async () => {
    const { bridge, invoke } = bridgeFor((operation) => {
      if (operation === 'workspaces.list') return { workspaces: [checkout] }
      if (operation === 'runtimes.list') return { runtimes: [
        { id: 'prime', aliases: [], available: true, availability_check: '', version: null, version_verified: false, availability_note: '', modes: [], chat_only: false, sandboxed: false },
        { id: 'pi', aliases: [], available: true, availability_check: '', version: null, version_verified: false, availability_note: '', modes: [], chat_only: false, sandboxed: false },
      ] }
      if (operation === 'tasks.submit') return { task: { id: 'task-9', status: 'queued' } }
      if (operation === 'tasks.get') return { task: { id: 'task-9', status: 'queued' } }
      if (operation === 'tasks.events') return { events: [] }
      throw new Error(operation)
    })
    const server: LiveServer = {
      status: 'ready', scope: scopeFor(bridge), projects: liveProjects([project]), sessions: [], refreshing: false, refresh: vi.fn(),
    }
    render(<LiveChatView server={server} sessionId={null} preferredProjectId="project-1" pollDelayMs={60_000} onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)

    await screen.findByRole('option', { name: /Checkout · Archon backend/ })
    fireEvent.change(screen.getByLabelText('Run in'), { target: { value: checkout.workspace_id } })
    expect(screen.getByLabelText('Runtime')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'Add a test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('tasks.submit', {
      projectId: 'project-1', prompt: 'Add a test', workspaceId: checkout.workspace_id, workspaceGeneration: 2,
    }))
  })
})
