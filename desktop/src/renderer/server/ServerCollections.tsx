import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ConnectionDescription, DesktopBridge, JsonRecord } from '../../shared/bridge/types'
import { PrimeTaskPanel } from './PrimeTaskPanel'
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

function WorkspaceSection({
  bridge,
  state,
  records,
  onRetry,
  accessRejected,
  projects,
  projectsLoading,
}: {
  bridge: DesktopBridge
  state: 'loading' | 'ready' | 'unavailable'
  records: readonly JsonRecord[]
  onRetry: () => void
  accessRejected: boolean
  projects: readonly JsonRecord[] | null
  projectsLoading: boolean
}) {
  const choices = workspaceProjectChoices(projects ?? [])
  const [projectId, setProjectId] = useState('')
  const [revision, setRevision] = useState('')
  const [provisionPending, setProvisionPending] = useState(false)
  const [provisionMessage, setProvisionMessage] = useState<{ kind: 'success' | 'error' | 'ambiguous'; text: string } | null>(null)
  const provisionLock = useRef(false)
  const selectedProjectId = choices.some((choice) => choice.id === projectId) ? projectId : choices[0]?.id ?? ''
  const revisionIsCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(revision)

  async function provisionWorkspace(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (provisionLock.current || !selectedProjectId || !revisionIsCommit || projects === null) return
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

  return <section className="server-collection" aria-label="SERVER WORKSPACES">
    <div className="server-collection-heading"><h3>SERVER WORKSPACES</h3><span>{state === 'ready' ? `${records.length} shown` : state === 'loading' ? 'loading' : 'unavailable'}</span></div>
    <p className="server-workspace-status">Git checkout; native execution isolation not yet enabled</p>
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
        <select aria-label="Registered project" value={selectedProjectId} onChange={(event) => setProjectId(event.currentTarget.value)} disabled={provisionPending}>
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
          disabled={provisionPending || projects === null || choices.length === 0}
        />
      </label>
      <button type="submit" disabled={provisionPending || projects === null || choices.length === 0 || !revisionIsCommit}>
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
          const projectId = exactTextField(record, 'project_id') ?? 'Not recorded'
          const baseRevision = exactTextField(record, 'base_revision') ?? 'Not recorded'
          const headRevision = exactTextField(record, 'head_revision') ?? 'Not recorded'
          const root = exactTextField(record, 'root') ?? 'Unavailable'
          const generation = typeof record.generation === 'number' && Number.isSafeInteger(record.generation)
            ? String(record.generation)
            : 'Unknown'
          return <li className="server-collection-row server-workspace-row" key={id}>
            <strong>{id}</strong>
            <span>Project: {projectId} · Generation: {generation}</span>
            <span>Base revision: {baseRevision}</span>
            <span>Head revision: {headRevision}</span>
            <code>Authoritative root: {root}</code>
          </li>
        })}
      </ul>}
  </section>
}

/** Read-only projection of remote collections. Connection state is owned by the shell. */
export function ServerCollections({
  bridge,
  connection,
}: {
  bridge?: DesktopBridge
  connection: ConnectionDescription | null
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
      />}
    </div>}
    {(data || currentWorkspaceLoadState?.state === 'ready') && <p className="server-collections-note">Counts show rows returned; the server may cap session, task and workspace lists.</p>}
    {data && bridge && connection && <PrimeTaskPanel key={generation} bridge={bridge} connection={connection} projects={data.projects} tasks={data.tasks} />}
  </section>
}
