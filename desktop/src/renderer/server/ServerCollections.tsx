import { useEffect, useRef, useState } from 'react'
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

const MAX_LABEL_LENGTH = 120

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readRecords(result: unknown, key: 'projects' | 'sessions' | 'tasks'): readonly JsonRecord[] {
  if (!isPlainRecord(result)) throw new TypeError('Invalid server collection response')
  const rows = result[key]
  if (!Array.isArray(rows) || !rows.every(isPlainRecord)) {
    throw new TypeError('Invalid server collection response')
  }
  return rows as JsonRecord[]
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

/** Read-only projection of remote collections. Connection state is owned by the shell. */
export function ServerCollections({
  bridge,
  connection,
}: {
  bridge?: DesktopBridge
  connection: ConnectionDescription | null
}) {
  const serial = useRef(0)
  const [reload, setReload] = useState(0)
  const [loadState, setLoadState] = useState<LoadState | null>(null)

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

  const currentLoadState = loadState && bridge && configured && validGeneration && loadState.bridge === bridge && loadState.generation === generation
    ? loadState
    : null
  const state = currentLoadState?.state ?? (!bridge || !connection || (configured && !validGeneration) ? 'unavailable' : !configured ? 'disconnected' : 'loading')
  const data = currentLoadState?.state === 'ready' ? currentLoadState.data : null
  const accessRejected = currentLoadState?.state === 'unavailable' && currentLoadState.reason === 'unauthorized'

  return <section className="server-collections" aria-label="Server collections">
    <header className="server-collections-header">
      <div><span className="eyebrow">SERVER DATA</span><h2>Projects, sessions and tasks</h2></div>
      <span className={`server-collections-state state-${state}`} role="status">
        {state === 'ready' ? 'SERVER connected · data loaded' :
          state === 'loading' ? 'SERVER data loading' :
            state === 'disconnected' ? 'SERVER disconnected' :
              accessRejected ? 'SERVER access rejected' : 'SERVER unavailable'}
      </span>
    </header>

    {!bridge && <p className="server-collections-message">The desktop bridge is unavailable. This browser preview is offline.</p>}
    {bridge && !connection && <p className="server-collections-message">Connection status is unavailable.</p>}
    {state === 'loading' && <p className="server-collections-message">Loading read-only collections from the server…</p>}
    {state === 'disconnected' && <p className="server-collections-message">Connect to a server to load projects, sessions and tasks.</p>}
    {state === 'unavailable' && bridge && connection && <div className="server-collections-message" role="alert">
      <p>{accessRejected
        ? 'SERVER access rejected. Return to Connection to re-enter the server token.'
        : 'SERVER data unavailable. Check the server connection and token, then retry. No collection results are shown.'}</p>
      {configured && !accessRejected && <button type="button" onClick={() => setReload((current) => current + 1)}>Retry SERVER data</button>}
    </div>}

    {data && <div className="server-collections-grid">
      <CollectionSection title="PROJECTS" kind="project" records={data.projects} />
      <CollectionSection title="SESSIONS" kind="session" records={data.sessions} />
      <CollectionSection title="TASKS" kind="task" records={data.tasks} />
    </div>}
    {data && <p className="server-collections-note">Counts show rows returned; the server may cap session and task lists.</p>}
    {data && bridge && connection && <PrimeTaskPanel key={generation} bridge={bridge} connection={connection} projects={data.projects} tasks={data.tasks} />}
  </section>
}
