// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

import { SkillsPage } from './SkillsPage'

describe('SkillsPage', () => {
  it('commits an enable change atomically and keeps the row and detail state in sync', async () => {
    const skill = { name: 'health', description: 'VPS health', category: 'ops', path: '/skills/health/SKILL.md', enabled: true }
    const api = {
      skills: vi.fn(async () => [skill]),
      inspectSkill: vi.fn(async () => ({ ...skill, content: '# Health' })),
      toggleSkill: vi.fn(async (_name: string, enabled: boolean) => ({ ...skill, enabled, content: '# Health' })),
    }

    render(<SkillsPage api={api as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /health/i }))
    const toggle = await screen.findByRole('switch', { name: /disable health/i })
    fireEvent.click(toggle)

    await waitFor(() => expect(api.toggleSkill).toHaveBeenCalledWith('health', false))
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })
})
