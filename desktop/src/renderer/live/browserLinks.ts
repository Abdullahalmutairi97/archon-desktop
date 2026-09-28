import { browserHttpUrl, MAX_BROWSER_URL_LENGTH } from '../../shared/bridge/validation'

export type BrowserLink = { url: string; label: string }

/** Links offered from one conversation. */
export const MAX_BROWSER_LINKS = 24
/** Characters of any one text searched for links, so a huge reply stays cheap. */
const MAX_SCANNED_CHARACTERS = 100_000

const LINK_PATTERN = /https?:\/\/[^\s<>)\]"'`]+/giu

/**
 * Find ordinary web links in agent output while keeping the browser URL-only:
 * http/https only, trailing punctuation trimmed, deduplicated, at most 24, in
 * the order the texts are given.
 */
export function extractBrowserLinks(texts: readonly (string | null | undefined)[]): BrowserLink[] {
  const links: BrowserLink[] = []
  const seen = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const match of text.slice(0, MAX_SCANNED_CHARACTERS).matchAll(LINK_PATTERN)) {
      const url = browserHttpUrl(match[0].replace(/[.,;:!?*_~]+$/u, ''))
      if (!url || seen.has(url)) continue
      seen.add(url)
      const parsed = new URL(url)
      links.push({ url, label: parsed.hostname.replace(/^www\./u, '') + (parsed.pathname !== '/' ? parsed.pathname : '') })
      if (links.length >= MAX_BROWSER_LINKS) return links
    }
  }
  return links
}

/**
 * Turn what was typed in the address bar into a web address:
 * `example.com` becomes `https://example.com/`; only http and https load.
 */
export function normalizeBrowserAddress(value: string): string {
  const candidate = value.trim()
  if (!candidate) throw new Error('Enter a URL to browse.')
  if (candidate.length > MAX_BROWSER_URL_LENGTH) throw new Error('That address is too long.')
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(candidate)
  // `javascript:…`, `data:…`, `mailto:…` name a scheme without `//`; `localhost:3000` does not.
  if (!hasScheme && /^[a-z][a-z\d+.-]*:(?!\d)/iu.test(candidate)) throw new Error('Browser URLs must use HTTP or HTTPS.')
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? candidate : `https://${candidate}`)
  } catch {
    throw new Error('Enter a valid web address.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Browser URLs must use HTTP or HTTPS.')
  if (parsed.username || parsed.password) throw new Error('Enter a web address without a user name or password.')
  const url = browserHttpUrl(parsed.href)
  if (!url) throw new Error('Enter a valid web address.')
  return url
}
