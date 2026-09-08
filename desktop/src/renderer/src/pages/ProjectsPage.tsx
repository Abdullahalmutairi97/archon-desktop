import { ArrowRight, Folder, PushPin } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { ErrorNotice, usePolling } from '../components'
import type { ArchonApi } from '../lib/api'
import type { PrimeSession, Project, Task } from '../lib/types'
import { readPinnedProjectIds, relativeWorkspaceTime, sortProjectsByName, sortSessions, writePinnedProjectIds } from '../lib/workspace'

export function ProjectsPage({ api, tasks, onOpen }: { api: ArchonApi; tasks: Task[]; onOpen(projectId: string): void }) {
  const { data: projects = [], error } = usePolling<Project[]>(() => api.projects(), 15000, [api])
  const { data: sessions = [] } = usePolling<PrimeSession[]>(() => api.sessions(), 5000, [api])
  const [pinVersion, setPinVersion] = useState(0)
  const pinned = useMemo(() => new Set(readPinnedProjectIds(projects)), [pinVersion, projects])
  const togglePin = (id: string) => {
    const next = new Set(readPinnedProjectIds(projects))
    if (next.has(id)) next.delete(id); else next.add(id)
    writePinnedProjectIds(Array.from(next)); setPinVersion((value) => value + 1)
  }
  return <section className="reference-page projects-page">
    <header className="reference-page-header"><div><h1>Projects</h1><p>Sorted A to Z. Pin the ones you want in the sidebar — the rest stay here.</p></div><span>{pinned.size} of {projects.length} in sidebar</span></header>
    <ErrorNotice error={error}/>
    <div className="project-card-grid">{sortProjectsByName(projects).map((project) => {
      const related = sortSessions(sessions.filter((session) => session.project_id === project.id), 'recent', 'desc')
      const latest = related[0]
      const running = tasks.filter((task) => ['queued', 'running'].includes(task.status) && (task.cwd === project.primary_path || related.some((session) => session.id === task.session_id))).length
      const isPinned = pinned.has(project.id)
      return <article key={project.id} className={isPinned ? 'pinned' : ''}><header><Folder/><h2>{project.name}</h2><button aria-label={`${isPinned ? 'Hide' : 'Show'} ${project.name} in sidebar`} title="Show in sidebar" className={isPinned ? 'active' : ''} onClick={() => togglePin(project.id)}><PushPin/></button></header><code>{project.primary_path || `~/archon/${project.slug}`}</code><div className="project-meta"><span>{related.length} sessions</span><span>{latest ? `last ${relativeWorkspaceTime(latest.last_active)}` : 'no activity'}</span><span>{running ? `${running} ${running === 1 ? 'task' : 'tasks'}` : 'none'}</span></div><footer><button onClick={() => onOpen(project.id)}>Open project <ArrowRight/></button><span>{isPinned ? 'In the sidebar' : 'Hidden from sidebar'}</span></footer></article>
    })}</div>
  </section>
}
