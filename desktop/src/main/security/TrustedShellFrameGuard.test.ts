import { describe, expect, it } from 'vitest'
import {
  TrustedShellFrameGuard,
  type ShellFrameLike,
  type ShellWebContentsLike,
  type ShellWindowLike,
  type TrustedShellIpcEvent,
} from './TrustedShellFrameGuard'

const trustedUrl = 'file:///app/renderer/index.html'

function makeShell(url = trustedUrl) {
  const frame: { url: string; parent: ShellFrameLike | null; detached: boolean } = {
    url,
    parent: null,
    detached: false,
  }
  let currentFrame: ShellFrameLike = frame
  let contentsDestroyed = false
  let windowDestroyed = false
  const contents: ShellWebContentsLike & { mainFrame: ShellFrameLike } = {
    id: Math.floor(Math.random() * 1_000_000),
    get mainFrame() { return currentFrame },
    set mainFrame(value: ShellFrameLike) { currentFrame = value },
    isDestroyed: () => contentsDestroyed,
  }
  const window: ShellWindowLike = {
    webContents: contents,
    isDestroyed: () => windowDestroyed,
  }
  const event: TrustedShellIpcEvent = { sender: contents, senderFrame: frame }
  return {
    frame,
    contents,
    window,
    event,
    destroyWindow: () => { windowDestroyed = true },
    destroyContents: () => { contentsDestroyed = true },
  }
}

describe('TrustedShellFrameGuard', () => {
  it('accepts only the registered main frame at its trusted loaded document', () => {
    const shell = makeShell()
    const guard = new TrustedShellFrameGuard()
    guard.register(shell.window, trustedUrl)

    expect(() => guard.assertTrusted(shell.event)).not.toThrow()
  })

  it('rejects a same-origin child frame and a same-origin lookalike document', () => {
    const shell = makeShell('http://127.0.0.1:5173/')
    const guard = new TrustedShellFrameGuard()
    guard.register(shell.window, shell.frame.url)

    expect(() =>
      guard.assertTrusted({
        sender: shell.contents,
        senderFrame: { url: 'http://127.0.0.1:5173/', parent: shell.frame },
      }),
    ).toThrow('Untrusted IPC sender')
    expect(() =>
      guard.assertTrusted({
        sender: shell.contents,
        senderFrame: { url: 'http://127.0.0.1:5173/other.html', parent: null },
      }),
    ).toThrow('Untrusted IPC sender')
  })

  it('rejects a replaced frame, replaced window, and non-owner sender', () => {
    const shell = makeShell()
    const guard = new TrustedShellFrameGuard()
    guard.register(shell.window, trustedUrl)

    const replacedFrame: ShellFrameLike = { url: trustedUrl, parent: null }
    shell.contents.mainFrame = replacedFrame
    expect(() => guard.assertTrusted({ sender: shell.contents, senderFrame: replacedFrame })).toThrow(
      'Untrusted IPC sender',
    )

    const replacement = makeShell()
    guard.register(replacement.window, trustedUrl)
    expect(() => guard.assertTrusted(shell.event)).toThrow('Untrusted IPC sender')
    expect(() => guard.assertTrusted({ sender: shell.contents, senderFrame: replacement.frame })).toThrow(
      'Untrusted IPC sender',
    )
  })

  it('rejects stale events after top-level navigation and refuses an untrusted rebind', () => {
    const shell = makeShell('http://127.0.0.1:5173/')
    const guard = new TrustedShellFrameGuard()
    guard.register(shell.window, shell.frame.url)

    guard.invalidateNavigation(shell.contents)
    expect(() => guard.assertTrusted(shell.event)).toThrow('Untrusted IPC sender')

    shell.frame.url = 'http://127.0.0.1:5173/attacker.html'
    expect(() => guard.register(shell.window, 'http://127.0.0.1:5173/')).toThrow(
      'Untrusted IPC sender',
    )
  })

  it('revokes a binding when the window or its webContents is destroyed or closed', () => {
    const shell = makeShell()
    const guard = new TrustedShellFrameGuard()
    guard.register(shell.window, trustedUrl)
    shell.destroyWindow()
    expect(() => guard.assertTrusted(shell.event)).toThrow('Untrusted IPC sender')

    const next = makeShell()
    guard.register(next.window, trustedUrl)
    next.destroyContents()
    expect(() => guard.assertTrusted(next.event)).toThrow('Untrusted IPC sender')
  })

  it('ignores the URL fragment for same-document routing but rejects frame detachment', () => {
    const shell = makeShell('http://127.0.0.1:5173/')
    const guard = new TrustedShellFrameGuard()
    guard.register(shell.window, shell.frame.url)
    shell.frame.url = 'http://127.0.0.1:5173/#/projects'
    expect(() => guard.assertTrusted(shell.event)).not.toThrow()

    shell.frame.detached = true
    expect(() => guard.assertTrusted(shell.event)).toThrow('Untrusted IPC sender')
  })

  it('bounds structured payload shape, nesting, and serialized size', async () => {
    const { isBoundedIpcPayload } = await import('./TrustedShellFrameGuard')

    expect(isBoundedIpcPayload({ limit: 100, projectId: 'demo' })).toBe(true)
    expect(isBoundedIpcPayload({ value: 'x'.repeat(16_385) })).toBe(false)
    expect(isBoundedIpcPayload({ value: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isBoundedIpcPayload({ value: undefined })).toBe(false)

    const cyclic: { child?: unknown } = {}
    cyclic.child = cyclic
    expect(isBoundedIpcPayload(cyclic)).toBe(false)

    let deeplyNested: unknown = 'end'
    for (let index = 0; index < 12; index += 1) deeplyNested = { child: deeplyNested }
    expect(isBoundedIpcPayload(deeplyNested)).toBe(false)
  })
})
