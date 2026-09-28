import type { BrowserViewState, WorkspacePreviewBounds } from '../shared/bridge/types'
import { BROWSER_CHANNELS, browserHttpUrl, parseBrowserRequest, parseBrowserResponse, parseBrowserState } from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import { assertBoundedIpcPayload } from './security/TrustedShellFrameGuard'

export interface BrowserViewIpcController {
  open(url: string, bounds: WorkspacePreviewBounds): BrowserViewState
  navigate(url: string): BrowserViewState
  back(): BrowserViewState
  forward(): BrowserViewState
  reload(): BrowserViewState
  setBounds(bounds: WorkspacePreviewBounds): boolean
  close(): boolean
}

interface BrowserStateWindowLike {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
  }
}

export interface RegisterBrowserViewOptions {
  ipc: IpcRegistrar
  guard(event: unknown): boolean | void
  /** Resolves the controller at call time so a missing one fails closed. */
  controller(): BrowserViewIpcController | undefined
  /** Close anything else drawn natively over the app (the service preview) first. */
  beforeOpen?(): void
  openExternal(url: string): Promise<void>
}

const channels = Object.freeze(Object.values(BROWSER_CHANNELS).filter((channel) => channel !== BROWSER_CHANNELS.state))

function assertTrusted(guard: RegisterBrowserViewOptions['guard'], event: unknown): void {
  if (guard(event) === false) throw new Error('Untrusted desktop frame')
}

function requireController(options: RegisterBrowserViewOptions): BrowserViewIpcController {
  const controller = options.controller()
  if (!controller) throw new Error('The browser is unavailable')
  return controller
}

/** Relay one validated state frame to the app window; nothing else is sent. */
export function sendBrowserState(window: BrowserStateWindowLike | undefined, state: BrowserViewState): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  let safe: BrowserViewState
  try {
    safe = parseBrowserState(state)
  } catch {
    return
  }
  window.webContents.send(BROWSER_CHANNELS.state, safe)
}

/** Fixed main-process IPC surface for the sandboxed in-app browser view. */
export function registerBrowserView(options: RegisterBrowserViewOptions): () => void {
  const handle = (channel: string, run: (input: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>) => {
    options.ipc.handle(channel, async (event, ...args) => {
      assertTrusted(options.guard, event)
      assertBoundedIpcPayload(args)
      const input = parseBrowserRequest(channel, args)
      const result = await run(input)
      return parseBrowserResponse(channel, result)
    })
  }

  handle(BROWSER_CHANNELS.open, (input) => {
    const controller = requireController(options)
    options.beforeOpen?.()
    return controller.open(input.url as string, input.bounds as WorkspacePreviewBounds)
  })
  handle(BROWSER_CHANNELS.navigate, (input) => requireController(options).navigate(input.url as string))
  handle(BROWSER_CHANNELS.back, () => requireController(options).back())
  handle(BROWSER_CHANNELS.forward, () => requireController(options).forward())
  handle(BROWSER_CHANNELS.reload, () => requireController(options).reload())
  handle(BROWSER_CHANNELS.bounds, (input) => options.controller()?.setBounds(input.bounds as WorkspacePreviewBounds) ?? false)
  handle(BROWSER_CHANNELS.close, () => options.controller()?.close() ?? false)
  handle(BROWSER_CHANNELS.openExternal, async (input) => {
    // Re-check at the edge: only http(s) ever reaches the system browser.
    const url = browserHttpUrl(input.url)
    if (!url) throw new Error('Only http and https addresses can be opened')
    await options.openExternal(url)
    return true
  })

  return () => { for (const channel of channels) options.ipc.removeHandler(channel) }
}
