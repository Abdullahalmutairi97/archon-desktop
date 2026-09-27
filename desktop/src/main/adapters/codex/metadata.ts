import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isCodexProjectId, isCodexSessionId, isCodexTaskId } from './ids'

export const CODEX_METADATA_FILENAME = 'codex-sessions.json'
const MAX_METADATA_BYTES = 4 * 1024 * 1024
const MAX_METADATA_NODES = 50_000
const MAX_PROJECTS = 2_000
const MAX_SESSIONS = 5_000
const MAX_TURNS_PER_SESSION = 5_000
const SECRET_FIELDS = new Set([
  'token', 'apitoken', 'authtoken', 'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken',
  'authorization', 'password', 'secret', 'clientsecret', 'credential', 'credentials',
  'apikey', 'accesskey', 'privatekey', 'cookie', 'sessioncookie', 'bearer',
])
const SECRET_FIELD_SHAPE = /(?:token|cookie|authorization|password|secret|credential|apikey|accesskey|privatekey|bearer)/

export type MetadataJson = string | number | boolean | null | MetadataJson[] | { [key: string]: MetadataJson }

export interface CodexOwnedProject extends Record<string, MetadataJson> {
  id: string
  name: string
  primary_path: string
}

export interface CodexTurnMapping extends Record<string, MetadataJson> {
  id: string
  turnId: string
}

export interface CodexOwnedSession extends Record<string, MetadataJson> {
  id: string
  threadId: string
  title: string
  cwd: string
  projectId: string | null
  turns: CodexTurnMapping[]
}

export interface OwnedCodexMetadataV1 extends Record<string, MetadataJson> {
  version: 1
  projects: CodexOwnedProject[]
  sessions: CodexOwnedSession[]
}

function fail(): never {
  throw new Error('Invalid Codex-owned metadata. Restore its backup before continuing.')
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

function validateJson(value: unknown, state = { nodes: 0, bytes: 0 }, depth = 0): MetadataJson {
  state.nodes += 1
  if (state.nodes > MAX_METADATA_NODES || depth > 16) return fail()
  if (value === null || typeof value === 'boolean') {
    state.bytes += 8
    return value
  }
  if (typeof value === 'string') {
    state.bytes += value.length * 3
    if (value.includes('\0')) return fail()
    if (state.bytes > MAX_METADATA_BYTES) return fail()
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail()
    state.bytes += 16
    return value
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_METADATA_NODES) return fail()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== 'string')) return fail()
    const result: MetadataJson[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail()
      result.push(validateJson(descriptor.value, state, depth + 1))
    }
    return result
  }
  if (!record(value)) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length > 512 || keys.some((key) => typeof key !== 'string')) return fail()
  const result: Record<string, MetadataJson> = Object.create(null) as Record<string, MetadataJson>
  for (const key of keys) {
    if (typeof key !== 'string') return fail()
    const normalizedKey = key.toLowerCase().replace(/[-_\s]/g, '')
    if (SECRET_FIELDS.has(normalizedKey) || SECRET_FIELD_SHAPE.test(normalizedKey)) return fail()
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail()
    state.bytes += key.length * 3
    result[key] = validateJson(descriptor.value, state, depth + 1)
  }
  if (state.bytes > MAX_METADATA_BYTES) return fail()
  return result
}

function requiredString(value: unknown, maxLength = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function parseMetadata(value: unknown): OwnedCodexMetadataV1 {
  const parsed = validateJson(value)
  if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.sessions)) return fail()
  if (parsed.projects.length > MAX_PROJECTS || parsed.sessions.length > MAX_SESSIONS) return fail()

  const projects = parsed.projects as unknown[]
  const projectIds = new Set<string>()
  for (const project of projects) {
    if (!record(project) || !isCodexProjectId(project.id) || !requiredString(project.name, 300)
      || !requiredString(project.primary_path) || !isAbsolute(project.primary_path)) return fail()
    if (projectIds.has(project.id)) return fail()
    if (project.runtime !== undefined && project.runtime !== 'codex') return fail()
    projectIds.add(project.id)
  }

  const sessionIds = new Set<string>()
  for (const session of parsed.sessions as unknown[]) {
    if (!record(session) || !isCodexSessionId(session.id) || !requiredString(session.threadId, 240)
      || session.id !== `codex:${session.threadId}` || !requiredString(session.title, 500)
      || !requiredString(session.cwd) || !isAbsolute(session.cwd)) return fail()
    if (session.projectId !== null && (!isCodexProjectId(session.projectId) || !projectIds.has(session.projectId))) return fail()
    if (sessionIds.has(session.id)) return fail()
    sessionIds.add(session.id)
    if (session.turns === undefined) session.turns = []
    if (!Array.isArray(session.turns) || session.turns.length > MAX_TURNS_PER_SESSION) return fail()
    const taskIds = new Set<string>()
    const turnIds = new Set<string>()
    for (const turn of session.turns as unknown[]) {
      if (!record(turn) || !isCodexTaskId(turn.id) || !requiredString(turn.turnId, 240)) return fail()
      if (taskIds.has(turn.id) || turnIds.has(turn.turnId)) return fail()
      taskIds.add(turn.id)
      turnIds.add(turn.turnId)
    }
  }
  return parsed as unknown as OwnedCodexMetadataV1
}

export class OwnedCodexMetadataStore {
  readonly filePath: string
  private loadPromise: Promise<OwnedCodexMetadataV1> | undefined
  private state: OwnedCodexMetadataV1 | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly profileDirectory: string) {
    if (!isAbsolute(profileDirectory) || profileDirectory.includes('\0')) {
      throw new TypeError('Codex profile directory must be an absolute injected path.')
    }
    this.filePath = join(profileDirectory, CODEX_METADATA_FILENAME)
  }

  async load(): Promise<OwnedCodexMetadataV1> {
    if (this.state) return freezeDeep(clone(this.state) as OwnedCodexMetadataV1)
    if (!this.loadPromise) this.loadPromise = this.readFileOrDefault()
    const loaded = await this.loadPromise
    this.state = loaded
    return freezeDeep(clone(loaded) as OwnedCodexMetadataV1)
  }

  async read(): Promise<OwnedCodexMetadataV1> {
    return this.load()
  }

  async replace(next: unknown): Promise<OwnedCodexMetadataV1> {
    const state = parseMetadata(next)
    const text = `${JSON.stringify(state, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) return fail()

    const write = async (): Promise<OwnedCodexMetadataV1> => {
      await this.load()
      await this.ensureProfileDirectory()
      const temp = `${this.filePath}.${randomUUID()}.tmp`
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        await handle.writeFile(text, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temp, this.filePath)
        const directory = await open(dirname(this.filePath), constants.O_RDONLY)
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
        this.state = state
        return freezeDeep(clone(state) as OwnedCodexMetadataV1)
      } catch {
        if (handle) await handle.close().catch(() => undefined)
        await rm(temp, { force: true }).catch(() => undefined)
        throw new Error('Could not safely save Codex-owned metadata.')
      }
    }

    const nextWrite = this.writeQueue.then(write, write)
    this.writeQueue = nextWrite.then(() => undefined, () => undefined)
    return nextWrite
  }

  private async ensureProfileDirectory(): Promise<void> {
    try {
      await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 })
      const info = await lstat(this.profileDirectory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid directory')
    } catch {
      throw new Error('Codex-owned metadata directory is unavailable.')
    }
  }

  private async readFileOrDefault(): Promise<OwnedCodexMetadataV1> {
    await this.ensureProfileDirectory()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_METADATA_BYTES) return fail()
      const saved = JSON.parse(await handle.readFile('utf8')) as unknown
      return parseMetadata(saved)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, projects: [], sessions: [] }
      }
      return fail()
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
}
