import { MAX_AUDIO_DATA_URL_LENGTH } from '../../shared/bridge/validation'

/** Narrow structural types keep the security policy unit-testable without Electron. */
export interface ShellFrameLike {
  readonly url: string
  readonly parent: ShellFrameLike | null
  readonly detached?: boolean
  isDestroyed?: () => boolean
}

export interface ShellWebContentsLike {
  readonly id: number
  readonly mainFrame: ShellFrameLike
  isDestroyed(): boolean
}

export interface ShellWindowLike {
  readonly webContents: ShellWebContentsLike
  isDestroyed(): boolean
}

export interface TrustedShellIpcEvent {
  readonly sender: ShellWebContentsLike
  readonly senderFrame?: ShellFrameLike | null
}

interface TrustedBinding {
  readonly window: ShellWindowLike
  readonly webContents: ShellWebContentsLike
  readonly frame: ShellFrameLike
  readonly documentUrl: string
  active: boolean
}

export interface BoundedPayloadLimits {
  maxBytes: number
  maxDepth: number
  maxNodes: number
  maxStringLength: number
  maxArrayLength: number
  maxObjectKeys: number
}

export const IPC_PAYLOAD_LIMITS: Readonly<BoundedPayloadLimits> = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 8,
  maxNodes: 2048,
  maxStringLength: 16_384,
  maxArrayLength: 512,
  maxObjectKeys: 128,
})

/**
 * The one larger envelope: an `audio.transcribe` invoke carrying at most the
 * server's audio ceiling as a data URL. Operation validation still enforces the
 * exact shape, so no other operation can use this allowance.
 */
export const AUDIO_TRANSCRIBE_IPC_PAYLOAD_LIMITS: Readonly<BoundedPayloadLimits> = Object.freeze({
  maxBytes: MAX_AUDIO_DATA_URL_LENGTH + 1024,
  maxDepth: 4,
  maxNodes: 16,
  maxStringLength: MAX_AUDIO_DATA_URL_LENGTH,
  maxArrayLength: 4,
  maxObjectKeys: 4,
})

/**
 * Server files (ARCHON_ROOT): a text save carries one string up to 1 MiB of
 * JSON-encoded UTF-8, which validation then checks exactly. Every other
 * operation keeps the default envelope.
 */
export const SERVER_FILE_TEXT_IPC_LIMITS: Readonly<BoundedPayloadLimits> = Object.freeze({
  ...IPC_PAYLOAD_LIMITS,
  maxBytes: 1024 * 1024 + 64 * 1024,
  maxStringLength: 1024 * 1024,
})

/** Payload limits for one API operation: audio uploads and server file text saves each get their own bounded envelope. */
export function ipcPayloadLimitsForOperation(operation: unknown): Readonly<BoundedPayloadLimits> {
  if (operation === 'audio.transcribe') return AUDIO_TRANSCRIBE_IPC_PAYLOAD_LIMITS
  return operation === 'files.writeText' ? SERVER_FILE_TEXT_IPC_LIMITS : IPC_PAYLOAD_LIMITS
}

/** A constant message avoids reflecting sender-controlled details to IPC callers. */
export class UntrustedShellIpcError extends Error {
  constructor() {
    super('Untrusted IPC sender')
    this.name = 'UntrustedShellIpcError'
  }
}

function normalizedDocumentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return undefined
  try {
    const url = new URL(value)
    const authority = value.match(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/([^/?#]*)/u)?.[1] ?? ''
    if (authority.includes('@')) return undefined
    if (url.username || url.password || url.search || value.includes('?') || value.includes('#')) {
      // Fragments are same-document state and are normalized below. Empty query
      // delimiters remain rejected because URL.search does not preserve them.
      if (url.search || value.includes('?')) return undefined
      if (url.username || url.password) return undefined
    }
    if (url.protocol === 'file:') {
      if (url.host !== '' && url.host !== 'localhost') return undefined
      if (!url.pathname.startsWith('/')) return undefined
    } else if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.port !== '5173' ||
      url.host !== '127.0.0.1:5173'
    ) {
      return undefined
    }
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

/**
 * Holds one currently trusted shell document. Call `register` only after the
 * app's known renderer entry has finished loading. Invalidate synchronously
 * when a top-level navigation starts; a later trusted reload must be registered
 * explicitly after it finishes.
 */
export class TrustedShellFrameGuard {
  private binding: TrustedBinding | undefined

  register(window: ShellWindowLike, trustedDocumentUrl: string): void {
    // Replacing the active window immediately revokes every prior binding,
    // including one that has not yet reported destruction.
    this.binding = undefined

    const webContents = window.webContents
    const frame = webContents.mainFrame
    const expectedUrl = normalizedDocumentUrl(trustedDocumentUrl)
    const loadedUrl = normalizedDocumentUrl(frame.url)
    if (
      !expectedUrl ||
      expectedUrl !== loadedUrl ||
      frame.parent !== null ||
      frame.detached === true ||
      window.isDestroyed() ||
      webContents.isDestroyed()
    ) {
      throw new UntrustedShellIpcError()
    }

    this.binding = { window, webContents, frame, documentUrl: expectedUrl, active: true }
  }

  /** Revoke the active document before handling any top-level navigation. */
  invalidateNavigation(webContents: ShellWebContentsLike): void {
    if (this.binding?.webContents === webContents) this.binding.active = false
  }

  /** Revoke only the binding owned by this window or its webContents. */
  unregister(owner: ShellWindowLike | ShellWebContentsLike): void {
    const binding = this.binding
    if (binding && (owner === binding.window || owner === binding.webContents)) {
      binding.active = false
      this.binding = undefined
    }
  }

  isTrusted(event: TrustedShellIpcEvent): boolean {
    const binding = this.binding
    if (!binding || !binding.active) return false

    try {
      const sender = event?.sender
      const senderFrame = event?.senderFrame
      const { window, webContents, frame, documentUrl } = binding
      if (
        sender !== webContents ||
        senderFrame !== frame ||
        window.isDestroyed() ||
        window.webContents !== webContents ||
        webContents.isDestroyed() ||
        webContents.mainFrame !== frame ||
        frame.parent !== null ||
        frame.detached === true ||
        frame.isDestroyed?.() === true
      ) {
        return false
      }

      return normalizedDocumentUrl(frame.url) === documentUrl &&
        normalizedDocumentUrl(senderFrame.url) === documentUrl
    } catch {
      // Electron objects can become detached while navigation/destruction is
      // in progress. Treat any failed property access as an untrusted event.
      return false
    }
  }

  /**
   * True only for a request from the trusted document's own main frame, as
   * Electron describes a permission request: the owning webContents, a
   * main-frame flag and the URL the requesting frame last loaded.
   */
  isTrustedMainFrameRequest(webContents: unknown, requestingUrl: unknown, isMainFrame: unknown): boolean {
    const binding = this.binding
    if (!binding || !binding.active || isMainFrame !== true || webContents !== binding.webContents) return false
    try {
      return this.isTrusted({ sender: binding.webContents, senderFrame: binding.webContents.mainFrame }) &&
        normalizedDocumentUrl(requestingUrl) === binding.documentUrl
    } catch {
      return false
    }
  }

  assertTrusted(event: TrustedShellIpcEvent): void {
    if (!this.isTrusted(event)) throw new UntrustedShellIpcError()
  }
}

/** Validate a JSON-shaped, bounded payload without invoking accessors. */
export function isBoundedIpcPayload(
  value: unknown,
  limits: BoundedPayloadLimits = IPC_PAYLOAD_LIMITS,
): boolean {
  const visited = new WeakSet<object>()
  let nodes = 0

  const visit = (current: unknown, depth: number): boolean => {
    if (depth > limits.maxDepth || ++nodes > limits.maxNodes) return false
    if (current === null || typeof current === 'boolean') return true
    if (typeof current === 'string') return current.length <= limits.maxStringLength
    if (typeof current === 'number') return Number.isFinite(current)
    if (typeof current !== 'object') return false

    try {
      if (visited.has(current)) return false
      visited.add(current)

      if (Array.isArray(current)) {
        if (current.length > limits.maxArrayLength) return false
        const descriptors = Object.getOwnPropertyDescriptors(current)
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)]
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false
          if (!visit(descriptor.value, depth + 1)) return false
        }
        return Reflect.ownKeys(descriptors).every((key) =>
          key === 'length' || (typeof key === 'string' && /^\d+$/.test(key) && Number(key) < current.length),
        )
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) return false
      const descriptors = Object.getOwnPropertyDescriptors(current)
      const keys = Reflect.ownKeys(descriptors)
      if (keys.length > limits.maxObjectKeys) return false
      for (const key of keys) {
        if (
          typeof key !== 'string' ||
          key === '__proto__' ||
          key === 'prototype' ||
          key === 'constructor' ||
          key.length > limits.maxStringLength
        ) {
          return false
        }
        const descriptor = descriptors[key]
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false
        if (!visit(descriptor.value, depth + 1)) return false
      }
      return true
    } catch {
      return false
    }
  }

  try {
    if (!visit(value, 0)) return false
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' && new TextEncoder().encode(serialized).byteLength <= limits.maxBytes
  } catch {
    return false
  }
}

export function assertBoundedIpcPayload(
  value: unknown,
  limits: BoundedPayloadLimits = IPC_PAYLOAD_LIMITS,
): void {
  if (!isBoundedIpcPayload(value, limits)) throw new TypeError('Invalid or oversized IPC payload')
}
