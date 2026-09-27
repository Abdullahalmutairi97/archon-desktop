import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { WorkspaceConsoleBridge, WorkspaceConsoleScreenDto, WorkspaceConsoleTerminalDto, WorkspaceConsoleKeyEvent, WorkspaceConsoleNamedKey } from '../../shared/bridge/types'
import './WorkspaceConsole.css'

export function WorkspaceConsole({
  bridge,
  workspaceId,
  generation,
  pairingAvailable,
}: {
  bridge: WorkspaceConsoleBridge
  workspaceId: string
  generation: number
  pairingAvailable: boolean
}) {
  const [terminals, setTerminals] = useState<readonly WorkspaceConsoleTerminalDto[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [screen, setScreen] = useState<WorkspaceConsoleScreenDto | null>(null)
  const [line, setLine] = useState('')
  const [lease, setLease] = useState<{ attachId: string; mode: 'control' | 'read-only' } | null>(null)
  const [interactiveLine, setInteractiveLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [message, setMessage] = useState<{ kind: 'status' | 'error' | 'ambiguous'; text: string } | null>(null)
  const requestLock = useRef(false)
  const screenRequestRef = useRef<{ key: string; promise: Promise<boolean> } | null>(null)
  const listRequestId = useRef(0)
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const identity = `${workspaceId}:${generation}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const screenKey = `${identity}:${sessionId ?? ''}`
  const screenKeyRef = useRef(screenKey)
  screenKeyRef.current = screenKey

  const refreshList = useCallback(async () => {
    if (!pairingAvailable) return
    const requestId = ++listRequestId.current
    const requestedIdentity = identity
    try {
      const items = await bridge.list({ workspaceId })
      if (requestId !== listRequestId.current || identityRef.current !== requestedIdentity || workspaceIdRef.current !== workspaceId) return
      setTerminals(items)
      const currentSessionId = sessionIdRef.current
      const nextSessionId = items.some((item) => item.sessionId === currentSessionId) ? currentSessionId : items[0]?.sessionId ?? null
      if (nextSessionId !== currentSessionId) {
        setConfirmStop(false)
        setScreen(null)
      }
      setSessionId(nextSessionId)
      setMessage(null)
    } catch {
      if (requestId === listRequestId.current && identityRef.current === requestedIdentity && workspaceIdRef.current === workspaceId) {
        setMessage({ kind: 'error', text: 'Console status is unavailable. The backend may lack console support, local pairing may be offline, or tmux may be unavailable. Refresh to check again.' })
      }
    }
  }, [bridge, generation, identity, pairingAvailable, workspaceId])

  const refreshScreen = useCallback((): Promise<boolean> => {
    if (!pairingAvailable || !sessionId) return Promise.resolve(false)
    const requestKey = `${identity}:${sessionId}`
    const currentRequest = screenRequestRef.current
    if (currentRequest?.key === requestKey) return currentRequest.promise
    const request = Promise.resolve().then(() => bridge.screen({ workspaceId, sessionId, lines: 80 })).then((response) => {
      if (screenKeyRef.current !== requestKey) return false
      setScreen(response)
      return true
    }).catch(() => {
      if (screenKeyRef.current === requestKey) {
        setScreen(null)
        setMessage({ kind: 'error', text: 'Could not refresh the screen. Check the session list before sending another line.' })
      }
      return false
    }).finally(() => {
      if (screenRequestRef.current?.promise === request) screenRequestRef.current = null
    })
    screenRequestRef.current = { key: requestKey, promise: request }
    return request
  }, [bridge, generation, identity, pairingAvailable, sessionId, workspaceId])

  useEffect(() => { void refreshList() }, [refreshList])
  const selectedSessionRunning = terminals.some((item) => item.sessionId === sessionId && item.state === 'running')
  useEffect(() => {
    setScreen(null)
    setLease(null)
    if (!sessionId) return
    void refreshScreen()
    if (!selectedSessionRunning) return
    const timer = window.setInterval(() => { void refreshScreen() }, 2500)
    return () => window.clearInterval(timer)
  }, [refreshScreen, selectedSessionRunning, sessionId])

  async function createSession(): Promise<void> {
    if (requestLock.current || !pairingAvailable) return
    const requestedIdentity = identity
    requestLock.current = true
    setBusy(true)
    setMessage(null)
    try {
      const created = await bridge.create({ workspaceId, expectedGeneration: generation })
      if (identityRef.current !== requestedIdentity) return
      setTerminals((current) => [created, ...current.filter((item) => item.sessionId !== created.sessionId)].slice(0, 16))
      setConfirmStop(false)
      setSessionId(created.sessionId)
    } catch {
      if (identityRef.current === requestedIdentity) setMessage({ kind: 'ambiguous', text: 'Could not confirm whether a console session was created. Refresh the session list before trying again.' })
    } finally {
      requestLock.current = false
      if (identityRef.current === requestedIdentity) setBusy(false)
    }
  }

  async function sendLine(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (requestLock.current || !pairingAvailable || !sessionId || !terminals.some((item) => item.sessionId === sessionId && item.state === 'running') || !line || /[\u0000-\u001f\u007f]/u.test(line)
      || new TextEncoder().encode(line).byteLength > 4096) return
    requestLock.current = true
    setBusy(true)
    setMessage(null)
    const sentLine = line
    const requestedIdentity = identity
    try {
      await bridge.sendLine({ workspaceId, sessionId, line: sentLine })
      if (identityRef.current !== requestedIdentity) return
      setLine('')
      if (await refreshScreen()) setMessage({ kind: 'status', text: 'Line sent once.' })
    } catch {
      if (identityRef.current === requestedIdentity) setMessage({ kind: 'ambiguous', text: 'The line may have reached the process, but the reply was not confirmed. It was not retried. Refresh the screen before deciding what to do next.' })
    } finally {
      requestLock.current = false
      if (identityRef.current === requestedIdentity) setBusy(false)
    }
  }

  async function interruptCommand(): Promise<void> {
    if (requestLock.current || !pairingAvailable || !sessionId || !terminals.some((item) => item.sessionId === sessionId && item.state === 'running')) return
    requestLock.current = true
    setBusy(true)
    setMessage(null)
    const requestedIdentity = identity
    const requestedSessionId = sessionId
    try {
      await bridge.interrupt({ workspaceId, sessionId: requestedSessionId })
      if (identityRef.current !== requestedIdentity || sessionIdRef.current !== requestedSessionId) return
      setMessage({ kind: 'status', text: 'Interrupt sent once. The console session remains open.' })
    } catch {
      if (identityRef.current === requestedIdentity && sessionIdRef.current === requestedSessionId) {
        setMessage({ kind: 'ambiguous', text: 'The interrupt may have reached the process, but the reply was not confirmed. It was not retried. Refresh the screen before any manual retry.' })
      }
    } finally {
      requestLock.current = false
      if (identityRef.current === requestedIdentity) setBusy(false)
    }
  }

  async function stopSession(): Promise<void> {
    if (!sessionId || requestLock.current) return
    const requestedIdentity = identity
    const requestedSessionId = sessionId
    requestLock.current = true
    setBusy(true)
    try {
      await bridge.stop({ workspaceId, sessionId })
      if (identityRef.current !== requestedIdentity || sessionIdRef.current !== requestedSessionId) return
      setTerminals((current) => current.filter((item) => item.sessionId !== requestedSessionId))
      setSessionId(null)
      setScreen(null)
      setConfirmStop(false)
      setMessage({ kind: 'status', text: 'Console session stopped.' })
    } catch {
      if (identityRef.current === requestedIdentity && sessionIdRef.current === requestedSessionId) setMessage({ kind: 'ambiguous', text: 'Could not confirm whether the session stopped. Refresh the session list before trying again.' })
    } finally {
      requestLock.current = false
      if (identityRef.current === requestedIdentity) setBusy(false)
    }
  }

  const canInteract = pairingAvailable && terminals.some((item) => item.sessionId === sessionId && item.state === 'running')
  const selectedRunning = canInteract

  async function attachSession(mode: 'control' | 'read-only'): Promise<void> {
    if (requestLock.current || !pairingAvailable || !sessionId || !selectedRunning) return
    const requestedIdentity = identity
    const requestedSessionId = sessionId
    requestLock.current = true
    setBusy(true)
    setMessage(null)
    try {
      const ticket = await bridge.attach({ workspaceId, sessionId: requestedSessionId, expectedGeneration: generation, mode })
      const claimed = await bridge.claim({ workspaceId, sessionId: requestedSessionId, ticket: ticket.ticket })
      if (identityRef.current !== requestedIdentity || sessionIdRef.current !== requestedSessionId) return
      setLease({ attachId: claimed.attachId, mode: claimed.mode })
      setMessage({ kind: 'status', text: mode === 'control' ? 'Interactive control attached.' : 'Read-only attach open. Input stays disabled.' })
    } catch {
      if (identityRef.current === requestedIdentity && sessionIdRef.current === requestedSessionId) {
        setMessage({ kind: 'error', text: 'Could not open an interactive attach. Another client may hold control, or the session changed. Refresh before retrying.' })
      }
    } finally {
      requestLock.current = false
      if (identityRef.current === requestedIdentity) setBusy(false)
    }
  }

  async function detachSession(): Promise<void> {
    const active = lease
    if (!active || requestLock.current || !sessionId) return
    const requestedIdentity = identity
    const requestedSessionId = sessionId
    requestLock.current = true
    setBusy(true)
    try {
      await bridge.detach({ workspaceId, sessionId: requestedSessionId, attachId: active.attachId })
      if (identityRef.current !== requestedIdentity || sessionIdRef.current !== requestedSessionId) return
      setLease(null)
      setMessage({ kind: 'status', text: 'Interactive attach released. The shell keeps running.' })
    } catch {
      if (identityRef.current === requestedIdentity && sessionIdRef.current === requestedSessionId) {
        setMessage({ kind: 'error', text: 'Could not confirm the attach release. The lease may have expired. Refresh the session list.' })
      }
    } finally {
      requestLock.current = false
      if (identityRef.current === requestedIdentity) setBusy(false)
    }
  }

  async function sendKeys(events: readonly WorkspaceConsoleKeyEvent[]): Promise<void> {
    const active = lease
    if (!active || active.mode !== 'control' || requestLock.current || !pairingAvailable || !sessionId) return
    const requestedIdentity = identity
    const requestedSessionId = sessionId
    const requestedAttachId = active.attachId
    requestLock.current = true
    setBusy(true)
    setMessage(null)
    try {
      await bridge.attachInput({ workspaceId, sessionId: requestedSessionId, attachId: requestedAttachId, events })
      if (identityRef.current !== requestedIdentity || sessionIdRef.current !== requestedSessionId) return
      if (await refreshScreen()) setMessage({ kind: 'status', text: 'Interactive input sent once.' })
    } catch {
      if (identityRef.current === requestedIdentity && sessionIdRef.current === requestedSessionId) {
        setMessage({ kind: 'ambiguous', text: 'The interactive input may have reached the process, but the reply was not confirmed. It was not retried. Refresh the screen before deciding what to do next.' })
      }
    } finally {
      requestLock.current = false
      if (identityRef.current === requestedIdentity) setBusy(false)
    }
  }

  useEffect(() => {
    if (!lease || !sessionId) return
    let active = true
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = bridge.subscribe((event) => {
        if (!active || event.attachId !== lease.attachId) return
        setScreen({ text: event.text, truncated: event.truncated })
      })
    } catch {
      unsubscribe = undefined
    }
    void bridge.watch({ workspaceId, sessionId, attachId: lease.attachId, lines: 80 }).catch(() => {})
    return () => {
      active = false
      unsubscribe?.()
      void bridge.unwatch({ workspaceId, sessionId, attachId: lease.attachId }).catch(() => {})
    }
  }, [bridge, lease, sessionId, workspaceId])

  const quickKeys: readonly { label: string; key: WorkspaceConsoleNamedKey }[] = [
    { label: 'Tab', key: 'Tab' }, { label: '↑', key: 'Up' }, { label: '↓', key: 'Down' },
    { label: 'Esc', key: 'Escape' }, { label: 'Ctrl-C', key: 'C-c' }, { label: 'Backspace', key: 'BSpace' },
  ]

  return <section className="workspace-console" aria-label="Trusted same-user line console">
    <div className="workspace-console-heading">
      <div><h4>Trusted same-user line console</h4><span>Checkout {workspaceId} · generation {generation}</span></div>
      <button type="button" onClick={() => { void refreshList() }} disabled={!pairingAvailable || busy}>Refresh sessions</button>
    </div>
    <p>The shell starts in this checkout as the backend owner and can access that owner’s files. This is a plain-text line console, not a full interactive terminal. Do not enter secrets.</p>
    {!pairingAvailable && <p role="status">Local same-user pairing is unavailable, so the console is disabled.</p>}
    <div className="workspace-console-session-actions">
      <label><span>Session</span>
        <select aria-label="Console session" value={sessionId ?? ''} onChange={(event) => { setScreen(null); setSessionId(event.currentTarget.value || null); setConfirmStop(false) }} disabled={!pairingAvailable || busy}>
          <option value="">No session</option>
          {terminals.map((terminal) => <option key={terminal.sessionId} value={terminal.sessionId}>{terminal.state} · {terminal.createdAt} · …{terminal.sessionId.slice(-6)}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => { void createSession() }} disabled={!pairingAvailable || busy || terminals.length >= 16}>Create session</button>
      {sessionId && pairingAvailable && <button type="button" onClick={() => { void interruptCommand() }} disabled={busy || !canInteract}>Interrupt command</button>}
      {sessionId && !confirmStop && <button type="button" onClick={() => setConfirmStop(true)} disabled={busy}>Stop session…</button>}
      {sessionId && confirmStop && <span className="workspace-console-confirm">Stop this console session?
        <button type="button" onClick={() => { void stopSession() }} disabled={busy}>Confirm stop</button>
        <button type="button" onClick={() => setConfirmStop(false)} disabled={busy}>Keep session</button>
      </span>}
    </div>
    <div className="workspace-console-screen" aria-label="Console screen" aria-live="polite">
      {sessionId && screen?.truncated && <span className="workspace-console-truncated">Showing the last 80 lines.</span>}
      <pre>{sessionId ? (screen?.text ?? 'Loading console output…') : 'Create or select a session to view output.'}</pre>
    </div>
    <form className="workspace-console-input" onSubmit={(event) => { void sendLine(event) }}>
      <label htmlFor="workspace-console-line">Send one line</label>
      <input id="workspace-console-line" type="text" autoComplete="off" maxLength={4096} value={line} onChange={(event) => setLine(event.currentTarget.value)} disabled={!canInteract || busy} />
      <button type="submit" disabled={!canInteract || busy || !line || /[\u0000-\u001f\u007f]/u.test(line) || new TextEncoder().encode(line).byteLength > 4096}>{busy ? 'Working…' : 'Send line'}</button>
    </form>
    {message && <p className={`workspace-console-message console-${message.kind}`} role={message.kind === 'error' || message.kind === 'ambiguous' ? 'alert' : 'status'}>{message.text}</p>}
    <div className="workspace-console-attach" aria-label="Interactive attach">
      <h5>Interactive attach</h5>
      <p>A one-use ticket opens a single input-control lease. Detaching never stops the shell. Read-only attach can watch but never type.</p>
      {!lease && <div className="workspace-console-session-actions">
        <button type="button" onClick={() => { void attachSession('control') }} disabled={!canInteract || busy}>Attach control</button>
        <button type="button" onClick={() => { void attachSession('read-only') }} disabled={!canInteract || busy}>Attach read-only</button>
      </div>}
      {lease && <>
        <p className="workspace-console-lease">Attached ({lease.mode}) · …{lease.attachId.slice(-6)}</p>
        <div className="workspace-console-keys" aria-label="Control keys">
          {quickKeys.map((entry) => <button key={entry.key} type="button" disabled={busy || lease.mode !== 'control'} onClick={() => { void sendKeys([{ type: 'key', value: entry.key }]) }}>{entry.label}</button>)}
        </div>
        <form className="workspace-console-input" onSubmit={(event) => {
          event.preventDefault()
          if (!interactiveLine) return
          const pending = interactiveLine
          setInteractiveLine('')
          void sendKeys([{ type: 'text', value: pending }, { type: 'key', value: 'Enter' }])
        }}>          <label htmlFor="workspace-console-interactive">Interactive input</label>
          <input id="workspace-console-interactive" type="text" autoComplete="off" maxLength={1024} value={interactiveLine} onChange={(event) => setInteractiveLine(event.currentTarget.value)} disabled={!canInteract || busy || lease.mode !== 'control'} />
          <button type="submit" disabled={!canInteract || busy || lease.mode !== 'control' || !interactiveLine || /[\u0000-\u001f\u007f]/u.test(interactiveLine) || new TextEncoder().encode(interactiveLine).byteLength > 1024}>Send keys</button>
        </form>
        <button type="button" onClick={() => { void detachSession() }} disabled={busy}>Detach</button>
      </>}
    </div>
  </section>
}
