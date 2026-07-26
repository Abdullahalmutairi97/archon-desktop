import { APPEARANCE_DEFAULTS, appearanceForTheme, applyAppearance, deleteCustomAppearance, normalizeAppearance, readAppearance, readCustomAppearances, saveAppearance, saveCustomAppearance } from './appearance'

describe('appearance preferences', () => {
  beforeEach(() => localStorage.clear())

  it('normalizes imported values without allowing invalid colors or broken layout ranges', () => {
    const value = normalizeAppearance({
      canvas: 'not-a-color',
      accent: '#123456',
      fontScale: 99,
      fontWeight: 999,
      letterSpacing: -2,
      iconScale: 9,
      iconStroke: -3,
      motion: 8,
      backgroundDim: 4,
      density: -3,
      sidebarWidth: 9999,
      navSide: 'diagonal',
    })

    expect(value.canvas).toBe(APPEARANCE_DEFAULTS.canvas)
    expect(value.accent).toBe('#123456')
    expect(value.fontScale).toBe(1.2)
    expect(value.fontWeight).toBe(650)
    expect(value.letterSpacing).toBe(-0.04)
    expect(value.iconScale).toBe(1.3)
    expect(value.iconStroke).toBe(1)
    expect(value.motion).toBe(1.5)
    expect(value.backgroundDim).toBe(1)
    expect(value.density).toBe(0.78)
    expect(value.sidebarWidth).toBe(380)
    expect(value.navSide).toBe('left')
  })

  it('falls back to defaults when persisted appearance JSON is corrupt', () => {
    localStorage.setItem('archon.appearance.v2', '{broken')
    expect(readAppearance()).toEqual(APPEARANCE_DEFAULTS)
  })

  it('keeps device-local background metadata out of blob storage and uses the contractual metrics', () => {
    const appearance = normalizeAppearance({
      ...APPEARANCE_DEFAULTS,
      backgroundImage: 'file:///home/abdullah/.archon/backgrounds/plate.webp',
      backgroundFile: '/home/abdullah/.archon/backgrounds/plate.webp',
      backgroundId: 'plate', backgroundLabel: 'Plate', backgroundAddedAt: '2026-07-25T00:00:00Z',
      backgroundLibrary: [
        { id: 'plate', label: 'Plate', file: '/home/abdullah/.archon/backgrounds/plate.webp', url: 'file:///home/abdullah/.archon/backgrounds/plate.webp', addedAt: '2026-07-25T00:00:00Z' },
      ],
    })

    expect(appearance.backgroundImage).toBe('archon-asset://local/backgrounds/plate.webp')
    expect(appearance.backgroundFile).toBe('/home/abdullah/.archon/backgrounds/plate.webp')
    expect(appearance.sidebarWidth).toBe(262)
    expect(appearance.composerWidth).toBe(860)
    expect(appearance.backgroundLibrary).toHaveLength(1)
    expect(JSON.stringify(appearance)).not.toContain('data:image')
  })

  it('keeps at most three safe device-local background slots', () => {
    const appearance = normalizeAppearance({
      ...APPEARANCE_DEFAULTS,
      backgroundLibrary: [1, 2, 3, 4].map((id) => ({
        id: String(id), label: `Plate ${id}`,
        file: `/home/abdullah/.archon/backgrounds/${id}.webp`,
        url: `file:///home/abdullah/.archon/backgrounds/${id}.webp`,
        addedAt: '2026-07-25T00:00:00Z',
      })),
    })
    expect(appearance.backgroundLibrary.map((item) => item.id)).toEqual(['1', '2', '3'])
  })

  it('halves background strength for light themes', () => {
    applyAppearance(normalizeAppearance({ ...APPEARANCE_DEFAULTS, canvas: '#ffffff', backgroundDim: 0.8 }))
    expect(document.documentElement.style.getPropertyValue('--background-dim')).toBe('0.4')
    applyAppearance(normalizeAppearance({ ...APPEARANCE_DEFAULTS, canvas: '#111111', backgroundDim: 0.8 }))
    expect(document.documentElement.style.getPropertyValue('--background-dim')).toBe('0.8')
  })

  it('persists the independent wordmark tone and applies outline mode', () => {
    const appearance = normalizeAppearance({ ...APPEARANCE_DEFAULTS, wordmarkTone: 'outline' })
    applyAppearance(appearance)
    expect(appearance.wordmarkTone).toBe('outline')
    expect(document.documentElement.dataset.wordmarkTone).toBe('outline')
  })

  it('applies and persists the appearance as live shell variables', () => {
    const value = normalizeAppearance({ ...APPEARANCE_DEFAULTS, accent: '#ff3366', navSide: 'right', glass: false, sidebarWidth: 300 })
    saveAppearance(value)

    expect(readAppearance().accent).toBe('#ff3366')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff3366')
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('300px')
    expect(document.documentElement.dataset.navSide).toBe('right')
    expect(document.documentElement.dataset.glass).toBe('off')
  })

  it('keeps the selected background independent from the background-effect toggle', () => {
    const off = normalizeAppearance({ ...APPEARANCE_DEFAULTS, backdropEnabled: false, useShippedBackground: true })
    applyAppearance(off)
    expect(off.useShippedBackground).toBe(true)
    expect(document.documentElement.dataset.backdrop).toBe('off')
    expect(document.documentElement.style.getPropertyValue('--custom-background-image')).toBe('none')

    const on = normalizeAppearance({ ...off, backdropEnabled: true })
    applyAppearance(on)
    expect(document.documentElement.dataset.backdrop).toBe('on')
    expect(document.documentElement.style.getPropertyValue('--custom-background-image')).toContain('home-backdrop')
  })

  it('stores and deletes named custom appearances', () => {
    const saved = saveCustomAppearance(' Night studio ', { ...APPEARANCE_DEFAULTS, accent: '#00ccaa' })
    expect(saved.name).toBe('Night studio')
    expect(readCustomAppearances()).toEqual([saved])
    deleteCustomAppearance(saved.id)
    expect(readCustomAppearances()).toEqual([])
  })

  it('can apply preferences without persisting while a control is dragged', () => {
    applyAppearance({ ...APPEARANCE_DEFAULTS, radius: 21 })
    expect(document.documentElement.style.getPropertyValue('--radius')).toBe('21px')
    expect(localStorage.getItem('archon.appearance.v2')).toBeNull()
  })

  it('maps all supplied v2 themes into real presets and preserves the shipped plate and mark', () => {
    expect(appearanceForTheme('obsidian', APPEARANCE_DEFAULTS)).toMatchObject({
      canvas: '#1a1a1a', rail: '#131313', surface: '#212121', text: '#e8e5e0', accent: '#cfc9c1', radius: 4,
      mark: 'wing', useShippedBackground: true,
    })
    expect(appearanceForTheme('indigo', APPEARANCE_DEFAULTS)).toMatchObject({
      canvas: '#14172c', rail: '#191d3a', surface: '#1e2244', text: '#eceaf6', accent: '#b5abfc', radius: 8,
    })
    expect(appearanceForTheme('carbon', APPEARANCE_DEFAULTS)).toMatchObject({
      canvas: '#161826', rail: '#191b28', surface: '#232532', text: '#e9e9ed', accent: '#9184d9', radius: 8,
    })
    expect(appearanceForTheme('ivory', APPEARANCE_DEFAULTS)).toMatchObject({
      canvas: '#f3f2f2', rail: '#f1eee8', surface: '#fbfaf8', text: '#201f1d', accent: '#b68235', font: 'lora', radius: 4,
    })
    expect(appearanceForTheme('blueprint', APPEARANCE_DEFAULTS)).toMatchObject({
      canvas: '#f3f2f2', rail: '#eceaea', surface: '#ffffff', text: '#201e1d', accent: '#ec3013', font: 'archivo', radius: 0,
    })
    expect(appearanceForTheme('moss', APPEARANCE_DEFAULTS)).toMatchObject({ canvas: '#121a17', accent: '#79b892', radius: 10 })
    expect(appearanceForTheme('ember', APPEARANCE_DEFAULTS)).toMatchObject({ canvas: '#1a1411', accent: '#e08a4c', radius: 6 })
  })
})
