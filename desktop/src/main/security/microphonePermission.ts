import type { ShellWebContentsLike, TrustedShellFrameGuard } from './TrustedShellFrameGuard'

/** A microphone request must follow the user's click within this window. */
export const MICROPHONE_ACTIVATION_WINDOW_MS = 5_000

/** The fields of an Electron input event this policy reads. */
export interface UserInputLike {
  readonly type?: unknown
  readonly button?: unknown
  readonly keyCode?: unknown
}

/** The fields of an Electron permission request's details this policy reads. */
export interface PermissionRequestDetailsLike {
  readonly isMainFrame?: unknown
  readonly requestingUrl?: unknown
  readonly mediaTypes?: unknown
}

const ACTIVATION_KEYS = new Set(['Enter', 'Return', 'Space', ' '])

/** A primary-button press, or the keyboard keys that activate a focused button. */
function isExplicitActivation(input: UserInputLike | null | undefined): boolean {
  if (!input || typeof input !== 'object') return false
  if (input.type === 'mouseDown') return input.button === undefined || input.button === 'left'
  if (input.type === 'keyDown' || input.type === 'rawKeyDown') {
    return typeof input.keyCode === 'string' && ACTIVATION_KEYS.has(input.keyCode)
  }
  return false
}

/** True only for an audio-only media request; any video, or an unknown shape, is refused. */
function isAudioOnly(mediaTypes: unknown): boolean {
  return Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio')
}

/**
 * Decides every permission request for the app window's session. Everything is
 * denied except microphone-only `media` for the trusted application's own main
 * frame, and only when the user pressed a button in that window moments before.
 * Each user activation allows at most one microphone request.
 *
 * Input events come from the browser process (`webContents` 'input-event'), so
 * page script cannot manufacture the activation this gate requires.
 */
export class MicrophonePermissionGate {
  private activation: { webContents: ShellWebContentsLike; at: number } | undefined

  constructor(
    private readonly frames: Pick<TrustedShellFrameGuard, 'isTrustedMainFrameRequest'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a user activation delivered to a window's contents. */
  noteInput(webContents: ShellWebContentsLike, input: UserInputLike | null | undefined): void {
    if (isExplicitActivation(input)) this.activation = { webContents, at: this.now() }
  }

  /** Permission request handler decision. */
  decideRequest(webContents: unknown, permission: unknown, details: PermissionRequestDetailsLike | null | undefined): boolean {
    if (permission !== 'media') return false
    // Any media request uses up the pending activation, granted or not.
    const activation = this.activation
    this.activation = undefined
    if (!details || typeof details !== 'object' || !isAudioOnly(details.mediaTypes)) return false
    if (!this.frames.isTrustedMainFrameRequest(webContents, details.requestingUrl, details.isMainFrame)) return false
    if (!activation || activation.webContents !== webContents) return false
    const elapsed = this.now() - activation.at
    return elapsed >= 0 && elapsed <= MICROPHONE_ACTIVATION_WINDOW_MS
  }

  /** Permission check handler decision: never pre-grant; each use goes through a request. */
  decideCheck(): boolean {
    return false
  }
}
