import { applyTheme, readTheme, THEMES, type ThemeId } from './theme'

describe('Archon visual themes', () => {
  it.each<ThemeId>(['obsidian', 'indigo', 'carbon', 'ivory', 'blueprint', 'moss', 'ember'])('applies the %s visual system', (theme) => {
    applyTheme(theme)
    expect(document.documentElement.dataset.theme).toBe(theme)
    expect(localStorage.getItem('archon.visual-theme')).toBe(theme)
  })

  it('ships all seven named themes from the supplied v2 archive', () => {
    expect(THEMES).toHaveLength(7)
    expect(THEMES.map((theme) => theme.id)).toEqual(['obsidian', 'indigo', 'carbon', 'ivory', 'blueprint', 'moss', 'ember'])
    expect(new Set(THEMES.map((theme) => theme.signature)).size).toBe(7)
  })

  it('uses the supplied design-system swatches for its three core identities', () => {
    expect(THEMES.find((theme) => theme.id === 'carbon')?.swatches).toEqual(['#161826', '#232532', '#9184d9'])
    expect(THEMES.find((theme) => theme.id === 'ivory')?.swatches).toEqual(['#f3f2f2', '#fbfaf8', '#b68235'])
    expect(THEMES.find((theme) => theme.id === 'blueprint')?.swatches).toEqual(['#f3f2f2', '#ffffff', '#ec3013'])
  })

  it('migrates the old dark preference to obsidian', () => {
    localStorage.removeItem('archon.visual-theme')
    localStorage.setItem('archon.theme', 'dark')
    expect(readTheme()).toBe('obsidian')
  })
})
