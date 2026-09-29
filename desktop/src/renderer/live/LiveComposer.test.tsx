import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, JsonRecord } from '../../shared/bridge/types'
import { LiveChatView } from './LiveChat'
import { liveProjects, liveSessions } from './liveModels'
import { readLastModel, saveLastModel } from './composerPreferences'
import { MAX_RECORDING_MS } from './useMicRecorder'
import type { LiveServer } from './useLiveServer'

const SESSION_ID = 'prime-session-1'
const project: JsonRecord = { id: 'project-1', name: 'Archon backend', primary_path: '/srv/work/archon', folders: [] }
const primeSession: JsonRecord = {
  id: SESSION_ID, source: 'prime', title: 'Refactor', model: 'prime-agent', cwd: '/srv/work/archon',
  project_id: 'project-1', started_at: 1, last_active: 2, message_count: 0, active: false,
  preview: '', ownership_state: 'verified', ownership_reason: null, runtime: 'prime', read_only: false, can_delete: true,
}
const piSession: JsonRecord = { ...primeSession, id: 'pi-session-1', runtime: 'pi' }
const catalog = {
  current: { provider: 'openai-codex', model: 'gpt-5.6-terra', base_url_configured: true },
  fallback: null,
  providers: [{ id: 'openai-codex', models: ['gpt-5.6-terra', 'gpt-5.5'] }],
  choices: [{ provider: 'openai-codex', model: 'gpt-5.6-terra' }, { provider: 'openai-codex', model: 'gpt-5.5' }],
}
function runtimeRow(id: 'prime' | 'pi') {
  return { id, aliases: [id], available: true, availability_check: 'executable_file', version: null, version_verified: false,
    availability_note: '', modes: [{ id: 'auto', label: 'Trusted execution', restricted: false }], chat_only: false, sandboxed: false }
}
const workspaceRow = {
  workspace_id: `workspace-${'a'.repeat(32)}`, root: '/srv/data/workspaces/a', project_id: 'project-1',
  base_revision: 'a'.repeat(40), head_revision: 'a'.repeat(40), generation: 2,
}
const voiceOn = { available: true, stt: { available: true, provider: 'stt' }, tts: { available: true, provider: 'tts' } }
const voiceOff = { available: false, stt: { available: false, provider: 'stt' }, tts: { available: false, provider: 'tts' } }

type Handler = (operation: string, payload: Record<string, unknown>) => unknown

function makeBridge(overrides: Record<string, unknown> = {}, handler?: Handler) {
  const invoke = vi.fn((operation: string, payload: Record<string, unknown>) => Promise.resolve().then(() => {
    const custom = handler?.(operation, payload)
    if (custom !== undefined) return custom
    if (operation in overrides) return overrides[operation]
    switch (operation) {
      case 'runtimes.list': return { runtimes: [runtimeRow('prime'), runtimeRow('pi')] }
      case 'workspaces.list': return { workspaces: [] }
      case 'models.catalog': return catalog
      case 'audio.status': return voiceOn
      case 'sessions.messages': return { messages: [] }
      case 'tasks.list': return { tasks: [] }
      case 'tasks.submit': return { task: { id: 'task-1', status: 'queued', session_id: SESSION_ID } }
      case 'tasks.get': return { task: { id: 'task-1', status: 'running', session_id: SESSION_ID } }
      case 'tasks.events': return { events: [] }
      default: throw new Error(`Unexpected operation: ${operation}`)
    }
  }))
  const bridge = { api: { invoke } } as unknown as DesktopBridge
  return { bridge, invoke }
}

function serverFor(bridge: DesktopBridge): LiveServer {
  return {
    status: 'ready',
    scope: { bridge, generation: 4, serverUrl: 'https://archon.example', localPairingAvailable: false },
    projects: liveProjects([project]),
    sessions: liveSessions([primeSession, piSession]),
    refreshing: false,
    refresh: vi.fn(),
  }
}

function renderChat(bridge: DesktopBridge, sessionId: string | null = null) {
  return render(<LiveChatView server={serverFor(bridge)} sessionId={sessionId} preferredProjectId="project-1" pollDelayMs={60_000}
    onOpenSession={vi.fn()} onNewConversation={vi.fn()} onOpenConnection={vi.fn()} onOpenTasks={vi.fn()} />)
}

function submits(invoke: ReturnType<typeof makeBridge>['invoke']) {
  return invoke.mock.calls.filter(([name]) => name === 'tasks.submit')
}

/** Fake MediaRecorder: records `start`/`stop` and emits one chunk on stop. */
class FakeRecorder {
  static instances: FakeRecorder[] = []
  static isTypeSupported = (type: string) => type === 'audio/webm'
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly stream: unknown) { FakeRecorder.instances.push(this) }
  start() { this.state = 'recording' }
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

const track = { stop: vi.fn() }
const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }))

beforeEach(() => {
  FakeRecorder.instances = []
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

describe('composer model picker', () => {
  it('offers only the Prime catalog models, sends the choice and remembers it for Prime', async () => {
    const { bridge, invoke } = makeBridge()
    renderChat(bridge)
    const picker = await screen.findByLabelText('Model')
    await waitFor(() => expect(within(picker).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Server default · gpt-5.6-terra', 'gpt-5.6-terra', 'gpt-5.5']))
    fireEvent.change(picker, { target: { value: 'openai-codex\u0000gpt-5.5' } })
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))

    await waitFor(() => expect(submits(invoke)).toEqual([
      ['tasks.submit', { projectId: 'project-1', prompt: 'Hi', runtime: 'prime', model: 'gpt-5.5', provider: 'openai-codex' }],
    ]))
    expect(readLastModel('prime')).toEqual({ provider: 'openai-codex', model: 'gpt-5.5' })
    expect(readLastModel('pi')).toBeNull()
  })

  it('offers no model for Pi, says why, and never sends one', async () => {
    saveLastModel('prime', { provider: 'openai-codex', model: 'gpt-5.5' })
    const { bridge, invoke } = makeBridge()
    renderChat(bridge)
    const runtime = await screen.findByLabelText('Runtime')
    await waitFor(() => expect(within(runtime).getAllByRole('option')).toHaveLength(2))
    fireEvent.change(runtime, { target: { value: 'pi' } })
    const picker = screen.getByLabelText('Model')
    expect(picker).toBeDisabled()
    expect(within(picker).getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText(/Pi uses its own configured model/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(submits(invoke)).toEqual([
      ['tasks.submit', { projectId: 'project-1', prompt: 'Hi', runtime: 'pi' }],
    ]))
  })

  it('never sends a model on the checkout route, even with a remembered choice', async () => {
    saveLastModel('prime', { provider: 'openai-codex', model: 'gpt-5.5' })
    const { bridge, invoke } = makeBridge({ 'workspaces.list': { workspaces: [workspaceRow] } })
    renderChat(bridge)
    const runIn = await screen.findByLabelText('Run in')
    await waitFor(() => expect(within(runIn).getAllByRole('option')).toHaveLength(2))
    fireEvent.change(runIn, { target: { value: workspaceRow.workspace_id } })
    expect(screen.getByLabelText('Model')).toBeDisabled()
    expect(screen.getByText(/Checkout conversations run with Prime’s server default model/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(submits(invoke)).toEqual([
      ['tasks.submit', { projectId: 'project-1', prompt: 'Hi', workspaceId: workspaceRow.workspace_id, workspaceGeneration: 2 }],
    ]))
  })

  it('ignores a remembered model the catalog no longer offers', async () => {
    saveLastModel('prime', { provider: 'openai-codex', model: 'retired-model' })
    const { bridge, invoke } = makeBridge()
    renderChat(bridge)
    const picker = await screen.findByLabelText('Model')
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3))
    expect(picker).toHaveValue('')
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
    await waitFor(() => expect(submits(invoke)).toEqual([
      ['tasks.submit', { projectId: 'project-1', prompt: 'Hi', runtime: 'prime' }],
    ]))
  })

  it('sends the remembered Prime model with a Prime follow-up, and none for Pi', async () => {
    saveLastModel('prime', { provider: 'openai-codex', model: 'gpt-5.5' })
    const { bridge, invoke } = makeBridge()
    const view = renderChat(bridge, SESSION_ID)
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('openai-codex\u0000gpt-5.5'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Next' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(submits(invoke)).toEqual([
      ['tasks.submit', { sessionId: SESSION_ID, prompt: 'Next', projectId: 'project-1', model: 'gpt-5.5', provider: 'openai-codex' }],
    ]))
    view.unmount()

    const pi = makeBridge()
    renderChat(pi.bridge, 'pi-session-1')
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), { target: { value: 'Next' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled())
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(submits(pi.invoke)).toEqual([
      ['tasks.submit', { sessionId: 'pi-session-1', prompt: 'Next', projectId: 'project-1' }],
    ]))
    expect(pi.invoke.mock.calls.some(([name]) => name === 'models.catalog')).toBe(false)
  })
})

describe('composer voice input', () => {
  it('disables the microphone when the server has no speech-to-text', async () => {
    const { bridge } = makeBridge({ 'audio.status': voiceOff })
    renderChat(bridge)
    const mic = await screen.findByRole('button', { name: 'Record voice message' })
    await waitFor(() => expect(mic).toBeDisabled())
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('disables the microphone when the status cannot be read', async () => {
    const { bridge } = makeBridge({}, (operation) => operation === 'audio.status' ? Promise.reject(new Error('down')) : undefined)
    renderChat(bridge, SESSION_ID)
    const mic = await screen.findByRole('button', { name: 'Record voice message' })
    await waitFor(() => expect(mic).toBeDisabled())
  })

  it('inserts the transcript into the draft for review and never sends it', async () => {
    const { bridge, invoke } = makeBridge({ 'audio.transcribe': { success: true, transcript: ' مرحبا ', provider: 'stt' } })
    renderChat(bridge, SESSION_ID)
    const textbox = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.change(textbox, { target: { value: 'Draft:' } })
    const mic = screen.getByRole('button', { name: 'Record voice message' })
    await waitFor(() => expect(mic).toBeEnabled())
    fireEvent.click(mic)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument())
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))

    await waitFor(() => expect(textbox).toHaveValue('Draft: مرحبا'))
    const uploads = invoke.mock.calls.filter(([name]) => name === 'audio.transcribe')
    expect(uploads).toEqual([['audio.transcribe', { dataUrl: 'data:audio/webm;base64,AQID', mimeType: 'audio/webm' }]])
    expect(submits(invoke)).toHaveLength(0)
    expect(track.stop).toHaveBeenCalled()
  })

  it('stops recording by itself at the time bound', async () => {
    const { bridge, invoke } = makeBridge({ 'audio.transcribe': { success: true, transcript: 'hello', provider: 'stt' } })
    renderChat(bridge)
    const mic = await screen.findByRole('button', { name: 'Record voice message' })
    await waitFor(() => expect(mic).toBeEnabled())
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fireEvent.click(mic)
    await waitFor(() => expect(FakeRecorder.instances[0]?.state).toBe('recording'))
    await act(async () => { vi.advanceTimersByTime(MAX_RECORDING_MS - 1_000) })
    expect(FakeRecorder.instances[0].state).toBe('recording')
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(FakeRecorder.instances[0].state).toBe('inactive')
    vi.useRealTimers()
    await waitFor(() => expect(screen.getByLabelText('First message')).toHaveValue('hello'))
    expect(invoke.mock.calls.filter(([name]) => name === 'audio.transcribe')).toHaveLength(1)
    expect(submits(invoke)).toHaveLength(0)
  })
})
