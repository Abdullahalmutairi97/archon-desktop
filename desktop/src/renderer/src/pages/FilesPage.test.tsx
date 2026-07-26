// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { FilesPage } from './FilesPage'

const textFile = { name:'notes.md', path:'docs/notes.md', is_dir:false, restricted:false, size:12, modified_at:'2026-07-26T00:00:00Z', mime:'text/markdown' }
const otherFile = { ...textFile, name:'other.txt', path:'docs/other.txt', mime:'text/plain' }
const directory = { name:'docs', path:'docs', is_dir:true, restricted:false, size:0, modified_at:'2026-07-26T00:00:00Z' }

function makeApi() {
  return {
    files: vi.fn(async (path:string) => path === '.' ? [directory] : [textFile, otherFile]),
    readFile: vi.fn(async (path:string) => ({ content: path.includes('other') ? 'other' : 'hello', size:5 })),
    writeFile: vi.fn(async (_path:string, content:string) => ({ content, size:content.length })),
    downloadFile: vi.fn(async () => new Blob(['image'], { type:'image/png' })),
    uploadFile: vi.fn(), deleteFile: vi.fn(),
  }
}

describe('FilesPage', () => {
  it('navigates paths, opens text, edits and saves the selected file', async () => {
    const api = makeApi()
    render(<FilesPage api={api as never}/>)
    fireEvent.click(await screen.findByRole('button', { name:/docs/i }))
    fireEvent.click(await screen.findByRole('button', { name:/notes\.md/i }))
    const editor = await screen.findByRole('textbox', { name:'File content' })
    expect(editor).toHaveValue('hello')
    fireEvent.change(editor, { target:{ value:'changed' } })
    fireEvent.click(screen.getByRole('button', { name:/Save/i }))
    fireEvent.click(await screen.findByRole('button', { name:'Save file' }))
    await waitFor(() => expect(api.writeFile).toHaveBeenCalledWith('docs/notes.md', 'changed'))
  })

  it('protects unsaved changes when another path is selected', async () => {
    const api = makeApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<FilesPage api={api as never}/>)
    fireEvent.click(await screen.findByRole('button', { name:/docs/i }))
    fireEvent.click(await screen.findByRole('button', { name:/notes\.md/i }))
    fireEvent.change(await screen.findByRole('textbox', { name:'File content' }), { target:{ value:'changed' } })
    fireEvent.click(screen.getByRole('button', { name:/other\.txt/i }))
    expect(confirm).toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name:'File content' })).toHaveValue('changed')
    confirm.mockRestore()
  })

  it('surfaces read failures without presenting the error as editable file content', async () => {
    const api = makeApi(); api.readFile.mockRejectedValueOnce(new Error('read denied'))
    render(<FilesPage api={api as never}/>)
    fireEvent.click(await screen.findByRole('button', { name:/docs/i }))
    fireEvent.click(await screen.findByRole('button', { name:/notes\.md/i }))
    expect(await screen.findByText('read denied')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name:'File content' })).not.toBeInTheDocument()
  })

  it('previews supported images safely without decoding them as text', async () => {
    const image = { ...textFile, name:'screen.png', path:'docs/screen.png', mime:'image/png' }
    const api = makeApi(); api.files.mockResolvedValue([image]);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
    render(<FilesPage api={api as never}/>)
    fireEvent.click(await screen.findByRole('button', { name:/screen\.png/i }))
    expect(await screen.findByRole('img', { name:'Preview screen.png' })).toHaveAttribute('src', 'blob:preview')
    expect(api.readFile).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
