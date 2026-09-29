import { useState } from 'react'
import type { CronAction, CronJob, CronMutationResult, CronUpdateFields } from '../../shared/bridge/types'
import type { LiveScope } from '../live/useLiveServer'
import { ConfirmDialog, formatTimestamp, OpsHeader, OpsLoadState, operationsErrorText, useOpsResource, useScopeGuard } from './shared'

type Form = { name: string; schedule: string; deliver: string; prompt: string }
type Pending = { kind: 'save' } | { kind: 'action'; action: CronAction; job: CronJob }

const EMPTY_FORM: Form = { name: '', schedule: '', deliver: 'local', prompt: '' }
const ACTIONABLE_ID = /^[a-f0-9]{12}$/u
const ACTION_LABELS: Record<CronAction, string> = { pause: 'Pause', resume: 'Resume', run: 'Run now', remove: 'Remove' }

function formFor(job: CronJob): Form {
  return { name: job.name, schedule: job.schedule ?? '', deliver: job.deliver ?? 'local', prompt: job.prompt }
}

/** Only the fields that differ from the stored job are sent. */
export function changedCronFields(job: CronJob, form: Form): CronUpdateFields {
  const stored = formFor(job)
  const fields: CronUpdateFields = {}
  for (const key of ['schedule', 'prompt', 'name', 'deliver'] as const) {
    if (form[key] !== stored[key]) fields[key] = form[key]
  }
  return fields
}

function actionDetail(action: CronAction, job: CronJob): string {
  switch (action) {
    case 'pause': return `Pause “${job.name}”? It will not run until resumed.`
    case 'resume': return `Resume “${job.name}” on its stored schedule?`
    case 'run': return `Run “${job.name}” once now? The agent will execute its prompt immediately.`
    case 'remove': return `Remove “${job.name}” permanently from the server scheduler? This cannot be undone.`
  }
}

export function CronPage({ scope }: { scope: LiveScope }) {
  const { resource, reload, replace } = useOpsResource(scope, async (bridge) => (await bridge.api.invoke('cron.list', {})).jobs)
  const begin = useScopeGuard(scope)
  const [selected, setSelected] = useState<CronJob | null>(null)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string; output?: string } | null>(null)
  const jobs = resource.data
  const editing = selected !== null
  const changes = selected ? changedCronFields(selected, form) : null
  const canSave = form.schedule.trim() !== '' && form.prompt.trim() !== '' && (!changes || Object.keys(changes).length > 0)

  const startCreate = () => { setSelected(null); setForm(EMPTY_FORM) }
  const startEdit = (job: CronJob) => { setSelected(job); setForm(formFor(job)) }

  const execute = async () => {
    if (!pending) return
    const current = begin()
    setBusy(true)
    setFeedback(null)
    try {
      let result: CronMutationResult
      let done: string
      if (pending.kind === 'save') {
        if (selected) {
          result = await scope.bridge.api.invoke('cron.update', { jobId: selected.id, fields: changedCronFields(selected, form), confirm: true })
          done = `Saved changes to “${form.name || selected.name}”.`
        } else {
          result = await scope.bridge.api.invoke('cron.create', { ...form, confirm: true })
          done = `Created “${form.name || 'scheduled job'}”.`
        }
      } else {
        result = await scope.bridge.api.invoke('cron.action', { jobId: pending.job.id, action: pending.action, confirm: true })
        done = `${ACTION_LABELS[pending.action]}: “${pending.job.name}” done.`
      }
      if (!current()) return
      replace(result.jobs)
      setSelected(null)
      setForm(EMPTY_FORM)
      setFeedback({ kind: 'success', text: done, output: result.output })
    } catch (error) {
      if (current()) setFeedback({ kind: 'error', text: operationsErrorText(error, true) })
    } finally {
      if (current()) {
        setBusy(false)
        setPending(null)
      }
    }
  }

  return <section className="collection-view ops-page" aria-label="Server cron jobs">
    <OpsHeader eyebrow="SCHEDULED JOBS" description="The server scheduler’s jobs, shown exactly as stored. Every change asks for confirmation first.">
      <button type="button" className="text-button" onClick={reload}>Refresh</button>
      <button type="button" className="text-button" onClick={startCreate}>New job</button>
    </OpsHeader>
    {feedback && <div className={feedback.kind === 'error' ? 'ops-error' : 'ops-success'} role={feedback.kind === 'error' ? 'alert' : 'status'}>
      <p dir="auto">{feedback.text}</p>
      {feedback.output && <pre className="ops-pre" dir="ltr" aria-label="Scheduler output">{feedback.output}</pre>}
    </div>}
    <OpsLoadState resource={resource} subject="cron jobs" onRetry={reload} />
    {jobs && <div className="ops-split">
      <div className="ops-table-wrap">
        {jobs.length === 0 ? <p className="live-empty-line">The server scheduler has no jobs.</p> : <table className="ops-table" aria-label="Cron jobs">
          <thead><tr><th scope="col">State</th><th scope="col">Name</th><th scope="col">Schedule</th><th scope="col">Next run</th><th scope="col">Last</th><th scope="col"><span className="ops-visually-hidden">Actions</span></th></tr></thead>
          <tbody>{jobs.map((job) => {
            const actionable = ACTIONABLE_ID.test(job.id)
            return <tr key={job.id} aria-selected={selected?.id === job.id}>
              <td>{job.enabled ? 'Active' : 'Paused'}</td>
              <td><strong dir="auto">{job.name}</strong><small dir="ltr">{job.id}</small></td>
              <td><code dir="ltr">{job.schedule ?? '—'}</code></td>
              <td>{formatTimestamp(job.next_run_at)}</td>
              <td dir="auto">{job.last_status ?? '—'}{job.last_error && <small className="ops-error-text" dir="auto">{job.last_error}</small>}</td>
              <td><div className="ops-row-actions">
                {actionable ? <>
                  <button type="button" onClick={() => startEdit(job)} aria-label={`Edit ${job.name}`}>Edit</button>
                  {job.enabled
                    ? <button type="button" onClick={() => setPending({ kind: 'action', action: 'pause', job })} aria-label={`Pause ${job.name}`}>Pause</button>
                    : <button type="button" onClick={() => setPending({ kind: 'action', action: 'resume', job })} aria-label={`Resume ${job.name}`}>Resume</button>}
                  <button type="button" onClick={() => setPending({ kind: 'action', action: 'run', job })} aria-label={`Run ${job.name} now`}>Run</button>
                  <button type="button" className="ops-danger" onClick={() => setPending({ kind: 'action', action: 'remove', job })} aria-label={`Remove ${job.name}`}>Remove</button>
                </> : <small>Unsupported job id; read only.</small>}
              </div></td>
            </tr>
          })}</tbody>
        </table>}
      </div>
      <form className="ops-form" aria-label={editing ? 'Edit scheduled job' : 'Create scheduled job'} onSubmit={(event) => { event.preventDefault(); if (canSave) setPending({ kind: 'save' }) }}>
        <h3>{editing ? `Edit ${selected.name}` : 'Create scheduled job'}</h3>
        <label>Name<input dir="auto" value={form.name} maxLength={300} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} /></label>
        <label>Schedule<input dir="ltr" value={form.schedule} maxLength={120} placeholder="0 7 * * *" onChange={(event) => setForm({ ...form, schedule: event.currentTarget.value })} /></label>
        <label>Delivery<input dir="ltr" value={form.deliver} maxLength={64} onChange={(event) => setForm({ ...form, deliver: event.currentTarget.value })} /></label>
        <label>Prompt<textarea dir="auto" rows={6} value={form.prompt} maxLength={8_000} onChange={(event) => setForm({ ...form, prompt: event.currentTarget.value })} /></label>
        <div className="ops-form-actions">
          {editing && <button type="button" onClick={startCreate}>Discard edit</button>}
          <button type="submit" className="ops-primary" disabled={!canSave}>{editing ? 'Review changes' : 'Review new job'}</button>
        </div>
      </form>
    </div>}
    {pending && <ConfirmDialog
      title="Confirm scheduler change"
      confirmLabel={pending.kind === 'save' ? (editing ? 'Save changes' : 'Create job') : ACTION_LABELS[pending.action]}
      danger={pending.kind === 'action' && (pending.action === 'remove' || pending.action === 'run')}
      busy={busy}
      onCancel={() => { if (!busy) setPending(null) }}
      onConfirm={() => { void execute() }}
    >
      {pending.kind === 'action'
        ? <p dir="auto">{actionDetail(pending.action, pending.job)} This changes the live server scheduler.</p>
        : <>
          <p dir="auto">{editing ? `Save changes to “${selected.name}”?` : `Create “${form.name || 'this job'}”?`} This changes the live server scheduler.</p>
          <dl className="ops-dl">
            <dt>Schedule</dt><dd><code dir="ltr">{form.schedule}</code></dd>
            <dt>Delivery</dt><dd dir="ltr">{form.deliver}</dd>
            {changes && <><dt>Changed</dt><dd>{Object.keys(changes).join(', ')}</dd></>}
          </dl>
        </>}
    </ConfirmDialog>}
  </section>
}
