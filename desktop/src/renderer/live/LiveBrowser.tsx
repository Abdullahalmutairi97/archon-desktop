import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { BrowserViewBridge, BrowserViewState, WorkspacePreviewBounds } from '../../shared/bridge/types'
import { Icon } from '../shell/Icon'
import { normalizeBrowserAddress, type BrowserLink } from './browserLinks'
import './LiveBrowser.css'

/**
 * Bounds of the page surface, clipped to the scrolling workbench so the native
 * view never covers anything outside it. Null when nothing is visible.
 */
function surfaceBounds(surface: HTMLElement): WorkspacePreviewBounds | null {
  const rect = surface.getBoundingClientRect()
  const clip = surface.closest('.live-bench-content')?.getBoundingClientRect()
  const left = Math.max(rect.left, clip?.left ?? rect.left)
  const top = Math.max(rect.top, clip?.top ?? rect.top)
  const right = Math.min(rect.right, clip?.right ?? rect.right)
  const bottom = Math.min(rect.bottom, clip?.bottom ?? rect.bottom)
  const width = Math.round(right - left)
  const height = Math.round(bottom - top)
  if (width < 1 || height < 1) return null
  return { x: Math.round(left), y: Math.round(top), width, height }
}

/** A scrolled-away surface still needs a valid rectangle; this one lies outside the window. */
const HIDDEN_BOUNDS: WorkspacePreviewBounds = { x: -2, y: -2, width: 1, height: 1 }

/**
 * The workbench browser: links from this conversation as one-click sources, an
 * address bar, and one page rendered by main in a sandboxed native view laid
 * over the surface below. The page is closed whenever this panel unmounts.
 */
export function LiveBrowser({ bridge, links }: { bridge: BrowserViewBridge | undefined; links: readonly BrowserLink[] }) {
  const [address, setAddress] = useState('')
  const [page, setPage] = useState<BrowserViewState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const surface = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(false)
  const pageOpen = useRef(false)
  const lastUrl = useRef('')
  const serial = useRef(0)

  const apply = useCallback((state: BrowserViewState) => {
    if (!state.open) {
      pageOpen.current = false
      lastUrl.current = ''
      setPage(null)
      return
    }
    pageOpen.current = true
    setPage(state)
    // Follow the page's own navigations without overwriting what is being typed.
    if (state.url && state.url !== lastUrl.current) {
      lastUrl.current = state.url
      setAddress(state.url)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    if (!bridge) return () => { mounted.current = false }
    let unsubscribe = (): void => undefined
    try {
      unsubscribe = bridge.subscribe((state) => { if (mounted.current) apply(state) })
    } catch {
      // Without events the address still follows each call's result.
    }
    return () => {
      mounted.current = false
      pageOpen.current = false
      unsubscribe()
      void bridge.close().catch(() => undefined)
    }
  }, [bridge, apply])

  const isOpen = page !== null
  useEffect(() => {
    if (!bridge || !isOpen) return
    const box = surface.current
    if (!box) return
    const send = (): void => {
      void bridge.bounds(surfaceBounds(box) ?? HIDDEN_BOUNDS).catch(() => undefined)
    }
    const observer = new ResizeObserver(send)
    observer.observe(box)
    window.addEventListener('resize', send)
    // The workbench scrolls; keep the native view over its placeholder.
    window.addEventListener('scroll', send, true)
    send()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', send)
      window.removeEventListener('scroll', send, true)
    }
  }, [bridge, isOpen])

  async function run(action: () => Promise<BrowserViewState>, failure: string): Promise<void> {
    const id = ++serial.current
    setBusy(true)
    try {
      const state = await action()
      if (!mounted.current) {
        // The panel went away while the page was opening; never leave it on screen.
        void bridge?.close().catch(() => undefined)
        return
      }
      if (id === serial.current) apply(state)
    } catch {
      if (mounted.current && id === serial.current) setError(failure)
    } finally {
      if (mounted.current && id === serial.current) setBusy(false)
    }
  }

  function go(value: string): void {
    if (!bridge) return
    let url: string
    try {
      url = normalizeBrowserAddress(value)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Enter a valid web address.')
      return
    }
    setError('')
    setAddress(url)
    lastUrl.current = url
    const box = surface.current
    void run(async () => {
      if (pageOpen.current) {
        try {
          return await bridge.navigate({ url })
        } catch {
          // Main may have closed the page (another native view opened); open it again.
        }
      }
      const bounds = box ? surfaceBounds(box) : null
      if (!bounds) throw new Error('The browser surface is not visible')
      return bridge.open({ url, bounds })
    }, 'The browser could not open that address.')
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    go(address)
  }

  function openExternally(): void {
    const url = page?.url
    if (!bridge || !url) return
    setError('')
    void bridge.openExternal({ url }).catch(() => {
      if (mounted.current) setError('The system browser could not be opened.')
    })
  }

  if (!bridge) {
    return <p className="live-bench-empty" role="status">The in-app browser needs the current desktop preload, which this window does not have. Restart Archon Desktop to use it.</p>
  }

  const shownError = error || page?.error || ''
  return <section className="live-browser" aria-label="Browser">
    <div className="live-browser-toolbar">
      <button type="button" className="live-browser-back" aria-label="Go back" title="Go back" disabled={!page?.canGoBack || busy} onClick={() => { void run(() => bridge.back(), 'The browser could not go back.') }}><Icon name="chevron" /></button>
      <button type="button" className="live-browser-forward" aria-label="Go forward" title="Go forward" disabled={!page?.canGoForward || busy} onClick={() => { void run(() => bridge.forward(), 'The browser could not go forward.') }}><Icon name="chevron" /></button>
      <button type="button" aria-label="Reload page" title="Reload page" disabled={!page || busy} onClick={() => { void run(() => bridge.reload(), 'The browser could not reload the page.') }}>↻</button>
      <form className="live-browser-address" onSubmit={submit}>
        <input aria-label="Browser address" dir="ltr" value={address} onChange={(event) => setAddress(event.currentTarget.value)} placeholder="Enter a URL from the agent’s work…" spellCheck={false} autoComplete="off" />
        <button type="submit" aria-label="Open URL" title="Open URL">Go</button>
      </form>
      <button type="button" aria-label="Open in system browser" title="Open in system browser" disabled={!page?.url} onClick={openExternally}>↗</button>
    </div>
    {page && <p className="live-browser-status" dir="auto">{page.loading ? 'Loading… ' : ''}{page.title || page.url}</p>}
    {shownError && <p className="live-browser-error" role="alert">{shownError}</p>}
    {links.length > 0
      ? <div className="live-browser-sources">
        <div className="live-browser-sources-heading"><span>Links from this conversation</span><small>{links.length}</small></div>
        <ul>
          {links.map((link) => <li key={link.url}>
            <button type="button" title={link.url} onClick={() => go(link.url)} disabled={busy}><span dir="ltr">{link.label}</span></button>
          </li>)}
        </ul>
      </div>
      : <p className="live-browser-note">Links in this conversation’s replies will appear here.</p>}
    <div ref={surface} className={`live-browser-surface${page ? ' open' : ''}`} aria-label="Browser page">
      {!page && <div className="live-browser-empty"><Icon name="browser" /><b>Open a result in the browser</b><span>Pages open in a separate sandbox with no access to Archon.</span></div>}
    </div>
  </section>
}
