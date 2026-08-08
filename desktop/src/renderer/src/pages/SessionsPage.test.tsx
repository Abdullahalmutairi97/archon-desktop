// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { SessionsPage } from './SessionsPage'
import type { HermesSession } from '../lib/types'

const sessions: HermesSession[] = [
  { id: 'first', source: 'desktop', title: 'First session', model: 'gpt-test', cwd: '/work', started_at: '2026-08-02T10:00:00Z', last_active: '2026-08-02T10:00:00Z', message_count: 2, active: false, preview: 'First preview' },
  { id: 'second', source: 'desktop', title: 'Second session', model: 'gpt-test', cwd: '/work', started_at: '2026-08-02T09:00:00Z', last_active: '2026-08-02T09:00:00Z', message_count: 3, active: false, preview: 'Second preview' },
]

describe('SessionsPage', () => {
  it('removes every selected session after an explicit confirmation', async () => {
    const api = {
      sessions: vi.fn(async () => sessions),
      projects: vi.fn(async () => []),
      deleteSessions: vi.fn(async (ids: string[]) => ({ ok: true, deleted: ids })),
    }
    render(<SessionsPage api={api as never} onOpen={vi.fn()} />)

    await screen.findByText('First session')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select First session' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Second session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected (2)' }))

    const dialog = await screen.findByRole('dialog', { name: 'Remove 2 sessions?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 2 sessions' }))

    await waitFor(() => expect(api.deleteSessions).toHaveBeenCalledWith(['first', 'second']))
  })
})
