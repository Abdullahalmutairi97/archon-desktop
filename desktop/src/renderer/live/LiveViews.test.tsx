import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionDescription, DesktopBridge, JsonRecord } from '../../shared/bridge/types'
import { App } from '../shell/App'
import { LiveChatView } from './LiveChat'
import { liveProjects, liveSessions } from './liveModels'
import { LiveProjectsView, LiveTasksView } from './LiveViews'
import type { LiveServer } from './useLiveServer'

afterEach(() => {
  cleanup()
  localStorage.clear()
  Reflect.deleteProperty(window, 'archon')
})

const CONNECTED: ConnectionDescription = { serverUrl: 'https://archon.example', configured: true, storageMode: 'memory', generation: 4 }
const DISCONNECTED: ConnectionDescription = { serverUrl: null, configured: false, storageMode: 'memory', generation: 0 }
const SESSION_ID = 'prime-session-1'

const verifiedSession: JsonRecord = {
  id: SESSION_ID, source: 'prime', title: 'Refactor the queue', model: 'prime-agent', cwd: '/srv/work/archon',
  project_id: 'project-1', started_at: 1_790_000_000, last_active: 1_790_000_600, message_count: 2, active: false,
  preview: 'Split the worker loop', ownership_state: 'verified', ownership_reason: null, runtime: 'prime', read_only: false, can_delete: true,
}
const nativePiSession: JsonRecord = {
  ...verifiedSession, id: 'pi-native-notes', source: 'pi-cli', title: 'Native Pi notes', runtime: 'pi', read_only: true, project_id: null,
}
const reviewSession: JsonRecord = {
  ...verifiedSession, id: 'prime-review', title: 'Changed runtime session', ownership_state: 'review_required',
  ownership_reason: 'The recorded runtime identity changed.', runtime: null,
}
const project: JsonRecord = { id: 'project-1', name: 'Archon backend', primary_path: '/srv/work/archon', folders: [] }
const transcript = [
  { id: 'task-1-prompt', role: 'user', content: 'Please split the worker loop.', kind: 'text', timestamp: 1_790_000_000 },
  { id: 'native-2:0', role: 'assistant', content: 'PRIVATE_REASONING_TEXT', kind: 'thinking', timestamp: 1_790_000_001 },
  { id: 'native-2:1', role: 'assistant', content: 'The loop is now split into two stages.', kind: 'text', timestamp: 1_790_000_002 },
]

type Handler = (operation: string, payload: Record<string, unknown>) => unknown

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function makeBridge(handler: Handler, describe: () => Promise<ConnectionDescription> = async () => CONNECTED) {
  const invoke = vi.fn((operation: string, payload: Record<string, unknown>) => Promise.resolve().then(() => handler(operation, payload)))
  const describeMock = vi.fn(describe)
  const bridge = {
    connection: { describe: describeMock },
    api: { invoke },
    localCodex: { listProjects: vi.fn(async () => []), subscribe: vi.fn(() => () => undefined) },
  } as unknown as DesktopBridge
  return { bridge, invoke, describe: describeMock }
}

function installBridge(bridge: DesktopBridge): void {
  Object.defineProperty(window, 'archon', { value: bridge, configurable: true })
}

function defaults(operation: string): unknown {
  switch (operation) {
    case 'projects.list': return { projects: [project] }
    case 'sessions.list': return { sessions: [verifiedSession, nativePiSession, reviewSession] }
    case 'sessions.messages': return { messages: transcript }
    case 'tasks.list': return { tasks: [] }
    case 'runtimes.list': return { runtimes: [] }
    default: throw new Error(`Unexpected operation: ${operation}`)
  }
}

function serverFor(bridge: DesktopBridge, rows: readonly JsonRecord[] = [verifiedSession, nativePiSession, reviewSession]): LiveServer {
  return {
    status: 'ready',
    scope: { bridge, generation: 4, serverUrl: 'https://archon.example', localPairingAvailable: false },
    projects: liveProjects([project]),
    sessions: liveSessions(rows),
    refreshing: false,
    refresh: vi.fn(),
  }
}

function callsTo(invoke: ReturnType<typeof makeBridge>['invoke'], operation: string) {
  return invoke.mock.calls.filter(([name]) => name === operation)
}

describe('live server views in the desktop shell', () => {
  it('shows live server sessions, projects and a real transcript instead of fixtures', async () => {
    const { bridge, invoke } = makeBridge((operation) => defaults(operation))
    installBridge(bridge)
    render(<App />)

    const liveNavigation = within(screen.getByRole('navigation', { name: 'Server conversations' }))
    expect(screen.queryByRole('button', { name: 'Preview/demo' })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Server session: Refactor the queue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Server project: Archon backend' })).toBeInTheDocument()

    fireEvent.click(liveNavigation.getByRole('button', { name: 'Sessions' }))
    const sessions = await screen.findByRole('region', { name: 'Server sessions' })
    expect(within(sessions).getByText('Refactor the queue')).toBeInTheDocument()
    expect(within(sessions).getByText('Native Pi notes')).toBeInTheDocument()
    expect(within(sessions).getByText('Read only')).toBeInTheDocument()
    expect(within(sessions).getByText('Review required')).toBeInTheDocument()
    expect(screen.getByText('SERVER SESSIONS')).toBeInTheDocument()
    expect(screen.getByText('SERVER CONVERSATIONS', { selector: '.reconstruction-ribbon span' })).toBeInTheDocument()
    expect(screen.queryByText('SYNTHETIC FIXTURE DATA')).not.toBeInTheDocument()
    expect(screen.queryByText(/PREVIEW\/DEMO/)).not.toBeInTheDocument()
    expect(screen.queryByText('Reconstruction shell review')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace tools' })).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveClass('workspace-main-live')

    fireEvent.click(within(sessions).getByRole('button', { name: /Refactor the queue/ }))
    const chat = await screen.findByRole('region', { name: 'Server conversation' })
    expect(await within(chat).findByText('The loop is now split into two stages.')).toBeInTheDocument()
    expect(within(chat).getByText('Please split the worker loop.')).toHaveAttribute('dir', 'auto')
    // Reasoning is collapsed behind a disclosure rather than shown as the reply.
    const reasoning = within(chat).getByText(/^Reasoning/, { selector: 'summary' }).closest('details')
    expect(reasoning).not.toBeNull()
    expect(reasoning).not.toHaveAttribute('open')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Refactor the queue')
    expect(invoke).toHaveBeenCalledWith('sessions.messages', { sessionId: SESSION_ID, limit: 200 })
    expect(invoke).toHaveBeenCalledWith('sessions.list', { limit: 200 })

    const message = within(chat).getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(within(chat).queryByText(/Checking this conversation for running tasks/)).not.toBeInTheDocument())
    expect(message).toBeEnabled()
    fireEvent.change(message, { target: { value: 'Continue with tests' } })
    expect(within(chat).getByRole('button', { name: 'Send message' })).toBeEnabled()
    expect(callsTo(invoke, 'tasks.submit')).toHaveLength(0)
  })

  it('shows an explicit not-connected state that points to Connection, with no fixture rows', async () => {
    const { bridge, invoke } = makeBridge((operation) => defaults(operation), async () => DISCONNECTED)
    installBridge(bridge)
    render(<App />)

    for (const route of ['Chat', 'Sessions', 'Tasks', 'Projects']) {
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Server conversations' })).getByRole('button', { name: route }))
      expect(await screen.findByText('Not connected')).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent(/No server connection is configured/)
      expect(screen.queryByText('Reconstruction shell review')).not.toBeInTheDocument()
      expect(screen.queryByRole('note')).not.toBeInTheDocument()
    }
    expect(screen.getByText('Not connected. Open Connection to list server work.')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open Connection' }))
    expect(await screen.findByRole('region', { name: 'Desktop connection' })).toBeInTheDocument()
  })

  it('shows a rejected token as access rejected, pointing to Connection, with no partial rows', async () => {
    const { bridge, invoke } = makeBridge((operation) => {
      if (operation === 'sessions.list') return Promise.reject(Object.assign(new Error('rejected'), { code: 'unauthorized' }))
      return defaults(operation)
    })
    installBridge(bridge)
    render(<App />)
    const liveNavigation = within(screen.getByRole('navigation', { name: 'Server conversations' }))
    for (const route of ['Sessions', 'Projects', 'Chat']) {
      fireEvent.click(liveNavigation.getByRole('button', { name: route }))
      expect(await screen.findByText('Access rejected')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open Connection' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    }
    // Projects loaded, but none are shown while the session half of the pair failed.
    expect(screen.queryByText('Archon backend')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Server project:/ })).not.toBeInTheDocument()
    expect(screen.getByText('Server access rejected. Check Connection.')).toBeInTheDocument()
    expect(callsTo(invoke, 'sessions.messages')).toHaveLength(0)
  })

  it('offers a retry for an unavailable server and loads rows after it succeeds', async () => {
    let fail = true
    const { bridge, invoke } = makeBridge((operation) => {
      if (operation === 'projects.list' && fail) return Promise.reject(new Error('offline'))
      return defaults(operation)
    })
    installBridge(bridge)
    render(<App />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Server conversations' })).getByRole('button', { name: 'Projects' }))
    expect(await screen.findByText('Server data unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Archon backend')).not.toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Server conversations' })).getByRole('button', { name: 'Chat' }))
    expect(await screen.findByText('Server data unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'New server conversation' })).not.toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Server conversations' })).getByRole('button', { name: 'Projects' }))

    fail = false
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'Archon backend' })).toBeInTheDocument()
    expect(callsTo(invoke, 'projects.list')).toHaveLength(2)
  })

  it('ignores collection responses that arrive for an earlier connection generation', async () => {
    const stale = deferred<unknown>()
    let sessionsCalls = 0
    let generation = 1
    const { bridge } = makeBridge((operation) => {
      if (operation === 'sessions.list') {
        sessionsCalls += 1
        return sessionsCalls === 1 ? stale.promise : { sessions: [{ ...verifiedSession, id: 'new-session', title: 'Session on the new server' }] }
      }
      if (operation === 'projects.list') return { projects: [] }
      return defaults(operation)
    }, async () => ({ ...CONNECTED, generation }))
    installBridge(bridge)
    render(<App />)
    await waitFor(() => expect(sessionsCalls).toBe(1))

    // The connection is replaced while the first list is still loading.
    generation = 2
    fireEvent.click(screen.getByRole('button', { name: 'Connection' }))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Server conversations' })).getByRole('button', { name: 'Sessions' }))
    expect(await screen.findByText('Session on the new server', { selector: '.session-card strong' })).toBeInTheDocument()

    await act(async () => {
      stale.resolve({ sessions: [{ ...verifiedSession, id: 'old-session', title: 'Session from the old server' }] })
    })
    expect(screen.queryByText('Session from the old server')).not.toBeInTheDocument()
    expect(screen.getByText('Session on the new server', { selector: '.session-card strong' })).toBeInTheDocument()
  })

  it('drops a selected conversation when the connection generation changes', async () => {
    let generation = 4
    const { bridge } = makeBridge((operation) => defaults(operation), async () => ({ ...CONNECTED, generation }))
    installBridge(bridge)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Server session: Refactor the queue' }))
    expect(await screen.findByText('The loop is now split into two stages.')).toBeInTheDocument()

    generation = 5
    fireEvent.click(screen.getByRole('button', { name: 'Connection' }))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Server conversations' })).getByRole('button', { name: 'Chat' }))
    expect(await screen.findByRole('region', { name: 'New server conversation' })).toBeInTheDocument()
    expect(screen.queryByText('The loop is now split into two stages.')).not.toBeInTheDocument()
  })

  it('keeps the labeled fixture demo when the desktop bridge is absent', () => {
    render(<App />)
    expect(screen.queryByRole('navigation', { name: 'Server conversations' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview/demo' }))
    expect(screen.getByRole('note')).toHaveTextContent('Sample data only')
    expect(screen.getByText('PREVIEW/DEMO · SYNTHETIC DATA')).toBeInTheDocument()
    expect(screen.getByText('SYNTHETIC FIXTURE DATA')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Synthetic chat transcript' })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Demo views' })).getByRole('button', { name: 'Demo sessions' }))
    expect(screen.getByRole('region', { name: 'Synthetic sessions' })).toBeInTheDocument()
  })
})

describe('live server conversation', () => {
  it('continues a conversation with the exact payload, follows the task, and reloads on completion', async () => {
    let finished = false
    let polls = 0
    const { bridge, invoke } = makeBridge((operation, payload) => {
      if (operation === 'tasks.submit') return { task: { id: 'task-9', status: 'queued', session_id: SESSION_ID } }
      if (operation === 'tasks.get') {
        polls += 1
        if (polls >= 2) finished = true
        return { task: finished
          ? { id: 'task-9', status: 'completed', session_id: SESSION_ID, result: { text: 'Tests added.' } }
          : { id: 'task-9', status: 'running', session_id: SESSION_ID } }
      }
      if (operation === 'tasks.events') {
        return { events: payload.after === 0 ? [{
          seq: 1, task_id: 'task-9', type: 'message.delta', data: { text: 'Adding tests now' },
          created_at: '2026-09-28T00:00:00Z', attempt_id: null,
        }] : [] }
      }
      if (operation === 'sessions.messages' && finished) return { messages: [
        ...transcript,
        { id: 'task-9-prompt', role: 'user', content: 'Add tests for it', kind: 'text', timestamp: 1_790_000_100 },
        { id: 'task-9-result', role: 'assistant', content: 'Tests added.', kind: 'text', timestamp: 1_790_000_200 },
      ] }
      return defaults(operation)
    })
    const server = serverFor(bridge)
    render(<LiveChatView server={server} sessionId={SESSION_ID} preferredProjectId={null} pollDelayMs={5}
      onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)

    await screen.findByText('The loop is now split into two stages.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Add tests for it' } })
    // Sending waits until the conversation has been checked for running work.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    expect(callsTo(invoke, 'tasks.list')).toEqual([['tasks.list', { limit: 100 }]])
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('region', { name: 'Conversation task' })).toBeInTheDocument()
    expect(callsTo(invoke, 'tasks.submit')).toEqual([
      ['tasks.submit', { sessionId: SESSION_ID, prompt: 'Add tests for it', projectId: 'project-1' }],
    ])
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()

    expect(await screen.findByText('Tests added.', { selector: '.live-message-text p' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Conversation task' })).not.toBeInTheDocument())
    expect(invoke).toHaveBeenCalledWith('tasks.get', { taskId: 'task-9' })
    expect(invoke).toHaveBeenCalledWith('tasks.events', { taskId: 'task-9', after: 0 })
    expect(invoke).toHaveBeenCalledWith('tasks.events', { taskId: 'task-9', after: 1 })
    expect(callsTo(invoke, 'sessions.messages')).toHaveLength(2)
    expect(server.refresh).toHaveBeenCalledTimes(1)
    expect(callsTo(invoke, 'tasks.submit')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  })

  it('disables the composer with a clear reason for read-only and review-required conversations', async () => {
    const { bridge, invoke } = makeBridge((operation) => defaults(operation))
    const { unmount } = render(<LiveChatView server={serverFor(bridge)} sessionId="pi-native-notes" preferredProjectId={null}
      onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)
    await screen.findByText('The loop is now split into two stages.')
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByText(/This conversation is read-only on the server/)).toBeInTheDocument()
    expect(screen.getByText('READ ONLY')).toBeInTheDocument()
    unmount()

    render(<LiveChatView server={serverFor(bridge)} sessionId="prime-review" preferredProjectId={null}
      onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)
    await screen.findByText('The loop is now split into two stages.')
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByText(/requires review: The recorded runtime identity changed/)).toBeInTheDocument()
    expect(screen.getByText('REVIEW REQUIRED')).toBeInTheDocument()
    expect(callsTo(invoke, 'tasks.submit')).toHaveLength(0)
  })

  it('renders hostile transcript content as inert text', async () => {
    const hostile = '<img src=x onerror="window.__archonPwned = true"><script>window.__archonPwned = true</script>'
    const { bridge } = makeBridge((operation) => operation === 'sessions.messages'
      ? { messages: [
        { id: 'm1', role: 'assistant', content: hostile, kind: 'text', timestamp: 1 },
        { id: 'm2', role: 'toolResult', content: `<a href="javascript:alert(1)">tool</a>`, kind: 'tool_result', timestamp: 2 },
      ] }
      : defaults(operation))
    render(<LiveChatView server={serverFor(bridge)} sessionId={SESSION_ID} preferredProjectId={null}
      onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)
    const list = await screen.findByLabelText('Conversation transcript')
    expect(await within(list).findByText(hostile)).toBeInTheDocument()
    expect(within(list).getByText('<a href="javascript:alert(1)">tool</a>')).toBeInTheDocument()
    expect(list.querySelector('img, script, a, iframe')).toBeNull()
    expect((window as unknown as { __archonPwned?: boolean }).__archonPwned).toBeUndefined()
  })

  it('attaches to a task already running in the conversation and reads back a cancellation', async () => {
    let cancelled = false
    const { bridge, invoke } = makeBridge((operation) => {
      if (operation === 'tasks.list') return { tasks: [
        { id: 'task-other', status: 'running', session_id: 'another-session' },
        { id: 'task-live', status: 'running', session_id: SESSION_ID, runtime_id: 'prime' },
      ] }
      if (operation === 'tasks.cancel') {
        cancelled = true
        return { ok: true }
      }
      if (operation === 'tasks.get') return { task: { id: 'task-live', status: cancelled ? 'cancelled' : 'running' } }
      if (operation === 'tasks.events') return { events: [] }
      return defaults(operation)
    })
    render(<LiveChatView server={serverFor(bridge)} sessionId={SESSION_ID} preferredProjectId={null} pollDelayMs={60_000}
      onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)

    const task = await screen.findByRole('region', { name: 'Conversation task' })
    expect(within(task).getByText('task-live')).toBeInTheDocument()
    expect(screen.getByText(/A task is already running in this conversation/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Another message' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()

    fireEvent.click(within(task).getByRole('button', { name: 'Cancel task' }))
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Conversation task' })).getByRole('status')).toHaveTextContent('Cancelled'))
    expect(invoke).toHaveBeenCalledWith('tasks.cancel', { taskId: 'task-live' })
    expect(callsTo(invoke, 'tasks.cancel')).toHaveLength(1)
    expect(callsTo(invoke, 'tasks.submit')).toHaveLength(0)
  })

  it('treats a failed send as an unknown outcome, never resends it, and checks the server on request', async () => {
    const { bridge, invoke } = makeBridge((operation) => {
      if (operation === 'tasks.submit') return Promise.reject(new Error('connection dropped'))
      return defaults(operation)
    })
    const server = serverFor(bridge)
    render(<LiveChatView server={server} sessionId={SESSION_ID} preferredProjectId={null}
      onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)
    await screen.findByText('The loop is now split into two stages.')
    await waitFor(() => expect(callsTo(invoke, 'tasks.list')).toHaveLength(1))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Only once' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByText('Message outcome unknown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Only once')
    fireEvent.click(screen.getByRole('button', { name: 'Check the server' }))
    expect(await screen.findByText(/No running task was found for this conversation/)).toBeInTheDocument()
    expect(callsTo(invoke, 'tasks.list')).toHaveLength(2)
    expect(callsTo(invoke, 'tasks.submit')).toHaveLength(1)
    expect(server.refresh).toHaveBeenCalled()
  })

  it('ignores a transcript that arrives after another conversation was opened', async () => {
    const slow = deferred<unknown>()
    const { bridge } = makeBridge((operation, payload) => {
      if (operation === 'sessions.messages' && payload.sessionId === SESSION_ID) return slow.promise
      if (operation === 'sessions.messages') return { messages: [{ id: 'x', role: 'user', content: 'Second conversation text', kind: 'text', timestamp: 1 }] }
      return defaults(operation)
    })
    const server = serverFor(bridge)
    const props = { preferredProjectId: null, onOpenSession: vi.fn(), onNewConversation: vi.fn(), onOpenConnection: vi.fn(), onOpenTasks: vi.fn() }
    const { rerender } = render(<LiveChatView server={server} sessionId={SESSION_ID} {...props} />)
    rerender(<LiveChatView server={server} sessionId="prime-review" {...props} />)
    expect(await screen.findByText('Second conversation text')).toBeInTheDocument()
    await act(async () => { slow.resolve({ messages: [{ id: 'y', role: 'user', content: 'First conversation text', kind: 'text', timestamp: 1 }] }) })
    expect(screen.queryByText('First conversation text')).not.toBeInTheDocument()
  })

  it('starts a new conversation with an available runtime and opens it once it completes', async () => {
    const onOpenSession = vi.fn()
    const { bridge, invoke } = makeBridge((operation) => {
      if (operation === 'runtimes.list') return { runtimes: [
        { id: 'prime', aliases: ['prime'], available: true, availability_check: 'executable_file', version: null, version_verified: false,
          availability_note: '', modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }], chat_only: false, sandboxed: false },
        { id: 'pi', aliases: ['pi'], available: false, availability_check: 'executable_file', version: null, version_verified: false,
          availability_note: '', modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }], chat_only: false, sandboxed: false },
      ] }
      if (operation === 'tasks.submit') return { task: { id: 'task-new', status: 'queued', session_id: 'prime-task-new' } }
      if (operation === 'tasks.get') return { task: { id: 'task-new', status: 'completed', session_id: 'prime-task-new', result: { text: 'Hello!' } } }
      if (operation === 'tasks.events') return { events: [] }
      return defaults(operation)
    })
    const server = serverFor(bridge)
    render(<LiveChatView server={server} sessionId={null} preferredProjectId="project-1" pollDelayMs={5}
      onOpenSession={onOpenSession} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)

    const runtime = await screen.findByLabelText('Runtime')
    await waitFor(() => expect(within(runtime).getAllByRole('option').map((option) => option.textContent)).toEqual(['Prime · version unverified']))
    expect(screen.getByLabelText('Project')).toHaveValue('project-1')
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'Say hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))

    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('prime-task-new'))
    expect(callsTo(invoke, 'tasks.submit')).toEqual([
      ['tasks.submit', { projectId: 'project-1', prompt: 'Say hello', runtime: 'prime' }],
    ])
    expect(server.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('live tasks and projects', () => {
  it('lists server tasks with truthful queue labels and opens their conversation', async () => {
    const onOpenSession = vi.fn()
    const { bridge, invoke } = makeBridge((operation) => operation === 'tasks.list'
      ? { tasks: [
        { id: 'task-running', status: 'running', runtime_id: 'prime', session_id: SESSION_ID, prompt: 'Split the loop' },
        { id: 'task-queued', status: 'queued', runtime_id: 'pi', prompt: 'Queued work' },
        { id: 'task-review', status: 'interrupted', runtime_id: 'prime', prompt: 'Interrupted work', result: { recovery: { review_required: true } } },
        { id: 'task-strange', status: 'teleported', prompt: 'Unknown state' },
      ] }
      : defaults(operation))
    render(<LiveTasksView server={serverFor(bridge)} onOpenSession={onOpenSession} onOpenConnection={vi.fn()} />)

    const table = await screen.findByRole('table', { name: 'Server tasks' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell').slice(1).map((cell) => cell.textContent))).toEqual([
      ['Server · Prime', 'Running', '—'],
      ['Server · Pi', 'Queued', '—'],
      ['Server · Prime', 'Interrupted', 'Review required'],
      ['Server · Runtime unverified', 'Unknown status', '—'],
    ])
    expect(screen.getByText(/1 running · 1 queued/)).toBeInTheDocument()
    expect(screen.getByText(/not described as running, complete, or safe to retry/)).toBeInTheDocument()
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Open conversation' }))
    expect(onOpenSession).toHaveBeenCalledWith(SESSION_ID)
    expect(invoke).toHaveBeenCalledWith('tasks.list', { limit: 100 })
  })

  it('filters sessions by the selected server project', async () => {
    const onOpenSession = vi.fn()
    const onSelectProject = vi.fn()
    const { bridge, invoke } = makeBridge((operation, payload) => operation === 'sessions.list' && payload.projectId === 'project-1'
      ? { sessions: [verifiedSession, { ...verifiedSession, id: 'other-project-session', title: 'Belongs elsewhere', project_id: 'project-2' }] }
      : defaults(operation))
    const server = serverFor(bridge)
    const { rerender } = render(<LiveProjectsView server={server} selectedProjectId={null} selectedSessionId={null} onSelectProject={onSelectProject}
      onOpenSession={onOpenSession} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show sessions' }))
    expect(onSelectProject).toHaveBeenCalledWith('project-1')

    rerender(<LiveProjectsView server={server} selectedProjectId="project-1" selectedSessionId={null} onSelectProject={onSelectProject}
      onOpenSession={onOpenSession} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} />)
    const projectSessions = await screen.findByRole('region', { name: 'Sessions in Archon backend' })
    fireEvent.click(await within(projectSessions).findByRole('button', { name: /Refactor the queue/ }))
    expect(onOpenSession).toHaveBeenCalledWith(SESSION_ID)
    expect(within(projectSessions).queryByText('Belongs elsewhere')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('sessions.list', { projectId: 'project-1', limit: 200 })
  })
})

describe('connection changes without a route change', () => {
  it('notices a connection saved while the chat view stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let current: ConnectionDescription = DISCONNECTED
      const { bridge } = makeBridge(defaults, async () => current)
      installBridge(bridge)
      render(<App />)
      expect(await screen.findByText(/No server connection is configured/)).toBeInTheDocument()
      current = CONNECTED
      await act(async () => { vi.advanceTimersByTime(3_100) })
      // The sidebar lists the server's conversations without leaving the view.
      expect((await screen.findAllByText('Refactor the queue')).length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
