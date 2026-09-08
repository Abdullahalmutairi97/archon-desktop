import { ArrowsClockwise, CircleNotch, FolderOpen, Plus, Pulse, Trash, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { ArchonApi } from '../lib/api'
import type { Task, PrimeSession, FileItem, TaskEvent } from '../lib/types'
import type { BenchDestination } from '../lib/workspace'
import { ErrorNotice, formatDate, StatusPill } from '../components'
import { TerminalDock } from './TerminalDock'

const tabs: Array<{ id: BenchDestination; label: string }> = [{ id:'tasks',label:'Activity' },{ id:'files',label:'Files' },{ id:'terminal',label:'Terminal' }]
export function WorkspaceBench({ api, panel, onPanel, tasks, sessions, events, ready, onClose, onRefresh }: { api: ArchonApi; panel: BenchDestination; onPanel(value: BenchDestination): void; tasks: Task[]; sessions: PrimeSession[]; events: TaskEvent[]; ready: boolean; onClose(): void; onRefresh(): Promise<void> }) {
  const [files, setFiles] = useState<FileItem[]>([])
  const [path, setPath] = useState('/home/archon')
  const [fileError, setFileError] = useState('')
  const [selectedTask, setSelectedTask] = useState<Task>()
  const loadFiles = async (next = path) => { setFileError(''); try { const result = await api.files(next); setPath(next); setFiles(result) } catch (reason) { setFileError(reason instanceof Error ? reason.message : String(reason)) } }
  useEffect(() => { if (panel === 'files') void loadFiles() }, [panel])
  const active = tasks.filter((task) => ['queued','running','blocked'].includes(task.status))
  return <aside className="workspace-bench">
    <header className="bench-tabs">{tabs.map((item) => <button className={panel === item.id ? 'active' : ''} key={item.id} onClick={() => onPanel(item.id)}>{item.label}{item.id === 'tasks' && active.length > 0 && <i>{active.length}</i>}</button>)}<span/><button aria-label="Close panel" onClick={onClose}><X/></button></header>
    {panel === 'tasks' && <div className="bench-panel activity-panel"><div className="bench-panel-title"><div><b>Server-owned work</b><small>Live snapshot and replayed events from the VPS.</small></div><button aria-label="Refresh activity" onClick={() => void onRefresh()}><ArrowsClockwise/></button></div><div className="bench-list">{active.map((task) => <article key={task.id}><button className="bench-task" onClick={() => setSelectedTask(task)}><span><StatusPill status={task.status}/><b>{task.prompt}</b></span><small>{formatDate(task.created_at)}</small></button><button className="bench-kill" title="Cancel task" onClick={() => void api.cancelTask(task.id).then(onRefresh)}><Trash/></button></article>)}{events.map((event) => <article className="bench-event" key={event.seq}><Pulse/><div><b>{event.type.replaceAll('.', ' ')}</b><small>{event.task_id ? `Task ${event.task_id.slice(0, 8)} · ` : ''}event #{event.seq}</small></div><time>{formatDate(event.created_at)}</time></article>)}{!active.length && !events.length && (ready ? <div className="bench-empty"><CircleNotch/><b>No activity yet</b><span>New and replayed task events will appear here.</span></div> : <div className="bench-empty"><CircleNotch className="spin"/><b>Loading activity</b><span>Waiting for the initial server snapshot.</span></div>)}</div>{selectedTask && <div className="bench-detail"><header><b>{selectedTask.prompt}</b><button onClick={() => setSelectedTask(undefined)}><X/></button></header><pre>{selectedTask.error || selectedTask.result?.text || 'Waiting for runner output…'}</pre></div>}</div>}
    {panel === 'files' && <div className="bench-panel files-panel"><div className="bench-panel-title"><div><b>VPS files</b><code>{path}</code></div><button onClick={() => void loadFiles()}><ArrowsClockwise/></button></div><ErrorNotice error={fileError}/><div className="bench-file-list"><button onClick={() => void loadFiles(path.split('/').slice(0,-1).join('/') || '/')}><FolderOpen/><span>..</span></button>{files.map((entry) => <button key={entry.path} onDoubleClick={() => entry.is_dir && void loadFiles(entry.path)}><FolderOpen/><span>{entry.name}</span><small>{entry.is_dir ? 'dir' : entry.size}</small></button>)}</div></div>}
    {panel === 'terminal' && <TerminalDock api={api}/>}
  </aside>
}
