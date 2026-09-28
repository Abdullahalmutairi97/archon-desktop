import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../../shared/bridge/types'
import { RuntimeCompatibility } from './RuntimeCompatibility'

afterEach(cleanup)

function bridgeWith(manifest: unknown, auth: unknown): DesktopBridge {
  const invoke = vi.fn(async (operation: string) => {
    if (operation === 'runtimes.list') return manifest
    if (operation === 'secrets.authStates') return auth
    throw new Error(`unexpected operation ${operation}`)
  })
  return { api: { invoke } } as unknown as DesktopBridge
}

const MANIFEST = {
  runtimes: [{
    id: 'prime', aliases: [], available: true, availability_check: 'executable_file',
    version: '0.9.6', version_verified: true, executable_digest: 'a'.repeat(64), manifest_version: 1,
    availability_note: 'Filesystem availability is not authentication.',
    capabilities: {
      modalities: ['prompt'], resume: false, fork: false, steer: false, approval: false,
      read_only: false, chat_only: false, reconnect: 'task_event_replay',
      resource_formats: ['print'], transports: ['stdio'],
    },
    modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }],
    chat_only: false, sandboxed: false,
  }],
}

const AUTH = {
  providers: [{ provider: 'prime', state: 'unverified', references: 1, purpose: ['provider'],
    verifiedAt: null, lastAttemptAt: null, lastFailureReason: 'no call yet' }],
  epoch: 2, secretSource: 'process-environment', secretValuesExposed: false, note: 'never a value',
}

describe('runtime compatibility panel', () => {
  it('derives rows from the manifest and refuses to call an unverified runtime ready', async () => {
    const bridge = bridgeWith(MANIFEST, AUTH)
    render(<RuntimeCompatibility bridge={bridge} generation={1} />)
    await waitFor(() => expect(screen.getByText('prime 0.9.6')).toBeTruthy())
    expect(screen.getByText('unverified')).toBeTruthy()
    expect(screen.getByText(/no brokered call has succeeded/)).toBeTruthy()
    // An unsupported capability is visible instead of hidden.
    expect(screen.getAllByText('unsupported').length).toBeGreaterThan(0)
    expect(screen.getByText('task_event_replay')).toBeTruthy()
    expect(screen.getByText(/not a claim about provider quotas/)).toBeTruthy()
  })

  it('reports an unavailable connection instead of an empty capability list', async () => {
    const bridge = { api: { invoke: vi.fn(async () => { throw new Error('offline') }) } } as unknown as DesktopBridge
    render(<RuntimeCompatibility bridge={bridge} generation={1} />)
    await waitFor(() => expect(screen.getByText(/runtime manifest or the authentication state is unavailable/)).toBeTruthy())
  })

  it('shows an authenticated runtime as ready only with a verified provider state', async () => {
    const bridge = bridgeWith(MANIFEST, { ...AUTH, providers: [{ ...AUTH.providers[0], state: 'verified' }] })
    render(<RuntimeCompatibility bridge={bridge} generation={1} />)
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy())
    expect(screen.getByText(/one brokered provider call were observed/)).toBeTruthy()
  })
})
