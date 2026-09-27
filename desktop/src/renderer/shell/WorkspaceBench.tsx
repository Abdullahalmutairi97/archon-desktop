import { useMemo, useState } from 'react'
import { documentKeyId, makeDocumentKey, type ExecutionScope } from '../../shared/domain/identity'
import { queueCounts } from '../../shared/domain/queue'
import { FIXTURE_ACTIVITY, FIXTURE_TASKS, runtimeLabel } from './fixtures'
import type { BenchId } from './shortcuts'
import { Icon, type IconName } from './Icon'
import { BrandMark } from './BrandMark'

const tabs: { id: BenchId; label: string; icon: IconName }[] = [
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'browser', label: 'Browser', icon: 'browser' },
  { id: 'ide', label: 'IDE', icon: 'code' },
]

const fixtureFiles = [
  { path: 'README.md', label: 'README.md', kind: 'markdown' },
  { path: 'src/App.tsx', label: 'App.tsx', kind: 'typescript' },
  { path: 'src/theme.css', label: 'theme.css', kind: 'css' },
] as const

const filePreviews: Record<string, string> = {
  'README.md': '# Scoped workspace fixture\n\nThis is authored sample content for the reconstruction preview. It is not read from a real workspace.\n\n- Baseline parity: unverified',
  'src/App.tsx': "export function App() {\n  return <main data-preview-only>\n    <h1>Fixture workspace</h1>\n    <p>No local project files are connected.</p>\n  </main>\n}",
  'src/theme.css': ':root {\n  --surface: #1a1a1a;\n  --accent: #cfc9c1;\n}\n\n/* Synthetic preview source */',
}

function statusLabel(status: string, recoveryState?: string) {
  if (recoveryState === 'review_required') return 'Review required'
  if (status === 'running' || status === 'cancel_requested') return 'Working'
  if (status === 'queued') return 'Queued'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'blocked') return 'Blocked'
  return 'Outcome unknown'
}

export function WorkspaceBench({
  active,
  open,
  scope,
  onSelect,
  onClose,
}: {
  active: BenchId
  open: boolean
  scope: ExecutionScope
  onSelect(tab: BenchId): void
  onClose(): void
}) {
  const [selectedFile, setSelectedFile] = useState<string>(fixtureFiles[0].path)
  const activeFile = useMemo(() => fixtureFiles.find((file) => file.path === selectedFile) ?? fixtureFiles[0], [selectedFile])
  const activeDocumentId = documentKeyId(makeDocumentKey(scope, activeFile.path))
  const counts = queueCounts([...FIXTURE_TASKS])
  const needsReview = FIXTURE_TASKS.filter((task) => task.recoveryState === 'review_required' || task.recoveryState === 'unknown').length

  if (!open) return null

  return <aside className="workspace-bench" aria-label="Workspace tools">
    <div className="bench-header">
      <div className="bench-tabs" role="tablist" aria-label="Workbench panels">
        {tabs.map((tab) => <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={`bench-tab ${active === tab.id ? 'active' : ''}`}
          onClick={() => onSelect(tab.id)}
          title={`${tab.label} · Ctrl ${tabs.indexOf(tab) + 1}`}
        ><Icon name={tab.icon} /><span>{tab.label}</span></button>)}
      </div>
      <button className="quiet-icon-button bench-close" aria-label="Close workbench" onClick={onClose}><Icon name="close" /></button>
    </div>

    <div className="bench-content">
      {active === 'activity' && <section className="bench-panel activity-panel" aria-labelledby="activity-heading">
        <div className="panel-title-row"><div><span className="eyebrow">SESSION ACTIVITY</span><h2 id="activity-heading">Activity</h2></div><span className="fixture-tag">SYNTHETIC</span></div>
        <div className="queue-summary"><div><span className="summary-value">{counts.running}</span><span>Working</span></div><div><span className="summary-value">{counts.queued}</span><span>Queued</span></div><div><span className="summary-value">{needsReview}</span><span>Review</span></div></div>
        <div className="activity-list">
          {FIXTURE_ACTIVITY.map((item, index) => <article key={item.id} className="activity-item">
            <span className={`activity-node node-${index}`}><i /></span>
            <div className="activity-copy"><div className="activity-meta"><strong>{item.label}</strong><time>{item.time}</time></div><p>{item.detail}</p></div>
          </article>)}
        </div>
        <div className="bench-note"><Icon name="activity" /><p>These events are fixture rows. No worker is running in this preview.</p></div>
      </section>}

      {active === 'files' && <section className="bench-panel files-panel" aria-labelledby="files-heading">
        <div className="panel-title-row"><div><span className="eyebrow">FIXTURE TREE</span><h2 id="files-heading">Files</h2></div><span className="fixture-tag">READ ONLY</span></div>
        <div className="root-path"><Icon name="folder" /><span>{scope.root}</span></div>
        <div className="file-browser">
          <div className="file-tree" role="list" aria-label="Synthetic files">
            <div className="tree-folder"><Icon name="chevron" /> <Icon name="folder" /> src</div>
            {fixtureFiles.map((file) => <button key={file.path} className={`tree-file ${selectedFile === file.path ? 'selected' : ''}`} onClick={() => setSelectedFile(file.path)}>
              <Icon name={file.kind === 'markdown' ? 'file' : 'code'} /><span>{file.label}</span>
            </button>)}
          </div>
          <div className="file-preview" data-document-key={activeDocumentId}>
            <div className="preview-file-title"><Icon name={activeFile.kind === 'markdown' ? 'file' : 'code'} />{activeFile.label}<span>Fixture</span></div>
            <pre>{filePreviews[activeFile.path]}</pre>
          </div>
        </div>
        <div className="bench-note"><Icon name="file" /><p>Paths and text are invented for this view; nothing is opened from disk.</p></div>
      </section>}

      {active === 'terminal' && <section className="bench-panel unavailable-panel" aria-labelledby="terminal-heading">
        <div className="panel-title-row"><div><span className="eyebrow">COMMAND SURFACE</span><h2 id="terminal-heading">Terminal</h2></div><span className="fixture-tag">DISCONNECTED</span></div>
        <div className="terminal-window"><div className="terminal-chrome"><i /><i /><i /><span>synthetic-shell</span></div><div className="terminal-body"><p><span className="terminal-prompt">$</span> Terminal is not connected.</p><p className="terminal-muted">This preview never executes commands.</p><span className="terminal-cursor" /></div></div>
        <div className="bench-note"><Icon name="terminal" /><p>For a real selected-checkout shell, open Server work and choose its line console. This preview never executes commands.</p></div>
      </section>}

      {active === 'browser' && <section className="bench-panel browser-panel" aria-labelledby="browser-heading">
        <div className="panel-title-row"><div><span className="eyebrow">BROWSER SURFACE</span><h2 id="browser-heading">Browser</h2></div><span className="fixture-tag">OFFLINE FIXTURE</span></div>
        <div className="browser-frame">
          <div className="browser-toolbar"><span className="browser-dots"><i /><i /><i /></span><div className="address-bar"><Icon name="settings" /> preview://fixture/reconstruction</div></div>
          <div className="browser-page"><BrandMark className="browser-mark" /><span className="eyebrow">SYNTHETIC BROWSER PANEL</span><h3>Nothing is connected</h3><p>This sample page is part of the renderer fixture. It does not navigate or load remote content.</p><button className="text-button" onClick={() => onSelect('activity')}>Return to activity</button></div>
        </div>
      </section>}

      {active === 'ide' && <section className="bench-panel ide-panel" aria-labelledby="ide-heading">
        <div className="panel-title-row"><div><span className="eyebrow">EDITOR SURFACE</span><h2 id="ide-heading">IDE</h2></div><span className="fixture-tag">FIXTURE</span></div>
        <div className="ide-context"><span className="ide-language-dot" />{runtimeLabel(scope.runtime)}<span className="context-separator">/</span>{scope.root.split('/').filter(Boolean).at(-1)}</div>
        <div className="ide-editor"><div className="editor-tab"><Icon name="code" />{activeFile.label}<span className="editor-readonly">Read only</span></div><pre data-document-key={activeDocumentId}>{filePreviews[activeFile.path].split('\n').map((line, index) => <span className="code-line" key={`${index}-${line}`}><i>{String(index + 1).padStart(2, '0')}</i>{line || ' '}{'\n'}</span>)}</pre></div>
        <div className="bench-note"><Icon name="code" /><p>Document identity includes runtime, connection, session, root, and path. Edits are not persisted.</p></div>
      </section>}

      <section className="queue-panel" aria-label="Synthetic task queue">
        <div className="queue-panel-heading"><strong>Task queue</strong><span className="fixture-tag">FIXTURE</span></div>
        {FIXTURE_TASKS.map((task) => <div className="queue-row" key={task.id}>
          <span className={`queue-status status-${task.status}`} />
          <span className="queue-task-id">{task.id.replace(/^[^:]+:/, '')}</span>
          <span className={`queue-state ${task.recoveryState === 'review_required' ? 'state-review' : ''}`}>{statusLabel(task.status, task.recoveryState)}</span>
        </div>)}
      </section>
    </div>
  </aside>
}
