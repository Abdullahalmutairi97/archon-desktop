import { ChatCircleDots, CircleNotch, Microphone, Plus, Stop, Warning, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ArchonApi } from '../lib/api'
import type { HermesSession, ModelCatalog, Task } from '../lib/types'
import { ErrorNotice } from '../components'
import { QuillGlyph, WaveGlyph } from '../components/ComposerGlyphs'
import { ModelPicker } from '../components/ModelPicker'
import { readComposerVisibility } from '../lib/composerPreferences'
import { useMicRecorder } from '../lib/useMicRecorder'

const day = (value: string | number) => {
  const date = new Date(value)
  const now = new Date()
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === now.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const clock = (value: string | number) => new Date(value).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })

export function ChatsPage({ api, sessions, tasks, catalog, onOpen, onCreated }: {
  api: ArchonApi
  sessions: HermesSession[]
  tasks: Task[]
  catalog?: ModelCatalog
  onOpen(sessionId: string): void
  onCreated(): Promise<void>
}) {
  const chats = useMemo(() => sessions.filter((session) => !session.project_id), [sessions])
  const groups = useMemo(() => {
    const value = new Map<string,HermesSession[]>()
    chats.forEach((chat) => { const key = day(chat.last_active); value.set(key,[...(value.get(key)||[]),chat]) })
    return [...value.entries()]
  }, [chats])
  const [prompt,setPrompt] = useState('')
  const [modelChoice,setModelChoice] = useState('')
  const [sending,setSending] = useState(false)
  const [error,setError] = useState('')
  const [voiceError,setVoiceError] = useState('')
  const [transcribing,setTranscribing] = useState(false)
  const [voiceMode,setVoiceMode] = useState(false)
  const [voiceAvailable,setVoiceAvailable] = useState<boolean>()
  const [pendingTaskId,setPendingTaskId] = useState('')
  const [creating,setCreating] = useState(false)
  const [composerVisibility,setComposerVisibility] = useState(readComposerVisibility)
  const voiceModeRef = useRef(false)
  const spokenReply = useRef('')
  const startListeningRef = useRef<() => Promise<void>>(async () => {})
  const pendingTask = tasks.find((task) => task.id === pendingTaskId)

  useEffect(() => {
    if (catalog?.current.provider && catalog.current.model) setModelChoice(`${catalog.current.provider}\u0000${catalog.current.model}`)
  }, [catalog?.current.model, catalog?.current.provider])
  useEffect(() => { void api.audioStatus().then((status) => setVoiceAvailable(status.available)).catch(() => setVoiceAvailable(false)) }, [api])
  useEffect(() => {
    const sync = () => setComposerVisibility(readComposerVisibility())
    window.addEventListener('archon:composer-visibility', sync)
    return () => window.removeEventListener('archon:composer-visibility', sync)
  }, [])

  const submit = async (override?: string) => {
    const text = (override ?? prompt).trim()
    if (!text || sending || !modelChoice) return
    setSending(true); setError('')
    try {
      const split = modelChoice.indexOf('\u0000')
      const provider = split >= 0 ? modelChoice.slice(0,split) : catalog?.current.provider
      const model = split >= 0 ? modelChoice.slice(split + 1) : catalog?.current.model
      const task = await api.createTask({ prompt:text, provider, model, chat_only:true, approval_mode:'auto', skills:[] })
      setPendingTaskId(task.id); setPrompt('')
      await onCreated()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSending(false) }
  }

  const mic = useMicRecorder(async (audio) => {
    setTranscribing(true); setVoiceError('')
    try {
      const result = await api.transcribeAudio(audio)
      setPrompt(result.transcript)
      if (voiceModeRef.current && result.transcript.trim()) await submit(result.transcript)
    } finally { setTranscribing(false) }
  }, setVoiceError)
  startListeningRef.current = mic.start

  useEffect(() => {
    if (!voiceMode || !pendingTask?.result?.text || spokenReply.current === pendingTask.id) return
    spokenReply.current = pendingTask.id
    void api.speakText(pendingTask.result.text).then((result) => {
      const audio = new Audio(result.data_url)
      audio.addEventListener('ended', () => { if (voiceModeRef.current) void startListeningRef.current() }, { once:true })
      return audio.play()
    }).catch((reason) => setVoiceError(reason instanceof Error ? reason.message : String(reason)))
  }, [api, pendingTask, voiceMode])

  const toggleVoice = () => {
    const next = !voiceModeRef.current
    voiceModeRef.current = next; setVoiceMode(next)
    if (next) void mic.start(); else if (mic.recording) mic.stop()
  }

  return <section className="reference-page chats-page">
    <header className="reference-page-header"><div><h1>Chat</h1><p>Conversation only · same model · zero tools · no filesystem or shell access</p></div><button className="chat-new-action" onClick={() => setCreating(true)}><Plus/>New chat</button><span>{chats.length}</span></header>
    <ErrorNotice error={error || voiceError}/>
    {!creating && <div className="chat-list">
      {groups.map(([label,items]) => <section key={label}><h2>{label}</h2>{items.map((chat) => <button key={chat.id} onClick={() => onOpen(chat.id)}><ChatCircleDots/><span><b>{chat.title || 'Untitled chat'}</b><small>{chat.preview || 'No preview'}</small></span><time>{clock(chat.last_active)}</time></button>)}</section>)}
      {!groups.length && <div className="chat-list-empty"><ChatCircleDots/><b>No chat conversations yet</b><span>Choose New chat. This path deliberately binds no agent tools.</span></div>}
      {pendingTask && <article className={`chat-only-status ${pendingTask.status}`}>
        {['queued','running'].includes(pendingTask.status) ? <CircleNotch className="spin"/> : pendingTask.status === 'failed' ? <Warning/> : <ChatCircleDots/>}
        <div><b>{pendingTask.status === 'running' ? 'Archon is replying' : pendingTask.status}</b>{pendingTask.result?.text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{pendingTask.result.text}</ReactMarkdown>}{pendingTask.error && <small>{pendingTask.error}</small>}</div>
        {pendingTask.session_id && <button onClick={() => onOpen(pendingTask.session_id!)}>Open conversation</button>}
      </article>}
    </div>}
    {creating && <div className="chat-new-surface"><div className="chat-new-heading"><div><ChatCircleDots/><span><b>New chat</b><small>Isolated conversation · zero tools</small></span></div><button aria-label="Close new chat" onClick={() => setCreating(false)}><X/></button></div><div className="chat-bottom-composer">
      <textarea aria-label="Chat with Archon" rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} placeholder="Message Archon without tools…"/>
      <div><ModelPicker catalog={catalog} value={modelChoice} onChange={setModelChoice} globalShortcut/>{composerVisibility.voice && <><button className={voiceMode ? 'active' : ''} role="switch" aria-checked={voiceMode} aria-label="Voice conversation" disabled={voiceAvailable === false} onClick={toggleVoice}><WaveGlyph live={voiceMode}/>{voiceMode && <small>Live</small>}</button><button className={mic.recording ? 'active' : ''} aria-label={mic.recording ? 'Stop microphone recording' : 'Start microphone recording'} disabled={voiceAvailable === false || transcribing} onClick={() => mic.recording ? mic.stop() : void mic.start()}>{transcribing ? <CircleNotch className="spin"/> : mic.recording ? <Stop/> : <Microphone/>}</button></>}<button className="round-send" aria-label="Send chat message" disabled={!prompt.trim() || sending || !modelChoice} onClick={() => void submit()}>{sending ? <CircleNotch className="spin"/> : <QuillGlyph/>}</button></div>
      <small>Enter to send · Shift Enter newline · conversation-only session persists on the server</small>
    </div></div>}
  </section>
}
