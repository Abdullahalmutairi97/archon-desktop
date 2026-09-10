// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import { IdePanel } from './IdePanel'
import type { Task } from '../lib/types'

const task = { id: 'task-1', cwd: '/workspace/demo', prompt: 'Build the app', status: 'completed', skills: [], created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z' } as Task

describe('IdePanel', () => {
  it('starts in the latest task workspace and opens a text file', async () => {
    const api = {
      files: vi.fn(async (path: string) => path === '/workspace/demo' ? [{ name: 'src', path: '/workspace/demo/src', is_dir: true, restricted: false, size: 0, modified_at: '' }, { name: 'README.md', path: '/workspace/demo/README.md', is_dir: false, restricted: false, size: 12, modified_at: '' }] : []),
      readFile: vi.fn(async () => ({ content: '# Demo' })),
      writeFile: vi.fn(async () => undefined),
    }
    render(<IdePanel api={api as never} tasks={[task]}/>)
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'README.md' }))
    expect(await screen.findByRole('textbox', { name: 'Edit README.md' })).toHaveValue('# Demo')
  })

  it('requires an explicit confirmation before saving edits', async () => {
    const api = {
      files: vi.fn(async () => [{ name: 'main.ts', path: '/workspace/demo/main.ts', is_dir: false, restricted: false, size: 12, modified_at: '' }]),
      readFile: vi.fn(async () => ({ content: 'const demo = true' })),
      writeFile: vi.fn(async () => undefined),
    }
    render(<IdePanel api={api as never} tasks={[task]}/>)
    fireEvent.click(await screen.findByRole('button', { name: 'main.ts' }))
    const editor = await screen.findByRole('textbox', { name: 'Edit main.ts' })
    fireEvent.change(editor, { target: { value: 'const demo = false' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('writes changes to /workspace/demo/main.ts')
    expect(api.writeFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(api.writeFile).toHaveBeenCalledWith('/workspace/demo/main.ts', 'const demo = false'))
  })

  it('keeps restricted and binary files read-only', async () => {
    const api = {
      files: vi.fn(async () => [{ name: '.env', path: '/workspace/demo/.env', is_dir: false, restricted: true, size: 10, modified_at: '' }, { name: 'image.png', path: '/workspace/demo/image.png', is_dir: false, restricted: false, size: 10, modified_at: '' }]),
      readFile: vi.fn(async () => ({ content: 'should not load' })),
      writeFile: vi.fn(async () => undefined),
    }
    render(<IdePanel api={api as never} tasks={[task]}/>)
    fireEvent.click(await screen.findByRole('button', { name: /\.env/ }))
    expect(await screen.findByRole('textbox', { name: 'Edit .env' })).toHaveAttribute('readonly')
    expect(api.readFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /image\.png/ }))
    expect(await screen.findByRole('textbox', { name: 'Edit image.png' })).toHaveAttribute('readonly')
  })
})
