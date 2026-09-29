import { describe, expect, it, vi } from 'vitest'
import type { OperationName } from '../../shared/bridge/types'
import { BackendTransport, OPERATIONS_PAGE_OPERATIONS, type BackendFetch } from './backendTransport'

const localConnection = { serverUrl: 'http://127.0.0.1:8000', token: 'TOKEN_SENTINEL' }
const JOB_ID = 'a1b2c3d4e5f6'
const SOURCE = '/srv/backups/archon-backup-20260901_040000.tar.gz.age'

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const status = {
  hostname: 'archon-vps', system: 'Linux', architecture: 'x86_64', kernel: '6.8.0', uptime_seconds: 60,
  cpu: { percent: 1, cores: 2, load_1: 0, load_5: 0, load_15: 0 },
  memory: { total: 10, used: 5, available: 5, percent: 50 },
  swap: { total: 0, used: 0, percent: 0 },
  disk: { path: '/srv/archon', total: 10, used: 1, free: 9, percent: 10 },
  archon: { cpu_percent: 0, memory_used: 1, memory_percent: 0, processes: 1, accounting: 'process-tree' },
}
const catalog = (model = 'gpt-5.5') => ({
  current: { provider: 'openai-codex', model, base_url_configured: true },
  fallback: null,
  providers: [{ id: 'openai-codex', models: ['gpt-5.5', 'gpt-5.4'] }],
  choices: [{ provider: 'openai-codex', model: 'gpt-5.5' }, { provider: 'openai-codex', model: 'gpt-5.4' }],
})
const skill = { name: 'deploy notes', description: '', category: 'Prime', enabled: true, path: '/srv/skills/deploy/SKILL.md' }
const cronJob = {
  id: JOB_ID, name: 'Brief', enabled: true, state: null, schedule: '0 7 * * *', next_run_at: null, last_run_at: null,
  last_status: null, last_error: null, deliver: 'local', prompt: 'Summarise', skills: [], model: null, provider: null,
  script: null, no_agent: false,
}
const cronResult = { ok: true, output: 'ok', jobs: [cronJob] }

type Case = { operation: OperationName; payload: unknown; result: unknown; method: string; path: string; body?: unknown }

const cases: Case[] = [
  { operation: 'status.get', payload: {}, result: status, method: 'GET', path: '/api/status' },
  { operation: 'logs.list', payload: { limit: 1500 }, result: { logs: [] }, method: 'GET', path: '/api/logs?limit=1500' },
  { operation: 'logs.list', payload: { limit: 20, level: 'WARNING' }, result: { logs: [] }, method: 'GET', path: '/api/logs?limit=20&level=WARNING' },
  { operation: 'models.list', payload: {}, result: catalog(), method: 'GET', path: '/api/models' },
  { operation: 'models.setDefault', payload: { provider: 'openai-codex', model: 'gpt-5.4' }, result: catalog('gpt-5.4'), method: 'PUT', path: '/api/models/default', body: { provider: 'openai-codex', model: 'gpt-5.4' } },
  { operation: 'skills.list', payload: {}, result: { skills: [skill] }, method: 'GET', path: '/api/skills' },
  { operation: 'skills.get', payload: { name: 'deploy notes' }, result: { ...skill, content: '# x' }, method: 'GET', path: '/api/skills/deploy%20notes' },
  { operation: 'skills.toggle', payload: { name: 'deploy notes', enabled: true }, result: skill, method: 'PUT', path: '/api/skills/toggle', body: { name: 'deploy notes', enabled: true } },
  { operation: 'cron.list', payload: {}, result: { jobs: [cronJob] }, method: 'GET', path: '/api/cron' },
  { operation: 'cron.create', payload: { schedule: '0 7 * * *', prompt: 'Summarise', name: 'Brief', deliver: 'local', confirm: true }, result: cronResult, method: 'POST', path: '/api/cron', body: { schedule: '0 7 * * *', prompt: 'Summarise', name: 'Brief', deliver: 'local', confirm: true } },
  { operation: 'cron.update', payload: { jobId: JOB_ID, fields: { name: 'Renamed' }, confirm: true }, result: cronResult, method: 'PUT', path: `/api/cron/${JOB_ID}`, body: { fields: { name: 'Renamed' }, confirm: true } },
  { operation: 'cron.action', payload: { jobId: JOB_ID, action: 'pause', confirm: true }, result: cronResult, method: 'POST', path: `/api/cron/${JOB_ID}/action`, body: { action: 'pause', confirm: true } },
  { operation: 'backups.list', payload: {}, result: { backups: [] }, method: 'GET', path: '/api/backups' },
  { operation: 'backups.create', payload: { confirm: true }, result: { ok: true, output: 'created', backups: [] }, method: 'POST', path: '/api/backups', body: { confirm: true } },
  { operation: 'backups.schedule.get', payload: {}, result: { calendar: null, ActiveState: 'active' }, method: 'GET', path: '/api/backups/schedule' },
  { operation: 'backups.schedule.set', payload: { calendar: '*-*-* 03:00:00', confirm: true }, result: { calendar: '*-*-* 03:00:00', updated: true }, method: 'PUT', path: '/api/backups/schedule', body: { calendar: '*-*-* 03:00:00', confirm: true } },
  { operation: 'backups.inspect', payload: { source: SOURCE }, result: { source: SOURCE, contents: 'a\nb' }, method: 'POST', path: '/api/backups/inspect', body: { source: SOURCE } },
  { operation: 'backups.restore', payload: { source: SOURCE, allFiles: false, paths: ['home/a.txt'], confirm: true }, result: { ok: true, output: 'restored' }, method: 'POST', path: '/api/backups/restore', body: { source: SOURCE, paths: ['home/a.txt'], all_files: false, confirm: true } },
]

const MUTATIONS: readonly OperationName[] = [
  'models.setDefault', 'skills.toggle', 'cron.create', 'cron.update', 'cron.action',
  'backups.create', 'backups.schedule.set', 'backups.restore',
]

describe('operations page transport', () => {
  it('lists every operations page operation in one reviewed group', () => {
    expect(OPERATIONS_PAGE_OPERATIONS).toEqual([
      'status.get', 'logs.list', 'models.list', 'models.setDefault', 'skills.list', 'skills.get', 'skills.toggle',
      'cron.list', 'cron.create', 'cron.update', 'cron.action', 'backups.list', 'backups.create',
      'backups.schedule.get', 'backups.schedule.set', 'backups.inspect', 'backups.restore',
    ])
  })

  it('maps each operation to its fixed method, route and body', async () => {
    for (const item of cases) {
      const fetcher = vi.fn<BackendFetch>(async () => response(item.result))
      const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
      await expect(transport.invoke(item.operation, item.payload as never), item.operation).resolves.toEqual(item.result)
      expect(fetcher).toHaveBeenCalledOnce()
      const [url, init] = fetcher.mock.calls[0]
      expect(url.pathname + url.search, item.operation).toBe(item.path)
      expect(init.method, item.operation).toBe(item.method)
      expect(init.redirect).toBe('manual')
      const headers = new Headers(init.headers)
      expect(headers.get('authorization')).toBe('Bearer TOKEN_SENTINEL')
      expect(headers.get('idempotency-key')).toBeNull()
      if (item.body === undefined) {
        expect(init.body, item.operation).toBeUndefined()
        expect(headers.get('content-type')).toBeNull()
      } else {
        expect(JSON.parse(String(init.body)), item.operation).toEqual(item.body)
        expect(headers.get('content-type')).toBe('application/json')
      }
    }
  })

  it('never retries a mutation after a network failure or server error', async () => {
    for (const item of cases.filter((entry) => MUTATIONS.includes(entry.operation))) {
      const failed = vi.fn<BackendFetch>(async () => { throw new Error('connection lost after request') })
      await expect(new BackendTransport({ ...localConnection, fetch: failed }).invoke(item.operation, item.payload as never))
        .rejects.toMatchObject({ code: 'network_error' })
      expect(failed, item.operation).toHaveBeenCalledOnce()

      const serverError = vi.fn<BackendFetch>(async () => response({ detail: 'Cron command failed: private detail' }, 503))
      const error = await new BackendTransport({ ...localConnection, fetch: serverError }).invoke(item.operation, item.payload as never)
        .catch((reason: unknown) => reason)
      expect(error).toMatchObject({ code: 'http_error' })
      expect(String(error)).not.toContain('private detail')
      expect(serverError, item.operation).toHaveBeenCalledOnce()
    }
  })

  it('rejects hostile payloads before any request', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({}))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    const hostile: [OperationName, unknown][] = [
      ['logs.list', { limit: 10_000 }],
      ['skills.get', { name: '../../api/backups' }],
      ['cron.action', { jobId: `${JOB_ID}/../../x`, action: 'run', confirm: true }],
      ['cron.action', { jobId: JOB_ID, action: 'run', confirm: false }],
      ['cron.create', { schedule: '--help', prompt: 'x', name: '', deliver: 'local', confirm: true }],
      ['backups.create', {}],
      ['backups.restore', { source: '/etc/shadow', allFiles: true, paths: [], confirm: true }],
      ['backups.restore', { source: SOURCE, allFiles: false, paths: ['-rf'], confirm: true }],
      ['backups.schedule.set', { calendar: 'x\n[Service]', confirm: true }],
    ]
    for (const [operation, payload] of hostile) {
      await expect(transport.invoke(operation, payload as never), operation).rejects.toMatchObject({ code: 'invalid_payload' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses results that do not confirm the requested state or exceed the requested bounds', async () => {
    const invalid: [OperationName, unknown, unknown][] = [
      ['logs.list', { limit: 1 }, { logs: [
        { id: '1', timestamp: '', level: 'INFO', source: 'prime', component: 'task', message: 'a' },
        { id: '2', timestamp: '', level: 'INFO', source: 'prime', component: 'task', message: 'b' },
      ] }],
      ['models.setDefault', { provider: 'openai-codex', model: 'gpt-5.4' }, catalog('gpt-5.5')],
      ['skills.get', { name: 'other' }, { ...skill, content: 'x' }],
      ['skills.toggle', { name: 'deploy notes', enabled: false }, skill],
      ['backups.schedule.set', { calendar: '*-*-* 03:00:00', confirm: true }, { calendar: '*-*-* 04:00:00', updated: true }],
      ['status.get', {}, { ...status, apiKey: 'x' }],
      ['cron.list', {}, { jobs: [{ ...cronJob, token: 'x' }] }],
    ]
    for (const [operation, payload, result] of invalid) {
      const transport = new BackendTransport({ ...localConnection, fetch: vi.fn(async () => response(result)) })
      await expect(transport.invoke(operation, payload as never), operation).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })

  it('reports rejected access and missing records with stable codes', async () => {
    const forbidden = new BackendTransport({ ...localConnection, fetch: vi.fn(async () => response({ detail: 'Explicit confirmation is required' }, 403)) })
    await expect(forbidden.invoke('backups.create', { confirm: true })).rejects.toMatchObject({ code: 'unauthorized' })
    const missing = new BackendTransport({ ...localConnection, fetch: vi.fn(async () => response({ detail: "'x'" }, 404)) })
    await expect(missing.invoke('skills.get', { name: 'x' })).rejects.toMatchObject({ code: 'http_error' })
  })
})
