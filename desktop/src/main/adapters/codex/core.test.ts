import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createCodexAdapterCore } from './index'

describe('Codex adapter core composition', () => {
  it('uses only an injected profile and does not start a Codex process during construction', async () => {
    const profileDirectory = await mkdtemp(join(tmpdir(), 'archon-codex-core-profile-'))
    const spawn = vi.fn(() => { throw new Error('the fake process must not start during construction') })
    const core = await createCodexAdapterCore({
      profileDirectory,
      appServer: { command: '/fixture/codex', env: { PATH: '/fixture/bin' }, spawn },
      approvals: {
        onPrompt: vi.fn(),
        isTaskActive: () => true,
        resolveContext: () => undefined,
      },
    })
    try {
      expect(await core.metadata.read()).toEqual({ version: 1, projects: [], sessions: [] })
      expect(spawn).not.toHaveBeenCalled()
      await expect(core.files.read('prime:session', 'anything')).rejects.toThrow(/owned Codex session/i)
    } finally {
      core.close()
      await rm(profileDirectory, { recursive: true, force: true })
    }
  })
})
