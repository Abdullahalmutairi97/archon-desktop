import type { ThemeId } from './theme'
import { MARK_IDS, type MarkId } from './marks'
import shippedBackgroundUrl from '../assets/home-backdrop.png'

export type AppearancePattern = 'aurora' | 'halo' | 'mesh' | 'grid' | 'none'
export type AppearanceFont = string
export type AppearanceDisplayFont = string
export type NavigationSide = 'left' | 'right'
export type WordmarkTone = 'tinted' | 'ink' | 'accent' | 'ghost' | 'outline'
export type BackgroundAsset = { id: string; label: string; file: string; url: string; addedAt: string }

export type AppearanceConfig = {
  canvas: string
  rail: string
  surface: string
  text: string
  muted: string
  accent: string
  line: string
  ambientOne: string
  ambientTwo: string
  font: AppearanceFont
  displayFont: AppearanceDisplayFont
  wordmarkTone: WordmarkTone
  mark: MarkId
  fontScale: number
  fontWeight: number
  letterSpacing: number
  iconScale: number
  iconStroke: number
  motion: number
  density: number
  radius: number
  blur: number
  glow: number
  ambientOpacity: number
  sidebarWidth: number
  railWidth: number
  composerWidth: number
  contentWidth: number
  pattern: AppearancePattern
  navSide: NavigationSide
  glass: boolean
  backgroundImage: string
  backgroundId: string
  backgroundLabel: string
  backgroundFile: string
  backgroundAddedAt: string
  backgroundLibrary: BackgroundAsset[]
  customMark: string
  customMarkFile: string
  useShippedBackground: boolean
  backdropEnabled: boolean
  backgroundDim: number
  backgroundFit: 'cover' | 'contain' | 'tile'
  backgroundPosition: 'center' | 'top' | 'bottom'
}

export const APPEARANCE_STORAGE_KEY = 'archon.appearance.v3-exact'

export const APPEARANCE_DEFAULTS: AppearanceConfig = {
  canvas: '#1a1a1a', rail: '#131313', surface: '#212121', text: '#e8e5e0', muted: '#96928c',
  accent: '#cfc9c1', line: '#343230', ambientOne: '#615d58', ambientTwo: '#353b43',
  font: 'chivo', displayFont: 'playfair', wordmarkTone: 'tinted', mark: 'wing', fontScale: 1, fontWeight: 400, letterSpacing: 0, iconScale: 1, iconStroke: 1.55, motion: 1,
  density: 0.86, radius: 4, blur: 14, glow: 0.12,
  ambientOpacity: 0.3, sidebarWidth: 262, railWidth: 52, composerWidth: 860, contentWidth: 1120,
  pattern: 'none', navSide: 'left', glass: true, backgroundImage: '', backgroundId: '', backgroundLabel: '', backgroundFile: '', backgroundAddedAt: '', backgroundLibrary: [], customMark: '', customMarkFile: '', useShippedBackground: true, backdropEnabled: true, backgroundDim: 1, backgroundFit: 'cover', backgroundPosition: 'center',
}

const themeVisuals: Record<ThemeId, Partial<AppearanceConfig>> = {
  obsidian: { canvas: '#1a1a1a', rail: '#131313', surface: '#212121', text: '#e8e5e0', muted: '#96928c', accent: '#cfc9c1', line: '#343230', ambientOne: '#615d58', ambientTwo: '#353b43', font: 'chivo', displayFont: 'playfair', pattern: 'none', density: .86, radius: 4, glow: .12 },
  indigo: { canvas: '#14172c', rail: '#191d3a', surface: '#1e2244', text: '#eceaf6', muted: '#9e9bb8', accent: '#b5abfc', line: '#353a65', ambientOne: '#6159a8', ambientTwo: '#333a71', font: 'chivo', displayFont: 'playfair', pattern: 'halo', density: .86, radius: 8, glow: .24 },
  carbon: { canvas: '#161826', rail: '#191b28', surface: '#232532', text: '#e9e9ed', muted: '#9596a2', accent: '#9184d9', line: '#383a48', ambientOne: '#514a82', ambientTwo: '#343852', font: 'chivo', displayFont: 'playfair', pattern: 'none', density: .86, radius: 8, glow: .18 },
  ivory: { canvas: '#f3f2f2', rail: '#f1eee8', surface: '#fbfaf8', text: '#201f1d', muted: '#716c65', accent: '#b68235', line: '#d4cec3', ambientOne: '#b9986b', ambientTwo: '#d8c9b4', font: 'lora', displayFont: 'cormorant', pattern: 'none', density: 1, radius: 4, glow: .08 },
  blueprint: { canvas: '#f3f2f2', rail: '#eceaea', surface: '#ffffff', text: '#201e1d', muted: '#6d6963', accent: '#ec3013', line: '#cbc7c5', ambientOne: '#ec3013', ambientTwo: '#615b59', font: 'archivo', displayFont: 'archivo', pattern: 'grid', density: 1, radius: 0, glow: .05, glass: false },
  moss: { canvas: '#121a17', rail: '#161f1c', surface: '#1b2622', text: '#e4ece7', muted: '#879b91', accent: '#79b892', line: '#304038', ambientOne: '#3f6954', ambientTwo: '#5b6045', font: 'chivo', displayFont: 'playfair', pattern: 'mesh', density: .9, radius: 10 },
  ember: { canvas: '#1a1411', rail: '#1f1815', surface: '#261d18', text: '#f1e7e0', muted: '#a48f80', accent: '#e08a4c', line: '#49372e', ambientOne: '#704126', ambientTwo: '#5a3331', font: 'chivo', displayFont: 'playfair', pattern: 'halo', density: .88, radius: 6 },
}

const fonts: AppearanceFont[] = ['chivo','schibsted','familjen','epilogue','onest','gabarito','hanken','be-vietnam','chakra-petch','rajdhani','unbounded','martian-mono','space-mono','plex-mono','instrument-sans','dm-sans','plus-jakarta','manrope','figtree','space-grotesk','ibm-plex-sans','archivo','sora','outfit','inter','system','jetbrains-mono','condensed','mono','serif','lora']
const displayFonts: AppearanceDisplayFont[] = ['playfair-black','bodoni-black','prata','rozha','yeseva','abril','suranna','bellefair','cinzel','marcellus','italiana','gloock','eb-garamond','young-serif','dm-serif','unicase','anton','archivo-black','antonio','oswald','big-shoulders','unbounded','cormorant','instrument-serif','playfair','bodoni-moda','baskerville','spectral','newsreader','lora','syne','bricolage','space-grotesk','archivo','inter']
const patterns: AppearancePattern[] = ['aurora', 'halo', 'mesh', 'grid', 'none']
const sides: NavigationSide[] = ['left', 'right']
const wordmarkTones: WordmarkTone[] = ['tinted', 'ink', 'accent', 'ghost', 'outline']
const fits: AppearanceConfig['backgroundFit'][] = ['cover', 'contain', 'tile']
const positions: AppearanceConfig['backgroundPosition'][] = ['center', 'top', 'bottom']
const colorPattern = /^#[0-9a-f]{6}$/i

function number(value: unknown, fallback: number, min: number, max: number) {
  return Math.min(max, Math.max(min, typeof value === 'number' && Number.isFinite(value) ? value : fallback))
}

function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback
}

function color(value: unknown, fallback: string) {
  return typeof value === 'string' && colorPattern.test(value) ? value : fallback
}

export function normalizeAppearance(value: unknown): AppearanceConfig {
  const input = value && typeof value === 'object' ? value as Partial<AppearanceConfig> : {}
  const localPath = (value: unknown) => typeof value === 'string' && /^\/[a-z0-9_./+ -]+$/i.test(value) ? value : ''
  const protocolUrl = (value: unknown, file: string, folder: 'brand' | 'backgrounds') => {
    if (typeof value === 'string' && /^archon-asset:\/\/local\/(brand|backgrounds)\/[a-z0-9._%+-]+$/i.test(value)) return value
    const filename = file.split('/').pop()
    return filename ? `archon-asset://local/${folder}/${encodeURIComponent(filename)}` : ''
  }
  const backgroundFile = localPath(input.backgroundFile)
  const customMarkFile = localPath(input.customMarkFile)
  const image = protocolUrl(input.backgroundImage, backgroundFile, 'backgrounds')
  const mark = protocolUrl(input.customMark, customMarkFile, 'brand')
  const shortText = (value: unknown, size = 100) => typeof value === 'string' ? value.slice(0, size) : ''
  const backgroundLibrary = Array.isArray(input.backgroundLibrary) ? input.backgroundLibrary.slice(0, 3).map((candidate) => {
    const asset = candidate && typeof candidate === 'object' ? candidate as Partial<BackgroundAsset> : {}
    const file = localPath(asset.file)
    const url = protocolUrl(asset.url, file, 'backgrounds')
    return { id: shortText(asset.id), label: shortText(asset.label, 80), file, url, addedAt: shortText(asset.addedAt) }
  }).filter((asset) => asset.id && asset.file && asset.url) : []
  return {
    canvas: color(input.canvas, APPEARANCE_DEFAULTS.canvas), rail: color(input.rail, APPEARANCE_DEFAULTS.rail),
    surface: color(input.surface, APPEARANCE_DEFAULTS.surface), text: color(input.text, APPEARANCE_DEFAULTS.text),
    muted: color(input.muted, APPEARANCE_DEFAULTS.muted), accent: color(input.accent, APPEARANCE_DEFAULTS.accent),
    line: color(input.line, APPEARANCE_DEFAULTS.line), ambientOne: color(input.ambientOne, APPEARANCE_DEFAULTS.ambientOne),
    ambientTwo: color(input.ambientTwo, APPEARANCE_DEFAULTS.ambientTwo), font: choice(input.font, fonts, APPEARANCE_DEFAULTS.font),
    displayFont: choice(input.displayFont, displayFonts, APPEARANCE_DEFAULTS.displayFont), wordmarkTone: choice(input.wordmarkTone, wordmarkTones, APPEARANCE_DEFAULTS.wordmarkTone), mark: choice(input.mark, MARK_IDS, APPEARANCE_DEFAULTS.mark),
    fontScale: number(input.fontScale, APPEARANCE_DEFAULTS.fontScale, .84, 1.2),
    fontWeight: number(input.fontWeight, APPEARANCE_DEFAULTS.fontWeight, 300, 650), letterSpacing: number(input.letterSpacing, APPEARANCE_DEFAULTS.letterSpacing, -.04, .04),
    iconScale: number(input.iconScale, APPEARANCE_DEFAULTS.iconScale, .8, 1.3), iconStroke: number(input.iconStroke, APPEARANCE_DEFAULTS.iconStroke, 1, 2.4),
    motion: number(input.motion, APPEARANCE_DEFAULTS.motion, 0, 1.5), density: number(input.density, APPEARANCE_DEFAULTS.density, .78, 1.18),
    radius: number(input.radius, APPEARANCE_DEFAULTS.radius, 0, 24), blur: number(input.blur, APPEARANCE_DEFAULTS.blur, 0, 36),
    glow: number(input.glow, APPEARANCE_DEFAULTS.glow, 0, .65), ambientOpacity: number(input.ambientOpacity, APPEARANCE_DEFAULTS.ambientOpacity, 0, .85),
    sidebarWidth: number(input.sidebarWidth, APPEARANCE_DEFAULTS.sidebarWidth, 190, 380), railWidth: number(input.railWidth, APPEARANCE_DEFAULTS.railWidth, 42, 76),
    composerWidth: number(input.composerWidth, APPEARANCE_DEFAULTS.composerWidth, 520, 1200), contentWidth: number(input.contentWidth, APPEARANCE_DEFAULTS.contentWidth, 720, 1600),
    pattern: choice(input.pattern, patterns, APPEARANCE_DEFAULTS.pattern), navSide: choice(input.navSide, sides, APPEARANCE_DEFAULTS.navSide),
    glass: typeof input.glass === 'boolean' ? input.glass : APPEARANCE_DEFAULTS.glass, backgroundImage: image,
    backgroundId: shortText(input.backgroundId), backgroundLabel: shortText(input.backgroundLabel), backgroundFile, backgroundAddedAt: shortText(input.backgroundAddedAt), backgroundLibrary,
    customMark: mark, customMarkFile,
    useShippedBackground: typeof input.useShippedBackground === 'boolean' ? input.useShippedBackground : APPEARANCE_DEFAULTS.useShippedBackground,
    backdropEnabled: typeof input.backdropEnabled === 'boolean' ? input.backdropEnabled : APPEARANCE_DEFAULTS.backdropEnabled,
    backgroundDim: number(input.backgroundDim, APPEARANCE_DEFAULTS.backgroundDim, .2, 1),
    backgroundFit: choice(input.backgroundFit, fits, APPEARANCE_DEFAULTS.backgroundFit), backgroundPosition: choice(input.backgroundPosition, positions, APPEARANCE_DEFAULTS.backgroundPosition),
  }
}

export function readAppearance(): AppearanceConfig {
  try { return normalizeAppearance(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) || 'null')) }
  catch { return { ...APPEARANCE_DEFAULTS } }
}

export function appearanceForTheme(theme: ThemeId, layout: AppearanceConfig = readAppearance()): AppearanceConfig {
  return normalizeAppearance({ ...layout, ...themeVisuals[theme] })
}

const fontStacks: Record<string, string> = {
  chivo: '"Chivo Variable", "Chivo", ui-sans-serif, system-ui, sans-serif',
  schibsted: '"Schibsted Grotesk", system-ui, sans-serif', familjen: '"Familjen Grotesk", system-ui, sans-serif', epilogue: '"Epilogue", system-ui, sans-serif', onest: '"Onest", system-ui, sans-serif', gabarito: '"Gabarito", system-ui, sans-serif', hanken: '"Hanken Grotesk", system-ui, sans-serif', 'be-vietnam': '"Be Vietnam Pro", system-ui, sans-serif', 'chakra-petch': '"Chakra Petch", system-ui, sans-serif', rajdhani: '"Rajdhani", system-ui, sans-serif', unbounded: '"Unbounded", system-ui, sans-serif', 'martian-mono': '"Martian Mono", ui-monospace, monospace', 'space-mono': '"Space Mono", ui-monospace, monospace', 'plex-mono': '"IBM Plex Mono", ui-monospace, monospace', 'instrument-sans': '"Instrument Sans", system-ui, sans-serif', 'dm-sans': '"DM Sans", system-ui, sans-serif', 'plus-jakarta': '"Plus Jakarta Sans", system-ui, sans-serif', manrope: '"Manrope", system-ui, sans-serif', figtree: '"Figtree", system-ui, sans-serif', 'space-grotesk': '"Space Grotesk", system-ui, sans-serif', 'ibm-plex-sans': '"IBM Plex Sans", system-ui, sans-serif', sora: '"Sora", system-ui, sans-serif', outfit: '"Outfit", system-ui, sans-serif', 'jetbrains-mono': '"JetBrains Mono", ui-monospace, monospace',
  inter: '"Inter Variable", "Inter", "Noto Sans", ui-sans-serif, system-ui, sans-serif',
  archivo: '"Archivo Variable", "Archivo", "Noto Sans", ui-sans-serif, system-ui, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  condensed: '"Roboto Condensed", "Arial Narrow", "Noto Sans", sans-serif',
  mono: '"JetBrains Mono", "DejaVu Sans Mono", ui-monospace, monospace',
  serif: '"Lora Variable", "Lora", "Noto Serif", Georgia, serif',
  lora: '"Lora Variable", "Lora", "Noto Serif", Georgia, serif',
}

const displayStacks: Record<string, string> = {
  'playfair-black': '"Playfair Display", Georgia, serif', 'bodoni-black': '"Bodoni Moda", Georgia, serif', prata: '"Prata", Georgia, serif', rozha: '"Rozha One", Georgia, serif', yeseva: '"Yeseva One", Georgia, serif', abril: '"Abril Fatface", Georgia, serif', suranna: '"Suranna", Georgia, serif', bellefair: '"Bellefair", Georgia, serif', cinzel: '"Cinzel", Georgia, serif', marcellus: '"Marcellus", Georgia, serif', italiana: '"Italiana", Georgia, serif', gloock: '"Gloock", Georgia, serif', 'eb-garamond': '"EB Garamond", Georgia, serif', 'young-serif': '"Young Serif", Georgia, serif', 'dm-serif': '"DM Serif Display", Georgia, serif', unicase: '"Cormorant Unicase", Georgia, serif', anton: '"Anton", system-ui, sans-serif', 'archivo-black': '"Archivo Black", system-ui, sans-serif', antonio: '"Antonio", system-ui, sans-serif', oswald: '"Oswald", system-ui, sans-serif', 'big-shoulders': '"Big Shoulders", system-ui, sans-serif', unbounded: '"Unbounded", system-ui, sans-serif', 'instrument-serif': '"Instrument Serif", Georgia, serif', 'bodoni-moda': '"Bodoni Moda", Georgia, serif', baskerville: '"Libre Baskerville", Georgia, serif', spectral: '"Spectral", Georgia, serif', newsreader: '"Newsreader", Georgia, serif', syne: '"Syne", system-ui, sans-serif', bricolage: '"Bricolage Grotesque", system-ui, sans-serif', 'space-grotesk': '"Space Grotesk", system-ui, sans-serif',
  playfair: '"Playfair Display Variable", "Playfair Display", Georgia, serif',
  cormorant: '"Cormorant Garamond Variable", "Cormorant Garamond", "Noto Serif", Georgia, serif',
  archivo: '"Archivo Variable", "Archivo", ui-sans-serif, system-ui, sans-serif',
  inter: '"Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif',
  lora: '"Lora Variable", "Lora", "Noto Serif", Georgia, serif',
}

const patternImages: Record<AppearancePattern, string> = {
  aurora: 'radial-gradient(70% 90% at 70% 10%,color-mix(in srgb,var(--ambient-one) 48%,transparent),transparent 72%),radial-gradient(70% 100% at 20% 90%,color-mix(in srgb,var(--ambient-two) 38%,transparent),transparent 74%)',
  halo: 'radial-gradient(circle at 50% 42%,color-mix(in srgb,var(--ambient-one) 38%,transparent),transparent 46%),radial-gradient(circle at 88% 12%,color-mix(in srgb,var(--ambient-two) 24%,transparent),transparent 38%)',
  mesh: 'radial-gradient(circle at 12% 15%,color-mix(in srgb,var(--ambient-one) 34%,transparent),transparent 34%),radial-gradient(circle at 82% 20%,color-mix(in srgb,var(--ambient-two) 30%,transparent),transparent 32%),radial-gradient(circle at 50% 100%,color-mix(in srgb,var(--accent) 14%,transparent),transparent 38%)',
  grid: 'linear-gradient(color-mix(in srgb,var(--accent) 7%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--accent) 7%,transparent) 1px,transparent 1px),radial-gradient(circle at 70% 10%,color-mix(in srgb,var(--ambient-one) 28%,transparent),transparent 46%)',
  none: 'none',
}

function brightness(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  return (((value >> 16) & 255) * 299 + ((value >> 8) & 255) * 587 + (value & 255) * 114) / 1000
}

export function applyAppearance(value: AppearanceConfig) {
  const config = normalizeAppearance(value)
  const root = document.documentElement
  const selectedBackground = config.backdropEnabled ? (config.backgroundImage || (config.useShippedBackground ? shippedBackgroundUrl : '')) : ''
  const properties: Record<string, string> = {
    '--bg': config.canvas, '--canvas': config.canvas, '--rail': config.rail, '--surface': config.surface,
    '--surface-2': 'color-mix(in srgb,var(--surface) 84%,var(--text) 16%)', '--surface-3': 'color-mix(in srgb,var(--surface) 74%,var(--text) 26%)',
    '--text': config.text, '--muted': config.muted, '--quiet': 'color-mix(in srgb,var(--muted) 68%,var(--canvas))',
    '--accent': config.accent, '--accent-ink': brightness(config.accent) > 150 ? config.canvas : config.text,
    '--accent-soft': 'color-mix(in srgb,var(--accent) 14%,transparent)', '--line': config.line,
    '--line-strong': 'color-mix(in srgb,var(--line) 72%,var(--text) 28%)', '--ambient-one': config.ambientOne,
    '--ambient-two': config.ambientTwo, '--font-ui': fontStacks[config.font] || fontStacks.chivo, '--font-display': displayStacks[config.displayFont] || displayStacks.playfair,
    '--display-weight': config.displayFont.includes('black') ? '900' : config.displayFont === 'playfair' ? '800' : '700',
    '--display-tracking': ['anton','oswald','antonio','big-shoulders'].includes(config.displayFont) ? '.04em' : '.02em',
    '--font-scale': String(config.fontScale), '--font-weight': String(config.fontWeight), '--letter-spacing': `${config.letterSpacing}em`,
    '--icon-scale': String(config.iconScale), '--icon-stroke': String(config.iconStroke), '--motion-speed': `${Math.round(150 * config.motion)}ms`,
    '--density': String(config.density), '--radius': `${config.radius}px`,
    '--radius-lg': `${Math.min(32, config.radius + 5)}px`, '--glass-blur': `${config.blur}px`, '--theme-glow': String(config.glow),
    '--ambient-opacity': String(config.ambientOpacity), '--sidebar-width': `${config.sidebarWidth}px`, '--rail-width': `${config.railWidth}px`,
    '--composer-width': `${config.composerWidth}px`, '--content-width': `${config.contentWidth}px`, '--canvas-pattern': patternImages[config.pattern],
    '--custom-background-image': selectedBackground ? `url("${selectedBackground}")` : 'none',
    '--background-dim': String(brightness(config.canvas) > 150 ? config.backgroundDim / 2 : config.backgroundDim),
    '--custom-background-size': config.backgroundFit === 'tile' ? '340px' : config.backgroundFit,
    '--custom-background-position': config.backgroundPosition,
    '--custom-background-repeat': config.backgroundFit === 'tile' ? 'repeat' : 'no-repeat',
  }
  Object.entries(properties).forEach(([name, content]) => root.style.setProperty(name, content))
  root.dataset.pattern = config.pattern
  root.dataset.backdrop = config.backdropEnabled ? 'on' : 'off'
  root.dataset.navSide = config.navSide
  root.dataset.glass = config.glass ? 'on' : 'off'
  root.dataset.mark = config.mark
  root.dataset.wordmarkTone = config.wordmarkTone
  root.style.colorScheme = brightness(config.canvas) > 150 ? 'light' : 'dark'
  window.dispatchEvent(new CustomEvent('archon:appearance-changed', { detail: config }))
}

export function saveAppearance(value: AppearanceConfig) {
  const config = normalizeAppearance(value)
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(config))
  void window.archon?.setSettings({ appearance: config })
  applyAppearance(config)
  return config
}

export type SavedAppearance = { id: string; name: string; appearance: AppearanceConfig }
const CUSTOM_APPEARANCE_KEY = 'archon.custom-appearances.v1'

export function readCustomAppearances(): SavedAppearance[] {
  try {
    const value = JSON.parse(localStorage.getItem(CUSTOM_APPEARANCE_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.slice(0, 24).filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string').map((item) => ({ id: item.id, name: item.name.slice(0, 48), appearance: normalizeAppearance(item.appearance) }))
  } catch { return [] }
}

export function saveCustomAppearance(name: string, appearance: AppearanceConfig): SavedAppearance {
  const saved: SavedAppearance = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    name: name.trim().slice(0, 48) || 'Custom theme', appearance: normalizeAppearance(appearance),
  }
  const appearances = [saved, ...readCustomAppearances()].slice(0, 24)
  localStorage.setItem(CUSTOM_APPEARANCE_KEY, JSON.stringify(appearances))
  void window.archon?.setSettings({ customAppearances: appearances })
  return saved
}

export function deleteCustomAppearance(id: string) {
  const appearances = readCustomAppearances().filter((item) => item.id !== id)
  localStorage.setItem(CUSTOM_APPEARANCE_KEY, JSON.stringify(appearances))
  void window.archon?.setSettings({ customAppearances: appearances })
}
