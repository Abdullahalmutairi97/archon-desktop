import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileBrowser, type WorkspaceFileListing, type WorkspaceFileRead, type WorkspaceReadOnlyFilePort } from './WorkspaceFileBrowser'

afterEach(cleanup)

function file(path: string, size = 12) {
  return { name: path.split('/').at(-1)!, path, kind: 'file' as const, size }
}

function directory(path: string) {
  return { name: path.split('/').at(-1)!, path, kind: 'directory' as const, size: null }
}

function port({
  list = vi.fn(async (_workspaceId: string, path: string) => ({ path, entries: [], truncated: false })),
  read = vi.fn(async (_workspaceId: string, path: string) => ({ path, content: '', truncated: false })),
}: {
  list?: WorkspaceReadOnlyFilePort['list']
  read?: WorkspaceReadOnlyFilePort['read']
} = {}) {
  return { list, read }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('WorkspaceFileBrowser', () => {
  it('browses a safe relative path, reads bounded text, and marks partial results read-only', async () => {
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => path === ''
        ? { path, entries: [directory('src'), file('README.md')], truncated: true }
        : { path, entries: [file('src/app.ts')], truncated: false }),
      read: vi.fn(async (_workspaceId, path, maxBytes) => ({
        path,
        content: 'export const answer = 42',
        truncated: maxBytes === 64 * 1024,
      })),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-1" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    expect(await within(section).findByRole('button', { name: /src Folder/ })).toBeInTheDocument()
    expect(screen.getByText(/more entries than the 100-item preview limit/i)).toBeInTheDocument()
    expect(screen.getByText('READ ONLY')).toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: /src Folder/ }))

    const appFile = await within(section).findByRole('button', { name: /app.ts 12 B/ })
    expect(filePort.list).toHaveBeenLastCalledWith('workspace-1', 'src', 100)
    fireEvent.click(appFile)
    expect(await screen.findByText('export const answer = 42')).toBeInTheDocument()
    expect(filePort.read).toHaveBeenCalledWith('workspace-1', 'src/app.ts', 64 * 1024)
    expect(screen.getByText(/showing a partial preview/i)).toBeInTheDocument()
    expect(screen.getByText(/read-only preview · server-owned checkout/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save|write|edit/i })).not.toBeInTheDocument()
  })

  it('filters malformed paths and gives a clear binary-file error', async () => {
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => ({
        path,
        entries: [file('visible.txt'), file('../outside.txt'), file('different/name.txt')],
        truncated: false,
      })),
      read: vi.fn(async (_workspaceId, _path) => {
        throw Object.assign(new Error('unsupported binary content'), { httpStatus: 415 })
      }),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-2" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    fireEvent.click(await within(section).findByRole('button', { name: /visible.txt/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Binary files cannot be previewed as text.')
    expect(within(section).queryByText('../outside.txt')).not.toBeInTheDocument()
    expect(within(section).queryByText('different/name.txt')).not.toBeInTheDocument()
  })

  it('ignores stale directory and file reads after a newer selection wins', async () => {
    const oldDirectory = deferred<WorkspaceFileListing>()
    const oldRead = deferred<WorkspaceFileRead>()
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => {
        if (path === 'old') return oldDirectory.promise
        if (path === '') return { path, entries: [directory('old'), file('new.txt')], truncated: false }
        return { path, entries: [], truncated: false }
      }),
      read: vi.fn(async (_workspaceId, path) => path === 'old/old.txt'
        ? oldRead.promise
        : { path, content: 'new file wins', truncated: false }),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-3" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    fireEvent.click(await within(section).findByRole('button', { name: /old Folder/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Workspace root' }))
    expect(await within(section).findByRole('button', { name: /new.txt/ })).toBeInTheDocument()
    oldDirectory.resolve({ path: 'old', entries: [file('old/old.txt')], truncated: false })
    await waitFor(() => expect(within(section).queryByRole('button', { name: /old.txt/ })).not.toBeInTheDocument())

    fireEvent.click(within(section).getByRole('button', { name: /new.txt/ }))
    expect(await screen.findByText('new file wins')).toBeInTheDocument()
    // Start an old read from a valid row after navigating into the old folder; its late response is fenced out.
    fireEvent.click(within(section).getByRole('button', { name: /old Folder/ }))
    const oldFile = await within(section).findByRole('button', { name: /old.txt/ })
    fireEvent.click(oldFile)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace root' }))
    fireEvent.click(await within(section).findByRole('button', { name: /new.txt/ }))
    expect(await screen.findByText('new file wins')).toBeInTheDocument()
    oldRead.resolve({ path: 'old/old.txt', content: 'stale content', truncated: false })
    await waitFor(() => expect(screen.queryByText('stale content')).not.toBeInTheDocument())
  })

  it('shows explicit errors and retries a failed listing', async () => {
    let fails = true
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => {
        if (fails) throw new Error('network failed')
        return { path, entries: [file('available.txt')], truncated: false }
      }),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-4" readOnlyFilePort={filePort} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this folder.')
    fails = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry folder' }))
    expect(await screen.findByRole('button', { name: /available.txt/ })).toBeInTheDocument()
  })
})
