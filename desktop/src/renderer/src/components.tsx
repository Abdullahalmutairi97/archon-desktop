import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { TaskStatus } from './lib/types'

export function Button({ children, tone = 'default', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  return <button className={`button ${tone}`} {...props}>{children}</button>
}
export function Section({ title, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="section"><header className="section-head"><div><h2>{title}</h2></div>{actions && <div className="actions">{actions}</div>}</header>{children}</section>
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div> }
export function ErrorNotice({ error }: { error?: string }) { return error ? <div className="notice error">{error}</div> : null }
export function StatusPill({ status }: { status: TaskStatus | string }) { return <span className={`status ${status}`}>{status}</span> }
export function ConfirmDialog({ open, title, detail, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }: { open: boolean; title: string; detail: string; confirmLabel?: string; danger?: boolean; onConfirm(): void; onCancel(): void }) {
  if (!open) return null
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><h3 id="confirm-title">{title}</h3><p>{detail}</p><div className="dialog-actions"><Button onClick={onCancel}>Cancel</Button><Button tone={danger ? 'danger' : 'primary'} autoFocus onClick={onConfirm}>{confirmLabel}</Button></div></div></div>
}
export function formatBytes(value?: number) { if (value == null) return '—'; const units = ['B','KiB','MiB','GiB','TiB']; let n = value; let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}` }
export function formatDate(value?: string | number) { if (!value) return '—'; const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString() }
export function usePolling<T>(load: () => Promise<T>, _interval: number, deps: unknown[] = []) {
  const [data, setData] = useState<T>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(true)
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve())
  useEffect(() => {
    let active = true
    let inFlight = false
    const run = async () => {
      if (inFlight) return
      inFlight = true
      try { const value = await load(); if (active) { setData(value); setError('') } } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)) } finally { inFlight = false; if (active) setLoading(false) }
    }
    const onData = () => void run()
    refreshRef.current = run
    void run()
    window.addEventListener('archon:data-changed', onData)
    const timer = _interval > 0 ? window.setInterval(onData, _interval) : undefined
    return () => { active = false; refreshRef.current = () => Promise.resolve(); window.removeEventListener('archon:data-changed', onData); if (timer !== undefined) window.clearInterval(timer) }
  }, deps)
  return { data, error, loading, refresh: () => refreshRef.current() }
}
