import type { FixtureProject, FixtureSession } from './fixtures'
import { runtimeLabel } from './fixtures'
import { Icon, type IconName } from './Icon'
import { runtimeLabel as liveRuntimeLabel, type LiveProject, type LiveSession } from '../live/liveModels'
import type { LiveStatus } from '../live/useLiveServer'
import { OPERATIONS_ITEMS, type OperationsView } from '../operations/OperationsView'

export type WorkspaceView = 'chat' | 'sessions' | 'tasks' | 'projects' | 'connection' | 'server' | 'codex'
  | OperationsView

export function isPreviewView(view: WorkspaceView) {
  return view === 'chat' || view === 'sessions' || view === 'tasks' || view === 'projects'
}

const primaryItems: { id: WorkspaceView; label: string; icon: IconName; shortcut?: string }[] = [
  { id: 'codex', label: 'Local Codex', icon: 'code', shortcut: 'Ctrl N' },
  { id: 'server', label: 'Server work', icon: 'folder' },
  { id: 'connection', label: 'Connection', icon: 'settings' },
]

const demoItems: { id: WorkspaceView; label: string; icon: IconName }[] = [
  { id: 'chat', label: 'Demo chat', icon: 'chat' },
  { id: 'sessions', label: 'Demo sessions', icon: 'history' },
  { id: 'tasks', label: 'Demo tasks', icon: 'activity' },
  { id: 'projects', label: 'Demo projects', icon: 'folder' },
]

const liveItems: { id: WorkspaceView; label: string; icon: IconName }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'sessions', label: 'Sessions', icon: 'history' },
  { id: 'tasks', label: 'Tasks', icon: 'activity' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
]

/** Sidebar rows shown for the connected server; ids are server ids only. */
export type LiveSidebarData = {
  status: LiveStatus
  projects: readonly LiveProject[]
  sessions: readonly LiveSession[]
  selectedSessionId: string | null
  selectedProjectId: string | null
  onSession(sessionId: string): void
  onProject(projectId: string): void
}

const MAX_SIDEBAR_PROJECTS = 20
const MAX_SIDEBAR_SESSIONS = 12

function liveSidebarNote(status: LiveStatus): string | null {
  switch (status) {
    case 'ready': return null
    case 'checking':
    case 'loading': return 'Loading server data…'
    case 'disconnected': return 'Not connected. Open Connection to list server work.'
    case 'rejected': return 'Server access rejected. Check Connection.'
    default: return 'Server data unavailable.'
  }
}

function LiveSidebarContent({ view, collapsed, live, onView }: {
  view: WorkspaceView
  collapsed: boolean
  live: LiveSidebarData
  onView(view: WorkspaceView): void
}) {
  const note = liveSidebarNote(live.status)
  return <div className="live-sidebar-content">
    <div className="sidebar-section-head"><span className="sidebar-section-label">SERVER CONVERSATIONS</span></div>
    <nav className="primary-navigation" aria-label="Server conversations">
      {liveItems.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-label={item.label} title={item.label} aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}>
        <Icon name={item.icon} /><span className="nav-label">{item.label}</span>{item.id === 'chat' && !collapsed && <kbd title="New conversation">Ctrl N</kbd>}
      </button>)}
    </nav>
    {note && <p className="live-sidebar-note">{note}</p>}
    {live.status === 'ready' && <>
      <div className="sidebar-section-head">
        <span className="sidebar-section-label">SERVER PROJECTS</span>
        <span className="section-count">{live.projects.length}</span>
      </div>
      <div className="project-list">
        {live.projects.slice(0, MAX_SIDEBAR_PROJECTS).map((project) => <button className="project-item" key={project.id} onClick={() => live.onProject(project.id)} aria-label={`Server project: ${project.name}`} title={`Server project: ${project.name}`} aria-current={view === 'projects' && live.selectedProjectId === project.id ? 'true' : undefined}>
          <span className="project-dot" />
          <span className="project-copy"><span className="project-name" dir="auto">{project.name}</span><span className="project-location">Server · registered</span></span>
          {!collapsed && <Icon className="project-chevron live-flip" name="chevron" />}
        </button>)}
      </div>

      <div className="sidebar-section-head recent-heading"><span className="sidebar-section-label">RECENT SESSIONS</span><span className="section-count">{live.sessions.length}</span></div>
      <div className="recent-list">
        {live.sessions.slice(0, MAX_SIDEBAR_SESSIONS).map((session) => <button key={session.id} className={`recent-session ${live.selectedSessionId === session.id && view === 'chat' ? 'selected' : ''}`} onClick={() => live.onSession(session.id)} aria-label={`Server session: ${session.title}`} title={`Server session: ${session.title}`}>
          <span className={`session-runtime-icon runtime-${session.runtime ?? 'unverified'}`}><Icon name="chat" /></span>
          <span className="recent-copy"><span className="recent-title" dir="auto">{session.title}</span><span className="recent-runtime">{liveRuntimeLabel(session.runtime)}{session.active ? ' · task running' : session.readOnly ? ' · read only' : ''}</span></span>
        </button>)}
      </div>
    </>}
  </div>
}

export function Sidebar({
  view,
  collapsed,
  sessions,
  projects,
  selectedSessionId,
  onView,
  onSession,
  onNewSession,
  onProject,
  onAppearance,
  live,
}: {
  view: WorkspaceView
  collapsed: boolean
  sessions: readonly FixtureSession[]
  projects: readonly FixtureProject[]
  selectedSessionId: string
  onView(view: WorkspaceView): void
  onSession(sessionId: string): void
  onNewSession(): void
  onProject(projectId: string): void
  onAppearance(): void
  /** Present only with the desktop bridge; replaces the fixture demo area. */
  live?: LiveSidebarData
}) {
  const preview = isPreviewView(view) && !live
  return <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`} aria-label="Workspace navigation">
    <div className="sidebar-top">
      <div className="sidebar-section-label">WORK</div>
      <nav className="primary-navigation" aria-label="Main">
        {primaryItems.map((item) => <button
          key={item.id}
          className={`nav-item ${view === item.id ? 'active' : ''}`}
          title={item.label}
          aria-label={item.label}
          aria-current={view === item.id ? 'page' : undefined}
          onClick={() => item.id === 'codex' ? onNewSession() : onView(item.id)}
        ><Icon name={item.icon} /><span className="nav-label">{item.label}</span>{item.shortcut && !collapsed && !live && <kbd>{item.shortcut}</kbd>}</button>)}
      </nav>

      {live && <LiveSidebarContent view={view} collapsed={collapsed} live={live} onView={onView} />}

      {live && <>
        <div className="sidebar-section-head"><span className="sidebar-section-label">OPERATIONS</span></div>
        <nav className="primary-navigation" aria-label="Operations">
          {OPERATIONS_ITEMS.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-label={item.label} title={item.label} aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}>
            <Icon name={item.icon} /><span className="nav-label">{item.label}</span>
          </button>)}
        </nav>
      </>}

      {!live && <nav className="preview-navigation" aria-label="Preview/demo">
        <button className={`nav-item ${preview ? 'active' : ''}`} aria-label="Preview/demo" title="Preview/demo · sample data only" aria-current={preview ? 'page' : undefined} onClick={() => onView('chat')}>
          <Icon name="browser" /><span className="nav-label">Preview/demo</span>
        </button>
      </nav>}

      {preview && <div className="demo-sidebar-content">
      <p className="demo-sidebar-note">Sample data only</p>
      <nav className="primary-navigation demo-navigation" aria-label="Demo views">
        {demoItems.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-label={item.label} title={item.label} aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}>
          <Icon name={item.icon} /><span className="nav-label">{item.label}</span>
        </button>)}
      </nav>

      <div className="sidebar-section-head">
        <span className="sidebar-section-label">DEMO PROJECTS</span>
        <span className="section-count">{projects.length}</span>
      </div>
      <div className="project-list">
        {projects.map((project) => <button className="project-item" key={project.id} onClick={() => onProject(project.id)} aria-label={`Demo project: ${project.name}`} title={`Demo project: ${project.name}`}>
          <span className={`project-dot runtime-${project.runtime}`} />
          <span className="project-copy"><span className="project-name">{project.name}</span><span className="project-location">{project.location} · {project.runtime === 'codex' ? 'Codex' : project.runtime === 'pi' ? 'Pi' : 'Prime'}</span></span>
          {!collapsed && <Icon className="project-chevron" name="chevron" />}
        </button>)}
      </div>

      <div className="sidebar-section-head recent-heading"><span className="sidebar-section-label">DEMO SESSIONS</span><span className="section-count">{sessions.length}</span></div>
      <div className="recent-list">
        {sessions.map((session) => <button key={session.scope.sessionId} className={`recent-session ${selectedSessionId === session.scope.sessionId && view === 'chat' ? 'selected' : ''}`} onClick={() => { onSession(session.scope.sessionId); onView('chat') }} aria-label={`Demo session: ${session.title}`} title={`Demo session: ${session.title}`}>
          <span className={`session-runtime-icon runtime-${session.scope.runtime}`}><Icon name={session.scope.runtime === 'codex' ? 'code' : 'chat'} /></span>
          <span className="recent-copy"><span className="recent-title">{session.title}</span><span className="recent-runtime">{runtimeLabel(session.scope.runtime)}</span></span>
        </button>)}
      </div>
      </div>}
    </div>

    <div className="sidebar-footer">
      <div className="profile-card">
        <span className="profile-avatar">A</span>
        <span className="profile-copy"><strong>Archon Desktop</strong><small>Local and server work</small></span>
        <button className="quiet-icon-button" aria-label="Open appearance settings" onClick={onAppearance}><Icon name="settings" /></button>
      </div>
      {!collapsed && <div className="footer-state"><span className="state-light" />Reconstruction</div>}
    </div>
  </aside>
}
