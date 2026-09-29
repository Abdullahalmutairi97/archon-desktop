import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_AUDIO_BYTES } from '../../shared/bridge/validation'

/**
 * Microphone capture for the composer, ported from the v0.3.0 client
 * (`lib/useMicRecorder.ts`, commit 69bcf1e) with hard bounds added: a
 * recording stops by itself after MAX_RECORDING_MS, and audio larger than the
 * server's ceiling is discarded rather than uploaded.
 */
export const MAX_RECORDING_MS = 2 * 60 * 1000
const CHUNK_MS = 1_000

function microphoneError(reason: unknown): string {
  const name = typeof reason === 'object' && reason !== null && 'name' in reason ? String((reason as { name: unknown }).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission was denied.'
  if (name === 'NotFoundError') return 'No microphone was found.'
  if (name === 'NotReadableError') return 'The microphone is already in use.'
  return 'Could not start the microphone.'
}

export function useMicRecorder(onAudio: (audio: Blob) => void, onError: (message: string) => void) {
  const [recording, setRecording] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const bytes = useRef(0)
  const oversized = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const starting = useRef(false)
  const alive = useRef(true)
  const callbacks = useRef({ onAudio, onError })
  callbacks.current = { onAudio, onError }

  const release = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    recorder.current = null
    if (alive.current) setRecording(false)
  }, [])

  const stop = useCallback(() => {
    const instance = recorder.current
    if (instance && instance.state !== 'inactive') instance.stop()
    else release()
  }, [release])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // Unmounting discards any recording; nothing is uploaded.
      const instance = recorder.current
      if (instance) instance.onstop = null
      if (instance && instance.state !== 'inactive') instance.stop()
      release()
    }
  }, [release])

  const start = useCallback(async () => {
    if (recorder.current || starting.current) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      callbacks.current.onError('Microphone recording is not supported here.')
      return
    }
    starting.current = true
    try {
      // Audio only: the main process refuses any request that includes video.
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      if (!alive.current) {
        media.getTracks().forEach((track) => track.stop())
        return
      }
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
        .find((type) => MediaRecorder.isTypeSupported?.(type)) ?? ''
      const instance = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      stream.current = media
      recorder.current = instance
      chunks.current = []
      bytes.current = 0
      oversized.current = false
      instance.ondataavailable = (event: BlobEvent) => {
        if (!event.data.size || oversized.current) return
        bytes.current += event.data.size
        if (bytes.current > MAX_AUDIO_BYTES) {
          oversized.current = true
          chunks.current = []
          if (instance.state !== 'inactive') instance.stop()
          return
        }
        chunks.current.push(event.data)
      }
      instance.onerror = () => {
        callbacks.current.onError('The microphone recording failed.')
        instance.onstop = null
        if (instance.state !== 'inactive') instance.stop()
        release()
      }
      instance.onstop = () => {
        const type = (instance.mimeType || mimeType || 'audio/webm')
        const audio = new Blob(chunks.current, { type })
        chunks.current = []
        release()
        if (oversized.current) {
          callbacks.current.onError('The recording is larger than the server accepts, so it was discarded.')
          return
        }
        if (audio.size > 0 && audio.size <= MAX_AUDIO_BYTES) callbacks.current.onAudio(audio)
      }
      instance.start(CHUNK_MS)
      timer.current = setTimeout(() => {
        if (instance.state !== 'inactive') instance.stop()
      }, MAX_RECORDING_MS)
      setRecording(true)
    } catch (reason) {
      callbacks.current.onError(microphoneError(reason))
      release()
    } finally {
      starting.current = false
    }
  }, [release])

  return { recording, start, stop }
}

/** Build the exact `data:<type>;base64,…` body the transcription route expects. */
export async function audioDataUrl(audio: Blob): Promise<{ dataUrl: string; mimeType: string }> {
  const mimeType = (audio.type.split(';', 1)[0] ?? '').trim().toLowerCase() || 'audio/webm'
  const view = new Uint8Array(await audio.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000))
  }
  return { dataUrl: `data:${mimeType};base64,${btoa(binary)}`, mimeType }
}
