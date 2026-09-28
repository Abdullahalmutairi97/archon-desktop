import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionDescription, DesktopBridge, JsonRecord } from '../../shared/bridge/types'
import { encodeSnapshotV1, parseSnapshotV1 } from '../../shared/domain/snapshot'
import { App } from '../shell/App'
import { LiveChatView } from './LiveChat'
import { deletionFailureMessage, liveProjects, liveSessions, snapshotSourceMessages } from './liveModels'
import { LiveProjectsView, LiveSessionsView } from './LiveViews'
import type { LiveServer } from './useLiveServer'

afterEach(() => {
  cleanup()
  localStorage.clear()
  Reflect.deleteProperty(window, 'archon')
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(window, '__archonPwned')
})

const CONNECTED: ConnectionDescription = { serverUrl: 'https://archon.example', configured: true, storageMode: 'memory', generation: 4 }
const SESSION_ID = 'prime-session-1'

const verifiedSession: JsonRecord = {
  id: SESSION_ID, source: 'prime', title: 'Refactor the queue', model: 'prime-agent', cwd: '/srv/work/archon',
  project_id: 'project-1', started_at: 1_790_000_000, last_active: 1_790_000_600, message_count: 2, active: false,
  preview: 'Split the worker loop', ownership_state: 'verified', ownership_reason: null, runtime: 'prime', read_only: false, can_delete: true,
}
const secondSession: JsonRecord = { ...verifiedSession, id: 'prime-session-2', title: 'Write the docs' }
const runningSession: JsonRecord = { ...verifiedSession, id: 'prime-running', title: 'Busy work', active: true }
const nativePiSession: JsonRecord = {
  ...verifiedSession, id: 'pi-native-notes', source: 'pi-cli', title: 'Native Pi notes', runtime: 'pi', read_only: true, project_id: null,
}
const project: JsonRecord = { id: 'project-1', name: 'Archon backend', primary_path: '/srv/work/archon', folders: [] }
const transcript = [
  { id: 'task-1-prompt', role: 'user', content: 'Please split the worker loop.', kind: 'text', timestamp: 1_790_000_000 },
  { id: 'native-2:0', role: 'assistant', content: 'PRIVATE_REASONING_TEXT', kind: 'thinking', timestamp: 1_790_000_001 },
  { id: 'native-2:t', role: 'toolResult', content: 'PRIVATE_TOOL_OUTPUT', kind: 'tool_result', timestamp: 1_790_000_001 },
  { id: 'native-2:1', role: 'assistant', content: 'The loop is now split into two stages.', kind: 'text', timestamp: 1_790_000_002 },
]
const ALL_ROWS = [verifiedSession, secondSession, runningSession, nativePiSession]

type Handler = (operation: string, payload: Record<string, unknown>) => unknown

function makeBridge(handler: Handler) {
  const invoke = vi.fn((operation: string, payload: Record<string, unknown>) => Promise.resolve().then(() => handler(operation, payload)))
  const bridge = {
    connection: { describe: vi.fn(async () => CONNECTED) },
    api: { invoke },
    localCodex: { listProjects: vi.fn(async () => []), subscribe: vi.fn(() => () => undefined) },
  } as unknown as DesktopBridge
  return { bridge, invoke }
}

function defaults(operation: string, payload: Record<string, unknown> = {}): unknown {
  switch (operation) {
    case 'projects.list': return { projects: [project] }
    case 'sessions.list': return { sessions: ALL_ROWS }
    case 'sessions.messages': return { messages: transcript }
    case 'sessions.delete': return { ok: true, deleted: payload.sessionIds }
    case 'tasks.list': return { tasks: [] }
    case 'runtimes.list': return { runtimes: [] }
    case 'workspaces.list': return { workspaces: [] }
    default: throw new Error(`Unexpected operation: ${operation}`)
  }
}

function serverFor(bridge: DesktopBridge, rows: readonly JsonRecord[] = ALL_ROWS): LiveServer {
  return {
    status: 'ready',
    scope: { bridge, generation: 4, serverUrl: 'https://archon.example', localPairingAvailable: false },
    projects: liveProjects([project]),
    sessions: liveSessions(rows),
    refreshing: false,
    refresh: vi.fn(),
    renameSession: vi.fn(),
  }
}

function callsTo(invoke: ReturnType<typeof makeBridge>['invoke'], operation: string) {
  return invoke.mock.calls.filter(([name]) => name === operation)
}

function renderSessions(bridge: DesktopBridge, onSessionsDeleted = vi.fn()) {
  const server = serverFor(bridge)
  render(<LiveSessionsView server={server} selectedSessionId={null} onOpenSession={vi.fn()} onNewConversation={vi.fn()}
    onOpenConnection={vi.fn()} onSessionsDeleted={onSessionsDeleted} />)
  return { server, onSessionsDeleted }
}

function renderChat(bridge: DesktopBridge, sessionId = SESSION_ID, rows: readonly JsonRecord[] = ALL_ROWS) {
  const server = serverFor(bridge, rows)
  const onNewConversation = vi.fn()
  render(<LiveChatView server={server} sessionId={sessionId} preferredProjectId={null}
    onOpenSession={vi.fn()} onNewConversation={onNewConversation} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)
  return { server, onNewConversation }
}

describe('removing server conversations', () => {
  it('confirms before removing: cancel and Escape do nothing, confirm sends the exact ids once', async () => {
    const { bridge, invoke } = makeBridge((operation, payload) => defaults(operation, payload))
    const { server, onSessionsDeleted } = renderSessions(bridge)

    const remove = screen.getByRole('button', { name: 'Remove selected (0)' })
    expect(remove).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Select Busy work' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Select Native Pi notes' })).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Write the docs' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Refactor the queue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (2)' }))
    let dialog = screen.getByRole('dialog', { name: 'Remove 2 conversations?' })
    expect(within(dialog).getByText(/permanently removes the selected conversations and their Archon task history/)).toBeInTheDocument()
    expect(within(dialog).getByRole('list', { name: 'Conversations to remove' })).toHaveTextContent('Refactor the queueWrite the docs')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (2)' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(callsTo(invoke, 'sessions.delete')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (2)' }))
    dialog = screen.getByRole('dialog', { name: 'Remove 2 conversations?' })
    const confirm = within(dialog).getByRole('button', { name: 'Remove 2 conversations' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Sent in list order, exactly once, with no running or native Pi conversation in the batch.
    expect(callsTo(invoke, 'sessions.delete')).toEqual([['sessions.delete', { sessionIds: [SESSION_ID, 'prime-session-2'] }]])
    expect(onSessionsDeleted).toHaveBeenCalledWith([SESSION_ID, 'prime-session-2'])
    expect(server.refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Remove selected (0)' })).toBeDisabled()
  })

  it('selects every removable conversation at once and never the running or native Pi ones', async () => {
    const { bridge, invoke } = makeBridge((operation, payload) => defaults(operation, payload))
    renderSessions(bridge)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all removable' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (2)' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove 2 conversations' }))
    await waitFor(() => expect(callsTo(invoke, 'sessions.delete')).toHaveLength(1))
    expect(callsTo(invoke, 'sessions.delete')[0][1]).toEqual({ sessionIds: [SESSION_ID, 'prime-session-2'] })
  })

  it('shows a busy conversation failure honestly and refreshes the list', async () => {
    // Electron IPC keeps only the message of the main-process error.
    const { bridge } = makeBridge((operation, payload) => {
      if (operation === 'sessions.delete') {
        throw new Error("Error invoking remote method 'archon:api:invoke': BackendTransportError: A selected conversation has a queued or running task. Cancel its task first.")
      }
      return defaults(operation, payload)
    })
    const { server, onSessionsDeleted } = renderSessions(bridge)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Refactor the queue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (1)' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove 1 conversation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancel its task first')
    expect(onSessionsDeleted).not.toHaveBeenCalled()
    expect(server.refresh).toHaveBeenCalledTimes(1)
  })

  it('maps removal failures by code or by the message that survives IPC', () => {
    expect(deletionFailureMessage(Object.assign(new Error('x'), { code: 'session_busy' }))).toMatch(/Cancel its task first/)
    expect(deletionFailureMessage(Object.assign(new Error('x'), { code: 'session_not_found' }))).toMatch(/no longer exists/)
    expect(deletionFailureMessage(new Error('A selected conversation no longer exists on the server. Refresh the list.'))).toMatch(/Nothing was removed/)
    expect(deletionFailureMessage(new Error('Could not reach the configured server.'))).toMatch(/did not confirm the removal/)
  })

  it('deletes the open conversation after confirmation and leaves for a new conversation', async () => {
    const { bridge, invoke } = makeBridge((operation, payload) => defaults(operation, payload))
    const { server, onNewConversation } = renderChat(bridge)
    await screen.findByText('The loop is now split into two stages.')
    const remove = screen.getByRole('button', { name: 'Delete conversation' })
    await waitFor(() => expect(remove).toBeEnabled())

    fireEvent.click(remove)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this conversation?' })).getByRole('button', { name: 'Cancel' }))
    expect(callsTo(invoke, 'sessions.delete')).toHaveLength(0)
    expect(onNewConversation).not.toHaveBeenCalled()

    fireEvent.click(remove)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete conversation' }))
    await waitFor(() => expect(onNewConversation).toHaveBeenCalledWith('project-1'))
    expect(callsTo(invoke, 'sessions.delete')).toEqual([['sessions.delete', { sessionIds: [SESSION_ID] }]])
    expect(server.refresh).toHaveBeenCalledTimes(1)
  })

  it('disables deleting running, native Pi and unlisted conversations', async () => {
    const { bridge } = makeBridge((operation, payload) => defaults(operation, payload))
    for (const sessionId of ['prime-running', 'pi-native-notes', 'prime-unlisted']) {
      renderChat(bridge, sessionId)
      await screen.findByText('The loop is now split into two stages.')
      expect(screen.getByRole('button', { name: 'Delete conversation' })).toBeDisabled()
      cleanup()
    }
  })

  it('leaves an open conversation that was removed from the Sessions view', async () => {
    const { bridge, invoke } = makeBridge((operation, payload) => defaults(operation, payload))
    Object.defineProperty(window, 'archon', { value: bridge, configurable: true })
    render(<App />)
    const navigation = within(screen.getByRole('navigation', { name: 'Server conversations' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Server session: Refactor the queue' }))
    expect(await screen.findByRole('region', { name: 'Server conversation' })).toBeInTheDocument()

    fireEvent.click(navigation.getByRole('button', { name: 'Sessions' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Refactor the queue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (1)' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove 1 conversation' }))
    await waitFor(() => expect(callsTo(invoke, 'sessions.delete')).toHaveLength(1))

    fireEvent.click(navigation.getByRole('button', { name: 'Chat' }))
    expect(await screen.findByRole('region', { name: 'New server conversation' })).toBeInTheDocument()
  })
})

describe('read-only sharing', () => {
  it('shares only user and assistant text after a review, with a copyable code', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { bridge, invoke } = makeBridge((operation, payload) => defaults(operation, payload))
    renderChat(bridge)
    await screen.findByText('The loop is now split into two stages.')

    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    const dialog = screen.getByRole('dialog', { name: 'Share “Refactor the queue”' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(await within(dialog).findByText(/Review what will be shared: 1 conversation, 2 messages\./)).toBeInTheDocument()
    expect(within(dialog).queryByText(/PRIVATE_/)).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('sessions.messages', { sessionId: SESSION_ID, limit: 500 })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create sharing code' }))
    const field = within(dialog).getByRole('textbox', { name: 'Sharing code' })
    const code = (field as HTMLTextAreaElement).value
    expect(field).toHaveAttribute('readonly')
    expect(code.startsWith('archon-snapshot:')).toBe(true)
    expect(code).not.toContain('PRIVATE_')
    expect(parseSnapshotV1(code)).toEqual({
      type: 'archon-collab', version: 2, kind: 'session', title: 'Refactor the queue',
      sessions: [{ id: SESSION_ID, title: 'Refactor the queue', messages: [
        { role: 'user', content: 'Please split the worker loop.' },
        { role: 'agent', content: 'The loop is now split into two stages.' },
      ] }],
    })
    expect(JSON.stringify(parseSnapshotV1(code))).not.toContain('PRIVATE_')
    expect(within(dialog).getByText(/KB code · snapshot content is limited to 1 MB/)).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy code' }))
    expect(await within(dialog).findByText('Sharing code copied.')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(code)
  })

  it('falls back to a selectable code when the clipboard is refused', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied') }) }, configurable: true })
    const { bridge } = makeBridge((operation, payload) => defaults(operation, payload))
    renderChat(bridge)
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create sharing code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed. Select the code above and copy it manually.')
    expect(screen.getByRole('textbox', { name: 'Sharing code' })).toHaveFocus()
  })

  it('shares a project’s conversations and refuses a project that is too large', async () => {
    const { bridge, invoke } = makeBridge((operation, payload) => operation === 'sessions.list'
      ? { sessions: [verifiedSession, secondSession, { ...verifiedSession, id: 'elsewhere', project_id: 'project-2' }] }
      : defaults(operation, payload))
    render(<LiveProjectsView server={serverFor(bridge)} selectedProjectId={null} selectedSessionId={null} onSelectProject={vi.fn()}
      onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Share project Archon backend' }))
    const dialog = screen.getByRole('dialog', { name: 'Share project “Archon backend”' })
    expect(await within(dialog).findByText(/Review what will be shared: 2 conversations, 4 messages\./)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('sessions.list', { projectId: 'project-1', limit: 200 })
    expect(callsTo(invoke, 'sessions.messages').map(([, payload]) => payload)).toEqual([
      { sessionId: SESSION_ID, limit: 500 }, { sessionId: 'prime-session-2', limit: 500 },
    ])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create sharing code' }))
    const shared = parseSnapshotV1((within(dialog).getByRole('textbox', { name: 'Sharing code' }) as HTMLTextAreaElement).value)
    expect(shared.kind).toBe('project')
    expect(shared.title).toBe('Archon backend')
    expect(shared.sessions.map((session) => session.id)).toEqual([SESSION_ID, 'prime-session-2'])
    cleanup()

    const many = Array.from({ length: 101 }, (_, index) => ({ ...verifiedSession, id: `prime-${index}`, title: `Chat ${index}` }))
    const large = makeBridge((operation, payload) => operation === 'sessions.list' ? { sessions: many } : defaults(operation, payload))
    render(<LiveProjectsView server={serverFor(large.bridge)} selectedProjectId={null} selectedSessionId={null} onSelectProject={vi.fn()}
      onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Share project Archon backend' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Share individual sessions from this large project.')
    expect(callsTo(large.invoke, 'sessions.messages')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Create sharing code' })).not.toBeInTheDocument()
  })

  it('opens a pasted snapshot read-only, rendering hostile content as text', async () => {
    const { bridge, invoke } = makeBridge((operation, payload) => defaults(operation, payload))
    renderSessions(bridge)
    fireEvent.click(screen.getByRole('button', { name: 'Open shared snapshot' }))
    const dialog = screen.getByRole('dialog', { name: 'Open a shared snapshot' })
    const field = within(dialog).getByRole('textbox', { name: 'Sharing code to open' })
    expect(field).toHaveFocus()

    fireEvent.change(field, { target: { value: 'archon-snapshot:not-base64!!' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open snapshot' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Invalid or oversized sharing code.')

    const hostileAgent = '<img src=x onerror="window.__archonPwned = true"> [link](javascript:alert(1))'
    const hostileUser = '<script>window.__archonPwned = true</script>'
    const code = encodeSnapshotV1({
      type: 'archon-collab', version: 2, kind: 'project', title: '<b>Shared</b>',
      sessions: [
        { id: 'a', title: 'First', messages: [{ role: 'user', content: hostileUser }, { role: 'agent', content: hostileAgent }] },
        { id: 'b', title: 'Second', messages: [{ role: 'agent', content: 'Second reply' }] },
      ],
    })
    fireEvent.change(field, { target: { value: code } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open snapshot' }))
    const content = within(dialog).getByRole('region', { name: 'Shared content' })
    expect(within(content).getByText('<b>Shared</b>')).toBeInTheDocument()
    expect(within(content).getByText(hostileUser)).toHaveAttribute('dir', 'auto')
    expect(content.textContent).toContain('<img src=x onerror="window.__archonPwned = true">')
    expect(content.querySelector('img, script, a, iframe, b')).toBeNull()
    expect((window as unknown as { __archonPwned?: boolean }).__archonPwned).toBeUndefined()

    fireEvent.change(within(content).getByRole('combobox', { name: 'Shared content: conversation' }), { target: { value: '1' } })
    expect(within(content).getByText('Second reply')).toBeInTheDocument()
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    expect(invoke.mock.calls.every(([operation]) => operation !== 'sessions.delete')).toBe(true)
  })

  it('keeps only user and assistant text rows from a transcript', () => {
    expect(snapshotSourceMessages(transcript.map((row) => ({ ...row })))).toEqual([
      { role: 'user', content: 'Please split the worker loop.' },
      { role: 'assistant', content: 'The loop is now split into two stages.' },
    ])
  })
})
