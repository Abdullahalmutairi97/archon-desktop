// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { ChatsPage } from './ChatsPage'

const api = {
  audioStatus: vi.fn(() => new Promise(() => undefined)),
  createTask: vi.fn(() => new Promise(() => undefined)),
}

const catalog = { current: { provider: 'openai', model: 'gpt-test' }, providers: [{ id: 'openai', models: ['gpt-test'] }], choices: [{ provider: 'openai', model: 'gpt-test' }] }

describe('ChatsPage', () => {
  it('keeps the chat list composer-free until New chat is chosen', async () => {
    render(<ChatsPage api={api as never} sessions={[]} tasks={[]} catalog={catalog} onOpen={vi.fn()} onCreated={vi.fn(async () => undefined)} />)
    expect(screen.queryByLabelText('Chat with Archon')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(await screen.findByLabelText('Chat with Archon')).toBeInTheDocument()
  })

  it('submits new conversations through the isolated chat-only task path', async () => {
    render(<ChatsPage api={api as never} sessions={[]} tasks={[]} catalog={catalog} onOpen={vi.fn()} onCreated={vi.fn(async () => undefined)} />)
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.change(await screen.findByLabelText('Chat with Archon'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send chat message' }))
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello', chat_only: true, skills: [] }))
  })
})
