// @vitest-environment jsdom
import { render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it } from 'vitest'

import { BrandGlyph } from './BrandGlyph'
import { APPEARANCE_DEFAULTS, APPEARANCE_STORAGE_KEY } from '../lib/appearance'

describe('BrandGlyph', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the shared brand-glyph sizing contract for custom marks', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({
      ...APPEARANCE_DEFAULTS,
      customMark: 'archon-asset://local/brand/mark.png',
      customMarkFile: 'mark.png',
    }))

    const { container } = render(<BrandGlyph className="titlebar-mark" />)
    const glyph = container.querySelector('svg')
    expect(glyph).toHaveClass('brand-glyph', 'titlebar-mark')
    expect(glyph?.querySelector('image')).toHaveAttribute('href', 'archon-asset://local/brand/mark.png')
  })
})
