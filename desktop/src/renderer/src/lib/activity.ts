import type { TaskEvent } from './types'

export function mergeActivityEvents(existing: TaskEvent[], incoming: TaskEvent[], limit = 100): TaskEvent[] {
  const bySequence = new Map<number, TaskEvent>()
  for (const event of [...existing, ...incoming]) bySequence.set(event.seq, event)
  return Array.from(bySequence.values()).sort((a, b) => b.seq - a.seq).slice(0, limit)
}
