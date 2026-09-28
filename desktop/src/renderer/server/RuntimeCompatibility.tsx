import { useCallback, useEffect, useRef, useState } from 'react'
import {
  describeRuntimeCompatibility,
  type ProviderAuthState,
  type RuntimeCompatibilityRow,
  type RuntimeManifestRecord,
} from '../../shared/domain/runtimeCompatibility'
import type { DesktopBridge } from '../../shared/bridge/types'
import './RuntimeCompatibility.css'

/**
 * Runtime choices for this connection, derived from the server manifest and the
 * provider authentication state instead of a hardcoded list.
 *
 * Nothing here is a capability claim. A runtime is "unverified" unless the
 * executable, its declared version and one brokered provider call were all
 * observed, and every capability the server does not claim is shown as
 * unsupported rather than hidden.
 */
export function RuntimeCompatibility({ bridge, generation }: { bridge: DesktopBridge; generation: number }) {
  const [rows, setRows] = useState<readonly RuntimeCompatibilityRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const serial = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++serial.current
    try {
      const [runtimes, auth] = await Promise.all([
        bridge.api.invoke('runtimes.list', {}),
        bridge.api.invoke('secrets.authStates', {}),
      ])
      if (serial.current !== requestId) return
      const providers = (auth.providers ?? []) as readonly ProviderAuthState[]
      setRows(describeRuntimeCompatibility(runtimes.runtimes as readonly RuntimeManifestRecord[], providers))
      setError(null)
    } catch {
      if (serial.current !== requestId) return
      setRows([])
      setError('The runtime manifest or the authentication state is unavailable on this connection.')
    } finally {
      if (serial.current === requestId) setLoaded(true)
    }
  }, [bridge])

  useEffect(() => {
    serial.current += 1
    setRows([])
    setLoaded(false)
    setError(null)
    void load()
    return () => {
      serial.current += 1
    }
  }, [bridge, generation, load])

  return (
    <section className="runtime-compatibility" aria-label="Runtime compatibility">
      <div className="runtime-compatibility-heading">
        <h4>Runtime compatibility</h4>
        <button type="button" onClick={() => { void load() }}>Refresh</button>
      </div>
      {error !== null && <p className="runtime-compatibility-error">{error}</p>}
      {error === null && loaded && rows.length === 0 && <p>No runtime is registered on this server.</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.id} className={`runtime-row runtime-${row.state}`}>
            <div className="runtime-row-heading">
              <span className={`runtime-state runtime-state-${row.state}`}>{row.state}</span>
              <code>{row.heading}</code>
            </div>
            <p className="runtime-reason">{row.reason}</p>
            <dl className="runtime-facts">
              {row.facts.map((fact) => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
            </dl>
            <dl className="runtime-capabilities">
              {row.capabilities.map((capability) => (
                <div key={capability.key}>
                  <dt>{capability.label}</dt>
                  <dd className={capability.value === 'unsupported' || capability.value === 'not declared' ? 'capability-absent' : ''}>{capability.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      {rows.length > 0 && <p className="runtime-note">A verified state means one brokered provider call succeeded from this host. It is not a claim about provider quotas, model access or native conformance.</p>}
    </section>
  )
}
