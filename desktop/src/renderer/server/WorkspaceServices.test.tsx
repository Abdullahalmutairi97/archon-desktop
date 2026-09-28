import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceServiceDto, WorkspaceServicesBridge } from '../../shared/bridge/types'
import { WorkspaceServices } from './WorkspaceServices'

afterEach(cleanup)

const WORKSPACE_ID = `workspace-${'a'.repeat(32)}`

function service(overrides: Partial<WorkspaceServiceDto> = {}): WorkspaceServiceDto {
  return {
    name: 'web', argv: ['/bin/echo', 'hello'], cwd: '.', ports: [], restart: 'never',
    state: 'registered', exitCode: null, restarts: 0, health: 'unknown',
    memoryLimitMb: null, cpuQuotaPercent: null, tasksMax: null,
    filesystemIsolation: 'none', networkIsolation: 'host',
    ...overrides,
  }
}

function bridgeWith(rows: readonly WorkspaceServiceDto[]): WorkspaceServicesBridge {
  return {
    list: vi.fn(async () => rows),
    define: vi.fn(async () => rows[0] ?? service()),
    codeServer: vi.fn(),
    remove: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    logs: vi.fn(async () => ({ text: '', truncated: false })),
  }
}

const preview: Parameters<typeof WorkspaceServices>[0]['preview'] = {
  open: vi.fn(), bounds: vi.fn(), close: vi.fn(),
}

describe('WorkspaceServices declared controls', () => {
  it('states the applied controls for a bounded service and their absence for a plain one', async () => {
    const bridge = bridgeWith([
      service({
        name: 'bounded', memoryLimitMb: 256, cpuQuotaPercent: 50, tasksMax: 64,
        filesystemIsolation: 'workspace-only', networkIsolation: 'isolated',
      }),
      service({ name: 'plain' }),
    ])
    render(<WorkspaceServices bridge={bridge} preview={preview} workspaceId={WORKSPACE_ID} generation={1} pairingAvailable />)

    const bounded = await screen.findByLabelText('Applied controls for bounded')
    expect(bounded).toHaveTextContent('memory 256 MB')
    expect(bounded).toHaveTextContent('cpu 50%')
    expect(bounded).toHaveTextContent('tasks 64')
    expect(bounded).toHaveTextContent('filesystem: workspace only')
    expect(bounded).toHaveTextContent('network: none')
    // A service without declared controls must say so instead of implying isolation.
    expect(screen.getByLabelText('Applied controls for plain')).toHaveTextContent(
      'no declared controls (full host access)',
    )
  })

  it('sends the declared controls through the definition', async () => {
    const bridge = bridgeWith([])
    render(<WorkspaceServices bridge={bridge} preview={preview} workspaceId={WORKSPACE_ID} generation={1} pairingAvailable />)
    await waitFor(() => expect(bridge.list).toHaveBeenCalled())

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'bounded' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Executable' }), { target: { value: '/bin/sleep' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory limit MB (blank for none)' }), { target: { value: '256' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'CPU quota % (blank for none)' }), { target: { value: '50' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Task limit (blank for none)' }), { target: { value: '64' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filesystem' }), { target: { value: 'workspace-only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))

    await waitFor(() => expect(bridge.define).toHaveBeenCalledTimes(1))
    expect(bridge.define).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      definition: expect.objectContaining({
        name: 'bounded', memoryLimitMb: 256, cpuQuotaPercent: 50, tasksMax: 64,
        filesystemIsolation: 'workspace-only', networkIsolation: 'host',
      }),
    })
  })

  it('refuses an out-of-range control and an isolated service with a port before any request', async () => {
    const bridge = bridgeWith([])
    render(<WorkspaceServices bridge={bridge} preview={preview} workspaceId={WORKSPACE_ID} generation={1} pairingAvailable />)
    await waitFor(() => expect(bridge.list).toHaveBeenCalled())

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'bounded' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Executable' }), { target: { value: '/bin/sleep' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'CPU quota % (blank for none)' }), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await screen.findByRole('alert')
    expect(bridge.define).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: 'CPU quota % (blank for none)' }), { target: { value: '' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Port name' }), { target: { value: 'http' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Port' }), { target: { value: '4173' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Network' }), { target: { value: 'isolated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))
    await screen.findByRole('alert')
    expect(bridge.define).not.toHaveBeenCalled()
  })
})
