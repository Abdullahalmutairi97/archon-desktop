import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopBridge, LocalCodexApprovalDto, LocalCodexBridge, LocalCodexEvent, LocalCodexProjectDto, LocalCodexSessionDto, LocalCodexTurnStatusDto } from '../../shared/bridge/types'
import './LocalCodexPanel.css'

const TEXT_LIMIT = 8000
const APPROVAL_LIMIT = 8
type Terminal = Extract<LocalCodexEvent, { type: 'turn.completed' | 'turn.cancelled' | 'turn.failed' }>
type Status = 'idle' | 'checking' | 'starting' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'unknown' | 'outcome_unknown'
interface View { status: Status; turn?: LocalCodexTurnStatusDto; output: string; message: string; approvals: LocalCodexApprovalDto[]; recovered?: boolean; statusCheckFailed?: boolean }
interface EarlyEvents { output?: string; terminal?: Terminal; approvals: LocalCodexApprovalDto[] }
interface Session {
  api: LocalCodexBridge; alive: boolean; ready: boolean; busy: boolean; pending: boolean; ended: boolean; cancelRequested: boolean
  projectId: string; turn?: LocalCodexTurnStatusDto; early: Map<string, EarlyEvents>; approvals: LocalCodexApprovalDto[]; restoring: boolean; recovered: boolean; statusCheckPending: boolean
}
const initialView = (): View => ({ status: 'idle', output: '', message: '', approvals: [] })
const statusLabels: Record<Status, string> = {
  idle: 'Ready for a new turn', checking: 'Checking previous turn', starting: 'Starting', running: 'Running', cancelling: 'Cancellation requested',
  completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', unknown: 'Start outcome unknown', outcome_unknown: 'Outcome unknown after restart',
}

function turnState(viewState: LocalCodexTurnStatusDto['state']): Status {
  return viewState === 'running' ? 'running' : viewState
}

function deny(api: LocalCodexBridge, approvals: readonly LocalCodexApprovalDto[]) {
  for (const approval of approvals) void api.answerApproval({ approvalId: approval.approvalId, allow: false }).catch(() => {})
}

function failureMessage(message: string) {
  const bounded = message.slice(0, 6000)
  if (/sign[ -]?in|log[ -]?in|unauthenticated|authentication|unauthorized/i.test(bounded)) return `${bounded} Run codex login in a terminal on this PC, then check the connection before starting another turn.`
  if (/CLI.*(?:unavailable|not found|not installed)|executable.*(?:unavailable|not found)|ENOENT/i.test(bounded)) return `${bounded} Install the Codex CLI and make sure the desktop app can find the codex executable.`
  return bounded
}

function ApprovalDialog({ approval, answer }: { approval: LocalCodexApprovalDto; answer: (allow: boolean) => void }) {
  const titleId = useId()
  const denyButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const answerRef = useRef(answer)
  answerRef.current = answer
  useEffect(() => {
    const previous = document.activeElement
    denyButton.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); answerRef.current(false) }
      if (event.key !== 'Tab') return
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      const first = buttons[0]
      const last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.removeEventListener('keydown', keyboard)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return createPortal(
    <div className="local-codex-approval-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) answer(false)
    }}>
      <section className="local-codex-approval" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><div><p className="local-codex-eyebrow">THIS PC · CODEX</p><h2 id={titleId}>Approve {approval.kind === 'command' ? 'command' : 'file change'}?</h2></div>
          <button type="button" aria-label="Close and deny approval" onClick={() => answer(false)}>×</button></header>
        <p>Review the exact request below. Closing this dialog denies it.</p>
        <dl>
          <dt>Reason</dt><dd><pre>{approval.reason}</pre></dd>
          <dt>Working directory</dt><dd><code>{approval.cwd}</code></dd>
          {approval.kind === 'file' ? <>
            <dt>Exact proposed changes</dt>
            <dd className="local-codex-file-changes">{approval.changes?.map((change, index) => <section key={`${change.path}:${index}`}>
              <p><strong>{change.kind === 'add' ? 'Add' : change.kind === 'delete' ? 'Delete' : 'Update'}</strong> <code>{change.path}</code></p>
              {change.movePath !== undefined && <p>Move target: <code>{change.movePath}</code></p>}
              <p className="local-codex-diff-label">Exact diff</p>
              <pre aria-label={`Exact diff for ${change.path}`}>{change.diff}</pre>
            </section>)}</dd>
          </> : <dt>Paths</dt>}
          {approval.kind === 'command' && <dd>{approval.paths.length ? <ul>{approval.paths.map((path, index) => <li key={index}><code>{path}</code></li>)}</ul> : 'No paths supplied'}</dd>}
          {approval.command !== undefined && <><dt>Command</dt><dd><pre>{approval.command}</pre></dd></>}
        </dl>
        <footer><button type="button" ref={denyButton} onClick={() => answer(false)}>Deny</button>
          <button type="button" onClick={() => answer(true)}>Allow</button></footer>
      </section>
    </div>, document.body,
  )
}

export function LocalCodexPanel({
  bridge,
  active,
  selectionRequest,
}: {
  bridge?: DesktopBridge
  active: boolean
  selectionRequest?: { requestId: number; projectId: string }
}) {
  const [projects, setProjects] = useState<readonly LocalCodexProjectDto[]>([])
  const [sessions, setSessions] = useState<readonly LocalCodexSessionDto[]>([])
  const [projectId, setProjectId] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [ready, setReady] = useState(false)
  const [projectsLoadFailed, setProjectsLoadFailed] = useState(false)
  const [sessionsLoadFailed, setSessionsLoadFailed] = useState(false)
  const [sessionsRefresh, setSessionsRefresh] = useState(0)
  const [picking, setPicking] = useState(false)
  const [view, setView] = useState<View>(initialView)
  const session = useRef<Session | null>(null)
  const pickingRef = useRef(false)
  const projectRetryTimer = useRef<number | undefined>(undefined)
  const sessionsRetryTimer = useRef<number | undefined>(undefined)
  const sessionsLoadRequest = useRef(0)
  const consumedSelectionRequest = useRef<number | null>(null)
  const projectLoadRequest = useRef(0)
  const pendingProjectSelection = useRef<{ requestId: number; projectId: string } | null>(null)
  const wasActive = useRef(active)
  const formId = useId()
  const api = bridge?.localCodex
  const isCurrent = (current: Session) => current.alive && session.current === current

  async function loadProjects(current: Session, retryOnce = false) {
    const request = ++projectLoadRequest.current
    try {
      const items = await current.api.listProjects()
      if (!isCurrent(current) || request !== projectLoadRequest.current) return
      setProjects(items)
      const selection = pendingProjectSelection.current
      if (selection) {
        pendingProjectSelection.current = null
        if (items.some((item) => item.id === selection.projectId)) {
          setProjectId(selection.projectId)
          setView((previous) => previous.message === 'This workspace is no longer available in Local Codex.' ? { ...previous, message: '' } : previous)
        } else {
          setProjectId((previous) => items.some((item) => item.id === previous) ? previous : items[0]?.id ?? '')
          setView((previous) => ({ ...previous, message: 'This workspace is no longer available in Local Codex.' }))
        }
      } else {
        const preferredProject = current.turn?.projectId
        setProjectId(items.some((item) => item.id === preferredProject)
          ? preferredProject!
          : items.some((item) => item.id === projectId) ? projectId : items[0]?.id ?? '')
      }
      setProjectsLoadFailed(false)
      setView((previous) => previous.message === 'Could not load local projects.' ? { ...previous, message: '' } : previous)
    } catch {
      if (!isCurrent(current)) return
      if (retryOnce) {
        projectRetryTimer.current = window.setTimeout(() => {
          projectRetryTimer.current = undefined
          void loadProjects(current)
        }, 250)
        return
      }
      setProjectsLoadFailed(true)
      setView((previous) => ({ ...previous, message: 'Could not load local projects.' }))
    }
  }

  async function loadSessions(current: Session, targetProjectId: string, retryOnce = false) {
    const request = ++sessionsLoadRequest.current
    try {
      const items = await current.api.listSessions(targetProjectId)
      if (!isCurrent(current) || request !== sessionsLoadRequest.current) return
      setSessions(items)
      setSelectedSessionId((previous) => items.some((item) => item.id === previous)
        || current.turn?.sessionId === previous ? previous : '')
      setSessionsLoadFailed(false)
    } catch {
      if (!isCurrent(current) || request !== sessionsLoadRequest.current) return
      if (retryOnce) {
        sessionsRetryTimer.current = window.setTimeout(() => {
          sessionsRetryTimer.current = undefined
          void loadSessions(current, targetProjectId)
        }, 250)
        return
      }
      setSessionsLoadFailed(true)
    }
  }

  function applyTurnStatus(current: Session, status: LocalCodexTurnStatusDto, recovered: boolean): void {
    const changedTurn = current.turn?.taskId !== status.taskId
    if (changedTurn || status.state !== 'running') deny(current.api, current.approvals)
    const turn: LocalCodexTurnStatusDto = { ...status }
    current.turn = turn
    current.projectId = status.projectId
    current.pending = false
    current.restoring = false
    current.recovered = changedTurn ? recovered : current.recovered || recovered
    current.ended = status.state !== 'running'
    current.busy = status.state === 'running'
    if (changedTurn || status.state !== 'running') current.approvals = []
    if (changedTurn) {
      setProjectId(status.projectId)
      setSelectedSessionId(status.sessionId)
      setSessionsRefresh((previous) => previous + 1)
    }
    setView((previous) => ({
      ...previous,
      turn,
      status: turnState(status.state),
      output: changedTurn ? '' : previous.output,
      message: status.state === 'outcome_unknown'
        ? 'The backend accepted this turn but cannot confirm that it completed before the Codex worker stopped or restarted. It was not resumed.'
        : '',
      approvals: changedTurn || status.state !== 'running' ? [] : previous.approvals,
      recovered: current.recovered,
      statusCheckFailed: false,
    }))

    const early = current.early.get(status.taskId)
    for (const [taskId, other] of current.early) if (taskId !== status.taskId) deny(current.api, other.approvals)
    current.early.clear()
    if (early?.output !== undefined) receive(current, { type: 'turn.output', taskId: status.taskId, text: early.output })
    if (early?.terminal) receive(current, early.terminal)
  }

  async function restoreLatestTurn(current: Session): Promise<void> {
    try {
      const status = await current.api.getLatestTurnStatus?.()
      if (!isCurrent(current)) return
      if (!status) {
        current.restoring = false
        setView(initialView())
        return
      }
      applyTurnStatus(current, status, true)
    } catch {
      if (!isCurrent(current)) return
      current.restoring = false
      setView({
        ...initialView(),
        message: 'The previous Local Codex turn status could not be confirmed. It was not restarted; check the local conversation before starting another turn.',
      })
    }
  }

  async function refreshTurnStatus(current: Session): Promise<void> {
    const taskId = current.turn?.taskId
    if (!taskId || !current.api.getTurnStatus || current.statusCheckPending) return
    current.statusCheckPending = true
    try {
      const status = await current.api.getTurnStatus({ taskId })
      if (!isCurrent(current) || current.turn?.taskId !== taskId) return
      if (current.ended && status.state === 'running') return
      applyTurnStatus(current, status, view.recovered ?? false)
    } catch {
      if (!isCurrent(current) || current.turn?.taskId !== taskId) return
      setView((previous) => ({ ...previous, statusCheckFailed: true }))
    } finally {
      current.statusCheckPending = false
    }
  }

  function receive(current: Session, event: LocalCodexEvent) {
    if (!isCurrent(current)) return
    const eventTaskId = event.type === 'approval.requested' ? event.approval.taskId : event.taskId
    if (event.type === 'approval.requested' && event.approval.kind === 'file'
      && (!event.approval.changes || event.approval.changes.length < 1)) {
      deny(current.api, [event.approval])
      return
    }
    // Main may emit progress or completion before the start acknowledgement crosses IPC.
    if ((current.pending || current.restoring) && !current.turn) {
      let early = current.early.get(eventTaskId)
      if (!early) {
        if (current.early.size >= 8) {
          if (event.type === 'approval.requested') deny(current.api, [event.approval])
          return
        }
        early = { approvals: [] }
        current.early.set(eventTaskId, early)
      }
      if (event.type === 'approval.requested') {
        if (current.restoring || early.terminal || event.approval.projectId !== current.projectId || early.approvals.length >= APPROVAL_LIMIT) deny(current.api, [event.approval])
        else if (!early.approvals.some((item) => item.approvalId === event.approval.approvalId)) early.approvals.push(event.approval)
      } else if (!early.terminal) {
        if (event.type === 'turn.output') early.output = event.text.slice(0, TEXT_LIMIT)
        else early.terminal = event
      }
      return
    }
    if (!current.turn || eventTaskId !== current.turn.taskId
      || (current.ended && !(current.recovered && event.type === 'turn.output'))) {
      if (event.type === 'approval.requested') deny(current.api, [event.approval])
      return
    }
    if (event.type === 'approval.requested') {
      if (event.approval.projectId !== current.turn.projectId || current.approvals.length >= APPROVAL_LIMIT) {
        deny(current.api, [event.approval]); return
      }
      if (current.approvals.some((item) => item.approvalId === event.approval.approvalId)) return
      current.approvals = [...current.approvals, event.approval]
      setView((previous) => ({ ...previous, approvals: current.approvals }))
    } else if (event.type === 'turn.output') {
      // The service emits a bounded replacement snapshot, not a text delta.
      setView((previous) => ({ ...previous, output: event.text.slice(0, TEXT_LIMIT) }))
    } else {
      current.ended = true
      current.busy = false
      deny(current.api, current.approvals)
      current.approvals = []
      setView((previous) => ({ ...previous, approvals: [],
        status: event.type === 'turn.completed' ? 'completed' : event.type === 'turn.cancelled' ? 'cancelled' : 'failed',
        message: event.type === 'turn.failed' ? failureMessage(event.message) : '',
      }))
    }
  }

  useEffect(() => {
    setProjects([]); setSessions([]); setProjectId(''); setSelectedSessionId(''); setReady(false); setProjectsLoadFailed(false); setSessionsLoadFailed(false); setPicking(false); pickingRef.current = false; setView(initialView())
    if (!api) { session.current = null; return }
    const current: Session = { api, alive: true, ready: false, busy: false, pending: false, ended: false, cancelRequested: false, projectId: '', early: new Map(), approvals: [], restoring: !!api.getLatestTurnStatus, recovered: false, statusCheckPending: false }
    session.current = current
    if (current.restoring) setView({ ...initialView(), status: 'checking' })
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = api.subscribe((event) => receive(current, event))
      current.ready = true
      setReady(true)
    } catch {
      setView((previous) => ({ ...previous, message: 'Could not subscribe to local Codex. Reopen the desktop app to reconnect.' }))
    }
    void loadProjects(current, true)
    if (current.restoring) void restoreLatestTurn(current)
    return () => {
      current.alive = false
      if (projectRetryTimer.current !== undefined) window.clearTimeout(projectRetryTimer.current)
      if (sessionsRetryTimer.current !== undefined) window.clearTimeout(sessionsRetryTimer.current)
      projectRetryTimer.current = undefined
      sessionsRetryTimer.current = undefined
      sessionsLoadRequest.current += 1
      unsubscribe?.()
      deny(current.api, current.approvals)
      for (const early of current.early.values()) deny(current.api, early.approvals)
      current.approvals = []; current.early.clear()
    }
    // Visibility deliberately does not control the subscription or task lifetime.
  }, [api])

  // The Server work route can register a paired checkout while this panel stays
  // mounted but hidden. Refresh projects when the user returns to Local Codex.
  useEffect(() => {
    const becameActive = active && !wasActive.current
    wasActive.current = active
    const isNewSelection = selectionRequest !== undefined && consumedSelectionRequest.current !== selectionRequest.requestId
    if (isNewSelection && selectionRequest) {
      consumedSelectionRequest.current = selectionRequest.requestId
      pendingProjectSelection.current = selectionRequest
    }
    const current = session.current
    if ((becameActive || isNewSelection) && current?.ready) void loadProjects(current, true)
  }, [active, api, selectionRequest])

  useEffect(() => {
    setSessions([])
    setSelectedSessionId('')
    setSessionsLoadFailed(false)
  }, [projectId])

  useEffect(() => {
    const current = session.current
    if (!current?.ready || !projectId) return
    void loadSessions(current, projectId, true)
    return () => {
      sessionsLoadRequest.current += 1
      if (sessionsRetryTimer.current !== undefined) window.clearTimeout(sessionsRetryTimer.current)
      sessionsRetryTimer.current = undefined
    }
  }, [api, projectId, ready, sessionsRefresh])

  useEffect(() => {
    const current = session.current
    if (!current || view.status !== 'running' || !current.api.getTurnStatus) return
    const timer = window.setInterval(() => { void refreshTurnStatus(current) }, 3_000)
    return () => window.clearInterval(timer)
  }, [api, view.status, view.turn?.taskId])

  async function registerProject() {
    const current = session.current
    if (!current?.ready || current.busy || pickingRef.current) return
    pickingRef.current = true; setPicking(true)
    try {
      const project = await current.api.registerProject()
      if (!isCurrent(current) || !project) return
      setProjects((previous) => [...previous.filter((item) => item.id !== project.id), project])
      setProjectId(project.id)
    } catch {
      if (isCurrent(current)) setView((previous) => ({ ...previous, message: 'Could not register the selected local project.' }))
    } finally {
      if (isCurrent(current)) { pickingRef.current = false; setPicking(false) }
    }
  }

  async function startTurn() {
    const current = session.current
    if (!current?.ready || current.busy || pickingRef.current || !projects.some((item) => item.id === projectId) || !prompt.trim() || prompt.length > TEXT_LIMIT) return
    current.busy = true; current.pending = true; current.ended = false; current.cancelRequested = false; current.turn = undefined; current.recovered = false
    current.projectId = projectId; current.early.clear(); current.approvals = []
    setView({ ...initialView(), status: 'starting' })
    try {
      const turn = await current.api.startTurn({ projectId, prompt, ...(selectedSessionId ? { sessionId: selectedSessionId } : {}) })
      if (!isCurrent(current)) return
      if (turn.projectId !== current.projectId) throw new Error('Project binding mismatch')
      if (turn.sessionId) setSelectedSessionId(turn.sessionId)
      setSessionsRefresh((previous) => previous + 1)
      current.pending = false; current.turn = turn
      setView((previous) => ({ ...previous, turn, status: 'running' }))
      const early = current.early.get(turn.taskId)
      for (const [taskId, other] of current.early) if (taskId !== turn.taskId) deny(current.api, other.approvals)
      current.early.clear()
      if (early?.output !== undefined) receive(current, { type: 'turn.output', taskId: turn.taskId, text: early.output })
      if (early?.terminal) { deny(current.api, early.approvals); receive(current, early.terminal) }
      else for (const approval of early?.approvals ?? []) receive(current, { type: 'approval.requested', approval })
    } catch (error) {
      if (!isCurrent(current)) return
      current.pending = false
      for (const early of current.early.values()) deny(current.api, early.approvals)
      current.early.clear()
      // An IPC rejection does not prove that native execution never started.
      const detail = error instanceof Error ? failureMessage(error.message) : 'The local connection could not start the turn.'
      setView((previous) => ({ ...previous, status: 'unknown', message: `${detail} The start outcome could not be confirmed. No automatic retry will be made. Check the local Codex process before resetting this panel.` }))
    }
  }

  async function cancelTurn() {
    const current = session.current
    if (!current?.turn || current.ended || current.cancelRequested) return
    const taskId = current.turn.taskId
    current.cancelRequested = true
    setView((previous) => ({ ...previous, status: 'cancelling' }))
    try {
      const accepted = await current.api.cancelTurn({ taskId })
      if (isCurrent(current) && current.turn?.taskId === taskId && !current.ended && !accepted) {
        current.cancelRequested = false
        setView((previous) => ({ ...previous, status: 'running', message: 'Cancellation was not accepted. Waiting for the turn result.' }))
      }
    } catch {
      if (isCurrent(current) && current.turn?.taskId === taskId && !current.ended) {
        current.cancelRequested = false
        setView((previous) => ({ ...previous, status: 'running', message: 'Cancellation could not be confirmed. The turn may still be running.' }))
      }
    }
  }

  function answerApproval(approval: LocalCodexApprovalDto, allow: boolean) {
    const current = session.current
    if (!current || !current.approvals.some((item) => item.approvalId === approval.approvalId)) return
    current.approvals = current.approvals.filter((item) => item.approvalId !== approval.approvalId)
    setView((previous) => ({ ...previous, approvals: current.approvals }))
    void current.api.answerApproval({ approvalId: approval.approvalId, allow }).then((accepted) => {
      if (isCurrent(current) && current.turn?.taskId === approval.taskId && !current.ended && !accepted) setView((previous) => ({ ...previous, message: 'This approval is no longer pending.' }))
    }).catch(() => {
      deny(current.api, [approval])
      if (isCurrent(current) && current.turn?.taskId === approval.taskId && !current.ended) setView((previous) => ({ ...previous, message: 'The approval answer could not be confirmed. A deny response was requested.' }))
    })
  }

  const project = projects.find((item) => item.id === projectId)
  const busy = ['checking', 'starting', 'running', 'cancelling', 'unknown', 'outcome_unknown'].includes(view.status)
  const approval = view.approvals[0]
  return <>
    <section className="local-codex-panel" aria-label="Local Codex" hidden={!active}>
      <header><div><p className="local-codex-eyebrow">THIS PC · CODEX</p><h1>Work in a local project</h1></div>
        <span className="local-codex-status" role="status">{!api ? 'Desktop connection unavailable' : statusLabels[view.status]}</span></header>
      <p className="local-codex-description">Start a new conversation by default, or choose an earlier conversation in this project to continue it. Review command and exact file-change approvals here.</p>
      {!api && <p>Open the desktop app to run Codex on this PC. Browser preview is offline.</p>}
      {view.recovered && <p className="local-codex-message" role="status">Latest accepted turn status restored from the backend. Retained output may replay if its journal event is still available; pending approvals are not restored.</p>}
      {view.statusCheckFailed && <p className="local-codex-message" role="alert">The backend status could not be refreshed. The displayed status may be stale.</p>}
      <form onSubmit={(event) => { event.preventDefault(); void startTurn() }}>
        <div className="local-codex-project-row"><label htmlFor={`${formId}-project`}>Local project
          <select id={`${formId}-project`} value={projectId} disabled={!ready || busy || picking} onChange={(event) => setProjectId(event.target.value)}>
            {!projects.length && <option value="">No local projects registered</option>}
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <button type="button" disabled={!ready || busy || picking} onClick={() => void registerProject()}>{picking ? 'Choosing folder…' : 'Add local project'}</button>
          {projectsLoadFailed && <button type="button" disabled={!ready || busy || picking} onClick={() => { const current = session.current; if (current) void loadProjects(current) }}>Retry projects</button>}
        </div>
        <div className="local-codex-project-row"><label htmlFor={`${formId}-conversation`}>Conversation
          <select id={`${formId}-conversation`} value={selectedSessionId} disabled={!ready || busy || picking || !project} onChange={(event) => setSelectedSessionId(event.target.value)}>
            <option value="">New conversation</option>
            {sessions.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.turnCount} {item.turnCount === 1 ? 'turn' : 'turns'}</option>)}
          </select></label>
          {sessionsLoadFailed && <button type="button" disabled={!ready || busy || picking || !project} onClick={() => setSessionsRefresh((previous) => previous + 1)}>Retry conversations</button>}
        </div>
        {project && <code className="local-codex-root">{project.rootPath}</code>}
        <label htmlFor={`${formId}-prompt`}>Local prompt
          <textarea id={`${formId}-prompt`} rows={5} maxLength={TEXT_LIMIT} value={prompt} disabled={!ready || busy} onChange={(event) => setPrompt(event.target.value.slice(0, TEXT_LIMIT))} placeholder="What should Codex do in this project?" />
        </label>
        <div className="local-codex-actions"><span>{prompt.length.toLocaleString()} / 8,000 characters</span><div>
          {(view.status === 'running' || view.status === 'cancelling') && <button type="button" disabled={view.status === 'cancelling'} onClick={() => void cancelTurn()}>Cancel turn</button>}
          <button type="submit" disabled={!ready || busy || picking || !project || !prompt.trim()}>Start Codex turn</button>
        </div></div>
      </form>
      {view.message && <p className="local-codex-message" role="alert">{view.message}</p>}
      {(view.status === 'unknown' || view.status === 'outcome_unknown') && <div><button type="button" onClick={() => {
        const current = session.current
        if (!current || current.pending) return
        current.busy = false; current.ended = true; current.turn = undefined
        setView(initialView())
      }}>Reset after checking</button></div>}
      {(view.turn || view.output) && <div className="local-codex-result"><div className="local-codex-result-heading"><h2>Turn output</h2>{view.turn && <code>{view.turn.taskId}</code>}
        {view.status === 'running' && session.current?.api.getTurnStatus && <button type="button" onClick={() => { const current = session.current; if (current) void refreshTurnStatus(current) }}>Refresh backend status</button>}</div>
        <pre aria-label="Codex output">{view.output || (view.recovered && view.status !== 'running' ? 'Earlier output may be unavailable if its journal event was evicted.' : 'Waiting for output…')}</pre><p>Output is limited to the latest service snapshot of 8,000 characters.</p></div>}
    </section>
    {approval && <ApprovalDialog key={approval.approvalId} approval={approval} answer={(allow) => answerApproval(approval, allow)} />}
  </>
}
