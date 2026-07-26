// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { TasksPage } from './TasksPage'

const task = { id:'task-12345678', prompt:'Package release', skills:[], status:'running', session_id:'session-12345678', created_at:'2026-07-26T00:00:00Z', started_at:'2026-07-26T00:00:00Z', updated_at:'2026-07-26T00:00:00Z' }

describe('TasksPage', () => {
  it('renders canonical state chips and opens the parent session', async () => {
    const api = { listTasks:vi.fn(async () => [task]), cancelTask:vi.fn() }
    const open = vi.fn()
    render(<TasksPage api={api as never} onOpenSession={open}/>)
    expect(await screen.findByText('working')).toBeInTheDocument()
    const summary = screen.getByText('Package release').closest('.task-summary')
    expect(summary).toBeInTheDocument()
    expect(summary?.querySelector(':scope > b')).toHaveTextContent('Package release')
    expect(summary?.querySelector(':scope > small')).toHaveTextContent('Session session-1234')
    fireEvent.click(screen.getByRole('button', { name:'Open session' }))
    expect(open).toHaveBeenCalledWith('session-12345678')
  })

  it('surfaces cancellation failures instead of leaving a dead-end action', async () => {
    const api = { listTasks:vi.fn(async () => [task]), cancelTask:vi.fn(async () => { throw new Error('cancel refused') }) }
    render(<TasksPage api={api as never} onOpenSession={vi.fn()}/>)
    fireEvent.click(await screen.findByRole('button', { name:/Cancel Package release/i }))
    await waitFor(() => expect(screen.getByText('cancel refused')).toBeInTheDocument())
  })
})
