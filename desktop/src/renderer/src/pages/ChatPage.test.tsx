// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { ChatPage } from './ChatPage'

it('renders the canonical new-chat composition with greeting, wordmark, composer, and pickup work', async () => {
  const api = { audioStatus:vi.fn(() => new Promise(() => undefined)), createTask:vi.fn(), uploadFile:vi.fn() }
  const task = { id:'7f21c9', prompt:'Ship v0.6.1', skills:[], status:'running', created_at:'2026-07-26T00:00:00Z', updated_at:'2026-07-26T00:00:00Z' }
  render(<ChatPage api={api as never} projects={[]} sessions={[]} tasks={[task] as never} refreshSessions={vi.fn()} refreshTasks={vi.fn()} onOpenChat={vi.fn()}/>)
  expect(screen.getByRole('heading', { name:'Evening, Abdullah.' })).toBeInTheDocument()
  expect(screen.getByText('Archon', { selector:'.v2-start-wordmark' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name:'Message Archon' })).toHaveAttribute('placeholder', 'Ask Archon anything, or give it a job to run on the server…')
  expect(screen.getByText('Ship v0.6.1')).toBeInTheDocument()
})
