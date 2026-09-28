import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageProfileExtensionDto, LanguageProfilesBridge, LanguageProfilesDto } from '../../shared/bridge/types'
import { LanguageProfiles } from './LanguageProfiles'

afterEach(cleanup)

const WORKSPACE_ID = `workspace-${'a'.repeat(32)}`

function extension(overrides: Partial<LanguageProfileExtensionDto> = {}): LanguageProfileExtensionDto {
  return {
    extensionId: 'ms-python.python', version: '2026.4.0', marketplace: 'open-vsx', declaredLicence: 'MIT',
    licenceSha256: 'b'.repeat(64), vsixSha256: 'c'.repeat(64), vsixBytes: 6826731,
    downloadUrl: 'https://open-vsx.org/api/ms-python/python/2026.4.0/file/x.vsix',
    targetPlatform: null, pinnedInstalledSha256: 'd'.repeat(64), state: 'installed', reason: null,
    installedVersion: '2026.4.0', installedDirectory: 'ms-python.python-2026.4.0',
    measuredSha256: 'd'.repeat(64), measuredFiles: 2381, installedLicenceField: 'MIT',
    ...overrides,
  }
}

function report(overrides: Partial<LanguageProfilesDto> = {}): LanguageProfilesDto {
  return {
    extensionsDirectory: '/home/user/.local/share/code-server/extensions',
    profiles: [{
      profile: 'python', label: 'Python', languageIds: ['python'],
      extensions: [extension()],
      debuggers: [extension({ extensionId: 'ms-python.debugpy', version: '2026.6.0', state: 'missing', reason: 'the pinned extension is not installed in this directory' })],
      unsupported: [{
        feature: 'pylance-language-server',
        reason: 'Pylance is proprietary and is not published to this marketplace.',
      }],
    }],
    unpinnedInstalled: [{
      extensionId: 'ms-python.vscode-python-envs', installedVersion: '1.38.0', installedLicenceField: null,
      measuredSha256: 'e'.repeat(64), state: 'unpinned', reason: 'this installed extension is not covered by a verified pin',
    }],
    pinsVerified: false,
    note: 'Installed means the pinned version is present and its files still hash to the recorded digest.',
    ...overrides,
  }
}

function bridgeReturning(value: LanguageProfilesDto): LanguageProfilesBridge {
  return { list: vi.fn(async () => value) }
}

describe('LanguageProfiles', () => {
  it('reports installed, missing and unsupported rows with their reasons', async () => {
    const bridge = bridgeReturning(report())
    render(<LanguageProfiles bridge={bridge} workspaceId={WORKSPACE_ID} generation={2} pairingAvailable />)

    expect(await screen.findByText('ms-python.python@2026.4.0')).toBeInTheDocument()
    expect(screen.getByText('installed')).toBeInTheDocument()
    expect(screen.getByText('ms-python.debugpy@2026.6.0')).toBeInTheDocument()
    expect(screen.getByText('missing')).toBeInTheDocument()
    // An unsupported capability is named with its reason, never implied as working.
    expect(screen.getByText('pylance-language-server')).toBeInTheDocument()
    expect(screen.getByText(/Pylance is proprietary/)).toBeInTheDocument()
    // An automatically installed extension is reported as unpinned, not verified.
    expect(screen.getByText('ms-python.vscode-python-envs@1.38.0')).toBeInTheDocument()
    expect(screen.getByText('no licence field')).toBeInTheDocument()
    expect(screen.getByText(/not a behavioural qualification/)).toBeInTheDocument()
    expect(bridge.list).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID })
  })

  it('shows an error and keeps the previous report when the backend is unreachable', async () => {
    const bridge: LanguageProfilesBridge = { list: vi.fn(async () => { throw new Error('backend down') }) }
    render(<LanguageProfiles bridge={bridge} workspaceId={WORKSPACE_ID} generation={1} pairingAvailable />)
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable for this checkout')
  })

  it('refreshes only when asked and never retries on its own', async () => {
    const bridge = bridgeReturning(report())
    render(<LanguageProfiles bridge={bridge} workspaceId={WORKSPACE_ID} generation={1} pairingAvailable />)
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2))
  })
})
