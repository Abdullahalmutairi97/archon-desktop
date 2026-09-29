import type { ShellPreferences, ThemeId } from './themes'
import { THEMES } from './themes'
import { Icon } from '../shell/Icon'
import { useOverlay } from '../shell/overlays'

const FONT_SCALES: ShellPreferences['fontScale'][] = [0.9, 1, 1.1, 1.2]

export function AppearanceStudio({
  value,
  onChange,
  onClose,
}: {
  value: ShellPreferences
  onChange(value: ShellPreferences): void
  onClose(): void
}) {
  useOverlay()
  const patch = (change: Partial<ShellPreferences>) => onChange({ ...value, ...change })

  return <div className="modal-scrim" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
      <header className="dialog-titlebar">
        <div><span className="eyebrow">LOCAL PREVIEW SETTINGS</span><h2 id="appearance-title">Appearance</h2></div>
        <button className="icon-button" aria-label="Close appearance settings" onClick={onClose}><Icon name="close"/></button>
      </header>
      <div className="appearance-content">
        <section className="appearance-section">
          <div className="section-heading"><div><h3>Theme</h3><p>Seven recovered palette names and accent tones.</p></div><span className="setting-current">{THEMES.find((theme) => theme.id === value.theme)?.label}</span></div>
          <div className="theme-grid" role="group" aria-label="Choose theme">
            {THEMES.map((theme) => <button
              className={`theme-choice ${value.theme === theme.id ? 'selected' : ''}`}
              key={theme.id}
              aria-pressed={value.theme === theme.id}
              onClick={() => patch({ theme: theme.id as ThemeId })}
            >
              <span className="theme-swatches" aria-hidden="true">{theme.swatches.map((color) => <i key={color} style={{ background: color }}/>)}</span>
              <span>{theme.label}</span>
            </button>)}
          </div>
        </section>

        <section className="appearance-section setting-columns">
          <div>
            <div className="section-heading"><div><h3>Navigation position</h3><p>Choose which edge holds the workspace tree.</p></div></div>
            <div className="segmented-control" role="group" aria-label="Navigation position">
              {(['left', 'right'] as const).map((side) => <button key={side} aria-pressed={value.navigationSide === side} className={value.navigationSide === side ? 'selected' : ''} onClick={() => patch({ navigationSide: side })}>{side === 'left' ? 'Left' : 'Right'}</button>)}
            </div>
          </div>
          <div>
            <div className="section-heading"><div><h3>Language direction</h3><p>Layout fixture for LTR and RTL content.</p></div></div>
            <div className="segmented-control" role="group" aria-label="Language direction">
              {(['ltr', 'rtl'] as const).map((direction) => <button key={direction} aria-pressed={value.direction === direction} className={value.direction === direction ? 'selected' : ''} onClick={() => patch({ direction })}>{direction.toUpperCase()}</button>)}
            </div>
          </div>
        </section>

        <section className="appearance-section">
          <div className="section-heading"><div><h3>Text scale</h3><p>Keyboard, controls, and labels scale together.</p></div><span className="setting-current">{Math.round(value.fontScale * 100)}%</span></div>
          <div className="scale-options" role="group" aria-label="Text scale">
            {FONT_SCALES.map((fontScale) => <button key={fontScale} aria-pressed={value.fontScale === fontScale} className={value.fontScale === fontScale ? 'selected' : ''} onClick={() => patch({ fontScale })}>{Math.round(fontScale * 100)}%</button>)}
          </div>
        </section>

        <p className="local-preferences-note"><Icon name="settings"/> Preferences are saved only in this reconstruction profile. No connection token or real workspace data is stored here.</p>
      </div>
    </section>
  </div>
}
