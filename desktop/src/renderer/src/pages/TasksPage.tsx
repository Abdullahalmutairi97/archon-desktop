import { ArrowSquareOut, X } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { ErrorNotice, usePolling } from '../components'
import type { ArchonApi } from '../lib/api'
import type { Task, TaskStatus } from '../lib/types'

const visibleState: Record<TaskStatus, 'working' | 'queued' | 'failed' | 'finished'> = {
  running: 'working', queued: 'queued', failed: 'failed', completed: 'finished', cancelled: 'finished', blocked: 'queued',
}

function elapsed(task: Task) {
  const start = new Date(task.started_at || task.created_at).getTime()
  const end = ['running', 'queued', 'blocked'].includes(task.status) ? Date.now() : new Date(task.updated_at).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—'
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}

export function TasksPage({ api, onOpenSession }: { api: ArchonApi; onOpenSession(sessionId: string): void }) {
  const { data: tasks = [], error, refresh } = usePolling(() => api.listTasks(), 0, [api])
  const [actionError, setActionError] = useState('')
  const [cancelling, setCancelling] = useState('')
  const cancel = async (task: Task) => {
    setCancelling(task.id); setActionError('')
    try { await api.cancelTask(task.id); await refresh() }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setCancelling('') }
  }
  const ordered = useMemo(() => [...tasks].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()), [tasks])
  return <section className="reference-page tasks-page exact-tasks">
    <header className="reference-page-header"><div><h1>Tasks</h1><p>The truth for what is running right now — durable server-side work.</p></div></header>
    <ErrorNotice error={error || actionError}/>
    <div className="task-truth-list">{ordered.map((task) => {
      const state = visibleState[task.status]
      return <article key={task.id}>
        <span className={`task-state ${state}`}>{state}</span>
        <div className="task-summary"><b>{task.prompt.slice(0, 140)}</b><small>{task.session_id ? `Session ${task.session_id.slice(0, 12)}` : 'Session is assigned when Hermes starts'}</small>{task.error && <em>{task.error}</em>}</div>
        <code>{elapsed(task)}</code>
        <button disabled={!task.session_id} onClick={() => task.session_id && onOpenSession(task.session_id)}><ArrowSquareOut/>{task.session_id ? 'Open session' : 'Session pending'}</button>
        {['running','queued','blocked'].includes(task.status) && <button className="task-cancel" aria-label={`Cancel ${task.prompt.slice(0, 40)}`} disabled={cancelling === task.id} onClick={() => void cancel(task)}><X/></button>}
      </article>
    })}{!ordered.length && <div className="reference-empty">No tasks submitted yet.</div>}</div>
  </section>
}
