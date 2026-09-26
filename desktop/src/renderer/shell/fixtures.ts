/** Synthetic view data for P2A. Nothing in this file is fetched or dispatched. */
import type { ExecutionScope, RuntimeId } from '../../shared/domain/identity'
import type { TaskView } from '../../shared/domain/queue'

export type FixtureMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export type FixtureProject = {
  id: string
  name: string
  root: string
  location: 'Server fixture' | 'THIS PC'
  runtime: RuntimeId
}

export type FixtureSession = {
  scope: ExecutionScope
  title: string
  preview: string
  projectId?: string
  updatedAt: string
  messages: FixtureMessage[]
}

export const FIXTURE_CONNECTION_IDS = {
  server: 'fixture-remote-server',
  localCodex: 'fixture-this-pc',
} as const

export const FIXTURE_PROJECTS: readonly FixtureProject[] = [
  {
    id: 'server-project:desktop-shell',
    name: 'Desktop shell',
    root: '/fixture/server/desktop-shell',
    location: 'Server fixture',
    runtime: 'prime',
  },
  {
    id: 'server-project:research-notes',
    name: 'Research notes',
    root: '/fixture/server/research-notes',
    location: 'Server fixture',
    runtime: 'pi',
  },
  {
    id: 'codex-project:local-workbench',
    name: 'Local workbench',
    root: '/fixture/this-pc/local-workbench',
    location: 'THIS PC',
    runtime: 'codex',
  },
]

const primeScope: ExecutionScope = {
  connectionId: FIXTURE_CONNECTION_IDS.server,
  runtime: 'prime',
  sessionId: 'server:session:prime-01',
  root: '/fixture/server/desktop-shell',
}
const piScope: ExecutionScope = {
  connectionId: FIXTURE_CONNECTION_IDS.server,
  runtime: 'pi',
  sessionId: 'server:session:pi-02',
  root: '/fixture/server/research-notes',
}
const codexScope: ExecutionScope = {
  connectionId: FIXTURE_CONNECTION_IDS.localCodex,
  runtime: 'codex',
  sessionId: 'codex:task:fixture-local-03',
  root: '/fixture/this-pc/local-workbench',
}

export const FIXTURE_SESSIONS: readonly FixtureSession[] = [
  {
    scope: primeScope,
    title: 'Reconstruction shell review',
    preview: 'Keep the sidebar, keyboard shortcuts, and workbench placement familiar.',
    projectId: 'server-project:desktop-shell',
    updatedAt: 'Today · fixture',
    messages: [
      { id: 'prime-message-1', role: 'user', text: 'What does this preview connect to?' },
      { id: 'prime-message-2', role: 'assistant', text: 'This is synthetic data only. No remote server, agent, or native capability is connected.' },
    ],
  },
  {
    scope: piScope,
    title: 'Study notes',
    preview: 'A separate Pi session on the remote server fixture.',
    projectId: 'server-project:research-notes',
    updatedAt: 'Yesterday · fixture',
    messages: [
      { id: 'pi-message-1', role: 'user', text: 'Show a second remote runtime identity.' },
      { id: 'pi-message-2', role: 'assistant', text: 'Pi remains labeled as Server · Pi in this preview; it does not share a session ID with Prime or Codex.' },
    ],
  },
  {
    scope: codexScope,
    title: 'Local planning draft',
    preview: 'A THIS PC thread with a local Codex namespace.',
    projectId: 'codex-project:local-workbench',
    updatedAt: 'Monday · fixture',
    messages: [
      { id: 'codex-message-1', role: 'user', text: 'Can the local and server identities be separated?' },
      { id: 'codex-message-2', role: 'assistant', text: 'Yes. This fixture uses a codex:task: ID and a THIS PC label. The preview does not launch Codex.' },
    ],
  },
]

export const FIXTURE_TASKS: readonly TaskView[] = [
  {
    id: 'server-task:prime-running-01',
    sessionId: primeScope.sessionId,
    projectId: 'server-project:desktop-shell',
    runtimeId: 'prime',
    status: 'running',
    currentAttemptId: 'server-attempt:prime-01',
    recoveryState: 'none',
  },
  {
    id: 'server-task:pi-queued-02',
    sessionId: piScope.sessionId,
    projectId: 'server-project:research-notes',
    runtimeId: 'pi',
    status: 'queued',
    recoveryState: 'none',
  },
  {
    id: 'server-task:review-needed-03',
    sessionId: 'server:session:archived-review',
    runtimeId: 'prime',
    status: 'interrupted',
    recoveryState: 'review_required',
  },
  {
    id: 'codex-task:fixture-local-03',
    sessionId: codexScope.sessionId,
    projectId: 'codex-project:local-workbench',
    runtimeId: 'codex',
    status: 'completed',
    recoveryState: 'none',
  },
]

export const FIXTURE_ACTIVITY = [
  { id: 'activity-1', label: 'task.running', detail: 'Server · Prime · attempt 1', time: '09:42' },
  { id: 'activity-2', label: 'task.queued', detail: 'Server · Pi · waiting in queue', time: '09:39' },
  { id: 'activity-3', label: 'task.interrupted', detail: 'Review required · outcome unknown', time: 'Yesterday' },
] as const

export function runtimeLabel(runtime: RuntimeId): string {
  if (runtime === 'codex') return 'THIS PC · Local Codex'
  if (runtime === 'pi') return 'Server fixture · Pi'
  return 'Server fixture · Prime'
}

export function sessionForId(sessionId: string | undefined): FixtureSession | undefined {
  return FIXTURE_SESSIONS.find((session) => session.scope.sessionId === sessionId)
}
