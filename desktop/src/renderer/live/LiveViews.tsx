import { useEffect, useMemo, useState } from 'react'
import { queueLabel } from '../../shared/domain/queue'
import { Icon } from '../shell/Icon'
import {
  formatEpochSeconds,
  liveSessions,
  liveTasks,
  runtimeLabel,
  type LiveProject,
  type LiveSession,
  type LiveTask,
} from './liveModels'
import { LIVE_SESSION_LIMIT, type LiveScope, type LiveServer, type LiveStatus } from './useLiveServer'
import './LiveViews.css'

/** Rows the Tasks route asks for; the server may cap it further. */
export const LIVE_TASK_LIMIT = 100

/** Explicit not-connected, rejected and failure states. Never mixes in fixture rows. */
export function LiveUnavailable({
  status,
  subject,
  onOpenConnection,
  onRetry,
}: {
  status: LiveStatus
  subject: string
  onOpenConnection(): void
  onRetry(): void
}) {
  const pending = status === 'checking' || status === 'loading'
  const title = pending ? 'Loading'
    : status === 'disconnected' ? 'Not connected'
      : status === 'rejected' ? 'Access rejected'
        : 'Server data unavailable'
  const message = status === 'checking' ? 'Checking the desktop connection…'
    : status === 'loading' ? `Loading ${subject} from the server…`
      : status === 'disconnected' ? `No server connection is configured. Connect in the Connection view to see live ${subject}.`
        : status === 'rejected' ? 'The server did not accept the saved connection. Re-enter the server token in the Connection view.'
          : status === 'unavailable' ? 'The desktop connection state could not be read. Check it in the Connection view.'
            : `Server ${subject} could not be loaded. Check the connection and token, then retry. No ${subject} are shown.`
  return <div className="live-empty" role={pending ? 'status' : 'alert'}>
    <strong>{title}</strong>
    <p>{message}</p>
    {!pending && <div className="live-empty-actions">
      <button type="button" onClick={onOpenConnection}>Open Connection</button>
      {status === 'error' && <button type="button" onClick={onRetry}>Retry</button>}
    </div>}
  </div>
}

function SessionBadges({ session }: { session: LiveSession }) {
  return <span className="live-badges">
    {session.active && <b className="live-badge live-badge-running">Task running</b>}
    {session.readOnly && <b className="live-badge">Read only</b>}
    {session.ownership !== 'verified' && <b className="live-badge live-badge-review">{session.ownership === 'review_required' ? 'Review required' : 'Ownership unverified'}</b>}
  </span>
}

function SessionCard({ session, selected, onOpen }: { session: LiveSession; selected: boolean; onOpen(sessionId: string): void }) {
  return <button type="button" className={`session-card ${selected ? 'selected' : ''}`} onClick={() => onOpen(session.id)} aria-current={selected ? 'true' : undefined}>
    <span className={`card-runtime-icon runtime-${session.runtime ?? 'unverified'}`}><Icon name="chat" /></span>
    <span className="session-card-copy">
      <strong dir="auto">{session.title}</strong>
      {session.preview && <span dir="auto">{session.preview}</span>}
      <small>Server · {runtimeLabel(session.runtime)} · {formatEpochSeconds(session.lastActive)}{session.messageCount === null ? '' : ` · ${session.messageCount} messages`}</small>
      <SessionBadges session={session} />
    </span>
    <Icon className="card-chevron live-flip" name="chevron" />
  </button>
}

function SessionList({ sessions, selectedSessionId, onOpenSession }: {
  sessions: readonly LiveSession[]
  selectedSessionId: string | null
  onOpenSession(sessionId: string): void
}) {
  return <div className="session-card-list">
    {sessions.map((session) => <SessionCard key={session.id} session={session} selected={session.id === selectedSessionId} onOpen={onOpenSession} />)}
  </div>
}

export function LiveSessionsView({
  server,
  selectedSessionId,
  onOpenSession,
  onNewConversation,
  onOpenConnection,
}: {
  server: LiveServer
  selectedSessionId: string | null
  onOpenSession(sessionId: string): void
  onNewConversation(projectId: string | null): void
  onOpenConnection(): void
}) {
  return <section className="collection-view" aria-label="Server sessions">
    {server.status !== 'ready'
      ? <LiveUnavailable status={server.status} subject="sessions" onOpenConnection={onOpenConnection} onRetry={server.refresh} />
      : <>
        <div className="collection-intro live-intro">
          <div>
            <span className="eyebrow">SERVER CONVERSATIONS</span>
            <p>{server.sessions.length} returned by the server{server.sessions.length >= LIVE_SESSION_LIMIT ? '; the list may be capped' : ''}. Open one to read and continue it.</p>
          </div>
          <div className="live-intro-actions">
            <button type="button" className="text-button" onClick={server.refresh} disabled={server.refreshing}>{server.refreshing ? 'Refreshing…' : 'Refresh'}</button>
            <button type="button" className="text-button" onClick={() => onNewConversation(null)}>New conversation</button>
          </div>
        </div>
        {server.sessions.length === 0
          ? <p className="live-empty-line">The server returned no sessions.</p>
          : <SessionList sessions={server.sessions} selectedSessionId={selectedSessionId} onOpenSession={onOpenSession} />}
      </>}
  </section>
}

type ProjectSessionsState =
  | { state: 'loading' }
  | { state: 'ready'; sessions: LiveSession[] }
  | { state: 'error' }

function ProjectSessions({ scope, project, selectedSessionId, onOpenSession }: {
  scope: LiveScope
  project: LiveProject
  selectedSessionId: string | null
  onOpenSession(sessionId: string): void
}) {
  const [state, setState] = useState<ProjectSessionsState>({ state: 'loading' })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let current = true
    setState({ state: 'loading' })
    void Promise.resolve().then(() => scope.bridge.api.invoke('sessions.list', { projectId: project.id, limit: LIVE_SESSION_LIMIT })).then((result) => {
      // The server filters by project; rows bound to another project id are still dropped here.
      if (current) setState({ state: 'ready', sessions: liveSessions(result.sessions).filter((session) => session.projectId === project.id) })
    }).catch(() => {
      if (current) setState({ state: 'error' })
    })
    return () => { current = false }
  }, [scope.bridge, project.id, reload])

  return <section className="live-project-sessions" aria-label={`Sessions in ${project.name}`}>
    <div className="live-intro">
      <h3 dir="auto">Sessions in {project.name}</h3>
      <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)} disabled={state.state === 'loading'}>Refresh</button>
    </div>
    {state.state === 'loading' && <p className="live-empty-line" role="status">Loading this project’s sessions…</p>}
    {state.state === 'error' && <p className="live-empty-line" role="alert">This project’s sessions could not be loaded.</p>}
    {state.state === 'ready' && (state.sessions.length === 0
      ? <p className="live-empty-line">The server returned no sessions for this project.</p>
      : <SessionList sessions={state.sessions} selectedSessionId={selectedSessionId} onOpenSession={onOpenSession} />)}
  </section>
}

export function LiveProjectsView({
  server,
  selectedProjectId,
  selectedSessionId,
  onSelectProject,
  onOpenSession,
  onNewConversation,
  onOpenConnection,
}: {
  server: LiveServer
  selectedProjectId: string | null
  selectedSessionId: string | null
  onSelectProject(projectId: string): void
  onOpenSession(sessionId: string): void
  onNewConversation(projectId: string | null): void
  onOpenConnection(): void
}) {
  const selectedProject = server.projects.find((project) => project.id === selectedProjectId) ?? null
  return <section className="collection-view projects-view" aria-label="Server projects">
    {server.status !== 'ready' || !server.scope
      ? <LiveUnavailable status={server.status} subject="projects" onOpenConnection={onOpenConnection} onRetry={server.refresh} />
      : <>
        <div className="collection-intro live-intro">
          <div>
            <span className="eyebrow">SERVER PROJECTS</span>
            <p>Registered projects on the connected server. Local Codex projects stay in the Local Codex view.</p>
          </div>
          <div className="live-intro-actions">
            <button type="button" className="text-button" onClick={server.refresh} disabled={server.refreshing}>{server.refreshing ? 'Refreshing…' : 'Refresh'}</button>
          </div>
        </div>
        {server.projects.length === 0
          ? <p className="live-empty-line">The server returned no registered projects. Register one in Server work.</p>
          : <div className="project-card-grid">{server.projects.map((project) => <article className={`project-card ${project.id === selectedProjectId ? 'selected' : ''}`} key={project.id}>
            <div className="project-card-heading"><span className="project-card-icon"><Icon name="folder" /></span><span className="project-card-runtime">Server · registered project</span></div>
            <h2 dir="auto">{project.name}</h2>
            <p className="project-root live-path" dir="ltr">{project.primaryPath ?? 'No primary path reported'}</p>
            <div className="project-card-footer">
              <button type="button" className="text-button" aria-pressed={project.id === selectedProjectId} onClick={() => onSelectProject(project.id)}>Show sessions <Icon className="live-flip" name="chevron" /></button>
              <button type="button" className="text-button" onClick={() => onNewConversation(project.id)}>New conversation</button>
            </div>
          </article>)}</div>}
        {selectedProject && <ProjectSessions
          key={`${server.scope.generation}:${selectedProject.id}`}
          scope={server.scope}
          project={selectedProject}
          selectedSessionId={selectedSessionId}
          onOpenSession={onOpenSession}
        />}
      </>}
  </section>
}

type TaskListState =
  | { state: 'loading' }
  | { state: 'ready'; tasks: LiveTask[] }
  | { state: 'error' }

function LiveTaskTable({ scope, onOpenSession }: { scope: LiveScope; onOpenSession(sessionId: string): void }) {
  const [state, setState] = useState<TaskListState>({ state: 'loading' })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let current = true
    setState({ state: 'loading' })
    void Promise.resolve().then(() => scope.bridge.api.invoke('tasks.list', { limit: LIVE_TASK_LIMIT })).then((result) => {
      if (current) setState({ state: 'ready', tasks: liveTasks(result.tasks) })
    }).catch(() => {
      if (current) setState({ state: 'error' })
    })
    return () => { current = false }
  }, [scope.bridge, reload])

  const tasks = state.state === 'ready' ? state.tasks : null
  const summary = useMemo(() => tasks ? queueLabel(tasks.map((task) => task.view)) : null, [tasks])
  const reviewCount = tasks?.filter((task) => task.view.recoveryState === 'review_required' || task.view.recoveryState === 'unknown').length ?? 0

  return <>
    <div className="collection-intro live-intro">
      <div>
        <span className="eyebrow">SERVER TASK QUEUE</span>
        <p>{tasks ? `${tasks.length} recent tasks returned${tasks.length >= LIVE_TASK_LIMIT ? '; older tasks are not shown' : ''} · ${summary}` : 'Recent tasks from the connected server.'}</p>
      </div>
      <div className="live-intro-actions">
        <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)} disabled={state.state === 'loading'}>Refresh</button>
      </div>
    </div>
    {state.state === 'loading' && <p className="live-empty-line" role="status">Loading tasks from the server…</p>}
    {state.state === 'error' && <div className="live-empty" role="alert"><strong>Server data unavailable</strong><p>Server tasks could not be loaded. Check the connection and token, then retry. No tasks are shown.</p></div>}
    {tasks && tasks.length === 0 && <p className="live-empty-line">The server returned no tasks.</p>}
    {tasks && tasks.length > 0 && <div className="task-table" role="table" aria-label="Server tasks">
      <div className="task-row task-header" role="row"><span role="columnheader">Task</span><span role="columnheader">Runtime</span><span role="columnheader">Status</span><span role="columnheader">Recovery</span></div>
      {tasks.map((task) => <div className="task-row" role="row" key={task.id}>
        <span className="live-task-cell" role="cell">
          <span className="task-name"><i className={`queue-status status-${task.view.status}`} /><span dir="auto">{task.prompt ?? task.id}</span></span>
          <small className="live-task-meta"><code>{task.id}</code>{task.error ? ` · ${task.error}` : ''}</small>
          {task.sessionId && <button type="button" className="text-button" onClick={() => onOpenSession(task.sessionId as string)}>Open conversation</button>}
        </span>
        <span role="cell">Server · {runtimeLabel(task.runtime)}</span>
        <span role="cell" className={`task-status status-text-${task.view.status}`}>{task.statusLabel}</span>
        <span role="cell" className={task.recoveryLabel ? 'recovery-review' : 'recovery-none'}>{task.recoveryLabel ?? '—'}</span>
      </div>)}
    </div>}
    {reviewCount > 0 && <div className="review-callout"><span className="review-icon">!</span><div><strong>Interrupted outcomes stay visible</strong><p>{reviewCount} task{reviewCount === 1 ? '' : 's'} need review. Review-required work is not described as running, complete, or safe to retry.</p></div></div>}
  </>
}

export function LiveTasksView({ server, onOpenSession, onOpenConnection }: {
  server: LiveServer
  onOpenSession(sessionId: string): void
  onOpenConnection(): void
}) {
  const usable = server.scope && server.status !== 'rejected' && server.status !== 'checking'
  return <section className="collection-view" aria-label="Server tasks">
    {usable && server.scope
      ? <LiveTaskTable key={server.scope.generation} scope={server.scope} onOpenSession={onOpenSession} />
      : <LiveUnavailable status={server.status} subject="tasks" onOpenConnection={onOpenConnection} onRetry={server.refresh} />}
  </section>
}
