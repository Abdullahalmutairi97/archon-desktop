import type { FixtureProject, FixtureSession } from './fixtures'
import { runtimeLabel } from './fixtures'
import { Icon, type IconName } from './Icon'

export type WorkspaceView = 'chat' | 'sessions' | 'tasks' | 'projects'

const primaryItems: { id: WorkspaceView; label: string; icon: IconName; shortcut?: string }[] = [
  { id: 'chat', label: 'New chat', icon: 'plus', shortcut: '⌘ N' },
  { id: 'sessions', label: 'Sessions', icon: 'history' },
  { id: 'tasks', label: 'Tasks', icon: 'activity' },
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
  return <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`} aria-label="Workspace navigation">
    <div className="sidebar-top">
      <div className="sidebar-section-label">WORKSPACE</div>
      <nav className="primary-navigation" aria-label="Main">
        {primaryItems.map((item) => <button
          key={item.id}
          className={`nav-item ${view === item.id ? 'active' : ''}`}
          title={collapsed ? item.label : undefined}
          aria-current={view === item.id ? 'page' : undefined}
          onClick={() => item.id === 'chat' ? onNewSession() : onView(item.id)}
        ><Icon name={item.icon} /><span className="nav-label">{item.label}</span>{item.shortcut && !collapsed && <kbd>{item.shortcut}</kbd>}</button>)}
      </nav>

      <div className="sidebar-section-head">
        <span className="sidebar-section-label">PROJECTS</span>
        <button className="quiet-icon-button" aria-label="Show all projects" title="Show all projects" onClick={() => onView('projects')}><Icon name="plus" /></button>
      </div>
      <button className={`project-overview ${view === 'projects' ? 'active' : ''}`} onClick={() => onView('projects')}>
        <span className="overview-glyph"><Icon name="folder" /></span><span className="nav-label">All projects</span><span className="project-count">{projects.length}</span>
      </button>
      <div className="project-list">
        {projects.map((project) => <button className="project-item" key={project.id} onClick={() => onProject(project.id)} title={collapsed ? project.name : undefined}>
          <span className={`project-dot runtime-${project.runtime}`} />
          <span className="project-copy"><span className="project-name">{project.name}</span><span className="project-location">{project.location} · {project.runtime === 'codex' ? 'Codex' : project.runtime === 'pi' ? 'Pi' : 'Prime'}</span></span>
          {!collapsed && <Icon className="project-chevron" name="chevron" />}
        </button>)}
      </div>

      <div className="sidebar-section-head recent-heading"><span className="sidebar-section-label">RECENT SESSIONS</span><span className="section-count">{sessions.length}</span></div>
      <div className="recent-list">
        {sessions.map((session) => <button key={session.scope.sessionId} className={`recent-session ${selectedSessionId === session.scope.sessionId && view === 'chat' ? 'selected' : ''}`} onClick={() => { onSession(session.scope.sessionId); onView('chat') }} title={collapsed ? session.title : undefined}>
          <span className={`session-runtime-icon runtime-${session.scope.runtime}`}><Icon name={session.scope.runtime === 'codex' ? 'code' : 'chat'} /></span>
          <span className="recent-copy"><span className="recent-title">{session.title}</span><span className="recent-runtime">{runtimeLabel(session.scope.runtime)}</span></span>
        </button>)}
      </div>
    </div>

    <div className="sidebar-footer">
      <div className="profile-card">
        <span className="profile-avatar">A</span>
        <span className="profile-copy"><strong>Local preview</strong><small>Fixture profile</small></span>
        <button className="quiet-icon-button" aria-label="Open appearance settings" onClick={onAppearance}><Icon name="settings" /></button>
      </div>
      {!collapsed && <div className="footer-state"><span className="state-light" />Synthetic mode <span className="footer-version">P2A</span></div>}
    </div>
  </aside>
}
