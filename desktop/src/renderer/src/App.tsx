import { useCallback, useEffect, useMemo, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { CommandPalette } from './components/CommandPalette'
import { ConnectionSetup } from './components/ConnectionSetup'
import { ErrorNotice } from './components'
import { ArchonApi } from './lib/api'
import { applyAppearance, readAppearance, saveAppearance } from './lib/appearance'
import { applyTheme, readTheme, type ThemeId } from './lib/theme'
import type { ConnectionConfig, HermesSession, ModelCatalog, Project, Task, TaskEvent } from './lib/types'
import { mergeActivityEvents } from './lib/activity'

import type { PageId } from './navigation'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { WorkspaceBench } from './components/WorkspaceBench'
import { ChatPage } from './pages/ChatPage'
import { ChatsPage } from './pages/ChatsPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectPage } from './pages/ProjectPage'
import { SessionsPage } from './pages/SessionsPage'
import { TasksPage } from './pages/TasksPage'
import { LogsPage } from './pages/LogsPage'
import { ModelsPage } from './pages/ModelsPage'
import { SkillsPage } from './pages/SkillsPage'
import { FilesPage } from './pages/FilesPage'
import { TerminalPage } from './pages/TerminalPage'
import { BackupsPage } from './pages/BackupsPage'
import { CronPage } from './pages/CronPage'
import { StatusPage } from './pages/StatusPage'
import { SettingsPage } from './pages/SettingsPage'
import { UpdateDialog } from './components/UpdateDialog'
import { readSidebarCollapsed, writeSidebarCollapsed, type BenchDestination } from './lib/workspace'

export function App() {
  const [connection, setConnection] = useState<ConnectionConfig | null | undefined>(undefined)
  const [api, setApi] = useState<ArchonApi | null>(null)
  const [server, setServer] = useState<Record<string, string> | null>(null)
  const [serverError, setServerError] = useState('')
  const [page, setPage] = useState<PageId>('home')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('0.6.1')
  const [previousPage, setPreviousPage] = useState<PageId>('home')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteSeed, setPaletteSeed] = useState('')
  const [bench, setBench] = useState<BenchDestination>()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<HermesSession[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [activityEvents, setActivityEvents] = useState<TaskEvent[]>([])
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [counts, setCounts] = useState({ skills: 0, cron: 0, backups: 0, logs: 0 })
  const [chatIntent, setChatIntent] = useState<{ projectId?: string; sessionId?: string; nonce: number }>({ nonce: 0 })
  const [selectedProjectId, setSelectedProjectId] = useState<string>()

  useEffect(() => {
    applyTheme(readTheme())
    const language = localStorage.getItem('archon.language') === 'ar' ? 'ar' : 'en'
    document.documentElement.lang = language
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'
    applyAppearance(readAppearance())
    void window.archon?.getSettings().then((value) => {
      if (typeof value.theme === 'string') applyTheme(value.theme as ThemeId)
      if (value.language === 'ar' || value.language === 'en') {
        localStorage.setItem('archon.language', value.language)
        document.documentElement.lang = value.language
        document.documentElement.dir = value.language === 'ar' ? 'rtl' : 'ltr'
      }
      if (value.appearance) saveAppearance(value.appearance as ReturnType<typeof readAppearance>)
      if (Array.isArray(value.customAppearances)) localStorage.setItem('archon.custom-appearances.v1', JSON.stringify(value.customAppearances))
    }).catch(() => undefined)
    void window.archon?.getConnection().then((value) => {
      const next = value.serverUrl && value.token && value.secureStorage ? value : null
      setConnection(next); setApi(next ? new ArchonApi(next) : null)
    }).catch(() => setConnection(null))
    void window.archon?.getVersion().then(setAppVersion).catch(() => undefined)
  }, [])

  const refreshWorkspace = useCallback(async () => {
    if (!api) return
    const results = await Promise.allSettled([api.projects(), api.sessions(), api.listTasks(), api.models()])
    if (results[0].status === 'fulfilled') setProjects(results[0].value)
    if (results[1].status === 'fulfilled') setSessions(results[1].value)
    if (results[2].status === 'fulfilled') setTasks(results[2].value)
    if (results[3].status === 'fulfilled') setCatalog(results[3].value)
  }, [api])

  const refreshCounts = useCallback(async () => {
    if (!api) return
    const values = await Promise.allSettled([api.skills(), api.cronJobs(), api.backups(), api.logs([], '', 1000)])
    const count = (index: number) => values[index].status === 'fulfilled' ? values[index].value.length : 0
    setCounts({ skills: count(0), cron: count(1), backups: count(2), logs: count(3) })
  }, [api])

  useEffect(() => { void refreshCounts() }, [refreshCounts])

  useEffect(() => {
    if (!api) return
    let cancelled = false
    setWorkspaceReady(false)
    Promise.all([api.server(), api.projects(), api.sessions(), api.listTasks(), api.models()]).then(([serverResult, projectResult, sessionResult, taskResult, modelResult]) => {
      if (cancelled) return
      setServer(serverResult); setProjects(projectResult); setSessions(sessionResult); setTasks(taskResult); setCatalog(modelResult); setServerError('')
    }).catch((reason) => { if (!cancelled) setServerError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (!cancelled) setWorkspaceReady(true) })
    return () => { cancelled = true }
  }, [api])

  useEffect(() => {
    if (!api) return
    const controller = new AbortController()
    let closed = false
    let cursor = Number(localStorage.getItem('archon.event-cursor') || 0)
    let refreshTimer: number | undefined
    const onEvent = (event: TaskEvent) => {
      cursor = event.seq
      localStorage.setItem('archon.event-cursor', String(cursor))
      setActivityEvents((current) => mergeActivityEvents(current, [event]))
      window.dispatchEvent(new CustomEvent('archon:data-changed', { detail: event }))
      if (refreshTimer) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => void refreshWorkspace(), 160)
    }
    const connect = async () => {
      while (!closed) {
        try { cursor = await api.streamEvents(cursor, onEvent, controller.signal); setServerError('') }
        catch (reason) {
          if (controller.signal.aborted) return
          setServerError(reason instanceof Error ? reason.message : String(reason))
          await new Promise((resolve) => window.setTimeout(resolve, 1000))
        }
      }
    }
    void connect()
    return () => { closed = true; controller.abort(); if (refreshTimer) window.clearTimeout(refreshTimer) }
  }, [api, refreshWorkspace])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => { const next = !current; writeSidebarCollapsed(next); return next })
  }, [])


  const navigate = useCallback((next: PageId) => {
    if (next === 'settings') { setPreviousPage(page); setSettingsOpen(true); return }
    setSettingsOpen(false); setPage(next)
  }, [page])
  const openSession = useCallback((projectId?: string, sessionId?: string) => {
    setChatIntent({ projectId, sessionId, nonce: Date.now() })
    if (projectId) setSelectedProjectId(projectId)
    setSettingsOpen(false); setPage('home')
  }, [])
  const openProject = useCallback((projectId: string) => { setSelectedProjectId(projectId); setSettingsOpen(false); setPage('project') }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteSeed(''); setPaletteOpen(true) }
      if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openSession() }
      if (modifier && event.key === ',') { event.preventDefault(); setPreviousPage(page); setSettingsOpen(true) }
      if (modifier && event.key === '\\') { event.preventDefault(); toggleSidebar() }
      const digit = /^Digit[123]$/.test(event.code) ? event.code.slice(-1) : event.key
      if (modifier && ['1','2','3'].includes(digit)) { event.preventDefault(); setBench(digit === '1' ? 'tasks' : digit === '2' ? 'files' : 'terminal') }
      if (event.key === 'Escape') { if (updateOpen) setUpdateOpen(false); else if (settingsOpen) setSettingsOpen(false); else setBench(undefined) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSession, page, settingsOpen, toggleSidebar, updateOpen])

  const saveConnection = async (next: ConnectionConfig) => {
    const stored = await window.archon?.setConnection(next)
    if (!stored?.secureStorage || !stored.token) throw new Error('Secure device storage is unavailable. Archon will not store a plaintext token.')
    const secureNext = { ...next, secureStorage: true }
    const nextApi = new ArchonApi(secureNext)
    await nextApi.server()
    setConnection(secureNext); setApi(nextApi); setServerError('')
  }

  if (connection === undefined) return <div className="connection-setup"><section><span>Loading Archon…</span></section></div>
  if (!connection || !api) return <ConnectionSetup initial={connection || undefined} onSave={saveConnection}/>

  const activeSession = sessions.find((session) => session.id === chatIntent.sessionId)
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const activeProjectId = chatIntent.projectId || selectedProjectId
  const crumb = page === 'home' ? activeSession?.title || 'Chat' : page === 'project' ? selectedProject?.name || 'Projects' : page === 'cron' ? 'Automations' : page[0].toUpperCase() + page.slice(1)
  const title = `${crumb} · Archon`
  const newSession = (projectId?: string) => openSession(projectId)
  const content = (() => {
    switch (page) {
      case 'home': return <ChatPage key={chatIntent.nonce} api={api} intent={chatIntent} projects={projects} sessions={sessions} tasks={tasks} catalog={catalog} refreshSessions={refreshWorkspace} refreshTasks={refreshWorkspace} onOpenChat={openSession}/>
      case 'chat': return <ChatsPage api={api} sessions={sessions} tasks={tasks} catalog={catalog} onOpen={(sessionId) => openSession(undefined, sessionId)} onCreated={refreshWorkspace}/>
      case 'projects': return <ProjectsPage api={api} tasks={tasks} onOpen={openProject}/>
      case 'project': return <ProjectPage project={selectedProject} sessions={sessions} tasks={tasks} onNew={newSession} onOpen={openSession}/>
      case 'sessions': return <SessionsPage api={api} onOpen={openSession}/>
      case 'tasks': return <TasksPage api={api} onOpenSession={(sessionId) => openSession(undefined, sessionId)}/>
      case 'logs': return <LogsPage api={api}/>
      case 'models': return <ModelsPage api={api}/>
      case 'skills': return <SkillsPage api={api}/>
      case 'files': return <FilesPage api={api}/>
      case 'terminal': return <TerminalPage api={api}/>
      case 'backups': return <BackupsPage api={api}/>
      case 'cron': return <CronPage api={api}/>
      case 'status': return <StatusPage api={api}/>
      default: return null
    }
  })()

  return <div className={`desktop-v2 ${bench ? 'bench-open' : ''} ${sidebarCollapsed ? 'sidebar-hidden' : ''}`}>
    <TitleBar title={title} crumb={crumb} bench={bench} unseen={{ tasks: tasks.some((task) => task.status === 'queued' || task.status === 'running') }} onSidebar={toggleSidebar} onBench={(id) => setBench((current) => current === id ? undefined : id)}/>
    <div className="workspace-shell">
      <WorkspaceSidebar projects={projects} sessions={sessions} tasks={tasks} counts={counts} page={page} activeSessionId={chatIntent.sessionId} activeProjectId={activeProjectId} settingsOpen={settingsOpen} version={appVersion} onPage={navigate} onNewSession={newSession} onOpenSession={openSession} onOpenProject={openProject} onOpenActivity={() => navigate('tasks')} onOpenSettings={() => { setPreviousPage(page); setSettingsOpen(true) }} onOpenUpdate={() => setUpdateOpen(true)}/>
      <main className="workspace-main"><ErrorNotice error={serverError}/>{content}</main>
      {bench && <WorkspaceBench api={api} panel={bench} onPanel={setBench} tasks={tasks} sessions={sessions} events={activityEvents} ready={workspaceReady} onClose={() => setBench(undefined)} onRefresh={refreshWorkspace}/>}
    </div>
    {settingsOpen && <SettingsPage api={api} connection={connection} onConnection={saveConnection} onClose={() => { setSettingsOpen(false); setPage(previousPage) }} onUpdate={() => setUpdateOpen(true)}/>}
    <UpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)}/>
    <CommandPalette open={paletteOpen} seed={paletteSeed} onClose={() => { setPaletteOpen(false); setPaletteSeed('') }} onPage={navigate} onBench={setBench} onNewSession={() => openSession()} onSearchSessions={(query) => { setPaletteSeed(query); setPaletteOpen(true) }} projects={projects} sessions={sessions} onOpenSession={openSession}/>
    <span hidden>{server?.profile}</span>
  </div>
}

export default App
