import { describe, expect, it } from 'vitest'
import { isTrustedNavigation } from './navigation'

describe('isTrustedNavigation', () => {
  const renderer = '/opt/archon/resources/app.asar/out/renderer/index.html'

  it('allows only the packaged renderer file', () => {
    expect(isTrustedNavigation('file:///opt/archon/resources/app.asar/out/renderer/index.html', renderer)).toBe(true)
    expect(isTrustedNavigation('file:///tmp/attacker.html', renderer)).toBe(false)
    expect(isTrustedNavigation('file:///etc/passwd', renderer)).toBe(false)
  })

  it('rejects malformed and non-file packaged navigations', () => {
    expect(isTrustedNavigation('not a URL', renderer)).toBe(false)
    expect(isTrustedNavigation('https://evil.example/', renderer)).toBe(false)
  })

  it('allows only the configured development origin', () => {
    expect(isTrustedNavigation('http://localhost:5173/settings', renderer, 'http://localhost:5173')).toBe(true)
    expect(isTrustedNavigation('http://evil.example/', renderer, 'http://localhost:5173')).toBe(false)
    expect(isTrustedNavigation('data:text/html,attacker', renderer, 'data:text/html,app')).toBe(false)
  })
})
