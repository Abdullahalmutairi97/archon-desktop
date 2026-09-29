import { LiveUnavailable } from '../live/LiveViews'
import type { LiveServer } from '../live/useLiveServer'
import type { IconName } from '../shell/Icon'
import { BackupsPage } from './BackupsPage'
import { CronPage } from './CronPage'
import { LogsPage } from './LogsPage'
import { ModelsPage } from './ModelsPage'
import { SkillsPage } from './SkillsPage'
import { StatusPage } from './StatusPage'

export type OperationsView = 'ops-status' | 'ops-logs' | 'ops-models' | 'ops-skills' | 'ops-cron' | 'ops-backups'

export const OPERATIONS_ITEMS: readonly { id: OperationsView; label: string; icon: IconName; subject: string }[] = [
  { id: 'ops-status', label: 'Status', icon: 'activity', subject: 'status figures' },
  { id: 'ops-logs', label: 'Logs', icon: 'terminal', subject: 'log lines' },
  { id: 'ops-models', label: 'Models', icon: 'code', subject: 'models' },
  { id: 'ops-skills', label: 'Skills', icon: 'file', subject: 'skills' },
  { id: 'ops-cron', label: 'Cron', icon: 'history', subject: 'cron jobs' },
  { id: 'ops-backups', label: 'Backups', icon: 'folder', subject: 'backups' },
]

export function isOperationsView(view: string): view is OperationsView {
  return OPERATIONS_ITEMS.some((item) => item.id === view)
}

export function operationsTitle(view: OperationsView): string {
  return OPERATIONS_ITEMS.find((item) => item.id === view)?.label ?? 'Operations'
}

/** One operations page for the live connection; it remounts, dropping all state, when the generation changes. */
export function OperationsPageView({ view, server, onOpenConnection }: { view: OperationsView; server: LiveServer; onOpenConnection(): void }) {
  const scope = server.scope
  const item = OPERATIONS_ITEMS.find((entry) => entry.id === view) ?? OPERATIONS_ITEMS[0]
  if (!scope || server.status === 'rejected' || server.status === 'checking') {
    return <section className="collection-view" aria-label={`Server ${item.label.toLowerCase()}`}>
      <LiveUnavailable status={server.status} subject={item.subject} onOpenConnection={onOpenConnection} onRetry={server.refresh} />
    </section>
  }
  const key = `${view}:${scope.generation}`
  switch (view) {
    case 'ops-status': return <StatusPage key={key} scope={scope} />
    case 'ops-logs': return <LogsPage key={key} scope={scope} />
    case 'ops-models': return <ModelsPage key={key} scope={scope} />
    case 'ops-skills': return <SkillsPage key={key} scope={scope} />
    case 'ops-cron': return <CronPage key={key} scope={scope} />
    case 'ops-backups': return <BackupsPage key={key} scope={scope} />
  }
}
