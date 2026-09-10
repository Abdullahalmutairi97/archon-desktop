import type { PrimeSession, Project } from './types'

export type SidebarDestination = 'chat' | 'sessions' | 'tasks' | 'logs' | 'skills' | 'cron' | 'backups'
export type BenchDestination = 'tasks' | 'files' | 'terminal' | 'browser' | 'ide'
export type SessionSort = 'recent' | 'title' | 'project' | 'model' | 'messages' | 'status'
export type SortDirection = 'asc' | 'desc'

export const SIDEBAR_NAV_TOP: ReadonlyArray<{ id: SidebarDestination; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'tasks', label: 'Tasks' },
]
export const SIDEBAR_NAV_UNDER: ReadonlyArray<{ id: SidebarDestination; label: string }> = [
  { id: 'skills', label: 'Skills' },
  { id: 'cron', label: 'Automations' },
  { id: 'backups', label: 'Backups' },
  { id: 'logs', label: 'Logs' },
]
export const SIDEBAR_NAV = [...SIDEBAR_NAV_TOP, ...SIDEBAR_NAV_UNDER] as const

export const TITLEBAR_BENCH: ReadonlyArray<{ id: BenchDestination; label: string }> = [
  { id: 'tasks', label: 'Activity' },
  { id: 'files', label: 'Files' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'browser', label: 'Browser' },
  { id: 'ide', label: 'IDE' },
]

function timestamp(value: string | number | undefined) {
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000
  const parsed = value ? new Date(value).getTime() : 0
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortProjectsByName<T extends Pick<Project, 'name'>>(projects: T[]): T[] {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

export function sortSessions(sessions: PrimeSession[], sort: SessionSort = 'recent', direction: SortDirection = 'desc'): PrimeSession[] {
  const text = (value?: string) => (value || '').trim()
  const compare = (a: PrimeSession, b: PrimeSession) => {
    if (sort === 'recent') return timestamp(a.last_active || a.started_at) - timestamp(b.last_active || b.started_at)
    if (sort === 'messages') return (a.message_count || 0) - (b.message_count || 0)
    if (sort === 'status') return Number(a.active) - Number(b.active)
    if (sort === 'project') return text(a.project_id).localeCompare(text(b.project_id), undefined, { numeric: true, sensitivity: 'base' })
    if (sort === 'model') return text(a.model).localeCompare(text(b.model), undefined, { numeric: true, sensitivity: 'base' })
    return text(a.title).localeCompare(text(b.title), undefined, { numeric: true, sensitivity: 'base' })
  }
  const multiplier = direction === 'asc' ? 1 : -1
  return [...sessions].sort((a, b) => {
    const result = compare(a, b)
    return result === 0 ? a.id.localeCompare(b.id) : result * multiplier
  })
}

export function relativeWorkspaceTime(value?: string | number, now = Date.now()) {
  if (!value) return ''
  const time = timestamp(value)
  if (!Number.isFinite(time)) return ''
  const minutes = Math.max(0, Math.round((now - time) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(time))
}

export function groupSessionsForSidebar(sessions: PrimeSession[], now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = start - 86_400_000
  const groups = [{ label: 'Today', sessions: [] as PrimeSession[] }, { label: 'Yesterday', sessions: [] as PrimeSession[] }, { label: 'Earlier', sessions: [] as PrimeSession[] }]
  for (const session of sortSessions(sessions, 'recent', 'desc')) {
    const time = timestamp(session.last_active || session.started_at)
    if (time >= start) groups[0].sessions.push(session)
    else if (time >= yesterday) groups[1].sessions.push(session)
    else groups[2].sessions.push(session)
  }
  return groups.filter((group) => group.sessions.length)
}

const PINNED_PROJECTS_KEY = 'archon.pinned-projects.v1'
const EXPANDED_PROJECTS_KEY = 'archon.expanded-projects.v1'
const SIDEBAR_COLLAPSED_KEY = 'archon.sidebar-collapsed.v1'

export function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true' } catch { return false }
}

export function writeSidebarCollapsed(value: boolean) {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value)) } catch { /* unavailable */ }
}

export function readExpandedProjectIds(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_KEY) || '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch { return new Set() }
}

export function writeExpandedProjectIds(value: Set<string>) {
  try { localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(Array.from(value))) } catch { /* unavailable */ }
}
export function readPinnedProjectIds(projects: Project[]): string[] {
  let stored: string[] = []
  try { const value = JSON.parse(localStorage.getItem(PINNED_PROJECTS_KEY) || '[]'); if (Array.isArray(value)) stored = value.filter((id): id is string => typeof id === 'string') } catch { stored = [] }
  const ids = new Set(projects.map((project) => project.id))
  const valid = stored.filter((id) => ids.has(id)).slice(0, 12)
  if (valid.length) return valid
  const preferred = ['prime-agent', 'archon-desktop', 'archon-core']
  const selected = preferred.map((slug) => projects.find((project) => project.slug === slug)?.id).filter((id): id is string => Boolean(id))
  for (const project of sortProjectsByName(projects)) if (selected.length < 3 && !selected.includes(project.id)) selected.push(project.id)
  return selected
}
export function writePinnedProjectIds(ids: string[]) { localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(Array.from(new Set(ids)))) }
