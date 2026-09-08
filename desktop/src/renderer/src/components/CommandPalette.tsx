import { ChatTeardropText, Folder, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { PrimeSession, Project } from '../lib/types'
import type { PageId } from '../navigation'
import type { BenchDestination } from '../lib/workspace'

export function CommandPalette({ open, seed, onClose, onPage, onBench, onNewSession, projects, sessions, onOpenSession }: { open: boolean; seed: string; onClose(): void; onPage(value: PageId): void; onBench(value: BenchDestination): void; onNewSession(): void; onSearchSessions(query: string): void; projects: Project[]; sessions: PrimeSession[]; onOpenSession(projectId: string | undefined, sessionId: string): void }) {
  const [query, setQuery] = useState(seed)
  useEffect(() => { if (open) setQuery(seed) }, [open, seed])
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, onClose])
  const found = useMemo(() => sessions.filter((session) => !query.trim() || `${session.title} ${session.preview}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8), [query, sessions])
  if (!open) return null
  const act = (fn: () => void) => { fn(); onClose() }
  return <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="command-palette" role="dialog" aria-modal="true"><header><MagnifyingGlass/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions or run a command"/><button onClick={onClose}><X/></button></header><div className="palette-results"><small>Commands</small><button onClick={() => act(onNewSession)}><Plus/>New session<kbd>⌃N</kbd></button><button onClick={() => act(() => onPage('projects'))}><Folder/>Projects</button><button onClick={() => act(() => onPage('settings'))}>Settings</button><button onClick={() => act(() => onBench('terminal'))}>Open terminal panel</button><small>Sessions</small>{found.map((session) => <button key={session.id} onClick={() => act(() => onOpenSession(session.project_id,session.id))}><ChatTeardropText/><span>{session.title}</span><em>{projects.find((project) => project.id === session.project_id)?.name || 'Chat'}</em></button>)}</div><footer><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span></footer></section></div>
}
