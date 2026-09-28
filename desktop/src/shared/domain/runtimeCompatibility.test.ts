import { describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITY_FIELDS,
  RUNTIME_IDENTITY_FIELDS,
  describeRuntimeCompatibility,
  type RuntimeManifestRecord,
} from './runtimeCompatibility'

const MANIFEST_CAPABILITIES = {
  modalities: ['prompt'],
  resume: false,
  fork: false,
  steer: false,
  approval: false,
  read_only: false,
  chat_only: false,
  reconnect: 'task_event_replay',
  resource_formats: ['print'],
  transports: ['stdio'],
}

function runtime(overrides: Partial<RuntimeManifestRecord> = {}): RuntimeManifestRecord {
  return {
    id: 'prime',
    available: true,
    availability_check: 'executable_file',
    version: '0.9.6',
    version_verified: true,
    executable_digest: 'a'.repeat(64),
    manifest_version: 1,
    capabilities: MANIFEST_CAPABILITIES,
    modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }],
    sandboxed: false,
    chat_only: false,
    ...overrides,
  }
}

describe('runtime compatibility', () => {
  it('covers every capability and identity field the server publishes', () => {
    // The published manifest keys must all have a row, or a capability could
    // disappear from the interface without anyone noticing.
    expect(RUNTIME_CAPABILITY_FIELDS.map((field) => field.key).sort())
      .toEqual(Object.keys(MANIFEST_CAPABILITIES).sort())
    expect(RUNTIME_IDENTITY_FIELDS.map((field) => field.key)).toEqual([
      'available', 'availability_check', 'version', 'version_verified', 'executable_digest',
      'manifest_version', 'sandboxed',
    ])
  })

  it('never reports ready without a verified authentication state', () => {
    const verified = [{ provider: 'prime', state: 'verified' as const, references: 1, lastFailureReason: null }]
    expect(describeRuntimeCompatibility([runtime()], verified)[0].state).toBe('ready')

    const unverified = describeRuntimeCompatibility([runtime()], [{ ...verified[0], state: 'unverified' }])[0]
    expect(unverified.state).toBe('unverified')
    expect(unverified.reason).toContain('no brokered call has succeeded')

    const absent = describeRuntimeCompatibility([runtime()], [{ ...verified[0], state: 'unavailable', references: 0 }])[0]
    expect(absent.state).toBe('unverified')
    expect(absent.reason).toContain('credential is absent')

    const none = describeRuntimeCompatibility([runtime()], [])[0]
    expect(none.state).toBe('unverified')
    expect(none.reason).toContain('no authentication state is registered')
  })

  it('reports an unavailable executable and an unverified version before anything else', () => {
    const rows = describeRuntimeCompatibility(
      [runtime({ available: false }), runtime({ id: 'pi', version_verified: false })],
      [{ provider: 'prime', state: 'verified', references: 1, lastFailureReason: null },
        { provider: 'pi', state: 'verified', references: 1, lastFailureReason: null }],
    )
    expect(rows[0].state).toBe('unavailable')
    expect(rows[0].reason).toContain('not an executable file')
    expect(rows[1].state).toBe('unverified')
    expect(rows[1].reason).toContain('not verified against the executable')
  })

  it('renders an unsupported capability instead of hiding it', () => {
    const row = describeRuntimeCompatibility([runtime()], [])[0]
    const byKey = Object.fromEntries(row.capabilities.map((entry) => [entry.key, entry.value]))
    expect(byKey.resume).toBe('unsupported')
    expect(byKey.modalities).toBe('prompt')
    expect(byKey.reconnect).toBe('task_event_replay')
    expect(byKey.transports).toBe('stdio')
    // A manifest that omits a capability says so rather than claiming support.
    const bare = describeRuntimeCompatibility([runtime({ capabilities: {} })], [])[0]
    const bareByKey = Object.fromEntries(bare.capabilities.map((entry) => [entry.key, entry.value]))
    expect(bareByKey.resume).toBe('not declared')
    expect(bareByKey.modalities).toBe('none declared')
  })

  it('reports identity facts honestly, including a missing digest', () => {
    const row = describeRuntimeCompatibility([runtime({ executable_digest: null })], [])[0]
    const facts = Object.fromEntries(row.facts.map((entry) => [entry.key, entry.value]))
    expect(facts.executable_digest).toBe('not declared')
    expect(facts.available).toBe('true')
    expect(row.heading).toBe('prime 0.9.6')
  })
})
