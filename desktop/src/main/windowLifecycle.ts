export interface WindowCloseEventLike {
  preventDefault(): void
}

export interface MinimizableWindowLike {
  minimize(): void
}

/** Keep the main process and its local Codex child alive when the user closes a busy window. */
export function minimizeInsteadOfClosingForActiveWork(
  event: WindowCloseEventLike,
  window: MinimizableWindowLike,
  hasActiveWork: boolean,
  quitRequested: boolean,
): boolean {
  if (!hasActiveWork || quitRequested) return false
  event.preventDefault()
  window.minimize()
  return true
}
