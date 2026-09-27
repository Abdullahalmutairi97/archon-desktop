import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ConnectionDescription, ConnectionProbeResult, DesktopBridge } from '../../shared/bridge/types'

interface ServerOverview {
  projects: number
  sessions: number
  tasks: number
  cursor: number
}

const connectionFailure = 'Connection check failed. Verify the address and token.'
const overviewFailure = 'The read-only server overview is unavailable.'

function storageHint(description: ConnectionDescription | null): string {
  if (description?.localPairingAvailable && !description.configured) {
    return 'Local pairing needs the Archon backend service running under the same Linux account as this desktop. See docs/operator-setup.md (installer: deploy/install-user-server.sh) to set it up, then retry.'
  }
  if (description?.localPairingAvailable && description.configured) {
    return 'Paired with the local Archon service. Its short-lived bearer stays in main-process memory and renews when needed.'
  }
  if (description?.storageMode === 'protected' && description.configured) {
    return 'The connection is stored with OS-protected storage. The token stays in the desktop main process.'
  }
  if (description?.storageMode === 'unavailable') {
    return 'Saved connection storage could not be read. Its record was left unchanged; disconnect to clear it.'
  }
  return 'The token is held in main-process memory and must be entered again after a restart.'
}

function statusLabel(description: ConnectionDescription | null, probe: ConnectionProbeResult | null): string {
  if (!description?.configured) return 'Disconnected'
  if (!probe) return 'Configured · not checked'
  if (!probe.ok) return probe.error?.code === 'unauthorized' ? 'Access rejected' : 'Connection unavailable'
  return probe.readiness?.dispatch_ready === true ? 'Dispatch ready' : 'Dispatch unavailable'
}

export function ConnectionPanel({ bridge }: { bridge?: DesktopBridge }) {
  const serial = useRef(0)
  const [description, setDescription] = useState<ConnectionDescription | null>(null)
  const [probe, setProbe] = useState<ConnectionProbeResult | null>(null)
  const [overview, setOverview] = useState<ServerOverview | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const id = ++serial.current
    if (bridge) {
      void bridge.connection.describe().then((value) => {
        if (serial.current !== id) return
        setDescription(value)
        setServerUrl((current) => current || value.serverUrl || '')
      }).catch(() => {
        if (serial.current === id) setMessage(connectionFailure)
      })
    }
    return () => { serial.current += 1 }
  }, [bridge])

  async function loadOverview(id: number): Promise<void> {
    if (!bridge) return
    try {
      const [projects, sessions, tasks, cursor] = await Promise.all([
        bridge.api.invoke('projects.list', {}),
        bridge.api.invoke('sessions.list', {}),
        bridge.api.invoke('tasks.list', {}),
        bridge.api.invoke('events.cursor', {}),
      ])
      if (serial.current !== id) return
      setOverview({
        projects: projects.projects.length,
        sessions: sessions.sessions.length,
        tasks: tasks.tasks.length,
        cursor: cursor.cursor,
      })
    } catch {
      if (serial.current === id) {
        setOverview(null)
        setMessage(overviewFailure)
      }
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!bridge || busy || description?.storageMode === 'unavailable' || !serverUrl.trim() || !token) return
    const id = ++serial.current
    const enteredToken = token
    setToken('')
    setBusy(true)
    setMessage('')
    setOverview(null)
    setProbe(null)
    try {
      const result = await bridge.connection.save({ serverUrl: serverUrl.trim(), token: enteredToken })
      if (serial.current !== id) return
      setDescription(result.description)
      setProbe(result.probe)
      if (result.probe.ok) await loadOverview(id)
    } catch {
      if (serial.current === id) setMessage(connectionFailure)
    } finally {
      if (serial.current === id) setBusy(false)
    }
  }

  async function refresh(): Promise<void> {
    if (!bridge || busy || (!description?.configured && !description?.localPairingAvailable)) return
    const id = ++serial.current
    setBusy(true)
    setMessage('')
    setOverview(null)
    setProbe(null)
    try {
      const result = await bridge.connection.probe()
      if (serial.current !== id) return
      setProbe(result)
      const updatedDescription = await bridge.connection.describe()
      if (serial.current !== id) return
      setDescription(updatedDescription)
      if (result.ok) await loadOverview(id)
    } catch {
      if (serial.current === id) setMessage(connectionFailure)
    } finally {
      if (serial.current === id) setBusy(false)
    }
  }

  async function disconnect(): Promise<void> {
    if (!bridge || busy || (!description?.configured && description?.storageMode !== 'unavailable')) return
    const id = ++serial.current
    setBusy(true)
    setToken('')
    setMessage('')
    setOverview(null)
    try {
      const value = await bridge.connection.disconnect()
      if (serial.current !== id) return
      setDescription(value)
      setProbe(null)
    } catch {
      if (serial.current === id) setMessage(connectionFailure)
    } finally {
      if (serial.current === id) setBusy(false)
    }
  }

  const status = statusLabel(description, probe)
  return <section className="collection-view connection-view" aria-label="Desktop connection">
    <div className="collection-intro"><span className="eyebrow">SERVER CONNECTION</span><p>Inspect backend readiness and counts through the desktop bridge. Server work can submit Prime tasks after confirmation; chat, files and workbench remain fixtures.</p></div>
    <div className="connection-layout">
      <form className="connection-card" onSubmit={(event) => { void connect(event) }}>
        <div className="connection-card-heading"><h2>Connect to Archon</h2><span className="fixture-tag">MAIN PROCESS</span></div>
        <label htmlFor="connection-url">Server address</label>
        <input id="connection-url" type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://archon.example" autoComplete="url" disabled={!bridge || busy} />
        <label htmlFor="connection-token">Device token</label>
        <input id="connection-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" disabled={!bridge || busy} />
        <p className="connection-hint">{storageHint(description)}</p>
        <div className="connection-actions"><button className="connection-primary" type="submit" disabled={!bridge || busy || description?.storageMode === 'unavailable' || !serverUrl.trim() || !token}>Connect</button><button type="button" onClick={() => { void refresh() }} disabled={!bridge || busy || (!description?.configured && !description?.localPairingAvailable)}>{description?.localPairingAvailable && !description.configured ? 'Retry local pairing' : 'Check again'}</button><button type="button" onClick={() => { void disconnect() }} disabled={!bridge || busy || (!description?.configured && description?.storageMode !== 'unavailable')}>{description?.storageMode === 'unavailable' && !description.configured ? 'Clear saved record' : 'Disconnect'}</button></div>
      </form>
      <section className="connection-card connection-status-card" aria-label="Read-only connection status">
        <div className="connection-card-heading"><h2>Backend status</h2><span className="fixture-tag">NO COMMANDS</span></div>
        <p className="connection-status" role="status"><i className={probe?.ok ? 'connected' : ''} />{status}</p>
        {description?.configured && <p className="connection-address">{description.serverUrl}</p>}
        {probe?.ok && <p className="connection-hint">The backend accepted this connection. Native execution and provider credentials are still unverified.</p>}
        {overview && <><div className="connection-overview" aria-label="Server overview"><strong>{overview.projects} {overview.projects === 1 ? 'project' : 'projects'} returned</strong><strong>{overview.sessions} {overview.sessions === 1 ? 'session' : 'sessions'} returned</strong><strong>{overview.tasks} {overview.tasks === 1 ? 'task' : 'tasks'} returned</strong><span>Cursor {overview.cursor}</span></div><p className="connection-hint">Session and task lists are capped by the server; these are returned rows, not totals.</p></>}
        {!bridge && <p className="connection-note">Connection requires the desktop bridge. This browser preview stays offline.</p>}
        {message && <p className="connection-error" role="alert">{message}</p>}
      </section>
    </div>
  </section>
}
