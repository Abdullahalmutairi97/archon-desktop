import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, LocalCodexEvent } from '../../shared/bridge/types'
import { App } from './App'

describe('reconstruction preview shell', () => {
  afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, 'archon') })

  it('starts with three primary live routes and keeps all fixture content behind Preview/demo', () => {
    render(<App />)
    const main = within(screen.getByRole('navigation', { name: 'Main' }))
    expect(main.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Local Codex', 'Server work', 'Connection'])
    expect(main.getByRole('button', { name: 'Local Codex' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Preview/demo' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Demo views' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Local planning draft/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace tools' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open workbench activity' })).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveClass('workspace-main-live')
    expect(screen.getByRole('region', { name: 'Local Codex' })).toHaveTextContent('Browser preview is offline')

    fireEvent.click(screen.getByRole('button', { name: 'Preview/demo' }))
    expect(screen.getByRole('navigation', { name: 'Demo views' })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Sample data only')
    expect(screen.getByRole('complementary', { name: 'Workspace tools' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Synthetic chat transcript' })).toBeInTheDocument()
  })

  it('shows the parity caveat and distinct synthetic identities', () => {
    render(<App />)
    expect(screen.getByText('BASELINE PARITY UNVERIFIED')).toBeInTheDocument()
    expect(screen.getByText('LOCAL CODEX · ONE TURN')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview/demo' }))
    expect(screen.getByText('SYNTHETIC FIXTURE DATA')).toBeInTheDocument()
    expect(screen.getAllByText(/Server fixture · Prime/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Study notes/ }))
    expect(screen.getAllByText(/Server fixture · Pi/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Local planning draft/ }))
    expect(screen.getAllByText(/THIS PC · Local Codex/).length).toBeGreaterThan(0)
  })

  it('keeps recovery review separate and applies workbench shortcuts', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview/demo' }))
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Demo views' })).getByRole('button', { name: 'Demo tasks' }))
    expect(screen.getAllByText('Review required')).toHaveLength(2)
    expect(screen.getByText(/not described as running, complete, or safe to retry/i)).toBeInTheDocument()

    fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true })
    expect(screen.getByRole('tab', { name: /Files/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/nothing is opened from disk/i)).toBeInTheDocument()
  })

  it('supports theme, RTL, and sidebar controls from the local appearance dialog', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Open appearance settings' })[0])
    fireEvent.click(screen.getByRole('button', { name: '120%' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ivory' }))
    fireEvent.click(screen.getByRole('button', { name: 'RTL' }))
    expect(document.querySelector('.shell-app')).toHaveAttribute('data-theme', 'ivory')
    expect(document.querySelector('.shell-app')).toHaveStyle({ '--font-scale': '1.2' })
    expect(document.querySelector('.workspace-main')).toHaveAttribute('dir', 'rtl')
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true })
    expect(document.querySelector('.workspace-frame')).toHaveClass('sidebar-is-collapsed')
  })

  it('keeps appearance and command palette mutually exclusive, with Escape closing the top layer', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Open appearance settings' })[0])
    expect(screen.getByRole('dialog', { name: 'Appearance' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(screen.queryByRole('dialog', { name: 'Appearance' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Quick actions' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Quick actions' })).not.toBeInTheDocument()
  })

  it('opens an honest connection view in the browser preview', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection' }))
    expect(screen.getByRole('region', { name: 'Desktop connection' })).toBeInTheDocument()
    expect(screen.getByText('CONNECTION STATUS')).toBeInTheDocument()
    expect(screen.getByText(/requires the desktop bridge/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(screen.queryByRole('complementary', { name: 'Workspace tools' })).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveClass('workspace-main-live')
  })

  it('keeps server collections offline in the browser preview', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Server work' }))
    expect(screen.getByRole('region', { name: 'Server collections' })).toBeInTheDocument()
    expect(screen.getByText('SERVER CHECKOUTS · LINE CONSOLE')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Server collections' })).getByText(/browser preview is offline/i)).toBeInTheDocument()
    expect(screen.queryByText('SERVER PROJECTS')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace tools' })).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveClass('workspace-main-live')
  })

  it('moves workbench shortcuts into the demo area and removes it again on live routes', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', ctrlKey: true })
    expect(screen.getByRole('button', { name: 'Preview/demo' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('note')).toHaveTextContent('Sample data only')
    expect(screen.getByRole('tab', { name: /Files/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Local Codex' }))
    expect(screen.queryByRole('complementary', { name: 'Workspace tools' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Demo views' })).not.toBeInTheDocument()
  })

  it('puts live work first in quick actions and groups fixtures under one demo entry', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true })
    const palette = within(screen.getByRole('dialog', { name: 'Quick actions' }))
    expect(palette.queryByRole('button', { name: 'Browse sessions' })).not.toBeInTheDocument()
    expect(palette.queryByRole('button', { name: 'Open synthetic files' })).not.toBeInTheDocument()
    fireEvent.click(palette.getByRole('button', { name: 'Open Preview/demo' }))
    expect(screen.getByRole('note')).toHaveTextContent('Sample data only')
    expect(screen.getByRole('button', { name: 'Preview/demo' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps a local turn subscribed and approvals visible while navigating every other area', async () => {
    let listener: ((event: LocalCodexEvent) => void) | undefined
    const unsubscribe = vi.fn()
    const project = { id: 'codex-project:one', name: 'Live local project', rootPath: '/work/local' }
    const turn = { taskId: 'codex-task:one', projectId: project.id, sessionId: 'codex:one', state: 'running' as const }
    const localCodex = {
      listProjects: vi.fn(async () => [project]),
      subscribe: vi.fn((callback: (event: LocalCodexEvent) => void) => { listener = callback; return unsubscribe }),
      startTurn: vi.fn(async () => turn),
      answerApproval: vi.fn(async () => true),
    }
    const bridge = { localCodex, connection: { describe: vi.fn(async () => ({ configured: false, serverUrl: null, storageMode: 'unavailable', generation: 0 })) } } as unknown as DesktopBridge
    Object.defineProperty(window, 'archon', { value: bridge, configurable: true })
    render(<App />)
    // With the desktop bridge the app opens on server conversations.
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Local Codex' }))
    await screen.findByRole('option', { name: project.name })
    fireEvent.change(screen.getByLabelText('Local prompt'), { target: { value: 'Inspect the local project' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex turn' }))
    await screen.findByText('Running')

    for (const route of ['Server work', 'Connection', 'Sessions', 'Chat']) {
      fireEvent.click(screen.getByRole('button', { name: route }))
      await act(async () => {})
      expect(localCodex.subscribe).toHaveBeenCalledTimes(1)
      expect(unsubscribe).not.toHaveBeenCalled()
    }
    act(() => listener?.({ type: 'turn.output', taskId: turn.taskId, text: 'Local progress persisted' }))
    act(() => listener?.({ type: 'approval.requested', approval: { approvalId: 'approval:one', taskId: turn.taskId, projectId: project.id, kind: 'command', reason: 'Run local check', cwd: project.rootPath, paths: [], command: 'npm test' } }))
    expect(screen.getByRole('dialog', { name: 'Approve command?' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: 'approval:one', allow: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Local Codex' }))
    expect(screen.getByLabelText('Codex output')).toHaveTextContent('Local progress persisted')
    expect(localCodex.startTurn).toHaveBeenCalledTimes(1)
    expect(localCodex.subscribe).toHaveBeenCalledTimes(1)
  })
})
