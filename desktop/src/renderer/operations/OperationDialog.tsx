import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

function useModalKeyboard(dialog: RefObject<HTMLElement | null>, initialFocus: RefObject<HTMLElement | null>, onCancel: () => void) {
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  useEffect(() => {
    const previous = document.activeElement
    initialFocus.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); cancelRef.current(); return }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input') ?? [])
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.removeEventListener('keydown', keyboard)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [dialog, initialFocus])
}

/** A modal confirmation. Focus starts on Cancel; Escape and the backdrop cancel. */
export function ConfirmDialog({ title, children, confirmLabel, danger = false, onConfirm, onCancel }: {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm(): void
  onCancel(): void
}) {
  const titleId = useId()
  const dialog = useRef<HTMLElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useModalKeyboard(dialog, cancel, onCancel)
  return createPortal(
    <div className="operation-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <section className="operation-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} dir="auto">{title}</h2>
        <div className="operation-dialog-body">{children}</div>
        <footer>
          <button type="button" ref={cancel} onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? 'operation-danger' : 'operation-primary'} onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </section>
    </div>, document.body,
  )
}

/** A modal that asks for one value, such as a folder name or a destination path. */
export function NameDialog({ title, label, initialValue, submitLabel, validate, onSubmit, onCancel }: {
  title: string
  label: string
  initialValue: string
  submitLabel: string
  validate(value: string): string | null
  onSubmit(value: string): void
  onCancel(): void
}) {
  const titleId = useId()
  const inputId = useId()
  const dialog = useRef<HTMLElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialValue)
  useModalKeyboard(dialog, input, onCancel)
  const problem = value.trim() ? validate(value.trim()) : null
  return createPortal(
    <div className="operation-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <section className="operation-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} dir="auto">{title}</h2>
        <form onSubmit={(event) => { event.preventDefault(); if (value.trim() && !problem) onSubmit(value.trim()) }}>
          <label htmlFor={inputId}>{label}</label>
          <input id={inputId} ref={input} dir="ltr" value={value} spellCheck={false} onChange={(event) => setValue(event.currentTarget.value)} />
          {problem && <p className="operation-dialog-problem" role="alert">{problem}</p>}
          <footer>
            <button type="button" onClick={onCancel}>Cancel</button>
            <button type="submit" className="operation-primary" disabled={!value.trim() || problem !== null}>{submitLabel}</button>
          </footer>
        </form>
      </section>
    </div>, document.body,
  )
}
