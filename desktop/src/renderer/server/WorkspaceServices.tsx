import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspacePreviewBridge, WorkspaceServiceDefinitionInput, WorkspaceServiceDto, WorkspaceServicesBridge } from '../../shared/bridge/types'
import './WorkspaceServices.css'
import { useOverlayOpen } from '../shell/overlays'

const EMPTY_LOGS = { name: '', text: '', truncated: false }

export function WorkspaceServices({
  bridge,
  preview,
  workspaceId,
  generation,
  pairingAvailable,
}: {
  bridge: WorkspaceServicesBridge
  preview: WorkspacePreviewBridge
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
  const [previewName, setPreviewName] = useState<string | null>(null)
  const [memoryLimit, setMemoryLimit] = useState('')
  const [cpuQuota, setCpuQuota] = useState('')
  const [tasksMax, setTasksMax] = useState('')
  const [filesystemIsolation, setFilesystemIsolation] = useState<'none' | 'workspace-only'>('none')
  const [networkIsolation, setNetworkIsolation] = useState<'host' | 'isolated'>('host')
  const previewBox = useRef<HTMLDivElement | null>(null)
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
    setPreviewName(null)
    void preview.close()
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // The native preview is drawn over the window; it must not outlive this panel.
  useEffect(() => () => { void Promise.resolve().then(() => preview.close()).catch(() => undefined) }, [preview])

  const covered = useOverlayOpen()
  useEffect(() => {
    if (!previewName) return
    const box = previewBox.current
    if (!box) return
    const send = (): void => {
      const rect = box.getBoundingClientRect()
      // A dialog or palette is open: move the native preview out of its way.
      void preview.bounds(covered ? { x: -2, y: -2, width: 1, height: 1 } : {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
      })
    }
    const observer = new ResizeObserver(send)
    observer.observe(box)
    window.addEventListener('resize', send)
    send()
    return () => { observer.disconnect(); window.removeEventListener('resize', send) }
  }, [preview, previewName, covered])

  function optionalNumber(text: string, minimum: number, maximum: number): number | null | undefined {
    const trimmed = text.trim()
    if (!trimmed) return null
    const value = Number(trimmed)
    if (!Number.isInteger(value) || value < minimum || value > maximum) return undefined
    return value
  }

  function buildDefinition(): WorkspaceServiceDefinitionInput | null {
    const argv = [executable.trim(), ...argsText.split('\n').map((line) => line.trim()).filter(Boolean)]
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(name) || argv.length === 0 || !argv[0]) return null
    let ports: WorkspaceServiceDefinitionInput['ports'] = []
    if (portName || portValue) {
      const value = Number(portValue)
      if (!/^[a-z][a-z0-9-]{0,15}$/u.test(portName) || !Number.isInteger(value) || value < 1 || value > 65535) return null
      ports = [{ name: portName, port: value }]
    }
    const memoryLimitMb = optionalNumber(memoryLimit, 16, 65536)
    const cpuQuotaPercent = optionalNumber(cpuQuota, 1, 1600)
    const tasksMaxValue = optionalNumber(tasksMax, 4, 4096)
    if (memoryLimitMb === undefined || cpuQuotaPercent === undefined || tasksMaxValue === undefined) return null
    if (networkIsolation === 'isolated' && ports.length > 0) return null
    return {
      name, argv, cwd: cwd.trim() || '.', env: [], ports,
      health: null, dependsOn: [], restart: 'never', memoryLimitMb,
      cpuQuotaPercent, tasksMax: tasksMaxValue, filesystemIsolation, networkIsolation,
    }
  }

  function controlSummary(service: WorkspaceServiceDto): string {
    const parts: string[] = []
    if (service.memoryLimitMb !== null) parts.push(`memory ${service.memoryLimitMb} MB`)
    if (service.cpuQuotaPercent !== null) parts.push(`cpu ${service.cpuQuotaPercent}%`)
    if (service.tasksMax !== null) parts.push(`tasks ${service.tasksMax}`)
    if (service.filesystemIsolation === 'workspace-only') parts.push('filesystem: workspace only')
    if (service.networkIsolation === 'isolated') parts.push('network: none')
    // Nothing declared means the process runs with the owner's full filesystem and network.
    return parts.length > 0 ? parts.join(' · ') : 'no declared controls (full host access)'
  }

  async function define(): Promise<void> {
    if (lock.current || !pairingAvailable) return
    const definition = buildDefinition()
    if (definition === null) {
      setMessage({ kind: 'error', text: 'Check the service name, executable and port, and use whole numbers inside the allowed ranges. An isolated service cannot declare a port.' })
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

  async function openPreview(target: string): Promise<void> {
    if (lock.current || !pairingAvailable) return
    const requested = identity
    lock.current = true
    setBusy(true)
    setMessage(null)
    setPreviewName(target)
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    const box = previewBox.current
    if (!box) {
      setPreviewName(null)
      lock.current = false
      setBusy(false)
      return
    }
    const rect = box.getBoundingClientRect()
    try {
      await preview.open({
        workspaceId, name: target, expectedGeneration: generation, portName: null,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) },
      })
      if (identityRef.current !== requested) return
      setMessage({ kind: 'status', text: `Preview opened for ${target}.` })
    } catch {
      if (identityRef.current === requested) {
        setPreviewName(null)
        setMessage({ kind: 'error', text: `Could not open a preview for ${target}. The service must be running and declare a port.` })
      }
    } finally {
      lock.current = false
      if (identityRef.current === requested) setBusy(false)
    }
  }

  async function closePreview(): Promise<void> {
    try {
      await preview.close()
    } catch {
      // Closing an already-closed preview is not an error.
    }
    setPreviewName(null)
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
    <p>A registered service runs a bounded argv array in this checkout as the backend owner. Declared controls are applied through one user scope and each is refused unless the backend probe observed real enforcement on this host: memory, CPU quota, task limit, workspace-only filesystem confinement and no network. A service without declared controls keeps full host access. Starting executes the registered command; a chat URL or parsed log port never authorizes access.</p>
    {!pairingAvailable && <p role="status">Local same-user pairing is unavailable, so services are disabled.</p>}
    <ul className="workspace-services-list">
      {services.length === 0 && <li>No services registered.</li>}
      {services.map((service) => <li key={service.name}>
        <span className={`service-state service-${service.state}`}>{service.state}</span>
        <span className={`service-health service-health-${service.health}`}>health: {service.health}</span>
        <code>{service.name}</code>
        <span className="service-argv">{service.argv.join(' ')}</span>
        <span className="service-controls" aria-label={`Applied controls for ${service.name}`}>{controlSummary(service)}</span>
        {service.state !== 'running' && <button type="button" onClick={() => { void startService(service.name) }} disabled={busy || !pairingAvailable}>Start</button>}
        {service.state === 'running' && <button type="button" onClick={() => setPending({ action: 'stop', name: service.name })} disabled={busy}>Stop…</button>}
        <button type="button" onClick={() => { void viewLogs(service.name) }} disabled={busy}>Logs</button>
        {service.ports.length > 0 && <button type="button" onClick={() => { void openPreview(service.name) }} disabled={busy || !pairingAvailable}>Preview</button>}
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
      <label><span>Memory limit MB (blank for none)</span><input value={memoryLimit} onChange={(e) => setMemoryLimit(e.currentTarget.value)} inputMode="numeric" placeholder="256" /></label>
      <label><span>CPU quota % (blank for none)</span><input value={cpuQuota} onChange={(e) => setCpuQuota(e.currentTarget.value)} inputMode="numeric" placeholder="50" /></label>
      <label><span>Task limit (blank for none)</span><input value={tasksMax} onChange={(e) => setTasksMax(e.currentTarget.value)} inputMode="numeric" placeholder="64" /></label>
      <label><span>Filesystem</span><select value={filesystemIsolation} onChange={(e) => setFilesystemIsolation(e.currentTarget.value as 'none' | 'workspace-only')}>
        <option value="none">none (host access)</option>
        <option value="workspace-only">workspace only (read-only host)</option>
      </select></label>
      <label><span>Network</span><select value={networkIsolation} onChange={(e) => setNetworkIsolation(e.currentTarget.value as 'host' | 'isolated')}>
        <option value="host">host</option>
        <option value="isolated">isolated (no network, no port)</option>
      </select></label>
      <button type="button" onClick={() => { void define() }} disabled={!pairingAvailable || busy}>Register</button>
    </fieldset>
    {previewName && <div className="workspace-preview" aria-label="Service preview">
      <div className="workspace-preview-heading"><span>Preview · {previewName}</span>
        <button type="button" onClick={() => { void closePreview() }}>Close preview</button>
      </div>
      <div ref={previewBox} className="workspace-preview-surface" aria-label="Sandboxed preview surface" />
    </div>}
    {logs.name && <div className="workspace-services-logs" aria-label="Service logs">
      <div>{logs.name}{logs.truncated ? ' · showing the bounded tail' : ''}</div>
      <pre>{logs.text || 'No output captured.'}</pre>
    </div>}
    {message && <p className={`workspace-services-message service-${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>}
  </section>
}
