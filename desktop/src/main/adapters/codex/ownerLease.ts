import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const LOCK_NAME = '.archon-codex-owner.lock'
const OWNER_FORMAT = 'archon-codex-owner-lease'
const MAX_ROOT_LENGTH = 4096
const MAX_OWNER_LABEL_LENGTH = 64

export interface CodexOwnerLease {
  /** Removes the lock if it still belongs to this lease. */
  release(): Promise<void>
  /** Synchronous variant for process exit and Electron before-quit handlers. */
  releaseSync(): void
}

/** Claims exclusive write ownership of one Codex metadata directory. */
export async function acquireCodexOwnerLease(rootPath: string, ownerLabel: string): Promise<CodexOwnerLease> {
  if (process.platform !== 'linux') throw new Error('Codex metadata ownership leases require Linux.')
  const noFollow = constants.O_NOFOLLOW
  const directoryFlag = constants.O_DIRECTORY
  if (typeof noFollow !== 'number' || typeof directoryFlag !== 'number') {
    throw new Error('Codex metadata ownership leases require no-follow directory support.')
  }

  const { root, rootFd } = preparePrivateRoot(rootPath, noFollow, directoryFlag)
  let lockFd: number | undefined
  try {
    const lockPath = directoryEntryPath(rootFd, root, LOCK_NAME)
    const payload = `${JSON.stringify({
      format: OWNER_FORMAT,
      version: 1,
      owner: validateOwnerLabel(ownerLabel),
      pid: process.pid,
      token: randomUUID(),
    })}\n`
    const lockBytes = Buffer.from(payload, 'utf8')
    lockFd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
    fchmodSync(lockFd, 0o600)

    const lockInfo = fstatSync(lockFd)
    if (!lockInfo.isFile() || lockInfo.nlink !== 1 || !ownedByCurrentUser(lockInfo.uid)) {
      throw new Error('Codex metadata ownership lock is unsafe.')
    }
    writeAll(lockFd, lockBytes)
    fsyncSync(lockFd)
    fsyncSync(rootFd)

    const ownedInode = fstatSync(lockFd)
    let released = false
    const releaseSync = (): void => {
      if (released) return
      released = true
      try {
        const currentPath = directoryEntryPath(rootFd, root, LOCK_NAME)
        const pathInfo = lstatSync(currentPath)
        const descriptorInfo = fstatSync(lockFd!)
        if (pathInfo.isFile()
          && !pathInfo.isSymbolicLink()
          && pathInfo.nlink === 1
          && sameInode(ownedInode, descriptorInfo)
          && sameInode(descriptorInfo, pathInfo)
          && readContents(lockFd!) === payload) {
          unlinkSync(currentPath)
          fsyncSync(rootFd)
        }
      } catch {
        // A changed or inaccessible lock is left in place so another process fails closed.
      } finally {
        closeSync(lockFd!)
        closeSync(rootFd)
        lockFd = undefined
      }
    }

    return {
      release: async () => releaseSync(),
      releaseSync,
    }
  } catch (error) {
    if (lockFd !== undefined) {
      // Remove only the untouched, empty file created by this call after a pre-write failure.
      try {
        const info = fstatSync(lockFd)
        const current = lstatSync(directoryEntryPath(rootFd, root, LOCK_NAME))
        if (current.isFile() && !current.isSymbolicLink() && current.nlink === 1
          && sameInode(info, current) && readContents(lockFd) === '') {
          unlinkSync(directoryEntryPath(rootFd, root, LOCK_NAME))
        }
      } catch {
        // Keep any ambiguous lock. A stale lease is intentionally fail-closed.
      }
      closeSync(lockFd)
    }
    closeSync(rootFd)
    if (hasCode(error, 'EEXIST')) {
      throw new Error('Another process owns this Codex metadata directory, or a previous owner left a lock behind.')
    }
    throw error
  }
}

function preparePrivateRoot(input: string, noFollow: number, directoryFlag: number): { root: string; rootFd: number } {
  if (typeof input !== 'string' || !input || input.length > MAX_ROOT_LENGTH || input.includes('\0') || !isAbsolute(input)) {
    throw new Error('Codex metadata ownership requires an explicit absolute directory path.')
  }
  const root = resolve(input)
  const filesystemRoot = parse(root).root
  if (root === filesystemRoot) throw new Error('The filesystem root cannot be used as a Codex metadata directory.')

  const directoryFlags = constants.O_RDONLY | directoryFlag | noFollow
  let directoryFd = openSync(filesystemRoot, directoryFlags)
  let expectedPath = filesystemRoot
  try {
    const segments = relative(filesystemRoot, root).split(sep).filter(Boolean)
    for (const segment of segments) {
      const childPath = directoryEntryPath(directoryFd, expectedPath, segment)
      let childInfo
      try {
        childInfo = lstatSync(childPath)
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error
        try {
          mkdirSync(childPath, 0o700)
        } catch (mkdirError) {
          if (!hasCode(mkdirError, 'EEXIST')) throw mkdirError
        }
        childInfo = lstatSync(childPath)
      }
      if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) {
        throw new Error('Codex metadata path contains a symbolic link or non-directory component.')
      }

      const childFd = openSync(childPath, directoryFlags)
      const openedInfo = fstatSync(childFd)
      if (!sameInode(childInfo, openedInfo) || !openedInfo.isDirectory()) {
        closeSync(childFd)
        throw new Error('Codex metadata directory changed while it was opened.')
      }
      closeSync(directoryFd)
      directoryFd = childFd
      expectedPath = join(expectedPath, segment)
    }

    const rootInfo = fstatSync(directoryFd)
    if (!ownedByCurrentUser(rootInfo.uid)) throw new Error('Codex metadata directory must be owned by this user.')
    fchmodSync(directoryFd, 0o700)
    return { root, rootFd: directoryFd }
  } catch (error) {
    closeSync(directoryFd)
    throw error
  }
}

function directoryEntryPath(directoryFd: number, expectedPath: string, name: string): string {
  const procPath = `/proc/self/fd/${directoryFd}`
  if (realpathSync(procPath) !== expectedPath) {
    throw new Error('Codex metadata directory handle no longer matches its configured path.')
  }
  return join(procPath, name)
}

function validateOwnerLabel(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_OWNER_LABEL_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error('Codex metadata owner label must be 1–64 safe characters.')
  }
  return value
}

function readContents(fd: number): string {
  const size = fstatSync(fd).size
  if (!Number.isSafeInteger(size) || size < 0 || size > 1024) return ''
  const bytes = Buffer.alloc(size)
  const bytesRead = readSync(fd, bytes, 0, size, 0)
  return bytesRead === size ? bytes.toString('utf8') : ''
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error('Codex metadata ownership lock could not be written.')
    offset += written
  }
}

function sameInode(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function ownedByCurrentUser(uid: number): boolean {
  const currentUid = typeof process.geteuid === 'function'
    ? process.geteuid()
    : typeof process.getuid === 'function'
      ? process.getuid()
      : uid
  return uid === currentUid
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
