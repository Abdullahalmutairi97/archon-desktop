import { describe, expect, it } from 'vitest'
import { resolveShellShortcut, type ShortcutState } from './shortcuts'

const closed: ShortcutState = { appearanceOpen: false, paletteOpen: false, benchOpen: false }

describe('reconstruction shell keyboard map', () => {
  it('keeps Ctrl+Backslash on sidebar collapse and maps the five workbench panels', () => {
    expect(resolveShellShortcut({ key: '\\', code: 'Backslash', ctrlKey: true, metaKey: false, altKey: false }, closed))
      .toEqual({ type: 'toggle-sidebar' })

    const panels = ['activity', 'files', 'terminal', 'browser', 'ide'] as const
    panels.forEach((bench, index) => {
      expect(resolveShellShortcut({ key: String(index + 1), code: `Digit${index + 1}`, ctrlKey: true, metaKey: false, altKey: false }, closed))
        .toEqual({ type: 'open-bench', bench })
    })
  })

  it('closes only the topmost UI layer on Escape', () => {
    expect(resolveShellShortcut({ key: 'Escape', code: 'Escape', ctrlKey: false, metaKey: false, altKey: false }, { appearanceOpen: true, paletteOpen: true, benchOpen: true }))
      .toEqual({ type: 'close-appearance' })
    expect(resolveShellShortcut({ key: 'Escape', code: 'Escape', ctrlKey: false, metaKey: false, altKey: false }, { appearanceOpen: false, paletteOpen: true, benchOpen: true }))
      .toEqual({ type: 'close-palette' })
    expect(resolveShellShortcut({ key: 'Escape', code: 'Escape', ctrlKey: false, metaKey: false, altKey: false }, { appearanceOpen: false, paletteOpen: false, benchOpen: true }))
      .toEqual({ type: 'close-bench' })
  })

  it('ignores Alt-modified shortcuts and opens the palette with Ctrl+K', () => {
    expect(resolveShellShortcut({ key: '2', code: 'Digit2', ctrlKey: true, metaKey: false, altKey: true }, closed)).toBeNull()
    expect(resolveShellShortcut({ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false }, closed)).toEqual({ type: 'open-palette' })
  })
})
