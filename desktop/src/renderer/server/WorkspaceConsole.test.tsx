import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceConsoleBridge } from '../../shared/bridge/types'
import { WorkspaceConsole } from './WorkspaceConsole'

afterEach(cleanup)

describe('WorkspaceConsole', () => {
  it('reuses the in-flight screen refresh after sending a line', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    let resolveScreen: ((value: { text: string; truncated: boolean }) => void) | undefined
    const bridge: WorkspaceConsoleBridge = {
      list: vi.fn(async () => [{ sessionId, state: 'running' as const, createdAt: '2026-09-27T00:00:00Z' }]),
      create: vi.fn(),
      screen: vi.fn(() => new Promise<{ text: string; truncated: boolean }>((resolve) => { resolveScreen = resolve })),
      sendLine: vi.fn(async () => true),
      interrupt: vi.fn(),
      stop: vi.fn(),
      attach: vi.fn(),
      claim: vi.fn(),
      attachScreen: vi.fn(),
      attachInput: vi.fn(),
      detach: vi.fn(),
    }

    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    await screen.findByRole('button', { name: 'Interrupt command' })
    await waitFor(() => expect(bridge.screen).toHaveBeenCalledOnce())

    fireEvent.change(screen.getByRole('textbox', { name: 'Send one line' }), { target: { value: 'do work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send line' }))
    await waitFor(() => expect(bridge.sendLine).toHaveBeenCalledOnce())
    expect(bridge.screen).toHaveBeenCalledOnce()

    resolveScreen?.({ text: 'latest refresh', truncated: false })
    expect(await screen.findByRole('status')).toHaveTextContent('Line sent once.')
    expect(bridge.screen).toHaveBeenCalledOnce()
  })

  it('does not retry an input line after an ambiguous send failure', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const bridge: WorkspaceConsoleBridge = {
      list: vi.fn(async () => [{ sessionId, state: 'running' as const, createdAt: '2026-09-27T00:00:00Z' }]),
      create: vi.fn(),
      screen: vi.fn(async () => ({ text: 'ready', truncated: false })),
      sendLine: vi.fn(async () => { throw new Error('reply lost') }),
      interrupt: vi.fn(async () => true),
      stop: vi.fn(),
      attach: vi.fn(),
      claim: vi.fn(),
      attachScreen: vi.fn(),
      attachInput: vi.fn(),
      detach: vi.fn(),
    }
    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    expect(await screen.findByText('ready')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Send one line' }), { target: { value: 'do work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send line' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('It was not retried.')
    await waitFor(() => expect(bridge.sendLine).toHaveBeenCalledTimes(1))
    expect(bridge.sendLine).toHaveBeenCalledWith({ workspaceId, sessionId, line: 'do work' })
  })

  it('interrupts the selected command once without closing its console session', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const bridge: WorkspaceConsoleBridge = {
      list: vi.fn(async () => [{ sessionId, state: 'running' as const, createdAt: '2026-09-27T00:00:00Z' }]),
      create: vi.fn(),
      screen: vi.fn(async () => ({ text: 'running command', truncated: false })),
      sendLine: vi.fn(),
      interrupt: vi.fn(async () => true),
      stop: vi.fn(),
      attach: vi.fn(),
      claim: vi.fn(),
      attachScreen: vi.fn(),
      attachInput: vi.fn(),
      detach: vi.fn(),
    }
    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    expect(await screen.findByText('running command')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt command' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Interrupt sent once.')
    expect(bridge.interrupt).toHaveBeenCalledOnce()
    expect(bridge.interrupt).toHaveBeenCalledWith({ workspaceId, sessionId })
    expect(screen.getByRole('combobox', { name: 'Console session' })).toHaveValue(sessionId)
    expect(bridge.stop).not.toHaveBeenCalled()
  })

  it('does not retry an ambiguous interrupt and tells the user to refresh before retrying', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const bridge: WorkspaceConsoleBridge = {
      list: vi.fn(async () => [{ sessionId, state: 'running' as const, createdAt: '2026-09-27T00:00:00Z' }]),
      create: vi.fn(),
      screen: vi.fn(async () => ({ text: 'running command', truncated: false })),
      sendLine: vi.fn(),
      interrupt: vi.fn(async () => { throw new Error('outcome unknown') }),
      stop: vi.fn(),
      attach: vi.fn(),
      claim: vi.fn(),
      attachScreen: vi.fn(),
      attachInput: vi.fn(),
      detach: vi.fn(),
    }
    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    expect(await screen.findByText('running command')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt command' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('It was not retried. Refresh the screen before any manual retry.')
    expect(bridge.interrupt).toHaveBeenCalledOnce()
    expect(screen.getByRole('combobox', { name: 'Console session' })).toHaveValue(sessionId)
  })

  it('waits for a running session before accepting input or an interrupt', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const bridge: WorkspaceConsoleBridge = {
      list: vi.fn(async () => [{ sessionId, state: 'starting' as const, createdAt: '2026-09-27T00:00:00Z' }]),
      create: vi.fn(),
      screen: vi.fn(),
      sendLine: vi.fn(),
      interrupt: vi.fn(),
      stop: vi.fn(),
      attach: vi.fn(),
      claim: vi.fn(),
      attachScreen: vi.fn(),
      attachInput: vi.fn(),
      detach: vi.fn(),
    }
    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    expect(await screen.findByRole('button', { name: 'Interrupt command' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Send one line' })).toBeDisabled()
    expect(bridge.interrupt).not.toHaveBeenCalled()
  })

  it('opens a one-use attach lease, sends a control key, and detaches without stopping the shell', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const attachId = `watt-${'c'.repeat(32)}`
    const bridge: WorkspaceConsoleBridge = {
      list: vi.fn(async () => [{ sessionId, state: 'running' as const, createdAt: '2026-09-27T00:00:00Z' }]),
      create: vi.fn(),
      screen: vi.fn(async () => ({ text: 'pane', truncated: false })),
      sendLine: vi.fn(),
      interrupt: vi.fn(),
      stop: vi.fn(),
      attach: vi.fn(async () => ({ ticket: attachId, mode: 'control' as const, expiresAt: '2026-09-27T00:00:30Z' })),
      claim: vi.fn(async () => ({ attachId, mode: 'control' as const, expiresAt: '2026-09-27T00:02:00Z' })),
      attachScreen: vi.fn(),
      attachInput: vi.fn(async () => true),
      detach: vi.fn(async () => true),
    }
    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    fireEvent.click(await screen.findByRole('button', { name: 'Attach control' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Interactive control attached.')
    expect(bridge.attach).toHaveBeenCalledWith({ workspaceId, sessionId, expectedGeneration: 3, mode: 'control' })
    expect(bridge.claim).toHaveBeenCalledWith({ workspaceId, sessionId, ticket: attachId })

    fireEvent.click(screen.getByRole('button', { name: 'Ctrl-C' }))
    await waitFor(() => expect(bridge.attachInput).toHaveBeenCalledWith({
      workspaceId, sessionId, attachId, events: [{ type: 'key', value: 'C-c' }],
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Detach' }))
    await waitFor(() => expect(bridge.detach).toHaveBeenCalledWith({ workspaceId, sessionId, attachId }))
    expect(bridge.stop).not.toHaveBeenCalled()
  })

  it('keeps input controls disabled for a read-only attach', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const sessionId = `wterm-${'b'.repeat(32)}`
    const attachId = `watt-${'c'.repeat(32)}`
    const bridge: WorkspaceConsoleBridge = {
      list: vi.fn(async () => [{ sessionId, state: 'running' as const, createdAt: '2026-09-27T00:00:00Z' }]),
      create: vi.fn(),
      screen: vi.fn(async () => ({ text: 'pane', truncated: false })),
      sendLine: vi.fn(),
      interrupt: vi.fn(),
      stop: vi.fn(),
      attach: vi.fn(async () => ({ ticket: attachId, mode: 'read-only' as const, expiresAt: '2026-09-27T00:00:30Z' })),
      claim: vi.fn(async () => ({ attachId, mode: 'read-only' as const, expiresAt: '2026-09-27T00:02:00Z' })),
      attachScreen: vi.fn(),
      attachInput: vi.fn(async () => true),
      detach: vi.fn(async () => true),
    }
    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    fireEvent.click(await screen.findByRole('button', { name: 'Attach read-only' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Read-only attach open.')
    expect(screen.getByLabelText('Interactive input')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Ctrl-C' })).toBeDisabled()
    expect(bridge.attachInput).not.toHaveBeenCalled()
  })
})
