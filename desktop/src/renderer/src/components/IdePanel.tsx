import { ArrowsClockwise, CircleNotch, File, FolderOpen, FloppyDisk, ArrowUp, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Button, ConfirmDialog, ErrorNotice } from '../components'
import type { ArchonApi } from '../lib/api'
import type { FileItem, Task } from '../lib/types'

const textExtensions = /\.(?:c|cc|cpp|css|csv|go|h|hpp|html?|ini|java|js|json|jsx|md|mjs|php|py|rb|rs|sh|sql|svelte|toml|ts|tsx|txt|vue|xml|ya?ml|zsh)$/i

function editable(item: FileItem) {
  const mime = (item.mime || '').toLowerCase()
  return mime.startsWith('text/') || /(?:json|javascript|xml|yaml|toml|shellscript)/.test(mime) || textExtensions.test(item.name)
}

function sortFiles(items: FileItem[]) {
  return [...items].sort((left, right) => Number(right.is_dir) - Number(left.is_dir) || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
}

export function IdePanel({ api, tasks }: { api: ArchonApi; tasks: Task[] }) {
  const [path, setPath] = useState(() => tasks.find((task) => task.cwd)?.cwd || '/home/archon')
  const [items, setItems] = useState<FileItem[]>([])
  const [selected, setSelected] = useState<FileItem>()
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [error, setError] = useState('')

  const loadFiles = async (next = path) => {
    setLoading(true); setError('')
    try { setItems(sortFiles(await api.files(next))); setPath(next) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void loadFiles() }, [api])

  const mayDiscard = () => !dirty || window.confirm('Discard unsaved IDE changes?')
  const open = async (item: FileItem) => {
    if (item.is_dir) { if (mayDiscard()) { setSelected(undefined); setContent(''); setDirty(false); void loadFiles(item.path) }; return }
    if (!mayDiscard()) return
    setSelected(item); setContent(''); setDirty(false); setError('')
    if (item.restricted) { setContent('This secret-bearing file is intentionally unavailable.'); return }
    if (!editable(item)) { setContent('This file type is not editable in the IDE. Use the Files page to download it.'); return }
    setLoading(true)
    try { setContent((await api.readFile(item.path)).content) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }
  const navigateUp = () => {
    if (!mayDiscard()) return
    const parent = path === '/' ? '/' : path.split('/').slice(0, -1).join('/') || '/'
    setSelected(undefined); setContent(''); setDirty(false); void loadFiles(parent)
  }
  const save = async () => {
    if (!selected || selected.restricted || !editable(selected) || !dirty) return
    setSaving(true); setError('')
    try { await api.writeFile(selected.path, content); setDirty(false); setSaveOpen(false); await loadFiles() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }

  return <section className="ide-panel" aria-label="Agent IDE">
    <header className="ide-header"><div><b>IDE</b><code>{path}</code></div><div className="ide-header-actions"><button aria-label="Refresh files" title="Refresh files" onClick={() => void loadFiles()} disabled={loading}><ArrowsClockwise className={loading ? 'browser-spin' : ''}/></button></div></header>
    <ErrorNotice error={error}/>
    <div className="ide-layout">
      <aside className="ide-files" aria-label="Project files">
        <div className="ide-file-toolbar"><button aria-label="Open parent directory" title="Open parent directory" onClick={navigateUp}><ArrowUp/></button><span>Explorer</span></div>
        <div className="ide-file-list"><button className="ide-file-row ide-parent" onClick={navigateUp}><FolderOpen/><span>..</span></button>{items.map((item) => <button className={`ide-file-row ${selected?.path === item.path ? 'selected' : ''}`} key={item.path} onClick={() => void open(item)}><span className="ide-file-icon">{item.is_dir ? <FolderOpen/> : <File/>}</span><span className="ide-file-name">{item.name}</span>{item.restricted && <small>restricted</small>}</button>)}{!items.length && !loading && <p className="ide-empty-files">No files in this folder.</p>}{loading && <p className="ide-empty-files"><CircleNotch className="browser-spin"/> Loading…</p>}</div>
      </aside>
      <div className="ide-editor">
        {selected ? <><header className="ide-editor-header"><div><b>{selected.name}{dirty ? ' •' : ''}</b><code>{selected.path}</code></div><div><Button disabled={selected.restricted || !editable(selected) || !dirty || saving} onClick={() => setSaveOpen(true)}><FloppyDisk/> Save</Button><button aria-label="Close file" title="Close file" onClick={() => { if (!mayDiscard()) return; setSelected(undefined); setContent(''); setDirty(false) }}><X/></button></div></header><textarea aria-label={`Edit ${selected.name}`} value={content} readOnly={selected.restricted || !editable(selected)} onChange={(event) => { setContent(event.target.value); setDirty(true) }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !selected.restricted && editable(selected) && dirty && !saving) { event.preventDefault(); setSaveOpen(true) } }} spellCheck={false}/></> : <div className="ide-empty"><File/><b>Open a file to start editing</b><span>Choose a text file from the explorer.</span></div>}
      </div>
    </div>
    <ConfirmDialog open={saveOpen} title={`Save ${selected?.name || 'file'}?`} detail={`This writes changes to ${selected?.path || ''} on the VPS.`} confirmLabel={saving ? 'Saving…' : 'Save file'} onConfirm={() => void save()} onCancel={() => { if (!saving) setSaveOpen(false) }}/>
  </section>
}
