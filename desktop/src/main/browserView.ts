import { WebContentsView, type WebPreferences } from 'electron'
import type { BrowserViewState, WorkspacePreviewBounds } from '../shared/bridge/types'
import { MAX_BROWSER_ERROR_LENGTH, MAX_BROWSER_TITLE_LENGTH, browserHttpUrl } from '../shared/bridge/validation'

/** In-memory partition (no `persist:` prefix) used by nothing else in the app. */
export const BROWSER_PARTITION = 'archon-browser'

export const BROWSER_WEB_PREFERENCES: Readonly<WebPreferences> = Object.freeze({
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  partition: BROWSER_PARTITION,
})

interface NavigationDetailsLike {
  readonly url: string
  readonly isMainFrame: boolean
  preventDefault(): void
}

interface DownloadItemLike {
  cancel(): void
}

/** Narrow structural types keep the policy testable without Electron. */
export interface BrowserSessionLike {
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(handler: () => boolean): void
  setDevicePermissionHandler?(handler: () => boolean): void
  on(event: 'will-download', listener: (event: { preventDefault(): void }, item: DownloadItemLike) => void): void
}

export interface BrowserWebContentsLike {
  readonly session: BrowserSessionLike
  readonly navigationHistory: {
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
  }
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  isDestroyed(): boolean
  reload(): void
  close(): void
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: string, listener: (...args: never[]) => void): void
}

export interface BrowserViewLike {
  readonly webContents: BrowserWebContentsLike
  setBounds(bounds: WorkspacePreviewBounds): void
}

export interface BrowserWindowLike {
  isDestroyed(): boolean
  readonly contentView: {
    addChildView(view: BrowserViewLike): void
    removeChildView(view: BrowserViewLike): void
  }
}

export interface BrowserViewControllerOptions {
  getWindow(): BrowserWindowLike | undefined
  /** Called with every state change, including the final `open: false`. */
  onState?(state: BrowserViewState): void
  /** Injected for tests; defaults to a real sandboxed WebContentsView. */
  createView?(preferences: Readonly<WebPreferences>): BrowserViewLike
}

const CLOSED_STATE: BrowserViewState = Object.freeze({
  open: false, url: '', title: '', canGoBack: false, canGoForward: false, loading: false, error: null,
})

/** Chromium's code for a navigation that was superseded or refused; not a page failure. */
const ERR_ABORTED = -3

function refuse(): never {
  throw new Error('The browser only opens http and https addresses')
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // Strip controls so a hostile page title cannot smuggle layout characters.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * Owns at most one in-app browser page. It renders in its own in-memory
 * partition with no preload, no Node and the sandbox on; it may only load or
 * navigate its main frame to http(s); it opens no windows, gets no permissions
 * and downloads nothing.
 */
export class BrowserViewController {
  private view: BrowserViewLike | undefined
  private pendingUrl = ''
  private lastError: string | null = null
  private readonly hardenedSessions = new WeakSet<BrowserSessionLike>()

  constructor(private readonly options: BrowserViewControllerOptions) {}

  get isOpen(): boolean {
    return this.view !== undefined
  }

  open(url: string, bounds: WorkspacePreviewBounds): BrowserViewState {
    const target = browserHttpUrl(url) ?? refuse()
    this.closeView(false)
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) throw new Error('No window is available for the browser')
    const view = this.options.createView
      ? this.options.createView(BROWSER_WEB_PREFERENCES)
      : new WebContentsView({ webPreferences: { ...BROWSER_WEB_PREFERENCES } }) as unknown as BrowserViewLike
    this.harden(view)
    view.setBounds(bounds)
    window.contentView.addChildView(view)
    this.view = view
    this.load(view, target)
    return this.state()
  }

  navigate(url: string): BrowserViewState {
    const target = browserHttpUrl(url) ?? refuse()
    const view = this.requireView()
    this.load(view, target)
    return this.state()
  }

  back(): BrowserViewState {
    const history = this.requireView().webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
    return this.state()
  }

  forward(): BrowserViewState {
    const history = this.requireView().webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
    return this.state()
  }

  reload(): BrowserViewState {
    const view = this.requireView()
    this.lastError = null
    view.webContents.reload()
    return this.state()
  }

  setBounds(bounds: WorkspacePreviewBounds): boolean {
    if (!this.view) return false
    this.view.setBounds(bounds)
    return true
  }

  close(): boolean {
    return this.closeView(true)
  }

  private closeView(notify: boolean): boolean {
    const view = this.view
    if (!view) return false
    this.view = undefined
    this.pendingUrl = ''
    this.lastError = null
    try {
      this.options.getWindow()?.contentView.removeChildView(view)
    } catch {
      // The window may already be gone during shutdown.
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      // The contents may already be destroyed.
    }
    if (notify) this.emit()
    return true
  }

  /** A snapshot of the current page for the renderer; never page content. */
  state(): BrowserViewState {
    const view = this.view
    if (!view) return CLOSED_STATE
    const contents = view.webContents
    try {
      if (contents.isDestroyed()) return CLOSED_STATE
      const current = browserHttpUrl(contents.getURL())
      return Object.freeze({
        open: true,
        url: current ?? browserHttpUrl(this.pendingUrl) ?? '',
        title: boundedText(contents.getTitle(), MAX_BROWSER_TITLE_LENGTH),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        loading: contents.isLoading(),
        error: this.lastError,
      })
    } catch {
      return CLOSED_STATE
    }
  }

  private requireView(): BrowserViewLike {
    if (!this.view) throw new Error('No browser page is open')
    return this.view
  }

  private load(view: BrowserViewLike, target: string): void {
    this.pendingUrl = target
    this.lastError = null
    // Load failures arrive through did-fail-load; the call itself returns at once.
    view.webContents.loadURL(target).catch(() => undefined)
  }

  private emit(): void {
    try {
      this.options.onState?.(this.state())
    } catch {
      // A closed or reloading renderer cannot receive state; that is not a browser failure.
    }
  }

  private harden(view: BrowserViewLike): void {
    const contents = view.webContents
    const session = contents.session
    if (!this.hardenedSessions.has(session)) {
      this.hardenedSessions.add(session)
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      session.setPermissionCheckHandler(() => false)
      session.setDevicePermissionHandler?.(() => false)
      session.on('will-download', (event, item) => {
        event.preventDefault()
        try { item.cancel() } catch { /* Already cancelled. */ }
      })
    }
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guardNavigation = (details: NavigationDetailsLike) => {
      if (details.isMainFrame && browserHttpUrl(details.url) === null) details.preventDefault()
    }
    const current = () => this.view === view
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.on('will-attach-webview', (event: { preventDefault(): void }) => event.preventDefault())
    const onChange = () => { if (current()) this.emit() }
    contents.on('did-start-loading', () => {
      if (!current()) return
      // A new load (link, back, forward) starts without the previous failure.
      this.lastError = null
      this.emit()
    })
    contents.on('did-stop-loading', onChange)
    contents.on('did-navigate', () => {
      if (!current()) return
      this.pendingUrl = ''
      this.emit()
    })
    contents.on('did-navigate-in-page', onChange)
    contents.on('page-title-updated', onChange)
    contents.on('did-fail-load', (_event: unknown, errorCode: number, errorDescription: string, _url: string, isMainFrame: boolean) => {
      if (!current() || !isMainFrame || errorCode === ERR_ABORTED) return
      this.lastError = boundedText(`The page could not be loaded (${errorDescription || errorCode}).`, MAX_BROWSER_ERROR_LENGTH)
      this.emit()
    })
    contents.on('render-process-gone', () => { if (current()) this.close() })
  }
}
