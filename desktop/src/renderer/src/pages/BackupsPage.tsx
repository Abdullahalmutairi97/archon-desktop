import { useEffect, useMemo, useState } from 'react'
import { Archive, CheckCircle2, Clock3, Eye, RefreshCw, RotateCcw } from 'lucide-react'
import { Button, ConfirmDialog, Empty, ErrorNotice, Section, formatBytes, formatDate, usePolling } from '../components'
import type { ArchonApi } from '../lib/api'
import type { Backup } from '../lib/types'

const backupSource = (backup?: Backup) => backup?.encrypted_path || backup?.plain_path || ''

export function BackupsPage({ api }: { api: ArchonApi }) {
  const { data: backups = [], error, refresh } = usePolling(() => api.backups(), 15_000, [api])
  const [schedule, setSchedule] = useState('')
  const [scheduleInfo, setScheduleInfo] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<'create' | 'schedule' | null>(null)
  const [selected, setSelected] = useState<Backup>()
  const [inspection, setInspection] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restoreAll, setRestoreAll] = useState(true)
  const [restorePaths, setRestorePaths] = useState('')
  const [restoreWord, setRestoreWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    void api.backupSchedule().then((info) => {
      setScheduleInfo(info)
      setSchedule(info.calendar || '*-*-* 04:00:00')
    }).catch(() => undefined)
  }, [api])

  const paths = useMemo(() => restorePaths.split(/[\n,]/).map((item) => item.trim()).filter(Boolean), [restorePaths])

  const act = async () => {
    setBusy(true)
    setActionError('')
    try {
      if (confirm === 'create') await api.createBackup(true)
      if (confirm === 'schedule') await api.setBackupSchedule(schedule, true)
      setConfirm(null)
      await refresh()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  const inspect = async () => {
    if (!selected) return
    setBusy(true)
    setActionError('')
    try { setInspection((await api.inspectBackup(backupSource(selected))).contents) }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const restore = async () => {
    if (!selected || restoreWord !== 'RESTORE' || (!restoreAll && !paths.length)) return
    setBusy(true)
    setActionError('')
    try {
      await api.restoreBackup(backupSource(selected), paths, restoreAll, true)
      setRestoreOpen(false)
      setRestoreWord('')
      setRestorePaths('')
      await refresh()
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return <Section title="Backups" description="History, manual creation, selective restore inspection, and the existing Archon backup timer." actions={<Button tone="primary" onClick={() => setConfirm('create')}><Archive size={14}/> Create backup now</Button>}>
    <ErrorNotice error={error || actionError}/>
    <div className="schedule-bar">
      <div><Clock3 size={17}/><span><strong>Backup schedule</strong><small>{scheduleInfo.ActiveState || 'unknown'} · next {scheduleInfo.NextElapseUSecRealtime || 'not reported'}</small></span></div>
      <input value={schedule} onChange={(event) => setSchedule(event.target.value)} aria-label="systemd calendar"/>
      <Button onClick={() => setConfirm('schedule')}>Update schedule</Button>
    </div>
    <div className="backup-layout">
      <div className="list-pane">{!backups.length ? <Empty>No backups found.</Empty> : backups.map((backup) => <button className={`list-row ${selected?.id === backup.id ? 'selected' : ''}`} key={backup.id} onClick={() => { setSelected(backup); setInspection('') }}>
        <span><strong>{formatDate(backup.created_at)}</strong><small>{formatBytes(backup.plain_size)} local · {backup.encrypted ? <><CheckCircle2 size={11}/> encrypted</> : 'plain only'}</small></span><span>{backup.id}</span>
      </button>)}</div>
      <div className="detail-pane">{!selected ? <Empty>Select a backup to inspect or restore.</Empty> : <>
        <header><div><h3>{selected.id}</h3><p>{backupSource(selected)}</p></div><div><Button disabled={busy} onClick={() => void inspect()}><Eye size={14}/> Inspect</Button><Button tone="danger" disabled={busy} onClick={() => setRestoreOpen(true)}><RotateCcw size={14}/> Restore</Button></div></header>
        {inspection ? <pre className="backup-inspection">{inspection}</pre> : <div className="inspection-empty"><RefreshCw size={22}/><p>Inspect first to review the archive before choosing a full or selective restore.</p></div>}
      </>}</div>
    </div>
    <ConfirmDialog open={confirm === 'create'} title="Create a backup now?" detail="This runs the existing Archon backup script immediately." confirmLabel="Create backup" onConfirm={() => void act()} onCancel={() => setConfirm(null)}/>
    <ConfirmDialog open={confirm === 'schedule'} title="Update the backup schedule?" detail={`The existing timer schedule will be changed to ${schedule}.`} confirmLabel="Update schedule" onConfirm={() => void act()} onCancel={() => setConfirm(null)}/>
    {restoreOpen && <div className="dialog-backdrop" role="presentation"><div className="dialog backup-restore-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-title">
      <h3 id="restore-title">Restore {selected?.id}</h3>
      <p>This overwrites live files. Inspect the archive, choose the scope, then type <strong>RESTORE</strong>.</p>
      <label><input type="radio" checked={restoreAll} onChange={() => setRestoreAll(true)}/> Restore every file</label>
      <label><input type="radio" checked={!restoreAll} onChange={() => setRestoreAll(false)}/> Restore selected paths only</label>
      {!restoreAll && <textarea aria-label="Paths to restore" rows={5} value={restorePaths} onChange={(event) => setRestorePaths(event.target.value)} placeholder="One archive path per line"/>}
      <label>Confirmation<input aria-label="Type RESTORE to confirm" value={restoreWord} onChange={(event) => setRestoreWord(event.target.value)} placeholder="RESTORE"/></label>
      <div className="dialog-actions"><Button onClick={() => { setRestoreOpen(false); setRestoreWord('') }}>Cancel</Button><Button tone="danger" disabled={busy || restoreWord !== 'RESTORE' || (!restoreAll && !paths.length)} onClick={() => void restore()}>Restore backup</Button></div>
    </div></div>}
  </Section>
}
