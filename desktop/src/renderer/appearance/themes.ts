/**
 * Theme tokens authored from the recovered appearance reference.
 * Source: work/recovered-desktop-69bcf1e/desktop/src/renderer/src/lib/appearance.ts
 * (commit 69bcf1ecb25e4004c11576d3becdb3cb2d266767). Values are transcribed
 * as CSS tokens; historical persistence, asset handling and font loading are
 * intentionally not imported into this fixture-only shell.
 */

export type ThemeId = 'obsidian' | 'indigo' | 'carbon' | 'ivory' | 'blueprint' | 'moss' | 'ember'
export type NavigationSide = 'left' | 'right'
export type TextDirection = 'ltr' | 'rtl'

export type ThemeDefinition = {
  id: ThemeId
  label: string
  swatches: readonly [string, string, string]
}

export const THEMES: readonly ThemeDefinition[] = [
  { id: 'obsidian', label: 'Obsidian', swatches: ['#1a1a1a', '#212121', '#cfc9c1'] },
  { id: 'indigo', label: 'Indigo', swatches: ['#14172c', '#1e2244', '#b5abfc'] },
  { id: 'carbon', label: 'Carbon', swatches: ['#161826', '#232532', '#9184d9'] },
  { id: 'ivory', label: 'Ivory', swatches: ['#f3f2f2', '#fbfaf8', '#b68235'] },
  { id: 'blueprint', label: 'Blueprint', swatches: ['#f3f2f2', '#ffffff', '#ec3013'] },
  { id: 'moss', label: 'Moss', swatches: ['#121a17', '#1b2622', '#79b892'] },
  { id: 'ember', label: 'Ember', swatches: ['#1a1411', '#261d18', '#e08a4c'] },
]

export type ShellPreferences = {
  theme: ThemeId
  navigationSide: NavigationSide
  direction: TextDirection
  fontScale: 0.9 | 1 | 1.1 | 1.2
  sidebarCollapsed: boolean
}

const PREFERENCES_KEY = 'archon.reconstruction.preferences.v1'
const themeIds = new Set<ThemeId>(THEMES.map(({ id }) => id))
const fontScales = new Set<ShellPreferences['fontScale']>([0.9, 1, 1.1, 1.2])

export const DEFAULT_PREFERENCES: ShellPreferences = {
  theme: 'obsidian',
  navigationSide: 'left',
  direction: 'ltr',
  fontScale: 1,
  sidebarCollapsed: false,
}

export function readShellPreferences(storage: Pick<Storage, 'getItem'> = localStorage): ShellPreferences {
  try {
    const raw = storage.getItem(PREFERENCES_KEY)
    if (!raw) return { ...DEFAULT_PREFERENCES }
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES }
    const candidate = value as Partial<ShellPreferences>
    return {
      theme: typeof candidate.theme === 'string' && themeIds.has(candidate.theme as ThemeId)
        ? candidate.theme as ThemeId : DEFAULT_PREFERENCES.theme,
      navigationSide: candidate.navigationSide === 'right' ? 'right' : 'left',
      direction: candidate.direction === 'rtl' ? 'rtl' : 'ltr',
      fontScale: fontScales.has(candidate.fontScale as ShellPreferences['fontScale'])
        ? candidate.fontScale as ShellPreferences['fontScale'] : DEFAULT_PREFERENCES.fontScale,
      sidebarCollapsed: candidate.sidebarCollapsed === true,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function saveShellPreferences(
  value: ShellPreferences,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try { storage.setItem(PREFERENCES_KEY, JSON.stringify(value)) } catch { /* preview may run with storage disabled */ }
}
