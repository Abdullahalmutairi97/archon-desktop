import { useEffect, useId, useRef, useState } from 'react'
import type { SkillDetail, SkillRecord } from '../../shared/bridge/types'
import type { LiveScope } from '../live/useLiveServer'
import { OpsHeader, OpsLoadState, operationsErrorText, useOpsResource, useScopeGuard } from './shared'

function SkillReader({ skill, onClose }: { skill: SkillDetail; onClose(): void }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => { closeRef.current?.focus() }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])
  return <div className="ops-dialog-backdrop" role="presentation">
    <section className="ops-dialog ops-reader" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="ops-reader-head">
        <h2 id={titleId} dir="auto">{skill.name}</h2>
        <span>{skill.enabled ? 'Enabled' : 'Disabled'}</span>
        <button type="button" ref={closeRef} onClick={onClose}>Close</button>
      </header>
      <p className="ops-note" dir="ltr">{skill.path}</p>
      <pre className="ops-pre" dir="auto">{skill.content}</pre>
    </section>
  </div>
}

export function SkillsPage({ scope }: { scope: LiveScope }) {
  const { resource, reload, replace } = useOpsResource(scope, async (bridge) => (await bridge.api.invoke('skills.list', {})).skills)
  const begin = useScopeGuard(scope)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reader, setReader] = useState<SkillDetail | null>(null)
  const skills = resource.data

  const toggle = async (skill: SkillRecord) => {
    if (pending || !skills) return
    const current = begin()
    setPending(skill.name)
    setError(null)
    try {
      const committed = await scope.bridge.api.invoke('skills.toggle', { name: skill.name, enabled: !skill.enabled })
      if (current()) replace(skills.map((item) => item.name === committed.name ? committed : item))
    } catch (reason) {
      if (current()) setError(`${skill.name}: ${operationsErrorText(reason, true)}`)
    } finally {
      if (current()) setPending(null)
    }
  }

  const inspect = async (skill: SkillRecord) => {
    const current = begin()
    setError(null)
    try {
      const detail = await scope.bridge.api.invoke('skills.get', { name: skill.name })
      if (current()) setReader(detail)
    } catch (reason) {
      if (current()) setError(`${skill.name}: ${operationsErrorText(reason)}`)
    }
  }

  return <section className="collection-view ops-page" aria-label="Server skills">
    <OpsHeader eyebrow="SKILLS" description="Skills installed for the server agent. A toggle writes the server profile immediately; the server may refuse to disable bundled skills.">
      <button type="button" className="text-button" onClick={reload}>Refresh</button>
    </OpsHeader>
    {error && <p className="ops-error" role="alert" dir="auto">{error}</p>}
    <OpsLoadState resource={resource} subject="skills" onRetry={reload} />
    {skills && (skills.length === 0
      ? <p className="live-empty-line">The server reports no installed skills.</p>
      : <div className="ops-card-list">{skills.map((skill) => <article className="ops-card" key={skill.name}>
        <button type="button" className={`ops-switch ${skill.enabled ? 'on' : ''}`} role="switch" aria-checked={skill.enabled}
          aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`} disabled={pending !== null} onClick={() => { void toggle(skill) }}><i /></button>
        <div className="ops-card-copy">
          <header><strong dir="auto">{skill.name}</strong><span dir="auto">{skill.category || 'Local'}</span></header>
          <p dir="auto">{skill.description || 'No description.'}</p>
        </div>
        <button type="button" className="text-button" aria-label={`Read ${skill.name}`} onClick={() => { void inspect(skill) }}>Read SKILL.md</button>
      </article>)}</div>)}
    {reader && <SkillReader skill={reader} onClose={() => setReader(null)} />}
  </section>
}
