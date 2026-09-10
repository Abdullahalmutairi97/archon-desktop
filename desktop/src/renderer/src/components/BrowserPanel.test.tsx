// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import { BrowserPanel, extractBrowserLinks } from './BrowserPanel'
import type { Task } from '../lib/types'

const tasks = [{
  id: 'task-1', prompt: 'Research the release notes at https://docs.example.com/start.',
  status: 'completed', result: { text: 'The agent found https://example.com/report and https://example.com/report.' },
  skills: [], created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z',
}] as Task[]

describe('BrowserPanel', () => {
  it('extracts unique HTTP links from prompts and results', () => {
    expect(extractBrowserLinks(tasks).map((link) => link.url)).toEqual([
      'https://example.com/report',
      'https://docs.example.com/start',
    ])
  })

  it('opens a surfaced agent link and supports direct URL navigation', () => {
    render(<BrowserPanel tasks={tasks}/>)
    expect(screen.getByText('Links from agent work')).toBeInTheDocument()
    expect(screen.getByTitle('https://example.com/report')).toBeInTheDocument()
    expect(screen.getByTitle('https://docs.example.com/start')).toBeInTheDocument()
    expect(screen.getByTitle('https://example.com/report').closest('button')).toBeTruthy()
    fireEvent.click(screen.getByTitle('https://example.com/report'))
    expect(screen.getByTitle(/Open in system browser/i)).toBeInTheDocument()
    expect(screen.getByTitle(/Open in system browser/i)).not.toBeDisabled()
    const input = screen.getByRole('textbox', { name: 'Browser address' })
    fireEvent.change(input, { target: { value: 'https://news.example.test/article' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByTitle(/Open in system browser/i)).not.toBeDisabled()
    expect(screen.getByTitle('Browser preview of https://news.example.test/article')).toBeInTheDocument()
  })

  it('rejects non-web protocols', () => {
    render(<BrowserPanel tasks={[]}/>)
    const input = screen.getByRole('textbox', { name: 'Browser address' })
    fireEvent.change(input, { target: { value: 'file:///etc/passwd' } })
    fireEvent.submit(input.closest('form')!)
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP or HTTPS')
    expect(screen.getByTitle('Open in system browser')).toBeDisabled()
  })

  it('can hand the current page to the system browser', () => {
    const openExternal = vi.fn()
    Object.defineProperty(window, 'archon', { configurable: true, value: { openExternal } })
    render(<BrowserPanel tasks={tasks}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Open in system browser' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/report')
  })
})
