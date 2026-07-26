export type ApprovalMode = 'auto' | 'approve' | 'plan'

const ORDER: ApprovalMode[] = ['auto', 'approve', 'plan']
const KEY = 'archon.session.approval-modes'

export function cycleApprovalMode(mode: ApprovalMode): ApprovalMode {
  return ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]
}

function readAll(): Record<string, ApprovalMode> {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) || '{}')
    if (!value || typeof value !== 'object') return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, ApprovalMode] => ORDER.includes(entry[1] as ApprovalMode)))
  } catch { return {} }
}

export function readApprovalMode(sessionId = 'new'): ApprovalMode {
  return readAll()[sessionId] || 'approve'
}

export function writeApprovalMode(sessionId: string, mode: ApprovalMode) {
  try { window.localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [sessionId]: mode })) } catch { /* unavailable */ }
}

export type ComposerVisibility = { approval: boolean; voice: boolean }

export function readComposerVisibility(): ComposerVisibility {
  return {
    approval: window.localStorage.getItem('archon.composer-approval') !== 'hidden',
    voice: window.localStorage.getItem('archon.composer-voice') !== 'hidden',
  }
}

export function writeComposerVisibility(value: ComposerVisibility) {
  window.localStorage.setItem('archon.composer-approval', value.approval ? 'shown' : 'hidden')
  window.localStorage.setItem('archon.composer-voice', value.voice ? 'shown' : 'hidden')
  window.dispatchEvent(new CustomEvent('archon:composer-visibility', { detail: value }))
}
