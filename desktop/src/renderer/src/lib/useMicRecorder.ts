import { useEffect, useRef, useState } from 'react'

function microphoneError(reason: unknown) {
  const name = reason instanceof DOMException ? reason.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return new Error('Microphone permission was denied')
  if (name === 'NotFoundError') return new Error('No microphone was found')
  if (name === 'NotReadableError') return new Error('The microphone is already in use')
  return reason instanceof Error ? reason : new Error('Could not start the microphone')
}

export function useMicRecorder(onAudio: (audio: Blob) => Promise<void>, onError: (message: string) => void) {
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const context = useRef<AudioContext | null>(null)
  const animation = useRef<number | null>(null)

  const cleanup = () => {
    if (animation.current !== null) cancelAnimationFrame(animation.current)
    animation.current = null
    void context.current?.close()
    context.current = null
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    recorder.current = null
    setRecording(false)
    setLevel(0)
  }

  useEffect(() => cleanup, [])

  const start = async () => {
    if (recorder.current) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      onError('Microphone recording is not supported on this device')
      return
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'].find((type) => MediaRecorder.isTypeSupported(type)) || ''
      const instance = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      stream.current = media
      recorder.current = instance
      chunks.current = []
      instance.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data) }
      instance.onerror = (event) => { onError(microphoneError((event as Event & { error?: unknown }).error).message); cleanup() }
      instance.onstop = () => {
        const audio = new Blob(chunks.current, { type: instance.mimeType || mimeType || 'audio/webm' })
        chunks.current = []
        cleanup()
        if (audio.size) void onAudio(audio).catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)))
      }
      instance.start()
      setRecording(true)

      try {
        const audioContext = new AudioContext()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        audioContext.createMediaStreamSource(media).connect(analyser)
        context.current = audioContext
        const data = new Uint8Array(analyser.fftSize)
        const tick = () => {
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (const value of data) { const centered = value - 128; sum += centered * centered }
          setLevel(Math.min(1, Math.sqrt(sum / data.length) / 42))
          animation.current = requestAnimationFrame(tick)
        }
        tick()
      } catch { setLevel(0) }
    } catch (reason) { onError(microphoneError(reason).message); cleanup() }
  }

  const stop = () => {
    if (recorder.current?.state !== 'inactive') recorder.current?.stop()
  }

  return { level, recording, start, stop }
}
