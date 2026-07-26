import {
  Alarm, Archive, CaretRight, ChatTeardropDots, ClockCounterClockwise, Folder, GearSix,
  GraduationCap, MagnifyingGlass, Plus, Pulse, Scroll, SlidersHorizontal,
} from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import type { HermesSession, Project, Task } from '../lib/types'
import {
  readExpandedProjectIds, readPinnedProjectIds, relativeWorkspaceTime, SIDEBAR_NAV_TOP,
  SIDEBAR_NAV_UNDER, sortSessions, writeExpandedProjectIds,
} from '../lib/workspace'
import type { PageId } from '../navigation'
import { BrandGlyph } from './BrandGlyph'

const navIcons = {
  chat: ChatTeardropDots,
  sessions: ClockCounterClockwise,
  tasks: Pulse,
  logs: Scroll,
  skills: GraduationCap,
  cron: Alarm,
  backups: Archive,
}

export function WorkspaceSidebar({ projects, sessions, tasks, counts, page, activeSessionId, activeProjectId, settingsOpen, version = '0.6.1', onPage, onNewSession, onOpenSession, onOpenProject, onOpenActivity, onOpenSettings, onOpenUpdate }: {
  projects: Project[]
  sessions: HermesSession[]
  tasks: Task[]
  counts?: { skills: number; cron: number; backups: number; logs: number }
  page: PageId
  activeSessionId?: string
  activeProjectId?: string
  settingsOpen: boolean
  version?: string
  onPage(page: PageId): void
  onNewSession(projectId?: string): void
  onOpenSession(projectId: string | undefined, sessionId: string): void
  onOpenProject(projectId: string): void
  onOpenActivity(): void
  onOpenSettings(): void
  onOpenUpdate(): void
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(readExpandedProjectIds)
  const normalized = query.trim().toLowerCase()
  const pinnedIds = useMemo(() => readPinnedProjectIds(projects), [projects])
  const pinnedProjects = useMemo(() => pinnedIds.map((id) => projects.find((project) => project.id === id)).filter((project): project is Project => Boolean(project)), [pinnedIds, projects])
  const activeTasks = tasks.filter((task) => task.status === 'queued' || task.status === 'running')
  const taskSessions = new Set(activeTasks.map((task) => task.session_id).filter(Boolean))
  const chatCount = sessions.filter((session) => !session.project_id).length

  const toggleProject = (id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    writeExpandedProjectIds(next)
    return next
  })

  const metaFor = (id: keyof typeof navIcons) => {
    if (id === 'chat') return chatCount || ''
    if (id === 'sessions') return sessions.length
    if (id === 'tasks') return `${activeTasks.length} live`
    return String(counts?.[id as keyof typeof counts] ?? 0)
  }
  const navRow = (item: (typeof SIDEBAR_NAV_TOP)[number] | (typeof SIDEBAR_NAV_UNDER)[number]) => {
    const Icon = navIcons[item.id]
    return <button className={`sidebar-nav-row ${page === item.id && !settingsOpen ? 'active' : ''}`} key={item.id} onClick={() => onPage(item.id)}><Icon/><span>{item.label}</span><small>{metaFor(item.id)}</small></button>
  }

  return <aside className="workspace-sidebar">
    <div className="sidebar-primary">
      <div className="sidebar-brand"><BrandGlyph/><span>Archon</span><button title="Check for updates" onClick={onOpenUpdate}>v{version}<i/></button></div>
      <button className="sidebar-new" onClick={() => onNewSession()}><Plus/><span>New session</span><kbd>⌃N</kbd></button>
      <label className="sidebar-search"><MagnifyingGlass/><input aria-label="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions"/><kbd>⌘K</kbd></label>
    </div>

    <div className="sidebar-scroll">
      {SIDEBAR_NAV_TOP.map(navRow)}
      <button className="sidebar-project-heading" onClick={() => onPage('projects')}><span>Projects</span><small>{pinnedProjects.length} of {projects.length} in sidebar</small><SlidersHorizontal/></button>
      <div className="sidebar-projects">{pinnedProjects.map((project) => {
        const related = sortSessions(sessions.filter((session) => session.project_id === project.id && (!normalized || `${session.title} ${session.preview}`.toLowerCase().includes(normalized))), 'recent', 'desc')
        const isExpanded = expanded.has(project.id)
        return <section className="sidebar-project" key={project.id}>
          <div className={`sidebar-project-row ${activeProjectId === project.id || page === 'project' && activeProjectId === project.id ? 'active' : ''}`}>
            <button className="sidebar-project-toggle" title="Show sessions" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${project.name}`} aria-expanded={isExpanded} onClick={() => toggleProject(project.id)}><CaretRight className={isExpanded ? 'expanded' : ''}/></button>
            <Folder/><button className="sidebar-project-open" onClick={() => onOpenProject(project.id)}>{project.name}</button><small>{related.length}</small>
          </div>
          {isExpanded && <div className="sidebar-project-sessions">{related.map((session) => {
            const sessionTask = [...tasks].reverse().find((task) => task.session_id === session.id)
            const state = taskSessions.has(session.id) ? 'working' : sessionTask?.status === 'failed' ? 'failed' : 'finished'
            return <button className={session.id === activeSessionId ? 'active' : ''} key={session.id} onClick={() => onOpenSession(project.id, session.id)}><i className={state}/><span>{session.title || 'Untitled session'}</span><time>{relativeWorkspaceTime(session.last_active)}</time></button>
          })}</div>}
        </section>
      })}</div>
      <div className="sidebar-divider"/>
      {SIDEBAR_NAV_UNDER.map(navRow)}
    </div>

    <div className="sidebar-footer">
      <button className="sidebar-live" onClick={onOpenActivity}><span className={`sidebar-live-dot ${activeTasks.length ? 'busy' : ''}`}/><span><b>{activeTasks.length ? `${activeTasks.length} ${activeTasks.length === 1 ? 'task' : 'tasks'} running` : 'Archon ready'}</b><small>vps-archon-01 · tailscale</small></span><CaretRight/></button>
      <button className={settingsOpen ? 'active' : ''} onClick={onOpenSettings}><GearSix/><span>Settings</span><kbd>⌘,</kbd></button>
    </div>
  </aside>
}
