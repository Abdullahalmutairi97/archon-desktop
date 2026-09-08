import { ArrowsDownUp, FolderOpen, Plus } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import type { PrimeSession, Project, Task } from '../lib/types'
import { relativeWorkspaceTime, sortSessions, type SessionSort, type SortDirection } from '../lib/workspace'

const sorts: Array<{ id: SessionSort; label: string }> = [{ id: 'recent', label: 'Recent' }, { id: 'title', label: 'Title' }, { id: 'messages', label: 'Msgs' }]

export function ProjectPage({ project, sessions, tasks, onNew, onOpen }: { project?: Project; sessions: PrimeSession[]; tasks: Task[]; onNew(projectId: string): void; onOpen(projectId: string, sessionId: string): void }) {
  const [sort, setSort] = useState<SessionSort>('recent')
  const [direction, setDirection] = useState<SortDirection>('desc')
  const related = useMemo(() => sortSessions(sessions.filter((session) => session.project_id === project?.id), sort, direction), [direction, project?.id, sessions, sort])
  if (!project) return <div className="reference-empty">Project not found.</div>
  const running = tasks.filter((task) => ['queued', 'running'].includes(task.status) && (task.cwd === project.primary_path || related.some((session) => session.id === task.session_id))).length
  const latest = sortSessions(related, 'recent', 'desc')[0]
  const defaultModel = latest?.model || 'Profile default'
  return <section className="reference-page project-page">
    <header className="project-page-header"><FolderOpen/><div><h1>{project.name}</h1><code>{project.primary_path}</code></div><button onClick={() => onNew(project.id)}><Plus/>New session here</button></header>
    <div className="project-stats"><div><small>Sessions</small><b>{related.length}</b></div><div><small>Last activity</small><b>{latest ? relativeWorkspaceTime(latest.last_active) : '—'}</b></div><div><small>Running now</small><b>{running || 'None'}</b></div><div><small>Default model</small><b>{defaultModel}</b></div></div>
    <div className="project-session-toolbar"><span>Sessions in this project</span><div>{sorts.map((item) => <button className={sort === item.id ? 'active' : ''} key={item.id} onClick={() => setSort(item.id)}>{item.label}</button>)}<button className="direction" onClick={() => setDirection((value) => value === 'asc' ? 'desc' : 'asc')}><ArrowsDownUp/>{direction === 'asc' ? 'Ascending' : 'Descending'}</button></div></div>
    <div className="project-session-list">{related.map((session) => <button key={session.id} onClick={() => onOpen(project.id, session.id)}><i className={session.active ? 'active' : ''}/><span><b>{session.title}</b><small>{session.preview}</small></span><em>{session.model || 'Default'}</em><time>{relativeWorkspaceTime(session.last_active)}</time></button>)}{!related.length && <div className="reference-empty"><span>No sessions in this project yet.</span><button onClick={() => onNew(project.id)}>Start one</button></div>}</div>
  </section>
}
