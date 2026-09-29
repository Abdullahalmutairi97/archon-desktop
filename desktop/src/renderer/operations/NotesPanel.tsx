import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveScope } from '../live/useLiveServer'
import { ConfirmDialog } from './OperationDialog'
import {
  ensureCurrentConnection,
  isServerFileName,
  readOnlyReason,
  serverFileErrorCode,
  serverFileErrorMessage,
  SERVER_FILE_READ_MAX_BYTES,
} from './serverFiles'
import './ServerFilesPage.css'

/** Notes live as Markdown files in this folder of the server file root. */
export const NOTES_DIRECTORY = 'notes'
/** Typing pause before a note is saved. */
export const NOTE_AUTOSAVE_MS = 900

export type NoteSaveState = 'idle' | 'dirty' | 'saving' | 'error'

function localDateStem(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Today's note name, `YYYY-MM-DD.md`, then `YYYY-MM-DD-2.md` and so on past taken names. */
export function nextNoteName(existing: readonly string[], now: Date): string {
  const stem = localDateStem(now)
  const taken = new Set(existing.map((name) => name.toLowerCase()))
  if (!taken.has(`${stem}.md`)) return `${stem}.md`
  for (let index = 2; ; index += 1) {
    const name = `${stem}-${index}.md`
    if (!taken.has(name)) return name
  }
}

function notePath(name: string): string {
  return `${NOTES_DIRECTORY}/${name}`
}

type NoteList = { state: 'loading' } | { state: 'ready'; names: readonly string[] } | { state: 'error'; message: string }
type OpenNote =
  | { name: string; state: 'loading' }
  | { name: string; state: 'error'; message: string }
  | { name: string; state: 'ready'; content: string; readOnly: string | null }

/** Server notes: Markdown files under `notes/`, edited as plain text and saved automatically. */
export function NotesPanel({ scope }: { scope: LiveScope }) {
  const api = scope.bridge.api
  const [list, setList] = useState<NoteList>({ state: 'loading' })
  const [note, setNote] = useState<OpenNote | null>(null)
  const [saveState, setSaveState] = useState<NoteSaveState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const listSerial = useRef(0)
  const openSerial = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The newest unsaved text, and a chain that keeps saves in order.
  const pending = useRef<{ name: string; content: string } | null>(null)
  const chain = useRef<Promise<boolean>>(Promise.resolve(true))

  const readNames = useCallback(async (): Promise<string[]> => {
    try {
      const result = await api.invoke('files.list', { path: NOTES_DIRECTORY })
      return result.items
        .filter((item) => !item.is_dir && item.name.toLowerCase().endsWith('.md') && isServerFileName(item.name))
        .map((item) => item.name)
        .sort((a, b) => b.localeCompare(a))
    } catch (error) {
      // No notes folder yet means no notes.
      if (serverFileErrorCode(error) === 'not_a_directory') return []
      throw error
    }
  }, [api])

  const loadList = useCallback(() => {
    const request = ++listSerial.current
    void readNames().then((names) => {
      if (alive.current && listSerial.current === request) setList({ state: 'ready', names })
    }).catch((error: unknown) => {
      if (alive.current && listSerial.current === request) setList({ state: 'error', message: serverFileErrorMessage(error, 'Notes could not be listed.') })
    })
  }, [readNames])

  /** Queue one save of the given text; resolves false when it failed. */
  const save = useCallback((name: string, content: string): Promise<boolean> => {
    chain.current = chain.current.then(async () => {
      if (alive.current) setSaveState('saving')
      try {
        await ensureCurrentConnection(scope)
        await api.invoke('files.writeText', { path: notePath(name), content })
        if (pending.current?.name === name && pending.current.content === content) pending.current = null
        if (alive.current) {
          setSaveState(pending.current ? 'dirty' : 'idle')
          setMessage(null)
        }
        return true
      } catch {
        if (alive.current) {
          setSaveState('error')
          setMessage('That note could not be saved. Your text is still here; keep typing or switch notes to try again.')
        }
        return false
      }
    })
    return chain.current
  }, [api, scope])

  /** Save any pending text now instead of waiting for the typing pause. */
  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const current = pending.current
    return current ? save(current.name, current.content) : chain.current
  }, [save])

  useEffect(() => {
    alive.current = true
    loadList()
    return () => {
      alive.current = false
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      const current = pending.current
      if (current) void save(current.name, current.content)
    }
  }, [loadList, save])

  function edit(content: string) {
    if (note?.state !== 'ready' || note.readOnly) return
    const name = note.name
    setNote({ ...note, content })
    pending.current = { name, content }
    setSaveState('dirty')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const latest = pending.current
      if (latest) void save(latest.name, latest.content)
    }, NOTE_AUTOSAVE_MS)
  }

  function openNote(name: string, known?: string) {
    const request = ++openSerial.current
    setNote(known === undefined ? { name, state: 'loading' } : { name, state: 'ready', content: known, readOnly: null })
    setSaveState('idle')
    if (known !== undefined) return
    void Promise.resolve().then(() => api.invoke('files.read', { path: notePath(name), maxBytes: SERVER_FILE_READ_MAX_BYTES })).then((result) => {
      if (alive.current && openSerial.current === request) {
        setNote({ name, state: 'ready', content: result.content, readOnly: readOnlyReason(result.content, result.truncated) })
      }
    }).catch((error: unknown) => {
      if (alive.current && openSerial.current === request) setNote({ name, state: 'error', message: serverFileErrorMessage(error, 'That note could not be read.') })
    })
  }

  async function switchTo(name: string) {
    if (note?.name === name) return
    // Keep the user on a note whose last edits did not reach the server.
    if (!await flush()) return
    if (alive.current) openNote(name)
  }

  async function newNote() {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      if (!await flush()) return
      await ensureCurrentConnection(scope)
      const names = await readNames()
      const name = nextNoteName(names, new Date())
      await api.invoke('files.mkdir', { path: NOTES_DIRECTORY })
      await api.invoke('files.writeText', { path: notePath(name), content: '' })
      if (!alive.current) return
      setList({ state: 'ready', names: [name, ...names].sort((a, b) => b.localeCompare(a)) })
      openNote(name, '')
    } catch (error) {
      if (alive.current) setMessage(serverFileErrorMessage(error, 'A new note could not be created.'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  async function deleteNote(name: string) {
    setConfirmDelete(null)
    if (busy) return
    setBusy(true)
    setMessage(null)
    // Edits to a note being deleted are dropped, not saved.
    if (pending.current?.name === name) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      pending.current = null
    }
    try {
      await chain.current
      await ensureCurrentConnection(scope)
      await api.invoke('files.delete', { path: notePath(name), confirm: true })
      if (!alive.current) return
      if (note?.name === name) { openSerial.current += 1; setNote(null); setSaveState('idle') }
      loadList()
    } catch (error) {
      if (alive.current) setMessage(serverFileErrorMessage(error, 'That note could not be deleted.'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const stateLabel = saveState === 'saving' ? 'Saving…' : saveState === 'dirty' ? 'Unsaved changes' : saveState === 'error' ? 'Not saved' : 'Saved'

  return <section className="server-notes" aria-label="Notes">
    <div className="server-notes-head">
      <span>Markdown notes in <code dir="ltr">{NOTES_DIRECTORY}/</code> on the server</span>
      <button type="button" onClick={() => { void newNote() }} disabled={busy}>New note</button>
    </div>
    {message && <p className="server-files-notice server-files-notice-error" role="alert">{message}</p>}
    {list.state === 'loading' && <p className="live-bench-empty">Loading notes…</p>}
    {list.state === 'error' && <p className="live-bench-empty" role="alert">{list.message}</p>}
    {list.state === 'ready' && !list.names.length && <p className="live-bench-empty">No notes yet. New note starts one for today.</p>}
    {list.state === 'ready' && list.names.length > 0 && <ul className="server-notes-list" aria-label="Notes">
      {list.names.map((name) => <li key={name}>
        <button type="button" dir="ltr" aria-pressed={note?.name === name} onClick={() => { void switchTo(name) }}>{name}</button>
      </li>)}
    </ul>}
    {note && <div className="server-notes-editor">
      <div className="server-notes-editor-head">
        <code dir="ltr">{notePath(note.name)}</code>
        {note.state === 'ready' && <span className={`server-notes-state ${saveState === 'error' ? 'server-notes-state-error' : ''}`} role="status">{stateLabel}</span>}
        <button type="button" className="operation-danger" onClick={() => setConfirmDelete(note.name)} disabled={busy}>Delete</button>
      </div>
      {note.state === 'loading' && <p className="live-bench-empty">Loading note…</p>}
      {note.state === 'error' && <p className="live-bench-empty" role="alert">{note.message}</p>}
      {note.state === 'ready' && <>
        {note.readOnly && <p className="server-files-note" role="status">{note.readOnly}</p>}
        <textarea aria-label={`Note ${note.name}`} dir="auto" value={note.content} readOnly={note.readOnly !== null} onChange={(event) => edit(event.currentTarget.value)} />
      </>}
    </div>}
    {confirmDelete && <ConfirmDialog title={`Delete ${confirmDelete}?`} confirmLabel="Delete note" danger onCancel={() => setConfirmDelete(null)} onConfirm={() => { void deleteNote(confirmDelete) }}>
      <p>This note will be deleted from the server. This cannot be undone.</p>
      <code dir="ltr">{notePath(confirmDelete)}</code>
    </ConfirmDialog>}
  </section>
}
