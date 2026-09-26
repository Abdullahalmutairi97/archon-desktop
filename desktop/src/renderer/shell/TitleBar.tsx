import { Icon } from './Icon'

export function TitleBar({
  sidebarCollapsed,
  onToggleSidebar,
  onSearch,
  onAppearance,
}: {
  sidebarCollapsed: boolean
  onToggleSidebar(): void
  onSearch(): void
  onAppearance(): void
}) {
  return <header className="titlebar">
    <div className="titlebar-leading">
      <button className="icon-button titlebar-icon" aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} onClick={onToggleSidebar}>
        <Icon name="menu" />
      </button>
      <div className="titlebar-brand"><span className="brand-word">Archon</span><span className="brand-divider">/</span><span>Desktop</span></div>
      <span className="reconstruction-chip"><i />Reconstruction preview</span>
    </div>
    <div className="titlebar-actions">
      <button className="search-trigger" onClick={onSearch} aria-label="Open command palette">
        <Icon name="search" /><span>Quick search</span><kbd>Ctrl K</kbd>
      </button>
      <button className="icon-button titlebar-icon appearance-trigger" aria-label="Open appearance settings" onClick={onAppearance}><Icon name="settings" /></button>
      <div className="window-controls" aria-hidden="true"><i /><i /><i /></div>
    </div>
  </header>
}
