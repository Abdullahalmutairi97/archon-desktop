import { useEffect, useRef, useState } from 'react'
import type { DesktopBridge, SessionMessageRecord } from '../../shared/bridge/types'
import {
  createSnapshotV1,
  encodeSnapshotV1,
  parseSnapshotV1,
  SNAPSHOT_MAX_BYTES,
  type SnapshotSourceSession,
  type SnapshotV1,
} from '../../shared/domain/snapshot'
import { LiveDialog } from './LiveDialog'
import { liveSessions, snapshotSourceMessages } from './liveModels'
import { Markdown } from './Markdown'
import { LIVE_SESSION_LIMIT } from './useLiveServer'
import './LiveViews.css'

/** Transcript rows read per shared conversation (the bridge maximum). */
export const SHARE_TRANSCRIPT_LIMIT = 500
/** A project with more conversations than this is shared one conversation at a time. */
export const MAX_SHARED_SESSIONS = 100

export type ShareSource =
  | { kind: 'session'; title: string; session: { id: string; title: string } }
  | { kind: 'project'; title: string; projectId: string }

type ShareState =
  | { state: 'collecting'; done: number; total: number | null }
  | { state: 'review'; snapshot: SnapshotV1; clipped: readonly string[] }
  | { state: 'code'; snapshot: SnapshotV1; clipped: readonly string[]; code: string; copy: 'idle' | 'copied' | 'failed' }
  | { state: 'error'; message: string }

class ShareFailure extends Error {}

function messageCount(snapshot: SnapshotV1): number {
  return snapshot.sessions.reduce((total, session) => total + session.messages.length, 0)
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`
}

/** Read-only rendering of snapshot content: user text as text, agent text through the inert Markdown subset. */
export function SnapshotView({ snapshot, label }: { snapshot: SnapshotV1; label: string }) {
  const [index, setIndex] = useState(0)
  const selected = snapshot.sessions[Math.min(index, snapshot.sessions.length - 1)]
  return <section className="live-snapshot" aria-label={label}>
    <p className="live-snapshot-summary">
      <strong dir="auto">{snapshot.title || 'Untitled snapshot'}</strong>
      <span>{snapshot.kind === 'project' ? 'Project' : 'Conversation'} · {plural(snapshot.sessions.length, 'conversation')} · {plural(messageCount(snapshot), 'message')}</span>
    </p>
    {snapshot.sessions.length > 1 && <select aria-label={`${label}: conversation`} value={Math.min(index, snapshot.sessions.length - 1)} onChange={(event) => setIndex(Number(event.currentTarget.value))}>
      {snapshot.sessions.map((session, sessionIndex) => <option key={`${sessionIndex}:${session.id}`} value={sessionIndex}>{session.title} · {plural(session.messages.length, 'message')}</option>)}
    </select>}
    <div className="live-snapshot-messages">
      {snapshot.sessions.length === 1 && <p className="live-task-note" dir="auto">{selected.title} · {plural(selected.messages.length, 'message')}</p>}
      {selected.messages.length === 0 && <p className="live-empty-line">This conversation has no shared messages.</p>}
      {selected.messages.map((message, messageIndex) => <article key={messageIndex} className={`live-snapshot-message live-snapshot-${message.role}`}>
        <strong>{message.role === 'user' ? 'You' : 'Agent'}</strong>
        {message.role === 'agent'
          ? <Markdown className="live-message-text" text={message.content} />
          : <p className="live-message-text" dir="auto">{message.content}</p>}
      </article>)}
    </div>
  </section>
}

/**
 * Share a conversation, or a project's conversations, as a read-only snapshot
 * code. Transcripts are read first and reviewed; the code is made only when
 * asked. Only user and assistant text is included.
 */
export function ShareDialog({ bridge, source, onClose }: { bridge: DesktopBridge; source: ShareSource; onClose(): void }) {
  const [state, setState] = useState<ShareState>({ state: 'collecting', done: 0, total: source.kind === 'session' ? 1 : null })
  const close = useRef<HTMLButtonElement>(null)
  const codeField = useRef<HTMLTextAreaElement>(null)
  // Primitive identity of the source, so a re-rendered parent does not restart the read.
  const { kind, title } = source
  const sessionId = source.kind === 'session' ? source.session.id : null
  const sessionTitle = source.kind === 'session' ? source.session.title : null
  const projectId = source.kind === 'project' ? source.projectId : null

  useEffect(() => {
    let current = true
    void (async () => {
      let sessions: Array<{ id: string; title: string }>
      if (projectId === null) {
        sessions = [{ id: sessionId ?? '', title: sessionTitle ?? '' }]
      } else {
        try {
          const result = await bridge.api.invoke('sessions.list', { projectId, limit: LIVE_SESSION_LIMIT })
          sessions = liveSessions(result.sessions)
            .filter((session) => session.projectId === projectId)
            .map((session) => ({ id: session.id, title: session.title }))
        } catch {
          throw new ShareFailure('This project’s conversations could not be read from the server. Check the connection, then try again.')
        }
        if (!current) return
        if (sessions.length === 0) throw new ShareFailure('This project has no conversations to share.')
        if (sessions.length > MAX_SHARED_SESSIONS) throw new ShareFailure('Share individual sessions from this large project.')
        setState({ state: 'collecting', done: 0, total: sessions.length })
      }
      const collected: SnapshotSourceSession[] = []
      const clipped: string[] = []
      for (const session of sessions) {
        let messages: readonly SessionMessageRecord[]
        try {
          messages = (await bridge.api.invoke('sessions.messages', { sessionId: session.id, limit: SHARE_TRANSCRIPT_LIMIT })).messages
        } catch {
          throw new ShareFailure(`“${session.title}” could not be read from the server. Check the connection, then try again.`)
        }
        if (!current) return
        if (messages.length >= SHARE_TRANSCRIPT_LIMIT) clipped.push(session.title)
        collected.push({ id: session.id, title: session.title, messages: snapshotSourceMessages(messages) })
        setState({ state: 'collecting', done: collected.length, total: sessions.length })
      }
      let snapshot: SnapshotV1
      try {
        snapshot = createSnapshotV1(kind, title, collected)
      } catch {
        throw new ShareFailure('This content is too large for a sharing code (1 MB limit). Share fewer conversations.')
      }
      if (current) setState({ state: 'review', snapshot, clipped })
    })().catch((error: unknown) => {
      if (current) setState({ state: 'error', message: error instanceof ShareFailure ? error.message : 'Sharing failed.' })
    })
    return () => { current = false }
  }, [bridge, kind, title, sessionId, sessionTitle, projectId])

  function createCode(): void {
    if (state.state !== 'review') return
    try {
      setState({ ...state, state: 'code', code: encodeSnapshotV1(state.snapshot), copy: 'idle' })
    } catch {
      setState({ state: 'error', message: 'This content is too large for a sharing code (1 MB limit). Share fewer conversations.' })
    }
  }

  async function copyCode(): Promise<void> {
    if (state.state !== 'code') return
    const { code } = state
    let copied = false
    try {
      await navigator.clipboard.writeText(code)
      copied = true
    } catch {
      const field = codeField.current
      field?.focus()
      field?.select()
      try {
        copied = typeof document.execCommand === 'function' && document.execCommand('copy')
      } catch {
        copied = false
      }
    }
    setState((current) => current.state === 'code' && current.code === code ? { ...current, copy: copied ? 'copied' : 'failed' } : current)
  }

  const reviewing = state.state === 'review' || state.state === 'code'
  return <LiveDialog
    eyebrow="READ-ONLY SHARING"
    title={source.kind === 'project' ? `Share project “${source.title}”` : `Share “${source.title}”`}
    wide
    initialFocus={close}
    onCancel={onClose}
    footer={<>
      <button type="button" ref={close} onClick={onClose}>{state.state === 'code' ? 'Done' : 'Cancel'}</button>
      {state.state === 'review' && <button type="button" className="live-primary" onClick={createCode}>Create sharing code</button>}
    </>}
  >
    <p className="live-dialog-detail">A snapshot code carries a read-only copy of the conversation text. Reasoning, tool calls, files, live editing and agent control are never included.</p>
    {state.state === 'collecting' && <p className="live-task-note" role="status">
      {state.total === null ? 'Reading this project’s conversations…' : `Reading ${state.done < state.total ? state.done + 1 : state.total} of ${plural(state.total, 'conversation')} from the server…`}
    </p>}
    {state.state === 'error' && <p className="live-dialog-error" role="alert">{state.message}</p>}
    {reviewing && <>
      <p className="live-dialog-detail"><strong>Review what will be shared: {plural(state.snapshot.sessions.length, 'conversation')}, {plural(messageCount(state.snapshot), 'message')}.</strong> Anyone with the code can read it, and a copy cannot be revoked.</p>
      {state.clipped.length > 0 && <p className="live-task-note">Only the most recent {SHARE_TRANSCRIPT_LIMIT} transcript rows were read for: <span dir="auto">{state.clipped.join(', ')}</span>.</p>}
      <SnapshotView snapshot={state.snapshot} label="Snapshot review" />
    </>}
    {state.state === 'code' && <div className="live-share-code">
      <label htmlFor="live-share-code">Sharing code</label>
      <textarea id="live-share-code" ref={codeField} readOnly value={state.code} rows={4} dir="ltr" onFocus={(event) => event.currentTarget.select()} />
      <div className="live-share-code-row">
        <span className="live-task-note">{(state.code.length / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB code · snapshot content is limited to {SNAPSHOT_MAX_BYTES / (1024 * 1024)} MB</span>
        <button type="button" onClick={() => { void copyCode() }}>Copy code</button>
      </div>
      {state.copy === 'copied' && <p className="live-task-note" role="status">Sharing code copied.</p>}
      {state.copy === 'failed' && <p className="live-dialog-error" role="alert">Copy failed. Select the code above and copy it manually.</p>}
    </div>}
  </LiveDialog>
}

/** Paste a snapshot code and read it. Nothing is sent to the server. */
export function OpenSnapshotDialog({ onClose }: { onClose(): void }) {
  const [input, setInput] = useState('')
  const [shared, setShared] = useState<SnapshotV1 | null>(null)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  function open(): void {
    setShared(null)
    try {
      setShared(parseSnapshotV1(input))
      setError(null)
    } catch {
      setError('Invalid or oversized sharing code.')
    }
  }

  return <LiveDialog
    eyebrow="READ-ONLY SNAPSHOT"
    title="Open a shared snapshot"
    wide
    initialFocus={field}
    onCancel={onClose}
    footer={<>
      <button type="button" onClick={onClose}>Close</button>
      <button type="button" className="live-primary" onClick={open} disabled={!input.trim()}>Open snapshot</button>
    </>}
  >
    <p className="live-dialog-detail">Paste an <code>archon-snapshot:</code> code from Archon. It opens here, read-only; nothing is sent to the server.</p>
    <textarea
      ref={field}
      className="live-snapshot-input"
      aria-label="Sharing code to open"
      dir="ltr"
      rows={4}
      maxLength={SNAPSHOT_MAX_BYTES * 2}
      value={input}
      onChange={(event) => { setInput(event.currentTarget.value); setError(null) }}
      placeholder="archon-snapshot:…"
    />
    {error && <p className="live-dialog-error" role="alert">{error}</p>}
    {shared && <SnapshotView snapshot={shared} label="Shared content" />}
  </LiveDialog>
}
