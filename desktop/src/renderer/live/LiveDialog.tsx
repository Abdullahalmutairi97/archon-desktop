import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import './LiveViews.css'

const FOCUSABLE = 'button:not(:disabled), textarea:not(:disabled), select:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/**
 * A small modal for live views. It renders inside the shell so the theme and
 * reading direction apply, moves focus to `initialFocus` (the safe choice),
 * keeps Tab inside, and treats Escape or a click outside as Cancel unless a
 * request is in flight. Focus returns to the opener when it closes.
 */
export function LiveDialog({
  eyebrow,
  title,
  wide = false,
  busy = false,
  initialFocus,
  onCancel,
  children,
  footer,
}: {
  eyebrow: string
  title: string
  wide?: boolean
  busy?: boolean
  initialFocus: RefObject<HTMLElement | null>
  onCancel(): void
  children: ReactNode
  footer: ReactNode
}) {
  const titleId = useId()
  const dialog = useRef<HTMLElement>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const previous = document.activeElement
    initialFocus.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busyRef.current) cancelRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); first.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.removeEventListener('keydown', keyboard)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [initialFocus])

  return <div className="modal-scrim" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busyRef.current) cancelRef.current()
  }}>
    <section ref={dialog} className={`live-dialog ${wide ? 'live-dialog-wide' : ''}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="dialog-titlebar">
        <div><span className="eyebrow">{eyebrow}</span><h2 id={titleId} dir="auto">{title}</h2></div>
      </header>
      <div className="live-dialog-body">{children}</div>
      <footer className="live-dialog-actions">{footer}</footer>
    </section>
  </div>
}

/** A confirmation for a destructive action. Cancel has the initial focus. */
export function ConfirmDialog({
  eyebrow,
  title,
  detail,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  children,
}: {
  eyebrow: string
  title: string
  detail: string
  confirmLabel: string
  busy: boolean
  onCancel(): void
  onConfirm(): void
  children?: ReactNode
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  return <LiveDialog eyebrow={eyebrow} title={title} busy={busy} initialFocus={cancel} onCancel={onCancel} footer={<>
    <button type="button" ref={cancel} onClick={onCancel} disabled={busy}>Cancel</button>
    <button type="button" className="live-danger" onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
  </>}>
    <p className="live-dialog-detail">{detail}</p>
    {children}
  </LiveDialog>
}
