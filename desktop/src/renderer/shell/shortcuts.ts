/** Pure keyboard mapping for the authored desktop shell. */
export type BenchId = 'activity' | 'files' | 'browser' | 'terminal' | 'preview'

export type ShortcutState = {
  appearanceOpen: boolean
  paletteOpen: boolean
  benchOpen: boolean
}

export type ShortcutAction =
  | { type: 'toggle-sidebar' }
  | { type: 'new-session' }
  | { type: 'open-appearance' }
  | { type: 'open-palette' }
  | { type: 'open-bench'; bench: BenchId }
  | { type: 'close-appearance' }
  | { type: 'close-palette' }
  | { type: 'close-bench' }

const benchByDigit: Record<string, BenchId> = {
  '1': 'activity',
  '2': 'files',
  '3': 'browser',
  '4': 'terminal',
  '5': 'preview',
}

export function resolveShellShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  state: ShortcutState,
): ShortcutAction | null {
  if (event.key === 'Escape') {
    if (state.appearanceOpen) return { type: 'close-appearance' }
    if (state.paletteOpen) return { type: 'close-palette' }
    if (state.benchOpen) return { type: 'close-bench' }
    return null
  }

  const modifier = event.ctrlKey || event.metaKey
  if (event.ctrlKey && !event.metaKey && event.key === '\\') return { type: 'toggle-sidebar' }
  if (!modifier || event.altKey) return null

  const normalized = event.key.toLowerCase()
  if (normalized === 'n' && event.ctrlKey && !event.metaKey) return { type: 'new-session' }
  if (normalized === ',') return { type: 'open-appearance' }
  if (normalized === 'k') return { type: 'open-palette' }

  const digit = /^Digit[1-5]$/.test(event.code) ? event.code.slice(-1) : event.key
  const bench = benchByDigit[digit]
  return bench ? { type: 'open-bench', bench } : null
}
