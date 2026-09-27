import { lstat, realpath } from 'node:fs/promises'
import { isIP, createConnection } from 'node:net'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Socket } from 'node:net'

export const LOCAL_PAIRING_AUDIENCE = 'archon-desktop.local/v1'
export const MAX_LOCAL_PAIRING_LINE_BYTES = 4096
const MAX_UNIX_SOCKET_PATH_BYTES = 107
const DEFAULT_PAIRING_TIMEOUT_MS = 10_000
const MAX_CHALLENGE_LIFETIME_SECONDS = 60
const MAX_CREDENTIAL_LIFETIME_SECONDS = 24 * 60 * 60 + 60

export interface LocalPairingCredential {
  serverUrl: string
  token: string
  expiresAt: number
}

export interface LocalPairingClientOptions {
  socketPath: string
  timeoutMs?: number
  uid?: number
  now?: () => number
}

function fail(): never {
  throw new Error('The local Archon service could not be paired.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return undefined
  return value
}

function safeLoopbackServerUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return false
  const match = /^http:\/\/(\[[^\]]+\]|[^:/?#@]+):([0-9]{1,5})$/u.exec(value)
  if (!match) return false
  const hostPart = match[1]!
  const host = hostPart.startsWith('[') ? hostPart.slice(1, -1) : hostPart
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || host.includes('%')) return false
  const hostname = host.toLowerCase()
  const loopback = hostname === 'localhost'
    || (isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127)
    || (isIP(hostname) === 6 && hostname === '::1')
  if (!loopback) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash
      && url.hostname.replace(/^\[|\]$/gu, '').toLowerCase() === hostname
      && (url.port === String(port) || (port === 80 && url.port === ''))
  } catch {
    return false
  }
}

export function resolveLocalPairingSocketPath(
  dataDirectory: string | undefined,
  accountHomeDirectory = userInfo().homedir,
): string {
  const dataRoot = dataDirectory ?? join(accountHomeDirectory, '.local', 'share', 'archon-desktop')
  if (!isAbsolute(dataRoot) || dataRoot.includes('\0')
    || !isAbsolute(accountHomeDirectory) || accountHomeDirectory.includes('\0')) return fail()
  const socketPath = join(resolve(dataRoot), 'runner-journal', 'pairing.sock')
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) return fail()
  return socketPath
}

interface SocketIdentity { dev: number; ino: number }

async function validateProtectedSocket(socketPath: string, uid: number): Promise<SocketIdentity> {
  try {
    const parent = dirname(socketPath)
    const [parentInfo, resolvedParent, socketInfo] = await Promise.all([
      lstat(parent), realpath(parent), lstat(socketPath),
    ])
    if (parent !== resolve(parent) || parent !== resolvedParent || !parentInfo.isDirectory()
      || parentInfo.isSymbolicLink() || parentInfo.uid !== uid || (parentInfo.mode & 0o7777) !== 0o700
      || !socketInfo.isSocket() || socketInfo.isSymbolicLink() || socketInfo.uid !== uid
      || (socketInfo.mode & 0o7777) !== 0o600) return fail()
    return { dev: socketInfo.dev, ino: socketInfo.ino }
  } catch {
    return fail()
  }
}

class JsonLineChannel {
  private buffer = Buffer.alloc(0)
  private queued: Buffer[] = []
  private waiting: { resolve(line: Buffer): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined
  private closed = false

  constructor(private readonly socket: Socket, private readonly timeoutMs: number) {
    socket.on('data', (chunk: Buffer) => this.onData(Buffer.from(chunk)))
    socket.on('error', () => this.fail())
    socket.on('end', () => this.fail())
    socket.on('close', () => this.fail())
    socket.setTimeout(timeoutMs, () => this.fail())
  }

  async write(value: Record<string, unknown>): Promise<void> {
    const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    if (line.byteLength > MAX_LOCAL_PAIRING_LINE_BYTES) {
      this.fail()
      throw new Error('The local Archon service could not be paired.')
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.socket.write(line, (error) => error ? rejectWrite(error) : resolveWrite())
    }).catch(() => {
      this.fail()
      throw new Error('The local Archon service could not be paired.')
    })
  }

  read(): Promise<Buffer> {
    const line = this.queued.shift()
    if (line) return Promise.resolve(line)
    if (this.closed || this.waiting) return Promise.reject(new Error('pairing channel closed'))
    return new Promise<Buffer>((resolveLine, rejectLine) => {
      const timer = setTimeout(() => {
        this.fail()
      }, this.timeoutMs)
      this.waiting = { resolve: resolveLine, reject: rejectLine, timer }
    })
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    // Reject before concatenating: a peer can send an oversized chunk without
    // ever sending a newline, and the protocol never needs multiple replies.
    if (chunk.byteLength > MAX_LOCAL_PAIRING_LINE_BYTES
      || this.buffer.byteLength + chunk.byteLength > MAX_LOCAL_PAIRING_LINE_BYTES) {
      this.fail()
      return
    }
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) break
      if (newline + 1 > MAX_LOCAL_PAIRING_LINE_BYTES) { this.fail(); return }
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (!this.deliver(line)) return
    }
    if (this.buffer.byteLength >= MAX_LOCAL_PAIRING_LINE_BYTES) this.fail()
  }

  private deliver(line: Buffer): boolean {
    if (line.byteLength === 0 || this.queued.length > 0) { this.fail(); return false }
    const waiter = this.waiting
    if (!waiter) { this.queued.push(line); return true }
    clearTimeout(waiter.timer)
    this.waiting = undefined
    waiter.resolve(line)
    return true
  }

  private fail(): void {
    this.closed = true
    const waiter = this.waiting
    this.waiting = undefined
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('pairing channel closed'))
    }
    this.socket.destroy()
  }
}

function parseLine(line: Buffer): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(line)
    return JSON.parse(text) as unknown
  } catch {
    return fail()
  }
}

function validateChallenge(value: unknown, nowSeconds: number): string {
  const response = exactRecord(value, ['ok', 'challenge'])
  if (!response || response.ok !== true) return fail()
  const challenge = exactRecord(response.challenge, ['nonce', 'audience', 'expires_at'])
  if (!challenge || typeof challenge.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(challenge.nonce)
    || challenge.audience !== LOCAL_PAIRING_AUDIENCE || typeof challenge.expires_at !== 'number' || !Number.isSafeInteger(challenge.expires_at)
    || (challenge.expires_at as number) <= nowSeconds
    || (challenge.expires_at as number) > nowSeconds + MAX_CHALLENGE_LIFETIME_SECONDS) return fail()
  return challenge.nonce
}

function validateCredential(value: unknown, nowSeconds: number, uid: number): LocalPairingCredential {
  const response = exactRecord(value, ['ok', 'credential'])
  if (!response || response.ok !== true) return fail()
  const credential = exactRecord(response.credential, ['access_token', 'principal', 'expires_at', 'server_url'])
  const principal = credential && exactRecord(credential.principal, ['principal_id', 'uid', 'auth_method'])
  if (!credential || typeof credential.access_token !== 'string'
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(credential.access_token)
    || !principal || principal.principal_id !== `local-uid:${uid}` || principal.uid !== uid
    || principal.auth_method !== 'unix-peer-credentials'
    || typeof credential.expires_at !== 'number' || !Number.isSafeInteger(credential.expires_at)
    || (credential.expires_at as number) <= nowSeconds
    || (credential.expires_at as number) > nowSeconds + MAX_CREDENTIAL_LIFETIME_SECONDS
    || !safeLoopbackServerUrl(credential.server_url)) return fail()
  return Object.freeze({ serverUrl: credential.server_url, token: credential.access_token, expiresAt: credential.expires_at as number })
}

function connect(socketPath: string, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolveSocket, rejectSocket) => {
    const socket = createConnection({ path: socketPath })
    const timer = setTimeout(() => {
      socket.destroy()
      rejectSocket(new Error('pairing connection timed out'))
    }, timeoutMs)
    const onError = () => {
      clearTimeout(timer)
      rejectSocket(new Error('pairing connection failed'))
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      resolveSocket(socket)
    })
  })
}

/** A bounded one-socket challenge/redeem client. The bearer never leaves the main process. */
export class LocalPairingClient {
  private readonly uid: number
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(private readonly options: LocalPairingClientOptions) {
    const uid = options.uid ?? process.getuid?.()
    const timeoutMs = options.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS
    if (!isAbsolute(options.socketPath) || options.socketPath.includes('\0') || resolve(options.socketPath) !== options.socketPath
      || Buffer.byteLength(options.socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
      || !Number.isSafeInteger(uid) || uid! < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) fail()
    this.uid = uid!
    this.timeoutMs = timeoutMs
    this.now = options.now ?? Date.now
  }

  async pair(): Promise<LocalPairingCredential> {
    let socket: Socket | undefined
    try {
      const initialIdentity = await validateProtectedSocket(this.options.socketPath, this.uid)
      socket = await connect(this.options.socketPath, this.timeoutMs)
      const connectedIdentity = await validateProtectedSocket(this.options.socketPath, this.uid)
      if (initialIdentity.dev !== connectedIdentity.dev || initialIdentity.ino !== connectedIdentity.ino) return fail()
      const channel = new JsonLineChannel(socket, this.timeoutMs)
      const nowSeconds = Math.floor(this.now() / 1000)
      await channel.write({ op: 'challenge', audience: LOCAL_PAIRING_AUDIENCE })
      const nonce = validateChallenge(parseLine(await channel.read()), nowSeconds)
      await channel.write({ op: 'redeem', audience: LOCAL_PAIRING_AUDIENCE, nonce })
      const credential = validateCredential(parseLine(await channel.read()), Math.floor(this.now() / 1000), this.uid)
      socket.destroy()
      return credential
    } catch {
      socket?.destroy()
      return fail()
    }
  }
}
