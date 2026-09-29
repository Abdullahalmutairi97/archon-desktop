import { describe, expect, it, vi } from 'vitest'
import { MAX_AUDIO_BYTES } from '../../shared/bridge/validation'
import { BackendTransport, COMPOSER_OPERATIONS, type BackendFetch } from './backendTransport'

const localConnection = { serverUrl: 'http://127.0.0.1:8000', token: 'TOKEN_SENTINEL' }

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const catalog = {
  current: { provider: 'openai-codex', model: 'gpt-5.6-terra', base_url_configured: true },
  fallback: null,
  providers: [{ id: 'openai-codex', models: ['gpt-5.6-terra'] }],
  choices: [{ provider: 'openai-codex', model: 'gpt-5.6-terra' }],
}
const status = { available: true, stt: { available: true, provider: 'stt' }, tts: { available: true, provider: 'tts' } }
const transcript = { success: true, transcript: 'hello', provider: 'stt' }
const task = { task: { id: 'task-1', status: 'queued' } }

function audio(bytes: number): { dataUrl: string; mimeType: string } {
  return { dataUrl: `data:audio/webm;base64,${Buffer.alloc(bytes, 1).toString('base64')}`, mimeType: 'audio/webm' }
}

describe('composer transport', () => {
  it('keeps composer operations in their own group', () => {
    expect(COMPOSER_OPERATIONS).toEqual(['models.catalog', 'audio.status', 'audio.transcribe'])
  })

  it('maps catalog, status and transcription to fixed routes with exact bodies', async () => {
    const fetcher = vi.fn<BackendFetch>(async (url) => response(
      url.pathname === '/api/models' ? catalog : url.pathname === '/api/audio/status' ? status : transcript))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })

    await expect(transport.invoke('models.catalog', {})).resolves.toEqual(catalog)
    await expect(transport.invoke('audio.status', {})).resolves.toEqual(status)
    const upload = audio(6)
    await expect(transport.invoke('audio.transcribe', upload)).resolves.toEqual(transcript)

    expect(fetcher.mock.calls.map(([url, init]) => [url.pathname + url.search, init.method, init.body])).toEqual([
      ['/api/models', 'GET', undefined],
      ['/api/audio/status', 'GET', undefined],
      ['/api/audio/transcribe', 'POST', JSON.stringify({ data_url: upload.dataUrl, mime_type: 'audio/webm' })],
    ])
    const headers = fetcher.mock.calls[2][1].headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toBe(`Bearer ${localConnection.token}`)
    expect(headers['Idempotency-Key']).toBeUndefined()
  })

  it('sends a model choice only as model and provider on the Prime task routes', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response(task, 202))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await transport.invoke('tasks.submit', { projectId: 'project-1', prompt: 'Start', runtime: 'prime', model: 'gpt-5.6-terra', provider: 'openai-codex' })
    await transport.invoke('tasks.submit', { sessionId: 'prime-abc', prompt: 'Next', model: 'gpt-5.5', provider: 'openai-codex' })
    await transport.invoke('tasks.submit', { projectId: 'project-1', prompt: 'Plain' })

    expect(fetcher.mock.calls.map(([url, init]) => [url.pathname, JSON.parse(String(init.body))])).toEqual([
      ['/api/tasks', { prompt: 'Start', project_id: 'project-1', profile: 'prime', model: 'gpt-5.6-terra', provider: 'openai-codex', approval_mode: 'auto', chat_only: false }],
      ['/api/tasks', { prompt: 'Next', session_id: 'prime-abc', model: 'gpt-5.5', provider: 'openai-codex', approval_mode: 'auto', chat_only: false }],
      ['/api/tasks', { prompt: 'Plain', project_id: 'project-1', profile: 'prime', approval_mode: 'auto', chat_only: false }],
    ])
  })

  it('refuses hostile model choices and oversized audio before any request', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response(task, 202))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    for (const payload of [
      { projectId: 'project-1', prompt: 'x', runtime: 'pi', model: 'gpt-5.5', provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: 'gpt-5.5', provider: 'anthropic' },
      { projectId: 'project-1', prompt: 'x', workspaceId: `workspace-${'a'.repeat(32)}`, workspaceGeneration: 1, model: 'gpt-5.5', provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: '../../etc', provider: 'openai-codex' },
    ]) {
      await expect(transport.invoke('tasks.submit', payload as never)).rejects.toMatchObject({ code: 'invalid_payload' })
    }
    await expect(transport.invoke('audio.transcribe', audio(MAX_AUDIO_BYTES + 1))).rejects.toMatchObject({ code: 'invalid_payload' })
    // The large audio allowance never applies to another operation.
    await expect(transport.invoke('tasks.submit', { projectId: 'project-1', prompt: 'x'.repeat(70_000) } as never))
      .rejects.toMatchObject({ code: 'invalid_payload' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uploads audio at the server ceiling', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response(transcript))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await expect(transport.invoke('audio.transcribe', audio(MAX_AUDIO_BYTES))).resolves.toEqual(transcript)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('never retries a transcription after a network failure or an HTTP error', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => { throw new Error('connection lost') })
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await expect(transport.invoke('audio.transcribe', audio(3))).rejects.toMatchObject({ code: 'network_error' })
    expect(fetcher).toHaveBeenCalledOnce()

    fetcher.mockReset()
    fetcher.mockImplementation(async () => response({ detail: 'Hermes local voice runtime is not installed' }, 500))
    await expect(transport.invoke('audio.transcribe', audio(3))).rejects.toMatchObject({ code: 'http_error' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rejects a catalog that offers an unlisted choice or carries a credential', async () => {
    const fetcher = vi.fn<BackendFetch>(async () => response({ ...catalog, choices: [{ provider: 'openai-codex', model: 'ghost' }] }))
    const transport = new BackendTransport({ ...localConnection, fetch: fetcher })
    await expect(transport.invoke('models.catalog', {})).rejects.toMatchObject({ code: 'invalid_response' })
    fetcher.mockImplementationOnce(async () => response({ ...catalog, fallback: { token: 'x' } }))
    await expect(transport.invoke('models.catalog', {})).rejects.toMatchObject({ code: 'invalid_response' })
  })
})
