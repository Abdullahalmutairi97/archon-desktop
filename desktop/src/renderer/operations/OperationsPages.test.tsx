import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionDescription, DesktopBridge } from '../../shared/bridge/types'
import { App } from '../shell/App'
import type { LiveServer, LiveStatus } from '../live/useLiveServer'
import { OperationsPageView, type OperationsView } from './OperationsView'

afterEach(() => {
  cleanup()
  localStorage.clear()
  Reflect.deleteProperty(window, 'archon')
})

const JOB_ID = 'a1b2c3d4e5f6'
const SOURCE = '/srv/backups/archon-backup-20260901_040000.tar.gz.age'

const status = (hostname = 'archon-vps') => ({
  hostname, system: 'Linux', architecture: 'x86_64', kernel: '6.8.0', uptime_seconds: 93_784,
  cpu: { percent: 12.5, cores: 4, load_1: 0.42, load_5: 0.3, load_15: 0.2 },
  memory: { total: 8 * 1024 ** 3, used: 3 * 1024 ** 3, available: 5 * 1024 ** 3, percent: 37.5 },
  swap: { total: 0, used: 0, percent: 0 },
  disk: { path: '/srv/archon', total: 100 * 1024 ** 3, used: 40 * 1024 ** 3, free: 60 * 1024 ** 3, percent: 40 },
  archon: { cpu_percent: 1.2, memory_used: 200 * 1024 ** 2, memory_percent: 2.5, processes: 7, accounting: 'systemd-cgroup' },
})
const catalog = (model = 'gpt-5.5') => ({
  current: { provider: 'openai-codex', model, base_url_configured: true },
  fallback: null,
  providers: [{ id: 'openai-codex', models: ['gpt-5.5', 'gpt-5.4-mini'] }],
  choices: [],
})
const skill = { name: 'deploy-notes', description: 'Writes deploy notes.', category: 'Prime', enabled: true, path: '/srv/skills/deploy-notes/SKILL.md' }
const cronJob = {
  id: JOB_ID, name: 'Morning brief', enabled: true, state: 'scheduled', schedule: '0 7 * * *',
  next_run_at: null, last_run_at: null, last_status: 'ok', last_error: null, deliver: 'local',
  prompt: 'Summarise overnight work.', skills: [], model: null, provider: null, script: null, no_agent: false,
}
const backup = {
  id: '20260901_040000', created_at: '2026-09-01T04:00:00+00:00', plain_path: null, encrypted_path: SOURCE,
  plain_size: null, encrypted_size: 2048, encrypted: true,
}

type Handler = (operation: string, payload: Record<string, unknown>) => unknown

function defaults(operation: string): unknown {
  switch (operation) {
    case 'projects.list': return { projects: [] }
    case 'sessions.list': return { sessions: [] }
    case 'status.get': return status()
    case 'logs.list': return { logs: [] }
    case 'models.list': return catalog()
    case 'skills.list': return { skills: [skill] }
    case 'cron.list': return { jobs: [cronJob] }
    case 'backups.list': return { backups: [backup] }
    case 'backups.schedule.get': return { calendar: '*-*-* 04:00:00', ActiveState: 'active', NextElapseUSecRealtime: 'Wed 2026-09-30 04:00:00 UTC' }
    default: throw new Error(`Unexpected operation: ${operation}`)
  }
}

function makeBridge(handler: Handler = (operation) => defaults(operation)) {
  const invoke = vi.fn((operation: string, payload: Record<string, unknown>) => Promise.resolve().then(() => handler(operation, payload)))
  const connected: ConnectionDescription = { serverUrl: 'https://archon.example', configured: true, storageMode: 'memory', generation: 4 }
  const bridge = {
    connection: { describe: vi.fn(async () => connected) },
    api: { invoke },
    localCodex: { listProjects: vi.fn(async () => []), subscribe: vi.fn(() => () => undefined) },
  } as unknown as DesktopBridge
  return { bridge, invoke }
}

function serverFor(bridge: DesktopBridge | null, generation = 4, status: LiveStatus = 'ready'): LiveServer {
  return {
    status,
    scope: bridge ? { bridge, generation, serverUrl: 'https://archon.example', localPairingAvailable: false } : null,
    projects: [],
    sessions: [],
    refreshing: false,
    refresh: vi.fn(),
  }
}

function renderPage(view: OperationsView, bridge: DesktopBridge) {
  return render(<OperationsPageView view={view} server={serverFor(bridge)} onOpenConnection={vi.fn()} />)
}

function rejection(code: string) {
  return Object.assign(new Error('failed'), { code })
}

function callsTo(invoke: ReturnType<typeof makeBridge>['invoke'], operation: string) {
  return invoke.mock.calls.filter(([name]) => name === operation)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('operations navigation', () => {
  it('adds an OPERATIONS group to the live sidebar that opens each page', async () => {
    const { bridge } = makeBridge()
    Object.defineProperty(window, 'archon', { value: bridge, configurable: true })
    render(<App />)
    const nav = within(await screen.findByRole('navigation', { name: 'Operations' }))
    expect(nav.getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['Status', 'Logs', 'Models', 'Skills', 'Cron', 'Backups'])
    fireEvent.click(nav.getByRole('button', { name: 'Status' }))
    expect(await screen.findByText('archon-vps')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Status' })).toBeInTheDocument()
    expect(screen.getAllByText('SERVER OPERATIONS').length).toBeGreaterThan(0)
    fireEvent.click(nav.getByRole('button', { name: 'Cron' }))
    expect(await screen.findByText('Morning brief')).toBeInTheDocument()
  })

  it('shows the honest disconnected state and makes no operation call', () => {
    const openConnection = vi.fn()
    render(<OperationsPageView view="ops-backups" server={serverFor(null, 0, 'disconnected')} onOpenConnection={openConnection} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Not connected')
    fireEvent.click(screen.getByRole('button', { name: 'Open Connection' }))
    expect(openConnection).toHaveBeenCalledOnce()
  })
})

describe('status page', () => {
  it('renders the server snapshot', async () => {
    const { bridge, invoke } = makeBridge()
    renderPage('ops-status', bridge)
    expect(await screen.findByText('archon-vps')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '12.5')
    expect(screen.getByText('3.0 GB of 8.0 GB')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('status.get', {})
  })

  it('shows a failure honestly with no figures', async () => {
    const { bridge } = makeBridge(() => { throw rejection('network_error') })
    renderPage('ops-status', bridge)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the configured server.')
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('ignores a response that arrives after the connection generation changed', async () => {
    const slow = deferred<unknown>()
    const { bridge: oldBridge } = makeBridge(() => slow.promise)
    const { bridge: newBridge } = makeBridge((operation) => operation === 'status.get' ? status('new-host') : defaults(operation))
    const view = render(<OperationsPageView view="ops-status" server={serverFor(oldBridge, 4)} onOpenConnection={vi.fn()} />)
    view.rerender(<OperationsPageView view="ops-status" server={serverFor(newBridge, 5)} onOpenConnection={vi.fn()} />)
    expect(await screen.findByText('new-host')).toBeInTheDocument()
    await act(async () => { slow.resolve(status('stale-host')) })
    expect(screen.queryByText('stale-host')).not.toBeInTheDocument()
    expect(screen.getByText('new-host')).toBeInTheDocument()
  })
})

describe('logs page', () => {
  it('shows log lines as plain text and filters errors', async () => {
    const { bridge, invoke } = makeBridge((operation) => operation === 'logs.list' ? { logs: [
      { id: '1', timestamp: '2026-09-29T08:00:00', level: 'INFO', source: 'prime', component: 'task', message: '<b>task.started</b>' },
      { id: '2', timestamp: '2026-09-29T08:01:00', level: 'ERROR', source: 'prime', component: 'task', message: 'task.failed' },
    ] } : defaults(operation))
    renderPage('ops-logs', bridge)
    const log = await screen.findByRole('log', { name: 'Log lines' })
    expect(within(log).getByText('<b>task.started</b>')).toHaveAttribute('dir', 'auto')
    expect(log.querySelector('b')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('logs.list', { limit: 1500 })
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }))
    expect(within(log).queryByText('<b>task.started</b>')).not.toBeInTheDocument()
    expect(within(log).getByText('task.failed')).toBeInTheDocument()
  })
})

describe('models page', () => {
  it('sets the chosen default model once and shows the committed default', async () => {
    const { bridge, invoke } = makeBridge((operation, payload) =>
      operation === 'models.setDefault' ? catalog(payload.model as string) : defaults(operation))
    renderPage('ops-models', bridge)
    const save = await screen.findByRole('button', { name: 'Use as default' })
    expect(save).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'gpt-5.4-mini' }))
    fireEvent.click(save)
    expect(await screen.findByText('The profile default is now gpt-5.4-mini.')).toBeInTheDocument()
    expect(callsTo(invoke, 'models.setDefault')).toEqual([['models.setDefault', { provider: 'openai-codex', model: 'gpt-5.4-mini' }]])
  })
})

describe('skills page', () => {
  it('reads SKILL.md in a dialog and reports a refused toggle honestly', async () => {
    const { bridge, invoke } = makeBridge((operation) => {
      if (operation === 'skills.get') return { ...skill, content: '# Deploy notes\nUse <script>.' }
      if (operation === 'skills.toggle') throw rejection('http_error')
      return defaults(operation)
    })
    renderPage('ops-skills', bridge)
    fireEvent.click(await screen.findByRole('button', { name: 'Read deploy-notes' }))
    const dialog = await screen.findByRole('dialog', { name: 'deploy-notes' })
    expect(dialog).toHaveTextContent('Use <script>.')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Disable deploy-notes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('deploy-notes: The server could not complete the request.')
    expect(screen.getByRole('switch', { name: 'Disable deploy-notes' })).toHaveAttribute('aria-checked', 'true')
    expect(callsTo(invoke, 'skills.toggle')).toEqual([['skills.toggle', { name: 'deploy-notes', enabled: false }]])
  })
})

describe('cron page', () => {
  it('gates every action behind a confirmation dialog that focuses Cancel and closes on Escape', async () => {
    const { bridge, invoke } = makeBridge((operation) =>
      operation === 'cron.action' ? { ok: true, output: 'Job paused', jobs: [{ ...cronJob, enabled: false }] } : defaults(operation))
    renderPage('ops-cron', bridge)
    for (const name of ['Run Morning brief now', 'Remove Morning brief', 'Pause Morning brief']) {
      fireEvent.click(await screen.findByRole('button', { name }))
      const dialog = screen.getByRole('dialog', { name: 'Confirm scheduler change' })
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    }
    expect(callsTo(invoke, 'cron.action')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Pause Morning brief' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause' }))
    expect(await screen.findByText('Job paused')).toBeInTheDocument()
    expect(callsTo(invoke, 'cron.action')).toEqual([['cron.action', { jobId: JOB_ID, action: 'pause', confirm: true }]])
    expect(screen.getByRole('button', { name: 'Resume Morning brief' })).toBeInTheDocument()
  })

  it('creates and edits jobs only after confirmation, sending only changed fields', async () => {
    const { bridge, invoke } = makeBridge((operation) =>
      operation === 'cron.create' || operation === 'cron.update' ? { ok: true, output: '', jobs: [cronJob] } : defaults(operation))
    renderPage('ops-cron', bridge)
    const form = await screen.findByRole('form', { name: 'Create scheduled job' })
    fireEvent.change(within(form).getByLabelText('Schedule'), { target: { value: '0 9 * * 1' } })
    fireEvent.change(within(form).getByLabelText('Prompt'), { target: { value: 'Weekly review' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Review new job' }))
    expect(callsTo(invoke, 'cron.create')).toHaveLength(0)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create job' }))
    await waitFor(() => expect(callsTo(invoke, 'cron.create')).toEqual([['cron.create', {
      name: '', schedule: '0 9 * * 1', deliver: 'local', prompt: 'Weekly review', confirm: true,
    }]]))

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Morning brief' }))
    const editForm = screen.getByRole('form', { name: 'Edit scheduled job' })
    fireEvent.change(within(editForm).getByLabelText('Name'), { target: { value: 'Morning summary' } })
    fireEvent.click(within(editForm).getByRole('button', { name: 'Review changes' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(callsTo(invoke, 'cron.update')).toEqual([['cron.update', {
      jobId: JOB_ID, fields: { name: 'Morning summary' }, confirm: true,
    }]]))
  })

  it('reports a failed change as possibly applied rather than retrying it', async () => {
    const { bridge, invoke } = makeBridge((operation) => {
      if (operation === 'cron.action') throw rejection('network_error')
      return defaults(operation)
    })
    renderPage('ops-cron', bridge)
    fireEvent.click(await screen.findByRole('button', { name: 'Run Morning brief now' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('the server may have applied the change')
    expect(callsTo(invoke, 'cron.action')).toHaveLength(1)
  })
})

describe('backups page', () => {
  it('creates a backup only after confirmation', async () => {
    const { bridge, invoke } = makeBridge((operation) =>
      operation === 'backups.create' ? { ok: true, output: 'backup written', backups: [backup] } : defaults(operation))
    renderPage('ops-backups', bridge)
    fireEvent.click(await screen.findByRole('button', { name: 'Create backup now' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(callsTo(invoke, 'backups.create')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Create backup now' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create backup' }))
    expect(await screen.findByText('backup written')).toBeInTheDocument()
    expect(callsTo(invoke, 'backups.create')).toEqual([['backups.create', { confirm: true }]])
  })

  it('inspects an archive and restores only after the backup name is typed', async () => {
    const { bridge, invoke } = makeBridge((operation) => {
      if (operation === 'backups.inspect') return { source: SOURCE, contents: 'home/archon/config.yaml\n' }
      if (operation === 'backups.restore') return { ok: true, output: 'restored 1 file' }
      return defaults(operation)
    })
    renderPage('ops-backups', bridge)
    fireEvent.click(await screen.findByRole('button', { name: /20260901_040000/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(await screen.findByLabelText('Archive contents')).toHaveTextContent('home/archon/config.yaml')
    expect(callsTo(invoke, 'backups.inspect')).toEqual([['backups.inspect', { source: SOURCE }]])

    fireEvent.click(screen.getByRole('button', { name: 'Restore…' }))
    const dialog = screen.getByRole('dialog', { name: 'Restore backup 20260901_040000' })
    const confirm = within(dialog).getByRole('button', { name: 'Restore backup' })
    expect(confirm).toBeDisabled()
    fireEvent.click(within(dialog).getByLabelText(/Restore selected paths only/))
    fireEvent.change(within(dialog).getByLabelText('Archive paths, one per line'), { target: { value: 'home/archon/config.yaml\n' } })
    fireEvent.change(within(dialog).getByLabelText('Type the backup name to confirm'), { target: { value: 'RESTORE' } })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(callsTo(invoke, 'backups.restore')).toHaveLength(0)
    fireEvent.change(within(dialog).getByLabelText('Type the backup name to confirm'), { target: { value: '20260901_040000' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(await screen.findByText('restored 1 file')).toBeInTheDocument()
    expect(callsTo(invoke, 'backups.restore')).toEqual([['backups.restore', {
      source: SOURCE, allFiles: false, paths: ['home/archon/config.yaml'], confirm: true,
    }]])
  })

  it('confirms a schedule change before sending it', async () => {
    const { bridge, invoke } = makeBridge((operation, payload) =>
      operation === 'backups.schedule.set' ? { calendar: payload.calendar, updated: true } : defaults(operation))
    renderPage('ops-backups', bridge)
    const input = await screen.findByLabelText('systemd calendar expression')
    await waitFor(() => expect(input).toHaveValue('*-*-* 04:00:00'))
    fireEvent.change(input, { target: { value: '*-*-* 03:30:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update schedule' }))
    expect(callsTo(invoke, 'backups.schedule.set')).toHaveLength(0)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Update schedule' }))
    expect(await screen.findByText('The backup timer schedule is now *-*-* 03:30:00.')).toBeInTheDocument()
    expect(callsTo(invoke, 'backups.schedule.set')).toEqual([['backups.schedule.set', { calendar: '*-*-* 03:30:00', confirm: true }]])
  })
})
