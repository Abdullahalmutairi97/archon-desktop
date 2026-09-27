import type { FixtureProject, FixtureSession } from './fixtures'
import { runtimeLabel } from './fixtures'
import { Icon, type IconName } from './Icon'

export type WorkspaceView = 'chat' | 'sessions' | 'tasks' | 'projects' | 'connection' | 'server' | 'codex'

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
}) {
  const preview = isPreviewView(view)
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
        ><Icon name={item.icon} /><span className="nav-label">{item.label}</span>{item.shortcut && !collapsed && <kbd>{item.shortcut}</kbd>}</button>)}
      </nav>

      <nav className="preview-navigation" aria-label="Preview/demo">
        <button className={`nav-item ${preview ? 'active' : ''}`} aria-label="Preview/demo" title="Preview/demo · sample data only" aria-current={preview ? 'page' : undefined} onClick={() => onView('chat')}>
          <Icon name="browser" /><span className="nav-label">Preview/demo</span>
        </button>
      </nav>

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
