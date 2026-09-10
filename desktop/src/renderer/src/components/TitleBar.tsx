import { ArrowClockwise, Browser, Code, Files, Minus, Pulse, SidebarSimple, Square, TerminalWindow, X } from '@phosphor-icons/react'
import type { BenchDestination } from '../lib/workspace'
import { BrandGlyph } from './BrandGlyph'

const tabs: Array<{ id: BenchDestination; label: string; icon: typeof Pulse }> = [
  { id: 'tasks', label: 'Activity', icon: Pulse },
  { id: 'files', label: 'Files', icon: Files },
  { id: 'terminal', label: 'Terminal', icon: TerminalWindow },
  { id: 'browser', label: 'Browser', icon: Browser },
  { id: 'ide', label: 'IDE', icon: Code },
]

export function TitleBar({ title, crumb, bench, unseen = {}, onBench, onSidebar, onRefresh, refreshing = false }: {
  title: string
  crumb: string
  bench?: BenchDestination
  unseen?: Partial<Record<BenchDestination, boolean>>
  onBench(value: BenchDestination): void
  onSidebar(): void
  onRefresh(): void
  refreshing?: boolean
}) {
  return <header className="titlebar" title={title}>
    <button className="titlebar-sidebar" aria-label="Toggle sidebar" title="Toggle sidebar (⌘\\)" onClick={onSidebar}><SidebarSimple/></button>
    <BrandGlyph className="titlebar-mark"/>
    <span className="titlebar-crumb">{crumb}</span>
    <div className="titlebar-drag"/>
    <nav className="titlebar-tools" aria-label="Bench">
      {tabs.map((item, index) => {
        const Icon = item.icon
        return <button aria-label={item.label} className={bench === item.id ? 'active' : ''} key={item.id} title={`${item.label} (⌘${index + 1})`} onClick={() => onBench(item.id)}><Icon/>{unseen[item.id] && <i/>}</button>
      })}
    </nav>
    <button aria-label="Refresh workspace" className={`titlebar-refresh${refreshing ? ' spinning' : ''}`} title="Refresh workspace" onClick={onRefresh} disabled={refreshing}><ArrowClockwise/><span>Refresh</span></button>
    <span className="titlebar-divider"/>
    <div className="window-controls">
      <button aria-label="Minimize" onClick={() => void window.archon?.minimize()}><Minus/></button>
      <button aria-label="Maximize" onClick={() => void window.archon?.maximize()}><Square/></button>
      <button aria-label="Close" onClick={() => void window.archon?.close()}><X/></button>
    </div>
  </header>
}
