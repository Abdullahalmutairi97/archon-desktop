import { describe, expect, it } from 'vitest'
import { extractBrowserLinks, MAX_BROWSER_LINKS, normalizeBrowserAddress } from './browserLinks'

describe('browser links from agent output', () => {
  it('extracts unique http(s) links in order with trailing punctuation trimmed', () => {
    const links = extractBrowserLinks([
      'The agent found https://example.com/report and https://example.com/report.',
      'Research the release notes at https://docs.example.com/start.',
      null,
      undefined,
    ])
    expect(links.map((link) => link.url)).toEqual([
      'https://example.com/report',
      'https://docs.example.com/start',
    ])
    expect(links.map((link) => link.label)).toEqual(['example.com/report', 'docs.example.com/start'])
  })

  it('keeps Markdown and quoting out of the address and ignores other schemes', () => {
    const links = extractBrowserLinks([
      'See [the docs](https://www.example.com/a), <https://example.org/b>, **https://example.net/c**, `https://example.io/d`,'
      + ' "https://example.dev/e" and ftp://example.com/f, javascript:alert(1), file:///etc/passwd, https://user:pw@example.com/x',
    ])
    expect(links.map((link) => link.url)).toEqual([
      'https://www.example.com/a',
      'https://example.org/b',
      'https://example.net/c',
      'https://example.io/d',
      'https://example.dev/e',
    ])
    expect(links[0].label).toBe('example.com/a')
  })

  it('stops at the link limit', () => {
    const text = Array.from({ length: 40 }, (_, index) => `https://example.com/${index}`).join(' ')
    const links = extractBrowserLinks([text])
    expect(links).toHaveLength(MAX_BROWSER_LINKS)
    expect(links.at(-1)?.url).toBe(`https://example.com/${MAX_BROWSER_LINKS - 1}`)
  })

  it('normalizes typed addresses to http(s) only', () => {
    expect(normalizeBrowserAddress('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserAddress('  localhost:3000/app ')).toBe('https://localhost:3000/app')
    expect(normalizeBrowserAddress('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173/')
    expect(() => normalizeBrowserAddress('   ')).toThrow('Enter a URL to browse.')
    for (const hostile of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/', 'blob:https://example.com/x']) {
      expect(() => normalizeBrowserAddress(hostile), hostile).toThrow('HTTP or HTTPS')
    }
    expect(() => normalizeBrowserAddress('https://user:pw@example.com/')).toThrow(/user name or password/)
    expect(() => normalizeBrowserAddress(`https://example.com/${'a'.repeat(2100)}`)).toThrow(/too long/)
  })
})
