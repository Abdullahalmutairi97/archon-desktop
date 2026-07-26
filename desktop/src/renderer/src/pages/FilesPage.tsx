import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Download, File, Folder, Save, Trash2, Upload } from 'lucide-react'
import { Button, ConfirmDialog, Empty, ErrorNotice, Section, formatBytes, formatDate } from '../components'
import type { ArchonApi } from '../lib/api'
import type { FileItem } from '../lib/types'

type PreviewKind = 'text' | 'image' | 'pdf' | 'unsupported'
const previewKind = (item: FileItem): PreviewKind => {
  const mime = (item.mime || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/') || /(?:json|javascript|xml|yaml|toml|shellscript)/.test(mime) || /\.(?:md|txt|json|ya?ml|toml|ini|conf|log|csv|ts|tsx|js|jsx|py|sh|css|html?|xml)$/i.test(item.name)) return 'text'
  return 'unsupported'
}

export function FilesPage({ api }: { api: ArchonApi }) {
  const [path, setPath] = useState('.')
  const [items, setItems] = useState<FileItem[]>([])
  const [selected, setSelected] = useState<FileItem>()
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<PreviewKind>('text')
  const [previewUrl, setPreviewUrl] = useState('')
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteWord, setDeleteWord] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)

  const clearPreviewUrl = () => setPreviewUrl((current) => { if (current) URL.revokeObjectURL(current); return '' })
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const load = async (next = path) => {
    try { setItems(await api.files(next)); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { void load() }, [path, api])

  const mayDiscard = () => !dirty || window.confirm('Discard unsaved file changes?')
  const navigate = (next: string) => {
    if (!mayDiscard()) return
    clearPreviewUrl(); setPath(next); setSelected(undefined); setContent(''); setDirty(false); setError('')
  }

  const open = async (item: FileItem) => {
    if (item.is_dir) { navigate(item.path); return }
    if (selected?.path !== item.path && !mayDiscard()) return
    clearPreviewUrl(); setSelected(item); setContent(''); setDirty(false); setError(''); setLoadingPreview(true)
    const nextKind = previewKind(item); setKind(nextKind)
    if (item.restricted) { setKind('unsupported'); setContent('This secret-bearing file is intentionally unavailable.'); setLoadingPreview(false); return }
    try {
      if (nextKind === 'text') setContent((await api.readFile(item.path)).content)
      else if (nextKind === 'image' || nextKind === 'pdf') setPreviewUrl(URL.createObjectURL(await api.downloadFile(item.path)))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoadingPreview(false) }
  }

  const parent = path === '.' ? '.' : path.split('/').slice(0, -1).join('/') || '.'
  const download = async () => {
    if (!selected) return
    try {
      const blob = await api.downloadFile(selected.path)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = selected.name; anchor.click(); URL.revokeObjectURL(url)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const upload = async (file?: globalThis.File) => {
    if (!file) return
    try { const target = path === '.' ? file.name : `${path}/${file.name}`; await api.uploadFile(target, file); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const save = async () => {
    if (!selected || selected.restricted || kind !== 'text') return
    try { await api.writeFile(selected.path, content); setDirty(false); setSaveOpen(false); setError(''); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const remove = async () => {
    if (!selected || deleteWord !== selected.path) return
    try { await api.deleteFile(selected.path, true); setDeleteOpen(false); setDeleteWord(''); clearPreviewUrl(); setSelected(undefined); setContent(''); setDirty(false); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const preview = !selected ? <Empty>Select a file to preview or edit.</Empty>
    : loadingPreview ? <Empty>Loading preview…</Empty>
    : error ? <Empty>Preview unavailable.</Empty>
    : kind === 'text' ? <textarea aria-label="File content" value={content} readOnly={selected.restricted} onChange={(event) => { setContent(event.target.value); setDirty(true) }} spellCheck={false}/>
    : kind === 'image' && previewUrl ? <div className="file-media-preview"><img alt={`Preview ${selected.name}`} src={previewUrl}/></div>
    : kind === 'pdf' && previewUrl ? <iframe className="file-pdf-preview" title={`Preview ${selected.name}`} src={previewUrl}/>
    : <Empty>{content || 'Preview is unavailable for this file type. Download it to inspect safely.'}</Empty>

  return <Section title="VPS files" description="Browse and edit allowlisted text files on the machine where Archon runs." actions={<><input ref={uploadRef} hidden type="file" onChange={(event) => void upload(event.target.files?.[0])}/><Button onClick={() => uploadRef.current?.click()}><Upload size={15}/> Upload</Button></>}>
    <ErrorNotice error={error}/>
    <div className="pathbar"><button onClick={() => navigate('.')}>~</button>{path !== '.' && path.split('/').map((part, index) => <span key={`${part}-${index}`}><ChevronRight size={13}/><button onClick={() => navigate(path.split('/').slice(0, index + 1).join('/'))}>{part}</button></span>)}</div>
    <div className="file-layout">
      <div className="file-list"><button className="file-row" onClick={() => navigate(parent)}><Folder size={16}/><span><strong>..</strong><small>Parent directory</small></span></button>{!items.length ? <Empty>This directory is empty.</Empty> : items.map((item) => <button className={`file-row ${selected?.path === item.path ? 'selected' : ''}`} key={item.path} onClick={() => void open(item)}>{item.is_dir ? <Folder size={16}/> : <File size={16}/>}<span><strong>{item.name}</strong><small>{item.is_dir ? 'Directory' : `${formatBytes(item.size)} · ${formatDate(item.modified_at)}`}</small></span>{item.restricted && <em>restricted</em>}</button>)}</div>
      <div className="file-editor">{selected && <header><div><h3>{selected.name}{dirty ? ' •' : ''}</h3><code>{selected.path}</code></div><div><Button onClick={() => void download()}><Download size={14}/> Download</Button><Button disabled={selected.restricted || !dirty || kind !== 'text'} onClick={() => setSaveOpen(true)}><Save size={14}/> Save</Button><Button tone="danger" disabled={selected.restricted} onClick={() => setDeleteOpen(true)}><Trash2 size={14}/> Delete</Button></div></header>}{preview}</div>
    </div>
    <ConfirmDialog open={saveOpen} title={`Save ${selected?.name || 'file'}?`} detail={`This writes changes to ${selected?.path || ''} on the VPS.`} confirmLabel="Save file" onConfirm={() => void save()} onCancel={() => setSaveOpen(false)}/>
    {deleteOpen && selected && <div className="dialog-backdrop" role="presentation"><div className="dialog file-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="file-delete-title"><h3 id="file-delete-title">Delete {selected.name}?</h3><p>This cannot be undone. Type the full path to confirm:</p><code>{selected.path}</code><label>Full path<input aria-label="Type the full path to delete" value={deleteWord} onChange={(event) => setDeleteWord(event.target.value)}/></label><div className="dialog-actions"><Button onClick={() => { setDeleteOpen(false); setDeleteWord('') }}>Cancel</Button><Button tone="danger" disabled={deleteWord !== selected.path} onClick={() => void remove()}>Delete file</Button></div></div></div>}
  </Section>
}
