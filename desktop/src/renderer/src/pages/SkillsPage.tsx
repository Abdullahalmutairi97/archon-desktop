import { X } from '@phosphor-icons/react'
import { useState } from 'react'
import { ErrorNotice, usePolling } from '../components'
import type { ArchonApi } from '../lib/api'
import type { Skill } from '../lib/types'

export function SkillsPage({ api }: { api: ArchonApi }) {
  const { data: skills = [], error: loadError, refresh } = usePolling<Skill[]>(() => api.skills(), 10000, [api])
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<string>()
  const [mutationError, setMutationError] = useState('')
  const [reader, setReader] = useState<{ skill: Skill; content: string }>()
  const enabled = (skill: Skill) => overrides[skill.name] ?? skill.enabled

  const toggle = async (skill: Skill) => {
    if (pending) return
    const next = !enabled(skill)
    setPending(skill.name); setMutationError('')
    try {
      const committed = await api.toggleSkill(skill.name, next)
      setOverrides((state) => ({ ...state, [skill.name]: committed.enabled }))
      await refresh()
    } catch (reason) { setMutationError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setPending(undefined) }
  }
  const inspect = async (skill: Skill) => {
    setMutationError('')
    try { const detail = await api.inspectSkill(skill.name); setReader({ skill: detail, content: detail.content || '' }) }
    catch (reason) { setMutationError(reason instanceof Error ? reason.message : String(reason)) }
  }

  return <section className="reference-page skills-page exact-skills">
    <header className="reference-page-header"><div><h1>Skills</h1><p>Installed Archon skills. Toggling writes the profile immediately.</p></div></header>
    <ErrorNotice error={loadError || mutationError}/>
    <div className="skill-card-list">{skills.map((skill) => <article key={skill.name}>
      <button type="button" className={`reference-switch ${enabled(skill) ? 'on' : ''}`} role="switch" aria-label={`${enabled(skill) ? 'Disable' : 'Enable'} ${skill.name}`} aria-checked={enabled(skill)} disabled={pending === skill.name} onClick={() => void toggle(skill)}><i/></button>
      <div><header><b>{skill.name}</b><span>{skill.category || 'Local'}</span></header><p>{skill.description || 'Installed Archon skill.'}</p></div>
      <button className="read-skill" aria-label={`Open ${skill.name}`} onClick={() => void inspect(skill)}>Read SKILL.md</button>
    </article>)}</div>
    {reader && <div className="skill-reader-backdrop" onClick={() => setReader(undefined)}><section onClick={(event) => event.stopPropagation()}><header><h2>{reader.skill.name}</h2><span>{enabled(reader.skill) ? 'Enabled' : 'Disabled'}</span><button aria-label="Close skill" onClick={() => setReader(undefined)}><X/></button></header><pre>{reader.content}</pre></section></div>}
  </section>
}
