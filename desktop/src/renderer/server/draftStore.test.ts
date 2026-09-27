import { beforeEach, describe, expect, it } from 'vitest'
import { clearDraft, readDraft, writeDraft } from './draftStore'

describe('draftStore', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips and clears a draft', () => {
    writeDraft('workspace-a', 'src/a.ts', 'const a = 1')
    expect(readDraft('workspace-a', 'src/a.ts')).toBe('const a = 1')
    clearDraft('workspace-a', 'src/a.ts')
    expect(readDraft('workspace-a', 'src/a.ts')).toBeNull()
  })

  it('refuses an oversized draft and bounds the number of drafts', () => {
    writeDraft('w', 'big', 'x'.repeat(17 * 1024))
    expect(readDraft('w', 'big')).toBeNull()
    for (let index = 0; index < 12; index += 1) writeDraft('w', `f${index}`, `content-${index}`)
    let present = 0
    for (let index = 0; index < 12; index += 1) if (readDraft('w', `f${index}`) !== null) present += 1
    expect(present).toBeLessThanOrEqual(8)
    expect(readDraft('w', 'f11')).toBe('content-11')
  })
})
