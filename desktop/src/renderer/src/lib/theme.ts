export type ThemeId = 'obsidian' | 'indigo' | 'carbon' | 'ivory' | 'blueprint' | 'moss' | 'ember'

export type ThemeDefinition = {
  id: ThemeId
  name: string
  signature: string
  swatches: [string, string, string]
}

export const THEMES: ThemeDefinition[] = [
  { id: 'obsidian', name: 'Obsidian', signature: 'near-black-no-chroma', swatches: ['#1a1a1a', '#212121', '#cfc9c1'] },
  { id: 'indigo', name: 'Indigo', signature: 'deep-indigo-line', swatches: ['#14172c', '#1e2244', '#b5abfc'] },
  { id: 'carbon', name: 'Carbon', signature: 'quiet-blue-grey', swatches: ['#161826', '#232532', '#9184d9'] },
  { id: 'ivory', name: 'Ivory', signature: 'warm-editorial', swatches: ['#f3f2f2', '#fbfaf8', '#b68235'] },
  { id: 'blueprint', name: 'Blueprint', signature: 'zero-radius-redline', swatches: ['#f3f2f2', '#ffffff', '#ec3013'] },
  { id: 'moss', name: 'Moss', signature: 'cool-organic', swatches: ['#121a17', '#1b2622', '#79b892'] },
  { id: 'ember', name: 'Ember', signature: 'warm-late-night', swatches: ['#1a1411', '#261d18', '#e08a4c'] },
]

const ids = new Set<ThemeId>(THEMES.map((theme) => theme.id))
const key = 'archon.visual-theme'

export function readTheme(): ThemeId {
  const saved = localStorage.getItem(key)
  if (saved && ids.has(saved as ThemeId)) return saved as ThemeId
  const legacy = localStorage.getItem('archon.theme')
  if (legacy === 'light') return 'ivory'
  if (legacy === 'dark') return 'obsidian'
  return 'obsidian'
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(key, theme)
}
