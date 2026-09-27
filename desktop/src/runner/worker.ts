import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { isAbsolute } from 'node:path'
import { LocalCodexController, createCodexChildEnvironment, createLocalCodexRuntimeFactory, resolveCodexExecutable } from '../main/localCodexController'
import type { CodexChildProcess } from '../main/adapters/codex/appServer'
import { OwnedCodexMetadataStore } from '../main/adapters/codex/metadata'
import { acquireCodexOwnerLease } from '../main/adapters/codex/ownerLease'
import { LocalCodexRunnerProtocol, MAX_RUNNER_FRAME_BYTES } from './protocol'

interface WorkerConfig {
  metadataRoot: string
  homeDirectory: string
  codexHomeDirectory: string
  codexExecutable?: string
}

function requireAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid ${name}.`)
  }
  return value
}

/** Startup config is argv-only so the parent explicitly selects all state paths. */
export function parseWorkerConfig(argv: readonly string[]): WorkerConfig {
  const allowed = new Set(['--metadata-root', '--home-directory', '--codex-home-directory', '--codex-executable'])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag || !allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) {
      throw new TypeError('Invalid runner startup arguments.')
    }
    values.set(flag, value)
    index += 1
  }
  const metadataRoot = requireAbsolutePath(values.get('--metadata-root'), 'metadata root')
  const homeDirectory = requireAbsolutePath(values.get('--home-directory'), 'home directory')
  const codexHomeDirectory = requireAbsolutePath(values.get('--codex-home-directory'), 'Codex home directory')
  const codexExecutable = values.get('--codex-executable')
  return Object.freeze({
    metadataRoot,
    homeDirectory,
    codexHomeDirectory,
    ...(codexExecutable === undefined ? {} : { codexExecutable: requireAbsolutePath(codexExecutable, 'Codex executable') }),
  })
}

function attachInput(stream: Readable, protocol: LocalCodexRunnerProtocol): void {
  const decoder = new StringDecoder('utf8')
  let partial = ''
  let droppingOversizedFrame = false

  const consume = (text: string): void => {
    let remaining = text
    while (remaining.length > 0) {
      if (droppingOversizedFrame) {
        const newline = remaining.indexOf('\n')
        if (newline < 0) return
        droppingOversizedFrame = false
        remaining = remaining.slice(newline + 1)
        protocol.receiveOversizedFrame()
        continue
      }

      const newline = remaining.indexOf('\n')
      if (newline >= 0) {
        const line = `${partial}${remaining.slice(0, newline)}`
        partial = ''
        remaining = remaining.slice(newline + 1)
        if (Buffer.byteLength(line, 'utf8') > MAX_RUNNER_FRAME_BYTES) protocol.receiveOversizedFrame()
        else if (line.trim()) void protocol.receive(line)
        continue
      }

      partial += remaining
      if (Buffer.byteLength(partial, 'utf8') > MAX_RUNNER_FRAME_BYTES) {
        partial = ''
        droppingOversizedFrame = true
      }
      return
    }
  }

  stream.on('data', (chunk: Buffer | string) => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk)))
  stream.on('end', () => {
    const trailing = partial + decoder.end()
    partial = ''
    if (droppingOversizedFrame || Buffer.byteLength(trailing, 'utf8') > MAX_RUNNER_FRAME_BYTES) {
      protocol.receiveOversizedFrame()
    } else if (trailing.trim()) {
      void protocol.receive(trailing)
    }
    protocol.inputClosed()
  })
  stream.on('error', () => protocol.inputClosed())
}

async function startWorker(argv: readonly string[]): Promise<void> {
  const config = parseWorkerConfig(argv)
  const ownerLease = await acquireCodexOwnerLease(config.metadataRoot, 'backend-worker')
  process.once('exit', () => ownerLease.releaseSync())
  try {
    const metadata = new OwnedCodexMetadataStore(config.metadataRoot)
    // Loading validates the exact parent-selected profile path before the worker accepts RPC.
    await metadata.load()
    const env = createCodexChildEnvironment({
      homeDirectory: config.homeDirectory,
      codexHomeDirectory: config.codexHomeDirectory,
    })
    const command = await resolveCodexExecutable(config.codexExecutable, false)
    const runtimeFactory = createLocalCodexRuntimeFactory({
      metadata,
      command,
      env,
      spawn: (executable, args, options) => spawn(executable, args, {
        ...options,
        env: { ...options.env },
      }) as unknown as CodexChildProcess,
    })
    const controller = new LocalCodexController({
      metadata,
      protectedRoots: [env.CODEX_HOME],
      createRuntime: runtimeFactory,
      // The native picker remains in Electron. This fixed worker surface only accepts roots
      // that the trusted parent resolved and sends through registerWorkspaceRoot.
      pickProjectDirectory: async () => null,
    })

    let outputClosed = false
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') outputClosed = true
    })
    const protocol = new LocalCodexRunnerProtocol(controller, (message) => {
      if (outputClosed || process.stdout.destroyed) return
      try {
        const frame = `${JSON.stringify(message)}\n`
        if (Buffer.byteLength(frame, 'utf8') <= MAX_RUNNER_FRAME_BYTES) process.stdout.write(frame, 'utf8')
      } catch {
        // Keep protocol state and the active turn alive if the Electron parent has gone away.
        outputClosed = true
      }
    }, () => ownerLease.releaseSync())
    attachInput(process.stdin, protocol)
  } catch (error) {
    ownerLease.releaseSync()
    throw error
  }
}

if (require.main === module) {
  void startWorker(process.argv.slice(2)).catch(() => {
    // Do not print raw config, paths, or underlying errors to the parent-facing JSONL channel.
    process.stderr.write('Local Codex runner could not start.\n')
    process.exitCode = 1
  })
}
