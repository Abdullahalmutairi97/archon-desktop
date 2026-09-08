export function waitForReconnect(signal: AbortSignal, delayMs = 1000): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, delayMs)
    const onAbort = () => { window.clearTimeout(timer); done() }
    function done() {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
