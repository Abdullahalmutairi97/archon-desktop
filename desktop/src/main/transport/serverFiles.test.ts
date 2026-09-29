import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_CHANNELS, isServerFilePath, parseBridgeRequest, parseBridgeResponse } from '../../shared/bridge/validation'
import type { ServerFileDownloadSink, ServerFileLocalPort } from '../serverFileLocalPort'
import { registerBridgeHandlers } from '../registerBridge'
import { createConnectionService } from '../connectionService'
import { BackendTransport, BackendTransportError, SERVER_FILE_OPERATIONS, type BackendFetch } from './backendTransport'

const localConnection = { serverUrl: 'http://127.0.0.1:8000', token: 'TOKEN_SENTINEL' }
const PICK = `upload-${'a'.repeat(32)}`

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const item = (name: string, path: string, isDir = false) => ({
  name, path, is_dir: isDir, is_symlink: false, restricted: false, size: isDir ? 4096 : 12,
  modified_at: '2026-09-01T10:00:00+00:00', mime: isDir ? null : 'text/markdown',
})

const readResult = (path: string, content: string) => ({
  path, content, size: new TextEncoder().encode(content).byteLength,
  read: new TextEncoder().encode(content).byteLength, truncated: false, binary: false,
})

function transportWith(fetcher: BackendFetch, serverFiles?: ServerFileLocalPort) {
  return new BackendTransport({ ...localConnection, fetch: fetcher, serverFiles })
}

function fakePort(overrides: Partial<ServerFileLocalPort> = {}) {
  let held = true
  const port: ServerFileLocalPort = {
    pickUpload: vi.fn(async () => ({ pickId: PICK, name: 'photo.png', size: 3 })),
    hasUpload: vi.fn(() => held),
    takeUpload: vi.fn(async () => { held = false; return { name: 'photo.png', size: 3, blob: new Blob([new Uint8Array([1, 2, 3])]) } }),
    discardUpload: vi.fn(() => { held = false }),
    chooseDownloadTarget: vi.fn(async () => null),
    ...overrides,
  }
  return port
}

function fakeSink() {
  const chunks: Uint8Array[] = []
  const sink = {
    name: 'report.pdf',
    write: vi.fn(async (chunk: Uint8Array) => { chunks.push(chunk) }),
    commit: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  } satisfies ServerFileDownloadSink
  return { sink, chunks }
}

describe('server file validation', () => {
  it('accepts only root-relative paths the server cannot reinterpret', () => {
    for (const path of ['notes', 'notes/2026-09-29.md', 'projects/app/src/index.ts', 'مجلد/ملف.md', 'a b/c']) {
      expect(isServerFilePath(path)).toBe(true)
    }
    expect(isServerFilePath('', true)).toBe(true)
    for (const path of ['', '/etc/passwd', '../x', 'a/../b', 'a/./b', './a', 'a//b', 'a/', '~/x', '~root', 'a\\b',
      'a\0b', 'a\nb', 'a\u0085b', 'x'.repeat(1_001), `${'x'.repeat(256)}`, '\ud800', 1, null]) {
      expect(isServerFilePath(path)).toBe(false)
    }
  })

  it('rejects hostile payloads for every server file operation at the bridge', () => {
    const bad: [string, unknown][] = [
      ['files.list', { path: '../' }],
      ['files.list', { path: '', extra: 1 }],
      ['files.read', { path: 'a.md' }],
      ['files.read', { path: 'a.md', maxBytes: 1024 * 1024 + 1 }],
      ['files.read', { path: '/abs', maxBytes: 10 }],
      ['files.writeText', { path: 'a.md', content: 'x\0y' }],
      ['files.writeText', { path: 'a.md', content: '\ud800' }],
      ['files.writeText', { path: '', content: 'x' }],
      ['files.mkdir', { path: 'a/../../b' }],
      ['files.rename', { path: 'a', destination: 'a' }],
      ['files.rename', { path: 'a', destination: '/tmp/a' }],
      ['files.copy', { path: 'a', destination: '~/b' }],
      ['files.pickUpload', { path: '/home/me/secret' }],
      ['files.upload', { pickId: 'upload-x', path: 'a', replace: false }],
      ['files.upload', { pickId: PICK, path: 'a', replace: 'yes' }],
      ['files.upload', { pickId: PICK, path: 'a', replace: false, localPath: '/etc/shadow' }],
      ['files.download', { path: '../x' }],
      ['files.download', { path: 'a', saveTo: '/tmp/x' }],
      ['files.delete', { path: 'a' }],
      ['files.delete', { path: 'a', confirm: false }],
      ['files.delete', { path: '', confirm: true }],
    ]
    for (const [operation, payload] of bad) {
      expect(() => parseBridgeRequest(BRIDGE_CHANNELS.apiInvoke, [operation, payload]), `${operation} ${JSON.stringify(payload)}`).toThrow()
    }
    expect(parseBridgeRequest(BRIDGE_CHANNELS.apiInvoke, ['files.delete', { path: 'notes/a.md', confirm: true }]).args[1])
      .toEqual({ path: 'notes/a.md', confirm: true })
  })

  it('bounds text saves by JSON-encoded size, not character count', () => {
    const fits = 'a'.repeat(1024 * 1024 - 2)
    expect(() => parseBridgeRequest(BRIDGE_CHANNELS.apiInvoke, ['files.writeText', { path: 'a.txt', content: fits }])).not.toThrow()
    expect(() => parseBridgeRequest(BRIDGE_CHANNELS.apiInvoke, ['files.writeText', { path: 'a.txt', content: `${fits}a` }])).toThrow()
    // Quotes double when JSON-encoded, so half as many fit.
    expect(() => parseBridgeRequest(BRIDGE_CHANNELS.apiInvoke, ['files.writeText', { path: 'a.txt', content: '"'.repeat(600_000) }])).toThrow()
  })

  it('validates server file responses strictly', () => {
    const parse = (operation: string, value: unknown) => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, value, operation)
    expect(parse('files.list', { root: '/home/owner', path: '.', items: [item('a.md', 'a.md')] })).toMatchObject({ items: [{ name: 'a.md' }] })
    expect(() => parse('files.list', { root: '/r', path: '.', items: [{ ...item('a', 'a'), token: 'x' }] })).toThrow()
    expect(() => parse('files.list', { root: '/r', path: '.', items: [item('a/b', 'a/b')] })).toThrow()
    expect(() => parse('files.list', { root: '/r', path: '.', items: Array.from({ length: 2_001 }, (_, i) => item(`f${i}`, `f${i}`)) })).toThrow()
    expect(() => parse('files.read', { ...readResult('a', 'hi'), binary: true })).toThrow()
    expect(() => parse('files.read', { ...readResult('a', 'hi'), truncated: true })).toThrow()
    expect(() => parse('files.read', { ...readResult('a', 'hi'), content: 'much longer than read' })).toThrow()
    expect(() => parse('files.writeText', { ...readResult('a', 'hi'), size: 10, truncated: true })).toThrow()
    expect(() => parse('files.delete', { ok: false })).toThrow()
    expect(() => parse('files.download', { saved: true, name: 'x', size: 100 * 1024 * 1024 + 1 })).toThrow()
    expect(parse('files.pickUpload', { cancelled: true })).toEqual({ cancelled: true })
    expect(() => parse('files.pickUpload', { cancelled: false, pickId: PICK, name: 'x', size: 1, path: '/home/me/x' })).toThrow()
  })
})

describe('server file transport', () => {
  it('lists the server group in one reviewed set', () => {
    expect(SERVER_FILE_OPERATIONS).toEqual([
      'files.list', 'files.read', 'files.writeText', 'files.mkdir', 'files.rename', 'files.copy',
      'files.pickUpload', 'files.upload', 'files.download', 'files.delete',
    ])
  })

  it('maps each operation to its exact method, route and body', async () => {
    const cases: { operation: string; payload: Record<string, unknown>; reply: unknown; method: string; path: string; query: Record<string, string>; body?: unknown }[] = [
      { operation: 'files.list', payload: { path: '' }, reply: { root: '/home/o', path: '.', items: [] }, method: 'GET', path: '/api/files', query: { path: '.' } },
      { operation: 'files.list', payload: { path: 'notes' }, reply: { root: '/home/o', path: 'notes', items: [item('a.md', 'notes/a.md')] }, method: 'GET', path: '/api/files', query: { path: 'notes' } },
      { operation: 'files.read', payload: { path: 'notes/a.md', maxBytes: 4096 }, reply: readResult('notes/a.md', '# hi'), method: 'GET', path: '/api/files/read', query: { path: 'notes/a.md', max_bytes: '4096' } },
      { operation: 'files.writeText', payload: { path: 'notes/a.md', content: '# hi' }, reply: readResult('notes/a.md', '# hi'), method: 'PUT', path: '/api/files/text', query: {}, body: { path: 'notes/a.md', content: '# hi' } },
      { operation: 'files.mkdir', payload: { path: 'notes' }, reply: { path: 'notes', created: true }, method: 'POST', path: '/api/files/mkdir', query: {}, body: { path: 'notes' } },
      { operation: 'files.rename', payload: { path: 'a', destination: 'b' }, reply: { path: 'b' }, method: 'POST', path: '/api/files/rename', query: {}, body: { path: 'a', destination: 'b' } },
      { operation: 'files.copy', payload: { path: 'a', destination: 'dir/a' }, reply: { path: 'dir/a' }, method: 'POST', path: '/api/files/copy', query: {}, body: { path: 'a', destination: 'dir/a' } },
      { operation: 'files.delete', payload: { path: 'notes/a.md', confirm: true }, reply: { ok: true }, method: 'DELETE', path: '/api/files', query: {}, body: { path: 'notes/a.md', confirm: true } },
    ]
    for (const entry of cases) {
      const fetcher = vi.fn<BackendFetch>(async () => response(entry.reply))
      await expect(transportWith(fetcher).invoke(entry.operation as never, entry.payload as never)).resolves.toEqual(entry.reply)
      expect(fetcher).toHaveBeenCalledOnce()
      const [url, init] = fetcher.mock.calls[0]
      expect(init.method, entry.operation).toBe(entry.method)
      expect(url.pathname).toBe(entry.path)
      expect(Object.fromEntries(url.searchParams)).toEqual(entry.query)
      expect(init.redirect).toBe('manual')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer TOKEN_SENTINEL')
      if (entry.body === undefined) expect(init.body).toBeUndefined()
      else {
        expect(JSON.parse(String(init.body))).toEqual(entry.body)
        expect(new Headers(init.headers).get('content-type')).toBe('application/json')
      }
    }
  })

  it('rejects hostile paths and oversized text before any request', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ ok: true }))
    const transport = transportWith(fetcher)
    for (const [operation, payload] of [
      ['files.list', { path: '../..' }],
      ['files.read', { path: '/etc/passwd', maxBytes: 10 }],
      ['files.writeText', { path: 'a.md', content: 'x'.repeat(1024 * 1024 + 1) }],
      ['files.mkdir', { path: 'a\u0000b' }],
      ['files.rename', { path: 'a', destination: '../a' }],
      ['files.delete', { path: 'a', confirm: false }],
    ] as const) {
      await expect(transport.invoke(operation as never, payload as never)).rejects.toMatchObject({ code: 'invalid_payload' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports restricted, missing, colliding and binary paths distinctly without auth failure', async () => {
    const statusFor = async (operation: string, payload: unknown, status: number) =>
      transportWith(async () => response({ detail: 'private detail' }, status)).invoke(operation as never, payload as never).catch((error: unknown) => error)
    const restricted = await statusFor('files.read', { path: '.env', maxBytes: 10 }, 403)
    expect(restricted).toMatchObject({ code: 'restricted_path' })
    expect((restricted as BackendTransportError).httpStatus).toBeUndefined()
    expect(String(restricted)).not.toContain('private detail')
    expect(await statusFor('files.delete', { path: 'gone', confirm: true }, 404)).toMatchObject({ code: 'not_found' })
    expect(await statusFor('files.rename', { path: 'a', destination: 'b' }, 409)).toMatchObject({ code: 'already_exists' })
    expect(await statusFor('files.read', { path: 'a.bin', maxBytes: 10 }, 400)).toMatchObject({ code: 'binary_file' })
    expect(await statusFor('files.list', { path: 'a.md' }, 400)).toMatchObject({ code: 'not_a_directory' })
    expect(await statusFor('files.list', { path: 'a' }, 401)).toMatchObject({ code: 'unauthorized', httpStatus: 401 })
  })

  it('never retries a server file mutation after an ambiguous failure', async () => {
    for (const [operation, payload] of [
      ['files.writeText', { path: 'a.md', content: 'x' }],
      ['files.mkdir', { path: 'd' }],
      ['files.rename', { path: 'a', destination: 'b' }],
      ['files.copy', { path: 'a', destination: 'b' }],
      ['files.delete', { path: 'a', confirm: true }],
    ] as const) {
      const fetcher = vi.fn<BackendFetch>(async () => { throw new Error('socket closed') })
      await expect(transportWith(fetcher).invoke(operation as never, payload as never)).rejects.toMatchObject({ code: 'network_error' })
      expect(fetcher).toHaveBeenCalledOnce()
    }
  })

  it('refuses a save whose read-back differs from what was sent', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response(readResult('a.md', 'other')))
    await expect(transportWith(fetcher).invoke('files.writeText', { path: 'a.md', content: 'mine' })).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('does not retry a file mutation after an HTTP 401 re-pairing', async () => {
    let generation = 1
    const transport = {
      get generation() { return generation },
      switchConnection: vi.fn(() => ++generation),
      disconnect: vi.fn(() => ++generation),
      probe: vi.fn(async () => ({ ok: true, readiness: {} })),
      invoke: vi.fn(async () => { throw new BackendTransportError('unauthorized', 401) }),
    }
    const credentials = {
      loadConnectionForMainTransport: vi.fn(async () => undefined),
      saveConnection: vi.fn(),
      describe: vi.fn(async () => ({ configured: false, storageMode: 'memory' as const })),
      clear: vi.fn(),
    }
    const localPairing = { pair: vi.fn(async () => ({ serverUrl: 'http://127.0.0.1:43123', token: 'local-token-123456789', expiresAt: Math.floor(Date.now() / 1000) + 86400 })) }
    const service = await createConnectionService(transport as never, credentials as never, { localPairing })
    await expect(service.invoke('files.delete', { path: 'a', confirm: true })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(transport.invoke).toHaveBeenCalledOnce()
  })

  it('carries a large text save through the IPC guard but keeps the default bound elsewhere', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const invoke = vi.fn(async () => readResult('a.md', 'x'.repeat(100_000)))
    registerBridgeHandlers({ handle: (channel, handler) => handlers.set(channel, handler), removeHandler: vi.fn() }, () => true, {
      describe: vi.fn(), save: vi.fn(), disconnect: vi.fn(), probe: vi.fn(), invoke,
    } as never)
    const api = handlers.get(BRIDGE_CHANNELS.apiInvoke)!
    await expect(api({}, 'files.writeText', { path: 'a.md', content: 'x'.repeat(100_000) })).resolves.toMatchObject({ path: 'a.md' })
    await expect(api({}, 'files.mkdir', { path: 'x'.repeat(20_000) })).rejects.toThrow()
    expect(invoke).toHaveBeenCalledOnce()
  })
})

describe('server file upload and download', () => {
  it('reports no dialogs as unsupported and a cancelled pick without a request', async () => {
    const fetcher = vi.fn<BackendFetch>()
    await expect(transportWith(fetcher).invoke('files.pickUpload', {})).rejects.toMatchObject({ code: 'unsupported_operation' })
    const port = fakePort({ pickUpload: vi.fn(async () => null) })
    await expect(transportWith(fetcher, port).invoke('files.pickUpload', {})).resolves.toEqual({ cancelled: true })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses a pick over the server upload limit', async () => {
    const port = fakePort({ pickUpload: vi.fn(async () => ({ pickId: PICK, name: 'big.iso', size: 100 * 1024 * 1024 + 1 })) })
    await expect(transportWith(vi.fn(), port).invoke('files.pickUpload', {})).rejects.toMatchObject({ code: 'too_large' })
    expect(port.discardUpload).toHaveBeenCalledWith(PICK)
  })

  it('uploads the picked file once as multipart after checking for a collision', async () => {
    const port = fakePort()
    const fetcher = vi.fn<BackendFetch>(async (url) => url.pathname === '/api/files'
      ? response({ root: '/home/o', path: 'media', items: [item('other.png', 'media/other.png')] })
      : response({ path: 'media/photo.png', size: 3 }))
    const transport = transportWith(fetcher, port)
    await expect(transport.invoke('files.pickUpload', {})).resolves.toEqual({ cancelled: false, pickId: PICK, name: 'photo.png', size: 3 })
    await expect(transport.invoke('files.upload', { pickId: PICK, path: 'media/photo.png', replace: false }))
      .resolves.toEqual({ path: 'media/photo.png', size: 3 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [listUrl] = fetcher.mock.calls[0]
    expect(listUrl.searchParams.get('path')).toBe('media')
    const [url, init] = fetcher.mock.calls[1]
    expect(url.pathname).toBe('/api/files/upload')
    expect(url.searchParams.get('path')).toBe('media/photo.png')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    const part = (init.body as FormData).get('upload') as File
    expect(part.name).toBe('photo.png')
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(new Headers(init.headers).get('content-type')).toBeNull()

    // The pick was consumed: it cannot be sent a second time.
    await expect(transport.invoke('files.upload', { pickId: PICK, path: 'media/photo.png', replace: true }))
      .rejects.toMatchObject({ code: 'upload_expired' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refuses to overwrite without replace and keeps the pick for a confirmed retry', async () => {
    const port = fakePort()
    const fetcher = vi.fn<BackendFetch>(async (url) => url.pathname === '/api/files'
      ? response({ root: '/home/o', path: '.', items: [item('photo.png', 'photo.png')] })
      : response({ path: 'photo.png', size: 3 }))
    const transport = transportWith(fetcher, port)
    await expect(transport.invoke('files.upload', { pickId: PICK, path: 'photo.png', replace: false }))
      .rejects.toMatchObject({ code: 'already_exists' })
    expect(port.takeUpload).not.toHaveBeenCalled()
    await expect(transport.invoke('files.upload', { pickId: PICK, path: 'photo.png', replace: true })).resolves.toEqual({ path: 'photo.png', size: 3 })
    expect(fetcher.mock.calls.map(([url]) => url.pathname)).toEqual(['/api/files', '/api/files/upload'])
  })

  it('never retries an upload after an ambiguous failure and maps 413', async () => {
    const failing = vi.fn<BackendFetch>(async () => { throw new Error('reset') })
    await expect(transportWith(failing, fakePort()).invoke('files.upload', { pickId: PICK, path: 'a.png', replace: true }))
      .rejects.toMatchObject({ code: 'network_error' })
    expect(failing).toHaveBeenCalledOnce()
    const tooLarge = vi.fn<BackendFetch>(async () => response({ detail: 'Upload exceeds 100 MiB' }, 413))
    await expect(transportWith(tooLarge, fakePort()).invoke('files.upload', { pickId: PICK, path: 'a.png', replace: true }))
      .rejects.toMatchObject({ code: 'too_large' })
  })

  it('streams a download into the chosen place and returns only its name and size', async () => {
    const { sink, chunks } = fakeSink()
    const port = fakePort({ chooseDownloadTarget: vi.fn(async () => sink) })
    const fetcher = vi.fn<BackendFetch>(async () => new Response(new Uint8Array([9, 8, 7, 6]), { status: 200, headers: { 'Content-Type': 'application/pdf' } }))
    await expect(transportWith(fetcher, port).invoke('files.download', { path: 'docs/report.pdf' })).resolves.toEqual({ saved: true, name: 'report.pdf', size: 4 })
    expect(port.chooseDownloadTarget).toHaveBeenCalledWith('report.pdf')
    const [url, init] = fetcher.mock.calls[0]
    expect(url.pathname).toBe('/api/files/download')
    expect(url.searchParams.get('path')).toBe('docs/report.pdf')
    expect(init.method).toBe('GET')
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([9, 8, 7, 6]))
    expect(sink.commit).toHaveBeenCalledOnce()
    expect(sink.abort).not.toHaveBeenCalled()
  })

  it('asks before fetching and aborts the partial file on failure', async () => {
    const fetcher = vi.fn<BackendFetch>()
    await expect(transportWith(fetcher, fakePort()).invoke('files.download', { path: 'a.pdf' })).resolves.toEqual({ saved: false })
    expect(fetcher).not.toHaveBeenCalled()

    const { sink } = fakeSink()
    const big = vi.fn<BackendFetch>(async () => new Response('x', { status: 200, headers: { 'Content-Length': String(100 * 1024 * 1024 + 1) } }))
    await expect(transportWith(big, fakePort({ chooseDownloadTarget: vi.fn(async () => sink) })).invoke('files.download', { path: 'a.iso' }))
      .rejects.toMatchObject({ code: 'too_large' })
    expect(sink.abort).toHaveBeenCalledOnce()
    expect(sink.commit).not.toHaveBeenCalled()

    const { sink: restrictedSink } = fakeSink()
    const restricted = vi.fn<BackendFetch>(async () => response({ detail: 'secret' }, 403))
    await expect(transportWith(restricted, fakePort({ chooseDownloadTarget: vi.fn(async () => restrictedSink) })).invoke('files.download', { path: '.env' }))
      .rejects.toMatchObject({ code: 'restricted_path' })
    expect(restrictedSink.abort).toHaveBeenCalledOnce()
    expect(restricted).toHaveBeenCalledOnce()
  })
})
