import {
  ArrowsClockwise, CheckCircle, Cpu, DownloadSimple, GearSix, Globe, Info, Palette,
  PlugsConnected, SealCheck, Shapes, SlidersHorizontal, X,
} from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { AppearanceStudio } from '../components/AppearanceStudio'
import { BrandGlyph } from '../components/BrandGlyph'
import { MarkGlyph } from '../lib/marks'
import { ArchonApi } from '../lib/api'
import type { ConnectionConfig, ModelCatalog } from '../lib/types'
import { ErrorNotice } from '../components'
import { readComposerVisibility, writeComposerVisibility } from '../lib/composerPreferences'

const tabs = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'connection', label: 'Connection', icon: PlugsConnected },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'language', label: 'Language', icon: Globe },
  { id: 'brand', label: 'Brand', icon: Shapes },
  { id: 'about', label: 'About', icon: Info },
] as const
type SettingsTab = (typeof tabs)[number]['id']

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange(): void }) {
  return <button type="button" className={`reference-switch ${checked ? 'on' : ''}`} role="switch" aria-label={label} aria-checked={checked} onClick={onChange}><i/></button>
}

export function SettingsPage({ api, connection, onConnection, onClose, onUpdate }: { api: ArchonApi; connection: ConnectionConfig; onConnection(value: ConnectionConfig): Promise<void>; onClose(): void; onUpdate(): void }) {
  const [tab, setTab] = useState<SettingsTab>('general')
  const [server, setServer] = useState<Record<string, string>>({})
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [url, setUrl] = useState(connection.serverUrl)
  const [token, setToken] = useState(connection.token)
  const [connectionMessage, setConnectionMessage] = useState('')
  const [error, setError] = useState('')
  const initialComposer = readComposerVisibility()
  const [showApproval, setShowApproval] = useState(initialComposer.approval)
  const [showVoice, setShowVoice] = useState(initialComposer.voice)
  const [language, setLanguage] = useState<'en' | 'ar'>(() => document.documentElement.dir === 'rtl' ? 'ar' : 'en')
  useEffect(() => { void api.server().then(setServer).catch(() => {}); void api.models().then(setCatalog).catch(() => {}) }, [api])
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close)
  }, [onClose])
  const title = tabs.find((item) => item.id === tab)?.label || 'General'
  const test = async () => { setError(''); setConnectionMessage(''); try { await new ArchonApi({ serverUrl: url, token }).server(); setConnectionMessage('Reachable · bearer token accepted') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } }
  const manifest = async () => { const data = await api.migrationManifest(); const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = href; anchor.download = 'archon-migration-manifest.json'; anchor.click(); URL.revokeObjectURL(href) }
  const setLang = (next: 'en' | 'ar') => { setLanguage(next); document.documentElement.lang = next; document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr'; localStorage.setItem('archon.language', next); void window.archon?.setSettings({ language: next }) }

  return <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
    <section className="settings-modal">
      <header><GearSix/><b>Settings</b><span>/</span><em>{title}</em><button aria-label="Close settings" onClick={onClose}><X/></button></header>
      <div className="settings-modal-body">
        <aside>{tabs.map((item) => { const Icon = item.icon; return <button className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => setTab(item.id)}><Icon/><span>{item.label}</span></button> })}<small>Archon Desktop 0.6.1 · AppImage · x64</small></aside>
        <main>
          {tab === 'general' && <div className="settings-general reference-settings-pane">
            <div className="settings-facts"><div><small>Profile</small><code>{server.profile || 'archon'}</code></div><div><small>Archon root</small><code>{server.archon_root || '~/archon'}</code></div><div><small>Hermes home</small><code>{server.hermes_home || '~/.hermes'}</code></div></div>
            <label className="reference-field">Default working directory for new sessions<input defaultValue="~/archon/projects/archon-desktop"/></label>
            <section className="settings-group"><h2>Composer controls</h2><article><div><b>Approval mode button</b><small>Auto · Approve steps · Plan mode, switched from the composer</small></div><Toggle checked={showApproval} label="Approval mode button" onChange={() => { const next = !showApproval; setShowApproval(next); writeComposerVisibility({ approval:next, voice:showVoice }) }}/></article><article><div><b>Voice conversation</b><small>Talk to Archon out loud from the window bar — both voice buttons use this switch</small></div><Toggle checked={showVoice} label="Voice conversation" onChange={() => { const next = !showVoice; setShowVoice(next); writeComposerVisibility({ approval:showApproval, voice:next }) }}/></article></section>
            <section className="settings-group"><h2>Keyboard</h2><div className="shortcut-grid">{[['New session','⌃N'],['Command palette','⌘K'],['Settings','⌘,'],['Model picker','⌃⇧M'],['Toggle sidebar','⌘\\'],['Activity panel','⌘1'],['Files panel','⌘2'],['Terminal panel','⌘3']].map(([label, keys]) => <div key={label}><span>{label}</span><code>{keys}</code></div>)}</div></section>
            <section className="settings-group"><h2>Migration</h2><article className="migration-card"><DownloadSimple/><div><b>Export the MiniPC manifest</b><small>Inventories profile, session database, skills, memories, cron data and vault — an itinerary for the move, never the secrets themselves.</small></div><button onClick={() => void manifest()}>Export</button></article></section>
          </div>}

          {tab === 'connection' && <div className="reference-settings-pane connection-pane"><label className="reference-field">Archon server URL<input value={url} onChange={(event) => setUrl(event.target.value)}/></label><label className="reference-field">Device token<div className="connection-inline"><input type="password" value={token} onChange={(event) => setToken(event.target.value)}/><button onClick={() => void test()}>Test</button><button className="primary" onClick={() => void onConnection({ serverUrl: url, token })}>Save</button></div></label><ErrorNotice error={error}/>{connectionMessage && <div className="connection-ok"><CheckCircle/>{connectionMessage}</div>}<section className="settings-group"><h2>Posture</h2>{['Tailscale endpoint only; no public listener.', 'Bearer token is stored with Electron safeStorage when available.', 'Renderer has no filesystem or process access.', 'Microphone permission is audio-only.', 'Protected paths and secret values never enter logs.'].map((text) => <p className="security-line" key={text}><SealCheck/>{text}</p>)}</section></div>}

          {tab === 'models' && <div className="reference-settings-pane models-pane"><article className="model-default"><CheckCircle/><div><small>Profile default</small><b>{catalog?.current.model || 'Loading…'}</b></div><span>Per-chat choices override this without touching the profile</span></article>{catalog?.choices.slice(0, 40).map((choice) => <article className="settings-model-row" key={`${choice.provider}:${choice.model}`}><div><b>{choice.model}</b><code>{choice.provider}/{choice.model}</code></div><span>Profile</span><button onClick={() => void api.setModel(choice.provider, choice.model).then(() => api.models().then(setCatalog))}>Default</button></article>)}</div>}

          {tab === 'appearance' && <AppearanceStudio/>}

          {tab === 'language' && <div className="reference-settings-pane language-pane"><p>Switching to Arabic mirrors the whole interface — the sidebar moves to the right, icons flip, and paths stay left-to-right inside Arabic text.</p><div className="language-options"><button className={language === 'en' ? 'active' : ''} onClick={() => setLang('en')}><i/><span><b>English</b><small>Left to right</small></span></button><button className={language === 'ar' ? 'active' : ''} onClick={() => setLang('ar')}><i/><span><b>العربية</b><small>من اليمين إلى اليسار</small></span></button></div><section className="language-preview" dir="rtl"><p>زر الإلغاء يغيّر الحالة فقط، أما العملية على السيرفر فتظل تعمل. أصلحه ثم أصدر النسخة للمعماريتين.</p><div><BrandGlyph/><b>أركون</b><span>تجزئة · أربع مهام</span></div><p>الإشارة لا تصل إلى مجموعة العمليات. سأرسل الإشارة إلى المجموعة ثم أتحقق من النتيجة.</p></section></div>}

          {tab === 'brand' && <div className="reference-settings-pane brand-pane"><section className="brand-hero"><BrandGlyph/><div><h2>ARCHON</h2><p>operator console · hermes on the vps</p></div><span>One mark, set once in Appearance and carried everywhere — titlebar, sidebar, replies, tray and packaging.</span></section><div className="brand-options">{(['wing','stroke','stele','sigil'] as const).map((mark) => <article key={mark}><MarkGlyph mark={mark}/><b>{mark === 'stroke' ? 'One-stroke A' : mark[0].toUpperCase()+mark.slice(1)}</b></article>)}</div></div>}

          {tab === 'about' && <div className="reference-settings-pane about-pane"><div><BrandGlyph/><span><h2>Archon Desktop 0.6.1</h2><p>Electron renderer · FastAPI + SQLite backend · AppImage and .deb for x86_64</p></span></div><section className="settings-group"><h2>Build</h2><p>Exact frontend integration from the supplied Archon Desktop v2 archive.</p></section><div className="about-actions"><button className="primary" onClick={onUpdate}><ArrowsClockwise/>Check for updates</button><button onClick={onUpdate}>Release notes</button><button onClick={() => void navigator.clipboard.writeText(JSON.stringify({ version:'0.6.1', server:server.profile || 'archon', secureStorage:connection.secureStorage !== false }, null, 2))}>Copy diagnostics</button></div></div>}
        </main>
      </div>
    </section>
  </div>
}
