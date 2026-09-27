import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionDescription, DesktopBridge, JsonRecord, TaskEventRecord, TaskRecord } from '../../shared/bridge/types'
import './PrimeTaskPanel.css'

const POLL_DELAY_MS = 2_000
const MAX_POLLS = 120
const MAX_OUTPUT_LENGTH = 30_000
const MAX_RECENT_TASKS = 8
const MAX_ACTIVITY_ITEMS = 8
const MAX_ACTIVITY_ITEM_LENGTH = 200
const MAX_ACTIVITY_TOTAL_LENGTH = 1_000

type ProjectChoice = { id: string; name: string; primaryPath: string }
type WorkspaceChoice = { id: string; projectId: string; root: string; generation: number }
type PrimeTaskSummary = { id: string; status: string }
type TaskActivity = { seq: number; kind: 'assistant' | 'tool'; text: string }
type Draft = { bridge: DesktopBridge; generation: number; projectId: string; prompt: string; workspaceId?: string }
type Confirmation = Draft & { project: ProjectChoice; workspace?: WorkspaceChoice }
type TaskProgress = {
  id: string
  status: string
  after: number
  polls: number
  activity: readonly TaskActivity[]
  resultText: string | null
  errorText: string | null
  statusCheckFailed: boolean
  eventsCheckFailed: boolean
}
type Submission = {
  bridge: DesktopBridge
  generation: number
  project: ProjectChoice
  prompt: string
  state: 'submitting' | 'unknown' | 'task'
  task?: TaskProgress
  cancelPending?: boolean
  checkingStatus?: boolean
  cancelNotice?: string
  recentTasks?: readonly JsonRecord[] | null
  recentTasksFailed?: boolean
  checkingRecent?: boolean
}
type Capability = {
  bridge: DesktopBridge
  generation: number
  state: 'loading' | 'disconnected' | 'unavailable' | 'ready'
  message?: string
}
type TaskOpenState = { bridge: DesktopBridge; generation: number; taskId: string | null; message?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized : null
}

function projectChoices(projects: readonly JsonRecord[]): ProjectChoice[] {
  return projects.flatMap((record) => {
    const id = nonEmptyString(record.id)
    const name = nonEmptyString(record.name)
    const primaryPath = nonEmptyString(record.primary_path)
    return id && name && primaryPath ? [{ id, name, primaryPath }] : []
  })
}

function workspaceChoices(workspaces: readonly JsonRecord[]): WorkspaceChoice[] {
  return workspaces.flatMap((record) => {
    const id = nonEmptyString(record.workspace_id)
    const projectId = nonEmptyString(record.project_id)
    const root = nonEmptyString(record.root)
    const generation = record.generation
    if (!id || !/^workspace-[0-9a-f]{32}$/u.test(id) || !projectId || !root?.startsWith('/') ||
        typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return []
    return [{ id, projectId, root, generation }]
  })
}

const NO_WORKSPACES: readonly JsonRecord[] = []

function primeTaskSummaries(tasks: readonly JsonRecord[]): PrimeTaskSummary[] {
  const seen = new Set<string>()
  return tasks.flatMap((task) => {
    const id = nonEmptyString(task.id)
    const status = nonEmptyString(task.status)
    const isPrime = task.runtime_id === 'prime' || task.profile === 'prime'
    if (!id || !/^[A-Za-z0-9_-]{1,200}$/u.test(id) || !status || !isPrime || seen.has(id)) return []
    seen.add(id)
    return [{ id, status: status.slice(0, 60) }]
  })
}

function terminal(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'canceled', 'blocked', 'interrupted', 'crashed'].includes(status.toLowerCase())
}

function boundedText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_OUTPUT_LENGTH) : null
}

function detailText(task: TaskRecord): { resultText: string | null; errorText: string | null } {
  const result = isRecord(task.result) ? task.result : null
  return {
    resultText: result ? boundedText(result.text) : null,
    errorText: boundedText(task.error),
  }
}

function eventText(events: readonly TaskEventRecord[]): { resultText: string | null; errorText: string | null } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index].data
    if (!isRecord(data)) continue
    const result = isRecord(data.result) ? data.result : null
    const resultText = result ? boundedText(result.text) : null
    const errorText = boundedText(data.error)
    if (resultText || errorText) return { resultText, errorText }
  }
  return { resultText: null, errorText: null }
}

function activityForEvent(event: TaskEventRecord): TaskActivity | null {
  const data = isRecord(event.data) ? event.data : null
  if (!data) return null
  if (event.type === 'message.delta') {
    return typeof data.text === 'string' && data.text.length > 0
      ? { seq: event.seq, kind: 'assistant', text: data.text.slice(0, MAX_ACTIVITY_ITEM_LENGTH) }
      : null
  }
  if (event.type !== 'tool' || (data.phase !== 'start' && data.phase !== 'end')) return null
  const rawTool = typeof data.tool === 'string' ? data.tool.trim() : ''
  const tool = /^[A-Za-z0-9_.:-]{1,48}$/u.test(rawTool) ? rawTool : 'tool'
  return {
    seq: event.seq,
    kind: 'tool',
    text: `${data.phase === 'start' ? 'Started' : 'Finished'} ${tool}`.slice(0, MAX_ACTIVITY_ITEM_LENGTH),
  }
}

function appendActivity(current: readonly TaskActivity[], events: readonly TaskEventRecord[]): TaskActivity[] {
  const next = [...current]
  for (const event of events) {
    const item = activityForEvent(event)
    if (!item) continue
    const last = next.at(-1)
    if (item.kind === 'assistant' && last?.kind === 'assistant') {
      next[next.length - 1] = { ...last, text: `${last.text}${item.text}`.slice(-MAX_ACTIVITY_ITEM_LENGTH) }
    } else {
      next.push(item)
    }
    while (next.length > MAX_ACTIVITY_ITEMS) next.shift()
    let totalLength = next.reduce((total, entry) => total + entry.text.length, 0)
    while (totalLength > MAX_ACTIVITY_TOTAL_LENGTH && next.length > 0) {
      totalLength -= next.shift()?.text.length ?? 0
    }
  }
  return next
}

function activityFromEvents(events: readonly TaskEventRecord[]): TaskActivity[] {
  return appendActivity([], events)
}

function latestCursor(events: readonly TaskEventRecord[], fallback: number): number {
  return events.reduce((cursor, event) => Math.max(cursor, event.seq), fallback)
}

function recentTaskLabel(task: JsonRecord): string {
  const id = nonEmptyString(task.id) ?? 'Unknown task'
  const status = nonEmptyString(task.status) ?? 'status unavailable'
  return `${id.slice(0, 200)} · ${status.slice(0, 60)}`
}

function sameScope(value: { bridge: DesktopBridge; generation: number } | null | undefined, bridge: DesktopBridge, generation: number): boolean {
  return value?.bridge === bridge && value.generation === generation
}

/** One confirmed remote Prime task at a time; task state remains owned by the server. */
export function PrimeTaskPanel({
  bridge,
  connection,
  projects,
  tasks,
  workspaces = NO_WORKSPACES,
}: {
  bridge: DesktopBridge
  connection: ConnectionDescription
  projects: readonly JsonRecord[]
  tasks: readonly JsonRecord[]
  workspaces?: readonly JsonRecord[]
}) {
  const generation = connection.generation
  const choices = useMemo(() => projectChoices(projects), [projects])
  const checkoutChoices = useMemo(() => workspaceChoices(workspaces), [workspaces])
  const primeTasks = useMemo(() => primeTaskSummaries(tasks), [tasks])
  const scopeSerial = useRef(0)
  const taskCheckVersion = useRef(0)
  const submitLock = useRef(false)
  const openLock = useRef(false)
  const cancelLock = useRef(false)
  const [capability, setCapability] = useState<Capability | null>(null)
  const [draftValue, setDraftValue] = useState<Draft>(() => ({
    bridge,
    generation,
    projectId: choices[0]?.id ?? '',
    prompt: '',
  }))
  const [confirmationValue, setConfirmationValue] = useState<Confirmation | null>(null)
  const [submissionValue, setSubmissionValue] = useState<Submission | null>(null)
  const [taskOpenValue, setTaskOpenValue] = useState<TaskOpenState | null>(null)

  const scopeDraft = sameScope(draftValue, bridge, generation)
    ? draftValue
    : { bridge, generation, projectId: choices[0]?.id ?? '', prompt: '' }
  const currentCapability = sameScope(capability, bridge, generation) ? capability : null
  const confirmation = sameScope(confirmationValue, bridge, generation) ? confirmationValue : null
  const submission = sameScope(submissionValue, bridge, generation) ? submissionValue : null
  const taskOpen = sameScope(taskOpenValue, bridge, generation) ? taskOpenValue : null
  const selectedProject = choices.find((project) => project.id === scopeDraft.projectId) ?? null
  const selectedWorkspace = scopeDraft.workspaceId
    ? checkoutChoices.find((workspace) => workspace.id === scopeDraft.workspaceId && workspace.projectId === selectedProject?.id) ?? null
    : null
  const locked = !!submission || !!confirmation || !!taskOpen?.taskId

  useEffect(() => {
    const requestId = ++scopeSerial.current
    taskCheckVersion.current += 1
    submitLock.current = false
    openLock.current = false
    cancelLock.current = false
    setConfirmationValue(null)
    setSubmissionValue(null)
    setTaskOpenValue(null)
    setDraftValue({ bridge, generation, projectId: choices[0]?.id ?? '', prompt: '' })

    if (!connection.configured || !Number.isSafeInteger(generation) || generation < 0) {
      setCapability({ bridge, generation, state: 'disconnected' })
      return () => {
        if (scopeSerial.current === requestId) scopeSerial.current += 1
      }
    }

    setCapability({ bridge, generation, state: 'loading' })
    void Promise.all([
      bridge.api.invoke('readiness', {}),
      bridge.api.invoke('runtimes.list', {}),
    ]).then(([readiness, runtimes]) => {
      if (scopeSerial.current !== requestId) return
      const prime = runtimes.runtimes.find((runtime) => runtime.id === 'prime')
      let message: string | undefined
      if (readiness.dispatch_ready !== true) {
        message = 'Server dispatch is not ready. Check the connection status before submitting.'
      } else if (!prime || !prime.available) {
        message = 'Prime is unavailable on this server.'
      } else if (!prime.modes.some((mode) => mode.id === 'auto' && mode.restricted === false)) {
        message = 'Prime does not advertise the Trusted execution approval mode.'
      } else if (prime.sandboxed !== false || prime.chat_only !== false) {
        message = 'Prime does not advertise unsandboxed task execution for this connection.'
      }
      setCapability({
        bridge,
        generation,
        state: message ? 'unavailable' : 'ready',
        ...(message ? { message } : {}),
      })
    }).catch(() => {
      if (scopeSerial.current === requestId) {
        setCapability({
          bridge,
          generation,
          state: 'unavailable',
          message: 'Prime task capability could not be checked. Check the server connection and token.',
        })
      }
    })

    return () => {
      if (scopeSerial.current === requestId) scopeSerial.current += 1
    }
  }, [bridge, connection.configured, generation, choices])

  useEffect(() => {
    if (!submission || submission.state !== 'task' || !submission.task || submission.cancelPending || submission.checkingStatus) return
    const task = submission.task
    if (terminal(task.status) || task.polls >= MAX_POLLS) return
    const requestId = scopeSerial.current
    const checkVersion = taskCheckVersion.current
    const timer = setTimeout(() => {
      void Promise.allSettled([
        bridge.api.invoke('tasks.get', { taskId: task.id }),
        bridge.api.invoke('tasks.events', { taskId: task.id, after: task.after }),
      ]).then(([detailResult, eventsResult]) => {
        if (scopeSerial.current !== requestId || taskCheckVersion.current !== checkVersion) return
        const detail = detailResult.status === 'fulfilled' ? detailResult.value.task : null
        const events = eventsResult.status === 'fulfilled' ? eventsResult.value.events : null
        const text = detail ? detailText(detail) : { resultText: null, errorText: null }
        const eventOutput = events ? eventText(events) : { resultText: null, errorText: null }
        setSubmissionValue((current) => {
          if (!current || !sameScope(current, bridge, generation) || current.state !== 'task') return current
          const currentTask = current.task
          if (!currentTask || currentTask.id !== task.id) return current
          return {
            ...current,
            task: {
              ...currentTask,
              status: detail?.status ?? currentTask.status,
              after: events ? latestCursor(events, currentTask.after) : currentTask.after,
              polls: currentTask.polls + 1,
              activity: events ? appendActivity(currentTask.activity, events) : currentTask.activity,
              resultText: text.resultText ?? eventOutput.resultText ?? currentTask.resultText,
              errorText: text.errorText ?? eventOutput.errorText ?? currentTask.errorText,
              statusCheckFailed: !detail,
              eventsCheckFailed: !events,
            },
          }
        })
      })
    }, POLL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [bridge, generation, submission])

  async function reviewSubmission(): Promise<void> {
    if (!selectedProject || (scopeDraft.workspaceId && !selectedWorkspace) || !scopeDraft.prompt.trim() || scopeDraft.prompt.length > 8_000 || currentCapability?.state !== 'ready' || submission || confirmation || openLock.current || taskOpen?.taskId) return
    setConfirmationValue({ ...scopeDraft, project: selectedProject,
      ...(selectedWorkspace ? { workspace: selectedWorkspace } : {}),
    })
  }

  async function openExistingTask(taskId: string): Promise<void> {
    if (!connection.configured || !Number.isSafeInteger(generation) || generation < 0 || submission || confirmation || submitLock.current || openLock.current || taskOpen?.taskId || !primeTasks.some((task) => task.id === taskId)) return
    const requestId = scopeSerial.current
    const checkVersion = ++taskCheckVersion.current
    openLock.current = true
    setTaskOpenValue({ bridge, generation, taskId })
    const [detailResult, eventsResult] = await Promise.allSettled([
      Promise.resolve().then(() => bridge.api.invoke('tasks.get', { taskId })),
      Promise.resolve().then(() => bridge.api.invoke('tasks.events', { taskId, after: 0 })),
    ])
    if (scopeSerial.current !== requestId || taskCheckVersion.current !== checkVersion) return
    openLock.current = false
    if (detailResult.status !== 'fulfilled' || detailResult.value.task.id !== taskId) {
      setTaskOpenValue({ bridge, generation, taskId: null, message: 'Task details could not be confirmed. Check the server connection and try again.' })
      return
    }
    const detail = detailResult.value.task
    const events = eventsResult.status === 'fulfilled' ? eventsResult.value.events : null
    const detailOutput = detailText(detail)
    const eventOutput = events ? eventText(events) : { resultText: null, errorText: null }
    setSubmissionValue((current) => current ?? {
      bridge,
      generation,
      project: { id: '', name: 'Existing server task', primaryPath: '' },
      prompt: '',
      state: 'task',
      task: {
        id: detail.id,
        status: detail.status,
        after: events ? latestCursor(events, 0) : 0,
        polls: 0,
        activity: events ? activityFromEvents(events) : [],
        resultText: detailOutput.resultText ?? eventOutput.resultText,
        errorText: detailOutput.errorText ?? eventOutput.errorText,
        statusCheckFailed: false,
        eventsCheckFailed: !events,
      },
    })
    setTaskOpenValue(null)
  }

  async function runConfirmedTask(): Promise<void> {
    if (!confirmation || submitLock.current || openLock.current || submission) return
    const frozen = confirmation
    const requestId = scopeSerial.current
    submitLock.current = true
    setConfirmationValue(null)
    setSubmissionValue({
      bridge,
      generation,
      project: frozen.project,
      prompt: frozen.prompt,
      state: 'submitting',
    })
    try {
      const result = await bridge.api.invoke('tasks.submit', {
        projectId: frozen.project.id,
        prompt: frozen.prompt,
        ...(frozen.workspace ? {
          workspaceId: frozen.workspace.id, workspaceGeneration: frozen.workspace.generation,
        } : {}),
      })
      if (scopeSerial.current !== requestId) return
      const output = detailText(result.task)
      setSubmissionValue({
        bridge,
        generation,
        project: frozen.project,
        prompt: frozen.prompt,
        state: 'task',
        task: {
          id: result.task.id,
          status: result.task.status,
          after: 0,
          polls: 0,
          activity: [],
          resultText: output.resultText,
          errorText: output.errorText,
          statusCheckFailed: false,
          eventsCheckFailed: false,
        },
      })
    } catch {
      if (scopeSerial.current === requestId) {
        setSubmissionValue({
          bridge,
          generation,
          project: frozen.project,
          prompt: frozen.prompt,
          state: 'unknown',
          recentTasks: null,
        })
      }
    } finally {
      if (scopeSerial.current === requestId) submitLock.current = false
    }
  }

  async function checkRecentTasks(): Promise<void> {
    if (!submission || submission.state !== 'unknown' || submission.checkingRecent) return
    const requestId = scopeSerial.current
    setSubmissionValue({ ...submission, checkingRecent: true, recentTasksFailed: false })
    try {
      const result = await bridge.api.invoke('tasks.list', {})
      if (scopeSerial.current !== requestId) return
      setSubmissionValue((current) => {
        if (!current || !sameScope(current, bridge, generation) || current.state !== 'unknown') return current
        return { ...current, checkingRecent: false, recentTasks: result.tasks.slice(0, MAX_RECENT_TASKS), recentTasksFailed: false }
      })
    } catch {
      if (scopeSerial.current === requestId) {
        setSubmissionValue((current) => {
          if (!current || !sameScope(current, bridge, generation) || current.state !== 'unknown') return current
          return { ...current, checkingRecent: false, recentTasksFailed: true }
        })
      }
    }
  }

  function startNewTask(): void {
    if (!submission || (submission.state === 'unknown' && submission.recentTasks === null)) return
    setSubmissionValue(null)
    setConfirmationValue(null)
    setDraftValue({ bridge, generation, projectId: choices[0]?.id ?? '', prompt: '' })
  }

  async function checkTaskStatus(): Promise<void> {
    if (!submission || submission.state !== 'task' || !submission.task || submission.cancelPending || submission.checkingStatus) return
    const taskId = submission.task.id
    const requestId = scopeSerial.current
    const checkVersion = ++taskCheckVersion.current
    setSubmissionValue({ ...submission, checkingStatus: true })
    const [detailResult, eventsResult] = await Promise.allSettled([
      bridge.api.invoke('tasks.get', { taskId }),
      bridge.api.invoke('tasks.events', { taskId, after: submission.task.after }),
    ])
    if (scopeSerial.current !== requestId || taskCheckVersion.current !== checkVersion) return
    const detail = detailResult.status === 'fulfilled' ? detailResult.value.task : null
    const events = eventsResult.status === 'fulfilled' ? eventsResult.value.events : null
    const text = detail ? detailText(detail) : { resultText: null, errorText: null }
    const eventOutput = events ? eventText(events) : { resultText: null, errorText: null }
    setSubmissionValue((current) => {
      if (!current || !sameScope(current, bridge, generation) || current.state !== 'task') return current
      const currentTask = current.task
      if (!currentTask || currentTask.id !== taskId) return current
      return {
        ...current,
        checkingStatus: false,
        task: {
          ...currentTask,
          status: detail?.status ?? currentTask.status,
          after: events ? latestCursor(events, currentTask.after) : currentTask.after,
          activity: events ? appendActivity(currentTask.activity, events) : currentTask.activity,
          resultText: text.resultText ?? eventOutput.resultText ?? currentTask.resultText,
          errorText: text.errorText ?? eventOutput.errorText ?? currentTask.errorText,
          statusCheckFailed: !detail,
          eventsCheckFailed: !events,
        },
      }
    })
  }

  async function cancelTask(): Promise<void> {
    if (!submission || submission.state !== 'task' || !submission.task || submission.cancelPending || submission.checkingStatus || terminal(submission.task.status) || cancelLock.current) return
    const taskId = submission.task.id
    const requestId = scopeSerial.current
    const checkVersion = ++taskCheckVersion.current
    cancelLock.current = true
    setSubmissionValue({ ...submission, cancelPending: true, cancelNotice: undefined })
    let cancelRequestFailed = false
    try {
      await bridge.api.invoke('tasks.cancel', { taskId })
    } catch {
      cancelRequestFailed = true
    }

    if (scopeSerial.current !== requestId || taskCheckVersion.current !== checkVersion) return
    const [detailResult, eventsResult] = await Promise.allSettled([
      bridge.api.invoke('tasks.get', { taskId }),
      bridge.api.invoke('tasks.events', { taskId, after: submission.task.after }),
    ])
    if (scopeSerial.current !== requestId || taskCheckVersion.current !== checkVersion) return
    const detail = detailResult.status === 'fulfilled' ? detailResult.value.task : null
    const events = eventsResult.status === 'fulfilled' ? eventsResult.value.events : null
    const text = detail ? detailText(detail) : { resultText: null, errorText: null }
    const eventOutput = events ? eventText(events) : { resultText: null, errorText: null }
    setSubmissionValue((current) => {
      if (!current || !sameScope(current, bridge, generation) || current.state !== 'task') return current
      const currentTask = current.task
      if (!currentTask || currentTask.id !== taskId) return current
      return {
        ...current,
        cancelPending: false,
        cancelNotice: !detail
          ? cancelRequestFailed
            ? 'Cancellation outcome and server status could not be confirmed. The displayed status may be stale.'
            : 'Cancellation was acknowledged, but the server status could not be confirmed. The displayed status may be stale.'
          : cancelRequestFailed
            ? 'Cancellation outcome was unclear; the status below is the server readback.'
            : undefined,
        task: {
          ...currentTask,
          status: detail?.status ?? currentTask.status,
          after: events ? latestCursor(events, currentTask.after) : currentTask.after,
          activity: events ? appendActivity(currentTask.activity, events) : currentTask.activity,
          resultText: text.resultText ?? eventOutput.resultText ?? currentTask.resultText,
          errorText: text.errorText ?? eventOutput.errorText ?? currentTask.errorText,
          statusCheckFailed: !detail,
          eventsCheckFailed: !events,
        },
      }
    })
    cancelLock.current = false
  }

  const capabilityState = currentCapability?.state
    ?? (!connection.configured ? 'disconnected' : 'loading')
  const status = submission?.state === 'task' ? submission.task?.status : null
  const isTerminal = status ? terminal(status) : false

  return <section className="prime-task-panel" aria-label="Remote Prime task">
    <div className="prime-task-heading">
      <div><span className="prime-task-eyebrow">SERVER EXECUTION</span><h3>Run a Prime task</h3></div>
      <span className={`prime-task-state state-${capabilityState}`} role="status">
        {capabilityState === 'ready' ? 'Prime ready' : capabilityState === 'loading' ? 'Checking Prime' : capabilityState === 'disconnected' ? 'Disconnected' : 'Unavailable'}
      </span>
    </div>

    {capabilityState === 'loading' && <p className="prime-task-message">Checking server readiness and the advertised Prime runtime…</p>}
    {capabilityState === 'disconnected' && <p className="prime-task-message">Connect to a server before creating a task.</p>}
    {capabilityState === 'unavailable' && <p className="prime-task-message" role="alert">{currentCapability?.message ?? 'Prime task capability is unavailable.'}</p>}

    <div className="prime-task-history">
      <div className="prime-task-history-heading"><strong>Returned Prime tasks</strong><span>{primeTasks.length} returned</span></div>
      {taskOpen?.message && <p className="prime-task-hint" role="alert">{taskOpen.message}</p>}
      {primeTasks.length === 0
        ? <p className="prime-task-hint">No returned server task is marked as Prime.</p>
        : <>
          <ul>
            {primeTasks.map((task) => <li key={task.id}>
              <span><code>{task.id}</code><small>{task.status}</small></span>
              <button type="button" onClick={() => { void openExistingTask(task.id) }} disabled={!!submission || !!confirmation || !!taskOpen?.taskId}>
                {taskOpen?.taskId === task.id ? 'Opening…' : 'Open details'}
              </button>
            </li>)}
          </ul>
        </>}
    </div>

    {capabilityState === 'ready' && <>
      <form className="prime-task-form" onSubmit={(event) => { event.preventDefault(); void reviewSubmission() }}>
        <label htmlFor="prime-task-project">Project</label>
        <select
          id="prime-task-project"
          value={selectedProject?.id ?? ''}
          onChange={(event) => setDraftValue({ bridge, generation, projectId: event.currentTarget.value, prompt: scopeDraft.prompt })}
          disabled={locked || !choices.length}
        >
          <option value="">{choices.length ? 'Choose a project' : 'No executable projects available'}</option>
          {choices.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.primaryPath}</option>)}
        </select>
        {!choices.length && <p className="prime-task-hint">No returned project has a usable primary path, so task submission is unavailable.</p>}

        <label htmlFor="prime-task-workspace">Execution location</label>
        <select
          id="prime-task-workspace"
          value={scopeDraft.workspaceId ?? ''}
          onChange={(event) => setDraftValue({ ...scopeDraft, workspaceId: event.currentTarget.value || undefined })}
          disabled={locked || !selectedProject}
        >
          <option value="">Registered project source</option>
          {checkoutChoices.filter((workspace) => workspace.projectId === selectedProject?.id).map((workspace) =>
            <option key={workspace.id} value={workspace.id}>Checkout {workspace.id.slice(-8)} · Generation {workspace.generation} · {workspace.root}</option>)}
        </select>

        <label htmlFor="prime-task-prompt">Prompt</label>
        <textarea
          id="prime-task-prompt"
          value={scopeDraft.prompt}
          onChange={(event) => setDraftValue({ ...scopeDraft, prompt: event.currentTarget.value })}
          maxLength={8_000}
          rows={5}
          placeholder="Describe the work for Prime…"
          disabled={locked}
        />
        <div className="prime-task-form-footer">
          <span>{scopeDraft.prompt.length.toLocaleString()} / 8,000 characters</span>
          <button type="submit" disabled={locked || !selectedProject || (scopeDraft.workspaceId !== undefined && !selectedWorkspace) || !scopeDraft.prompt.trim()}>Review task</button>
        </div>
      </form>
    </>}

    {confirmation && <div className="prime-task-confirm-backdrop">
      <section className="prime-task-confirm" role="dialog" aria-modal="true" aria-labelledby="prime-task-confirm-title">
        <div className="prime-task-confirm-heading"><span>CONFIRM SERVER TASK</span><h4 id="prime-task-confirm-title">Review before running</h4></div>
        <dl>
          <dt>Server</dt><dd>{connection.serverUrl ?? 'Server URL unavailable'}</dd>
          <dt>Project</dt><dd>{confirmation.project.name}</dd>
          <dt>Execution location</dt><dd>{confirmation.workspace ? `Checkout ${confirmation.workspace.id} · Generation ${confirmation.workspace.generation}` : 'Registered project source'}</dd>
          <dt>Path at last load</dt><dd className="prime-task-path">{confirmation.workspace?.root ?? confirmation.project.primaryPath}</dd>
          <dt>Prompt</dt><dd className="prime-task-confirm-prompt">{confirmation.prompt}</dd>
        </dl>
        <p className="prime-task-warning">Trusted execution is unsandboxed and may edit files or run commands in this {confirmation.workspace ? 'checkout' : 'project'}. The server rechecks the selected location when accepting and starting the task; the path above is a snapshot. Provider credentials and native conformance are unverified.</p>
        <div className="prime-task-confirm-actions">
          <button type="button" onClick={() => setConfirmationValue(null)}>Go back</button>
          <button className="prime-task-run" type="button" onClick={() => { void runConfirmedTask() }}>Run with Trusted execution</button>
        </div>
      </section>
    </div>}

    {submission?.state === 'submitting' && <p className="prime-task-message" role="status">Submitting once to {connection.serverUrl}…</p>}
    {submission?.state === 'unknown' && <div className="prime-task-result unknown" role="alert">
      <strong>Submission outcome unknown</strong>
      <p>The server may have accepted this task. This panel will not submit it again automatically.</p>
      <button type="button" onClick={() => { void checkRecentTasks() }} disabled={submission.checkingRecent}>
        {submission.checkingRecent ? 'Checking recent tasks…' : 'Check recent tasks'}
      </button>
      {submission.recentTasksFailed && <p>Recent tasks could not be read. Check the server connection and token.</p>}
      {submission.recentTasks && <ul aria-label="Recent server tasks">
        {submission.recentTasks.map((task, index) => <li key={nonEmptyString(task.id) ?? `recent-${index}`}>{recentTaskLabel(task)}</li>)}
        {submission.recentTasks.length === 0 && <li>No tasks were returned.</li>}
      </ul>}
    </div>}

    {submission?.state === 'task' && submission.task && <div className="prime-task-result">
      <div className="prime-task-result-heading"><strong>SERVER task</strong><span className={`task-status status-${status?.toLowerCase().replace(/[^a-z0-9_-]/g, '') ?? 'unknown'}`} role="status">{status ?? 'Unknown status'}</span></div>
      <p className="prime-task-id">Task ID <code>{submission.task.id}</code></p>
      {submission.cancelPending && <p className="prime-task-hint" role="status">Sending cancellation and reading the current server status…</p>}
      {submission.cancelNotice && <p className="prime-task-hint" role="alert">{submission.cancelNotice}</p>}
      {submission.task.statusCheckFailed && <p className="prime-task-hint" role="alert">Task status could not be refreshed; the displayed status may be stale.</p>}
      {submission.task.eventsCheckFailed && <p className="prime-task-hint" role="alert">Task events could not be refreshed. Status is shown from the task record.</p>}
      {submission.task.polls >= MAX_POLLS && !isTerminal && <p className="prime-task-hint">Automatic status checks paused after {MAX_POLLS} attempts. The task may still be running.</p>}
      <div className="prime-task-activity">
        <strong>Recent activity</strong>
        {submission.task.activity.length
          ? <ol aria-label="Recent task activity">
            {submission.task.activity.map((item) => <li key={`${item.seq}-${item.kind}`}>
              {item.kind === 'assistant' && <small>Assistant</small>}
              <span>{item.text}</span>
            </li>)}
          </ol>
          : <p>No activity yet.</p>}
      </div>
      {submission.task.resultText && <div className="prime-task-output"><strong>Result</strong><pre>{submission.task.resultText}</pre></div>}
      {submission.task.errorText && <div className="prime-task-output task-error"><strong>Server error</strong><pre>{submission.task.errorText}</pre></div>}
      {submission.task.polls >= MAX_POLLS && !isTerminal && <button type="button" onClick={() => { void checkTaskStatus() }} disabled={submission.checkingStatus || submission.cancelPending}>
        {submission.checkingStatus ? 'Checking server status…' : 'Check status'}
      </button>}
      {!isTerminal && <button type="button" className="prime-task-cancel" onClick={() => { void cancelTask() }} disabled={submission.cancelPending || submission.checkingStatus}>
        {submission.cancelPending ? 'Checking cancellation…' : 'Cancel task'}
      </button>}
      {isTerminal && <button type="button" onClick={startNewTask}>New task</button>}
    </div>}

    {submission?.state === 'unknown' && submission.recentTasks !== null && <div className="prime-task-next-action">
      <p>Starting a new task could duplicate work if the server accepted the previous request.</p>
      <button type="button" onClick={startNewTask}>Start new task</button>
    </div>}
  </section>
}
