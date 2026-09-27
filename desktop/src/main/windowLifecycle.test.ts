import { describe, expect, it, vi } from 'vitest'
import { minimizeInsteadOfClosingForActiveWork } from './windowLifecycle'

describe('main window close policy', () => {
  it('minimizes while local Codex work is active so the taskbar can restore the window', () => {
    const event = { preventDefault: vi.fn() }
    const window = { minimize: vi.fn() }

    expect(minimizeInsteadOfClosingForActiveWork(event, window, true, false)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.minimize).toHaveBeenCalledOnce()
  })

  it('allows normal close when idle and explicit quit while busy', () => {
    const event = { preventDefault: vi.fn() }
    const window = { minimize: vi.fn() }

    expect(minimizeInsteadOfClosingForActiveWork(event, window, false, false)).toBe(false)
    expect(minimizeInsteadOfClosingForActiveWork(event, window, true, true)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.minimize).not.toHaveBeenCalled()
  })
})
