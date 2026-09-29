import { useMemo, useState } from 'react'
import type { BackupRecord, BackupSchedule } from '../../shared/bridge/types'
import type { LiveScope } from '../live/useLiveServer'
import { ConfirmDialog, formatBytes, formatTimestamp, OpsHeader, OpsLoadState, operationsErrorText, useOpsResource, useScopeGuard } from './shared'

const DEFAULT_CALENDAR = '*-*-* 04:00:00'

export function backupSource(backup: BackupRecord): string | null {
  return backup.encrypted_path ?? backup.plain_path
}

export function parseRestorePaths(text: string): string[] {
  return [...new Set(text.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean))]
}

type Feedback = { kind: 'error' | 'success'; text: string; output?: string }

function RestoreDialog({ backup, busy, onCancel, onRestore }: {
  backup: BackupRecord
  busy: boolean
  onCancel(): void
  onRestore(allFiles: boolean, paths: string[]): void
}) {
  const [allFiles, setAllFiles] = useState(true)
  const [pathText, setPathText] = useState('')
  const [typed, setTyped] = useState('')
  const paths = useMemo(() => parseRestorePaths(pathText), [pathText])
  const ready = typed === backup.id && (allFiles || paths.length > 0)
  return <ConfirmDialog
    title={`Restore backup ${backup.id}`}
    confirmLabel="Restore backup"
    danger
    busy={busy}
    confirmDisabled={!ready}
    onCancel={() => { if (!busy) onCancel() }}
    onConfirm={() => { if (ready) onRestore(allFiles, allFiles ? [] : paths) }}
  >
    <p>This overwrites live files on the server with the archive’s copies. Inspect the archive first, choose the scope, then type the backup name <strong dir="ltr">{backup.id}</strong> to confirm.</p>
    <p className="ops-note" dir="ltr">{backupSource(backup)}</p>
    <fieldset className="ops-fieldset">
      <legend>Scope</legend>
      <label><input type="radio" name="ops-restore-scope" checked={allFiles} onChange={() => setAllFiles(true)} /> Restore every file</label>
      <label><input type="radio" name="ops-restore-scope" checked={!allFiles} onChange={() => setAllFiles(false)} /> Restore selected paths only</label>
    </fieldset>
    {!allFiles && <label>Archive paths, one per line<textarea dir="ltr" rows={5} value={pathText} onChange={(event) => setPathText(event.currentTarget.value)} /></label>}
    <label>Type {backup.id} to confirm<input dir="ltr" aria-label="Type the backup name to confirm" autoComplete="off" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} /></label>
  </ConfirmDialog>
}

export function BackupsPage({ scope }: { scope: LiveScope }) {
  const backups = useOpsResource(scope, async (bridge) => (await bridge.api.invoke('backups.list', {})).backups)
  const schedule = useOpsResource<BackupSchedule>(scope, (bridge) => bridge.api.invoke('backups.schedule.get', {}))
  const begin = useScopeGuard(scope)
  const [calendarDraft, setCalendarDraft] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'create' | 'schedule' | 'restore' | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspection, setInspection] = useState<{ id: string; contents: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const list = backups.resource.data
  const selected = list?.find((item) => item.id === selectedId) ?? null
  const calendar = calendarDraft ?? schedule.resource.data?.calendar ?? DEFAULT_CALENDAR
  const info = schedule.resource.data

  const run = async (action: () => Promise<Feedback | null>) => {
    const current = begin()
    setBusy(true)
    setFeedback(null)
    try {
      const result = await action()
      if (current() && result) setFeedback(result)
    } catch (error) {
      if (current()) setFeedback({ kind: 'error', text: operationsErrorText(error, confirm !== null) })
    } finally {
      if (current()) {
        setBusy(false)
        setConfirm(null)
      }
    }
  }

  const createBackup = () => run(async () => {
    const current = begin()
    const result = await scope.bridge.api.invoke('backups.create', { confirm: true })
    if (!current()) return null
    backups.replace(result.backups)
    return { kind: 'success', text: 'The backup script finished.', output: result.output }
  })

  const updateSchedule = () => run(async () => {
    const current = begin()
    const result = await scope.bridge.api.invoke('backups.schedule.set', { calendar, confirm: true })
    if (!current()) return null
    setCalendarDraft(null)
    schedule.reload()
    return { kind: 'success', text: `The backup timer schedule is now ${result.calendar}.` }
  })

  const inspect = (backup: BackupRecord, source: string) => run(async () => {
    const current = begin()
    const result = await scope.bridge.api.invoke('backups.inspect', { source })
    if (current()) setInspection({ id: backup.id, contents: result.contents })
    return null
  })

  const restore = (backup: BackupRecord, source: string, allFiles: boolean, paths: string[]) => run(async () => {
    const result = await scope.bridge.api.invoke('backups.restore', { source, allFiles, paths, confirm: true })
    return { kind: 'success', text: `Restored ${allFiles ? 'every file' : `${paths.length} path${paths.length === 1 ? '' : 's'}`} from ${backup.id}.`, output: result.output }
  })

  const selectedSource = selected ? backupSource(selected) : null

  return <section className="collection-view ops-page" aria-label="Server backups">
    <OpsHeader eyebrow="BACKUPS" description="Backup history, manual creation, archive inspection and restore, and the server backup timer. Every change asks for confirmation first.">
      <button type="button" className="text-button" onClick={backups.reload}>Refresh</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => setConfirm('create')}>Create backup now</button>
    </OpsHeader>
    {feedback && <div className={feedback.kind === 'error' ? 'ops-error' : 'ops-success'} role={feedback.kind === 'error' ? 'alert' : 'status'}>
      <p dir="auto">{feedback.text}</p>
      {feedback.output && <pre className="ops-pre" dir="ltr" aria-label="Command output">{feedback.output}</pre>}
    </div>}

    <div className="ops-schedule" role="group" aria-label="Backup schedule">
      <div>
        <strong>Backup schedule</strong>
        {schedule.resource.status === 'error'
          ? <small role="alert">{schedule.resource.error}</small>
          : <small>{info ? `${info.ActiveState ?? 'state not reported'} · next ${info.NextElapseUSecRealtime || 'not reported'}${info.calendar ? '' : ' · default timer calendar'}` : 'Loading…'}</small>}
      </div>
      <input dir="ltr" aria-label="systemd calendar expression" value={calendar} maxLength={120} onChange={(event) => setCalendarDraft(event.currentTarget.value)} />
      <button type="button" disabled={busy || schedule.resource.status !== 'ready' || !calendar.trim()} onClick={() => setConfirm('schedule')}>Update schedule</button>
    </div>

    <OpsLoadState resource={backups.resource} subject="backups" onRetry={backups.reload} />
    {list && <div className="ops-split">
      <div className="ops-list" role="group" aria-label="Backups">
        {list.length === 0 ? <p className="live-empty-line">The server reports no backups.</p> : list.map((backup) => <button type="button" key={backup.id} aria-pressed={backup.id === selectedId} onClick={() => { setSelectedId(backup.id); setInspection(null) }}>
          <span><strong>{formatTimestamp(backup.created_at)}</strong><small>{formatBytes(backup.plain_size ?? backup.encrypted_size)} · {backup.encrypted ? 'encrypted' : 'plain only'}</small></span>
          <span dir="ltr">{backup.id}</span>
        </button>)}
      </div>
      <div className="ops-detail">
        {!selected ? <p className="live-empty-line">Select a backup to inspect or restore.</p> : <>
          <header className="ops-detail-head">
            <div><h3 dir="ltr">{selected.id}</h3><p className="ops-note" dir="ltr">{selectedSource ?? 'No archive file reported'}</p></div>
            <div className="ops-row-actions">
              <button type="button" disabled={busy || !selectedSource} onClick={() => { if (selectedSource) void inspect(selected, selectedSource) }}>Inspect</button>
              <button type="button" className="ops-danger" disabled={busy || !selectedSource} onClick={() => setConfirm('restore')}>Restore…</button>
            </div>
          </header>
          {inspection?.id === selected.id
            ? <pre className="ops-pre" dir="ltr" aria-label="Archive contents">{inspection.contents}</pre>
            : <p className="live-empty-line">Inspect first to review the archive before choosing a full or selective restore.</p>}
        </>}
      </div>
    </div>}

    {confirm === 'create' && <ConfirmDialog title="Create a backup now?" confirmLabel="Create backup" busy={busy} onCancel={() => { if (!busy) setConfirm(null) }} onConfirm={() => { void createBackup() }}>
      <p>This runs the server’s backup script immediately. It can take several minutes.</p>
    </ConfirmDialog>}
    {confirm === 'schedule' && <ConfirmDialog title="Update the backup schedule?" confirmLabel="Update schedule" busy={busy} onCancel={() => { if (!busy) setConfirm(null) }} onConfirm={() => { void updateSchedule() }}>
      <p>The server’s backup timer will run on <code dir="ltr">{calendar}</code>.</p>
    </ConfirmDialog>}
    {confirm === 'restore' && selected && selectedSource && <RestoreDialog
      backup={selected}
      busy={busy}
      onCancel={() => setConfirm(null)}
      onRestore={(allFiles, paths) => { void restore(selected, selectedSource, allFiles, paths) }}
    />}
  </section>
}
