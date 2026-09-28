// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BrowserViewState } from '../shared/bridge/types'
import { BROWSER_CHANNELS } from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import { registerBrowserView, sendBrowserState, type BrowserViewIpcController } from './registerBrowserView'

const state: BrowserViewState = { open: true, url: 'https://example.com/', title: 'Example', canGoBack: false, canGoForward: false, loading: false, error: null }
const bounds = { x: 0, y: 0, width: 400, height: 300 }

function setup(trusted = true) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const ipc: IpcRegistrar = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    removeHandler: (channel) => { handlers.delete(channel) },
  }
  const controller = {
    open: vi.fn(() => state),
    navigate: vi.fn(() => state),
    back: vi.fn(() => state),
    forward: vi.fn(() => state),
    reload: vi.fn(() => state),
    setBounds: vi.fn(() => true),
    close: vi.fn(() => true),
  } satisfies BrowserViewIpcController
  const openExternal = vi.fn(async () => undefined)
  const beforeOpen = vi.fn()
  const guard = vi.fn(() => { if (!trusted) throw new Error('Untrusted IPC sender') })
  const unregister = registerBrowserView({ ipc, guard, controller: () => controller, beforeOpen, openExternal })
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {} }, ...args)
  return { handlers, controller, openExternal, beforeOpen, guard, unregister, call }
}

describe('browser view IPC registration', () => {
  it('registers the fixed invoke channels and removes them again', () => {
    const { handlers, unregister } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(BROWSER_CHANNELS).filter((channel) => channel !== BROWSER_CHANNELS.state).sort())
    unregister()
    expect(handlers.size).toBe(0)
  })

  it('refuses every channel from an untrusted frame before touching the view', async () => {
    const { handlers, controller, openExternal, call } = setup(false)
    const payloads: Record<string, unknown> = {
      [BROWSER_CHANNELS.open]: { url: 'https://example.com/', bounds },
      [BROWSER_CHANNELS.navigate]: { url: 'https://example.com/' },
      [BROWSER_CHANNELS.openExternal]: { url: 'https://example.com/' },
      [BROWSER_CHANNELS.bounds]: bounds,
    }
    for (const channel of handlers.keys()) {
      await expect(call(channel, payloads[channel] ?? {})).rejects.toThrow(/untrusted/i)
    }
    for (const method of Object.values(controller)) expect(method).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('refuses hostile and malformed payloads before touching the view', async () => {
    const { controller, openExternal, beforeOpen, call } = setup()
    await expect(call(BROWSER_CHANNELS.open, { url: 'javascript:alert(1)', bounds })).rejects.toThrow(TypeError)
    await expect(call(BROWSER_CHANNELS.open, { url: 'https://example.com/', bounds, preload: '/tmp/evil.js' })).rejects.toThrow(TypeError)
    await expect(call(BROWSER_CHANNELS.navigate, { url: 'file:///etc/passwd' })).rejects.toThrow(TypeError)
    await expect(call(BROWSER_CHANNELS.navigate, { url: `https://example.com/${'a'.repeat(4000)}` })).rejects.toThrow(TypeError)
    await expect(call(BROWSER_CHANNELS.openExternal, { url: 'smb://host/share' })).rejects.toThrow(TypeError)
    await expect(call(BROWSER_CHANNELS.openExternal, { url: 'https://example.com/' }, { url: 'file:///' })).rejects.toThrow(TypeError)
    await expect(call(BROWSER_CHANNELS.bounds, { ...bounds, width: -1 })).rejects.toThrow(TypeError)
    await expect(call(BROWSER_CHANNELS.back, { steps: 5 })).rejects.toThrow(TypeError)
    await expect(call(BROWSER_CHANNELS.open, { url: 'https://example.com/', bounds: 'x'.repeat(70_000) })).rejects.toThrow(TypeError)
    for (const method of Object.values(controller)) expect(method).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(beforeOpen).not.toHaveBeenCalled()
  })

  it('forwards canonical requests and closes the service preview before opening', async () => {
    const { controller, openExternal, beforeOpen, call } = setup()
    await expect(call(BROWSER_CHANNELS.open, { url: 'https://Example.com', bounds })).resolves.toEqual(state)
    expect(beforeOpen).toHaveBeenCalledBefore(controller.open)
    expect(controller.open).toHaveBeenCalledWith('https://example.com/', bounds)
    await expect(call(BROWSER_CHANNELS.navigate, { url: 'http://localhost:3000/a' })).resolves.toEqual(state)
    expect(controller.navigate).toHaveBeenCalledWith('http://localhost:3000/a')
    await expect(call(BROWSER_CHANNELS.back, {})).resolves.toEqual(state)
    await expect(call(BROWSER_CHANNELS.forward, {})).resolves.toEqual(state)
    await expect(call(BROWSER_CHANNELS.reload, {})).resolves.toEqual(state)
    await expect(call(BROWSER_CHANNELS.bounds, bounds)).resolves.toBe(true)
    await expect(call(BROWSER_CHANNELS.close, {})).resolves.toBe(true)
    await expect(call(BROWSER_CHANNELS.openExternal, { url: 'https://example.com/docs' })).resolves.toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('refuses a controller state that would carry a non-web address to the renderer', async () => {
    const { controller, call } = setup()
    controller.reload.mockReturnValueOnce({ ...state, url: 'file:///etc/passwd' })
    await expect(call(BROWSER_CHANNELS.reload, {})).rejects.toThrow(TypeError)
  })

  it('relays only validated state to a live window', () => {
    const send = vi.fn()
    const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    sendBrowserState(window, state)
    sendBrowserState(window, { ...state, url: 'javascript:alert(1)' })
    sendBrowserState({ ...window, isDestroyed: () => true }, state)
    sendBrowserState(undefined, state)
    expect(send.mock.calls).toEqual([[BROWSER_CHANNELS.state, state]])
  })
})
