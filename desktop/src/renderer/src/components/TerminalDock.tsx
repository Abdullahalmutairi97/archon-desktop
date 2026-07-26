import { Plus, Trash } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { ArchonApi } from '../lib/api'
import type { TerminalSession } from '../lib/types'
import { ErrorNotice } from '../components'
import { TerminalViewport } from './TerminalViewport'

export function TerminalDock({ api }: { api: ArchonApi; connection?: { url: string; token: string } }) {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const refresh = async () => { try { const result = await api.terminals(); setSessions(result); if (!selected || !result.some((item) => item.name === selected)) setSelected(result[0]?.name || '') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } }
  useEffect(() => { void refresh() }, [api])
  const create = async () => { setError(''); try { const names = sessions.map((item) => item.name); const base = ['deploy','logs','scratch'].find((name) => !names.includes(name)) || `shell-${sessions.length + 1}`; const result = await api.createTerminal(base); await refresh(); setSelected(result.name) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } }
  const close = async () => { if (!selected) return; try { await api.killTerminal(selected,true); setSelected(''); await refresh() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } }
  return <div className="terminal-dock"><div className="terminal-tabbar">{sessions.map((item) => <button className={selected === item.name ? 'active' : ''} key={item.name} onClick={() => setSelected(item.name)}>{item.label || item.name}</button>)}<button className="terminal-plus" aria-label="New terminal tab" onClick={() => void create()}><Plus/></button><span/><button className="terminal-trash" aria-label="Close terminal" disabled={!selected} onClick={() => void close()}><Trash/></button></div><ErrorNotice error={error}/><div className="terminal-dock-canvas" role="region" aria-label="Interactive terminal">{selected ? <TerminalViewport api={api} name={selected} compact/> : <button className="terminal-empty" aria-label="Create shell" onClick={() => void create()}><Plus/>Create shell</button>}</div></div>
}
