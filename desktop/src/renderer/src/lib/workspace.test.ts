import { describe, expect, it } from 'vitest'
import {
  groupSessionsForSidebar, readExpandedProjectIds, readSidebarCollapsed, SIDEBAR_NAV,
  sortProjectsByName, sortSessions, TITLEBAR_BENCH, writeExpandedProjectIds, writeSidebarCollapsed,
} from './workspace'
import type { PrimeSession, Project } from './types'

function session(id: string, lastActive: string): PrimeSession {
  return { id, source: 'desktop', title: id, model: 'test', cwd: '/tmp', started_at: lastActive, last_active: lastActive, message_count: 1, active: false, preview: id }
}

describe('Archon v2 workspace contract', () => {
  beforeEach(() => localStorage.clear())
  it('groups sidebar sessions into Today, Yesterday, and Earlier without dropping rows', () => {
    const now = new Date('2026-07-25T12:00:00Z')
    const groups = groupSessionsForSidebar([
      session('today', '2026-07-25T08:00:00Z'),
      session('yesterday', '2026-07-24T08:00:00Z'),
      session('earlier', '2026-07-20T08:00:00Z'),
    ], now)

    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', 'Earlier'])
    expect(groups.flatMap((group) => group.sessions.map((item) => item.id))).toEqual(['today', 'yesterday', 'earlier'])
  })

  it('keeps the supplied v2 sidebar and titlebar destinations while exposing missing live surfaces', () => {
    expect(SIDEBAR_NAV.map((item) => item.id)).toEqual(['chat', 'sessions', 'tasks', 'skills', 'cron', 'backups', 'logs'])
    expect(TITLEBAR_BENCH.map((item) => item.id)).toEqual(['tasks', 'files', 'terminal', 'browser'])
  })

  it('sorts projects A to Z and supports all supplied session columns in both directions', () => {
    const projects = [
      { id: 'z', slug: 'zulu', name: 'Zulu', description: '', icon: '', color: '', primary_path: '/z', folders: [] },
      { id: 'a', slug: 'alpha', name: 'Alpha', description: '', icon: '', color: '', primary_path: '/a', folders: [] },
    ] as Project[]
    expect(sortProjectsByName(projects).map((item) => item.name)).toEqual(['Alpha', 'Zulu'])

    const older = { ...session('older', '2026-07-23T09:00:00Z'), title: 'Zulu', project_id: 'a', model: 'm-model', message_count: 10 }
    const newer = { ...session('newer', '2026-07-24T09:00:00Z'), title: 'Beta', project_id: 'z', model: 'z-model', message_count: 20 }
    const titled = { ...session('titled', '2026-07-22T09:00:00Z'), title: 'Alpha', project_id: 'a', model: 'a-model', message_count: 2 }

    expect(sortSessions([older, newer, titled], 'recent', 'desc').map((item) => item.id)).toEqual(['newer', 'older', 'titled'])
    expect(sortSessions([older, newer, titled], 'recent', 'asc').map((item) => item.id)).toEqual(['titled', 'older', 'newer'])
    expect(sortSessions([older, newer, titled], 'title', 'asc').map((item) => item.id)).toEqual(['titled', 'newer', 'older'])
    expect(sortSessions([older, newer, titled], 'project', 'asc').map((item) => item.id)).toEqual(['older', 'titled', 'newer'])
    expect(sortSessions([older, newer, titled], 'model', 'asc').map((item) => item.id)).toEqual(['titled', 'older', 'newer'])
    expect(sortSessions([older, newer, titled], 'messages', 'desc').map((item) => item.id)).toEqual(['newer', 'older', 'titled'])
  })

  it('persists the fully-collapsed sidebar and each project expansion independently', () => {
    expect(readSidebarCollapsed()).toBe(false)
    writeSidebarCollapsed(true)
    expect(readSidebarCollapsed()).toBe(true)

    writeExpandedProjectIds(new Set(['alpha', 'beta']))
    expect(readExpandedProjectIds()).toEqual(new Set(['alpha', 'beta']))
    writeExpandedProjectIds(new Set(['beta']))
    expect(readExpandedProjectIds()).toEqual(new Set(['beta']))
  })
})
