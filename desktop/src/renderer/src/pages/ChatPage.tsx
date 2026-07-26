import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CaretDown, CircleNotch, Folder, Lightning, ListChecks, Microphone, Pulse, SealCheck, Stop, X } from '@phosphor-icons/react'
import { Button, ErrorNotice, formatDate } from '../components'
import { BrandGlyph } from '../components/BrandGlyph'
import { ModelPicker } from '../components/ModelPicker'
import type { ArchonApi } from '../lib/api'
import type { ChatMessage, HermesSession, ModelCatalog, Project, Task } from '../lib/types'
import { useMicRecorder } from '../lib/useMicRecorder'
import { QuillGlyph, RoseGlyph, WaveGlyph } from '../components/ComposerGlyphs'
import { cycleApprovalMode, readApprovalMode, readComposerVisibility, writeApprovalMode, type ApprovalMode } from '../lib/composerPreferences'

type ChatIntent = { projectId?: string; sessionId?: string }

type ChatPageProps = {
  api: ArchonApi
  intent?: ChatIntent
  projects: Project[]
  sessions: HermesSession[]
  tasks: Task[]
  catalog?: ModelCatalog
  refreshSessions(): Promise<void>
  refreshTasks(): Promise<void>
  onOpenChat(projectId?: string, sessionId?: string): void
}

function Message({ message }: { message: ChatMessage }) {
  const assistant = message.role === 'assistant'
  return <article className={`message ${assistant ? 'assistant' : 'user'}`}>
    <div className="message-identity">{assistant ? <><BrandGlyph/><span className="assistant-name">Archon</span></> : <span>YOU</span>}</div>
    <div className="message-body"><div className="message-copy"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div><time>{formatDate(message.timestamp)}</time></div>
  </article>
}

function TaskExchange({ task, onCancel }: { task: Task; onCancel(): void }) {
  const active = task.status === 'queued' || task.status === 'running'
  return <div className="task-exchange">
    <article className="message user"><div className="message-identity"><span>YOU</span></div><div className="message-body"><div className="message-copy">{task.prompt}</div></div></article>
    <article className="message assistant"><div className="message-identity"><BrandGlyph/><span className="assistant-name">Archon</span></div><div className="message-body">
      {active && <div className="run-state"><CircleNotch className="spin"/><span>{task.status === 'queued' ? 'queued' : 'working'}</span><code>{task.id.slice(0, 8)}</code><Button tone="ghost" onClick={onCancel}><Stop/> Stop</Button></div>}
      {task.result?.text && <div className="message-copy"><ReactMarkdown remarkPlugins={[remarkGfm]}>{task.result.text}</ReactMarkdown></div>}
      {task.error && <div className="message-error">{task.error}</div>}
    </div></article>
  </div>
}

export function ChatPage({ api, intent, projects, sessions, tasks, catalog, refreshSessions, refreshTasks, onOpenChat }: ChatPageProps) {
  const [projectId, setProjectId] = useState(intent?.projectId || '')
  const [sessionId] = useState(intent?.sessionId || '')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [modelChoice, setModelChoice] = useState('')
  const [localTaskIds, setLocalTaskIds] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [messageError, setMessageError] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [voiceMode, setVoiceMode] = useState(false)
  const [attachments, setAttachments] = useState<Array<{ name: string; path: string }>>([])
  const [uploading, setUploading] = useState(false)
  const [approval, setApproval] = useState<ApprovalMode>(() => readApprovalMode(intent?.sessionId || 'new'))
  const [composerVisibility, setComposerVisibility] = useState(readComposerVisibility)
  const [transcribing, setTranscribing] = useState(false)
  const [voiceAvailable, setVoiceAvailable] = useState<boolean>()
  const messageScroll = useRef<HTMLDivElement>(null)
  const promptArea = useRef<HTMLTextAreaElement>(null)
  const attachmentInput = useRef<HTMLInputElement>(null)
  const previousLength = useRef(0)
  const spokenReply = useRef('')
  const voiceModeRef = useRef(false)
  const startListeningRef = useRef<() => Promise<void>>(async () => {})
  const selectedSession = sessions.find((session) => session.id === sessionId)

  useEffect(() => {
    if (!projectId && projects.length) {
      const preferred = projects.find((project) => project.slug === 'archon-desktop') || projects[0]
      setProjectId(preferred.id)
    }
  }, [projectId, projects])
  useEffect(() => {
    if (!catalog) return
    if (selectedSession?.model) {
      const provider = catalog.providers.find((item) => item.models.includes(selectedSession.model))
      if (provider) { setModelChoice(`${provider.id}\u0000${selectedSession.model}`); return }
    }
    if (catalog.current.provider && catalog.current.model) setModelChoice(`${catalog.current.provider}\u0000${catalog.current.model}`)
  }, [selectedSession?.model, catalog?.current.provider, catalog?.current.model, catalog?.providers.length])
  useEffect(() => {
    let active = true
    if (!sessionId) { setMessages([]); return () => { active = false } }
    const load = () => void api.sessionMessages(sessionId).then((items) => { if (active) { setMessages(items); setMessageError('') } }).catch((error) => { if (active) setMessageError(error instanceof Error ? error.message : String(error)) })
    const onData = () => load()
    load(); window.addEventListener('archon:data-changed', onData)
    return () => { active = false; window.removeEventListener('archon:data-changed', onData) }
  }, [api, sessionId])
  useEffect(() => setApproval(readApprovalMode(sessionId || 'new')), [sessionId])
  useEffect(() => {
    if (!sessionId) return
    const latest = tasks.find((task) => task.session_id === sessionId && task.approval_mode)?.approval_mode
    if (!latest) return
    setApproval(latest); writeApprovalMode(sessionId, latest)
  }, [sessionId, tasks])
  useEffect(() => {
    const sync = () => setComposerVisibility(readComposerVisibility())
    window.addEventListener('archon:composer-visibility', sync)
    return () => window.removeEventListener('archon:composer-visibility', sync)
  }, [])
  useEffect(() => { void api.audioStatus().then((status) => setVoiceAvailable(status.available)).catch(() => setVoiceAvailable(false)) }, [api])
  useEffect(() => {
    const area = promptArea.current
    if (!area) return
    area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 170)}px`
  }, [prompt])

  const activeProject = projects.find((project) => project.id === (projectId || selectedSession?.project_id))
  const localTasks = tasks.filter((task) => localTaskIds.includes(task.id))
  const sessionTasks = tasks.filter((task) => task.session_id === sessionId && ['queued', 'running', 'failed'].includes(task.status))
  const displayedTasks = sessionId ? sessionTasks : localTasks
  const runningTaskCount = tasks.filter((task) => task.status === 'queued' || task.status === 'running').length
  const showThread = Boolean(sessionId || localTaskIds.length)

  useEffect(() => {
    const viewport = messageScroll.current
    if (!viewport || previousLength.current === messages.length + displayedTasks.length) return
    previousLength.current = messages.length + displayedTasks.length
    requestAnimationFrame(() => viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' }))
  }, [messages.length, displayedTasks.length])

  const submit = async (override?: string) => {
    const text = (override ?? prompt).trim()
    if (!text || sending) return
    setSending(true); setMessageError('')
    try {
      const separator = modelChoice.indexOf('\u0000')
      const provider = separator >= 0 ? modelChoice.slice(0, separator) : undefined
      const model = separator >= 0 ? modelChoice.slice(separator + 1) : undefined
      const submitted = attachments.length ? `${text}\n\nAttached files on the VPS:\n${attachments.map((file) => `- /home/archon/${file.path}`).join('\n')}` : text
      const task = await api.createTask({ prompt: submitted, cwd: activeProject?.primary_path || undefined, provider, model, session_id: sessionId || undefined, approval_mode: approval, skills: [] })
      setLocalTaskIds((ids) => [...ids, task.id]); setPrompt(''); setAttachments([])
      await Promise.all([refreshTasks(), refreshSessions()])
    } catch (error) { setMessageError(error instanceof Error ? error.message : String(error)) }
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
    if (!voiceMode) return
    const completedTask = [...displayedTasks].reverse().find((task) => task.result?.text)?.result?.text
    const assistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')?.content
    const text = completedTask || assistantMessage || ''
    const key = text ? `${sessionId}:${text.slice(0, 160)}` : ''
    if (!text || key === spokenReply.current) return
    spokenReply.current = key
    void api.speakText(text).then((result) => {
      const audio = new Audio(result.data_url)
      audio.addEventListener('ended', () => { if (voiceModeRef.current) void startListeningRef.current() }, { once: true })
      return audio.play()
    }).catch((reason) => setVoiceError(reason instanceof Error ? reason.message : String(reason)))
  }, [api, displayedTasks, messages, sessionId, voiceMode])

  const stopActive = () => {
    const active = displayedTasks.find((task) => ['queued', 'running'].includes(task.status))
    if (active) void api.cancelTask(active.id).then(refreshTasks)
  }

  const approvalModes = {
    auto: { label: 'Auto', icon: Lightning }, approve: { label: 'Approve steps', icon: SealCheck }, plan: { label: 'Plan mode', icon: ListChecks },
  } as const
  const cycleApproval = () => setApproval((value) => { const next = cycleApprovalMode(value); writeApprovalMode(sessionId || 'new', next); return next })
  const attach = async (file?: File) => {
    if (!file) return
    setUploading(true); setMessageError('')
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120) || 'attachment'
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const uploaded = await api.uploadFile(`.local/share/archon-desktop/attachments/${id}-${safeName}`, file)
      setAttachments((items) => [...items, { name: file.name, path: uploaded.path }])
    } catch (error) { setMessageError(error instanceof Error ? error.message : String(error)) }
    finally { setUploading(false); if (attachmentInput.current) attachmentInput.current.value = '' }
  }
  const composer = (home = false) => {
    const ApprovalIcon = approvalModes[approval].icon
    const inputProps = { 'aria-label': 'Message Archon', value: prompt, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setPrompt(event.target.value), onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }, placeholder: home ? 'Ask Archon anything, or give it a job to run on the server…' : 'Reply to Archon…' }
    return <div className={`v2-composer reference-composer ${home ? 'home' : ''}`}>
      {attachments.length > 0 && <div className="composer-attachments">{attachments.map((file) => <span key={file.path}>{file.name}<button aria-label={`Remove ${file.name}`} onClick={() => setAttachments((items) => items.filter((item) => item.path !== file.path))}><X/></button></span>)}</div>}
      {home ? <input {...inputProps}/> : <textarea ref={promptArea} {...inputProps} rows={2}/>}
      <div className="v2-composer-tools reference-composer-tools"><input ref={attachmentInput} hidden type="file" onChange={(event) => void attach(event.target.files?.[0])}/><button type="button" className="glyph-button" title="Attach file" aria-label="Attach file" disabled={uploading} onClick={() => attachmentInput.current?.click()}>{uploading ? <CircleNotch className="spin"/> : <RoseGlyph size={home ? 19 : 17}/>}</button><label className="project-button"><Folder/><select aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Workspace</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><ModelPicker catalog={catalog} value={modelChoice} onChange={setModelChoice} globalShortcut={home}/>{composerVisibility.approval && <button type="button" className="approval-button" onClick={cycleApproval}><ApprovalIcon/>{approvalModes[approval].label}</button>}{composerVisibility.voice && <><button type="button" className={`composer-voice voice-button ${voiceMode ? 'active' : ''}`} role="switch" aria-checked={voiceMode} aria-label="Voice conversation" disabled={voiceAvailable === false} onClick={() => { const next = !voiceModeRef.current; voiceModeRef.current = next; setVoiceMode(next); if (next) void mic.start(); else if (mic.recording) mic.stop() }}><WaveGlyph live={voiceMode}/>{voiceMode && <small>Live</small>}</button><button type="button" className={`composer-mic mic-button ${mic.recording ? 'recording active' : ''}`} aria-label={mic.recording ? 'Stop microphone recording' : 'Start microphone recording'} disabled={voiceAvailable === false || transcribing} onClick={() => mic.recording ? mic.stop() : void mic.start()} style={{ '--mic-level': String(mic.level) } as React.CSSProperties}>{transcribing ? <CircleNotch className="spin"/> : <Microphone/>}</button></>}{!home && displayedTasks.some((task) => ['queued', 'running'].includes(task.status)) && <button className="composer-stop" onClick={stopActive}><Stop/> Stop</button>}<button className={home ? 'round-send' : 'send-button'} aria-label="Send message" disabled={!prompt.trim() || sending || !modelChoice} onClick={() => void submit()}>{sending ? <CircleNotch className="spin"/> : <QuillGlyph size={home ? 16 : 15}/>}</button></div>
    </div>
  }

  if (!showThread) {
    const activeTasks = tasks.filter((task) => ['queued', 'running', 'blocked'].includes(task.status)).slice(0, 2)
    const recentSessions = sessions.slice(0, Math.max(0, 4 - activeTasks.length))
    return <section className="v2-new-chat canonical-home">
      <ErrorNotice error={messageError || voiceError}/>
      <div className="v2-start-canonical">
        <div className="v2-start-heading"><BrandGlyph/><span className="v2-start-wordmark">Archon</span><h1>Evening, Abdullah.</h1><p>{runningTaskCount ? `${runningTaskCount === 1 ? 'One task is' : `${runningTaskCount} tasks are`} still running on the VPS. Pick up where you left off, or start something new.` : 'Everything is quiet on the VPS. Start something new.'}</p></div>
        <div className="v2-start-composer canonical">{composer(true)}<small className="composer-note">Every message becomes a server-owned task — close the window and it keeps going.</small></div>
        {(activeTasks.length > 0 || recentSessions.length > 0) && <section className="v2-pickup"><h2>Pick up</h2><div>{activeTasks.map((task) => <button key={task.id} onClick={() => task.session_id && onOpenChat(undefined, task.session_id)}><Pulse/><span><b>{task.prompt}</b><small>{task.id.slice(0, 6)} {task.status}</small></span></button>)}{recentSessions.map((session) => <button key={session.id} onClick={() => onOpenChat(session.project_id, session.id)}><BrandGlyph/><span><b>{session.title || 'Untitled session'}</b><small>{projects.find((project) => project.id === session.project_id)?.name || 'Workspace'} · {formatDate(session.last_active)}</small></span></button>)}</div></section>}
      </div>
    </section>
  }

  return <section className="v2-thread">
    <header className="v2-thread-header"><div><h1>{selectedSession?.title || 'New task'}</h1><span><code>{activeProject?.primary_path || '~/archon'}</code>{messages.length ? ` · ${messages.length} messages` : ''}</span></div><ModelPicker catalog={catalog} value={modelChoice} onChange={setModelChoice}/></header>
    <ErrorNotice error={messageError || voiceError}/>
    <div className="message-scroll" ref={messageScroll}>{messages.map((message) => <Message key={message.id} message={message}/>)}{displayedTasks.map((task) => <TaskExchange key={task.id} task={task} onCancel={() => void api.cancelTask(task.id).then(refreshTasks)}/>)}</div>
    <div className="v2-thread-composer">{composer(false)}<small>Enter to send · Shift Enter newline · work continues if this window closes</small></div>
  </section>
}
