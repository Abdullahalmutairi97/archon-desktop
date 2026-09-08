import { describe, expect, it, vi } from 'vitest'
import { waitForReconnect } from './reconnect'

describe('waitForReconnect', () => {
  it('resolves immediately when aborted', async () => {
    const controller = new AbortController()
    const promise = waitForReconnect(controller.signal, 60_000)
    controller.abort()
    await expect(promise).resolves.toBeUndefined()
  })

  it('waits for the clean disconnect backoff', async () => {
    vi.useFakeTimers()
    try {
      const promise = waitForReconnect(new AbortController().signal, 1000)
      let settled = false
      void promise.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(promise).resolves.toBeUndefined()
    } finally { vi.useRealTimers() }
  })
})
