import { describe, expect, it } from 'vitest'
import { isTaskEvent, mergeActivityEvents, readEventCursor } from './activity'

describe('mergeActivityEvents', () => {
  it('deduplicates replayed events and keeps newest sequence first', () => {
    const existing = [{ seq: 2, type:'task.running', data:{}, task_id:'a' }]
    const replay = [{ seq: 1, type:'task.queued', data:{}, task_id:'a' }, { seq:2, type:'task.running', data:{}, task_id:'a' }, { seq:3, type:'task.completed', data:{}, task_id:'a' }]
    expect(mergeActivityEvents(existing, replay).map((event) => event.seq)).toEqual([3,2,1])
  })


  it('normalizes malformed persisted cursors to zero', () => {
    expect(readEventCursor(null)).toBe(0)
    expect(readEventCursor('garbage')).toBe(0)
    expect(readEventCursor('-1')).toBe(0)
    expect(readEventCursor('1.5')).toBe(0)
    expect(readEventCursor(String(Number.MAX_SAFE_INTEGER + 1))).toBe(0)
    expect(readEventCursor('42')).toBe(42)
  })

  it('rejects malformed runtime events before cursor updates', () => {
    expect(isTaskEvent(null)).toBe(false)
    expect(isTaskEvent([])).toBe(false)
    expect(isTaskEvent({ seq: 1.5, type: 'tick', data: {} })).toBe(false)
    expect(isTaskEvent({ seq: -1, type: 'tick', data: {} })).toBe(false)
    expect(isTaskEvent({ seq: Number.MAX_SAFE_INTEGER + 1, type: 'tick', data: {} })).toBe(false)
    expect(isTaskEvent({ seq: 1, type: '', data: {} })).toBe(false)
    expect(isTaskEvent({ seq: 1, type: 'tick', data: [] })).toBe(false)
    expect(isTaskEvent({ seq: 1, type: 'tick', data: {} })).toBe(true)
  })

  it('drops malformed events and deduplicates sequence numbers at runtime', () => {
    const incoming = [
      { seq: 1, type: 'tick', data: {} },
      { seq: 1.5, type: 'tick', data: {} },
      null,
      { seq: 2, type: 'tick', data: {} },
    ]
    const merged = mergeActivityEvents([], incoming as never[])
    expect(merged.map((event) => event.seq)).toEqual([2, 1])
  })

  it('bounds the replay list to the newest one hundred events', () => {
    const events = Array.from({ length:120 }, (_, index) => ({ seq:index + 1, type:'tick', data:{} }))
    const merged = mergeActivityEvents([], events)
    expect(merged).toHaveLength(100)
    expect(merged[0].seq).toBe(120)
    expect(merged.at(-1)?.seq).toBe(21)
  })
})
