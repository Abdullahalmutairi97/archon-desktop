import { ArrowsClockwise, CheckCircle, DownloadSimple, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { formatBytes } from '../components'

type ReleaseInfo = { currentVersion: string; version: string; size: number; sha256: string; updateAvailable: boolean; changes: string[] }

export function UpdateDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [info, setInfo] = useState<ReleaseInfo>()
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  useEffect(() => {
    if (!open) return
    setInfo(undefined)
    setError('')
    void window.archon?.getReleaseInfo().then(setInfo).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose, open])
  if (!open) return null
  const install = async () => {
    setInstalling(true)
    setError('')
    try { await window.archon?.updateAndRestart() }
    catch (reason) { setInstalling(false); setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  return <div className="update-backdrop" role="presentation" onMouseDown={(event) => !installing && event.target === event.currentTarget && onClose()}>
    <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <header><span><DownloadSimple/><b id="update-title">Archon Desktop update</b></span><button aria-label="Close update" disabled={installing} onClick={onClose}><X/></button></header>
      <div className="update-version"><CheckCircle/><span><small>Installed package</small><b>Version {info?.currentVersion || '…'}</b></span><code>{info ? `Latest ${info.version}` : 'Checking…'}</code></div>
      {info && <div className={`update-status ${info.updateAvailable ? 'available' : 'current'}`}><b>{info.updateAvailable ? `Version ${info.version} is ready` : 'Archon Desktop is up to date'}</b><span>{formatBytes(info.size)} · SHA-256 verified before replacement</span></div>}
      <ul>{(info?.changes || []).map((change) => <li key={change}>{change}</li>)}</ul>
      <p>Tasks and sessions live on the server. Installing this package and restarting the window never stops work already running.</p>
      {error && <div className="notice error">{error}</div>}
      <footer><button disabled={installing} onClick={onClose}>Cancel</button><button className="primary" disabled={!info?.updateAvailable || installing} onClick={() => void install()}><ArrowsClockwise className={installing ? 'spin' : ''}/>{installing ? 'Downloading and verifying…' : 'Update and restart'}</button></footer>
    </section>
  </div>
}
