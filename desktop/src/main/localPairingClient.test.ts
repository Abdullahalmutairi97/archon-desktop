// @vitest-environment node
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_PAIRING_AUDIENCE, LocalPairingClient } from './localPairingClient'

const SERVER_URL = 'http://127.0.0.1:43123'

function challengeResponse() {
  return { ok: true, challenge: {
    nonce: 'challenge_nonce_1234567890', audience: LOCAL_PAIRING_AUDIENCE,
    expires_at: Math.floor(Date.now() / 1000) + 30,
  } }
}

function credentialResponse() {
  const uid = process.getuid!()
  return { ok: true, credential: {
    access_token: 'ephemeral-local-token-123456789',
    principal: { principal_id: `local-uid:${uid}`, uid, auth_method: 'unix-peer-credentials' },
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    server_url: SERVER_URL,
  } }
}

describe('local Unix socket pairing client', () => {
  let root: string | undefined
  let server: ReturnType<typeof createServer> | undefined
  let clients: Socket[] = []

  afterEach(async () => {
    for (const socket of clients) socket.destroy()
    clients = []
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function socketDirectory() {
    root = await mkdtemp(join(tmpdir(), 'archon-pair-client-'))
    await chmod(root, 0o700)
    return { socketPath: join(root, 'pairing.sock') }
  }

  it('uses one protected socket for the exact challenge and redemption exchange', async () => {
    const { socketPath } = await socketDirectory()
    const requests: unknown[] = []
    let connections = 0
    server = createServer((socket) => {
      clients.push(socket)
      connections += 1
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const request = JSON.parse(line) as Record<string, unknown>
          requests.push(request)
          socket.write(`${JSON.stringify(request.op === 'challenge' ? challengeResponse() : credentialResponse())}\n`)
          if (request.op === 'redeem') socket.end()
        }
      })
    })
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve))
    await chmod(socketPath, 0o600)

    const paired = await new LocalPairingClient({ socketPath }).pair()
    expect(paired).toEqual({
      serverUrl: SERVER_URL,
      token: 'ephemeral-local-token-123456789',
      expiresAt: expect.any(Number),
    })
    expect(connections).toBe(1)
    expect(requests).toEqual([
      { op: 'challenge', audience: LOCAL_PAIRING_AUDIENCE },
      { op: 'redeem', audience: LOCAL_PAIRING_AUDIENCE, nonce: 'challenge_nonce_1234567890' },
    ])
    expect((await lstat(socketPath)).isSocket()).toBe(true)
  })

  it('rejects an unprotected socket directory and malformed credential responses', async () => {
    const { socketPath } = await socketDirectory()
    await chmod(root!, 0o755)
    await expect(new LocalPairingClient({ socketPath }).pair()).rejects.toThrow(/could not be paired/i)

    await chmod(root!, 0o700)
    server = createServer((socket) => {
      clients.push(socket)
      let count = 0
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => {
        buffer += chunk
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          buffer = buffer.slice(newline + 1)
          count += 1
          socket.write(`${JSON.stringify(count === 1 ? challengeResponse() : {
            ok: true, credential: { ...credentialResponse().credential, server_url: 'https://archon.example.test' },
          })}\n`)
        }
      })
    })
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve))
    await chmod(socketPath, 0o600)
    await expect(new LocalPairingClient({ socketPath }).pair()).rejects.toThrow(/could not be paired/i)
  })

  it('bounds a silent challenge response by the configured timeout', async () => {
    const { socketPath } = await socketDirectory()
    server = createServer((socket) => { clients.push(socket) })
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve))
    await chmod(socketPath, 0o600)

    const client = new LocalPairingClient({ socketPath, timeoutMs: 20 })
    await expect(client.pair()).rejects.toThrow(/could not be paired/i)
  })

  it('rejects an oversized challenge response before buffering it', async () => {
    const { socketPath } = await socketDirectory()
    server = createServer((socket) => {
      clients.push(socket)
      socket.once('data', () => socket.write(Buffer.alloc(1024 * 1024, 0x41)))
    })
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve))
    await chmod(socketPath, 0o600)

    await expect(new LocalPairingClient({ socketPath }).pair()).rejects.toThrow(/could not be paired/i)
  })
})
