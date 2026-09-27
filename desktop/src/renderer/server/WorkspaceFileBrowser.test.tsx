import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileBrowser, type WorkspaceFileDiff, type WorkspaceFileListing, type WorkspaceFileRead, type WorkspaceReadOnlyFilePort } from './WorkspaceFileBrowser'

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
  search = vi.fn(async () => ({ hits: [], files_scanned: 0, bytes_scanned: 0, truncated: false })),
  write,
  create,
  diff,
}: {
  list?: WorkspaceReadOnlyFilePort['list']
  read?: WorkspaceReadOnlyFilePort['read']
  search?: WorkspaceReadOnlyFilePort['search']
  write?: WorkspaceReadOnlyFilePort['write']
  create?: WorkspaceReadOnlyFilePort['create']
  diff?: WorkspaceReadOnlyFilePort['diff']
} = {}) {
  return { list, read, search, ...(write ? { write } : {}), ...(create ? { create } : {}), ...(diff ? { diff } : {}) }
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
  it('shows a bounded selected-file Git diff and ignores a stale response after selection changes', async () => {
    const firstDiff = deferred<WorkspaceFileDiff>()
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => ({ path, entries: [file('first.txt'), file('second.txt')], truncated: false })),
      read: vi.fn(async (_workspaceId, path) => ({ path, content: path, truncated: false })),
      diff: vi.fn(async (_workspaceId, path) => path === 'first.txt'
        ? firstDiff.promise : { path, diff: '@@ -1 +1 @@\n-old\n+new', truncated: true }),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-diff" readOnlyFilePort={filePort} />)
    const entries = screen.getByRole('region', { name: 'Workspace directory entries' })
    fireEvent.click(await within(entries).findByRole('button', { name: /first.txt/ }))
    await screen.findByText('first.txt', { selector: 'pre' })
    fireEvent.click(screen.getByRole('button', { name: 'Show Git diff' }))
    expect(filePort.diff).toHaveBeenCalledWith('workspace-diff', 'first.txt')
    fireEvent.click(within(entries).getByRole('button', { name: /second.txt/ }))
    await screen.findByText('second.txt', { selector: 'pre' })
    firstDiff.resolve({ path: 'first.txt', diff: 'stale diff', truncated: false })
    await waitFor(() => expect(screen.queryByText('stale diff')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Show Git diff' }))
    const shownDiff = await screen.findByRole('region', { name: 'Selected file Git diff' })
    expect(shownDiff.querySelector('pre')).toHaveTextContent('-old +new')
    expect(screen.getByText('Diff stopped at a safety limit.')).toBeInTheDocument()
  })

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

  it('searches the workspace with bounded path-and-line hits, reports partial results, and opens the exact file', async () => {
    const filePort = port({
      read: vi.fn(async (_workspaceId, path) => ({
        path,
        content: 'first line\nsecond line\nfunction makeAgent() {}\n',
        truncated: false,
      })),
      search: vi.fn(async (_workspaceId, query) => ({
        hits: [{ path: 'src/agent.ts', line: 3 }],
        files_scanned: query === 'agent' ? 17 : 0,
        bytes_scanned: 4096,
        truncated: true,
      })),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-search" readOnlyFilePort={filePort} />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find code' }), { target: { value: 'agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    const hit = await screen.findByText('src/agent.ts')
    expect(filePort.search).toHaveBeenCalledWith('workspace-search', 'agent')
    expect(screen.getByText(/these results may be incomplete/i)).toBeInTheDocument()
    fireEvent.click(hit)

    expect(await screen.findByText(/function makeAgent\(\)/u)).toBeInTheDocument()
    expect(screen.getByText(/Search match on line 3/u)).toBeInTheDocument()
    expect(filePort.read).toHaveBeenCalledWith('workspace-search', 'src/agent.ts', 64 * 1024)
  })

  it('saves a small complete text file with its original content and updates the preview', async () => {
    const pendingWrite = deferred<{ path: string; content: string }>()
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => ({ path, entries: [file('README.md', 5)], truncated: false })),
      read: vi.fn(async (_workspaceId, path) => ({ path, content: 'hello', truncated: false })),
      write: vi.fn(() => pendingWrite.promise),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-edit" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    fireEvent.click(await within(section).findByRole('button', { name: 'README.md 5 B' }))
    expect(await screen.findByText('hello')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    const editor = screen.getByRole('textbox', { name: 'Edit README.md' })
    expect(screen.getByText(/no changes/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(editor, { target: { value: 'updated text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(filePort.write).toHaveBeenCalledTimes(1)
    expect(filePort.write).toHaveBeenCalledWith('workspace-edit', 'README.md', 'hello', 'updated text')
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    await act(async () => {
      pendingWrite.resolve({ path: 'README.md', content: 'updated text' })
      await pendingWrite.promise
    })
    expect(await screen.findByText('updated text')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Edit README.md' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('creates a bounded text file at a safe relative path, refreshes, and selects it', async () => {
    const create = vi.fn(async (_workspaceId: string, path: string, content: string) => ({ path, content }))
    const list = vi.fn(async (_workspaceId: string, path: string) => ({
      path,
      entries: path === '' && list.mock.calls.length > 1 ? [file('new.md', 11)] : [],
      truncated: false,
    }))
    const read = vi.fn(async (_workspaceId: string, path: string) => ({ path, content: '# New note', truncated: false }))
    const filePort = port({ list, read, create })
    render(<WorkspaceFileBrowser workspaceId="workspace-create" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    await within(section).findByText('This folder is empty.')
    fireEvent.click(screen.getByRole('button', { name: 'New text file' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Relative file path' }), { target: { value: 'new.md' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'New file content' }), { target: { value: '# New note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create file' }))

    expect(create).toHaveBeenCalledWith('workspace-create', 'new.md', '# New note')
    await waitFor(() => expect(read).toHaveBeenCalledWith('workspace-create', 'new.md', 64 * 1024))
    expect(await screen.findByText('# New note')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'new.md 11 B' })).toHaveAttribute('aria-pressed', 'true')
    // The refresh after a create is one extra mocked call. Allow for a loaded
    // machine rather than the default one-second wait, which is not a property of
    // the component under test.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2), { timeout: 5000 })
  })

  it('rejects unsafe paths and oversized text, then distinguishes collisions from uncertain results', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('already exists'), { code: 'write_conflict' }))
      .mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'network_error' }))
    const filePort = port({ create })
    render(<WorkspaceFileBrowser workspaceId="workspace-create-errors" readOnlyFilePort={filePort} />)

    fireEvent.click(await screen.findByRole('button', { name: 'New text file' }))
    const pathInput = screen.getByRole('textbox', { name: 'Relative file path' })
    const contentInput = screen.getByRole('textbox', { name: 'New file content' })
    const submit = screen.getByRole('button', { name: 'Create file' })
    fireEvent.change(pathInput, { target: { value: '../outside.txt' } })
    fireEvent.change(contentInput, { target: { value: 'text' } })
    fireEvent.click(submit)
    expect(create).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent('Use one safe file name in this folder.')

    fireEvent.change(pathInput, { target: { value: 'notes.txt' } })
    fireEvent.change(contentInput, { target: { value: '😀'.repeat(4_097) } })
    expect(screen.getByRole('alert')).toHaveTextContent('This file exceeds the 12,000 character or 16 KiB create limit.')
    expect(create).not.toHaveBeenCalled()

    fireEvent.change(contentInput, { target: { value: 'unsafe\u0001text' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Remove unsupported control characters. Tabs and line breaks are allowed.')
    expect(create).not.toHaveBeenCalled()

    fireEvent.change(contentInput, { target: { value: 'text' } })
    fireEvent.click(submit)
    expect(await screen.findByRole('alert')).toHaveTextContent('That file already exists. Choose a different path.')
    expect(create).toHaveBeenCalledTimes(1)

    fireEvent.change(pathInput, { target: { value: 'other.txt' } })
    fireEvent.click(submit)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm whether this file was created. Refresh its folder before trying again.')
    expect(create).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Refresh folder' })).toBeInTheDocument()
  })

  it('shows a stale-content conflict and reloads the latest file without retrying the write', async () => {
    const read = vi.fn(async (_workspaceId: string, path: string) => ({
      path,
      content: read.mock.calls.length === 1 ? 'original' : 'changed on server',
      truncated: false,
    }))
    const write = vi.fn(async () => { throw Object.assign(new Error('stale content'), { code: 'write_conflict' }) })
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => ({ path, entries: [file('notes.txt')], truncated: false })),
      read,
      write,
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-conflict" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    fireEvent.click(await within(section).findByRole('button', { name: 'notes.txt 12 B' }))
    expect(await screen.findByText('original')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes.txt' }), { target: { value: 'my changes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('This file changed on the server. Reload it before saving your changes.')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(write).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reload file' }))
    expect(await screen.findByText('changed on server')).toBeInTheDocument()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('treats an uncertain save as requiring a reload and never retries automatically', async () => {
    const read = vi.fn(async (_workspaceId: string, path: string) => ({
      path,
      content: read.mock.calls.length === 1 ? 'original' : 'saved remotely',
      truncated: false,
    }))
    const write = vi.fn(async () => { throw Object.assign(new Error('connection lost'), { code: 'network_error' }) })
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => ({ path, entries: [file('notes.txt')], truncated: false })),
      read,
      write,
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-uncertain" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    fireEvent.click(await within(section).findByRole('button', { name: 'notes.txt 12 B' }))
    expect(await screen.findByText('original')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes.txt' }), { target: { value: 'maybe saved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm whether this file was saved. Reload it before editing or retrying.')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(write).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reload file' }))
    expect(await screen.findByText('saved remotely')).toBeInTheDocument()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not let a late save response replace the newer file selection', async () => {
    const pendingWrite = deferred<{ path: string; content: string }>()
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => ({ path, entries: [file('first.txt'), file('second.txt')], truncated: false })),
      read: vi.fn(async (_workspaceId, path) => ({ path, content: `contents of ${path}`, truncated: false })),
      write: vi.fn(() => pendingWrite.promise),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-race" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    fireEvent.click(await within(section).findByRole('button', { name: 'first.txt 12 B' }))
    expect(await screen.findByText('contents of first.txt')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    fireEvent.click(within(section).getByRole('button', { name: 'second.txt 12 B' }))
    expect(await screen.findByText('contents of second.txt')).toBeInTheDocument()
    pendingWrite.resolve({ path: 'first.txt', content: 'contents of first.txt' })

    expect(await screen.findByText('contents of second.txt')).toBeInTheDocument()
    expect(screen.queryByText('contents of first.txt')).not.toBeInTheDocument()
  })

  it('keeps a bounded preview read-only when the server reports a truncated file', async () => {
    const filePort = port({
      list: vi.fn(async (_workspaceId, path) => ({ path, entries: [file('large.txt')], truncated: false })),
      read: vi.fn(async (_workspaceId, path) => ({ path, content: 'first part', truncated: true })),
      write: vi.fn(async (_workspaceId, path, _expectedContent, content) => ({ path, content })),
    })
    render(<WorkspaceFileBrowser workspaceId="workspace-large" readOnlyFilePort={filePort} />)

    const section = screen.getByRole('region', { name: 'Workspace directory entries' })
    fireEvent.click(await within(section).findByRole('button', { name: 'large.txt 12 B' }))

    expect(await screen.findByText('first part')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(filePort.write).not.toHaveBeenCalled()
  })
})
