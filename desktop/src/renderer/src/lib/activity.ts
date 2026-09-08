import type { TaskEvent } from './types'

/** Guard events crossing the network boundary before they update UI state/cursors. */
export function readEventCursor(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 0
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) ? cursor : 0
}

export function isTaskEvent(value: unknown): value is TaskEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) return false
  if (typeof event.type !== 'string' || event.type.length === 0) return false
  if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) return false
  if (event.task_id !== undefined && typeof event.task_id !== 'string') return false
  if (event.created_at !== undefined && typeof event.created_at !== 'string') return false
  return true
}

export function mergeActivityEvents(existing: TaskEvent[], incoming: unknown[], limit = 100): TaskEvent[] {
  const bySequence = new Map<number, TaskEvent>()
  for (const event of [...existing, ...incoming]) {
    if (isTaskEvent(event)) bySequence.set(event.seq, event)
  }
  return Array.from(bySequence.values()).sort((a, b) => b.seq - a.seq).slice(0, limit)
}
