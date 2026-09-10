import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, Globe, LinkSimple, MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { Task } from '../lib/types'

type BrowserLink = { url: string; label: string; taskId: string }

/** Find ordinary web links in agent output while keeping the browser URL-only. */
export function extractBrowserLinks(tasks: Task[]): BrowserLink[] {
  const links: BrowserLink[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    const text = `${task.result?.text || ''}\n${task.prompt || ''}`
    for (const match of text.matchAll(/https?:\/\/[^\s<>)\]"']+/gi)) {
      const raw = match[0].replace(/[.,;:!?]+$/, '')
      try {
        const parsed = new URL(raw)
        if (!['http:', 'https:'].includes(parsed.protocol)) continue
        const url = parsed.toString()
        if (seen.has(url)) continue
        seen.add(url)
        links.push({ url, label: parsed.hostname.replace(/^www\./, '') + (parsed.pathname !== '/' ? parsed.pathname : ''), taskId: task.id })
      } catch { /* Ignore malformed text that only resembles a URL. */ }
    }
  }
  return links.slice(0, 24)
}

function normalizeUrl(value: string): string {
  const candidate = value.trim()
  if (!candidate) throw new Error('Enter a URL to browse.')
  const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Browser URLs must use HTTP or HTTPS.')
  return parsed.toString()
}

export function BrowserPanel({ tasks }: { tasks: Task[] }) {
  const links = useMemo(() => extractBrowserLinks(tasks), [tasks])
  const [address, setAddress] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    if (history.length || !links.length) return
    setAddress(links[0].url)
    setHistory([links[0].url])
    setHistoryIndex(0)
  }, [history.length, links])

  const currentUrl = historyIndex >= 0 ? history[historyIndex] : ''
  const navigate = (value: string, replace = false) => {
    try {
      const url = normalizeUrl(value)
      setError('')
      setAddress(url)
      setLoading(true)
      if (replace && historyIndex >= 0) {
        setHistory((items) => items.map((item, index) => index === historyIndex ? url : item))
      } else {
        setHistory((items) => [...items.slice(0, historyIndex + 1), url])
        setHistoryIndex((index) => index + 1)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const moveHistory = (delta: number) => {
    const next = historyIndex + delta
    if (next < 0 || next >= history.length) return
    setHistoryIndex(next)
    setAddress(history[next])
    setError('')
    setLoading(true)
  }

  return <section className="browser-panel" aria-label="Agent browser">
    <header className="browser-toolbar">
      <button aria-label="Go back" title="Go back" disabled={historyIndex <= 0} onClick={() => moveHistory(-1)}><ArrowLeft/></button>
      <button aria-label="Go forward" title="Go forward" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => moveHistory(1)}><ArrowRight/></button>
      <button aria-label="Reload page" title="Reload page" disabled={!currentUrl} onClick={() => { setLoading(true); setReloadNonce((value) => value + 1) }}><ArrowClockwise className={loading ? 'browser-spin' : ''}/></button>
      <form className="browser-address" onSubmit={(event) => { event.preventDefault(); navigate(address) }}>
        <Globe/><input aria-label="Browser address" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Enter a URL from the agent’s work…" spellCheck={false}/><button aria-label="Open URL" type="submit"><MagnifyingGlass/></button>
      </form>
      <button aria-label="Open in system browser" title="Open in system browser" disabled={!currentUrl} onClick={() => { if (currentUrl) void window.archon?.openExternal(currentUrl) }}><ArrowSquareOut/></button>
    </header>
    {error && <p className="browser-error" role="alert">{error}</p>}
    {links.length > 0 && <div className="browser-sources"><div className="browser-sources-heading"><LinkSimple/><span>Links from agent work</span><small>{links.length}</small></div><div className="browser-source-list">{links.map((link) => <button key={`${link.taskId}:${link.url}`} title={link.url} onClick={() => navigate(link.url)}><span>{link.label}</span><ArrowSquareOut/></button>)}</div></div>}
    <div className={`browser-view${currentUrl ? '' : ' empty'}`}>
      {currentUrl ? <iframe key={`${currentUrl}:${reloadNonce}`} title={`Browser preview of ${currentUrl}`} src={currentUrl} sandbox="allow-forms allow-modals allow-popups allow-presentation allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={() => setLoading(false)}/> : <div className="browser-empty"><Globe/><b>Open a result in the browser</b><span>Links found in agent task output will appear above.</span></div>}
    </div>
  </section>
}
