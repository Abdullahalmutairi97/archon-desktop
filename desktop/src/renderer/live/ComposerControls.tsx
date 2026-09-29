import { useCallback, useEffect, useState } from 'react'
import type { DesktopBridge, ModelCatalogResult } from '../../shared/bridge/types'
import { Icon } from '../shell/Icon'
import type { LiveRuntime } from './liveModels'
import type { ModelChoice } from './composerPreferences'
import { audioDataUrl, MAX_RECORDING_MS, useMicRecorder } from './useMicRecorder'

export type CatalogState =
  | { state: 'loading' }
  | { state: 'ready'; catalog: ModelCatalogResult }
  | { state: 'error' }

/** Read Prime's model catalog once per bridge. */
export function useModelCatalog(bridge: DesktopBridge, enabled = true): CatalogState {
  const [catalog, setCatalog] = useState<CatalogState>({ state: 'loading' })
  useEffect(() => {
    if (!enabled) return
    let current = true
    void Promise.resolve().then(() => bridge.api.invoke('models.catalog', {})).then((result) => {
      if (current) setCatalog({ state: 'ready', catalog: result })
    }).catch(() => {
      if (current) setCatalog({ state: 'error' })
    })
    return () => { current = false }
  }, [bridge, enabled])
  return catalog
}

const SEPARATOR = '\u0000'

/**
 * Model select for a composer. It lists only models the chosen runtime will
 * really run, and says plainly when the runtime ignores a model choice.
 */
export function ModelPicker({
  id,
  runtime,
  checkout,
  catalog,
  choices,
  value,
  disabled,
  onChange,
}: {
  id: string
  runtime: LiveRuntime | null
  checkout: boolean
  catalog: CatalogState
  choices: readonly ModelChoice[]
  value: ModelChoice | null
  disabled: boolean
  onChange(value: ModelChoice | null): void
}) {
  const current = catalog.state === 'ready' ? catalog.catalog.current : null
  const defaultLabel = current?.provider === 'openai-codex' && current.model
    ? `Server default · ${current.model}`
    : 'Server default'
  let note: string | null = null
  if (checkout) note = 'Checkout conversations run with Prime’s server default model; a model cannot be chosen here.'
  else if (runtime === 'pi') note = 'Pi uses its own configured model. The server’s model list covers Prime’s signed-in providers only, so no choice is offered.'
  else if (runtime === 'prime' && catalog.state === 'error') note = 'The model list could not be read from the server; the server default is used.'
  else if (runtime === 'prime' && catalog.state === 'ready' && !choices.length) note = 'The server reports no signed-in Prime provider, so the server default is used.'
  const selectable = !checkout && runtime === 'prime' && choices.length > 0
  return <>
    <label htmlFor={id}>Model</label>
    <select
      id={id}
      value={selectable && value ? `${value.provider}${SEPARATOR}${value.model}` : ''}
      disabled={disabled || !selectable}
      onChange={(event) => {
        const raw = event.currentTarget.value
        onChange(choices.find((choice) => `${choice.provider}${SEPARATOR}${choice.model}` === raw) ?? null)
      }}
    >
      <option value="">{runtime === 'prime' && catalog.state === 'loading' && !checkout ? 'Checking models…' : defaultLabel}</option>
      {selectable && choices.map((choice) => <option key={choice.model} value={`${choice.provider}${SEPARATOR}${choice.model}`}>{choice.model}</option>)}
    </select>
    {note && <p className="live-task-note">{note}</p>}
  </>
}

type VoiceState = 'unknown' | 'available' | 'unavailable'

/**
 * Microphone button. Speech goes to the server's transcription route and the
 * transcript is handed back for the user to review; it is never sent.
 */
export function MicButton({
  bridge,
  disabled,
  onTranscript,
}: {
  bridge: DesktopBridge
  disabled: boolean
  onTranscript(text: string): void
}) {
  const [voice, setVoice] = useState<VoiceState>('unknown')
  const [transcribing, setTranscribing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => bridge.api.invoke('audio.status', {})).then((status) => {
      if (current) setVoice(status.available && status.stt.available ? 'available' : 'unavailable')
    }).catch(() => {
      if (current) setVoice('unavailable')
    })
    return () => { current = false }
  }, [bridge])

  const transcribe = useCallback((audio: Blob) => {
    setTranscribing(true)
    setMessage(null)
    void audioDataUrl(audio)
      .then((payload) => bridge.api.invoke('audio.transcribe', payload))
      .then((result) => {
        const text = result.transcript.trim()
        if (text) onTranscript(text)
        else setMessage('No speech was recognised.')
      })
      .catch(() => setMessage('The recording could not be transcribed.'))
      .finally(() => setTranscribing(false))
  }, [bridge, onTranscript])

  const mic = useMicRecorder(transcribe, setMessage)
  const unavailable = voice !== 'available'
  const label = mic.recording ? 'Stop recording' : 'Record voice message'
  return <>
    <button
      type="button"
      className={`live-mic-button${mic.recording ? ' recording' : ''}`}
      aria-label={label}
      aria-pressed={mic.recording}
      title={unavailable ? 'Speech-to-text is not available on the server' : `${label} (up to ${MAX_RECORDING_MS / 60_000} minutes)`}
      disabled={unavailable || transcribing || (disabled && !mic.recording)}
      onClick={() => { if (mic.recording) mic.stop(); else { setMessage(null); void mic.start() } }}
    >{transcribing ? '…' : <Icon name={mic.recording ? 'stop' : 'mic'} />}</button>
    {(message || transcribing) && <span className="live-mic-status" role="status">{transcribing ? 'Transcribing…' : message}</span>}
  </>
}

/** Insert a transcript into a draft for review, within the composer's length limit. */
export function appendTranscript(draft: string, transcript: string, maxLength: number): string {
  const joined = draft.trim() ? `${draft.replace(/\s+$/u, '')} ${transcript}` : transcript
  return joined.slice(0, maxLength)
}
