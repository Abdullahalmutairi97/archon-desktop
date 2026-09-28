// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BrowserViewState } from '../shared/bridge/types'
import { BROWSER_PARTITION, BrowserViewController, type BrowserViewLike, type BrowserWindowLike } from './browserView'

type Listener = (...args: never[]) => void

function fakeSession() {
  const listeners = new Map<string, Listener>()
  return {
    listeners,
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => { listeners.set(event, listener) }),
  }
}

function fakeView(session = fakeSession()) {
  const listeners = new Map<string, Listener>()
  let url = ''
  let windowOpenHandler: (() => { action: 'deny' }) | undefined
  const webContents = {
    session,
    navigationHistory: {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
    loadURL: vi.fn(async (next: string) => { url = next }),
    getURL: () => url,
    getTitle: () => 'Example\u202e page',
    isLoading: () => false,
    isDestroyed: vi.fn(() => false),
    reload: vi.fn(),
    close: vi.fn(),
    setWindowOpenHandler: vi.fn((handler: () => { action: 'deny' }) => { windowOpenHandler = handler }),
    on: vi.fn((event: string, listener: Listener) => { listeners.set(event, listener) }),
  }
  const view = { webContents, setBounds: vi.fn() }
  return {
    view,
    webContents,
    session,
    listeners,
    fire: (event: string, ...args: unknown[]) => (listeners.get(event) as ((...values: unknown[]) => void) | undefined)?.(...args),
    windowOpen: () => windowOpenHandler?.(),
  }
}

function setup() {
  const session = fakeSession()
  const views: ReturnType<typeof fakeView>[] = []
  const window = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  } satisfies BrowserWindowLike
  const states: BrowserViewState[] = []
  const createView = vi.fn((_preferences: Readonly<Record<string, unknown>>) => {
    const created = fakeView(session)
    views.push(created)
    return created.view as unknown as BrowserViewLike
  })
  const controller = new BrowserViewController({ getWindow: () => window, onState: (state) => states.push(state), createView })
  return { controller, window, views, session, states, createView }
}

const bounds = { x: 10, y: 20, width: 400, height: 300 }

function navigationEvent(url: string, isMainFrame = true) {
  return { url, isMainFrame, preventDefault: vi.fn() }
}

describe('in-app browser view controller', () => {
  it('creates a sandboxed view in its own in-memory partition with no preload', () => {
    const { controller, createView, window, views } = setup()
    const state = controller.open('https://example.com/docs', bounds)

    const preferences = createView.mock.calls[0][0]
    expect(preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, partition: BROWSER_PARTITION })
    expect(BROWSER_PARTITION.startsWith('persist:')).toBe(false)
    expect(preferences).not.toHaveProperty('preload')
    expect(window.contentView.addChildView).toHaveBeenCalledWith(views[0].view)
    expect(views[0].view.setBounds).toHaveBeenCalledWith(bounds)
    expect(views[0].webContents.loadURL).toHaveBeenCalledWith('https://example.com/docs')
    expect(state).toMatchObject({ open: true, url: 'https://example.com/docs', canGoBack: true, canGoForward: false })
    // Bidi and control characters in a page title are neutralized.
    expect(state.title).toBe('Example  page')
  })

  it('refuses to load or navigate to anything but http(s)', () => {
    const { controller, createView, views } = setup()
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'blob:https://example.com/x', 'about:blank']) {
      expect(() => controller.open(url, bounds)).toThrow(/http and https/)
    }
    expect(createView).not.toHaveBeenCalled()
    expect(() => controller.navigate('https://example.com/')).toThrow(/No browser page/)

    controller.open('https://example.com/', bounds)
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://gpu']) {
      expect(() => controller.navigate(url)).toThrow(/http and https/)
    }
    expect(views[0].webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('blocks main-frame navigations and redirects that leave http(s)', () => {
    const { controller, views } = setup()
    controller.open('https://example.com/', bounds)
    const { fire } = views[0]
    for (const event of ['will-navigate', 'will-redirect']) {
      for (const hostile of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'blob:https://example.com/x']) {
        const details = navigationEvent(hostile)
        fire(event, details)
        expect(details.preventDefault).toHaveBeenCalled()
      }
      const allowed = navigationEvent('https://example.org/next')
      fire(event, allowed)
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }
  })

  it('denies new windows and every permission, and cancels downloads', () => {
    const { controller, views, session } = setup()
    controller.open('https://example.com/', bounds)

    expect(views[0].windowOpen()).toEqual({ action: 'deny' })
    const requestHandler = session.setPermissionRequestHandler.mock.calls[0][0] as (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
    const callback = vi.fn()
    for (const permission of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read']) requestHandler({}, permission, callback)
    expect(callback.mock.calls.every(([granted]) => granted === false)).toBe(true)
    expect((session.setPermissionCheckHandler.mock.calls[0][0] as () => boolean)()).toBe(false)
    expect((session.setDevicePermissionHandler.mock.calls[0][0] as () => boolean)()).toBe(false)

    const download = { preventDefault: vi.fn() }
    const item = { cancel: vi.fn() }
    ;(session.listeners.get('will-download') as unknown as (event: unknown, item: unknown) => void)(download, item)
    expect(download.preventDefault).toHaveBeenCalled()
    expect(item.cancel).toHaveBeenCalled()

    // The shared session is hardened once, not once per page.
    controller.open('https://example.org/', bounds)
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(session.on).toHaveBeenCalledTimes(1)
  })

  it('keeps one view at a time and reports closure', () => {
    const { controller, views, window, states } = setup()
    controller.open('https://example.com/', bounds)
    controller.open('https://example.org/', bounds)
    expect(views).toHaveLength(2)
    expect(views[0].webContents.close).toHaveBeenCalled()
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(views[0].view)
    expect(controller.isOpen).toBe(true)

    // Events from the replaced page no longer reach the renderer.
    states.length = 0
    views[0].fire('did-stop-loading')
    expect(states).toEqual([])

    expect(controller.close()).toBe(true)
    expect(views[1].webContents.close).toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({ open: false, url: '' })
    expect(controller.close()).toBe(false)
    expect(controller.setBounds(bounds)).toBe(false)
    expect(() => controller.back()).toThrow(/No browser page/)
  })

  it('reports main-frame load failures but not superseded navigations', () => {
    const { controller, views, states } = setup()
    controller.open('https://example.invalid/', bounds)
    views[0].fire('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.invalid/', true)
    views[0].fire('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.example/', false)
    expect(states).toEqual([])
    views[0].fire('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.invalid/', true)
    expect(states.at(-1)).toMatchObject({ open: true, error: 'The page could not be loaded (ERR_NAME_NOT_RESOLVED).' })
    // The next load (a link, back or forward) starts without the old failure.
    views[0].fire('did-start-loading')
    expect(states.at(-1)).toMatchObject({ open: true, error: null })
  })

  it('goes back, forward and reloads only through navigation history', () => {
    const { controller, views } = setup()
    controller.open('https://example.com/', bounds)
    controller.back()
    controller.forward()
    controller.reload()
    expect(views[0].webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    // canGoForward is false in the fake, so forward is a no-op.
    expect(views[0].webContents.navigationHistory.goForward).not.toHaveBeenCalled()
    expect(views[0].webContents.reload).toHaveBeenCalledTimes(1)
  })
})
