export type PageId =
  | 'home' | 'chat' | 'projects' | 'project' | 'sessions' | 'tasks' | 'logs'
  | 'models' | 'skills' | 'files' | 'terminal' | 'backups' | 'cron' | 'status' | 'settings'

export const NAV_ITEMS: ReadonlyArray<{ id: PageId; label: string; group: string }> = [
  { id: 'home', label: 'New session', group: 'hidden' },
  { id: 'chat', label: 'Chat', group: 'work' },
  { id: 'projects', label: 'Projects', group: 'work' },
  { id: 'project', label: 'Project', group: 'hidden' },
  { id: 'sessions', label: 'Sessions', group: 'work' },
  { id: 'tasks', label: 'Tasks', group: 'work' },
  { id: 'logs', label: 'Logs', group: 'library' },
  { id: 'models', label: 'Models', group: 'settings' },
  { id: 'skills', label: 'Skills', group: 'library' },
  { id: 'files', label: 'Files', group: 'system' },
  { id: 'terminal', label: 'Terminal', group: 'system' },
  { id: 'backups', label: 'Backups', group: 'library' },
  { id: 'cron', label: 'Automations', group: 'library' },
  { id: 'status', label: 'VPS', group: 'system' },
  { id: 'settings', label: 'Settings', group: 'footer' },
]
