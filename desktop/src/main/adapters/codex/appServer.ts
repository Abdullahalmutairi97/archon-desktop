import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

export interface CodexChildProcess extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(signal?: NodeJS.Signals): boolean
}

export interface CodexSpawnOptions {
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide: true
  env: Readonly<Record<string, string>>
}

export type CodexProcessSpawner = (
  command: string,
  args: string[],
  options: CodexSpawnOptions,
) => CodexChildProcess

export interface CodexServerRequest {
  id: string | number
  method: string
  params: Record<string, unknown>
  processGeneration: number
}

export interface CodexAppServerClientOptions {
  command: string
  args?: string[]
  /** Explicit, purpose-scoped child environment. Never sourced from ambient Electron process.env here. */
  env: Readonly<Record<string, string>>
  spawn: CodexProcessSpawner
  requestTimeoutMs?: number
  maxFrameBytes?: number
  onProcessStart?: (processGeneration: number) => void
  onServerRequest?: (request: CodexServerRequest) => Promise<unknown> | unknown
  onDisconnect?: (processGeneration: number) => void
}

interface PendingRequest {
  processGeneration: number
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

type NotificationListener = (method: string, params: Record<string, unknown>, processGeneration: number) => void
type ProtocolId = string | number

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
])

function error(message: string): Error {
  return new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProtocolId(value: unknown): value is ProtocolId {
  return typeof value === 'string'
    ? value.length > 0 && value.length <= 128 && !value.includes('\0')
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number
  private readonly maxFrameBytes: number
  private readonly args: string[]
  private readonly env: Readonly<Record<string, string>>
  private process: CodexChildProcess | undefined
  private generation = 0
  private nextRequestId = 0
  private inputBuffer = ''
  private initializedGeneration: number | undefined
  private starting: Promise<number> | undefined
  private closed = false
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationListeners = new Set<NotificationListener>()

  constructor(private readonly options: CodexAppServerClientOptions) {
    if (typeof options.command !== 'string' || !options.command.trim() || options.command.includes('\0')) {
      throw new TypeError('A configured Codex executable is required.')
    }
    this.args = [...(options.args ?? ['app-server'])]
    this.env = validateChildEnvironment(options.env)
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 300_000) {
      throw new TypeError('Invalid Codex app-server request timeout.')
    }
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1024 || this.maxFrameBytes > 8 * 1024 * 1024) {
      throw new TypeError('Invalid Codex app-server frame limit.')
    }
  }

  get processGeneration(): number {
    return this.generation
  }

  get connected(): boolean {
    return this.initializedGeneration === this.generation && this.process !== undefined
  }

  async start(): Promise<number> {
    if (this.closed) throw error('Codex adapter is closed.')
    if (this.connected) return this.generation
    if (this.starting) return this.starting

    const starting = this.startProcess()
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (typeof method !== 'string' || !method || method.length > 160 || method.includes('\0') || !isRecord(params)) {
      throw new TypeError('Invalid Codex app-server request.')
    }
    const processGeneration = await this.start()
    const process = this.process
    if (!process || processGeneration !== this.generation) throw error('Codex app-server connection closed.')
    return this.sendRequest(process, processGeneration, method, params)
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const process = this.process
    const generation = this.generation
    if (process) {
      this.disconnect(process, generation)
      try {
        process.kill()
      } catch {
        // Pending work has already been rejected and approvals already denied.
      }
    }
    this.notificationListeners.clear()
  }

  private async startProcess(): Promise<number> {
    let process: CodexChildProcess
    try {
      process = this.options.spawn(this.options.command, [...this.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.env,
      })
    } catch {
      throw error('Could not start the configured Codex app server.')
    }

    const generation = ++this.generation
    this.process = process
    this.inputBuffer = ''
    this.initializedGeneration = undefined
    process.stdout.setEncoding('utf8')
    process.stdout.on('data', (chunk: string | Buffer) => this.readChunk(process, generation, String(chunk)))
    // Diagnostics can contain local file or prompt content; drain without logging.
    process.stderr.on('data', () => undefined)
    process.on('error', () => this.disconnect(process, generation))
    process.on('exit', () => this.disconnect(process, generation))
    try {
      this.options.onProcessStart?.(generation)
    } catch {
      this.protocolFailure(process, generation)
      throw error('Codex app-server lifecycle initialization failed.')
    }

    try {
      const result = await this.sendRequest(process, generation, 'initialize', {
        clientInfo: { name: 'archon_desktop', title: 'Archon Desktop', version: 'reconstruction' },
        capabilities: { experimentalApi: false },
      })
      if (!isRecord(result) || typeof result.userAgent !== 'string' || result.userAgent.length > 256) {
        throw error('Codex app server returned an invalid initialization response.')
      }
      this.writeMessage(process, generation, { method: 'initialized', params: {} })
      this.initializedGeneration = generation
      return generation
    } catch {
      if (this.process === process && this.generation === generation) {
        this.disconnect(process, generation)
        try {
          process.kill()
        } catch {
          // The adapter is already disconnected.
        }
      }
      throw error('Codex app server did not complete initialization.')
    }
  }

  private sendRequest(process: CodexChildProcess, generation: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.process !== process || this.generation !== generation || process.stdin.destroyed) {
      return Promise.reject(error('Codex app-server connection closed.'))
    }
    const id = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const current = this.pending.get(id)
        if (current?.processGeneration !== generation) return
        this.pending.delete(id)
        reject(error('Codex app-server request timed out.'))
      }, this.requestTimeoutMs)
      this.pending.set(id, { processGeneration: generation, resolve, reject, timeout })
      try {
        this.writeMessage(process, generation, { id, method, params })
      } catch {
        const current = this.pending.get(id)
        if (current) {
          clearTimeout(current.timeout)
          this.pending.delete(id)
        }
        reject(error('Codex app-server request could not be sent.'))
      }
    })
  }

  private writeMessage(process: CodexChildProcess, generation: number, message: Record<string, unknown>): void {
    if (this.process !== process || this.generation !== generation || process.stdin.destroyed) {
      throw error('Codex app-server connection closed.')
    }
    const frame = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(frame, 'utf8') > this.maxFrameBytes) throw error('Codex app-server request exceeds the protocol frame limit.')
    process.stdin.write(frame, 'utf8')
  }

  private readChunk(process: CodexChildProcess, generation: number, chunk: string): void {
    if (this.process !== process || this.generation !== generation) return
    this.inputBuffer += chunk
    let newline = this.inputBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.inputBuffer.slice(0, newline)
      this.inputBuffer = this.inputBuffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
        this.protocolFailure(process, generation)
        return
      }
      if (line.trim()) {
        let message: unknown
        try {
          message = JSON.parse(line) as unknown
        } catch {
          this.protocolFailure(process, generation)
          return
        }
        this.receive(process, generation, message)
        if (this.process !== process || this.generation !== generation) return
      }
      newline = this.inputBuffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.inputBuffer, 'utf8') > this.maxFrameBytes) this.protocolFailure(process, generation)
  }

  private receive(process: CodexChildProcess, generation: number, value: unknown): void {
    if (!isRecord(value)) return this.protocolFailure(process, generation)
    const id = value.id
    if (value.method !== undefined) {
      if (typeof value.method !== 'string' || value.method.length > 160 || !isRecord(value.params ?? {})) {
        return this.protocolFailure(process, generation)
      }
      const params = (value.params ?? {}) as Record<string, unknown>
      if (id !== undefined) {
        if (!isProtocolId(id)) return this.protocolFailure(process, generation)
        void this.handleServerRequest(process, generation, { id, method: value.method, params, processGeneration: generation })
      } else {
        for (const listener of this.notificationListeners) {
          try {
            listener(value.method, params, generation)
          } catch {
            // Notification consumers cannot break framing or affect another request.
          }
        }
      }
      return
    }

    if (!isProtocolId(id)) return this.protocolFailure(process, generation)
    const request = typeof id === 'number' ? this.pending.get(id) : undefined
    if (!request || request.processGeneration !== generation) return
    clearTimeout(request.timeout)
    this.pending.delete(id as number)
    if (value.error !== undefined) {
      request.reject(error('Codex app-server request failed.'))
    } else {
      request.resolve(value.result)
    }
  }

  private async handleServerRequest(process: CodexChildProcess, generation: number, request: CodexServerRequest): Promise<void> {
    let response: Record<string, unknown>
    if (!this.options.onServerRequest) {
      response = APPROVAL_METHODS.has(request.method)
        ? { id: request.id, result: { decision: 'decline' } }
        : { id: request.id, error: { code: -32601, message: 'This Codex interaction is not supported.' } }
    } else {
      try {
        const result = await this.options.onServerRequest(request)
        if (this.process !== process || this.generation !== generation) return
        if (APPROVAL_METHODS.has(request.method)) {
          const decision = isRecord(result) && (result.decision === 'accept' || result.decision === 'decline')
            ? result.decision
            : 'decline'
          response = { id: request.id, result: { decision } }
        } else {
          response = { id: request.id, result: result ?? {} }
        }
      } catch {
        if (this.process !== process || this.generation !== generation) return
        response = APPROVAL_METHODS.has(request.method)
          ? { id: request.id, result: { decision: 'decline' } }
          : { id: request.id, error: { code: -32601, message: 'This Codex interaction is not supported.' } }
      }
    }
    try {
      this.writeMessage(process, generation, response)
    } catch {
      this.disconnect(process, generation)
    }
  }

  private protocolFailure(process: CodexChildProcess, generation: number): void {
    if (this.process !== process || this.generation !== generation) return
    this.disconnect(process, generation)
    try {
      process.kill()
    } catch {
      // No protocol data is exposed to the renderer.
    }
  }

  private disconnect(process: CodexChildProcess, generation: number): void {
    if (this.process !== process || this.generation !== generation) return
    this.process = undefined
    this.initializedGeneration = undefined
    this.inputBuffer = ''
    for (const [id, request] of this.pending) {
      if (request.processGeneration !== generation) continue
      clearTimeout(request.timeout)
      this.pending.delete(id)
      request.reject(error('Codex app-server connection closed.'))
    }
    try {
      this.options.onDisconnect?.(generation)
    } catch {
      // Disconnect cleanup must not revive or replace the old process.
    }
  }
}

function validateChildEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('An explicit Codex child environment is required.')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 128) throw new TypeError('Invalid Codex child environment.')
  const environment: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string'
      || item.includes('\0') || item.length > 16_384) {
      throw new TypeError('Invalid Codex child environment.')
    }
    environment[key] = item
  }
  return Object.freeze(environment)
}
