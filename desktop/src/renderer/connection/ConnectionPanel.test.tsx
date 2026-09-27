import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../../shared/bridge/types'
import { ConnectionPanel } from './ConnectionPanel'

afterEach(cleanup)

function fakeBridge() {
  const connection = {
    describe: vi.fn(async () => ({ serverUrl: null, configured: false, storageMode: 'memory' as const, generation: 0 })),
    save: vi.fn(async () => ({
      description: { serverUrl: 'http://127.0.0.1:8000', configured: true, storageMode: 'memory' as const, generation: 1 },
      probe: { ok: true, readiness: { dispatch_ready: false } },
    })),
    disconnect: vi.fn(async () => ({ serverUrl: null, configured: false, storageMode: 'memory' as const, generation: 2 })),
    probe: vi.fn(async () => ({ ok: true, readiness: { dispatch_ready: false } })),
  }
  const invoke = vi.fn(async (operation: string) => {
    if (operation === 'projects.list') return { projects: [{ id: 'project-1' }] }
    if (operation === 'sessions.list') return { sessions: Array.from({ length: 120 }, (_, index) => ({ id: `session-${index}` })) }
    if (operation === 'tasks.list') return { tasks: [] }
    return { cursor: 9 }
  })
  return { bridge: { connection, api: { invoke } } as unknown as DesktopBridge, connection, invoke }
}

describe('connection panel', () => {
  it('shows an honest unavailable state in the browser preview', () => {
    render(<ConnectionPanel />)
    expect(screen.getByText(/requires the desktop bridge/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })

  it('clears entered credentials and shows read-only server counts without mixing fixtures', async () => {
    const { bridge, connection, invoke } = fakeBridge()
    const { container } = render(<ConnectionPanel bridge={bridge} />)
    await waitFor(() => expect(connection.describe).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'http://127.0.0.1:8000' } })
    fireEvent.change(screen.getByLabelText('Device token'), { target: { value: 'TOKEN_SENTINEL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('events.cursor', {}))
    expect(connection.save).toHaveBeenCalledWith({ serverUrl: 'http://127.0.0.1:8000', token: 'TOKEN_SENTINEL' })
    expect(screen.getByLabelText('Device token')).toHaveValue('')
    expect(container.textContent).not.toContain('TOKEN_SENTINEL')
    expect(localStorage.length).toBe(0)
    expect(screen.getByText('Dispatch unavailable')).toBeInTheDocument()
    expect(screen.getByText('120 sessions returned')).toBeInTheDocument()
    expect(screen.getByText('1 project returned')).toBeInTheDocument()
    expect(screen.getByText(/returned rows, not totals/i)).toBeInTheDocument()
    expect(screen.getByText('Cursor 9')).toBeInTheDocument()
    expect(screen.getByText(/held in main-process memory/i)).toBeInTheDocument()
  })

  it('removes an old ready status when a new probe rejects', async () => {
    const { bridge, connection } = fakeBridge()
    connection.save.mockResolvedValue({
      description: { serverUrl: 'http://127.0.0.1:8000', configured: true, storageMode: 'memory', generation: 1 },
      probe: { ok: true, readiness: { dispatch_ready: true } },
    })
    const { unmount } = render(<ConnectionPanel bridge={bridge} />)
    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'http://127.0.0.1:8000' } })
    fireEvent.change(screen.getByLabelText('Device token'), { target: { value: 'TOKEN_SENTINEL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByText('Dispatch ready')
    connection.probe.mockRejectedValue(new Error('fake rejection'))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('Dispatch ready')).not.toBeInTheDocument()
    expect(screen.getByText('Saved in memory')).toBeInTheDocument()
    unmount()
  })
})
