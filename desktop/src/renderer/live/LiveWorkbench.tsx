import { useEffect, useMemo, useRef, useState } from 'react'
import type { JsonRecord, TaskEventRecord, WorkspaceRecord } from '../../shared/bridge/types'
import { WorkspaceConsole } from '../server/WorkspaceConsole'
import { WorkspaceFileBrowser } from '../server/WorkspaceFileBrowser'
import { WorkspaceServices } from '../server/WorkspaceServices'
import { workspaceFilePort } from '../server/workspaceFilePort'
import { Icon, type IconName } from '../shell/Icon'
import type { BenchId } from '../shell/shortcuts'
import { displayLine, isTerminalStatus, liveTasks, type LiveProject, type LiveSession, type LiveTask } from './liveModels'
import type { LiveScope } from './useLiveServer'
import { LIVE_TASK_LIMIT } from './LiveViews'
import { Markdown } from './Markdown'
import './LiveWorkbench.css'

const tabs: { id: BenchId; label: string; icon: IconName }[] = [
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'browser', label: 'Preview', icon: 'browser' },
]

const ACTIVITY_POLL_MS = 2_000
const MAX_ACTIVITY_ROWS = 60
const MAX_ACTIVITY_TEXT = 400
const MAX_ANSWER_TEXT = 4_000

export type CheckoutChoice = {
  id: string
  root: string
  projectId: string | null
  generation: number
  label: string
}

/** Checkouts in the validated shape the bridge returns; anything else is dropped. */
export function checkoutChoices(records: readonly WorkspaceRecord[], projects: readonly LiveProject[]): CheckoutChoice[] {
  return records.flatMap((record) => {
    if (!/^workspace-[0-9a-f]{32}$/u.test(record.workspace_id) || !Number.isSafeInteger(record.generation) || record.generation < 1) return []
    const project = projects.find((item) => item.id === record.project_id)
    const head = record.checkout?.state === 'branch' && record.checkout.branch
      ? record.checkout.branch
      : (record.checkout?.commit ?? record.head_revision ?? '').slice(0, 12)
    return [{
      id: record.workspace_id,
      root: record.root,
      projectId: record.project_id,
      generation: record.generation,
      label: `${project?.name ?? record.project_id ?? 'Checkout'} · ${head || record.workspace_id.slice(10, 18)}`,
    }]
  })
}

/**
 * The checkout a conversation's tools should open by default: the one the
 * conversation actually runs in, else a checkout of the same project, else none.
 */
export function defaultCheckout(session: LiveSession | null, choices: readonly CheckoutChoice[]): CheckoutChoice | null {
  if (!session) return choices[0] ?? null
  return choices.find((choice) => session.cwd !== null && choice.root === session.cwd)
    ?? choices.find((choice) => session.projectId !== null && choice.projectId === session.projectId)
    ?? null
}

type ActivityRow = { key: string; kind: 'tool' | 'tool-end' | 'diagnostic' | 'answer' | 'error'; text: string }

/** Turn a task's event stream into bounded, readable activity rows. */
export function activityRows(events: readonly TaskEventRecord[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  let answer = ''
  for (const event of events) {
    const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as JsonRecord : {}
    if (event.type === 'tool') {
      const tool = displayLine(data.tool, 80) ?? 'tool'
      if (data.phase === 'end') {
        const failed = typeof data.exit_code === 'number' && data.exit_code !== 0
        rows.push({ key: `${event.seq}`, kind: 'tool-end', text: `${failed ? 'Failed' : 'Done'} · ${tool}` })
      } else {
        const target = displayLine(data.target, MAX_ACTIVITY_TEXT)
        rows.push({ key: `${event.seq}`, kind: 'tool', text: target ? `${tool} · ${target}` : tool })
      }
    } else if (event.type === 'diagnostic') {
      rows.push({ key: `${event.seq}`, kind: 'diagnostic', text: displayLine(data.detail ?? data.message ?? data.kind, MAX_ACTIVITY_TEXT) ?? 'Runtime diagnostic' })
    } else if (event.type === 'message.delta' && typeof data.text === 'string') {
      answer = (answer + data.text).slice(0, MAX_ANSWER_TEXT)
    } else if (event.type === 'error' || event.type === 'failed') {
      rows.push({ key: `${event.seq}`, kind: 'error', text: displayLine(data.error ?? data.message, MAX_ACTIVITY_TEXT) ?? 'The task reported an error' })
    }
  }
  const bounded = rows.slice(-MAX_ACTIVITY_ROWS)
  if (answer.trim()) bounded.push({ key: 'answer', kind: 'answer', text: answer.trim() })
  return bounded
}

function ActivityPanel({ scope, session }: { scope: LiveScope; session: LiveSession | null }) {
  const [tasks, setTasks] = useState<{ key: string; rows: LiveTask[] } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [events, setEvents] = useState<{ taskId: string; rows: TaskEventRecord[] } | null>(null)
  const [error, setError] = useState(false)
  const key = `${scope.generation}:${session?.id ?? ''}`
  const keyRef = useRef(key)
  keyRef.current = key

  const sessionTasks = tasks && tasks.key === key ? tasks.rows : null
  const active = sessionTasks?.some((task) => !isTerminalStatus(task.rawStatus)) ?? false
  const current = sessionTasks?.find((task) => task.id === selected) ?? sessionTasks?.[0] ?? null
  const currentEvents = current && events?.taskId === current.id ? events.rows : null

  useEffect(() => {
    if (!session) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const requested = key
    const load = async () => {
      try {
        const result = await scope.bridge.api.invoke('tasks.list', { limit: LIVE_TASK_LIMIT })
        if (stopped || keyRef.current !== requested) return
        const rows = liveTasks(result.tasks).filter((task) => task.sessionId === session.id)
        setTasks({ key: requested, rows })
        setError(false)
        if (rows.some((task) => !isTerminalStatus(task.rawStatus))) timer = setTimeout(() => { void load() }, ACTIVITY_POLL_MS)
      } catch {
        if (!stopped && keyRef.current === requested) setError(true)
      }
    }
    void load()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [scope, session, key])

  useEffect(() => {
    if (!current) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const taskId = current.id
    const running = !isTerminalStatus(current.rawStatus)
    const load = async () => {
      try {
        const result = await scope.bridge.api.invoke('tasks.events', { taskId, after: 0 })
        if (stopped) return
        setEvents({ taskId, rows: [...result.events] })
        if (running) timer = setTimeout(() => { void load() }, ACTIVITY_POLL_MS)
      } catch {
        if (!stopped) setEvents({ taskId, rows: [] })
      }
    }
    void load()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [scope, current?.id, current?.rawStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return <p className="live-bench-empty">Open a conversation to follow its activity.</p>
  if (error) return <p className="live-bench-empty" role="alert">Task activity could not be read from the server.</p>
  if (!sessionTasks) return <p className="live-bench-empty">Loading activity…</p>
  if (!sessionTasks.length) {
    return <p className="live-bench-empty">No recent tasks for this conversation. Only the {LIVE_TASK_LIMIT} most recent server tasks are searched.</p>
  }
  const rows = currentEvents ? activityRows(currentEvents) : null
  return <div className="live-activity">
    <div className="live-activity-summary"><span>{sessionTasks.length} recent {sessionTasks.length === 1 ? 'task' : 'tasks'}</span>{active && <span className="live-activity-working">Working</span>}</div>
    <ul className="live-activity-tasks">
      {sessionTasks.map((task) => <li key={task.id}>
        <button type="button" aria-pressed={task.id === current?.id} onClick={() => setSelected(task.id)}>
          <span dir="auto">{task.prompt ?? task.id}</span>
          <small>{task.statusLabel}{task.recoveryLabel ? ` · ${task.recoveryLabel}` : ''}</small>
        </button>
      </li>)}
    </ul>
    <div className="live-activity-events" aria-label="Task activity">
      {!rows && <p className="live-bench-empty">Loading task events…</p>}
      {rows && !rows.length && <p className="live-bench-empty">No tool activity was recorded for this task.</p>}
      {rows && rows.map((row) => row.kind === 'answer'
        ? <Markdown key={row.key} className="live-activity-row live-activity-answer" text={row.text} />
        : <div key={row.key} className={`live-activity-row live-activity-${row.kind}`} dir="auto">{row.text}</div>)}
      {current?.error && <div className="live-activity-row live-activity-error" dir="auto">{displayLine(current.error, MAX_ACTIVITY_TEXT)}</div>}
    </div>
  </div>
}

/**
 * The workbench beside a live conversation: its task activity, and the files,
 * terminal and service previews of the checkout it runs in.
 */
export function LiveWorkbench({
  scope,
  session,
  projects,
  active,
  onSelect,
  onClose,
  onOpenServerWork,
}: {
  scope: LiveScope
  session: LiveSession | null
  projects: readonly LiveProject[]
  active: BenchId
  onSelect(tab: BenchId): void
  onClose(): void
  onOpenServerWork(): void
}) {
  const [workspaces, setWorkspaces] = useState<{ generation: number; state: 'ready'; records: readonly WorkspaceRecord[] } | { generation: number; state: 'error' } | null>(null)
  const [chosen, setChosen] = useState<{ key: string; id: string } | null>(null)
  const filePort = useMemo(() => workspaceFilePort(scope.bridge), [scope.bridge])
  const sessionKey = `${scope.generation}:${session?.id ?? ''}`

  useEffect(() => {
    let stopped = false
    void Promise.resolve().then(() => scope.bridge.api.invoke('workspaces.list', {})).then((result) => {
      if (!stopped) setWorkspaces({ generation: scope.generation, state: 'ready', records: result.workspaces })
    }).catch(() => {
      if (!stopped) setWorkspaces({ generation: scope.generation, state: 'error' })
    })
    return () => { stopped = true }
  }, [scope])

  const current = workspaces && workspaces.generation === scope.generation ? workspaces : null
  const choices = useMemo(() => current?.state === 'ready' ? checkoutChoices(current.records, projects) : [], [current, projects])
  const checkout = (chosen?.key === sessionKey ? choices.find((choice) => choice.id === chosen.id) : undefined) ?? defaultCheckout(session, choices)
  const runsElsewhere = !!checkout && !!session?.cwd && session.cwd !== checkout.root

  function checkoutBar() {
    if (!current) return <p className="live-bench-empty">Loading checkouts…</p>
    if (current.state === 'error') return <p className="live-bench-empty" role="alert">Checkouts could not be read from the server.</p>
    return <div className="live-bench-checkout">
      <label htmlFor="live-bench-checkout">Checkout</label>
      <select id="live-bench-checkout" value={checkout?.id ?? ''} onChange={(event) => setChosen({ key: sessionKey, id: event.currentTarget.value })}>
        <option value="">{choices.length ? 'Choose a checkout' : 'No checkouts on this server'}</option>
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
      {checkout && <code dir="ltr">{checkout.root}</code>}
      {runsElsewhere && <p className="live-bench-note">This conversation runs in <code dir="ltr">{session?.cwd}</code>, not in this checkout.</p>}
    </div>
  }

  function needsCheckout(what: string) {
    return <div className="live-bench-empty">
      <p>{what} work on a server checkout. {session?.cwd ? 'This conversation runs in the project source, which has no checkout.' : ''}</p>
      <button type="button" onClick={onOpenServerWork}>Create a checkout in Server work</button>
    </div>
  }

  return <aside className="workspace-bench live-bench" aria-label="Workspace tools">
    <div className="bench-header">
      <div className="bench-tabs" role="tablist" aria-label="Workbench panels">
        {tabs.map((tab, index) => <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={`bench-tab ${active === tab.id ? 'active' : ''}`}
          onClick={() => onSelect(tab.id)}
          title={`${tab.label} · Ctrl ${index + 1}`}
        ><Icon name={tab.icon} /><span>{tab.label}</span></button>)}
      </div>
      <button className="quiet-icon-button bench-close" aria-label="Close workbench" onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="bench-content live-bench-content">
      {active === 'activity' && <ActivityPanel scope={scope} session={session} />}
      {active !== 'activity' && checkoutBar()}
      {active === 'files' && current?.state === 'ready' && (checkout
        ? <WorkspaceFileBrowser key={`${checkout.id}:${checkout.generation}`} workspaceId={checkout.id} readOnlyFilePort={filePort} />
        : needsCheckout('Files'))}
      {(active === 'terminal' || active === 'browser') && current?.state === 'ready' && !scope.localPairingAvailable && <p className="live-bench-empty" role="status">
        {active === 'terminal' ? 'Terminals' : 'Service previews'} need same-user pairing with the server, which this connection does not have.
      </p>}
      {active === 'terminal' && current?.state === 'ready' && scope.localPairingAvailable && (checkout
        ? <WorkspaceConsole key={`${checkout.id}:${checkout.generation}`} bridge={scope.bridge.workspaceConsole} workspaceId={checkout.id} generation={checkout.generation} pairingAvailable />
        : needsCheckout('Terminals'))}
      {active === 'browser' && current?.state === 'ready' && scope.localPairingAvailable && (checkout
        ? <WorkspaceServices key={`${checkout.id}:${checkout.generation}`} bridge={scope.bridge.workspaceServices} preview={scope.bridge.workspacePreview} workspaceId={checkout.id} generation={checkout.generation} pairingAvailable />
        : needsCheckout('Service previews'))}
    </div>
  </aside>
}
