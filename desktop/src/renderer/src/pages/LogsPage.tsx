import { Check, Copy, DownloadSimple } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { ErrorNotice, usePolling } from '../components'
import type { ArchonApi } from '../lib/api'
import type { LogEntry } from '../lib/types'

const filters = [{ id: 'all', label: 'All' }, { id: 'runner', label: 'Runner' }, { id: 'backend', label: 'Backend' }, { id: 'cron', label: 'Cron' }, { id: 'errors', label: 'Errors' }] as const

export function LogsPage({ api }: { api: ArchonApi }) {
  const [filter, setFilter] = useState<(typeof filters)[number]['id']>('all')
  const [copied, setCopied] = useState(false)
  const { data: logs = [], error } = usePolling<LogEntry[]>(() => api.logs([], '', 1500), 3000, [api])
  const visible = useMemo(() => [...logs].filter((entry) => {
    const haystack = `${entry.source} ${entry.component}`.toLowerCase()
    if (filter === 'errors') return entry.level === 'ERROR' || entry.level === 'CRITICAL'
    return filter === 'all' || haystack.includes(filter)
  }).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()), [filter, logs])
  const text = () => visible.map((entry) => `${entry.timestamp}  ${entry.level.padEnd(8)}  ${(entry.component || entry.source).padEnd(12)}  ${entry.message}`).join('\n')
  const copy = async () => { try { await navigator.clipboard.writeText(text()); setCopied(true); window.setTimeout(() => setCopied(false), 1500) } catch { setCopied(false) } }
  const download = () => { const href = URL.createObjectURL(new Blob([text()], { type: 'text/plain' })); const anchor = document.createElement('a'); anchor.href = href; anchor.download = `archon-logs-${new Date().toISOString().slice(0, 10)}.txt`; anchor.click(); URL.revokeObjectURL(href) }
  const clock = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value.slice(0, 8) : date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) }

  return <section className="reference-page logs-page exact-logs">
    <header className="reference-page-header"><div><h1>Logs</h1><p>Backend, runner, cron and auth — merged, newest last. {visible.length} of {logs.length} lines</p></div><div className="log-actions"><button onClick={() => void copy()}>{copied ? <Check/> : <Copy/>}{copied ? 'Copied' : 'Copy all'}</button><button onClick={download}><DownloadSimple/>Download</button></div></header>
    <div className="log-filter-bar">{filters.map((item) => <button className={filter === item.id ? 'active' : ''} key={item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}<code>journalctl --user -u archon-desktop-server -f</code></div>
    <ErrorNotice error={error}/>
    <div className="reference-log-stream" role="log">{visible.map((entry) => <div className={`log-line level-${entry.level.toLowerCase()}`} key={entry.id}><time>{clock(entry.timestamp)}</time><span>{entry.level}</span><code>{entry.component || entry.source}</code><p>{entry.message}</p></div>)}{!visible.length && <div className="reference-empty">No matching log records.</div>}</div>
  </section>
}
