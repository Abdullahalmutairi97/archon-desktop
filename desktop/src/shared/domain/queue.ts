/**
 * Queue and recovery projections for renderer view models.
 *
 * Origin: pure `ArchonQueueCounts`, `ArchonQueueLabel`, and `ArchonQueueData`
 * helpers in `current/queue-status-patch.cjs` (SHA-256
 * 8a2fed89124d5a5e996c0f61448ca569f28fa7ec697287c4f9e184b35d44ceb2).
 * Transformation: release `state` values and P1 durable `status`/attempt
 * fields normalize into a typed `TaskView`; UI summaries remain derived from
 * tasks and never treat a session's `active` flag as execution evidence.
 */

import { isRuntimeId, type RuntimeId } from "./identity";

export type TaskStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted"
  | "crashed"
  | "unknown";

export type RecoveryState = "none" | "review_required" | "retryable" | "unknown";

export interface TaskView {
  /** Durable server task id or explicitly namespaced local task id. */
  id: string;
  status: TaskStatus;
  sessionId?: string;
  projectId?: string;
  runtimeId?: RuntimeId;
  currentAttemptId?: string;
  recoveryState: RecoveryState;
}

export interface QueueSessionView {
  id: string;
  projectId?: string | null;
  state?: string;
  [field: string]: unknown;
}

export interface QueueProjectView {
  id: string;
  [field: string]: unknown;
}

export interface QueueData {
  tasks: readonly TaskView[];
  sessions: readonly QueueSessionView[];
  projects: readonly QueueProjectView[];
  host?: Readonly<Record<string, unknown>>;
  [field: string]: unknown;
}

export interface QueueCounts {
  running: number;
  queued: number;
}

export interface DerivedQueueData extends Omit<QueueData, "tasks" | "sessions" | "projects" | "host"> {
  tasks: readonly TaskView[];
  sessions: QueueSessionView[];
  projects: QueueProjectView[];
  host: Record<string, unknown> & QueueCounts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(nonEmptyString) as string | undefined;
}

function recoveryFrom(value: Record<string, unknown>): RecoveryState {
  const direct = isRecord(value.recovery) ? value.recovery : undefined;
  let recovery = direct;
  if (!recovery && isRecord(value.result) && isRecord(value.result.recovery)) recovery = value.result.recovery;
  if (!recovery && typeof value.result_json === "string") {
    try {
      const result: unknown = JSON.parse(value.result_json);
      if (isRecord(result) && isRecord(result.recovery)) recovery = result.recovery;
    } catch {
      return "unknown";
    }
  }
  if (!recovery) return "none";
  if (recovery.review_required === true) return "review_required";
  if (recovery.automatic_retry === true) return "retryable";
  return "unknown";
}

function normalizeStatus(value: unknown, recoveryState: RecoveryState): TaskStatus {
  if (typeof value !== "string") return "unknown";
  switch (value.toLowerCase()) {
    case "queued":
      return "queued";
    case "running":
    case "working":
      return "running";
    case "cancelling":
    case "cancel_requested":
      return "cancel_requested";
    case "completed":
    case "finished":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "blocked":
      return "blocked";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "crashed":
      return "crashed";
    case "review_required":
      return recoveryState === "none" ? "interrupted" : "failed";
    default:
      return "unknown";
  }
}

/** Normalize P1 backend records and legacy queue-state records at the boundary. */
export function normalizeTaskView(input: unknown): TaskView {
  if (!isRecord(input)) throw new TypeError("Invalid task view");
  const nested = isRecord(input.task) ? input.task : isRecord(input.data) && isRecord(input.data.task) ? input.data.task : input;
  const id = firstString(nested.id, nested.task_id, input.id, input.task_id);
  if (!id) throw new TypeError("Task view requires a durable id");
  const recoveryState = recoveryFrom(nested);
  const status = normalizeStatus(nested.status ?? nested.state ?? input.status ?? input.state, recoveryState);
  const sessionId = firstString(nested.sessionId, nested.session_id, input.sessionId, input.session_id);
  const projectId = firstString(nested.projectId, nested.project_id, input.projectId, input.project_id);
  const runtime = nested.runtimeId ?? nested.runtime_id ?? nested.runtime ?? input.runtimeId ?? input.runtime_id ?? input.runtime;
  const attempt = firstString(nested.currentAttemptId, nested.current_attempt_id, input.currentAttemptId, input.current_attempt_id);
  return {
    id,
    status,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(isRuntimeId(runtime) ? { runtimeId: runtime } : {}),
    ...(attempt === undefined ? {} : { currentAttemptId: attempt }),
    recoveryState,
  };
}

function hasReviewRequiredRecovery(task: TaskView): boolean {
  return task.recoveryState === "review_required" || task.recoveryState === "unknown";
}

export function queueCounts(tasks: readonly TaskView[]): QueueCounts {
  let running = 0;
  let queued = 0;
  for (const task of tasks) {
    if (hasReviewRequiredRecovery(task)) continue;
    if (task.status === "running" || task.status === "cancel_requested") running += 1;
    else if (task.status === "queued") queued += 1;
  }
  return { running, queued };
}

export function queueLabel(tasks: readonly TaskView[]): string {
  const { running, queued } = queueCounts(tasks);
  return `${running} running${queued ? ` · ${queued} queued` : ""}`;
}

function sessionState(task: TaskView, fallback: string | undefined): string | undefined {
  if (hasReviewRequiredRecovery(task)) return "review";
  switch (task.status) {
    case "running":
    case "cancel_requested":
      return "working";
    case "queued":
      return "queued";
    case "failed":
    case "blocked":
    case "crashed":
    case "interrupted":
      return "error";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "unknown";
    default:
      return fallback;
  }
}

/** Derive session, project and host summaries without changing source records. */
export function deriveQueueData(data: QueueData): DerivedQueueData {
  const bySession = new Map<string, TaskView[]>();
  for (const task of data.tasks) {
    if (!task.sessionId) continue;
    const rows = bySession.get(task.sessionId) || [];
    rows.push(task);
    bySession.set(task.sessionId, rows);
  }

  const sessions = data.sessions.map((session) => {
    const tasks = bySession.get(session.id);
    if (!tasks?.length) return session;
    const active = tasks.find((task) => task.status === "running" || task.status === "cancel_requested")
      || tasks.find((task) => task.status === "queued");
    const selected = active || tasks[0];
    const state = sessionState(selected, typeof session.state === "string" ? session.state : undefined);
    return state === session.state ? session : { ...session, ...(state === undefined ? {} : { state }) };
  });

  const byProject = new Map<string, TaskView[]>();
  for (const session of sessions) {
    if (typeof session.projectId !== "string" || !session.projectId) continue;
    const rows = byProject.get(session.projectId) || [];
    rows.push(...(bySession.get(session.id) || []));
    byProject.set(session.projectId, rows);
  }

  return {
    ...data,
    tasks: data.tasks,
    sessions,
    projects: data.projects.map((project) => ({
      ...project,
      ...queueCounts(byProject.get(project.id) || []),
    })),
    host: { ...(data.host || {}), ...queueCounts(data.tasks) },
  };
}
