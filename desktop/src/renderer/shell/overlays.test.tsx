import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { overlayOpen, useOverlay } from './overlays'

afterEach(() => cleanup())

function Overlay() { useOverlay(); return null }

describe('overlay signal', () => {
  it('is raised while any overlay is mounted and cleared after the last one', () => {
    expect(overlayOpen()).toBe(false)
    const first = render(<Overlay />)
    const second = render(<Overlay />)
    expect(overlayOpen()).toBe(true)
    act(() => first.unmount())
    expect(overlayOpen()).toBe(true)
    act(() => second.unmount())
    expect(overlayOpen()).toBe(false)
  })
})
