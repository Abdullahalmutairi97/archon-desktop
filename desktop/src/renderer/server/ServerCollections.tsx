import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { ConnectionDescription, DesktopBridge, JsonRecord, LocalCodexProjectDto } from '../../shared/bridge/types'
import { PrimeTaskPanel } from './PrimeTaskPanel'
import { RuntimeCompatibility } from './RuntimeCompatibility'
import { WorkspaceFileBrowser, type WorkspaceReadOnlyFilePort } from './WorkspaceFileBrowser'
import { WorkspaceConsole } from './WorkspaceConsole'
import { LanguageProfiles } from './LanguageProfiles'
import { WorkspaceServices } from './WorkspaceServices'
import './ServerCollections.css'

type CollectionData = {
  projects: readonly JsonRecord[]
  sessions: readonly JsonRecord[]
  tasks: readonly JsonRecord[]
}

type LoadState =
  | { bridge: DesktopBridge; generation: number; state: 'loading' }
  | { bridge: DesktopBridge; generation: number; state: 'ready'; data: CollectionData }
  | { bridge: DesktopBridge; generation: number; state: 'unavailable'; reason: 'unauthorized' | 'unknown' }

type WorkspaceLoadState =
  | { bridge: DesktopBridge; generation: number; state: 'loading' }
  | { bridge: DesktopBridge; generation: number; state: 'ready'; records: readonly JsonRecord[] }
  | { bridge: DesktopBridge; generation: number; state: 'unavailable'; reason: 'unauthorized' | 'unknown' }

const MAX_LABEL_LENGTH = 120

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readRecords(result: unknown, key: 'projects' | 'sessions' | 'tasks' | 'workspaces'): readonly JsonRecord[] {
  if (!isPlainRecord(result)) throw new TypeError('Invalid server collection response')
  const rows = result[key]
  if (!Array.isArray(rows) || !rows.every(isPlainRecord)) {
    throw new TypeError('Invalid server collection response')
  }
  return rows as JsonRecord[]
}

function exactTextField(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

type WorkspaceProjectChoice = { id: string; name: string }

function workspaceProjectChoices(projects: readonly JsonRecord[]): WorkspaceProjectChoice[] {
  const seen = new Set<string>()
  return projects.flatMap((record) => {
    const id = exactTextField(record, 'id')
    if (!id || id.length > 200 || id !== id.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(id) || seen.has(id)) return []
    seen.add(id)
    return [{ id, name: textField(record, 'name', 'title') ?? id }]
  })
}

function isUnauthorizedRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')
    return !!code && 'value' in code && code.value === 'unauthorized'
  } catch {
    return false
  }
}

function operationErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')
    return code && 'value' in code && typeof code.value === 'string' ? code.value : null
  } catch {
    return null
  }
}

function textField(record: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== 'string') continue
    const normalized = value.slice(0, MAX_LABEL_LENGTH).trim()
    if (!normalized) continue
    return normalized
  }
  return null
}

function collectionTitle(record: JsonRecord, kind: 'project' | 'session' | 'task'): string {
  const label = kind === 'project'
    ? textField(record, 'name', 'title', 'id')
    : textField(record, 'title', 'name', 'id')
  return label ?? `Unnamed ${kind}`
}

function CollectionSection({
  title,
  kind,
  records,
}: {
  title: 'PROJECTS' | 'SESSIONS' | 'TASKS'
  kind: 'project' | 'session' | 'task'
  records: readonly JsonRecord[]
}) {
  return <section className="server-collection" aria-label={`SERVER ${title}`}>
    <div className="server-collection-heading"><h3>SERVER {title}</h3><span>{records.length} shown</span></div>
    {records.length === 0
      ? <p className="server-collection-empty">No server {title.toLowerCase()} returned.</p>
      : <ul>
        {records.map((record, index) => {
          const id = textField(record, 'id')
          const secondary = kind === 'session'
            ? textField(record, 'runtime', 'source', 'status')
            : textField(record, 'status')
          return <li className="server-collection-row" key={id ?? `${kind}-${index}`}>
            <strong>{collectionTitle(record, kind)}</strong>
            {secondary && <span>{secondary}</span>}
          </li>
        })}
      </ul>}
  </section>
}

/**
 * Owner and HEAD labels for one workspace row. They are shown only for a record
 * that carries both fields in the validated shape; anything else is
 * `unavailable`, as it is for an older server that does not report them.
 */
function workspaceOwnership(record: JsonRecord): { owner: string; branch: string } {
  const owner = exactTextField(record, 'owner_id')
  const checkout = record.checkout
  if (!owner || !isPlainRecord(checkout)) return { owner: 'unavailable', branch: 'unavailable' }
  if (checkout.state === 'branch' && typeof checkout.branch === 'string') {
    return { owner, branch: `on ${checkout.branch}` }
  }
  if (checkout.state === 'detached' && typeof checkout.commit === 'string' && typeof checkout.at_head_revision === 'boolean') {
    const commit = checkout.commit.slice(0, 12)
    return {
      owner,
      branch: checkout.at_head_revision
        ? `detached at ${commit} (provisioned revision)`
        : `detached at ${commit} (moved since provisioning)`,
    }
  }
  if (checkout.state === 'unknown') return { owner, branch: 'unknown (HEAD could not be read safely)' }
  return { owner: 'unavailable', branch: 'unavailable' }
}

function isAbsoluteServerPath(value: string): boolean {
  if (value.length > 1_000 || !value.startsWith('/') || /[\u0001-\u001f\u007f-\u009f]/u.test(value)) return false
  if (value === '/') return true
  if (value.endsWith('/')) return false
  return value.slice(1).split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function ServerProjectRegistration({ bridge, onRegistered }: { bridge: DesktopBridge; onRegistered: () => void }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const lock = useRef(false)
  const validPath = isAbsoluteServerPath(path.trim())
  const projectName = name.trim()
  const validName = projectName.length > 0 && !/[\u0001-\u001f\u007f-\u009f]/u.test(projectName)

  async function registerProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const serverPath = path.trim()
    if (lock.current || !validName || !isAbsoluteServerPath(serverPath)) return
    lock.current = true
    setPending(true)
    setFeedback(null)
    try {
      await bridge.api.invoke('projects.create', { name: projectName, path: serverPath })
      setName('')
      setPath('')
      setFeedback({ kind: 'success', text: `Registered “${projectName}” from the server Git repository.` })
      onRegistered()
    } catch (error) {
      const code = operationErrorCode(error)
      const text = code === 'unauthorized'
        ? 'Project registration was rejected. Return to Connection to re-enter the server token.'
        : code === 'unsupported_operation'
          ? 'This server does not support project registration yet.'
          : code === 'http_error'
            ? 'The server could not register this project. Check that the directory exists, is a Git repository, and is inside the backend’s allowed project area.'
            : code === 'network_error' || code === 'invalid_response' || code === 'response_too_large'
              ? 'Could not confirm whether registration completed. The project list was refreshed; check for this project before retrying.'
              : 'Could not register this server project. Check the backend path and connection, then try again.'
      setFeedback({ kind: 'error', text })
      if (code === 'network_error' || code === 'invalid_response' || code === 'response_too_large') onRegistered()
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  return <section className="server-project-registration" aria-label="Register server project">
    <form className="server-project-form" onSubmit={(event) => { void registerProject(event) }}>
      <h4>Register an existing Git project</h4>
      <p>Use an absolute path inside the backend’s allowed project area. The directory must already exist and contain a Git repository.</p>
      <label>
        <span>Project name</span>
        <input
          aria-label="Project name"
          type="text"
          autoComplete="off"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          disabled={pending}
        />
      </label>
      <label>
        <span>Backend Git directory path</span>
        <input
          aria-label="Backend Git directory path"
          type="text"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={1000}
          placeholder="/path/to/my-project"
          value={path}
          onChange={(event) => setPath(event.currentTarget.value)}
          disabled={pending}
          aria-invalid={path.trim().length > 0 && !validPath}
        />
      </label>
      {path.trim().length > 0 && !validPath && <p className="server-project-hint">Enter a canonical absolute POSIX path, such as <code>/path/to/my-project</code>.</p>}
      <button type="submit" disabled={pending || !validName || !validPath}>
        {pending ? 'Registering project…' : 'Register server project'}
      </button>
      {feedback && <p className={`server-project-feedback feedback-${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
    </form>
  </section>
}

function WorkspaceSection({
  bridge,
  state,
  records,
  onRetry,
  accessRejected,
  projects,
  projectsLoading,
  localCodexPairingAvailable,
  onLocalCodexProjectRegistered,
}: {
  bridge: DesktopBridge
  state: 'loading' | 'ready' | 'unavailable'
  records: readonly JsonRecord[]
  onRetry: () => void
  accessRejected: boolean
  projects: readonly JsonRecord[] | null
  projectsLoading: boolean
  localCodexPairingAvailable: boolean
  onLocalCodexProjectRegistered?: (project: LocalCodexProjectDto) => void
}) {
  const choices = workspaceProjectChoices(projects ?? [])
  const [projectId, setProjectId] = useState('')
  const [revision, setRevision] = useState('')
  const [headPending, setHeadPending] = useState(false)
  const [headMessage, setHeadMessage] = useState<string | null>(null)
  const [provisionPending, setProvisionPending] = useState(false)
  const [provisionMessage, setProvisionMessage] = useState<{ kind: 'success' | 'error' | 'ambiguous'; text: string } | null>(null)
  const [localCodexPendingWorkspaceId, setLocalCodexPendingWorkspaceId] = useState<string | null>(null)
  const [localCodexFeedback, setLocalCodexFeedback] = useState<{ workspaceId: string; kind: 'success' | 'error'; text: string } | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedConsoleWorkspaceId, setSelectedConsoleWorkspaceId] = useState<string | null>(null)
  const provisionLock = useRef(false)
  const headLock = useRef(false)
  const localCodexLock = useRef(false)
  const readOnlyFilePort = useMemo<WorkspaceReadOnlyFilePort>(() => ({
    list: (workspaceId, path, limit) => bridge.api.invoke('workspaces.files.list', { workspaceId, path, limit }),
    read: (workspaceId, path, maxBytes) => bridge.api.invoke('workspaces.files.read', { workspaceId, path, maxBytes }),
    search: (workspaceId, query) => bridge.api.invoke('workspaces.files.search', { workspaceId, query }),
    write: (workspaceId, path, expectedContent, content) => bridge.api.invoke('workspaces.files.write', {
      workspaceId, path, expectedContent, content,
    }),
    create: (workspaceId, path, content) => bridge.api.invoke('workspaces.files.create', {
      workspaceId, path, content,
    }),
    diff: (workspaceId, path) => bridge.api.invoke('workspaces.files.diff', { workspaceId, path }),
  }), [bridge])
  const selectedProjectId = choices.some((choice) => choice.id === projectId) ? projectId : choices[0]?.id ?? ''
  const revisionIsCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(revision)
  const activeWorkspaceId = state === 'ready' && records.some((record) => record.workspace_id === selectedWorkspaceId)
    ? selectedWorkspaceId : null
  const activeConsoleRecord = state === 'ready'
    ? records.find((record) => record.workspace_id === selectedConsoleWorkspaceId) : undefined
  const activeConsoleWorkspaceId = typeof activeConsoleRecord?.workspace_id === 'string'
    && /^workspace-[0-9a-f]{32}$/u.test(activeConsoleRecord.workspace_id) ? activeConsoleRecord.workspace_id : null
  const activeConsoleGeneration = typeof activeConsoleRecord?.generation === 'number'
    && Number.isSafeInteger(activeConsoleRecord.generation) && activeConsoleRecord.generation >= 1
    ? activeConsoleRecord.generation : null

  async function useCurrentHead(): Promise<void> {
    if (headLock.current || provisionLock.current || !selectedProjectId || projects === null) return
    headLock.current = true
    setHeadPending(true)
    setHeadMessage(null)
    try {
      const result = await bridge.api.invoke('projects.head', { projectId: selectedProjectId })
      setRevision(result.revision)
    } catch {
      setHeadMessage('Could not load this project’s current commit. You can enter a full commit SHA manually.')
    } finally {
      headLock.current = false
      setHeadPending(false)
    }
  }

  async function provisionWorkspace(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (provisionLock.current || headLock.current || !selectedProjectId || !revisionIsCommit || projects === null) return
    provisionLock.current = true
    setProvisionPending(true)
    setProvisionMessage(null)
    try {
      const result = await bridge.api.invoke('workspaces.provision', {
        projectId: selectedProjectId,
        revision,
      })
      setRevision('')
      setProvisionMessage({ kind: 'success', text: `Workspace ${result.workspace.workspace_id} was created.` })
      onRetry()
    } catch (error) {
      const code = operationErrorCode(error)
      if (code === 'unauthorized') {
        setProvisionMessage({ kind: 'error', text: 'Workspace creation access was rejected. Return to Connection to re-enter the server token.' })
      } else if (code === 'unsupported_operation') {
        setProvisionMessage({ kind: 'error', text: 'This server does not support Git checkout creation yet.' })
      } else if (code === 'network_error' || code === 'connection_changed' || code === 'http_error' || code === 'invalid_response' || code === 'response_too_large') {
        setProvisionMessage({ kind: 'ambiguous', text: 'Could not confirm whether the checkout was created. Refresh the workspace list before retrying.' })
      } else {
        setProvisionMessage({ kind: 'error', text: 'Workspace checkout could not be created. Check the selected project and revision.' })
      }
    } finally {
      provisionLock.current = false
      setProvisionPending(false)
    }
  }

  async function registerWorkspaceWithLocalCodex(workspaceId: string): Promise<void> {
    if (!localCodexPairingAvailable || localCodexLock.current || !/^workspace-[0-9a-f]{32}$/u.test(workspaceId)) return
    localCodexLock.current = true
    setLocalCodexPendingWorkspaceId(workspaceId)
    setLocalCodexFeedback(null)
    try {
      const project = await bridge.localCodex.registerWorkspace({ workspaceId })
      setLocalCodexFeedback({
        workspaceId,
        kind: 'success',
        text: 'Added to Local Codex. You can enter a prompt now.',
      })
      onLocalCodexProjectRegistered?.(project)
    } catch {
      setLocalCodexFeedback({
        workspaceId,
        kind: 'error',
        text: 'Could not add this workspace to Local Codex. Try again.',
      })
    } finally {
      localCodexLock.current = false
      setLocalCodexPendingWorkspaceId(null)
    }
  }

  return <section className="server-collection server-workspaces" aria-label="SERVER WORKSPACES">
    <div className="server-collection-heading"><h3>SERVER WORKSPACES</h3><span>{state === 'ready' ? `${records.length} shown` : state === 'loading' ? 'loading' : 'unavailable'}</span></div>
    <p className="server-workspace-status">Server Git checkout; Local Codex ownership depends on setup. Native execution isolation is not enabled.</p>
    {state === 'loading' && <p className="server-collection-empty">Loading workspaces from this server…</p>}
    {state === 'unavailable' && <div className="server-workspace-unavailable" role="alert">
      <span>{accessRejected
        ? 'Workspace access was rejected. Return to Connection to re-enter the server token.'
        : 'Workspace data is unavailable for this server connection.'}</span>
      {!accessRejected && <button type="button" onClick={onRetry}>Retry workspaces</button>}
    </div>}
    <form className="server-workspace-form" onSubmit={(event) => { void provisionWorkspace(event) }}>
      <h4>Create a Git checkout</h4>
      {projectsLoading && <p>Loading registered projects…</p>}
      {!projectsLoading && projects === null && <p>Registered projects are unavailable; checkout creation is disabled.</p>}
      {!projectsLoading && projects !== null && choices.length === 0 && <p>No registered server projects are available.</p>}
      {projects !== null && choices.length > 0 && <label>
        <span>Registered project</span>
        <select aria-label="Registered project" value={selectedProjectId} onChange={(event) => { setProjectId(event.currentTarget.value); setRevision(''); setHeadMessage(null) }} disabled={provisionPending || headPending}>
          {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name} · {choice.id}</option>)}
        </select>
      </label>}
      <label>
        <span>Full commit SHA</span>
        <input
          aria-label="Full commit SHA"
          type="text"
          autoComplete="off"
          spellCheck={false}
          required
          minLength={40}
          maxLength={64}
          pattern="(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})"
          placeholder="40 or 64 hexadecimal characters"
          value={revision}
          onChange={(event) => setRevision(event.currentTarget.value)}
          disabled={provisionPending || headPending || projects === null || choices.length === 0}
        />
      </label>
      <button type="button" onClick={() => { void useCurrentHead() }} disabled={provisionPending || headPending || projects === null || choices.length === 0}>
        {headPending ? 'Loading current commit…' : 'Use current HEAD'}
      </button>
      {headMessage && <p role="alert">{headMessage}</p>}
      <button type="submit" disabled={provisionPending || headPending || projects === null || choices.length === 0 || !revisionIsCommit}>
        {provisionPending ? 'Creating checkout…' : 'Create Git checkout'}
      </button>
      {provisionMessage && <p className={`server-workspace-feedback feedback-${provisionMessage.kind}`} role={provisionMessage.kind === 'error' ? 'alert' : 'status'}>
        {provisionMessage.text}
        {provisionMessage.kind === 'ambiguous' && <button type="button" onClick={onRetry}>Refresh workspace list</button>}
      </p>}
    </form>
    {state === 'ready' && records.length === 0
      ? <p className="server-collection-empty">No server workspaces returned.</p>
      : state === 'ready' && <ul>
        {records.map((record, index) => {
          const id = exactTextField(record, 'workspace_id') ?? `workspace-${index + 1}`
          const projectId = exactTextField(record, 'project_id') ?? 'Unavailable'
          const baseRevision = exactTextField(record, 'base_revision') ?? 'Unavailable'
          const headRevision = exactTextField(record, 'head_revision') ?? 'Unavailable'
          const root = exactTextField(record, 'root') ?? 'Unavailable'
          const generation = typeof record.generation === 'number' && Number.isSafeInteger(record.generation)
            ? String(record.generation)
            : 'Unavailable'
          const ownership = workspaceOwnership(record)
          return <li className="server-collection-row server-workspace-row" key={id}>
            <strong>{id}</strong>
            <span>Authority: server-managed checkout · Generation: {generation}</span>
            <span dir="auto">Source project: {projectId} · Owner: {ownership.owner} · Branch: {ownership.branch}</span>
            <span>Revisions: base {baseRevision} · head {headRevision}</span>
            <code>Authoritative root: {root}</code>
            {/^workspace-[0-9a-f]{32}$/u.test(id) && <button type="button" className="server-workspace-browse" aria-pressed={activeWorkspaceId === id} onClick={() => setSelectedWorkspaceId(activeWorkspaceId === id ? null : id)}>
              {activeWorkspaceId === id ? 'Close files' : 'Browse files'}
            </button>}
            {/^workspace-[0-9a-f]{32}$/u.test(id) && <button type="button" className="server-workspace-browse" aria-pressed={selectedConsoleWorkspaceId === id} onClick={() => setSelectedConsoleWorkspaceId(selectedConsoleWorkspaceId === id ? null : id)}>
              {selectedConsoleWorkspaceId === id ? 'Close line console' : 'Open line console'}
            </button>}
            {localCodexPairingAvailable && /^workspace-[0-9a-f]{32}$/u.test(id) && <>
              <button
                type="button"
                className="server-workspace-local-codex"
                onClick={() => { void registerWorkspaceWithLocalCodex(id) }}
                disabled={localCodexPendingWorkspaceId !== null}
              >
                {localCodexPendingWorkspaceId === id ? 'Registering…' : 'Add to Local Codex'}
              </button>
              {localCodexFeedback?.workspaceId === id && <p className={`server-workspace-feedback feedback-${localCodexFeedback.kind}`} role={localCodexFeedback.kind === 'error' ? 'alert' : 'status'}>
                {localCodexFeedback.text}
              </p>}
            </>}
          </li>
        })}
      </ul>}
    {activeWorkspaceId && <WorkspaceFileBrowser key={activeWorkspaceId} workspaceId={activeWorkspaceId} readOnlyFilePort={readOnlyFilePort} />}
    {activeConsoleWorkspaceId && activeConsoleGeneration !== null && <WorkspaceConsole
      key={`${activeConsoleWorkspaceId}:${activeConsoleGeneration}`}
      bridge={bridge.workspaceConsole}
      workspaceId={activeConsoleWorkspaceId}
      generation={activeConsoleGeneration}
      pairingAvailable={localCodexPairingAvailable}
    />}
    {activeConsoleWorkspaceId && activeConsoleGeneration !== null && <WorkspaceServices
      key={`services:${activeConsoleWorkspaceId}:${activeConsoleGeneration}`}
      bridge={bridge.workspaceServices}
      preview={bridge.workspacePreview}
      workspaceId={activeConsoleWorkspaceId}
      generation={activeConsoleGeneration}
      pairingAvailable={localCodexPairingAvailable}
    />}
    {activeConsoleWorkspaceId && activeConsoleGeneration !== null && <LanguageProfiles
      key={`profiles:${activeConsoleWorkspaceId}:${activeConsoleGeneration}`}
      bridge={bridge.languageProfiles}
      workspaceId={activeConsoleWorkspaceId}
      generation={activeConsoleGeneration}
      pairingAvailable={localCodexPairingAvailable}
    />}
  </section>
}

/** Read-only projection of remote collections. Connection state is owned by the shell. */
export function ServerCollections({
  bridge,
  connection,
  onLocalCodexProjectRegistered,
}: {
  bridge?: DesktopBridge
  connection: ConnectionDescription | null
  onLocalCodexProjectRegistered?: (project: LocalCodexProjectDto) => void
}) {
  const serial = useRef(0)
  const workspaceSerial = useRef(0)
  const [reload, setReload] = useState(0)
  const [workspaceReload, setWorkspaceReload] = useState(0)
  const [loadState, setLoadState] = useState<LoadState | null>(null)
  const [workspaceLoadState, setWorkspaceLoadState] = useState<WorkspaceLoadState | null>(null)

  const generation = connection?.generation ?? -1
  const configured = connection?.configured === true
  const validGeneration = Number.isSafeInteger(generation) && generation >= 0

  useEffect(() => {
    const requestId = ++serial.current
    if (!bridge || !configured || !validGeneration) {
      setLoadState(null)
      return () => { serial.current += 1 }
    }

    setLoadState({ bridge, generation, state: 'loading' })
    void Promise.all([
      bridge.api.invoke('projects.list', {}),
      bridge.api.invoke('sessions.list', {}),
      bridge.api.invoke('tasks.list', {}),
    ]).then(([projects, sessions, tasks]) => {
      if (serial.current !== requestId) return
      setLoadState({
        bridge,
        generation,
        state: 'ready',
        data: {
          projects: readRecords(projects, 'projects'),
          sessions: readRecords(sessions, 'sessions'),
          tasks: readRecords(tasks, 'tasks'),
        },
      })
    }).catch((error: unknown) => {
      if (serial.current === requestId) {
        setLoadState({
          bridge,
          generation,
          state: 'unavailable',
          reason: isUnauthorizedRejection(error) ? 'unauthorized' : 'unknown',
        })
      }
    })

    return () => {
      if (serial.current === requestId) serial.current += 1
    }
  }, [bridge, configured, generation, validGeneration, reload])

  useEffect(() => {
    const requestId = ++workspaceSerial.current
    if (!bridge || !configured || !validGeneration) {
      setWorkspaceLoadState(null)
      return () => { workspaceSerial.current += 1 }
    }

    setWorkspaceLoadState({ bridge, generation, state: 'loading' })
    void bridge.api.invoke('workspaces.list', {}).then((result) => {
      if (workspaceSerial.current !== requestId) return
      setWorkspaceLoadState({
        bridge,
        generation,
        state: 'ready',
        records: readRecords(result, 'workspaces'),
      })
    }).catch((error: unknown) => {
      if (workspaceSerial.current === requestId) {
        setWorkspaceLoadState({
          bridge,
          generation,
          state: 'unavailable',
          reason: isUnauthorizedRejection(error) ? 'unauthorized' : 'unknown',
        })
      }
    })

    return () => {
      if (workspaceSerial.current === requestId) workspaceSerial.current += 1
    }
  }, [bridge, configured, generation, validGeneration, workspaceReload])

  const currentLoadState = loadState && bridge && configured && validGeneration && loadState.bridge === bridge && loadState.generation === generation
    ? loadState
    : null
  const state = currentLoadState?.state ?? (!bridge || !connection || (configured && !validGeneration) ? 'unavailable' : !configured ? 'disconnected' : 'loading')
  const data = currentLoadState?.state === 'ready' ? currentLoadState.data : null
  const accessRejected = currentLoadState?.state === 'unavailable' && currentLoadState.reason === 'unauthorized'
  const currentWorkspaceLoadState = workspaceLoadState && bridge && configured && validGeneration && workspaceLoadState.bridge === bridge && workspaceLoadState.generation === generation
    ? workspaceLoadState
    : null
  const workspaceState = currentWorkspaceLoadState?.state ?? (!bridge || !connection || (configured && !validGeneration) ? 'unavailable' : !configured ? 'disconnected' : 'loading')
  const workspaceRecords = currentWorkspaceLoadState?.state === 'ready' ? currentWorkspaceLoadState.records : []
  const workspaceAccessRejected = currentWorkspaceLoadState?.state === 'unavailable' && currentWorkspaceLoadState.reason === 'unauthorized'

  return <section className="server-collections" aria-label="Server collections">
    <header className="server-collections-header">
      <div><span className="eyebrow">SERVER DATA</span><h2>Projects, sessions, tasks and workspaces</h2></div>
      <span className={`server-collections-state state-${state}`} role="status">
        {state === 'ready' ? 'SERVER connected · data loaded' :
          state === 'loading' ? 'SERVER data loading' :
            state === 'disconnected' ? 'SERVER disconnected' :
              accessRejected ? 'SERVER access rejected' : 'SERVER unavailable'}
      </span>
    </header>

    {!bridge && <p className="server-collections-message">The desktop bridge is unavailable. This browser preview is offline.</p>}
    {bridge && !connection && <p className="server-collections-message">Connection status is unavailable.</p>}
    {state === 'loading' && <p className="server-collections-message">Loading read-only collections and workspaces from the server…</p>}
    {state === 'disconnected' && <p className="server-collections-message">Connect to a server to load projects, sessions, tasks and workspaces.</p>}
    {state === 'unavailable' && bridge && connection && <div className="server-collections-message" role="alert">
      <p>{accessRejected
        ? 'SERVER access rejected. Return to Connection to re-enter the server token.'
        : 'SERVER data unavailable. Check the server connection and token, then retry. No collection results are shown.'}</p>
      {configured && !accessRejected && <button type="button" onClick={() => setReload((current) => current + 1)}>Retry SERVER data</button>}
    </div>}

    {bridge && configured && validGeneration && <ServerProjectRegistration key={`server-project-registration-${generation}`} bridge={bridge} onRegistered={() => setReload((current) => current + 1)} />}

    {(data || (bridge && configured)) && <div className="server-collections-grid">
      {data && <>
        <CollectionSection title="PROJECTS" kind="project" records={data.projects} />
        <CollectionSection title="SESSIONS" kind="session" records={data.sessions} />
        <CollectionSection title="TASKS" kind="task" records={data.tasks} />
      </>}
      {bridge && configured && <WorkspaceSection
        key={generation}
        bridge={bridge}
        state={workspaceState === 'disconnected' ? 'unavailable' : workspaceState}
        records={workspaceRecords}
        accessRejected={workspaceAccessRejected}
        onRetry={() => setWorkspaceReload((current) => current + 1)}
        projects={data?.projects ?? null}
        projectsLoading={state === 'loading'}
        localCodexPairingAvailable={configured && connection?.localPairingAvailable === true}
        onLocalCodexProjectRegistered={onLocalCodexProjectRegistered}
      />}
    </div>}
    {(data || currentWorkspaceLoadState?.state === 'ready') && <p className="server-collections-note">Counts show rows returned; the server may cap session, task and workspace lists.</p>}
    {data && bridge && connection && <PrimeTaskPanel key={generation} bridge={bridge} connection={connection} projects={data.projects} tasks={data.tasks} workspaces={workspaceRecords} />}
    {bridge && connection?.configured === true && <RuntimeCompatibility key={generation} bridge={bridge} generation={connection.generation} />}
  </section>
}
