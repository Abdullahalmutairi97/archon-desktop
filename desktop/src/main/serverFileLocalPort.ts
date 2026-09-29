import { randomBytes } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Local side of server file transfers. The renderer never supplies a local
 * path: the user picks one in a native dialog owned by the main process, and
 * only an opaque, one-use pick id crosses the bridge.
 */
export interface ServerFileLocalPort {
  pickUpload(): Promise<{ pickId: string; name: string; size: number } | null>
  hasUpload(pickId: string): boolean
  /** Removes the pick and opens it; a pick is sent at most once. */
  takeUpload(pickId: string): Promise<{ name: string; size: number; blob: Blob } | null>
  discardUpload(pickId: string): void
  chooseDownloadTarget(suggestedName: string): Promise<ServerFileDownloadSink | null>
}

export interface ServerFileDownloadSink {
  /** The chosen file name, for display only. */
  readonly name: string
  write(chunk: Uint8Array): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}

export interface ServerFileDialogs {
  chooseOpenFile(): Promise<string | null>
  chooseSaveFile(defaultPath: string): Promise<string | null>
  downloadsDirectory(): string
}

/** How long a pick stays usable while the user confirms a replacement. */
export const UPLOAD_PICK_TTL_MS = 10 * 60 * 1000

/** A file name that is safe as a save-dialog default: no separators or control characters. */
export function safeDownloadName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f/\\]/gu, '_').trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 200) : 'download'
}

export function createServerFileLocalPort(dialogs: ServerFileDialogs, now: () => number = Date.now): ServerFileLocalPort {
  // At most one pick is held; a new pick replaces it.
  let pending: { pickId: string; path: string; name: string; pickedAt: number } | null = null

  const current = (pickId: string) => {
    if (!pending || pending.pickId !== pickId) return null
    if (now() - pending.pickedAt > UPLOAD_PICK_TTL_MS) {
      pending = null
      return null
    }
    return pending
  }

  return {
    async pickUpload() {
      pending = null
      const path = await dialogs.chooseOpenFile()
      if (!path) return null
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Not a regular file')
      const pickId = `upload-${randomBytes(16).toString('hex')}`
      pending = { pickId, path, name: basename(path), pickedAt: now() }
      return { pickId, name: pending.name, size: info.size }
    },
    hasUpload: (pickId) => current(pickId) !== null,
    async takeUpload(pickId) {
      const pick = current(pickId)
      pending = null
      if (!pick) return null
      const info = await stat(pick.path)
      if (!info.isFile()) throw new Error('Not a regular file')
      return { name: pick.name, size: info.size, blob: await openAsBlob(pick.path) }
    },
    discardUpload(pickId) {
      if (pending?.pickId === pickId) pending = null
    },
    async chooseDownloadTarget(suggestedName) {
      const target = await dialogs.chooseSaveFile(join(dialogs.downloadsDirectory(), safeDownloadName(suggestedName)))
      if (!target) return null
      // Stream into a private sibling, then rename over the chosen path, so a
      // failed transfer never leaves a partial file under the chosen name.
      const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(8).toString('hex')}.archon-download`)
      const handle = await open(temporary, 'wx', 0o600)
      let closed = false
      const close = async () => { if (!closed) { closed = true; await handle.close() } }
      return {
        name: basename(target),
        async write(chunk) { await handle.write(chunk) },
        async commit() {
          await handle.chmod(0o644)
          await close()
          await rename(temporary, target)
        },
        async abort() {
          await close().catch(() => undefined)
          await unlink(temporary).catch(() => undefined)
        },
      }
    },
  }
}
