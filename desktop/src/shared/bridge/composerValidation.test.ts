import { describe, expect, it } from 'vitest'
import {
  BRIDGE_CHANNELS,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DATA_URL_LENGTH,
  parseBridgeResponse,
  parseOperationRequest,
} from './validation'

const sessionId = 'prime-0f3c2d1e-aaaa-4bbb-8ccc-123456789abc'
const workspace = { workspaceId: `workspace-${'a'.repeat(32)}`, workspaceGeneration: 1 }

const catalog = {
  current: { provider: 'openai-codex', model: 'gpt-5.6-terra', base_url_configured: true },
  fallback: null,
  providers: [{ id: 'openai-codex', models: ['gpt-5.6-terra', 'gpt-5.5'] }],
  choices: [{ provider: 'openai-codex', model: 'gpt-5.6-terra' }, { provider: 'openai-codex', model: 'gpt-5.5' }],
}

function dataUrl(bytes: number, mime = 'audio/webm'): string {
  return `data:${mime};base64,${Buffer.alloc(bytes, 7).toString('base64')}`
}

describe('composer operations', () => {
  it('accepts a Prime model choice on a new or continued conversation only with the forwarded provider', () => {
    const model = { model: 'gpt-5.6-terra', provider: 'openai-codex' }
    expect(parseOperationRequest('tasks.submit', { projectId: 'project-1', prompt: 'Start', ...model })[1])
      .toEqual({ projectId: 'project-1', prompt: 'Start', ...model })
    expect(parseOperationRequest('tasks.submit', { projectId: 'project-1', prompt: 'Start', runtime: 'prime', ...model })[1])
      .toEqual({ projectId: 'project-1', prompt: 'Start', runtime: 'prime', ...model })
    expect(parseOperationRequest('tasks.submit', { sessionId, prompt: 'Next', ...model })[1])
      .toEqual({ sessionId, prompt: 'Next', ...model })

    for (const payload of [
      { projectId: 'project-1', prompt: 'x', model: 'gpt-5.5' },
      { projectId: 'project-1', prompt: 'x', provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: 'gpt-5.5', provider: 'anthropic' },
      { projectId: 'project-1', prompt: 'x', model: 'gpt-5.5', provider: 'OPENAI-CODEX' },
      { projectId: 'project-1', prompt: 'x', model: 'gpt-5.5', provider: undefined },
      { projectId: 'project-1', prompt: 'x', model: '', provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: 'm'.repeat(101), provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: '--exec=rm', provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: 'gpt 5', provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: 'gpt\n5', provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: 42, provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', model: ['gpt-5.5'], provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', runtime: 'pi', model: 'gpt-5.5', provider: 'openai-codex' },
      { projectId: 'project-1', prompt: 'x', ...workspace, model: 'gpt-5.5', provider: 'openai-codex' },
      { sessionId, prompt: 'x', model: 'gpt-5.5' },
      { sessionId, prompt: 'x', model: 'gpt-5.5', provider: 'other' },
    ]) {
      expect(() => parseOperationRequest('tasks.submit', payload)).toThrow(TypeError)
    }
  })

  it('accepts empty catalog and audio status requests only', () => {
    expect(parseOperationRequest('models.catalog', {})).toEqual(['models.catalog', {}])
    expect(parseOperationRequest('audio.status', {})).toEqual(['audio.status', {}])
    expect(() => parseOperationRequest('models.catalog', { provider: 'x' })).toThrow(TypeError)
    expect(() => parseOperationRequest('audio.status', { url: 'https://evil.test' })).toThrow(TypeError)
  })

  it('bounds an audio upload to a well-formed base64 audio data URL within the server ceiling', () => {
    const small = { dataUrl: dataUrl(3), mimeType: 'audio/webm' }
    expect(parseOperationRequest('audio.transcribe', small)).toEqual(['audio.transcribe', small])
    const full = { dataUrl: dataUrl(MAX_AUDIO_BYTES, 'audio/ogg'), mimeType: 'audio/ogg' }
    expect(full.dataUrl.length).toBeLessThanOrEqual(MAX_AUDIO_DATA_URL_LENGTH)
    expect(parseOperationRequest('audio.transcribe', full)[1]).toEqual(full)

    let invoked = false
    const hostile = Object.defineProperty({ mimeType: 'audio/webm' }, 'dataUrl', {
      enumerable: true,
      get() { invoked = true; return dataUrl(3) },
    })
    for (const payload of [
      hostile,
      {},
      { dataUrl: dataUrl(3) },
      { dataUrl: dataUrl(MAX_AUDIO_BYTES + 1), mimeType: 'audio/webm' },
      { dataUrl: 'data:audio/webm;base64,', mimeType: 'audio/webm' },
      { dataUrl: dataUrl(3, 'video/webm'), mimeType: 'video/webm' },
      { dataUrl: dataUrl(3, 'text/html'), mimeType: 'text/html' },
      { dataUrl: dataUrl(3, 'audio/ogg'), mimeType: 'audio/webm' },
      { dataUrl: 'data:audio/webm,AAAA', mimeType: 'audio/webm' },
      { dataUrl: 'data:audio/webm;base64,AAA', mimeType: 'audio/webm' },
      { dataUrl: 'data:audio/webm;base64,AA AA', mimeType: 'audio/webm' },
      { dataUrl: 'data:audio/webm;base64,A===', mimeType: 'audio/webm' },
      { dataUrl: 'https://evil.test/a.webm', mimeType: 'audio/webm' },
      { dataUrl: dataUrl(3, `audio/${'x'.repeat(100)}`), mimeType: `audio/${'x'.repeat(100)}` },
      { dataUrl: dataUrl(3), mimeType: 'audio/webm', url: 'https://evil.test' },
      { dataUrl: new String(dataUrl(3)), mimeType: 'audio/webm' },
    ]) {
      expect(() => parseOperationRequest('audio.transcribe', payload)).toThrow(TypeError)
    }
    expect(invoked).toBe(false)
  })

  it('validates the Prime model catalog and refuses choices the providers do not offer', () => {
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, catalog, 'models.catalog')).toEqual(catalog)
    const empty = { current: { provider: null, model: null, base_url_configured: false }, fallback: null, providers: [], choices: [] }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, empty, 'models.catalog')).toEqual(empty)
    for (const value of [
      { ...catalog, choices: [{ provider: 'openai-codex', model: 'not-offered' }] },
      { ...catalog, providers: [{ id: 'openai-codex', models: ['gpt 5'] }], choices: [] },
      { ...catalog, providers: [{ id: 'openai-codex', models: ['a', 'a'] }], choices: [] },
      { ...catalog, providers: [{ id: 'x', models: [] }, { id: 'x', models: [] }], choices: [] },
      { ...catalog, providers: [{ id: 'openai-codex', models: Array.from({ length: 201 }, (_, i) => `m${i}`) }], choices: [] },
      { ...catalog, current: { provider: 'openai-codex', model: 'm', base_url_configured: true, api_key: 'x' } },
      { ...catalog, fallback: { api_key: 'secret' } },
      { ...catalog, extra: true },
      { providers: [], choices: [] },
    ]) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, value, 'models.catalog')).toThrow(TypeError)
    }
  })

  it('validates audio status and transcription results', () => {
    const status = { available: true, stt: { available: true, provider: 'Hermes configured STT' }, tts: { available: false, provider: 'Hermes configured TTS' } }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, status, 'audio.status')).toEqual(status)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { ...status, available: 'yes' }, 'audio.status')).toThrow(TypeError)
    expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { ...status, stt: { available: true } }, 'audio.status')).toThrow(TypeError)

    const result = { success: true, transcript: 'مرحبا hello', provider: 'local' }
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, result, 'audio.transcribe')).toEqual(result)
    expect(parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, { ...result, transcript: '' }, 'audio.transcribe')).toEqual({ ...result, transcript: '' })
    for (const value of [
      { ...result, success: false },
      { ...result, transcript: 'x'.repeat(100_001) },
      { ...result, provider: '' },
      { ...result, data_url: 'data:' },
    ]) {
      expect(() => parseBridgeResponse(BRIDGE_CHANNELS.apiInvoke, value, 'audio.transcribe')).toThrow(TypeError)
    }
  })
})
