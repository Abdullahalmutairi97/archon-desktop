import { useCallback, useEffect, useRef, useState } from 'react'
import type { LanguageProfileDto, LanguageProfilesBridge, LanguageProfilesDto } from '../../shared/bridge/types'

const EMPTY: LanguageProfilesDto = {
  extensionsDirectory: '', profiles: [], unpinnedInstalled: [], pinsVerified: false, note: '',
  debug: {
    adapters: [], unsupported: [], codeServer: null,
    sessionExercised: false, breakpointVerified: false, note: '',
  },
}

function stateLabel(state: string): string {
  switch (state) {
    case 'installed': return 'installed'
    case 'modified': return 'changed since verification'
    case 'unverified': return 'unverified'
    default: return 'missing'
  }
}

/**
 * Read-only language profile report for one checkout.
 *
 * Every row is an artefact statement: an extension is "installed" only when its
 * files still hash to the recorded digest, and a capability this host cannot
 * provide is listed as unsupported with its reason. Installing an extension is
 * not proof that a language feature works, and the panel says so.
 */
export function LanguageProfiles({
  bridge,
  workspaceId,
  generation,
  pairingAvailable,
}: {
  bridge: LanguageProfilesBridge
  workspaceId: string
  generation: number
  pairingAvailable: boolean
}) {
  const [report, setReport] = useState<LanguageProfilesDto>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const identity = `${workspaceId}:${generation}`
  const identityRef = useRef(identity)
  const lock = useRef(false)
  identityRef.current = identity

  const refresh = useCallback(async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    const requested = identityRef.current
    try {
      const next = await bridge.list({ workspaceId })
      if (identityRef.current !== requested) return
      setReport(next)
      setError(null)
    } catch {
      if (identityRef.current === requested) setError('The language profile report is unavailable for this checkout.')
    } finally {
      lock.current = false
      if (identityRef.current === requested) setBusy(false)
    }
  }, [bridge, workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  const profileRows = (profile: LanguageProfileDto) => [...profile.extensions, ...profile.debuggers]

  return <section className="workspace-services" aria-label="Pinned language profiles">
    <div className="workspace-services-heading">
      <div><h4>Language profiles</h4><span>Pinned extensions for {workspaceId} · generation {generation}</span></div>
      <button type="button" onClick={() => { void refresh() }} disabled={!pairingAvailable || busy}>Refresh</button>
    </div>
    <p>A profile lists the pinned extensions that provide a language in this checkout, each verified by digest and licence, and the features this host cannot provide. This is an artefact record, not a behavioural qualification.</p>
    {report.extensionsDirectory && <p className="workspace-services-controls">Extensions directory: <code>{report.extensionsDirectory}</code></p>}
    {!pairingAvailable && <p role="status">Local same-user pairing is unavailable, so this report is disabled.</p>}
    {error && <p className="workspace-services-message service-error" role="alert">{error}</p>}
    {report.profiles.map((profile) => <div key={profile.profile}>
      <h5>{profile.label} <span className="fixture-tag">{profile.languageIds.join(', ')}</span></h5>
      <ul className="workspace-services-list">
        {profileRows(profile).length === 0 && <li>No pinned extension for this language.</li>}
        {profileRows(profile).map((extension) => <li key={`${profile.profile}:${extension.extensionId}`}>
          <span className={`service-state service-${extension.state === 'installed' ? 'running' : 'failed'}`}>{stateLabel(extension.state)}</span>
          <code>{extension.extensionId}@{extension.version}</code>
          <span className="service-argv">{[extension.declaredLicence, extension.marketplace].join(' · ')}</span>
          {extension.reason && <span className="workspace-services-controls">{extension.reason}</span>}
        </li>)}
      </ul>
      {profile.unsupported.length > 0 && <ul className="workspace-services-list">
        {profile.unsupported.map((feature) => <li key={feature.feature}>
          <span className="service-state service-failed">unsupported</span>
          <code>{feature.feature}</code>
          <span className="workspace-services-controls">{feature.reason}</span>
        </li>)}
      </ul>}
    </div>)}
    {report.unpinnedInstalled.length > 0 && <div>
      <h5>Installed without a verified pin</h5>
      <ul className="workspace-services-list">
        {report.unpinnedInstalled.map((row) => <li key={row.extensionId}>
          <span className="service-state service-failed">unpinned</span>
          <code>{row.extensionId}{row.installedVersion ? `@${row.installedVersion}` : ''}</code>
          <span className="workspace-services-controls">{row.installedLicenceField ?? 'no licence field'}</span>
        </li>)}
      </ul>
    </div>}
    {report.note && <p className="workspace-services-controls">{report.note}</p>}
    <div>
      <h5>Debug readiness</h5>
      <ul className="workspace-services-list">
        <li>
          <span className="service-state service-failed">not verified</span>
          <code>debug session</code>
          <span className="workspace-services-controls">
            no session exercised, no breakpoint verified; this server cannot start or observe one
          </span>
        </li>
        {report.debug.adapters.map((adapter) => <li key={`${adapter.profile}:${adapter.extensionId ?? 'none'}`}>
          <span className={`service-state service-${adapter.state === 'installed' ? 'running' : 'failed'}`}>
            {adapter.state ?? 'unknown'}
          </span>
          <code>{adapter.extensionId ?? 'no adapter'} {adapter.version ? `@${adapter.version}` : ''}</code>
          <span className="workspace-services-controls">
            {adapter.reason ?? `debug adapter for ${adapter.profile} (the extension's own capability)`}
          </span>
        </li>)}
        {report.debug.unsupported.map((row) => <li key={`${row.profile ?? 'host'}:${row.feature}`}>
          <span className="service-state service-failed">unsupported</span>
          <code>{row.feature}</code>
          <span className="workspace-services-controls">{row.reason}</span>
        </li>)}
      </ul>
      {report.debug.codeServer && <ul className="workspace-services-list">
        <li>
          <span className="service-state service-running">{report.debug.codeServer.state ?? 'registered'}</span>
          <code>code-server {report.debug.codeServer.bindAddress ?? 'address unknown'}</code>
          <span className="workspace-services-controls">
            auth {report.debug.codeServer.authMode} · {report.debug.codeServer.accountNote}
          </span>
        </li>
      </ul>}
      {report.debug.note && <p className="workspace-services-controls">{report.debug.note}</p>}
    </div>
  </section>
}
