import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, join } from 'node:path'
import { isCodexSessionId } from './ids'
import type { OwnedCodexMetadataStore } from './metadata'

const MAX_LOCAL_PATH_LENGTH = 4096
const MAX_FILE_BYTES = 2 * 1024 * 1024
const PROTECTED_PARTS = new Set([
  '.codex', '.archon', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.secrets', 'secrets',
  'credentials', 'tokens', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  'auth.json', 'auth.toml', 'credentials.json', 'credentials.toml', 'tokens.json', 'codex-sessions.json',
  'token.json', 'secrets.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
])

export interface CodexFileListingEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  restricted: boolean
  size: number | null
  modifiedAt: string | null
}

export interface CodexTextFileRead {
  path: string
  content: string
  size: number
  truncated: boolean
  binary: boolean
}

interface ResolvedOwnedPath {
  root: string
  path: string
  exists: boolean
}

function failure(message: string): Error {
  return new Error(message)
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function isProtectedCodexPath(value: string): boolean {
  return resolve(value).split(sep).some((part) => {
    const name = part.toLowerCase()
    return name.startsWith('.env')
      || PROTECTED_PARTS.has(name)
      || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name)
  })
}

function notFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function canonicalRoot(rootPath: string): Promise<string> {
  if (!isAbsolute(rootPath) || rootPath.includes('\0')) throw failure('Choose an absolute Codex project root.')
  const details = await lstat(rootPath).catch(() => { throw failure('Codex project root is unavailable.') })
  if (details.isSymbolicLink() || !details.isDirectory()) throw failure('Codex project root must be a real directory.')
  const root = await realpath(rootPath).catch(() => { throw failure('Codex project root is unavailable.') })
  const actual = await lstat(root).catch(() => { throw failure('Codex project root is unavailable.') })
  if (actual.isSymbolicLink() || !actual.isDirectory()) throw failure('Codex project root must be a real directory.')
  return root
}

async function resolveOwnedPath(rootInput: string, input: string, allowMissingFinal: boolean): Promise<ResolvedOwnedPath> {
  if (typeof input !== 'string' || !input || input.length > MAX_LOCAL_PATH_LENGTH || input.includes('\0')) {
    throw failure('Choose a valid path inside this Codex project.')
  }
  const root = await canonicalRoot(rootInput)
  const target = resolve(root, input)
  if (!isInside(root, target)) throw failure('File is outside this Codex project.')
  if (isProtectedCodexPath(target)) throw failure('Private application and credential files cannot be opened here.')

  const rel = relative(root, target)
  const parts = rel ? rel.split(sep).filter(Boolean) : []
  let cursor = root
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index])
    let info
    try {
      info = await lstat(cursor)
    } catch (error) {
      if (allowMissingFinal && index === parts.length - 1 && notFound(error)) {
        return { root, path: target, exists: false }
      }
      throw failure('The requested path does not exist inside this Codex project.')
    }
    if (info.isSymbolicLink()) throw failure('Symbolic links are not allowed in Codex project file access.')
    if (index < parts.length - 1 && !info.isDirectory()) throw failure('The requested path is not a project directory.')
  }

  const resolved = await realpath(target).catch(() => { throw failure('The requested path is unavailable.') })
  if (!isInside(root, resolved)) throw failure('File is outside this Codex project.')
  if (isProtectedCodexPath(resolved)) throw failure('Private application and credential files cannot be opened here.')
  return { root, path: resolved, exists: true }
}

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)

/** Open a target through held directory descriptors so replaced path components cannot redirect the open. */
async function openAtOwnedPath(resolved: ResolvedOwnedPath, flags: number, mode?: number) {
  let directory = await open(resolved.root, DIRECTORY_OPEN_FLAGS)
  try {
    if (!(await directory.stat()).isDirectory()) throw failure('The requested project directory is unavailable.')
    const rel = relative(resolved.root, resolved.path)
    const parts = rel ? rel.split(sep).filter(Boolean) : []
    if (parts.length < 1) throw failure('Choose a file.')
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${directory.fd}/${part}`, DIRECTORY_OPEN_FLAGS)
      if (!(await next.stat()).isDirectory()) {
        await next.close()
        throw failure('The requested path is not a project directory.')
      }
      await directory.close()
      directory = next
    }
    return mode === undefined
      ? await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)!}`, flags)
      : await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)!}`, flags, mode)
  } finally {
    await directory.close()
  }
}

async function requireRegularFile(path: string): Promise<void> {
  const details = await lstat(path).catch(() => { throw failure('The requested file is unavailable.') })
  if (!details.isFile()) throw failure('Choose a regular file.')
}

export class CodexOwnedPathAccess {
  async resolve(root: string, path: string): Promise<string> {
    return (await resolveOwnedPath(root, path, false)).path
  }

  async readText(root: string, path: string, maxBytes = 512 * 1024): Promise<CodexTextFileRead> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw failure('Invalid Codex file read limit.')
    const limit = Math.min(maxBytes, MAX_FILE_BYTES)
    const resolved = await resolveOwnedPath(root, path, false)
    await requireRegularFile(resolved.path)
    let handle
    try {
      handle = await openAtOwnedPath(resolved,
        constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
    } catch {
      throw failure('Choose a regular file.')
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw failure('Choose a file.')
      const bytes = Buffer.alloc(Math.min(info.size, limit))
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const content = bytes.subarray(0, bytesRead)
      return {
        path: relative(resolved.root, resolved.path) || '.',
        content: content.toString('utf8'),
        size: info.size,
        truncated: info.size > bytesRead,
        binary: content.includes(0),
      }
    } finally {
      await handle.close()
    }
  }

  async writeText(root: string, path: string, content: string): Promise<{ ok: true; path: string }> {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw failure('File content exceeds the Codex editor limit.')
    }
    const resolved = await resolveOwnedPath(root, path, true)
    if (resolved.exists) await requireRegularFile(resolved.path)
    if (!resolved.exists) {
      const parent = await realpath(join(resolved.path, '..')).catch(() => { throw failure('Create the parent directory before saving.') })
      if (!isInside(resolved.root, parent)) throw failure('File is outside this Codex project.')
    }
    let handle
    try {
      handle = await openAtOwnedPath(resolved,
        constants.O_WRONLY | constants.O_CREAT | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0), 0o600)
    } catch {
      throw failure('Choose a regular file.')
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw failure('Choose a regular file.')
      await handle.truncate(0)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { ok: true, path: relative(resolved.root, resolved.path) || '.' }
  }

  async list(root: string, path: string): Promise<CodexFileListingEntry[]> {
    const resolved = await resolveOwnedPath(root, path, false)
    const info = await lstat(resolved.path)
    if (!info.isDirectory()) throw failure('Choose a project directory.')
    const entries = await readdir(resolved.path, { withFileTypes: true })
    return Promise.all(entries.map(async (entry) => {
      const fullPath = join(resolved.path, entry.name)
      const relativePath = relative(resolved.root, fullPath)
      const restricted = entry.isSymbolicLink() || isProtectedCodexPath(fullPath)
      if (restricted) return {
        name: entry.name,
        path: relativePath,
        kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
        restricted: true,
        size: null,
        modifiedAt: null,
      }
      const details = await lstat(fullPath)
      return {
        name: entry.name,
        path: relativePath,
        kind: details.isDirectory() ? 'directory' as const : 'file' as const,
        restricted: false,
        size: details.isFile() ? details.size : null,
        modifiedAt: details.mtime.toISOString(),
      }
    }))
  }
}

/** Public adapter surface: resolve the root only from a locally owned session. */
export class CodexOwnedFileService {
  constructor(
    private readonly metadata: OwnedCodexMetadataStore,
    private readonly access = new CodexOwnedPathAccess(),
  ) {}

  async read(sessionId: unknown, path: string, maxBytes = 512 * 1024): Promise<CodexTextFileRead> {
    const session = await this.ownedSession(sessionId)
    return this.access.readText(session.cwd, path, maxBytes)
  }

  async write(sessionId: unknown, path: string, content: string): Promise<{ ok: true; path: string }> {
    const session = await this.ownedSession(sessionId)
    return this.access.writeText(session.cwd, path, content)
  }

  async list(sessionId: unknown, path: string): Promise<CodexFileListingEntry[]> {
    const session = await this.ownedSession(sessionId)
    return this.access.list(session.cwd, path)
  }

  private async ownedSession(sessionId: unknown) {
    if (!isCodexSessionId(sessionId)) throw failure('Unknown Archon-owned Codex session.')
    const metadata = await this.metadata.read()
    const session = metadata.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw failure('Unknown Archon-owned Codex session.')
    return session
  }
}
