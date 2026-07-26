import { renderToStaticMarkup } from 'react-dom/server'
import { MARKS, MarkGlyph, type MarkId } from './marks'

describe('supplied Archon v2 app marks', () => {
  it('ships the complete twenty-two-mark archive set in canonical order', () => {
    expect(Object.keys(MARKS)).toEqual([
      'wing', 'caduceus', 'aegis', 'prism', 'helix', 'orbit', 'gate', 'eclipse', 'cipher', 'ridge', 'meander',
      'column', 'keystone', 'stroke', 'stele', 'sigil', 'laurel', 'omega', 'obelisk', 'seal', 'triglyph', 'delta',
    ])
  })

  it.each<MarkId>(['wing', 'caduceus', 'orbit', 'column', 'delta'])('renders %s as a two-role SVG mark', (mark) => {
    const markup = renderToStaticMarkup(<MarkGlyph mark={mark}/>)
    expect(markup).toContain('viewBox="0 0 32 32"')
    expect(markup).toContain('aria-label="Archon')
    expect(markup).not.toContain('&lt;')
  })
})
