import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceConsoleBridge } from '../../shared/bridge/types'
import { WorkspaceConsole } from './WorkspaceConsole'

afterEach(cleanup)

describe('WorkspaceConsole', () => {
  it('does not retry an input line after an ambiguous send failure', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const bridge: WorkspaceConsoleBridge = {
      list: vi.fn(async () => [{ sessionId, state: 'running' as const, createdAt: '2026-09-27T00:00:00Z' }]),
      create: vi.fn(),
      screen: vi.fn(async () => ({ text: 'ready', truncated: false })),
      sendLine: vi.fn(async () => { throw new Error('reply lost') }),
      stop: vi.fn(),
    }
    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    expect(await screen.findByText('ready')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Send one line' }), { target: { value: 'do work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send line' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('It was not retried.')
    await waitFor(() => expect(bridge.sendLine).toHaveBeenCalledTimes(1))
    expect(bridge.sendLine).toHaveBeenCalledWith({ workspaceId, sessionId, line: 'do work' })
  })
})
