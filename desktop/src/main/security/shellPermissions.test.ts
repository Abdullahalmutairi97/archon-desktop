import { describe, expect, it } from 'vitest'
import { allowShellPermission } from './shellPermissions'

const TRUSTED = 'file:///opt/app/out/renderer/index.html'

describe('trusted shell permissions', () => {
  it('allows only clipboard writes from the trusted top frame', () => {
    expect(allowShellPermission('clipboard-sanitized-write', { isMainFrame: true, requestingUrl: `${TRUSTED}#chat` }, TRUSTED)).toBe(true)
    expect(allowShellPermission('clipboard-read', { isMainFrame: true, requestingUrl: TRUSTED }, TRUSTED)).toBe(false)
    expect(allowShellPermission('media', { isMainFrame: true, requestingUrl: TRUSTED }, TRUSTED)).toBe(false)
    expect(allowShellPermission('clipboard-sanitized-write', { isMainFrame: false, requestingUrl: TRUSTED }, TRUSTED)).toBe(false)
    expect(allowShellPermission('clipboard-sanitized-write', { isMainFrame: true, requestingUrl: 'file:///tmp/other.html' }, TRUSTED)).toBe(false)
    expect(allowShellPermission('clipboard-sanitized-write', { isMainFrame: true, requestingUrl: 'https://evil.example/' }, TRUSTED)).toBe(false)
    expect(allowShellPermission('clipboard-sanitized-write', undefined, TRUSTED)).toBe(false)
  })

  it('matches a development origin exactly', () => {
    const dev = 'http://127.0.0.1:5173/'
    expect(allowShellPermission('clipboard-sanitized-write', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:5173/x' }, dev)).toBe(true)
    expect(allowShellPermission('clipboard-sanitized-write', { isMainFrame: true, requestingUrl: 'http://127.0.0.1:5174/' }, dev)).toBe(false)
  })
})
