import { Check, Cpu, Search, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button, ErrorNotice, usePolling } from '../components'
import type { ArchonApi } from '../lib/api'
import type { ModelCatalog } from '../lib/types'
import { modelKey, onPinnedModelsChange, readPinnedModels, togglePinnedModel, type ModelRef } from '../lib/modelPreferences'

export function ModelsPage({ api }: { api: ArchonApi }) {
  const { data, error, refresh } = usePolling<ModelCatalog>(() => api.models(), 15000, [api])
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [pinned, setPinned] = useState<ModelRef[]>([])
  useEffect(() => {
    if (data?.current.provider && !provider) setProvider(data.current.provider)
    if (data?.current.model && !model) setModel(data.current.model)
  }, [data, model, provider])
  useEffect(() => { setPinned(readPinnedModels(data)); return onPinnedModelsChange(() => setPinned(readPinnedModels(data))) }, [data])
  const providers = data?.providers || []
  const visibleModels = useMemo(() => {
    const selected = providers.find((item) => item.id === provider)
    const models = selected?.models || []
    return models.filter((item) => !query.trim() || item.toLowerCase().includes(query.trim().toLowerCase()))
  }, [provider, providers, query])
  const chooseProvider = (value: string) => {
    setProvider(value)
    const next = providers.find((item) => item.id === value)?.models[0] || ''
    setModel(next)
  }
  const save = async () => { setSaving(true); try { await api.setModel(provider, model); await refresh() } finally { setSaving(false) } }
  return <section className="model-studio">
    <header className="page-title"><div><span className="kicker">INFERENCE</span><h1>Models</h1></div><div className="current-model"><Cpu size={16}/><span><small>Profile default</small><strong>{data?.current.model || 'Loading'}</strong></span></div></header>
    <ErrorNotice error={error}/>
    <div className="model-browser">
      <aside>{providers.map((item) => <button className={provider === item.id ? 'active' : ''} key={item.id} onClick={() => chooseProvider(item.id)}><span>{item.id}</span><small>{item.models.length}</small></button>)}</aside>
      <div className="model-catalog">
        <div className="catalog-toolbar"><label className="search-field"><Search size={14}/><input aria-label="Search models" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a model"/></label><span className="pinned-count"><Star size={12} fill="currentColor"/>{pinned.length} in chat</span><Button tone="primary" disabled={saving || !provider || !model || (provider === data?.current.provider && model === data?.current.model)} onClick={() => void save()}>{saving ? 'Saving' : 'Use as default'}</Button></div>
        <div className="model-list">{visibleModels.map((item) => {
          const selected = item === model
          const current = provider === data?.current.provider && item === data?.current.model
          const ref = { provider, model: item }; const isPinned = pinned.some((value) => modelKey(value) === modelKey(ref))
          return <div className={`model-list-row ${selected ? 'selected' : ''}`} key={item}><button className="model-select-row" onClick={() => setModel(item)}><span className="model-radio">{selected && <Check size={12}/>}</span><span><strong>{item}</strong><small>{provider}{current ? ' · current default' : ''}</small></span></button><button className={`model-pin ${isPinned ? 'pinned' : ''}`} aria-label={`${isPinned ? 'Hide' : 'Show'} ${item} in chat`} onClick={() => setPinned(togglePinnedModel(ref, data))}><Star size={14} fill={isPinned ? 'currentColor' : 'none'}/></button></div>
        })}</div>
      </div>
    </div>
  </section>
}
