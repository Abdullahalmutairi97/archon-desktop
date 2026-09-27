import { useEffect, useRef, useState } from 'react'
import './WorkspaceFileBrowser.css'

export interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number | null
}

export interface WorkspaceFileListing {
  path: string
  entries: readonly WorkspaceFileEntry[]
  truncated: boolean
}

export interface WorkspaceFileRead {
  path: string
  content: string
  truncated: boolean
  /** Optional transport hint for servers that report binary reads as a result. */
  binary?: boolean
}

/** Read-only, bounded transport contract for a server-owned workspace. */
export interface WorkspaceReadOnlyFilePort {
  list(workspaceId: string, path: string, limit: number): Promise<WorkspaceFileListing>
  read(workspaceId: string, path: string, maxBytes: number): Promise<WorkspaceFileRead>
}

const LIST_LIMIT = 100
const READ_LIMIT_BYTES = 64 * 1024
const DISPLAY_LIMIT_CHARS = 24_000
const MAX_PATH_LENGTH = 1_000
const MAX_PATH_DEPTH = 64

type ListingState =
  | { workspaceId: string; path: string; status: 'loading' }
  | { workspaceId: string; path: string; status: 'ready'; entries: readonly WorkspaceFileEntry[]; truncated: boolean }
  | { workspaceId: string; path: string; status: 'error' }

type ReadState =
  | { workspaceId: string; path: string; status: 'loading' }
  | { workspaceId: string; path: string; status: 'ready'; content: string; truncated: boolean }
  | { workspaceId: string; path: string; status: 'binary' }
  | { workspaceId: string; path: string; status: 'error' }

function canonicalPath(path: string): string | null {
  if (path === '') return ''
  if (path.length > MAX_PATH_LENGTH || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(path)) return null
  const parts = path.split('/')
  if (parts.length > MAX_PATH_DEPTH || parts.some((part) => !part || part === '.' || part === '..' || part.length > 255)) return null
  return parts.join('/')
}

function safeName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && name.length <= 255
    && !name.includes('/')
    && !name.includes('\\')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(name)
}

function childPath(parent: string, name: string): string | null {
  if (!safeName(name)) return null
  return canonicalPath(parent ? `${parent}/${name}` : name)
}

function parentPath(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

function normalizeListing(value: WorkspaceFileListing, requestedPath: string): { entries: readonly WorkspaceFileEntry[]; truncated: boolean } | null {
  if (!value || typeof value !== 'object' || value.path !== requestedPath || !Array.isArray(value.entries)) return null
  const entries: WorkspaceFileEntry[] = []
  const seen = new Set<string>()
  for (const entry of value.entries.slice(0, LIST_LIMIT)) {
    if (!entry || typeof entry !== 'object' || !safeName(entry.name)) continue
    const expectedPath = childPath(requestedPath, entry.name)
    if (!expectedPath || entry.path !== expectedPath || (entry.kind !== 'file' && entry.kind !== 'directory') || seen.has(expectedPath)) continue
    seen.add(expectedPath)
    entries.push({
      name: entry.name,
      path: expectedPath,
      kind: entry.kind,
      size: Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null,
    })
  }
  entries.sort((first, second) => {
    if (first.kind !== second.kind) return first.kind === 'directory' ? -1 : 1
    return first.name.localeCompare(second.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return { entries, truncated: value.truncated === true || value.entries.length > LIST_LIMIT }
}

function isBinaryReadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (record.status === 415 || record.statusCode === 415 || record.httpStatus === 415) return true
  return typeof record.code === 'string' && /binary|unsupported_media_type/u.test(record.code)
}

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Bounded read-only browser for a server-managed workspace checkout. */
export function WorkspaceFileBrowser({
  workspaceId,
  readOnlyFilePort,
}: {
  workspaceId: string
  readOnlyFilePort: WorkspaceReadOnlyFilePort
}) {
  const [locationState, setLocationState] = useState({ workspaceId, path: '' })
  const path = locationState.workspaceId === workspaceId ? locationState.path : ''
  const [selectedState, setSelectedState] = useState<{ workspaceId: string; path: string } | null>(null)
  const selectedPath = selectedState?.workspaceId === workspaceId ? selectedState.path : null
  const [listingState, setListingState] = useState<ListingState | null>(null)
  const [readState, setReadState] = useState<ReadState | null>(null)
  const [listingReload, setListingReload] = useState(0)
  const listingGeneration = useRef(0)
  const readGeneration = useRef(0)
  const currentListing = listingState?.workspaceId === workspaceId && listingState.path === path ? listingState : null
  const currentRead = readState?.workspaceId === workspaceId && readState.path === selectedPath ? readState : null

  useEffect(() => {
    const generation = ++listingGeneration.current
    const safePath = canonicalPath(path)
    if (safePath === null) {
      setListingState({ workspaceId, path, status: 'error' })
      return () => { if (listingGeneration.current === generation) listingGeneration.current += 1 }
    }
    setListingState({ workspaceId, path: safePath, status: 'loading' })
    void readOnlyFilePort.list(workspaceId, safePath, LIST_LIMIT).then((result) => {
      if (listingGeneration.current !== generation) return
      const normalized = normalizeListing(result, safePath)
      if (!normalized) {
        setListingState({ workspaceId, path: safePath, status: 'error' })
        return
      }
      setListingState({ workspaceId, path: safePath, status: 'ready', ...normalized })
    }).catch(() => {
      if (listingGeneration.current === generation) setListingState({ workspaceId, path: safePath, status: 'error' })
    })
    return () => { if (listingGeneration.current === generation) listingGeneration.current += 1 }
  }, [readOnlyFilePort, workspaceId, path, listingReload])

  useEffect(() => {
    readGeneration.current += 1
    setReadState(null)
  }, [workspaceId, path])

  useEffect(() => () => {
    listingGeneration.current += 1
    readGeneration.current += 1
  }, [])

  function navigate(nextPath: string): void {
    const safePath = canonicalPath(nextPath)
    if (safePath === null) return
    setLocationState({ workspaceId, path: safePath })
    setSelectedState(null)
    setReadState(null)
  }

  function retryListing(): void {
    setListingReload((value) => value + 1)
  }

  function openFile(filePath: string): void {
    const safePath = canonicalPath(filePath)
    if (!safePath || !safePath.startsWith(path ? `${path}/` : '') || safePath.split('/').at(-1) === '') return
    const generation = ++readGeneration.current
    setSelectedState({ workspaceId, path: safePath })
    setReadState({ workspaceId, path: safePath, status: 'loading' })
    void readOnlyFilePort.read(workspaceId, safePath, READ_LIMIT_BYTES).then((result) => {
      if (readGeneration.current !== generation) return
      if (result?.binary === true) {
        setReadState({ workspaceId, path: safePath, status: 'binary' })
        return
      }
      if (!result || result.path !== safePath || typeof result.content !== 'string' || result.content.includes('\0')) {
        setReadState({ workspaceId, path: safePath, status: 'binary' })
        return
      }
      setReadState({
        workspaceId,
        path: safePath,
        status: 'ready',
        content: result.content.slice(0, DISPLAY_LIMIT_CHARS),
        truncated: result.truncated === true || result.content.length > DISPLAY_LIMIT_CHARS,
      })
    }).catch((error: unknown) => {
      if (readGeneration.current !== generation) return
      setReadState({ workspaceId, path: safePath, status: isBinaryReadError(error) ? 'binary' : 'error' })
    })
  }

  const breadcrumbs = path ? path.split('/') : []

  return <section className="workspace-file-browser" aria-label="Workspace files">
    <header className="workspace-file-browser-header">
      <div>
        <h3>WORKSPACE FILES</h3>
        <p>Read-only preview · server-owned checkout</p>
      </div>
      <span className="workspace-file-readonly-badge">READ ONLY</span>
    </header>

    <nav className="workspace-file-breadcrumbs" aria-label="Workspace file path">
      <button type="button" aria-current={path === '' ? 'location' : undefined} onClick={() => navigate('')}>Workspace root</button>
      {breadcrumbs.map((part, index) => {
        const target = breadcrumbs.slice(0, index + 1).join('/')
        return <span className="workspace-file-breadcrumb-part" key={target}>
          <span aria-hidden="true">/</span>
          <button type="button" aria-current={target === path ? 'location' : undefined} onClick={() => navigate(target)}>{part}</button>
        </span>
      })}
    </nav>

    <div className="workspace-file-browser-grid">
      <section className="workspace-file-list-pane" aria-label="Workspace directory entries">
        <div className="workspace-file-list-toolbar">
          <strong>{path || 'Root'}</strong>
          {path && <button type="button" onClick={() => navigate(parentPath(path))}>Up one level</button>}
        </div>
        {currentListing?.status === 'loading' && <p className="workspace-file-message" role="status">Loading this folder…</p>}
        {currentListing?.status === 'error' && <div className="workspace-file-message" role="alert">
          <span>Could not load this folder. The path may be unavailable for this workspace.</span>
          <button type="button" onClick={retryListing}>Retry folder</button>
        </div>}
        {currentListing?.status === 'ready' && <>
          {currentListing.truncated && <p className="workspace-file-truncated" role="status">This folder has more entries than the 100-item preview limit.</p>}
          {currentListing.entries.length === 0
            ? <p className="workspace-file-message">This folder is empty.</p>
            : <ul className="workspace-file-entries">
              {currentListing.entries.map((entry) => <li key={entry.path}>
                {entry.kind === 'directory'
                  ? <button className="workspace-file-entry workspace-file-entry-directory" type="button" aria-label={`${entry.name} Folder`} onClick={() => navigate(entry.path)}>
                    <span className="workspace-file-entry-name"><span aria-hidden="true">▸</span>{entry.name}</span>
                    <span>Folder</span>
                  </button>
                  : <button className={`workspace-file-entry workspace-file-entry-file${selectedPath === entry.path ? ' is-selected' : ''}`} type="button" aria-label={`${entry.name} ${entry.size == null ? 'Size unavailable' : byteLabel(entry.size)}`} onClick={() => openFile(entry.path)} aria-pressed={selectedPath === entry.path}>
                    <span className="workspace-file-entry-name"><span aria-hidden="true">·</span>{entry.name}</span>
                    <span>{entry.size == null ? 'Size unavailable' : byteLabel(entry.size)}</span>
                  </button>}
              </li>)}
            </ul>}
        </>}
      </section>

      <section className="workspace-file-preview-pane" aria-label="Read-only file preview">
        <div className="workspace-file-preview-heading">
          <strong>{selectedPath?.split('/').at(-1) ?? 'Preview'}</strong>
          <span>TEXT ONLY</span>
        </div>
        {!selectedPath && <p className="workspace-file-message">Choose a file to preview its text.</p>}
        {currentRead?.status === 'loading' && <p className="workspace-file-message" role="status">Reading file…</p>}
        {currentRead?.status === 'binary' && <p className="workspace-file-message workspace-file-binary" role="alert">Binary files cannot be previewed as text.</p>}
        {currentRead?.status === 'error' && <div className="workspace-file-message" role="alert">
          <span>Could not read this file. It may be unavailable or protected.</span>
          {selectedPath && <button type="button" onClick={() => openFile(selectedPath)}>Retry file</button>}
        </div>}
        {currentRead?.status === 'ready' && <>
          {currentRead.truncated && <p className="workspace-file-truncated" role="status">Showing a partial preview. The server or display limit stopped the text here.</p>}
          <pre className="workspace-file-preview-content">{currentRead.content || '(empty file)'}</pre>
        </>}
      </section>
    </div>
  </section>
}
