import type { BrowserViewBridge, BrowserViewState } from '../shared/bridge/types'
import { BROWSER_CHANNELS, parseBrowserRequest, parseBrowserResponse, parseBrowserState } from '../shared/bridge/validation'
import type { LocalCodexIpcInvoker } from './localCodexBridge'

function invoke<T>(ipc: LocalCodexIpcInvoker, channel: string, input: unknown): Promise<T> {
  const request = parseBrowserRequest(channel, [input])
  return ipc.invoke(channel, request).then((value) => parseBrowserResponse(channel, value) as T)
}

/** Renderer-visible browser methods are finite; main re-validates every address. */
export function createBrowserBridge(ipc: LocalCodexIpcInvoker): BrowserViewBridge {
  return Object.freeze({
    open: (input: Parameters<BrowserViewBridge['open']>[0]) => invoke<BrowserViewState>(ipc, BROWSER_CHANNELS.open, input),
    navigate: (input: Parameters<BrowserViewBridge['navigate']>[0]) => invoke<BrowserViewState>(ipc, BROWSER_CHANNELS.navigate, input),
    back: () => invoke<BrowserViewState>(ipc, BROWSER_CHANNELS.back, {}),
    forward: () => invoke<BrowserViewState>(ipc, BROWSER_CHANNELS.forward, {}),
    reload: () => invoke<BrowserViewState>(ipc, BROWSER_CHANNELS.reload, {}),
    bounds: (input: Parameters<BrowserViewBridge['bounds']>[0]) => invoke<boolean>(ipc, BROWSER_CHANNELS.bounds, input),
    close: () => invoke<boolean>(ipc, BROWSER_CHANNELS.close, {}),
    openExternal: (input: Parameters<BrowserViewBridge['openExternal']>[0]) => invoke<boolean>(ipc, BROWSER_CHANNELS.openExternal, input),
    subscribe: (listener: (state: BrowserViewState) => void): (() => void) => {
      if (typeof listener !== 'function' || !ipc.on || !ipc.removeListener) {
        throw new TypeError('Browser state subscription is unavailable.')
      }
      const onState = (_event: unknown, ...args: unknown[]) => {
        if (args.length !== 1) return
        let state: BrowserViewState
        try {
          state = parseBrowserState(args[0])
        } catch {
          return
        }
        listener(state)
      }
      ipc.on(BROWSER_CHANNELS.state, onState)
      let active = true
      return () => {
        if (!active) return
        active = false
        ipc.removeListener?.(BROWSER_CHANNELS.state, onState)
      }
    },
  }) satisfies BrowserViewBridge
}
