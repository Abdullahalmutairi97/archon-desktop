import { Plus, TerminalSquare, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, ConfirmDialog, Empty, ErrorNotice, Section, formatDate, usePolling } from '../components'
import { TerminalViewport } from '../components/TerminalViewport'
import type { ArchonApi } from '../lib/api'
import type { TerminalSession } from '../lib/types'

export function TerminalPage({ api }: { api: ArchonApi }) {
  const { data: sessions = [], error, refresh } = usePolling<TerminalSession[]>(() => api.terminals(), 5000, [api])
  const [selected, setSelected] = useState<TerminalSession>()
  const [label, setLabel] = useState('Shell')
  const [cwd, setCwd] = useState('.')
  const [killOpen, setKillOpen] = useState(false)

  useEffect(() => {
    if (!selected && sessions.length) setSelected(sessions[0])
    if (selected && !sessions.some((session) => session.name === selected.name)) setSelected(sessions[0])
  }, [selected, sessions])

  const create = async () => {
    const session = await api.createTerminal(label, cwd)
    await refresh()
    setSelected(session)
  }
  const kill = async () => {
    if (!selected) return
    await api.killTerminal(selected.name, true)
    setKillOpen(false)
    setSelected(undefined)
    await refresh()
  }

  return <Section title="Persistent terminal" description="tmux shells run on the Archon machine and survive closing the application." actions={<div className="inline-form"><input aria-label="Terminal label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Shell"/><input aria-label="Terminal working directory" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="."/><Button tone="primary" onClick={() => void create()}><Plus size={14}/> New shell</Button></div>}>
    <ErrorNotice error={error}/>
    <div className="terminal-layout"><aside>{sessions.map((session) => <button className={selected?.name === session.name ? 'active' : ''} key={session.name} onClick={() => setSelected(session)}><TerminalSquare size={16}/><span><strong>{session.label || session.name}</strong><small>{session.cwd || 'tmux'} · {session.created_at_epoch ? formatDate(session.created_at_epoch * 1000) : 'persistent'}</small></span></button>)}{!sessions.length && <Empty>No persistent terminal sessions.</Empty>}</aside><main>{selected ? <><header><span>{selected.label || selected.name}</span><code>{selected.cwd || '~'}</code><Button tone="danger" onClick={() => setKillOpen(true)}><Trash2 size={14}/> Kill</Button></header><TerminalViewport api={api} name={selected.name}/></> : <Empty>Select or create a terminal.</Empty>}</main></div>
    <ConfirmDialog open={killOpen} title="Kill persistent shell?" detail="This terminates the tmux session and every process in it." confirmLabel="Kill shell" danger onCancel={() => setKillOpen(false)} onConfirm={() => void kill()}/>
  </Section>
}
