import { NAV_ITEMS } from './navigation'

it('exposes every requested Archon control surface', () => {
  expect(NAV_ITEMS.map((item) => item.id)).toEqual([
    'home', 'chat', 'projects', 'project', 'sessions', 'tasks', 'logs', 'models', 'skills', 'files', 'terminal', 'backups', 'cron', 'status', 'settings'
  ])
})
