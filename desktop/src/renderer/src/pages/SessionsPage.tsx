import { ArrowsDownUp, MagnifyingGlass } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { ErrorNotice, usePolling } from '../components'
import type { ArchonApi } from '../lib/api'
import type { HermesSession, Project } from '../lib/types'
import { relativeWorkspaceTime, sortSessions, type SessionSort, type SortDirection } from '../lib/workspace'

const sortOptions: Array<{ id: SessionSort; label: string }> = [
  { id: 'recent', label: 'Recent' }, { id: 'project', label: 'Project' }, { id: 'model', label: 'Model' },
  { id: 'messages', label: 'Msgs' }, { id: 'status', label: 'Status' },
]

export function SessionsPage({ api, onOpen }: { api: ArchonApi; onOpen(projectId: string | undefined, sessionId: string): void }) {
  const { data: sessions = [], error } = usePolling<HermesSession[]>(() => api.sessions(), 4000, [api])
  const { data: projects = [] } = usePolling<Project[]>(() => api.projects(), 15000, [api])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [direction, setDirection] = useState<SortDirection>('desc')
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects])
  const filtered = useMemo(() => sortSessions(sessions.filter((session) => !query.trim() || `${session.title} ${session.preview} ${session.model}`.toLowerCase().includes(query.trim().toLowerCase())), sort, direction), [direction, query, sessions, sort])
  const sortNote = sort === 'recent' ? `${direction === 'asc' ? 'oldest' : 'newest'} first · by last activity` : `${direction === 'asc' ? 'A to Z' : 'Z to A'} · by ${sort === 'messages' ? 'message count' : sort}`

  return <section className="reference-page sessions-page exact-sessions">
    <header className="reference-page-header"><div><h1>Sessions</h1><p>{sessions.length} sessions across {projects.length} projects — desktop, CLI, TUI, Telegram and cron.</p></div><label className="reference-search"><MagnifyingGlass/><input aria-label="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, preview or model"/></label></header>
    <div className="session-sort-toolbar"><span>Sort</span>{sortOptions.map((item) => <button className={sort === item.id ? 'active' : ''} key={item.id} onClick={() => setSort(item.id)}>{item.label}</button>)}<button className="direction" onClick={() => setDirection((value) => value === 'asc' ? 'desc' : 'asc')}><ArrowsDownUp/>{direction === 'asc' ? 'Ascending' : 'Descending'}</button><small>{sortNote}</small></div>
    <ErrorNotice error={error}/>
    <div className="reference-session-table"><div className="head"><span>Session</span><span>Project</span><span>Model</span><span>Msgs</span><span>Activity</span></div>{filtered.map((session) => <button className="row" key={session.id} onClick={() => onOpen(session.project_id, session.id)}><span className="session-cell"><i className={session.active ? 'active' : ''}/><span><b>{session.title || 'Untitled session'}</b><small>{session.preview}</small></span></span><span><em>{session.project_id ? names.get(session.project_id) || 'Project' : 'Unassigned'}</em></span><span>{session.model || 'Default'}</span><span>{session.message_count}</span><time>{relativeWorkspaceTime(session.last_active)}</time></button>)}</div>
  </section>
}
