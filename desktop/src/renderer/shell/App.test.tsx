import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './App'

describe('reconstruction preview shell', () => {
  afterEach(() => { cleanup(); localStorage.clear() })

  it('shows the parity caveat and distinct synthetic identities', () => {
    render(<App />)
    expect(screen.getByText('BASELINE PARITY UNVERIFIED')).toBeInTheDocument()
    expect(screen.getByText('SYNTHETIC FIXTURE DATA')).toBeInTheDocument()
    expect(screen.getAllByText(/Server fixture · Prime/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Study notes/ }))
    expect(screen.getAllByText(/Server fixture · Pi/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Local planning draft/ }))
    expect(screen.getAllByText(/THIS PC · Local Codex/).length).toBeGreaterThan(0)
  })

  it('keeps recovery review separate and applies workbench shortcuts', () => {
    render(<App />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Tasks' }))
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

  it('keeps IDE fixture text aligned with the selected local Codex scope', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Local planning draft/ }))
    fireEvent.keyDown(window, { key: '5', code: 'Digit5', ctrlKey: true })

    expect(screen.getByRole('tab', { name: /IDE/ })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.ide-context')).toHaveTextContent('THIS PC · Local Codex')
    expect(document.querySelector('.ide-editor pre')).not.toHaveTextContent('Server fixture · Prime')
  })

  it('opens an honest connection view in the browser preview', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Connection' }))
    expect(screen.getByRole('region', { name: 'Desktop connection' })).toBeInTheDocument()
    expect(screen.getByText('CONNECTION STATUS')).toBeInTheDocument()
    expect(screen.getByText(/requires the desktop bridge/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  })

  it('keeps server collections offline in the browser preview', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Server work' }))
    expect(screen.getByRole('region', { name: 'Server collections' })).toBeInTheDocument()
    expect(screen.getByText('SERVER DATA · PRIME TASKS')).toBeInTheDocument()
    expect(screen.getByText(/browser preview is offline/i)).toBeInTheDocument()
    expect(screen.queryByText('SERVER PROJECTS')).not.toBeInTheDocument()
  })
})
