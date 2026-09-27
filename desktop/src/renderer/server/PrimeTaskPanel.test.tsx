import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionDescription, DesktopBridge, JsonRecord } from '../../shared/bridge/types'
import { PrimeTaskPanel } from './PrimeTaskPanel'

afterEach(cleanup)

const connection: ConnectionDescription = {
  serverUrl: 'https://archon.example',
  configured: true,
  storageMode: 'memory',
  generation: 4,
}

const projects: readonly JsonRecord[] = [{
  id: 'project-1',
  name: 'Sample project',
  primary_path: '/work/sample',
}]

const runtime = {
  id: 'prime',
  aliases: ['prime'],
  available: true,
  availability_check: 'executable_file',
  version: null,
  version_verified: false,
  availability_note: 'Prime is available.',
  modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }],
  chat_only: false,
  sandboxed: false,
}

function fakeBridge(handler: (operation: string, payload: unknown) => unknown | Promise<unknown>) {
  const invoke = vi.fn((operation: string, payload: unknown) => Promise.resolve(handler(operation, payload)))
  const bridge = { api: { invoke } } as unknown as DesktopBridge
  return { bridge, invoke }
}

function defaults(operation: string): unknown {
  if (operation === 'readiness') return { dispatch_ready: true }
  if (operation === 'runtimes.list') return { runtimes: [runtime] }
  if (operation === 'tasks.events') return { events: [] }
  if (operation === 'tasks.cancel') return { ok: true }
  if (operation === 'tasks.get') return { task: { id: 'task-1', status: 'queued' } }
  if (operation === 'tasks.list') return { tasks: [] }
  if (operation === 'tasks.submit') return { task: { id: 'task-1', status: 'completed', result: { text: 'Finished' } } }
  throw new Error(`Unexpected operation: ${operation}`)
}

describe('PrimeTaskPanel', () => {
  it('pins a confirmed Prime task to the selected checkout generation', async () => {
    const { bridge, invoke } = fakeBridge(defaults)
    const workspaceId = `workspace-${'a'.repeat(32)}`
    render(<PrimeTaskPanel bridge={bridge} connection={connection} projects={projects} tasks={[]} workspaces={[{
      workspace_id: workspaceId, root: '/work/checkouts/one', project_id: 'project-1',
      generation: 1, base_revision: 'a'.repeat(40), head_revision: 'a'.repeat(40),
    }]} />)

    fireEvent.change(await screen.findByLabelText('Execution location'), { target: { value: workspaceId } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Inspect the checkout.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review task' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('/work/checkouts/one')
    expect(dialog).toHaveTextContent('Generation 1')
    fireEvent.click(screen.getByRole('button', { name: 'Run with Trusted execution' }))
    await screen.findByText('Finished')
    expect(invoke.mock.calls.find(([operation]) => operation === 'tasks.submit')).toEqual([
      'tasks.submit', { projectId: 'project-1', prompt: 'Inspect the checkout.',
        workspaceId, workspaceGeneration: 1 },
    ])
  })

  it('shows a frozen task confirmation and submits only after explicit Trusted execution confirmation', async () => {
    const { bridge, invoke } = fakeBridge(defaults)
    render(<PrimeTaskPanel bridge={bridge} connection={connection} projects={projects} tasks={[]} />)

    fireEvent.change(await screen.findByLabelText('Project'), { target: { value: 'project-1' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Inspect the project and summarize it.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review task' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('https://archon.example')
    expect(dialog).toHaveTextContent('Sample project')
    expect(dialog).toHaveTextContent('/work/sample')
    expect(dialog).toHaveTextContent('Inspect the project and summarize it.')
    expect(dialog).toHaveTextContent('Trusted execution is unsandboxed')
    expect(dialog).toHaveTextContent('Provider credentials and native conformance are unverified.')
    expect(invoke.mock.calls.some(([operation]) => operation === 'tasks.submit')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Run with Trusted execution' }))
    await screen.findByText('Finished')
    expect(invoke.mock.calls.find(([operation]) => operation === 'tasks.submit')).toEqual([
      'tasks.submit',
      { projectId: 'project-1', prompt: 'Inspect the project and summarize it.' },
    ])
  })

  it('treats a rejected submit as unknown, offers a read-only recent-task check, and never retries automatically', async () => {
    const { bridge, invoke } = fakeBridge((operation) => {
      if (operation === 'tasks.submit') return Promise.reject(new Error('connection lost'))
      return defaults(operation)
    })
    render(<PrimeTaskPanel bridge={bridge} connection={connection} projects={projects} tasks={[]} />)

    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'Make a small change.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review task' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run with Trusted execution' }))
    expect(await screen.findByText('Submission outcome unknown')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Check recent tasks' }))
    expect(await screen.findByText('No tasks were returned.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start new task' })).toBeInTheDocument()
    expect(invoke.mock.calls.filter(([operation]) => operation === 'tasks.submit')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([operation]) => operation === 'tasks.list')).toHaveLength(1)
  })

  it('waits for task readback before displaying a cancellation result', async () => {
    let finishReadback!: (value: unknown) => void
    const readback = new Promise<unknown>((resolve) => { finishReadback = resolve })
    const { bridge, invoke } = fakeBridge((operation) => {
      if (operation === 'tasks.submit') return { task: { id: 'task-1', status: 'queued' } }
      if (operation === 'tasks.get') return readback
      return defaults(operation)
    })
    render(<PrimeTaskPanel bridge={bridge} connection={connection} projects={projects} tasks={[]} />)

    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'Run a long task.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review task' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run with Trusted execution' }))
    expect(await screen.findByText('queued')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
    await waitFor(() => expect(invoke.mock.calls.some(([operation]) => operation === 'tasks.cancel')).toBe(true))
    await waitFor(() => expect(invoke.mock.calls.some(([operation]) => operation === 'tasks.get')).toBe(true))
    expect(screen.getByText('queued')).toBeInTheDocument()

    finishReadback({ task: { id: 'task-1', status: 'cancelled' } })
    await screen.findByText('cancelled')
    const operations = invoke.mock.calls.map(([operation]) => operation)
    expect(operations.slice(-3)).toEqual(['tasks.cancel', 'tasks.get', 'tasks.events'])
  })

  it('reattaches only to a returned Prime task and restores its server detail without submitting', async () => {
    const serverTasks: readonly JsonRecord[] = [
      { id: 'prime-running', status: 'running', runtime_id: 'prime' },
      { id: 'pi-running', status: 'running', runtime_id: 'pi' },
      { id: 'prime-finished', status: 'completed', profile: 'prime' },
    ]
    const { bridge, invoke } = fakeBridge((operation) => {
      if (operation === 'tasks.get') return {
        task: { id: 'prime-running', status: 'completed', result: { text: 'Recovered server result' } },
      }
      if (operation === 'tasks.events') return { events: [{
        seq: 3,
        task_id: 'prime-running',
        type: 'task.completed',
        data: { result: { text: 'Recovered server result' } },
        created_at: '2026-09-27T00:00:00Z',
        attempt_id: null,
      }] }
      return defaults(operation)
    })
    render(<PrimeTaskPanel bridge={bridge} connection={connection} projects={projects} tasks={serverTasks} />)

    expect(await screen.findByText('prime-running')).toBeInTheDocument()
    expect(screen.queryByText('pi-running')).not.toBeInTheDocument()
    const primeRow = screen.getByText('prime-running').closest('li')
    expect(primeRow).not.toBeNull()
    fireEvent.click(within(primeRow as HTMLElement).getByRole('button', { name: 'Open details' }))

    expect(await screen.findByText('Recovered server result')).toBeInTheDocument()
    expect(screen.getByText('completed', { selector: '.task-status' })).toBeInTheDocument()
    expect(screen.getByText('Task ID').parentElement).toHaveTextContent('prime-running')
    expect(invoke.mock.calls).toContainEqual(['tasks.get', { taskId: 'prime-running' }])
    expect(invoke.mock.calls).toContainEqual(['tasks.events', { taskId: 'prime-running', after: 0 }])
    expect(invoke.mock.calls.some(([operation]) => operation === 'tasks.submit')).toBe(false)
  })

  it('can reopen every returned Prime task and blocks a new submission while details are pending', async () => {
    let finishReadback!: (value: unknown) => void
    const readback = new Promise<unknown>((resolve) => { finishReadback = resolve })
    const serverTasks: readonly JsonRecord[] = Array.from({ length: 12 }, (_, index) => ({
      id: `prime-${index + 1}`, status: 'running', runtime_id: 'prime',
    }))
    const { bridge, invoke } = fakeBridge((operation) => {
      if (operation === 'tasks.get') return readback
      return defaults(operation)
    })
    render(<PrimeTaskPanel bridge={bridge} connection={connection} projects={projects} tasks={serverTasks} />)

    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'New work' } })
    const lastTask = screen.getByText('prime-12').closest('li')
    expect(lastTask).not.toBeNull()
    fireEvent.click(within(lastTask as HTMLElement).getByRole('button', { name: 'Open details' }))
    expect(screen.getByRole('button', { name: 'Review task' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Review task' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoke.mock.calls.some(([operation]) => operation === 'tasks.submit')).toBe(false)

    finishReadback({ task: { id: 'prime-12', status: 'completed', result: { text: 'Recovered later task' } } })
    expect(await screen.findByText('Recovered later task')).toBeInTheDocument()
    expect(invoke.mock.calls.some(([operation]) => operation === 'tasks.submit')).toBe(false)
  })
})
