import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS, parseBridgeRequest, parseBridgeResponse, parseOperationRequest } from './validation'

const JOB_ID = 'a1b2c3d4e5f6'
const SOURCE = '/srv/backups/archon-backup-20260901_040000.tar.gz.age'

const statusFixture = {
  hostname: 'archon-vps', system: 'Linux', architecture: 'x86_64', kernel: '6.8.0', uptime_seconds: 93_784,
  cpu: { percent: 12.5, cores: 4, load_1: 0.42, load_5: 0.3, load_15: 0.2 },
  memory: { total: 8_000_000_000, used: 3_000_000_000, available: 5_000_000_000, percent: 37.5 },
  swap: { total: 2_000_000_000, used: 0, percent: 0 },
  disk: { path: '/srv/archon', total: 100_000_000_000, used: 40_000_000_000, free: 60_000_000_000, percent: 40 },
  archon: { cpu_percent: 1.2, memory_used: 200_000_000, memory_percent: 2.5, processes: 7, accounting: 'systemd-cgroup' },
}

const catalog = {
  current: { provider: 'openai-codex', model: 'gpt-5.5', base_url_configured: true },
  fallback: null,
  providers: [{ id: 'openai-codex', models: ['gpt-5.5', 'gpt-5.4-mini'] }],
  choices: [{ provider: 'openai-codex', model: 'gpt-5.5' }, { provider: 'openai-codex', model: 'gpt-5.4-mini' }],
}

const skill = { name: 'deploy-notes', description: 'Writes deploy notes.', category: 'Prime', enabled: true, path: '/srv/prime/skills/deploy-notes/SKILL.md' }

const cronJob = {
  id: JOB_ID, name: 'Morning brief', enabled: true, state: 'scheduled', schedule: '0 7 * * *',
  next_run_at: '2026-09-30T07:00:00+00:00', last_run_at: null, last_status: 'ok', last_error: null,
  deliver: 'local', prompt: 'Summarise overnight work.\nKeep it short.', skills: ['notes'], model: null,
  provider: null, script: null, no_agent: false,
}

const backup = {
  id: '20260901_040000', created_at: '2026-09-01T04:00:00+00:00',
  plain_path: '/srv/backups/archon-backup-20260901_040000.tar.gz', encrypted_path: SOURCE,
  plain_size: 1024, encrypted_size: 1100, encrypted: true,
}

function response(operation: string, value: unknown): unknown {
  return parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, value, operation)
}

describe('operations page bridge requests', () => {
  it('accepts bounded payloads and returns frozen canonical copies', () => {
    const accepted: [string, unknown][] = [
      ['status.get', {}],
      ['logs.list', { limit: 1500 }],
      ['logs.list', { limit: 1, level: 'ERROR' }],
      ['models.list', {}],
      ['models.setDefault', { provider: 'openai-codex', model: 'gpt-5.6-terra' }],
      ['skills.list', {}],
      ['skills.get', { name: 'deploy-notes' }],
      ['skills.toggle', { name: 'deploy-notes', enabled: false }],
      ['cron.list', {}],
      ['cron.create', { schedule: '0 7 * * *', prompt: 'Summarise.\nShort.', name: '', deliver: 'telegram:123', confirm: true }],
      ['cron.update', { jobId: JOB_ID, fields: { schedule: 'every 2h' }, confirm: true }],
      ['cron.action', { jobId: JOB_ID, action: 'remove', confirm: true }],
      ['backups.list', {}],
      ['backups.create', { confirm: true }],
      ['backups.schedule.get', {}],
      ['backups.schedule.set', { calendar: '*-*-* 04:00:00', confirm: true }],
      ['backups.inspect', { source: SOURCE }],
      ['backups.restore', { source: SOURCE, allFiles: true, paths: [], confirm: true }],
      ['backups.restore', { source: SOURCE, allFiles: false, paths: ['home/archon/.prime/config.yaml'], confirm: true }],
    ]
    for (const [operation, payload] of accepted) {
      const [name, parsed] = parseOperationRequest(operation, payload)
      expect(name).toBe(operation)
      expect(parsed).toEqual(payload)
      expect(parsed).not.toBe(payload)
      expect(Object.isFrozen(parsed)).toBe(true)
    }
    expect(parseBridgeRequest(BRIDGE_CHANNELS.apiInvoke, ['cron.action', { jobId: JOB_ID, action: 'run', confirm: true }]).args)
      .toEqual(['cron.action', { jobId: JOB_ID, action: 'run', confirm: true }])
  })

  it('rejects hostile, unconfirmed, option-shaped and unbounded payloads', () => {
    const rejected: [string, unknown][] = [
      ['status.get', { verbose: true }],
      ['logs.list', {}],
      ['logs.list', { limit: 0 }],
      ['logs.list', { limit: 2_001 }],
      ['logs.list', { limit: 1.5 }],
      ['logs.list', { limit: 10, level: 'TRACE' }],
      ['logs.list', { limit: 10, sources: 'agent' }],
      ['models.setDefault', { provider: 'openai-codex' }],
      ['models.setDefault', { provider: 'openai codex', model: 'gpt-5.5' }],
      ['models.setDefault', { provider: 'openai-codex', model: '../gpt' + 'x'.repeat(300) }],
      ['skills.get', { name: '' }],
      ['skills.get', { name: '../secrets' }],
      ['skills.get', { name: 'a/b' }],
      ['skills.get', { name: '..' }],
      ['skills.get', { name: 'bad\nname' }],
      ['skills.toggle', { name: 'deploy-notes', enabled: 'false' }],
      ['cron.create', { schedule: '0 7 * * *', prompt: 'x', name: '', deliver: 'local' }],
      ['cron.create', { schedule: '0 7 * * *', prompt: 'x', name: '', deliver: 'local', confirm: 'true' }],
      ['cron.create', { schedule: '--help', prompt: 'x', name: '', deliver: 'local', confirm: true }],
      ['cron.create', { schedule: '0 7 * * *\n', prompt: 'x', name: '', deliver: 'local', confirm: true }],
      ['cron.create', { schedule: '0 7 * * *', prompt: '--delete-all', name: '', deliver: 'local', confirm: true }],
      ['cron.create', { schedule: '0 7 * * *', prompt: '   ', name: '', deliver: 'local', confirm: true }],
      ['cron.create', { schedule: '0 7 * * *', prompt: 'x'.repeat(8_001), name: '', deliver: 'local', confirm: true }],
      ['cron.create', { schedule: '0 7 * * *', prompt: 'x', name: '-n', deliver: 'local', confirm: true }],
      ['cron.create', { schedule: '0 7 * * *', prompt: 'x', name: '', deliver: '--x', confirm: true }],
      ['cron.create', { schedule: 'x'.repeat(121), prompt: 'x', name: '', deliver: 'local', confirm: true }],
      ['cron.update', { jobId: JOB_ID, fields: {}, confirm: true }],
      ['cron.update', { jobId: JOB_ID, fields: { enabled: true }, confirm: true }],
      ['cron.update', { jobId: '../../x', fields: { name: 'x' }, confirm: true }],
      ['cron.update', { jobId: JOB_ID, fields: { name: 'x' }, confirm: false }],
      ['cron.action', { jobId: JOB_ID, action: 'delete', confirm: true }],
      ['cron.action', { jobId: JOB_ID.toUpperCase(), action: 'run', confirm: true }],
      ['cron.action', { jobId: JOB_ID, action: 'run' }],
      ['backups.create', {}],
      ['backups.create', { confirm: 1 }],
      ['backups.schedule.set', { calendar: 'daily\nOnCalendar=*', confirm: true }],
      ['backups.schedule.set', { calendar: '*-*-* 04:00:00; rm', confirm: true }],
      ['backups.schedule.set', { calendar: '*-*-* 04:00:00' }],
      ['backups.inspect', { source: '/etc/passwd' }],
      ['backups.inspect', { source: '/srv/backups/../etc/archon-backup-20260901_040000.tar.gz' }],
      ['backups.inspect', { source: 'archon-backup-20260901_040000.tar.gz' }],
      ['backups.restore', { source: SOURCE, allFiles: true, paths: ['etc'], confirm: true }],
      ['backups.restore', { source: SOURCE, allFiles: false, paths: [], confirm: true }],
      ['backups.restore', { source: SOURCE, allFiles: false, paths: ['--all'], confirm: true }],
      ['backups.restore', { source: SOURCE, allFiles: false, paths: ['home/../../etc'], confirm: true }],
      ['backups.restore', { source: SOURCE, allFiles: false, paths: ['a', 'a'], confirm: true }],
      ['backups.restore', { source: SOURCE, allFiles: false, paths: Array.from({ length: 201 }, (_, i) => `p${i}`), confirm: true }],
      ['backups.restore', { source: SOURCE, allFiles: true, paths: [] }],
      ['backups.restore', { source: SOURCE, allFiles: true, paths: [], confirm: true, extra: 1 }],
    ]
    for (const [operation, payload] of rejected) {
      expect(() => parseOperationRequest(operation, payload), `${operation} ${JSON.stringify(payload).slice(0, 80)}`).toThrow(TypeError)
    }
  })
})

describe('operations page bridge responses', () => {
  it('accepts exact server shapes', () => {
    expect(response('status.get', statusFixture)).toEqual(statusFixture)
    expect(response('logs.list', { logs: [{ id: '17', timestamp: '2026-09-29T08:00:00Z', level: 'INFO', source: 'prime', component: 'task', message: 'task.completed' }] }))
      .toEqual({ logs: [{ id: '17', timestamp: '2026-09-29T08:00:00Z', level: 'INFO', source: 'prime', component: 'task', message: 'task.completed' }] })
    expect(response('models.list', catalog)).toEqual(catalog)
    expect(response('models.setDefault', catalog)).toEqual(catalog)
    expect(response('models.list', { current: { provider: null, model: null, base_url_configured: false }, fallback: null, providers: [], choices: [] }))
      .toMatchObject({ providers: [] })
    expect(response('skills.list', { skills: [skill] })).toEqual({ skills: [skill] })
    expect(response('skills.get', { ...skill, content: '# Deploy notes\n' })).toEqual({ ...skill, content: '# Deploy notes\n' })
    expect(response('skills.toggle', skill)).toEqual(skill)
    expect(response('cron.list', { jobs: [cronJob] })).toEqual({ jobs: [cronJob] })
    expect(response('cron.action', { ok: true, output: 'Paused.', jobs: [cronJob] })).toEqual({ ok: true, output: 'Paused.', jobs: [cronJob] })
    expect(response('backups.list', { backups: [backup, { ...backup, id: '20260801_040000', encrypted_path: null, encrypted_size: null, encrypted: false }] }))
      .toMatchObject({ backups: [{ id: backup.id }, { id: '20260801_040000', encrypted: false }] })
    expect(response('backups.create', { ok: true, output: 'done', backups: [backup] })).toEqual({ ok: true, output: 'done', backups: [backup] })
    expect(response('backups.schedule.get', { calendar: null })).toEqual({ calendar: null })
    const schedule = { calendar: '*-*-* 04:00:00', ActiveState: 'active', UnitFileState: 'enabled', NextElapseUSecRealtime: 'Wed 2026-09-30 04:00:00 UTC', LastTriggerUSec: 'n/a' }
    expect(response('backups.schedule.get', schedule)).toEqual(schedule)
    expect(response('backups.schedule.set', { calendar: '*-*-* 04:00:00', updated: true })).toEqual({ calendar: '*-*-* 04:00:00', updated: true })
    expect(response('backups.inspect', { source: SOURCE, contents: 'home/archon/\nhome/archon/a.txt\n' })).toEqual({ source: SOURCE, contents: 'home/archon/\nhome/archon/a.txt\n' })
    expect(response('backups.restore', { ok: true, output: 'restored' })).toEqual({ ok: true, output: 'restored' })
  })

  it('redacts secret-looking text and strips terminal control sequences from free text', () => {
    const logs = response('logs.list', { logs: [{
      id: '1', timestamp: '', level: 'ERROR', source: 'prime', component: 'task',
      message: '\u001b[31mfailed\u001b[0m token=abc123 Authorization: Bearer sk-live-xyz api_key: "k"',
    }] }) as { logs: { message: string }[] }
    expect(logs.logs[0].message).toBe('failed token=[REDACTED] Authorization: [REDACTED] api_key: [REDACTED]')
    expect(logs.logs[0].message).not.toContain('abc123')
    expect(logs.logs[0].message).not.toContain('sk-live-xyz')

    const output = response('backups.restore', {
      ok: true, output: 'ok\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nBearer abc.def',
    }) as { output: string }
    expect(output.output).toBe('ok\n[REDACTED PRIVATE KEY]\nBearer [REDACTED]')

    const cron = response('cron.list', { jobs: [{ ...cronJob, last_error: 'password=hunter2 failed' }] }) as { jobs: { last_error: string }[] }
    expect(cron.jobs[0].last_error).toBe('password=[REDACTED] failed')
  })

  it('refuses sensitive fields, extra keys and out-of-range values', () => {
    const rejected: [string, unknown][] = [
      ['status.get', { ...statusFixture, token: 'x' }],
      ['status.get', { ...statusFixture, cpu: { ...statusFixture.cpu, percent: 101 } }],
      ['status.get', { ...statusFixture, cpu: { ...statusFixture.cpu, cores: 0 } }],
      ['status.get', { ...statusFixture, memory: { ...statusFixture.memory, used: -1 } }],
      ['status.get', { ...statusFixture, disk: { ...statusFixture.disk, path: 'relative' } }],
      ['status.get', { ...statusFixture, archon: { ...statusFixture.archon, accounting: 'guess' } }],
      ['status.get', { ...statusFixture, hostname: '<b>\u0000</b>' }],
      ['logs.list', { logs: [{ id: '1', timestamp: '', level: 'TRACE', source: 'prime', component: 'task', message: 'x' }] }],
      ['logs.list', { logs: [{ id: '1', timestamp: '', level: 'INFO', source: 'prime', component: 'task', message: { html: '<b>' } }] }],
      ['logs.list', { logs: Array.from({ length: 2_001 }, (_, i) => ({ id: String(i), timestamp: '', level: 'INFO', source: 'prime', component: 'task', message: 'x' })) }],
      ['models.list', { ...catalog, fallback: { provider: 'x', model: 'y' } }],
      ['models.list', { ...catalog, providers: [catalog.providers[0], catalog.providers[0]] }],
      ['models.list', { ...catalog, current: { ...catalog.current, api_key: 'sk' } }],
      ['models.list', { ...catalog, choices: [{ provider: 'openai-codex', model: 'bad model' }] }],
      ['skills.list', { skills: [{ ...skill, secret: 'x' }] }],
      ['skills.list', { skills: [{ ...skill, path: 'SKILL.md' }] }],
      ['skills.get', skill],
      ['skills.toggle', { ...skill, content: 'x' }],
      ['cron.list', { jobs: [{ ...cronJob, credentials: 'x' }] }],
      ['cron.list', { jobs: [{ ...cronJob, id: '../x' }] }],
      ['cron.list', { jobs: [cronJob, cronJob] }],
      ['cron.list', { jobs: [{ ...cronJob, enabled: 'yes' }] }],
      ['cron.action', { ok: false, output: '', jobs: [] }],
      ['cron.create', { ok: true, output: 'x'.repeat(1_000_001), jobs: [] }],
      ['backups.list', { backups: [{ ...backup, encrypted: false }] }],
      ['backups.list', { backups: [{ ...backup, plain_size: null }] }],
      ['backups.list', { backups: [{ ...backup, id: 'latest' }] }],
      ['backups.schedule.get', { calendar: null, Password: 'x' }],
      ['backups.schedule.get', { ActiveState: 'active' }],
      ['backups.schedule.set', { calendar: 'x\ny', updated: true }],
      ['backups.inspect', { source: SOURCE, contents: 5 }],
      ['backups.restore', { ok: true }],
    ]
    for (const [operation, value] of rejected) {
      expect(() => response(operation, value), `${operation} ${JSON.stringify(value).slice(0, 80)}`).toThrow(TypeError)
    }
  })
})
