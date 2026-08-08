import { ArrowsDownUp, MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { ConfirmDialog, ErrorNotice, usePolling } from '../components'
import type { ArchonApi } from '../lib/api'
import type { HermesSession, Project } from '../lib/types'
import { relativeWorkspaceTime, sortSessions, type SessionSort, type SortDirection } from '../lib/workspace'

const sortOptions: Array<{ id: SessionSort; label: string }> = [
  { id: 'recent', label: 'Recent' }, { id: 'project', label: 'Project' }, { id: 'model', label: 'Model' },
  { id: 'messages', label: 'Msgs' }, { id: 'status', label: 'Status' },
]

export function SessionsPage({ api, onOpen }: { api: ArchonApi; onOpen(projectId: string | undefined, sessionId: string): void }) {
  const { data: sessions = [], error, refresh } = usePolling<HermesSession[]>(() => api.sessions(), 4000, [api])
  const { data: projects = [] } = usePolling<Project[]>(() => api.projects(), 15000, [api])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [direction, setDirection] = useState<SortDirection>('desc')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState('')
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects])
  const filtered = useMemo(() => sortSessions(sessions.filter((session) => !query.trim() || `${session.title} ${session.preview} ${session.model}`.toLowerCase().includes(query.trim().toLowerCase())), sort, direction), [direction, query, sessions, sort])
  const selectedSessionIds = useMemo(() => sessions.filter((session) => selectedIds.has(session.id)).map((session) => session.id), [selectedIds, sessions])
  const allVisibleSelected = filtered.length > 0 && filtered.every((session) => selectedIds.has(session.id))
  const sortNote = sort === 'recent' ? `${direction === 'asc' ? 'oldest' : 'newest'} first · by last activity` : `${direction === 'asc' ? 'A to Z' : 'Z to A'} · by ${sort === 'messages' ? 'message count' : sort}`

  useEffect(() => {
    const available = new Set(sessions.map((session) => session.id))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
  }, [sessions])

  const toggleSelected = (sessionId: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId)
    return next
  })
  const toggleVisible = () => setSelectedIds((current) => {
    const next = new Set(current)
    if (allVisibleSelected) filtered.forEach((session) => next.delete(session.id))
    else filtered.forEach((session) => next.add(session.id))
    return next
  })
  const removeSelected = async () => {
    if (deleting || !selectedSessionIds.length) return
    setDeleting(true)
    setActionError('')
    try {
      const result = await api.deleteSessions(selectedSessionIds)
      setSelectedIds((current) => {
        const next = new Set(current)
        result.deleted.forEach((id) => next.delete(id))
        return next
      })
      setDeleteOpen(false)
      await refresh()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(false)
    }
  }

  return <section className="reference-page sessions-page exact-sessions">
    <header className="reference-page-header"><div><h1>Sessions</h1><p>{sessions.length} sessions across {projects.length} projects — desktop, CLI, TUI, Telegram and cron.</p></div><div className="session-header-actions"><button className="session-bulk-remove" disabled={!selectedSessionIds.length || deleting} onClick={() => setDeleteOpen(true)}>Remove selected ({selectedSessionIds.length})</button><label className="reference-search"><MagnifyingGlass/><input aria-label="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, preview or model"/></label></div></header>
    <div className="session-sort-toolbar"><span>Sort</span>{sortOptions.map((item) => <button className={sort === item.id ? 'active' : ''} key={item.id} onClick={() => setSort(item.id)}>{item.label}</button>)}<button className="direction" onClick={() => setDirection((value) => value === 'asc' ? 'desc' : 'asc')}><ArrowsDownUp/>{direction === 'asc' ? 'Ascending' : 'Descending'}</button><small>{sortNote}</small></div>
    <ErrorNotice error={error || actionError}/>
    <div className="reference-session-table"><div className="head"><input type="checkbox" aria-label="Select all visible sessions" checked={allVisibleSelected} disabled={!filtered.length} onChange={toggleVisible}/><span>Session</span><span>Project</span><span>Model</span><span>Msgs</span><span>Activity</span></div>{filtered.map((session) => <div className={`row ${selectedIds.has(session.id) ? 'selected' : ''}`} key={session.id}><input type="checkbox" aria-label={`Select ${session.title || 'Untitled session'}`} checked={selectedIds.has(session.id)} onChange={() => toggleSelected(session.id)}/><button className="session-open" onClick={() => onOpen(session.project_id, session.id)}><span className="session-cell"><i className={session.active ? 'active' : ''}/><span><b>{session.title || 'Untitled session'}</b><small>{session.preview}</small></span></span><span><em>{session.project_id ? names.get(session.project_id) || 'Project' : 'Unassigned'}</em></span><span>{session.model || 'Default'}</span><span>{session.message_count}</span><time>{relativeWorkspaceTime(session.last_active)}</time></button></div>)}</div>
    <ConfirmDialog open={deleteOpen} title={`Remove ${selectedSessionIds.length} session${selectedSessionIds.length === 1 ? '' : 's'}?`} detail="This permanently removes the selected conversations and their Archon task history. Running sessions cannot be removed." confirmLabel={deleting ? 'Removing…' : `Remove ${selectedSessionIds.length} session${selectedSessionIds.length === 1 ? '' : 's'}`} danger onCancel={() => { if (!deleting) setDeleteOpen(false) }} onConfirm={() => void removeSelected()}/>
  </section>
}
