import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { buildMetadata } from '../../shared/buildMetadata'
import { AppearanceStudio } from '../appearance/AppearanceStudio'
import { ConnectionPanel } from '../connection/ConnectionPanel'
import { LocalCodexPanel } from '../local/LocalCodexPanel'
import { ServerCollectionsView } from '../server/ServerCollectionsView'
import type { LocalCodexProjectDto } from '../../shared/bridge/types'
import { readShellPreferences, saveShellPreferences, type ShellPreferences } from '../appearance/themes'
import { FIXTURE_PROJECTS, FIXTURE_SESSIONS, FIXTURE_TASKS, runtimeLabel, sessionForId } from './fixtures'
import { Icon } from './Icon'
import { isPreviewView, Sidebar, type WorkspaceView } from './Sidebar'
import { TitleBar } from './TitleBar'
import { resolveShellShortcut, type BenchId } from './shortcuts'
import { WorkspaceBench } from './WorkspaceBench'

const DEFAULT_SESSION_ID = FIXTURE_SESSIONS[0].scope.sessionId

export function App() {
  const [preferences, setPreferences] = useState<ShellPreferences>(() => readShellPreferences())
  const [view, setView] = useState<WorkspaceView>('codex')
  const [selectedSessionId, setSelectedSessionId] = useState(DEFAULT_SESSION_ID)
  const [selectedProjectId, setSelectedProjectId] = useState(FIXTURE_PROJECTS[0].id)
  const [localCodexSelectionRequest, setLocalCodexSelectionRequest] = useState<{ requestId: number; projectId: string } | undefined>()
  const localCodexSelectionSerial = useRef(0)
  const [activeBench, setActiveBench] = useState<BenchId>('activity')
  const [benchOpen, setBenchOpen] = useState(true)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const preview = isPreviewView(view)

  const currentSession = useMemo(() => sessionForId(selectedSessionId) ?? FIXTURE_SESSIONS[0], [selectedSessionId])
  const currentProject = FIXTURE_PROJECTS.find((project) => project.id === selectedProjectId) ?? FIXTURE_PROJECTS[0]

  useEffect(() => { saveShellPreferences(preferences) }, [preferences])

  const openLocalCodex = useCallback(() => setView('codex'), [])
  const openRegisteredLocalCodexProject = useCallback((project: LocalCodexProjectDto) => {
    setLocalCodexSelectionRequest({ requestId: ++localCodexSelectionSerial.current, projectId: project.id })
    setView('codex')
  }, [])
  const openDemoBench = useCallback((bench: BenchId) => {
    setView((current) => isPreviewView(current) ? current : 'chat')
    setActiveBench(bench)
    setBenchOpen(true)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveShellShortcut(event, { appearanceOpen, paletteOpen, benchOpen: preview && benchOpen })
      if (!action) return
      event.preventDefault()
      switch (action.type) {
        case 'toggle-sidebar':
          setPreferences((value) => ({ ...value, sidebarCollapsed: !value.sidebarCollapsed }))
          break
        case 'new-session':
          openLocalCodex()
          break
        case 'open-appearance':
          setPaletteOpen(false)
          setAppearanceOpen(true)
          break
        case 'open-palette':
          setAppearanceOpen(false)
          setPaletteOpen(true)
          break
        case 'open-bench':
          openDemoBench(action.bench)
          break
        case 'close-appearance':
          setAppearanceOpen(false)
          break
        case 'close-palette':
          setPaletteOpen(false)
          break
        case 'close-bench':
          setBenchOpen(false)
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [appearanceOpen, benchOpen, openDemoBench, openLocalCodex, paletteOpen, preview])

  const showProject = (projectId: string) => {
    setSelectedProjectId(projectId)
    setView('projects')
  }

  const selectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId)
    const matching = FIXTURE_SESSIONS.find((session) => session.scope.sessionId === sessionId)
    if (matching?.projectId) setSelectedProjectId(matching.projectId)
  }

  const themeStyle = { '--font-scale': preferences.fontScale, '--text-direction': preferences.direction } as CSSProperties

  return <div className={`shell-app ${preferences.navigationSide === 'right' ? 'navigation-right' : 'navigation-left'}`} data-theme={preferences.theme} data-direction={preferences.direction} style={themeStyle}>
    <TitleBar
      sidebarCollapsed={preferences.sidebarCollapsed}
      onToggleSidebar={() => setPreferences((value) => ({ ...value, sidebarCollapsed: !value.sidebarCollapsed }))}
      onSearch={() => { setAppearanceOpen(false); setPaletteOpen(true) }}
      onAppearance={() => { setPaletteOpen(false); setAppearanceOpen(true) }}
    />
    <div className={`workspace-frame ${preferences.sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      <Sidebar
        view={view}
        collapsed={preferences.sidebarCollapsed}
        sessions={FIXTURE_SESSIONS}
        projects={FIXTURE_PROJECTS}
        selectedSessionId={selectedSessionId}
        onView={setView}
        onSession={selectSession}
        onNewSession={openLocalCodex}
        onProject={showProject}
        onAppearance={() => { setPaletteOpen(false); setAppearanceOpen(true) }}
      />
      <main className={`workspace-main ${preview ? 'workspace-main-demo' : 'workspace-main-live'}`} dir={preferences.direction}>
        <div className="workspace-view-header">
          <div className="view-heading">
            <span className="eyebrow">{preview ? 'PREVIEW/DEMO · SYNTHETIC DATA' : view === 'connection' ? 'DESKTOP CONNECTION' : view === 'server' ? 'SERVER WORK' : 'THIS PC · CODEX'}</span>
            <h1>{viewTitle(view, currentSession.title)}</h1>
          </div>
          <div className="view-actions">
            {view === 'chat' && <span className="scope-pill"><i className={`runtime-dot runtime-${currentSession.scope.runtime}`} />{runtimeLabel(currentSession.scope.runtime)}</span>}
            {view === 'projects' && <span className="scope-pill"><i className={`runtime-dot runtime-${currentProject.runtime}`} />{currentProject.location} · {currentProject.runtime === 'codex' ? 'Local Codex' : currentProject.runtime === 'pi' ? 'Pi' : 'Prime'}</span>}
            {preview && <button className="icon-button view-action-button" aria-label="Open workbench activity" title="Open demo workbench" onClick={() => openDemoBench('activity')}><Icon name="activity" /></button>}
          </div>
        </div>

        {preview && <div className="demo-route-notice" role="note"><strong>Preview/demo</strong><span>Sample data only · These chats, sessions, tasks, projects and workbench panels are not connected to live work.</span></div>}
        {view === 'chat' && <ChatView session={currentSession} />}
        {view === 'sessions' && <SessionsView selectedSessionId={selectedSessionId} onSelect={(sessionId) => { selectSession(sessionId); setView('chat') }} />}
        {view === 'tasks' && <TasksView />}
        {view === 'projects' && <ProjectsView selectedProjectId={selectedProjectId} onSelectSession={selectSession} onViewChat={() => setView('chat')} />}
        {view === 'connection' && <ConnectionPanel bridge={window.archon} />}
        {view === 'server' && <ServerCollectionsView bridge={window.archon} onLocalCodexProjectRegistered={openRegisteredLocalCodexProject} />}
        <div className="local-codex-route" hidden={view !== 'codex'}><LocalCodexPanel bridge={window.archon} active={view === 'codex'} selectionRequest={localCodexSelectionRequest} /></div>
      </main>
      {preview && <WorkspaceBench active={activeBench} open={benchOpen} scope={currentSession.scope} onSelect={setActiveBench} onClose={() => setBenchOpen(false)} />}
    </div>

    <div className="reconstruction-ribbon" aria-label="Reconstruction and fixture status">
      <span><i />SOURCE RECONSTRUCTION</span><b>·</b><span>{view === 'connection' ? 'CONNECTION STATUS' : view === 'server' ? 'SERVER CHECKOUTS · LINE CONSOLE' : view === 'codex' ? 'LOCAL CODEX · ONE TURN' : 'SYNTHETIC FIXTURE DATA'}</span><b>·</b><span>BASELINE PARITY UNVERIFIED</span>
    </div>

    {appearanceOpen && <AppearanceStudio value={preferences} onChange={setPreferences} onClose={() => setAppearanceOpen(false)} />}
    {paletteOpen && <CommandPalette preview={preview} onClose={() => setPaletteOpen(false)} onNavigate={(next) => { setView(next); setPaletteOpen(false) }} onAppearance={() => { setPaletteOpen(false); setAppearanceOpen(true) }} onBench={(tab) => { openDemoBench(tab); setPaletteOpen(false) }} />}
    <div className="build-stamp" aria-hidden="true">v{buildMetadata.appVersion} · source {buildMetadata.sourceCommit.slice(0, 7)} · parity unverified</div>
  </div>
}

function viewTitle(view: WorkspaceView, sessionTitle: string) {
  if (view === 'chat') return sessionTitle
  if (view === 'sessions') return 'Demo sessions'
  if (view === 'tasks') return 'Demo task queue'
  if (view === 'connection') return 'Connection'
  if (view === 'server') return 'Server work'
  if (view === 'codex') return 'Local Codex'
  return 'Demo projects'
}

function ChatView({ session }: { session: (typeof FIXTURE_SESSIONS)[number] }) {
  return <section className="chat-view" aria-label="Synthetic chat transcript" dir="auto">
    <div className="chat-context-line"><span className="context-lock"><Icon name="settings" /></span><span>Fixture session</span><span className="context-dot">·</span><span>{session.updatedAt}</span><span className="context-spacer" /><span className="fixture-tag">READ ONLY</span></div>
    <div className="message-list">
      {session.messages.map((message) => <article key={message.id} className={`message-card message-${message.role}`}>
        <div className="message-avatar">{message.role === 'user' ? 'A' : session.scope.runtime === 'codex' ? 'C' : session.scope.runtime === 'pi' ? 'P' : 'P'}</div>
        <div className="message-body"><div className="message-byline"><strong>{message.role === 'user' ? 'You' : runtimeLabel(session.scope.runtime)}</strong><span>{message.role === 'user' ? 'Local preview' : 'Fixture response'}</span></div><p>{message.text}</p></div>
      </article>)}
    </div>
    <div className="chat-bottom">
      <div className="composer-frame" aria-label="Disabled preview composer">
        <div className="composer-placeholder">Chat is read-only in this reconstruction preview.</div>
        <div className="composer-toolbar"><span><Icon name="plus" /> Attachments disabled</span><span><Icon name="settings" /> No tools connected</span><button disabled aria-label="Send message"><Icon name="chevron" /></button></div>
      </div>
      <p className="composer-caption">Synthetic transcript · No messages are sent or saved.</p>
    </div>
  </section>
}

function SessionsView({ selectedSessionId, onSelect }: { selectedSessionId: string; onSelect(sessionId: string): void }) {
  return <section className="collection-view" aria-label="Synthetic sessions">
    <div className="collection-intro"><span className="eyebrow">RECENT THREADS</span><p>Each row is fixture data with an explicit execution identity.</p></div>
    <div className="session-card-list">{FIXTURE_SESSIONS.map((session) => <button className={`session-card ${selectedSessionId === session.scope.sessionId ? 'selected' : ''}`} key={session.scope.sessionId} onClick={() => onSelect(session.scope.sessionId)}>
      <span className={`card-runtime-icon runtime-${session.scope.runtime}`}><Icon name={session.scope.runtime === 'codex' ? 'code' : 'chat'} /></span><span className="session-card-copy"><strong>{session.title}</strong><span>{session.preview}</span><small>{runtimeLabel(session.scope.runtime)} · {session.updatedAt}</small></span><Icon className="card-chevron" name="chevron" />
    </button>)}</div>
  </section>
}

function TasksView() {
  return <section className="collection-view" aria-label="Synthetic task queue">
    <div className="collection-intro"><span className="eyebrow">DURABLE QUEUE SHAPES</span><p>Fixture statuses distinguish active, queued, completed, and review-required work.</p></div>
    <div className="task-table" role="table" aria-label="Fixture tasks">
      <div className="task-row task-header" role="row"><span>Task</span><span>Runtime</span><span>Status</span><span>Recovery</span></div>
      {FIXTURE_TASKS.map((task) => <div className="task-row" role="row" key={task.id}>
        <span className="task-name"><i className={`queue-status status-${task.status}`} />{task.id.replace(/^[^:]+:/, '')}</span>
        <span>{task.runtimeId === 'codex' ? 'THIS PC · Codex' : task.runtimeId === 'pi' ? 'Server · Pi' : 'Server · Prime'}</span>
        <span className={`task-status status-text-${task.status}`}>{task.status === 'running' ? 'Working' : task.status === 'queued' ? 'Queued' : task.status === 'completed' ? 'Completed' : 'Interrupted'}</span>
        <span className={task.recoveryState === 'review_required' ? 'recovery-review' : 'recovery-none'}>{task.recoveryState === 'review_required' ? 'Review required' : '—'}</span>
      </div>)}
    </div>
    <div className="review-callout"><span className="review-icon">!</span><div><strong>Interrupted outcomes stay visible</strong><p>Review-required work is not described as running, complete, or safe to retry.</p></div></div>
  </section>
}

function ProjectsView({ selectedProjectId, onSelectSession, onViewChat }: { selectedProjectId: string; onSelectSession(sessionId: string): void; onViewChat(): void }) {
  return <section className="collection-view projects-view" aria-label="Synthetic projects">
    <div className="collection-intro"><span className="eyebrow">PROJECTS · FIXTURE ROOTS</span><p>Local Codex and remote Prime/Pi data use separate connection and runtime identifiers.</p></div>
    <div className="project-card-grid">{FIXTURE_PROJECTS.map((project) => {
      const session = FIXTURE_SESSIONS.find((item) => item.projectId === project.id)
      return <article className={`project-card ${selectedProjectId === project.id ? 'selected' : ''}`} key={project.id}>
        <div className="project-card-heading"><span className={`project-card-icon runtime-${project.runtime}`}><Icon name="folder" /></span><span className="project-card-runtime">{project.location} · {project.runtime === 'codex' ? 'Local Codex' : project.runtime === 'pi' ? 'Pi' : 'Prime'}</span></div>
        <h2>{project.name}</h2><p className="project-root">{project.root}</p>
        <div className="project-card-footer"><span className="fixture-tag">SYNTHETIC</span>{session && <button className="text-button" onClick={() => { onSelectSession(session.scope.sessionId); onViewChat() }}>Open fixture session <Icon name="chevron" /></button>}</div>
      </article>
    })}</div>
  </section>
}

function CommandPalette({ preview, onClose, onNavigate, onAppearance, onBench }: { preview: boolean; onClose(): void; onNavigate(view: WorkspaceView): void; onAppearance(): void; onBench(tab: BenchId): void }) {
  return <div className="modal-scrim palette-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="palette-title">
      <div className="palette-search"><Icon name="search" /><h2 id="palette-title">Quick actions</h2><button className="icon-button" aria-label="Close quick actions" onClick={onClose}><Icon name="close" /></button></div>
      <div className="palette-group"><span className="eyebrow">WORK</span>
        <button onClick={() => onNavigate('codex')}><Icon name="code" /><span>Local Codex</span><kbd>Ctrl N</kbd></button>
        <button onClick={() => onNavigate('server')}><Icon name="folder" /><span>Server work</span></button>
        <button onClick={() => onNavigate('connection')}><Icon name="settings" /><span>Connection</span></button>
      </div>
      <div className="palette-group"><span className="eyebrow">PREVIEW/DEMO · SAMPLE DATA</span>
        <button onClick={() => onNavigate('chat')}><Icon name="browser" /><span>Open Preview/demo</span></button>
        {preview && <>
          <button onClick={() => onNavigate('sessions')}><Icon name="history" /><span>Browse demo sessions</span></button>
          <button onClick={() => onNavigate('tasks')}><Icon name="activity" /><span>View demo tasks</span></button>
          <button onClick={() => onNavigate('projects')}><Icon name="folder" /><span>View demo projects</span></button>
          <button onClick={() => onBench('files')}><Icon name="file" /><span>Open synthetic files</span><kbd>Ctrl 2</kbd></button>
          <button onClick={() => onBench('browser')}><Icon name="browser" /><span>Open offline browser fixture</span><kbd>Ctrl 4</kbd></button>
        </>}
      </div>
      <div className="palette-group"><span className="eyebrow">SETTINGS</span>
        <button onClick={onAppearance}><Icon name="settings" /><span>Appearance</span><kbd>Ctrl ,</kbd></button>
      </div>
      <p className="palette-footnote">Preview chat, sessions, projects and workbench panels use fixtures. Local Codex and Server work use the desktop bridge.</p>
    </section>
  </div>
}
