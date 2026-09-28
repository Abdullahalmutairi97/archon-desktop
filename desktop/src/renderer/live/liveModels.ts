/**
 * Renderer view models for live server conversations.
 *
 * Every row is projected from a validated bridge result. Server identities are
 * kept as opaque ids; nothing here matches a local Codex or server record by
 * title, and unknown or missing ownership facts stay unverified.
 */
import type { JsonRecord, RuntimeRecord, SessionMessageRecord, TaskEventRecord, TaskRecord } from '../../shared/bridge/types'
import { normalizeTaskView, type TaskView } from '../../shared/domain/queue'

export type LiveRuntime = 'prime' | 'pi'

export type LiveProject = {
  id: string
  name: string
  primaryPath: string | null
}

export type LiveSession = {
  id: string
  title: string
  preview: string | null
  runtime: LiveRuntime | null
  projectId: string | null
  /** Epoch seconds, or null when the server gave no usable time. */
  lastActive: number | null
  messageCount: number | null
  /** The server reports a queued, running or cancelling task in this conversation. */
  active: boolean
  readOnly: boolean
  ownership: 'verified' | 'review_required' | 'unverified'
  ownershipReason: string | null
}

export type TranscriptEntry = {
  key: string
  role: 'user' | 'assistant' | 'other'
  kind: string
  /** User and assistant text is shown in full; reasoning and tool records are collapsed. */
  primary: boolean
  label: string
  content: string
  hiddenCharacters: number
  timestamp: number
}

export type LiveTask = {
  id: string
  /** The server's own status string, kept for readback; labels come from `view`. */
  rawStatus: string
  view: TaskView
  statusLabel: string
  recoveryLabel: string | null
  runtime: LiveRuntime | null
  sessionId: string | null
  prompt: string | null
  error: string | null
}

export type RuntimeChoice = {
  id: LiveRuntime
  label: string
}

export type TrackedTask = {
  id: string
  status: string
  sessionId: string | null
  after: number
  polls: number
  replyText: string
  toolNote: string | null
  diagnostic: string | null
  resultText: string | null
  errorText: string | null
  statusCheckFailed: boolean
  eventsCheckFailed: boolean
}

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu
const MAX_TITLE_LENGTH = 160
const MAX_PREVIEW_LENGTH = 240
const MAX_REASON_LENGTH = 500
const MAX_PRIMARY_CHARACTERS = 20_000
const MAX_SECONDARY_CHARACTERS = 4_000
const MAX_REPLY_CHARACTERS = 8_000
const MAX_OUTPUT_CHARACTERS = 8_000
const MAX_NOTE_CHARACTERS = 200
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'blocked', 'interrupted', 'crashed'])

export function isServerId(value: unknown): value is string {
  return typeof value === 'string' && SERVER_ID_PATTERN.test(value)
}

/** Single-line display text: control characters removed, whitespace trimmed, length bounded. */
export function displayLine(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function projectId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : null
}

function positiveSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function liveProjects(rows: readonly JsonRecord[]): LiveProject[] {
  const seen = new Set<string>()
  return rows.flatMap((row) => {
    const id = projectId(row.id)
    if (!id || seen.has(id)) return []
    seen.add(id)
    const path = typeof row.primary_path === 'string' && row.primary_path.startsWith('/') ? displayLine(row.primary_path, 1_000) : null
    return [{ id, name: displayLine(row.name, MAX_TITLE_LENGTH) ?? id, primaryPath: path }]
  })
}

export function liveSessions(rows: readonly JsonRecord[]): LiveSession[] {
  const seen = new Set<string>()
  return rows.flatMap((row) => {
    if (!isServerId(row.id) || seen.has(row.id)) return []
    seen.add(row.id)
    const ambiguous = row.project_ownership_ambiguous === true
    const ownership = ambiguous || row.ownership_state === 'review_required'
      ? 'review_required'
      : row.ownership_state === 'verified' ? 'verified' : 'unverified'
    const messageCount = typeof row.message_count === 'number' && Number.isSafeInteger(row.message_count) && row.message_count >= 0
      ? row.message_count : null
    return [{
      id: row.id,
      title: displayLine(row.title, MAX_TITLE_LENGTH) ?? 'Untitled conversation',
      preview: displayLine(row.preview, MAX_PREVIEW_LENGTH),
      runtime: ownership === 'verified' && (row.runtime === 'prime' || row.runtime === 'pi') ? row.runtime : null,
      projectId: projectId(row.project_id),
      lastActive: positiveSeconds(row.last_active),
      messageCount,
      active: row.active === true,
      // Fail closed: only an explicit `false` from the server allows writing.
      readOnly: row.read_only !== false || row.id.startsWith('pi-native-'),
      ownership,
      ownershipReason: displayLine(row.ownership_reason, MAX_REASON_LENGTH),
    }]
  })
}

export function runtimeLabel(runtime: LiveRuntime | null): string {
  return runtime === 'prime' ? 'Prime' : runtime === 'pi' ? 'Pi' : 'Runtime unverified'
}

/** Why a conversation cannot be continued from this client, independent of in-flight work. */
export function continuationBlocker(session: LiveSession): string | null {
  if (session.readOnly) {
    return 'This conversation is read-only on the server. Start a new conversation to keep working.'
  }
  if (session.ownership === 'review_required') {
    return `Server ownership of this conversation requires review${session.ownershipReason ? `: ${session.ownershipReason}` : '.'} It cannot be continued from here.`
  }
  if (session.ownership !== 'verified' || session.runtime === null) {
    return 'The server has not verified which runtime owns this conversation, so it cannot be continued from here.'
  }
  return null
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function formatEpochSeconds(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'Time unavailable'
  const date = new Date(seconds * 1_000)
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : dateFormat.format(date)
}

function secondaryLabel(kind: string): string {
  switch (kind) {
    case 'thinking': return 'Reasoning'
    case 'tool': return 'Tool call'
    case 'tool_result': return 'Tool result'
    case 'native': return 'Native record'
    default: return `Other record (${kind.slice(0, 64)})`
  }
}

export function transcriptEntries(messages: readonly SessionMessageRecord[], runtime: LiveRuntime | null): TranscriptEntry[] {
  return messages.map((message, index) => {
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'other'
    const primary = role !== 'other' && message.kind === 'text'
    const limit = primary ? MAX_PRIMARY_CHARACTERS : MAX_SECONDARY_CHARACTERS
    const label = primary
      ? role === 'user' ? 'You' : runtime ? runtimeLabel(runtime) : 'Assistant'
      : secondaryLabel(message.kind)
    return {
      key: `${index}:${message.id}`,
      role,
      kind: message.kind,
      primary,
      label,
      content: message.content.slice(0, limit),
      hiddenCharacters: Math.max(0, message.content.length - limit),
      timestamp: message.timestamp,
    }
  })
}

export function taskStatusLabel(view: TaskView): string {
  switch (view.status) {
    case 'running': return 'Running'
    case 'cancel_requested': return 'Cancelling'
    case 'queued': return 'Queued'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'blocked': return 'Blocked'
    case 'cancelled': return 'Cancelled'
    case 'interrupted': return 'Interrupted'
    case 'crashed': return 'Crashed'
    default: return 'Unknown status'
  }
}

function recoveryLabel(view: TaskView): string | null {
  switch (view.recoveryState) {
    case 'review_required': return 'Review required'
    case 'unknown': return 'Recovery unknown'
    case 'retryable': return 'Automatic retry'
    default: return null
  }
}

export function liveTasks(rows: readonly JsonRecord[]): LiveTask[] {
  const seen = new Set<string>()
  return rows.flatMap((row) => {
    let view: TaskView
    try {
      view = normalizeTaskView(row)
    } catch {
      return []
    }
    if (!isServerId(view.id) || seen.has(view.id)) return []
    seen.add(view.id)
    const runtime = row.runtime_id === 'prime' || row.runtime_id === 'pi'
      ? row.runtime_id
      : row.runtime_id == null && (row.profile === 'prime' || row.profile === 'pi') ? row.profile : null
    return [{
      id: view.id,
      rawStatus: typeof row.status === 'string' && row.status.length <= 64 ? row.status : 'unknown',
      view,
      statusLabel: taskStatusLabel(view),
      recoveryLabel: recoveryLabel(view),
      runtime,
      sessionId: isServerId(row.session_id) ? row.session_id : null,
      prompt: displayLine(row.prompt, MAX_PREVIEW_LENGTH),
      error: displayLine(row.error, MAX_REASON_LENGTH),
    }]
  })
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status.toLowerCase())
}

/** Only runtimes the server reports as available; version facts stay labeled as unverified. */
export function runtimeChoices(runtimes: readonly RuntimeRecord[]): RuntimeChoice[] {
  const seen = new Set<string>()
  return runtimes.flatMap((runtime) => {
    if (!runtime.available || seen.has(runtime.id)) return []
    seen.add(runtime.id)
    const version = runtime.version_verified ? displayLine(runtime.version, 64) : null
    return [{ id: runtime.id, label: `${runtimeLabel(runtime.id)} · ${version ? `version ${version}` : 'version unverified'}` }]
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedOutput(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.slice(0, MAX_OUTPUT_CHARACTERS) : null
}

function recordOutput(task: TaskRecord): { resultText: string | null; errorText: string | null } {
  return {
    resultText: isPlainRecord(task.result) ? boundedOutput(task.result.text) : null,
    errorText: boundedOutput(task.error),
  }
}

export function trackTask(task: TaskRecord): TrackedTask {
  const output = recordOutput(task)
  return {
    id: task.id,
    status: task.status,
    sessionId: isServerId(task.session_id) ? task.session_id : null,
    after: 0,
    polls: 0,
    replyText: '',
    toolNote: null,
    diagnostic: null,
    ...output,
    statusCheckFailed: false,
    eventsCheckFailed: false,
  }
}

/**
 * Fold one status/event readback into a tracked task. Streaming text is only
 * `message.delta` output; tool events show their sanitized name, never their
 * arguments or output, and unreadable records are shown as diagnostics.
 */
export function advanceTask(
  current: TrackedTask,
  detail: TaskRecord | null,
  events: readonly TaskEventRecord[] | null,
  countPoll: boolean,
): TrackedTask {
  let { replyText, toolNote, diagnostic, after } = current
  let eventResult: string | null = null
  let eventError: string | null = null
  for (const event of events ?? []) {
    after = Math.max(after, event.seq)
    const data = isPlainRecord(event.data) ? event.data : null
    if (!data) continue
    if (event.type === 'message.delta' && typeof data.text === 'string') {
      replyText = `${replyText}${data.text}`.slice(-MAX_REPLY_CHARACTERS)
    } else if (event.type === 'tool' && (data.phase === 'start' || data.phase === 'end')) {
      const rawTool = typeof data.tool === 'string' ? data.tool.trim() : ''
      const tool = /^[A-Za-z0-9_.:-]{1,48}$/u.test(rawTool) ? rawTool : 'tool'
      toolNote = `${data.phase === 'start' ? 'Started' : 'Finished'} ${tool}`
    } else if (event.type === 'diagnostic' && typeof data.detail === 'string' && data.detail.trim()) {
      diagnostic = `Unreadable runtime output: ${data.detail.trim()}`.slice(0, MAX_NOTE_CHARACTERS)
    }
    const result = isPlainRecord(data.result) ? boundedOutput(data.result.text) : null
    if (result) eventResult = result
    const error = boundedOutput(data.error)
    if (error) eventError = error
  }
  const output = detail ? recordOutput(detail) : { resultText: null, errorText: null }
  return {
    ...current,
    status: detail?.status ?? current.status,
    sessionId: current.sessionId ?? (detail && isServerId(detail.session_id) ? detail.session_id : null),
    after,
    polls: current.polls + (countPoll ? 1 : 0),
    replyText,
    toolNote,
    diagnostic,
    resultText: output.resultText ?? eventResult ?? current.resultText,
    errorText: output.errorText ?? eventError ?? current.errorText,
    statusCheckFailed: !detail,
    eventsCheckFailed: !events,
  }
}

/** Error codes survive only for in-process fakes; Electron IPC keeps the message, so callers fall back. */
export function operationErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')
    return code && 'value' in code && typeof code.value === 'string' ? code.value : null
  } catch {
    return null
  }
}
