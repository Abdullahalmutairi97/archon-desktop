import { cycleApprovalMode, readApprovalMode, readComposerVisibility, writeApprovalMode, writeComposerVisibility } from './composerPreferences'

describe('per-session approval modes', () => {
  beforeEach(() => localStorage.clear())

  it('cycles in the fixed Auto, Approve steps, Plan mode order', () => {
    expect(cycleApprovalMode('auto')).toBe('approve')
    expect(cycleApprovalMode('approve')).toBe('plan')
    expect(cycleApprovalMode('plan')).toBe('auto')
  })

  it('persists independently for each server-owned session', () => {
    writeApprovalMode('session-a', 'plan')
    writeApprovalMode('session-b', 'auto')
    expect(readApprovalMode('session-a')).toBe('plan')
    expect(readApprovalMode('session-b')).toBe('auto')
    expect(readApprovalMode('session-c')).toBe('approve')
  })

  it('uses one persisted switch for both voice controls and a separate approval switch', () => {
    expect(readComposerVisibility()).toEqual({ approval: true, voice: true })
    writeComposerVisibility({ approval: false, voice: false })
    expect(readComposerVisibility()).toEqual({ approval: false, voice: false })
    expect(localStorage.getItem('archon.composer-voice')).toBe('hidden')
  })
})