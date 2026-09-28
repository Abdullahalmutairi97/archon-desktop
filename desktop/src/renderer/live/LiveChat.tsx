import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { DesktopBridge, SessionMessageRecord, TaskEventRecord, TaskRecord } from '../../shared/bridge/types'
import { normalizeTaskView } from '../../shared/domain/queue'
import { Icon } from '../shell/Icon'
import {
  advanceTask,
  continuationBlocker,
  formatEpochSeconds,
  isTerminalStatus,
  liveTasks,
  operationErrorCode,
  runtimeChoices,
  runtimeLabel,
  taskStatusLabel,
  trackTask,
  transcriptEntries,
  type LiveProject,
  type LiveRuntime,
  type LiveSession,
  type LiveTask,
  type RuntimeChoice,
  type TrackedTask,
} from './liveModels'
import { checkoutChoices, type CheckoutChoice } from './LiveWorkbench'
import { Markdown } from './Markdown'
import type { LiveScope, LiveServer } from './useLiveServer'
import { LiveUnavailable } from './LiveViews'
import './LiveViews.css'

const POLL_DELAY_MS = 2_000
const MAX_POLLS = 120
const MAX_PROMPT_LENGTH = 8_000
/** Transcript rows requested per load; the server returns the most recent rows. */
export const TRANSCRIPT_LIMIT = 200
/** Recent server tasks inspected for work already running in a conversation. */
const TASK_WINDOW = 100

type TrackerState = {
  task: TrackedTask
  cancelPending: boolean
  checking: boolean
  notice: string | null
}

async function readBack(bridge: DesktopBridge, taskId: string, after: number): Promise<{
  detail: TaskRecord | null
  events: readonly TaskEventRecord[] | null
}> {
  const [detailResult, eventsResult] = await Promise.allSettled([
    Promise.resolve().then(() => bridge.api.invoke('tasks.get', { taskId })),
    Promise.resolve().then(() => bridge.api.invoke('tasks.events', { taskId, after })),
  ])
  return {
    detail: detailResult.status === 'fulfilled' && detailResult.value.task.id === taskId ? detailResult.value.task : null,
    events: eventsResult.status === 'fulfilled' ? eventsResult.value.events : null,
  }
}

/**
 * Follow one accepted server task with bounded status/event polling. Nothing
 * here submits work; cancellation is followed by a readback before the result
 * is shown, and results that arrive after unmount or a newer action are dropped.
 */
function useTaskTracker(bridge: DesktopBridge, pollDelayMs: number) {
  const [state, setState] = useState<TrackerState | null>(null)
  const alive = useRef(true)
  const version = useRef(0)
  const actionLock = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      version.current += 1
    }
  }, [])

  const task = state?.task ?? null
  const busy = !!state?.cancelPending || !!state?.checking

  useEffect(() => {
    if (!task || busy || isTerminalStatus(task.status) || task.polls >= MAX_POLLS) return
    const checkVersion = version.current
    const { id, after } = task
    const timer = setTimeout(() => {
      void readBack(bridge, id, after).then(({ detail, events }) => {
        if (!alive.current || version.current !== checkVersion) return
        setState((current) => current && current.task.id === id
          ? { ...current, task: advanceTask(current.task, detail, events, true) }
          : current)
      })
    }, pollDelayMs)
    return () => clearTimeout(timer)
  }, [bridge, task, busy, pollDelayMs])

  const track = useCallback((record: TaskRecord) => {
    version.current += 1
    actionLock.current = false
    setState({ task: trackTask(record), cancelPending: false, checking: false, notice: null })
  }, [])

  const clear = useCallback((taskId?: string) => {
    version.current += 1
    actionLock.current = false
    setState((current) => taskId === undefined || current?.task.id === taskId ? null : current)
  }, [])

  const readNow = useCallback(async (cancel: boolean) => {
    if (!state || busy || actionLock.current) return
    if (cancel && isTerminalStatus(state.task.status)) return
    const { id, after } = state.task
    const checkVersion = ++version.current
    actionLock.current = true
    setState({ ...state, cancelPending: cancel, checking: !cancel, notice: null })
    let cancelFailed = false
    if (cancel) {
      try {
        await bridge.api.invoke('tasks.cancel', { taskId: id })
      } catch {
        cancelFailed = true
      }
      if (!alive.current || version.current !== checkVersion) return
    }
    const { detail, events } = await readBack(bridge, id, after)
    if (!alive.current || version.current !== checkVersion) return
    actionLock.current = false
    let notice: string | null = null
    if (cancel && !detail) {
      notice = cancelFailed
        ? 'Cancellation outcome and server status could not be confirmed. The displayed status may be stale.'
        : 'Cancellation was acknowledged, but the server status could not be confirmed. The displayed status may be stale.'
    } else if (cancel && cancelFailed) {
      notice = 'Cancellation outcome was unclear; the status shown is the server readback.'
    }
    setState((current) => current && current.task.id === id
      ? { task: advanceTask(current.task, detail, events, false), cancelPending: false, checking: false, notice }
      : current)
  }, [bridge, busy, state])

  return {
    state,
    track,
    clear,
    cancel: useCallback(() => { void readNow(true) }, [readNow]),
    checkNow: useCallback(() => { void readNow(false) }, [readNow]),
  }
}

function TaskTrackerCard({
  state,
  title,
  onCancel,
  onCheck,
  onDismiss,
}: {
  state: TrackerState
  title: string
  onCancel(): void
  onCheck(): void
  onDismiss?: () => void
}) {
  const { task } = state
  const terminal = isTerminalStatus(task.status)
  const view = normalizeTaskView({ id: task.id, status: task.status })
  const output = terminal && task.resultText ? task.resultText : task.replyText
  return <section className="live-task" aria-label={title}>
    <div className="live-task-heading">
      <strong>{title}</strong>
      <span className={`task-status status-text-${view.status}`} role="status">{taskStatusLabel(view)}</span>
    </div>
    <p className="live-task-id">Task <code>{task.id}</code></p>
    {output && <Markdown className="live-task-reply" text={output} />}
    {!terminal && !output && <p className="live-task-note">Waiting for output…</p>}
    {task.toolNote && !terminal && <p className="live-task-note">{task.toolNote}</p>}
    {task.diagnostic && <p className="live-task-note">{task.diagnostic}</p>}
    {task.errorText && <div className="live-task-error" role="alert"><strong>Server error</strong><pre dir="auto">{task.errorText}</pre></div>}
    {state.cancelPending && <p className="live-task-note" role="status">Sending cancellation and reading the current server status…</p>}
    {state.checking && <p className="live-task-note" role="status">Reading the current server status…</p>}
    {state.notice && <p className="live-task-note" role="alert">{state.notice}</p>}
    {task.statusCheckFailed && <p className="live-task-note" role="alert">Task status could not be refreshed; the displayed status may be stale.</p>}
    {task.eventsCheckFailed && <p className="live-task-note" role="alert">Task output could not be refreshed.</p>}
    {!terminal && task.polls >= MAX_POLLS && <p className="live-task-note">Automatic status checks paused after {MAX_POLLS} attempts. The task may still be running.</p>}
    <div className="live-task-actions">
      {!terminal && task.polls >= MAX_POLLS && <button type="button" onClick={onCheck} disabled={state.checking || state.cancelPending}>
        {state.checking ? 'Checking server status…' : 'Check status'}
      </button>}
      {!terminal && <button type="button" onClick={onCancel} disabled={state.cancelPending || state.checking}>
        {state.cancelPending ? 'Checking cancellation…' : 'Cancel task'}
      </button>}
      {terminal && onDismiss && <button type="button" onClick={onDismiss}>Dismiss</button>}
    </div>
  </section>
}

type TranscriptState =
  | { state: 'loading' }
  | { state: 'ready'; messages: readonly SessionMessageRecord[]; refreshing: boolean }
  | { state: 'error'; tooLarge: boolean }

type Submission =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'unknown'; checking: boolean }

function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
}

/** One server conversation: its transcript, a composer that continues it, and the task it is running. */
function LiveConversation({
  scope,
  sessionId,
  session,
  sessionsLoading,
  pollDelayMs,
  onConversationChanged,
  onNewConversation,
}: {
  scope: LiveScope
  sessionId: string
  session: LiveSession | null
  sessionsLoading: boolean
  pollDelayMs: number
  onConversationChanged(): void
  onNewConversation(projectId: string | null): void
}) {
  const { bridge } = scope
  const tracker = useTaskTracker(bridge, pollDelayMs)
  const [transcript, setTranscript] = useState<TranscriptState>({ state: 'loading' })
  const [transcriptRequest, setTranscriptRequest] = useState(0)
  const [inspection, setInspection] = useState<'pending' | 'done' | 'failed'>('pending')
  const [latestOutcome, setLatestOutcome] = useState<LiveTask | null>(null)
  const [submission, setSubmission] = useState<Submission>({ state: 'idle' })
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sentPrompt, setSentPrompt] = useState<string | null>(null)
  const alive = useRef(true)
  const transcriptSerial = useRef(0)
  const inspectSerial = useRef(0)
  const submitLock = useRef(false)
  const handledTerminal = useRef<string | null>(null)
  const dismissAfterReload = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { track, clear } = tracker

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    const requestId = ++transcriptSerial.current
    setTranscript((current) => current.state === 'ready' ? { ...current, refreshing: true } : { state: 'loading' })
    void Promise.resolve().then(() => bridge.api.invoke('sessions.messages', { sessionId, limit: TRANSCRIPT_LIMIT })).then((result) => {
      if (transcriptSerial.current !== requestId) return
      setTranscript({ state: 'ready', messages: result.messages, refreshing: false })
      const dismiss = dismissAfterReload.current
      if (dismiss) {
        // The completed reply is now part of the server transcript.
        dismissAfterReload.current = null
        clear(dismiss)
        setSentPrompt(null)
      }
    }).catch((error: unknown) => {
      if (transcriptSerial.current !== requestId) return
      const code = operationErrorCode(error)
      setTranscript({ state: 'error', tooLarge: code === 'response_too_large' })
    })
    return () => {
      if (transcriptSerial.current === requestId) transcriptSerial.current += 1
    }
  }, [bridge, sessionId, transcriptRequest, clear])

  /** Attach to work already running in this conversation; the transcript deliberately omits it. */
  const inspectTasks = useCallback(async (): Promise<'running' | 'idle' | 'failed'> => {
    const requestId = ++inspectSerial.current
    try {
      const result = await bridge.api.invoke('tasks.list', { limit: TASK_WINDOW })
      if (!alive.current || inspectSerial.current !== requestId) return 'failed'
      const mine = liveTasks(result.tasks).filter((task) => task.sessionId === sessionId)
      const running = mine.find((task) => ['queued', 'running', 'cancel_requested', 'unknown'].includes(task.view.status))
      setInspection('done')
      if (running) {
        track({ id: running.id, status: running.rawStatus, session_id: sessionId })
        setLatestOutcome(null)
        return 'running'
      }
      const latest = mine[0]
      setLatestOutcome(latest && latest.view.status !== 'completed' ? latest : null)
      return 'idle'
    } catch {
      if (alive.current && inspectSerial.current === requestId) setInspection('failed')
      return 'failed'
    }
  }, [bridge, sessionId, track])

  useEffect(() => {
    void inspectTasks()
    return () => { inspectSerial.current += 1 }
  }, [inspectTasks])

  const trackedTask = tracker.state?.task ?? null
  useEffect(() => {
    if (!trackedTask || !isTerminalStatus(trackedTask.status) || handledTerminal.current === trackedTask.id) return
    handledTerminal.current = trackedTask.id
    if (trackedTask.status.toLowerCase() === 'completed') dismissAfterReload.current = trackedTask.id
    setTranscriptRequest((value) => value + 1)
    onConversationChanged()
  }, [trackedTask, onConversationChanged])

  const messageCount = transcript.state === 'ready' ? transcript.messages.length : 0
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messageCount, trackedTask?.replyText])

  const runtime: LiveRuntime | null = session?.runtime ?? null
  const entries = useMemo(
    () => transcript.state === 'ready' ? transcriptEntries(transcript.messages, runtime) : [],
    [transcript, runtime],
  )

  const staticBlocker = session
    ? continuationBlocker(session)
    : sessionsLoading
      ? 'Loading this conversation’s ownership details from the server…'
      : 'This conversation is not in the loaded session list, so its ownership cannot be checked. Refresh sessions to continue it.'
  const inFlight = !!trackedTask && !isTerminalStatus(trackedTask.status)
  let blocker = staticBlocker
  if (!blocker && submission.state === 'submitting') blocker = 'Sending once…'
  if (!blocker && submission.state === 'unknown') blocker = 'The last message’s outcome is unknown. Check the server before sending again.'
  if (!blocker && inFlight) blocker = 'A task is already running in this conversation. Wait for it to finish or cancel it.'
  if (!blocker && inspection === 'pending') blocker = 'Checking this conversation for running tasks…'
  if (!blocker && session?.active && !trackedTask) blocker = 'The server reports a task running in this conversation. Refresh to follow it.'
  const canSend = !blocker && draft.trim().length > 0 && draft.length <= MAX_PROMPT_LENGTH

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const prompt = draft
    if (!canSend || !session || submitLock.current) return
    submitLock.current = true
    setSubmission({ state: 'submitting' })
    setNotice(null)
    try {
      const result = await bridge.api.invoke('tasks.submit', {
        sessionId,
        prompt,
        ...(session.projectId ? { projectId: session.projectId } : {}),
      })
      if (!alive.current) return
      setDraft('')
      setSentPrompt(prompt)
      setLatestOutcome(null)
      setSubmission({ state: 'idle' })
      track(result.task)
    } catch {
      // The server may have accepted the message; never resend it automatically.
      if (alive.current) setSubmission({ state: 'unknown', checking: false })
    } finally {
      submitLock.current = false
    }
  }

  async function checkServer(): Promise<void> {
    if (submission.state !== 'unknown' || submission.checking) return
    setSubmission({ state: 'unknown', checking: true })
    const found = await inspectTasks()
    if (!alive.current) return
    setTranscriptRequest((value) => value + 1)
    onConversationChanged()
    if (found === 'failed') {
      setSubmission({ state: 'unknown', checking: false })
      setNotice('Server tasks could not be read. Check the connection before sending again.')
      return
    }
    setSubmission({ state: 'idle' })
    setNotice(found === 'running'
      ? 'The server accepted the message; its task is shown below.'
      : 'No running task was found for this conversation. Review the transcript before sending again.')
    if (found === 'running') setDraft('')
  }

  const lastActive = session?.lastActive ?? null
  return <section className="chat-view live-chat" aria-label="Server conversation">
    <div className="chat-context-line">
      <i className={`runtime-dot runtime-${runtime ?? 'unverified'}`} />
      <span>Server · {runtimeLabel(runtime)}</span>
      <span className="context-dot">·</span>
      <span>{transcript.state === 'ready' ? `${transcript.messages.length} rows shown` : 'Transcript'}</span>
      {lastActive !== null && <><span className="context-dot">·</span><span>{formatEpochSeconds(lastActive)}</span></>}
      <span className="context-spacer" />
      {session?.readOnly && <span className="fixture-tag">READ ONLY</span>}
      {session && session.ownership !== 'verified' && <span className="fixture-tag live-tag-review">{session.ownership === 'review_required' ? 'REVIEW REQUIRED' : 'UNVERIFIED'}</span>}
      <button type="button" className="text-button" onClick={() => setTranscriptRequest((value) => value + 1)} disabled={transcript.state === 'loading' || (transcript.state === 'ready' && transcript.refreshing)}>Reload</button>
      <button type="button" className="text-button" onClick={() => onNewConversation(session?.projectId ?? null)}>New conversation</button>
    </div>

    <div className="message-list live-message-list" ref={listRef} aria-label="Conversation transcript">
      {transcript.state === 'loading' && <p className="live-empty-line" role="status">Loading the conversation from the server…</p>}
      {transcript.state === 'error' && <div className="live-empty-line" role="alert">
        <p>{transcript.tooLarge
          ? 'This conversation is too large to load in one response.'
          : 'The conversation could not be loaded. Check the connection, then reload.'}</p>
      </div>}
      {transcript.state === 'ready' && entries.length === 0 && !trackedTask && <p className="live-empty-line">The server returned no messages for this conversation.</p>}
      {transcript.state === 'ready' && transcript.messages.length >= TRANSCRIPT_LIMIT && <p className="live-empty-line">Showing the most recent {TRANSCRIPT_LIMIT} rows.</p>}
      {entries.map((entry) => entry.primary
        ? <article key={entry.key} className={`message-card message-${entry.role}`}>
          <div className="message-avatar" aria-hidden="true">{entry.role === 'user' ? 'Y' : runtime === 'pi' ? 'Pi' : 'P'}</div>
          <div className="message-body">
            <div className="message-byline"><strong>{entry.label}</strong><span>{entry.timestamp > 0 ? formatEpochSeconds(entry.timestamp) : ''}</span></div>
            {entry.role === 'assistant'
              ? <Markdown className="live-message-text" text={entry.content} />
              : <p className="live-message-text" dir="auto">{entry.content}</p>}
            {entry.hiddenCharacters > 0 && <p className="live-message-clipped">{entry.hiddenCharacters.toLocaleString()} more characters are not shown.</p>}
          </div>
        </article>
        : <details key={entry.key} className="live-message-secondary">
          <summary>{entry.label}{entry.timestamp > 0 ? ` · ${formatEpochSeconds(entry.timestamp)}` : ''}</summary>
          <pre dir="auto">{entry.content || '(empty)'}</pre>
          {entry.hiddenCharacters > 0 && <p className="live-message-clipped">{entry.hiddenCharacters.toLocaleString()} more characters are not shown.</p>}
        </details>)}
      {sentPrompt && trackedTask && <article className="message-card message-user live-message-pending">
        <div className="message-avatar" aria-hidden="true">Y</div>
        <div className="message-body">
          <div className="message-byline"><strong>You</strong><span>Sent · not yet in the transcript</span></div>
          <p className="live-message-text" dir="auto">{sentPrompt}</p>
        </div>
      </article>}
      {tracker.state && <TaskTrackerCard
        state={tracker.state}
        title="Conversation task"
        onCancel={tracker.cancel}
        onCheck={tracker.checkNow}
        onDismiss={() => { clear(); setSentPrompt(null) }}
      />}
      {latestOutcome && !trackedTask && <div className="live-task live-task-outcome" role="note">
        <div className="live-task-heading"><strong>Latest task in this conversation</strong><span className={`task-status status-text-${latestOutcome.view.status}`}>{latestOutcome.statusLabel}</span></div>
        <p className="live-task-note">The server keeps unfinished and failed exchanges out of the transcript.</p>
        {latestOutcome.prompt && <p className="live-task-reply" dir="auto">{latestOutcome.prompt}</p>}
        {latestOutcome.error && <pre className="live-task-error-text" dir="auto">{latestOutcome.error}</pre>}
      </div>}
    </div>

    <form className="chat-bottom live-composer" onSubmit={(event) => { void send(event) }}>
      {submission.state === 'unknown' && <div className="live-task live-task-unknown" role="alert">
        <strong>Message outcome unknown</strong>
        <p>The server may have accepted this message. It will not be sent again automatically.</p>
        <button type="button" onClick={() => { void checkServer() }} disabled={submission.checking}>
          {submission.checking ? 'Checking the server…' : 'Check the server'}
        </button>
      </div>}
      {notice && <p className="live-task-note" role="status">{notice}</p>}
      {inspection === 'failed' && <p className="live-task-note">Running tasks could not be checked for this conversation.</p>}
      <div className="composer-frame">
        <textarea
          aria-label="Message"
          dir="auto"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={submitOnShortcut}
          maxLength={MAX_PROMPT_LENGTH}
          rows={3}
          placeholder={staticBlocker ? 'This conversation cannot be continued here.' : 'Continue this conversation…'}
          disabled={!!staticBlocker}
        />
        <div className="composer-toolbar">
          <span>{runtimeLabel(runtime)} · Trusted execution</span>
          <span>{draft.length.toLocaleString()} / 8,000</span>
          <button type="submit" aria-label="Send message" disabled={!canSend}><Icon className="live-flip" name="chevron" /></button>
        </div>
      </div>
      <p className={`composer-caption ${blocker ? 'live-composer-blocker' : ''}`} role="status">
        {blocker ?? `Sends once to ${scope.serverUrl ?? 'the connected server'} (Ctrl+Enter). Trusted execution is unsandboxed and may edit files or run commands in this conversation’s working directory.`}
      </p>
    </form>
  </section>
}

type RuntimeState =
  | { state: 'loading' }
  | { state: 'ready'; choices: RuntimeChoice[] }
  | { state: 'error' }

/** Start a new server conversation in a registered project with an available runtime. */
function NewConversation({
  scope,
  projects,
  projectsReady,
  preferredProjectId,
  pollDelayMs,
  onConversationChanged,
  onOpenSession,
  onOpenTasks,
}: {
  scope: LiveScope
  projects: readonly LiveProject[]
  projectsReady: boolean
  preferredProjectId: string | null
  pollDelayMs: number
  onConversationChanged(): void
  onOpenSession(sessionId: string): void
  onOpenTasks(): void
}) {
  const { bridge } = scope
  const tracker = useTaskTracker(bridge, pollDelayMs)
  const [runtimes, setRuntimes] = useState<RuntimeState>({ state: 'loading' })
  const [projectId, setProjectId] = useState(preferredProjectId ?? '')
  const [runtime, setRuntime] = useState<LiveRuntime | ''>('')
  // '' runs in the project source; otherwise a checkout of that project (Prime only on the server).
  const [checkoutId, setCheckoutId] = useState('')
  const [checkouts, setCheckouts] = useState<readonly CheckoutChoice[]>([])
  const [prompt, setPrompt] = useState('')
  const [submission, setSubmission] = useState<'idle' | 'submitting' | 'unknown'>('idle')
  const [sentPrompt, setSentPrompt] = useState<string | null>(null)
  const alive = useRef(true)
  const submitLock = useRef(false)
  const handledTerminal = useRef<string | null>(null)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => bridge.api.invoke('runtimes.list', {})).then((result) => {
      if (current) setRuntimes({ state: 'ready', choices: runtimeChoices(result.runtimes) })
    }).catch(() => {
      if (current) setRuntimes({ state: 'error' })
    })
    return () => { current = false }
  }, [bridge])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => bridge.api.invoke('workspaces.list', {})).then((result) => {
      if (current) setCheckouts(checkoutChoices(result.workspaces, projects))
    }).catch(() => {
      if (current) setCheckouts([])
    })
    return () => { current = false }
  }, [bridge, projects])

  const trackedTask = tracker.state?.task ?? null
  useEffect(() => {
    if (!trackedTask || !isTerminalStatus(trackedTask.status) || handledTerminal.current === trackedTask.id) return
    handledTerminal.current = trackedTask.id
    onConversationChanged()
    // A completed first turn is now a server session; open it by its server id.
    if (trackedTask.status.toLowerCase() === 'completed' && trackedTask.sessionId) onOpenSession(trackedTask.sessionId)
  }, [trackedTask, onConversationChanged, onOpenSession])

  const choices = runtimes.state === 'ready' ? runtimes.choices : []
  const selectedProject = projects.find((project) => project.id === projectId) ?? null
  const projectCheckouts = checkouts.filter((choice) => !!selectedProject && choice.projectId === selectedProject.id)
  const selectedCheckout = projectCheckouts.find((choice) => choice.id === checkoutId) ?? null
  // The server runs a checkout conversation with Prime only.
  const selectedRuntime = selectedCheckout
    ? choices.find((choice) => choice.id === 'prime') ?? null
    : choices.find((choice) => choice.id === runtime) ?? choices[0] ?? null
  const locked = submission !== 'idle' || (!!trackedTask && !isTerminalStatus(trackedTask.status))
  const canStart = !locked && !!selectedProject && !!selectedRuntime && prompt.trim().length > 0 && prompt.length <= MAX_PROMPT_LENGTH

  async function start(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canStart || !selectedProject || !selectedRuntime || submitLock.current) return
    const frozen = selectedCheckout
      ? { projectId: selectedProject.id, prompt, workspaceId: selectedCheckout.id, workspaceGeneration: selectedCheckout.generation }
      : { projectId: selectedProject.id, prompt, runtime: selectedRuntime.id }
    submitLock.current = true
    setSubmission('submitting')
    try {
      const result = await bridge.api.invoke('tasks.submit', frozen)
      if (!alive.current) return
      setPrompt('')
      setSentPrompt(frozen.prompt)
      setSubmission('idle')
      tracker.track(result.task)
    } catch {
      if (alive.current) setSubmission('unknown')
    } finally {
      submitLock.current = false
    }
  }

  return <section className="chat-view live-chat live-new-conversation" aria-label="New server conversation">
    <div className="collection-view live-new-body">
      <div className="collection-intro">
        <span className="eyebrow">NEW SERVER CONVERSATION</span>
        <p>Choose a registered server project and an available runtime. To continue an existing conversation, open it from Sessions.</p>
      </div>
      <form className="live-form" onSubmit={(event) => { void start(event) }}>
        <label htmlFor="live-new-project">Project</label>
        <select id="live-new-project" value={selectedProject?.id ?? ''} onChange={(event) => setProjectId(event.currentTarget.value)} disabled={locked || !projects.length}>
          <option value="">{!projectsReady ? 'Loading projects…' : projects.length ? 'Choose a project' : 'No registered server projects'}</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.primaryPath ? ` · ${project.primaryPath}` : ''}</option>)}
        </select>

        <label htmlFor="live-new-checkout">Run in</label>
        <select id="live-new-checkout" value={selectedCheckout?.id ?? ''} onChange={(event) => setCheckoutId(event.currentTarget.value)} disabled={locked || !selectedProject}>
          <option value="">Project source{selectedProject?.primaryPath ? ` · ${selectedProject.primaryPath}` : ''}</option>
          {projectCheckouts.map((choice) => <option key={choice.id} value={choice.id}>Checkout · {choice.label}</option>)}
        </select>
        {selectedCheckout && <p className="live-task-note">Files, terminal and previews in the workbench use this same checkout. The server runs checkout conversations with Prime.</p>}

        <label htmlFor="live-new-runtime">Runtime</label>
        <select id="live-new-runtime" value={selectedRuntime?.id ?? ''} onChange={(event) => setRuntime(event.currentTarget.value === 'pi' ? 'pi' : event.currentTarget.value === 'prime' ? 'prime' : '')} disabled={locked || !choices.length || !!selectedCheckout}>
          {!choices.length && <option value="">{runtimes.state === 'loading' ? 'Checking runtimes…' : runtimes.state === 'error' ? 'Runtimes could not be read' : 'No available runtime'}</option>}
          {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
        {runtimes.state === 'ready' && !choices.length && <p className="live-task-note" role="alert">The server reports no available runtime, so a conversation cannot be started.</p>}
        {runtimes.state === 'error' && <p className="live-task-note" role="alert">Available runtimes could not be read from the server.</p>}

        <label htmlFor="live-new-prompt">First message</label>
        <textarea id="live-new-prompt" dir="auto" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} onKeyDown={submitOnShortcut} maxLength={MAX_PROMPT_LENGTH} rows={5} disabled={locked} placeholder="What should this conversation start with?" />
        <div className="live-form-footer">
          <span>{prompt.length.toLocaleString()} / 8,000 characters</span>
          <button type="submit" disabled={!canStart}>{submission === 'submitting' ? 'Starting…' : 'Start conversation'}</button>
        </div>
        <p className="live-task-note">Sends once to {scope.serverUrl ?? 'the connected server'}. Trusted execution is unsandboxed and may edit files or run commands in the selected project. Provider credentials and native conformance are unverified.</p>
      </form>

      {submission === 'unknown' && <div className="live-task live-task-unknown" role="alert">
        <strong>Start outcome unknown</strong>
        <p>The server may have accepted this conversation. It will not be sent again automatically. Check Tasks before starting it again.</p>
        <div className="live-task-actions">
          <button type="button" onClick={onOpenTasks}>Open tasks</button>
          <button type="button" onClick={() => { setSubmission('idle'); onConversationChanged() }}>I checked · start over</button>
        </div>
      </div>}
      {sentPrompt && trackedTask && <p className="live-sent-prompt" dir="auto"><strong>You:</strong> {sentPrompt}</p>}
      {tracker.state && <TaskTrackerCard
        state={tracker.state}
        title="New conversation task"
        onCancel={tracker.cancel}
        onCheck={tracker.checkNow}
        onDismiss={() => { tracker.clear(); setSentPrompt(null) }}
      />}
    </div>
  </section>
}

/** Live chat route: a selected server conversation, or the new-conversation form. */
export function LiveChatView({
  server,
  sessionId,
  preferredProjectId,
  pollDelayMs = POLL_DELAY_MS,
  onOpenSession,
  onNewConversation,
  onOpenConnection,
  onOpenTasks,
}: {
  server: LiveServer
  sessionId: string | null
  preferredProjectId: string | null
  pollDelayMs?: number
  onOpenSession(sessionId: string): void
  onNewConversation(projectId: string | null): void
  onOpenConnection(): void
  onOpenTasks(): void
}) {
  const { scope, status, refresh } = server
  if (!scope || status === 'rejected' || status === 'error') {
    return <section className="collection-view" aria-label="Server conversation">
      <LiveUnavailable status={status} subject="conversations" onOpenConnection={onOpenConnection} onRetry={refresh} />
    </section>
  }
  if (sessionId) {
    const session = status === 'ready' ? server.sessions.find((item) => item.id === sessionId) ?? null : null
    return <LiveConversation
      key={`${scope.generation}:${sessionId}`}
      scope={scope}
      sessionId={sessionId}
      session={session}
      sessionsLoading={status === 'loading' || status === 'checking' || server.refreshing}
      pollDelayMs={pollDelayMs}
      onConversationChanged={refresh}
      onNewConversation={onNewConversation}
    />
  }
  return <NewConversation
    key={`${scope.generation}:${preferredProjectId ?? ''}`}
    scope={scope}
    projects={server.projects}
    projectsReady={status === 'ready'}
    preferredProjectId={preferredProjectId}
    pollDelayMs={pollDelayMs}
    onConversationChanged={refresh}
    onOpenSession={onOpenSession}
    onOpenTasks={onOpenTasks}
  />
}
