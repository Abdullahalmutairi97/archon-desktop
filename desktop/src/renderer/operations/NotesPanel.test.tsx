import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '../../shared/bridge/types'
import type { LiveScope } from '../live/useLiveServer'
import { nextNoteName, NOTE_AUTOSAVE_MS, NotesPanel } from './NotesPanel'

const note = (name: string, extra: Record<string, unknown> = {}) => ({
  name, path: `notes/${name}`, is_dir: false, is_symlink: false, restricted: false, size: 5,
  modified_at: '2026-09-01T10:00:00+00:00', mime: 'text/markdown', ...extra,
})

function harness(handler: (operation: string, payload: Record<string, unknown>) => unknown) {
  const invoke = vi.fn((operation: string, payload: Record<string, unknown>) => Promise.resolve().then(() => handler(operation, payload)))
  const describe = vi.fn(async () => ({ serverUrl: 'http://127.0.0.1:9700', configured: true, storageMode: 'memory', generation: 3 }))
  const bridge = { api: { invoke }, connection: { describe } } as unknown as DesktopBridge
  const scope: LiveScope = { bridge, generation: 3, serverUrl: 'http://127.0.0.1:9700', localPairingAvailable: false }
  return { invoke, scope }
}

const writes = (invoke: ReturnType<typeof harness>['invoke']) =>
  invoke.mock.calls.filter(([operation]) => operation === 'files.writeText').map(([, payload]) => payload)

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date(2026, 8, 29, 10, 0, 0))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function contentFor(path: unknown) {
  const content = path === 'notes/2026-09-28.md' ? 'yesterday' : 'older'
  return { path, content, size: content.length, read: content.length, truncated: false, binary: false }
}

describe('notes naming', () => {
  it('names a note by local date and steps past taken names', () => {
    const now = new Date(2026, 8, 29, 23, 30)
    expect(nextNoteName([], now)).toBe('2026-09-29.md')
    expect(nextNoteName(['2026-09-29.md'], now)).toBe('2026-09-29-2.md')
    expect(nextNoteName(['2026-09-29.md', '2026-09-29-2.md', '2026-09-29-3.md'], now)).toBe('2026-09-29-4.md')
  })
})

describe('notes panel', () => {
  it('lists only Markdown files and saves once, 900 ms after typing stops', async () => {
    const { invoke, scope } = harness((operation, payload) => {
      if (operation === 'files.list') return { root: '/home/o', path: 'notes', items: [note('2026-09-28.md'), note('draft.txt'), note('sub', { is_dir: true, mime: null, name: 'sub.md' })] }
      if (operation === 'files.read') return contentFor(payload.path)
      if (operation === 'files.writeText') return { ...contentFor(payload.path), content: payload.content }
      throw new Error(operation)
    })
    render(<NotesPanel scope={scope} />)
    await advance(0)
    expect(screen.getAllByRole('button', { name: /\.md$/ }).map((button) => button.textContent)).toEqual(['2026-09-28.md'])
    expect(screen.queryByText('draft.txt')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '2026-09-28.md' }))
    await advance(0)
    const editor = screen.getByLabelText('Note 2026-09-28.md')
    expect(editor).toHaveValue('yesterday')
    expect(editor).toHaveAttribute('dir', 'auto')

    fireEvent.change(editor, { target: { value: 'y' } })
    await advance(500)
    fireEvent.change(editor, { target: { value: 'ye' } })
    await advance(NOTE_AUTOSAVE_MS - 1)
    expect(writes(invoke)).toEqual([])
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
    await advance(1)
    expect(writes(invoke)).toEqual([{ path: 'notes/2026-09-28.md', content: 'ye' }])
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
  })

  it('flushes pending text before switching notes', async () => {
    const { invoke, scope } = harness((operation, payload) => {
      if (operation === 'files.list') return { root: '/home/o', path: 'notes', items: [note('2026-09-28.md'), note('2026-09-01.md')] }
      if (operation === 'files.read') return contentFor(payload.path)
      if (operation === 'files.writeText') return { ...contentFor(payload.path), content: payload.content }
      throw new Error(operation)
    })
    render(<NotesPanel scope={scope} />)
    await advance(0)
    fireEvent.click(screen.getByRole('button', { name: '2026-09-28.md' }))
    await advance(0)
    fireEvent.change(screen.getByLabelText('Note 2026-09-28.md'), { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: '2026-09-01.md' }))
    await advance(0)
    expect(writes(invoke)).toEqual([{ path: 'notes/2026-09-28.md', content: 'edited' }])
    expect(screen.getByLabelText('Note 2026-09-01.md')).toHaveValue('older')
    await advance(NOTE_AUTOSAVE_MS * 2)
    expect(writes(invoke)).toHaveLength(1)
  })

  it('flushes pending text when the panel closes', async () => {
    const { invoke, scope } = harness((operation, payload) => {
      if (operation === 'files.list') return { root: '/home/o', path: 'notes', items: [note('2026-09-28.md')] }
      if (operation === 'files.read') return contentFor(payload.path)
      if (operation === 'files.writeText') return { ...contentFor(payload.path), content: payload.content }
      throw new Error(operation)
    })
    const view = render(<NotesPanel scope={scope} />)
    await advance(0)
    fireEvent.click(screen.getByRole('button', { name: '2026-09-28.md' }))
    await advance(0)
    fireEvent.change(screen.getByLabelText('Note 2026-09-28.md'), { target: { value: 'last words' } })
    view.unmount()
    await advance(0)
    expect(writes(invoke)).toEqual([{ path: 'notes/2026-09-28.md', content: 'last words' }])
  })

  it('says honestly when a save fails and keeps the text', async () => {
    const { scope } = harness((operation, payload) => {
      if (operation === 'files.list') return { root: '/home/o', path: 'notes', items: [note('2026-09-28.md')] }
      if (operation === 'files.read') return contentFor(payload.path)
      throw new Error('socket closed')
    })
    render(<NotesPanel scope={scope} />)
    await advance(0)
    fireEvent.click(screen.getByRole('button', { name: '2026-09-28.md' }))
    await advance(0)
    fireEvent.change(screen.getByLabelText('Note 2026-09-28.md'), { target: { value: 'kept' } })
    await advance(NOTE_AUTOSAVE_MS)
    expect(screen.getByRole('alert')).toHaveTextContent('That note could not be saved')
    expect(screen.getByRole('status')).toHaveTextContent('Not saved')
    expect(screen.getByLabelText('Note 2026-09-28.md')).toHaveValue('kept')
  })

  it('creates the notes folder and a new dated note past a taken name', async () => {
    const { invoke, scope } = harness((operation) => {
      if (operation === 'files.list') return { root: '/home/o', path: 'notes', items: [note('2026-09-29.md')] }
      if (operation === 'files.mkdir') return { path: 'notes', created: true }
      if (operation === 'files.writeText') return { path: 'notes/2026-09-29-2.md', content: '', size: 0, read: 0, truncated: false, binary: false }
      throw new Error(operation)
    })
    render(<NotesPanel scope={scope} />)
    await advance(0)
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    await advance(0)
    expect(invoke.mock.calls.filter(([operation]) => operation === 'files.mkdir').map(([, payload]) => payload)).toEqual([{ path: 'notes' }])
    expect(writes(invoke)).toEqual([{ path: 'notes/2026-09-29-2.md', content: '' }])
    expect(screen.getByLabelText('Note 2026-09-29-2.md')).toHaveValue('')
  })

  it('treats a missing notes folder as no notes', async () => {
    const { scope } = harness((operation) => {
      if (operation === 'files.list') throw Object.assign(new Error('400'), { code: 'not_a_directory' })
      throw new Error(operation)
    })
    render(<NotesPanel scope={scope} />)
    await advance(0)
    expect(screen.getByText(/No notes yet/)).toBeInTheDocument()
  })

  it('deletes a note only after confirmation', async () => {
    const { invoke, scope } = harness((operation, payload) => {
      if (operation === 'files.list') return { root: '/home/o', path: 'notes', items: [note('2026-09-28.md')] }
      if (operation === 'files.read') return contentFor(payload.path)
      if (operation === 'files.delete') return { ok: true }
      throw new Error(operation)
    })
    render(<NotesPanel scope={scope} />)
    await advance(0)
    fireEvent.click(screen.getByRole('button', { name: '2026-09-28.md' }))
    await advance(0)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(invoke.mock.calls.some(([operation]) => operation === 'files.delete')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
    await advance(0)
    expect(invoke.mock.calls.filter(([operation]) => operation === 'files.delete').map(([, payload]) => payload))
      .toEqual([{ path: 'notes/2026-09-28.md', confirm: true }])
  })
})
