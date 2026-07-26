// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

import { TerminalDock } from './TerminalDock'

vi.mock('./TerminalViewport', () => ({
  TerminalViewport: ({ name }: { name: string }) => <div data-testid="live-terminal">connected:{name}</div>,
}))

describe('TerminalDock', () => {
  it('renders a live terminal in the bench and creates a shell without leaving the current page', async () => {
    const api = {
      terminals: vi.fn(async () => []),
      createTerminal: vi.fn(async () => ({ name: 'archon-shell', label: 'Shell', cwd: '/home/archon' })),
    }

    render(<TerminalDock api={api as never} connection={{ url: 'http://127.0.0.1:8765', token: 'test' }} />)
    fireEvent.click(await screen.findByRole('button', { name: /create shell/i }))

    await waitFor(() => expect(api.createTerminal).toHaveBeenCalled())
    expect(await screen.findByTestId('live-terminal')).toHaveTextContent('connected:archon-shell')
    expect(screen.getByRole('region', { name: /interactive terminal/i })).toBeInTheDocument()
  })
})
