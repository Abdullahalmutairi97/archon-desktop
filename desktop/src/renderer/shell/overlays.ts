import { useEffect, useSyncExternalStore } from 'react'

/**
 * Native views (the browser page, a service preview) are drawn above the whole
 * window, so they would cover any dialog or palette. While an overlay is open,
 * those views shrink out of the way; they come back when the last one closes.
 */
let open = 0
const listeners = new Set<() => void>()

function notify(): void { for (const listener of listeners) listener() }

export function subscribeOverlays(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function overlayOpen(): boolean { return open > 0 }

/** Mark an overlay open for as long as the calling component is mounted (and `active`). */
export function useOverlay(active = true): void {
  useEffect(() => {
    if (!active) return
    open += 1
    notify()
    return () => { open -= 1; notify() }
  }, [active])
}

/** Whether any overlay is open; re-renders when that changes. */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribeOverlays, overlayOpen, () => false)
}
