import { useMemo, useState } from 'react'
import type { ModelCatalog } from '../../shared/bridge/types'
import type { LiveScope } from '../live/useLiveServer'
import { OpsHeader, OpsLoadState, operationsErrorText, useOpsResource, useScopeGuard } from './shared'

export function ModelsPage({ scope }: { scope: LiveScope }) {
  const { resource, reload, replace } = useOpsResource<ModelCatalog>(scope, (bridge) => bridge.api.invoke('models.list', {}))
  const begin = useScopeGuard(scope)
  const [selection, setSelection] = useState<{ provider: string; model: string } | null>(null)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const catalog = resource.data
  const provider = selection?.provider ?? catalog?.current.provider ?? catalog?.providers[0]?.id ?? ''
  const model = selection?.model ?? catalog?.current.model ?? ''
  const visibleModels = useMemo(() => {
    const models = catalog?.providers.find((item) => item.id === provider)?.models ?? []
    const needle = query.trim().toLowerCase()
    return needle ? models.filter((item) => item.toLowerCase().includes(needle)) : models
  }, [catalog, provider, query])
  const unchanged = provider === catalog?.current.provider && model === catalog?.current.model

  const save = async () => {
    const current = begin()
    setSaving(true)
    setFeedback(null)
    try {
      const result = await scope.bridge.api.invoke('models.setDefault', { provider, model })
      if (!current()) return
      replace(result)
      setSelection(null)
      setFeedback({ kind: 'success', text: `The profile default is now ${model}.` })
    } catch (error) {
      if (current()) setFeedback({ kind: 'error', text: operationsErrorText(error, true) })
    } finally {
      if (current()) setSaving(false)
    }
  }

  return <section className="collection-view ops-page" aria-label="Server models">
    <OpsHeader eyebrow="INFERENCE" description="Models the server can run through a signed-in Prime provider. The default applies to new server work.">
      <button type="button" className="text-button" onClick={reload}>Refresh</button>
    </OpsHeader>
    <OpsLoadState resource={resource} subject="models" onRetry={reload} />
    {catalog && <>
      <p className="ops-current">Profile default: <strong dir="ltr">{catalog.current.model ?? 'None reported'}</strong>{catalog.current.provider && <> · <span dir="ltr">{catalog.current.provider}</span></>}</p>
      {catalog.providers.length === 0
        ? <p className="live-empty-line">The server reports no signed-in model provider, so no model can be chosen.</p>
        : <div className="ops-split">
          <div className="ops-list" role="group" aria-label="Providers">
            {catalog.providers.map((item) => <button type="button" key={item.id} aria-pressed={provider === item.id} onClick={() => setSelection({ provider: item.id, model: item.models[0] ?? '' })}>
              <span dir="ltr">{item.id}</span><small>{item.models.length}</small>
            </button>)}
          </div>
          <div className="ops-detail">
            <div className="ops-toolbar">
              <input type="search" aria-label="Search models" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Find a model" />
              <button type="button" className="ops-primary" disabled={saving || !provider || !model || unchanged} onClick={() => { void save() }}>{saving ? 'Saving…' : 'Use as default'}</button>
            </div>
            <div className="ops-radio-list" role="radiogroup" aria-label="Models">
              {visibleModels.map((item) => <label key={item} className="ops-radio">
                <input type="radio" name="ops-model" checked={item === model} onChange={() => setSelection({ provider, model: item })} />
                <span dir="ltr">{item}</span>
                {provider === catalog.current.provider && item === catalog.current.model && <small>current default</small>}
              </label>)}
              {!visibleModels.length && <p className="live-empty-line">No models match.</p>}
            </div>
          </div>
        </div>}
      {feedback && <p className={feedback.kind === 'error' ? 'ops-error' : 'ops-success'} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
    </>}
  </section>
}
