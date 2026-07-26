import { CheckCircle, CircleNotch, LockKey, PlugsConnected } from '@phosphor-icons/react'
import { useState } from 'react'
import type { ConnectionConfig } from '../lib/types'
import { BrandGlyph } from './BrandGlyph'

export function ConnectionSetup({ initial, onSave }: { initial?: ConnectionConfig; onSave(value: ConnectionConfig): Promise<void> }) {
  const [serverUrl,setServerUrl] = useState(initial?.serverUrl || 'http://100.80.70.23:8719')
  const [token,setToken] = useState(initial?.token || '')
  const [error,setError] = useState('')
  const [saving,setSaving] = useState(false)
  const save = async () => { setSaving(true); setError(''); try { await onSave({serverUrl:serverUrl.trim().replace(/\/$/,''),token:token.trim()}) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setSaving(false) } }
  return <div className="connection-setup"><section><BrandGlyph/><h1>Connect to Archon</h1><p>The desktop renderer only talks to your authenticated FastAPI service over Tailscale.</p><label><span>Server URL</span><div><PlugsConnected/><input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)}/></div></label><label><span>Device token</span><div><LockKey/><input type="password" value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void save()}/></div></label>{error && <div className="notice error">{error}</div>}<button disabled={!serverUrl.trim() || !token.trim() || saving} onClick={() => void save()}>{saving ? <CircleNotch className="spin"/> : <CheckCircle/>}Connect securely</button><small>Credentials stay in Electron safeStorage when available.</small></section></div>
}
