import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceServiceDefinitionInput, WorkspaceServiceDto, WorkspaceServicesBridge } from '../../shared/bridge/types'
import './WorkspaceServices.css'

const EMPTY_LOGS = { name: '', text: '', truncated: false }

export function WorkspaceServices({
  bridge,
  workspaceId,
  generation,
  pairingAvailable,
}: {
  bridge: WorkspaceServicesBridge
  workspaceId: string
  generation: number
  pairingAvailable: boolean
}) {
  const [services, setServices] = useState<readonly WorkspaceServiceDto[]>([])
  const [name, setName] = useState('')
  const [executable, setExecutable] = useState('')
  const [argsText, setArgsText] = useState('')
  const [cwd, setCwd] = useState('.')
  const [portName, setPortName] = useState('')
  const [portValue, setPortValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'status' | 'error'; text: string } | null>(null)
  const [pending, setPending] = useState<{ action: 'stop' | 'remove'; name: string } | null>(null)
  const [logs, setLogs] = useState<{ name: string; text: string; truncated: boolean }>(EMPTY_LOGS)
  const lock = useRef(false)
  const identity = `${workspaceId}:${generation}`
  const identityRef = useRef(identity)
  identityRef.current = identity

  const refresh = useCallback(async () => {
    if (!pairingAvailable) return
    const requested = identity
    try {
      const items = await bridge.list({ workspaceId })
      if (identityRef.current !== requested) return
      setServices(items)
    } catch {
      if (identityRef.current === requested) {
        setMessage({ kind: 'error', text: 'Service registry is unavailable. Check local pairing and the backend.' })
      }
    }
  }, [bridge, identity, pairingAvailable, workspaceId])

  useEffect(() => {
    setServices([])
    setLogs(EMPTY_LOGS)
    setPending(null)
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  function buildDefinition(): WorkspaceServiceDefinitionInput | null {
    const argv = [executable.trim(), ...argsText.split('\n').map((line) => line.trim()).filter(Boolean)]
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(name) || argv.length === 0 || !argv[0]) return null
    let ports: WorkspaceServiceDefinitionInput['ports'] = []
    if (portName || portValue) {
      const value = Number(portValue)
      if (!/^[a-z][a-z0-9-]{0,15}$/u.test(portName) || !Number.isInteger(value) || value < 1 || value > 65535) return null
      ports = [{ name: portName, port: value }]
    }
    return {
      name, argv, cwd: cwd.trim() || '.', env: [], ports,
      health: null, dependsOn: [], restart: 'never', memoryLimitMb: null,
    }
  }

  async function define(): Promise<void> {
    if (lock.current || !pairingAvailable) return
    const definition = buildDefinition()
    if (definition === null) {
      setMessage({ kind: 'error', text: 'Service name must be a lowercase slug, executable is required, and a port needs a name and number.' })
      return
    }
    const requested = identity
    lock.current = true
    setBusy(true)
    setMessage(null)
    try {
      await bridge.define({ workspaceId, definition })
      if (identityRef.current !== requested) return
      setMessage({ kind: 'status', text: `Registered service ${definition.name}.` })
      await refresh()
    } catch {
      if (identityRef.current === requested) setMessage({ kind: 'error', text: 'Could not register the service. The backend rejected the definition.' })
    } finally {
      lock.current = false
      if (identityRef.current === requested) setBusy(false)
    }
  }

  async function startService(target: string): Promise<void> {
    if (lock.current || !pairingAvailable) return
    const requested = identity
    lock.current = true
    setBusy(true)
    setMessage(null)
    try {
      await bridge.start({ workspaceId, name: target })
      if (identityRef.current !== requested) return
      setMessage({ kind: 'status', text: `Started ${target}.` })
      await refresh()
    } catch {
      if (identityRef.current === requested) setMessage({ kind: 'error', text: `Could not confirm that ${target} started. Refresh the list before retrying.` })
    } finally {
      lock.current = false
      if (identityRef.current === requested) setBusy(false)
    }
  }

  async function confirmPending(): Promise<void> {
    const action = pending
    if (!action || lock.current || !pairingAvailable) return
    const requested = identity
    lock.current = true
    setBusy(true)
    setMessage(null)
    try {
      if (action.action === 'stop') await bridge.stop({ workspaceId, name: action.name, confirm: true })
      else await bridge.remove({ workspaceId, name: action.name, confirm: true })
      if (identityRef.current !== requested) return
      setMessage({ kind: 'status', text: action.action === 'stop' ? `Stopped ${action.name}.` : `Removed ${action.name}.` })
      setPending(null)
      setLogs(EMPTY_LOGS)
      await refresh()
    } catch {
      if (identityRef.current === requested) setMessage({ kind: 'error', text: `Could not confirm the ${action.action}. Refresh the list before retrying.` })
    } finally {
      lock.current = false
      if (identityRef.current === requested) setBusy(false)
    }
  }

  async function viewLogs(target: string): Promise<void> {
    if (lock.current || !pairingAvailable) return
    const requested = identity
    lock.current = true
    setBusy(true)
    try {
      const result = await bridge.logs({ workspaceId, name: target, lines: 200 })
      if (identityRef.current !== requested) return
      setLogs({ name: target, text: result.text, truncated: result.truncated })
    } catch {
      if (identityRef.current === requested) setMessage({ kind: 'error', text: `Could not read logs for ${target}.` })
    } finally {
      lock.current = false
      if (identityRef.current === requested) setBusy(false)
    }
  }

  return <section className="workspace-services" aria-label="Managed workspace services">
    <div className="workspace-services-heading">
      <div><h4>Workspace services</h4><span>Checkout {workspaceId} · generation {generation}</span></div>
      <button type="button" onClick={() => { void refresh() }} disabled={!pairingAvailable || busy}>Refresh</button>
    </div>
    <p>A registered service runs a bounded argv array in this checkout as the backend owner. It is not isolated. Starting executes the registered command; a chat URL or parsed log port never authorizes access.</p>
    {!pairingAvailable && <p role="status">Local same-user pairing is unavailable, so services are disabled.</p>}
    <ul className="workspace-services-list">
      {services.length === 0 && <li>No services registered.</li>}
      {services.map((service) => <li key={service.name}>
        <span className={`service-state service-${service.state}`}>{service.state}</span>
        <code>{service.name}</code>
        <span className="service-argv">{service.argv.join(' ')}</span>
        {service.state !== 'running' && <button type="button" onClick={() => { void startService(service.name) }} disabled={busy || !pairingAvailable}>Start</button>}
        {service.state === 'running' && <button type="button" onClick={() => setPending({ action: 'stop', name: service.name })} disabled={busy}>Stop…</button>}
        <button type="button" onClick={() => { void viewLogs(service.name) }} disabled={busy}>Logs</button>
        <button type="button" onClick={() => setPending({ action: 'remove', name: service.name })} disabled={busy}>Remove…</button>
        {pending?.name === service.name && <span className="workspace-services-confirm">{pending.action === 'stop' ? 'Stop' : 'Remove'} {service.name}?
          <button type="button" onClick={() => { void confirmPending() }} disabled={busy}>Confirm</button>
          <button type="button" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
        </span>}
      </li>)}
    </ul>
    <fieldset className="workspace-services-define" disabled={!pairingAvailable || busy}>
      <legend>Register a service</legend>
      <label><span>Name</span><input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="web" /></label>
      <label><span>Executable</span><input value={executable} onChange={(e) => setExecutable(e.currentTarget.value)} placeholder="/usr/bin/python3" /></label>
      <label><span>Arguments (one per line)</span><textarea value={argsText} onChange={(e) => setArgsText(e.currentTarget.value)} rows={2} /></label>
      <label><span>Working directory</span><input value={cwd} onChange={(e) => setCwd(e.currentTarget.value)} placeholder="." /></label>
      <label><span>Port name</span><input value={portName} onChange={(e) => setPortName(e.currentTarget.value)} placeholder="http" /></label>
      <label><span>Port</span><input value={portValue} onChange={(e) => setPortValue(e.currentTarget.value)} inputMode="numeric" placeholder="4173" /></label>
      <button type="button" onClick={() => { void define() }} disabled={!pairingAvailable || busy}>Register</button>
    </fieldset>
    {logs.name && <div className="workspace-services-logs" aria-label="Service logs">
      <div>{logs.name}{logs.truncated ? ' · showing the bounded tail' : ''}</div>
      <pre>{logs.text || 'No output captured.'}</pre>
    </div>}
    {message && <p className={`workspace-services-message service-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
  </section>
}
