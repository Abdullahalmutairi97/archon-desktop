// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { WorkspaceBench } from './WorkspaceBench'

const api = { files:vi.fn(async () => []), cancelTask:vi.fn() }
const props = { api:api as never, panel:'tasks' as const, onPanel:vi.fn(), tasks:[], sessions:[], onClose:vi.fn(), onRefresh:vi.fn(async () => undefined) }

describe('WorkspaceBench activity readiness and replay', () => {
  it('does not claim the feed is empty before the initial snapshot is ready', () => {
    render(<WorkspaceBench {...props} events={[]} ready={false}/>)
    expect(screen.getByText('Loading activity')).toBeInTheDocument()
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument()
  })
  it('renders populated replay events after reconnect', () => {
    render(<WorkspaceBench {...props} events={[{ seq:42, type:'task.completed', task_id:'task-12345678', data:{}, created_at:'2026-07-26T00:00:00Z' }]} ready/>)
    expect(screen.getByText('task completed')).toBeInTheDocument()
    expect(screen.getByText(/event #42/)).toBeInTheDocument()
  })
})
