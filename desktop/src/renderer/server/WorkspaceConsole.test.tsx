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
    }
    render(<WorkspaceConsole bridge={bridge} workspaceId={workspaceId} generation={3} pairingAvailable />)
    expect(await screen.findByRole('button', { name: 'Interrupt command' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Send one line' })).toBeDisabled()
    expect(bridge.interrupt).not.toHaveBeenCalled()
  })
})
