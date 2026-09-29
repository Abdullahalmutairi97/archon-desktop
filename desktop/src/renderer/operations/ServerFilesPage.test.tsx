import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../../shared/bridge/types'
import type { LiveScope, LiveServer } from '../live/useLiveServer'
import { ServerFilesBrowser, ServerFilesPage } from './ServerFilesPage'
import { serverFileErrorCode } from './serverFiles'

afterEach(() => cleanup())

const item = (name: string, path: string, isDir = false, extra: Record<string, unknown> = {}) => ({
  name, path, is_dir: isDir, is_symlink: false, restricted: false, size: isDir ? 4096 : 12,
  modified_at: '2026-09-01T10:00:00+00:00', mime: isDir ? null : 'text/plain', ...extra,
})

const readResult = (path: string, content: string, extra: Record<string, unknown> = {}) => ({
  path, content, size: content.length, read: content.length, truncated: false, binary: false, ...extra,
})

function harness(handler: (operation: string, payload: Record<string, unknown>) => unknown, generation = 3) {
  const invoke = vi.fn((operation: string, payload: Record<string, unknown>) => Promise.resolve().then(() => handler(operation, payload)))
  const describe = vi.fn(async () => ({ serverUrl: 'http://127.0.0.1:9700', configured: true, storageMode: 'memory', generation }))
  const bridge = { api: { invoke }, connection: { describe } } as unknown as DesktopBridge
  const scope: LiveScope = { bridge, generation: 3, serverUrl: 'http://127.0.0.1:9700', localPairingAvailable: false }
  return { invoke, describe, scope }
}

const rootListing = { root: '/home/owner', path: '.', items: [item('docs', 'docs', true), item('todo.txt', 'todo.txt'), item('.env', '.env', false, { restricted: true })] }

function calls(invoke: ReturnType<typeof harness>['invoke'], operation: string) {
  return invoke.mock.calls.filter(([name]) => name === operation)
}

describe('server files page', () => {
  it('shows an honest disconnected state without touching the bridge', () => {
    const onOpenConnection = vi.fn()
    const server: LiveServer = { status: 'disconnected', scope: null, projects: [], sessions: [], refreshing: false, refresh: vi.fn(), renameSession: vi.fn() }
    render(<ServerFilesPage server={server} onOpenConnection={onOpenConnection} />)
    expect(screen.getByText(/Not connected/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Connection' }))
    expect(onOpenConnection).toHaveBeenCalled()
  })

  it('browses, opens a text file, edits it and saves it once', async () => {
    const { invoke, scope } = harness((operation, payload) => {
      if (operation === 'files.list' && payload.path === '') return rootListing
      if (operation === 'files.list' && payload.path === 'docs') return { root: '/home/owner', path: 'docs', items: [item('guide.md', 'docs/guide.md')] }
      if (operation === 'files.read') return readResult('docs/guide.md', '# Guide\n')
      if (operation === 'files.writeText') return readResult('docs/guide.md', String(payload.content))
      throw new Error(operation)
    })
    render(<ServerFilesBrowser scope={scope} />)

    expect(await screen.findByText('/home/owner')).toHaveAttribute('dir', 'ltr')
    fireEvent.click(screen.getByRole('button', { name: /^docs/ }))
    fireEvent.click(await screen.findByRole('button', { name: /^guide\.md/ }))
    const editor = await screen.findByLabelText('File content')
    expect(editor).toHaveValue('# Guide\n')
    expect(editor).toHaveAttribute('dir', 'auto')
    expect(calls(invoke, 'files.read')[0][1]).toEqual({ path: 'docs/guide.md', maxBytes: 1024 * 1024 })

    fireEvent.change(editor, { target: { value: '# Guide\nمرحبا\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved guide.md.')).toBeInTheDocument()
    expect(calls(invoke, 'files.writeText')).toEqual([['files.writeText', { path: 'docs/guide.md', content: '# Guide\nمرحبا\n' }]])
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('keeps truncated, lossy and restricted files read-only', async () => {
    const { invoke, scope } = harness((operation, payload) => {
      if (operation === 'files.list') return rootListing
      if (operation === 'files.read' && payload.path === 'todo.txt') return readResult('todo.txt', 'abc', { size: 5_000_000, read: 3, truncated: true })
      throw new Error(operation)
    })
    render(<ServerFilesBrowser scope={scope} />)
    fireEvent.click(await screen.findByRole('button', { name: /^todo\.txt/ }))
    expect(await screen.findByLabelText('File content')).toHaveAttribute('readonly')
    expect(screen.getByText(/Only the first 1 MiB is shown/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^\.env/ }))
    expect(await screen.findByText(/intentionally not shown/)).toBeInTheDocument()
    expect(calls(invoke, 'files.read')).toHaveLength(1)
  })

  it('asks before deleting: cancel sends nothing, confirm deletes once', async () => {
    const { invoke, scope } = harness((operation) => {
      if (operation === 'files.list') return rootListing
      if (operation === 'files.delete') return { ok: true }
      throw new Error(operation)
    })
    render(<ServerFilesBrowser scope={scope} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete todo.txt' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete todo.txt?' })
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(dialog).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete todo.txt' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls(invoke, 'files.delete')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Delete todo.txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }))
    expect(await screen.findByText('Deleted todo.txt.')).toBeInTheDocument()
    expect(calls(invoke, 'files.delete')).toEqual([['files.delete', { path: 'todo.txt', confirm: true }]])
  })

  it('refuses a change after the connection generation moved on', async () => {
    const { invoke, scope } = harness((operation) => {
      if (operation === 'files.list') return rootListing
      return { ok: true }
    }, 4)
    render(<ServerFilesBrowser scope={scope} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete todo.txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }))
    expect(await screen.findByText(/connection changed/)).toBeInTheDocument()
    expect(calls(invoke, 'files.delete')).toHaveLength(0)
  })

  it('confirms before a rename replaces an existing entry', async () => {
    const { invoke, scope } = harness((operation) => {
      if (operation === 'files.list') return rootListing
      if (operation === 'files.delete') return { ok: true }
      if (operation === 'files.rename') return { path: 'docs' }
      throw new Error(operation)
    })
    render(<ServerFilesBrowser scope={scope} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename todo.txt' }))
    const input = screen.getByLabelText('New path from the server file root')
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(await screen.findByRole('dialog', { name: 'Replace docs?' })).toBeInTheDocument()
    expect(calls(invoke, 'files.rename')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(calls(invoke, 'files.delete')).toHaveLength(0)
  })

  it('uploads a picked file and asks before replacing one', async () => {
    let uploads = 0
    const { invoke, scope } = harness((operation, payload) => {
      if (operation === 'files.list') return rootListing
      if (operation === 'files.pickUpload') return { cancelled: false, pickId: `upload-${'a'.repeat(32)}`, name: 'todo.txt', size: 3 }
      if (operation === 'files.upload') {
        uploads += 1
        if (!payload.replace) throw Object.assign(new Error('exists'), { code: 'already_exists' })
        return { path: 'todo.txt', size: 3 }
      }
      throw new Error(operation)
    })
    render(<ServerFilesBrowser scope={scope} />)
    await screen.findByText('todo.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Upload…' }))
    expect(await screen.findByRole('dialog', { name: 'Replace todo.txt?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(await screen.findByText('Uploaded todo.txt (3 B).')).toBeInTheDocument()
    expect(uploads).toBe(2)
    expect(calls(invoke, 'files.upload').map(([, payload]) => payload)).toEqual([
      { pickId: `upload-${'a'.repeat(32)}`, path: 'todo.txt', replace: false },
      { pickId: `upload-${'a'.repeat(32)}`, path: 'todo.txt', replace: true },
    ])
  })

  it('reads a transport code from an Electron-forwarded message', () => {
    expect(serverFileErrorCode(new Error("Error invoking remote method 'archon:api:invoke': BackendTransportError: Something with that name already exists on the server.")))
      .toBe('already_exists')
  })

  it('downloads through the main process and reports only the saved name', async () => {
    const { invoke, scope } = harness((operation) => {
      if (operation === 'files.list') return rootListing
      if (operation === 'files.download') return { saved: true, name: 'todo.txt', size: 12 }
      throw new Error(operation)
    })
    render(<ServerFilesBrowser scope={scope} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download todo.txt' }))
    await waitFor(() => expect(screen.getByText('Saved todo.txt (12 B) on this PC.')).toBeInTheDocument())
    expect(calls(invoke, 'files.download')).toEqual([['files.download', { path: 'todo.txt' }]])
  })
})
