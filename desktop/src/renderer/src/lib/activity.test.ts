import { describe, expect, it } from 'vitest'
import { mergeActivityEvents } from './activity'

describe('mergeActivityEvents', () => {
  it('deduplicates replayed events and keeps newest sequence first', () => {
    const existing = [{ seq: 2, type:'task.running', data:{}, task_id:'a' }]
    const replay = [{ seq: 1, type:'task.queued', data:{}, task_id:'a' }, { seq:2, type:'task.running', data:{}, task_id:'a' }, { seq:3, type:'task.completed', data:{}, task_id:'a' }]
    expect(mergeActivityEvents(existing, replay).map((event) => event.seq)).toEqual([3,2,1])
  })

  it('bounds the replay list to the newest one hundred events', () => {
    const events = Array.from({ length:120 }, (_, index) => ({ seq:index + 1, type:'tick', data:{} }))
    const merged = mergeActivityEvents([], events)
    expect(merged).toHaveLength(100)
    expect(merged[0].seq).toBe(120)
    expect(merged.at(-1)?.seq).toBe(21)
  })
})
