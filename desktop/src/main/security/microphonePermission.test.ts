import { describe, expect, it } from 'vitest'
import { MICROPHONE_ACTIVATION_WINDOW_MS, MicrophonePermissionGate } from './microphonePermission'
import { TrustedShellFrameGuard, type ShellFrameLike, type ShellWebContentsLike, type ShellWindowLike } from './TrustedShellFrameGuard'

const trustedUrl = 'file:///app/renderer/index.html'

function setup() {
  const frame: ShellFrameLike & { url: string } = { url: trustedUrl, parent: null }
  const contents: ShellWebContentsLike = { id: 1, mainFrame: frame, isDestroyed: () => false }
  const window: ShellWindowLike = { webContents: contents, isDestroyed: () => false }
  const guard = new TrustedShellFrameGuard()
  guard.register(window, trustedUrl)
  let now = 1_000
  const gate = new MicrophonePermissionGate(guard, () => now)
  const audio = { isMainFrame: true, requestingUrl: trustedUrl, mediaTypes: ['audio'] }
  const click = () => gate.noteInput(contents, { type: 'mouseDown', button: 'left' })
  return { frame, contents, guard, gate, audio, click, advance: (ms: number) => { now += ms } }
}

describe('microphone permission', () => {
  it('grants audio-only media to the trusted main frame right after a click', () => {
    const { gate, contents, audio, click } = setup()
    click()
    expect(gate.decideRequest(contents, 'media', audio)).toBe(true)
  })

  it('accepts a keyboard activation of the focused button', () => {
    const { gate, contents, audio } = setup()
    gate.noteInput(contents, { type: 'keyDown', keyCode: 'Space' })
    expect(gate.decideRequest(contents, 'media', audio)).toBe(true)
  })

  it('denies without a preceding user activation, or after it expires', () => {
    const { gate, contents, audio, click, advance } = setup()
    expect(gate.decideRequest(contents, 'media', audio)).toBe(false)
    gate.noteInput(contents, { type: 'mouseMove' })
    gate.noteInput(contents, { type: 'keyDown', keyCode: 'A' })
    gate.noteInput(contents, { type: 'mouseDown', button: 'right' })
    expect(gate.decideRequest(contents, 'media', audio)).toBe(false)
    click()
    advance(MICROPHONE_ACTIVATION_WINDOW_MS + 1)
    expect(gate.decideRequest(contents, 'media', audio)).toBe(false)
  })

  it('allows one request per activation', () => {
    const { gate, contents, audio, click } = setup()
    click()
    expect(gate.decideRequest(contents, 'media', audio)).toBe(true)
    expect(gate.decideRequest(contents, 'media', audio)).toBe(false)
  })

  it('denies video, mixed or unknown media types even after a click', () => {
    const { gate, contents, audio, click } = setup()
    for (const mediaTypes of [['video'], ['audio', 'video'], [], undefined, 'audio', [['audio']]]) {
      click()
      expect(gate.decideRequest(contents, 'media', { ...audio, mediaTypes })).toBe(false)
    }
  })

  it('denies subframes, other documents and other webContents', () => {
    const { gate, contents, audio, click } = setup()
    const other: ShellWebContentsLike = { id: 2, mainFrame: { url: trustedUrl, parent: null }, isDestroyed: () => false }
    for (const [target, details] of [
      [contents, { ...audio, isMainFrame: false }],
      [contents, { ...audio, requestingUrl: 'https://evil.test/' }],
      [contents, { ...audio, requestingUrl: `${trustedUrl}?x=1` }],
      [other, audio],
      [contents, null],
    ] as const) {
      click()
      gate.noteInput(other, { type: 'mouseDown', button: 'left' })
      expect(gate.decideRequest(target, 'media', details)).toBe(false)
    }
  })

  it('denies an activation recorded on a different webContents', () => {
    const { gate, contents, audio } = setup()
    const other: ShellWebContentsLike = { id: 2, mainFrame: { url: trustedUrl, parent: null }, isDestroyed: () => false }
    gate.noteInput(other, { type: 'mouseDown', button: 'left' })
    expect(gate.decideRequest(contents, 'media', audio)).toBe(false)
  })

  it('denies every other permission and every permission check', () => {
    const { gate, contents, audio, click } = setup()
    for (const permission of ['notifications', 'geolocation', 'display-capture', 'clipboard-read', 'openExternal', 'fullscreen']) {
      click()
      expect(gate.decideRequest(contents, permission, audio)).toBe(false)
    }
    expect(gate.decideCheck()).toBe(false)
  })

  it('denies after the trusted frame navigates or is replaced', () => {
    const { gate, guard, contents, frame, audio, click } = setup()
    guard.invalidateNavigation(contents)
    click()
    expect(gate.decideRequest(contents, 'media', audio)).toBe(false)

    const fresh = setup()
    fresh.frame.url = 'https://evil.test/'
    fresh.click()
    expect(fresh.gate.decideRequest(fresh.contents, 'media', { ...fresh.audio, requestingUrl: 'https://evil.test/' })).toBe(false)
    expect(frame.url).toBe(trustedUrl)
  })
})
