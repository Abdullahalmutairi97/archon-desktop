import { CaretDown, Check, MagnifyingGlass, SlidersHorizontal, Sparkle, Star } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { modelFromKey, modelKey, onPinnedModelsChange, readPinnedModels, togglePinnedModel, type ModelRef } from '../lib/modelPreferences'
import type { ModelCatalog } from '../lib/types'

export function ModelPicker({ catalog, value, onChange, globalShortcut = false }: { catalog?: ModelCatalog; value: string; onChange(value: string): void; globalShortcut?: boolean }) {
  const [open, setOpen] = useState(false)
  const [browse, setBrowse] = useState(false)
  const [query, setQuery] = useState('')
  const [pinned, setPinned] = useState<ModelRef[]>([])
  const root = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selected = modelFromKey(value)
  const allModels = useMemo(() => (catalog?.providers || []).flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, model }))), [catalog])
  const refreshPinned = () => setPinned(readPinnedModels(catalog))

  useEffect(refreshPinned, [catalog])
  useEffect(() => onPinnedModelsChange(refreshPinned), [catalog])
  useEffect(() => {
    const onPointer = (event: PointerEvent) => { if (open && root.current && !root.current.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
      if (globalShortcut && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') { event.preventDefault(); setOpen(true) }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [globalShortcut, open])
  useEffect(() => { if (open) window.setTimeout(() => searchRef.current?.focus(), 40) }, [open])

  const pinnedKeys = new Set(pinned.map(modelKey))
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle) return allModels.filter((item) => `${item.provider} ${item.model}`.toLowerCase().includes(needle)).slice(0, 80)
    if (browse) return allModels.slice(0, 80)
    const quick = [...pinned]
    if (selected && !quick.some((item) => modelKey(item) === modelKey(selected))) quick.unshift(selected)
    return quick
  }, [allModels, browse, pinned, query, selected?.provider, selected?.model])

  const togglePin = (item: ModelRef) => setPinned(togglePinnedModel(item, catalog))
  const choose = (item: ModelRef) => { onChange(modelKey(item)); setOpen(false); setBrowse(false); setQuery('') }
  return <div className="chat-model-picker" ref={root}>
    <button className="model-trigger" aria-label="Choose model" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Sparkle size={13}/><span>{selected?.model || 'Choose model'}</span><CaretDown size={12}/>
    </button>
    {open && <div className="model-popover">
      <header><div><strong>Model</strong><span>{selected?.provider || 'Session model'}</span></div><kbd>Ctrl Shift M</kbd></header>
      <label className="model-search"><MagnifyingGlass size={13}/><input ref={searchRef} aria-label="Search available models" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models"/></label>
      <div className="model-popover-label">{query || browse ? 'Available models' : 'Shown in chat'}</div>
      <div className="model-popover-list">
        {visible.map((item) => {
          const key = modelKey(item); const active = key === value; const isPinned = pinnedKeys.has(key)
          return <div className={`model-option ${active ? 'active' : ''}`} key={key}>
            <button className="model-option-pick" onClick={() => choose(item)}><span className="provider-mark">{item.provider.slice(0, 2).toUpperCase()}</span><span><strong>{item.model}</strong><small>{item.provider}</small></span>{active && <Check size={14}/>}</button>
            <button className={`pin-model ${isPinned ? 'pinned' : ''}`} aria-label={`${isPinned ? 'Hide' : 'Show'} ${item.model} in chat`} title={`${isPinned ? 'Hide from' : 'Show in'} chat`} onClick={() => togglePin(item)}><Star size={13} weight={isPinned ? 'fill' : 'regular'}/></button>
          </div>
        })}
        {!visible.length && <div className="model-empty">No matching models</div>}
      </div>
      {!query && <footer><button onClick={() => setBrowse((value) => !value)}><SlidersHorizontal size={13}/>{browse ? 'Show pinned only' : 'Browse all models'}</button><span>{pinned.length} pinned</span></footer>}
    </div>}
  </div>
}
