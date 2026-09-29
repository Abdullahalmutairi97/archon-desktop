import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { DesktopBridge } from '../../shared/bridge/types'
import { operationErrorCode } from '../live/liveModels'
import type { LiveScope } from '../live/useLiveServer'
import './Operations.css'

/** Honest, code-based error text. Server detail strings never reach the renderer. */
export function operationsErrorText(error: unknown, mutation = false): string {
  switch (operationErrorCode(error)) {
    case 'unauthorized': return 'The server rejected this request. Check the saved token in Connection.'
    case 'not_connected': return 'No server connection is configured.'
    case 'connection_changed': return 'The server connection changed while this request was running; its result was discarded.'
    case 'invalid_payload': return 'The request was refused before sending: a value is invalid or too large.'
    case 'invalid_response':
    case 'response_too_large':
      return mutation
        ? 'The server response could not be verified. The change may or may not have been applied; refresh before retrying.'
        : 'The server returned a response this app could not verify. Nothing from it is shown.'
    case 'network_error':
      return mutation
        ? 'Could not confirm the outcome: the server may have applied the change. Refresh before retrying.'
        : 'Could not reach the configured server.'
    case 'http_error': return 'The server could not complete the request.'
    default: return mutation ? 'The change failed or its outcome is unknown. Refresh before retrying.' : 'The request failed.'
  }
}

export type OpsResource<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: string }

type Stored<T> = { generation: number; value: OpsResource<T> }

const LOADING = { status: 'loading', data: null, error: null } as const

/**
 * Load one read-only resource for the current connection scope. Responses
 * that arrive after the scope's generation changed, or after unmount, are dropped.
 */
export function useOpsResource<T>(scope: LiveScope, load: (bridge: DesktopBridge) => Promise<T>, pollMs?: number): {
  resource: OpsResource<T>
  reload(): void
  replace(data: T): void
} {
  const loadRef = useRef(load)
  loadRef.current = load
  const [stored, setStored] = useState<Stored<T> | null>(null)
  const [reloadCount, setReloadCount] = useState(0)
  const { bridge, generation } = scope

  useEffect(() => {
    let current = true
    let inFlight = false
    const run = () => {
      if (inFlight) return
      inFlight = true
      void Promise.resolve().then(() => loadRef.current(bridge)).then((data) => {
        if (current) setStored({ generation, value: { status: 'ready', data, error: null } })
      }).catch((error: unknown) => {
        if (current) setStored({ generation, value: { status: 'error', data: null, error: operationsErrorText(error) } })
      }).finally(() => { inFlight = false })
    }
    run()
    const timer = pollMs ? window.setInterval(run, pollMs) : undefined
    return () => {
      current = false
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [bridge, generation, reloadCount, pollMs])

  const reload = useCallback(() => setReloadCount((value) => value + 1), [])
  const replace = useCallback((data: T) => setStored({ generation, value: { status: 'ready', data, error: null } }), [generation])
  const resource = stored && stored.generation === generation ? stored.value : LOADING
  return { resource, reload, replace }
}

/**
 * A mutation guard. Call it when a change starts; the returned check is true
 * only while the same connection generation is still mounted.
 */
export function useScopeGuard(scope: LiveScope): () => () => boolean {
  const state = useRef({ generation: scope.generation, mounted: true })
  state.current.generation = scope.generation
  useEffect(() => {
    const current = state.current
    current.mounted = true
    return () => { current.mounted = false }
  }, [])
  return useCallback(() => {
    const generation = state.current.generation
    return () => state.current.mounted && state.current.generation === generation
  }, [])
}

/**
 * Accessible confirmation: role=dialog, focus starts on Cancel, Escape cancels.
 * Nothing is sent until the confirm button is pressed.
 */
export function ConfirmDialog({ title, children, confirmLabel, danger = false, busy = false, confirmDisabled = false, onConfirm, onCancel }: {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  confirmDisabled?: boolean
  onConfirm(): void
  onCancel(): void
}) {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useEffect(() => { cancelRef.current?.focus() }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])
  return <div className="ops-dialog-backdrop" role="presentation">
    <section className="ops-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId} dir="auto">{title}</h2>
      <div className="ops-dialog-body">{children}</div>
      <div className="ops-dialog-actions">
        <button type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
        <button type="button" className={danger ? 'ops-danger' : 'ops-primary'} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </section>
  </div>
}

export function OpsHeader({ eyebrow, description, children }: { eyebrow: string; description: string; children?: ReactNode }) {
  return <div className="collection-intro live-intro">
    <div>
      <span className="eyebrow">{eyebrow}</span>
      <p>{description}</p>
    </div>
    {children && <div className="live-intro-actions">{children}</div>}
  </div>
}

export function OpsLoadState({ resource, subject, onRetry }: { resource: OpsResource<unknown>; subject: string; onRetry(): void }) {
  if (resource.status === 'loading') return <p className="live-empty-line" role="status">Loading {subject} from the server…</p>
  if (resource.status === 'error') return <div className="live-empty" role="alert">
    <strong>Server data unavailable</strong>
    <p>{resource.error} No {subject} are shown.</p>
    <div className="live-empty-actions"><button type="button" onClick={onRetry}>Retry</button></div>
  </div>
  return null
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`
}

export function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
