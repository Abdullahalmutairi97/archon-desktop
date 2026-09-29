import { useMemo, useState } from 'react'
import type { LogEntry } from '../../shared/bridge/types'
import type { LiveScope } from '../live/useLiveServer'
import { OpsHeader, OpsLoadState, useOpsResource } from './shared'

export const LOG_LIMIT = 1_500
export const LOGS_POLL_MS = 5_000

const FILTERS = [{ id: 'all', label: 'All' }, { id: 'errors', label: 'Errors' }] as const
type Filter = (typeof FILTERS)[number]['id']

function lineText(entry: LogEntry): string {
  return `${entry.timestamp}  ${entry.level.padEnd(8)}  ${(entry.component || entry.source).padEnd(12)}  ${entry.message}`
}

export function LogsPage({ scope }: { scope: LiveScope }) {
  const { resource, reload } = useOpsResource(scope, async (bridge) => (await bridge.api.invoke('logs.list', { limit: LOG_LIMIT })).logs, LOGS_POLL_MS)
  const [filter, setFilter] = useState<Filter>('all')
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
  const logs = resource.data
  const visible = useMemo(() => (logs ?? []).filter((entry) =>
    filter === 'all' || entry.level === 'ERROR' || entry.level === 'CRITICAL'), [filter, logs])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(visible.map(lineText).join('\n'))
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  return <section className="collection-view ops-page" aria-label="Server logs">
    <OpsHeader eyebrow="SERVER LOGS" description={logs
      ? `Server activity, newest last. ${visible.length} of ${logs.length} lines${logs.length >= LOG_LIMIT ? '; older lines are not shown' : ''}.`
      : 'Server activity, newest last.'}>
      <button type="button" className="text-button" onClick={reload}>Refresh</button>
      <button type="button" className="text-button" onClick={() => { void copy() }} disabled={!visible.length}>{copied === 'copied' ? 'Copied' : 'Copy lines'}</button>
    </OpsHeader>
    {copied === 'failed' && <p className="live-empty-line" role="alert">The clipboard is not available.</p>}
    <div className="ops-filter-bar" role="group" aria-label="Log filter">
      {FILTERS.map((item) => <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
    </div>
    <OpsLoadState resource={resource} subject="log lines" onRetry={reload} />
    {logs && <div className="ops-log-stream" role="log" aria-label="Log lines">
      {visible.map((entry) => <div className={`ops-log-line level-${entry.level.toLowerCase()}`} key={entry.id}>
        <time dir="ltr">{entry.timestamp || '—'}</time>
        <span className="ops-log-level">{entry.level}</span>
        <code dir="ltr">{entry.component || entry.source}</code>
        <p dir="auto">{entry.message}</p>
      </div>)}
      {!visible.length && <p className="live-empty-line">No matching log lines.</p>}
    </div>}
  </section>
}
