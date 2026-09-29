import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerFileItem, ServerFileUploadPick } from '../../shared/bridge/types'
import type { LiveScope, LiveServer } from '../live/useLiveServer'
import { Icon } from '../shell/Icon'
import { ConfirmDialog, NameDialog } from './OperationDialog'
import {
  ensureCurrentConnection,
  formatBytes,
  isServerFileName,
  isServerFilePath,
  itemIsAddressable,
  joinServerPath,
  parentServerPath,
  readOnlyReason,
  serverBaseName,
  serverFileErrorCode,
  serverFileErrorMessage,
  SERVER_FILE_READ_MAX_BYTES,
} from './serverFiles'
import './ServerFilesPage.css'

type Listing =
  | { path: string; state: 'loading' }
  | { path: string; state: 'ready'; root: string; items: readonly ServerFileItem[] }
  | { path: string; state: 'error'; message: string }

type OpenFile =
  | { path: string; name: string; state: 'loading' }
  | { path: string; name: string; state: 'restricted' }
  | { path: string; name: string; state: 'error'; message: string }
  | { path: string; name: string; state: 'ready'; content: string; original: string; size: number; readOnly: string | null }

type Dialog =
  | { kind: 'discard'; then(): void }
  | { kind: 'delete'; item: ServerFileItem }
  | { kind: 'mkdir' }
  | { kind: 'move'; mode: 'rename' | 'copy'; item: ServerFileItem }
  | { kind: 'replace-move'; mode: 'rename' | 'copy'; item: ServerFileItem; destination: string; existing: ServerFileItem }
  | { kind: 'replace-upload'; pickId: string; target: string }

type Notice = { kind: 'ok' | 'error'; text: string }

/** A failure whose message is already written for the user. */
class UserFacingError extends Error {}

/** The server file root page: honest states until a connection is usable. */
export function ServerFilesPage({ server, onOpenConnection }: { server: LiveServer; onOpenConnection(): void }) {
  if (!server.scope) {
    const text = server.status === 'checking' ? 'Checking the server connection…'
      : server.status === 'disconnected' ? 'Not connected. Connect to a server to browse its files.'
      : 'The desktop connection is unavailable.'
    return <section className="server-files" aria-label="Server files">
      <div className="server-files-empty" role="status"><p>{text}</p>
        {server.status !== 'checking' && <button type="button" onClick={onOpenConnection}>Open Connection</button>}
      </div>
    </section>
  }
  // A new connection generation starts from a clean page; nothing loaded before carries over.
  return <ServerFilesBrowser key={server.scope.generation} scope={server.scope} />
}

export function ServerFilesBrowser({ scope }: { scope: LiveScope }) {
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<Listing>({ path: '', state: 'loading' })
  const [reload, setReload] = useState(0)
  const [open, setOpen] = useState<OpenFile | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const listSerial = useRef(0)
  const openSerial = useRef(0)
  const alive = useRef(true)
  const running = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const api = scope.bridge.api
  const dirty = open?.state === 'ready' && open.content !== open.original

  useEffect(() => {
    const request = ++listSerial.current
    setListing({ path, state: 'loading' })
    void Promise.resolve().then(() => api.invoke('files.list', { path })).then((result) => {
      if (alive.current && listSerial.current === request) setListing({ path, state: 'ready', root: result.root, items: result.items })
    }).catch((error: unknown) => {
      if (alive.current && listSerial.current === request) {
        setListing({ path, state: 'error', message: serverFileErrorMessage(error, 'This folder could not be listed. It may hold more than 2,000 entries.') })
      }
    })
  }, [api, path, reload])

  const refresh = useCallback(() => setReload((value) => value + 1), [])

  function guardDiscard(then: () => void) {
    if (dirty) setDialog({ kind: 'discard', then })
    else then()
  }

  function navigate(next: string) {
    guardDiscard(() => {
      openSerial.current += 1
      setOpen(null)
      setNotice(null)
      setPath(next)
    })
  }

  function openFile(item: ServerFileItem) {
    if (item.is_dir) { navigate(item.path); return }
    guardDiscard(() => {
      const request = ++openSerial.current
      setNotice(null)
      if (item.restricted) { setOpen({ path: item.path, name: item.name, state: 'restricted' }); return }
      setOpen({ path: item.path, name: item.name, state: 'loading' })
      void Promise.resolve().then(() => api.invoke('files.read', { path: item.path, maxBytes: SERVER_FILE_READ_MAX_BYTES })).then((result) => {
        if (!alive.current || openSerial.current !== request) return
        setOpen({ path: item.path, name: item.name, state: 'ready', content: result.content, original: result.content, size: result.size, readOnly: readOnlyReason(result.content, result.truncated) })
      }).catch((error: unknown) => {
        if (alive.current && openSerial.current === request) {
          setOpen({ path: item.path, name: item.name, state: 'error', message: serverFileErrorMessage(error, 'This file could not be read.') })
        }
      })
    })
  }

  /** Run one change once; nothing here retries. */
  async function run(label: string, action: () => Promise<string | null>) {
    if (running.current) return
    running.current = true
    setBusy(label)
    setNotice(null)
    try {
      await ensureCurrentConnection(scope)
      const done = await action()
      if (alive.current && done) setNotice({ kind: 'ok', text: done })
    } catch (error) {
      const text = error instanceof UserFacingError ? error.message : serverFileErrorMessage(error, `${label} failed.`)
      if (alive.current) setNotice({ kind: 'error', text })
    } finally {
      running.current = false
      if (alive.current) setBusy(null)
    }
  }

  function save() {
    if (open?.state !== 'ready' || open.readOnly || !dirty) return
    const { path: filePath, content } = open
    void run('Save', async () => {
      await api.invoke('files.writeText', { path: filePath, content })
      if (alive.current) setOpen((current) => current?.state === 'ready' && current.path === filePath ? { ...current, original: content } : current)
      refresh()
      return `Saved ${serverBaseName(filePath)}.`
    })
  }

  function makeFolder(name: string) {
    setDialog(null)
    const target = joinServerPath(path, name)
    void run('New folder', async () => {
      await api.invoke('files.mkdir', { path: target })
      refresh()
      return `Created folder ${name}.`
    })
  }

  async function existingAt(target: string): Promise<ServerFileItem | null> {
    try {
      const result = await api.invoke('files.list', { path: parentServerPath(target) })
      return result.items.find((item) => item.name === serverBaseName(target)) ?? null
    } catch {
      // An unreadable or missing parent cannot hold a collision; the server rechecks anyway.
      return null
    }
  }

  function move(mode: 'rename' | 'copy', item: ServerFileItem, destination: string, replace: ServerFileItem | null) {
    setDialog(null)
    void run(mode === 'rename' ? 'Rename' : 'Copy', async () => {
      if (!replace) {
        const existing = await existingAt(destination)
        if (existing) {
          if (alive.current) setDialog({ kind: 'replace-move', mode, item, destination, existing })
          return null
        }
      } else {
        await api.invoke('files.delete', { path: destination, confirm: true })
      }
      const result = await api.invoke(mode === 'rename' ? 'files.rename' : 'files.copy', { path: item.path, destination })
      if (mode === 'rename' && alive.current) {
        setOpen((current) => current && (current.path === item.path || current.path.startsWith(`${item.path}/`)) ? null : current)
      }
      refresh()
      return `${mode === 'rename' ? 'Moved' : 'Copied'} ${item.name} to ${result.path}.`
    })
  }

  function remove(item: ServerFileItem) {
    setDialog(null)
    void run('Delete', async () => {
      await api.invoke('files.delete', { path: item.path, confirm: true })
      if (alive.current) setOpen((current) => current && (current.path === item.path || current.path.startsWith(`${item.path}/`)) ? null : current)
      refresh()
      return `Deleted ${item.name}.`
    })
  }

  async function uploadStep(pickId: string, target: string, replace: boolean): Promise<string | null> {
    try {
      const result = await api.invoke('files.upload', { pickId, path: target, replace })
      refresh()
      return `Uploaded ${serverBaseName(result.path)} (${formatBytes(result.size)}).`
    } catch (error) {
      if (!replace && serverFileErrorCode(error) === 'already_exists') {
        if (alive.current) setDialog({ kind: 'replace-upload', pickId, target })
        return null
      }
      throw error
    }
  }

  function replaceUpload(pickId: string, target: string) {
    setDialog(null)
    void run('Upload', () => uploadStep(pickId, target, true))
  }

  function pickUpload() {
    void run('Upload', async () => {
      const picked: ServerFileUploadPick = await api.invoke('files.pickUpload', {})
      if (picked.cancelled) return null
      if (!isServerFileName(picked.name)) throw new UserFacingError('That file name cannot be used on the server. Rename it on this PC first.')
      const target = joinServerPath(path, picked.name)
      if (!isServerFilePath(target)) throw new UserFacingError('That path is too long for the server.')
      return uploadStep(picked.pickId, target, false)
    })
  }

  function download(item: ServerFileItem) {
    void run('Download', async () => {
      const result = await api.invoke('files.download', { path: item.path })
      return result.saved ? `Saved ${result.name} (${formatBytes(result.size)}) on this PC.` : null
    })
  }

  const segments = path ? path.split('/') : []
  const items = listing.state === 'ready' && listing.path === path ? listing.items : null

  return <section className="server-files" aria-label="Server files">
    <div className="server-files-toolbar">
      <nav className="server-files-breadcrumbs" aria-label="Folder path" dir="ltr">
        <button type="button" onClick={() => navigate('')} aria-current={path === '' ? 'location' : undefined}>Root</button>
        {segments.map((segment, index) => {
          const target = segments.slice(0, index + 1).join('/')
          return <span key={target}><span aria-hidden="true">/</span><button type="button" onClick={() => navigate(target)} aria-current={target === path ? 'location' : undefined}>{segment}</button></span>
        })}
      </nav>
      <div className="server-files-actions">
        {path && <button type="button" onClick={() => navigate(parentServerPath(path))}>Up</button>}
        <button type="button" onClick={refresh} disabled={busy !== null}>Refresh</button>
        <button type="button" onClick={() => setDialog({ kind: 'mkdir' })} disabled={busy !== null}>New folder</button>
        <button type="button" onClick={pickUpload} disabled={busy !== null}>Upload…</button>
      </div>
    </div>
    {listing.state === 'ready' && <p className="server-files-root">Server file root <code dir="ltr">{listing.root}</code></p>}
    {busy && <p className="server-files-status" role="status">{busy}…</p>}
    {notice && <p className={`server-files-notice server-files-notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} dir="auto">{notice.text}</p>}

    <div className="server-files-layout">
      <div className="server-files-list" aria-label="Folder contents">
        {listing.state === 'loading' && <p className="server-files-empty">Loading folder…</p>}
        {listing.state === 'error' && <div className="server-files-empty" role="alert"><p>{listing.message}</p><button type="button" onClick={refresh}>Try again</button></div>}
        {items && !items.length && <p className="server-files-empty">This folder is empty.</p>}
        {items && items.length > 0 && <ul>
          {items.map((item) => {
            const usable = itemIsAddressable(item)
            return <li key={item.path} className={open?.path === item.path ? 'selected' : undefined}>
              {usable
                ? <button type="button" className="server-files-entry" onClick={() => openFile(item)}>
                  <Icon name={item.is_dir ? 'folder' : 'file'} />
                  <span className="server-files-name" dir="auto">{item.name}</span>
                  <small>{item.is_dir ? 'Folder' : formatBytes(item.size)}{item.is_symlink ? ' · link' : ''}{item.restricted ? ' · restricted' : ''}</small>
                </button>
                : <span className="server-files-entry server-files-unusable">
                  <Icon name={item.is_dir ? 'folder' : 'file'} />
                  <span className="server-files-name" dir="auto">{item.name}</span>
                  <small>Name not supported here</small>
                </span>}
              {usable && <span className="server-files-row-actions">
                {!item.is_dir && !item.restricted && <button type="button" aria-label={`Download ${item.name}`} onClick={() => download(item)} disabled={busy !== null}>Download</button>}
                <button type="button" aria-label={`Rename ${item.name}`} onClick={() => setDialog({ kind: 'move', mode: 'rename', item })} disabled={busy !== null}>Rename</button>
                <button type="button" aria-label={`Copy ${item.name}`} onClick={() => setDialog({ kind: 'move', mode: 'copy', item })} disabled={busy !== null}>Copy</button>
                <button type="button" aria-label={`Delete ${item.name}`} className="operation-danger" onClick={() => setDialog({ kind: 'delete', item })} disabled={busy !== null}>Delete</button>
              </span>}
            </li>
          })}
        </ul>}
      </div>

      <div className="server-files-editor">
        {!open && <p className="server-files-empty">Choose a file to open it.</p>}
        {open && <>
          <header>
            <div>
              <h2 dir="auto">{open.name}{dirty ? ' •' : ''}</h2>
              <code dir="ltr">{open.path}</code>
            </div>
            {open.state === 'ready' && !open.readOnly && <button type="button" className="operation-primary" onClick={save} disabled={!dirty || busy !== null}>Save</button>}
          </header>
          {open.state === 'loading' && <p className="server-files-empty">Loading file…</p>}
          {open.state === 'restricted' && <p className="server-files-empty" role="status">This secret-bearing file is intentionally not shown.</p>}
          {open.state === 'error' && <p className="server-files-empty" role="alert">{open.message}</p>}
          {open.state === 'ready' && <>
            {open.readOnly && <p className="server-files-note" role="status">{open.readOnly}</p>}
            <textarea
              aria-label="File content"
              dir="auto"
              spellCheck={false}
              value={open.content}
              readOnly={open.readOnly !== null}
              onChange={(event) => {
                const value = event.currentTarget.value
                setOpen((current) => current?.state === 'ready' ? { ...current, content: value } : current)
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save() }
              }}
            />
          </>}
        </>}
      </div>
    </div>

    {dialog?.kind === 'discard' && <ConfirmDialog title="Discard unsaved changes?" confirmLabel="Discard changes" danger onCancel={() => setDialog(null)} onConfirm={() => { const then = dialog.then; setDialog(null); setOpen(null); then() }}>
      <p>Your edits to <code dir="ltr">{open?.path}</code> have not been saved.</p>
    </ConfirmDialog>}
    {dialog?.kind === 'delete' && <ConfirmDialog title={`Delete ${dialog.item.name}?`} confirmLabel={dialog.item.is_dir ? 'Delete folder' : 'Delete file'} danger onCancel={() => setDialog(null)} onConfirm={() => remove(dialog.item)}>
      <p>{dialog.item.is_dir ? 'This folder and everything in it will be deleted from the server.' : 'This file will be deleted from the server.'} This cannot be undone.</p>
      <code dir="ltr">{dialog.item.path}</code>
    </ConfirmDialog>}
    {dialog?.kind === 'mkdir' && <NameDialog title="New folder" label="Folder name" initialValue="" submitLabel="Create folder"
      validate={(value) => isServerFileName(value) && isServerFilePath(joinServerPath(path, value)) ? null : 'Use one name without slashes, control characters, “.” or “..”.'}
      onCancel={() => setDialog(null)} onSubmit={makeFolder} />}
    {dialog?.kind === 'move' && <NameDialog
      title={`${dialog.mode === 'rename' ? 'Rename or move' : 'Copy'} ${dialog.item.name}`}
      label="New path from the server file root"
      initialValue={dialog.item.path}
      submitLabel={dialog.mode === 'rename' ? 'Rename' : 'Copy'}
      validate={(value) => !isServerFilePath(value) ? 'Use a path relative to the file root, without “..”, a leading “/” or “~”.'
        : value === dialog.item.path ? 'Choose a different path.'
        : dialog.item.is_dir && value.startsWith(`${dialog.item.path}/`) ? 'A folder cannot go inside itself.' : null}
      onCancel={() => setDialog(null)} onSubmit={(value) => move(dialog.mode, dialog.item, value, null)} />}
    {dialog?.kind === 'replace-move' && <ConfirmDialog title={`Replace ${dialog.existing.name}?`} confirmLabel="Replace" danger onCancel={() => setDialog(null)} onConfirm={() => move(dialog.mode, dialog.item, dialog.destination, dialog.existing)}>
      <p>{dialog.existing.is_dir ? 'A folder' : 'A file'} already exists at <code dir="ltr">{dialog.destination}</code>. Replacing deletes it{dialog.existing.is_dir ? ' and everything in it' : ''} first. This cannot be undone.</p>
    </ConfirmDialog>}
    {dialog?.kind === 'replace-upload' && <ConfirmDialog title={`Replace ${serverBaseName(dialog.target)}?`} confirmLabel="Replace" danger onCancel={() => setDialog(null)} onConfirm={() => replaceUpload(dialog.pickId, dialog.target)}>
      <p>A file already exists at <code dir="ltr">{dialog.target}</code>. Uploading overwrites it. This cannot be undone.</p>
    </ConfirmDialog>}
  </section>
}
