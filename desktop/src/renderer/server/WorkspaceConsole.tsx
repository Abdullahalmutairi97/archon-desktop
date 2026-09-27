import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { WorkspaceConsoleBridge, WorkspaceConsoleScreenDto, WorkspaceConsoleTerminalDto } from '../../shared/bridge/types'
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
  const [busy, setBusy] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [message, setMessage] = useState<{ kind: 'status' | 'error' | 'ambiguous'; text: string } | null>(null)
  const requestLock = useRef(false)
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

  const refreshScreen = useCallback(async (): Promise<boolean> => {
    if (!pairingAvailable || !sessionId) return false
    const requestKey = `${identity}:${sessionId}`
    try {
      const response = await bridge.screen({ workspaceId, sessionId, lines: 80 })
      if (screenKeyRef.current !== requestKey) return false
      setScreen(response)
      return true
    } catch {
      if (screenKeyRef.current === requestKey) {
        setScreen(null)
        setMessage({ kind: 'error', text: 'Could not refresh the screen. Check the session list before sending another line.' })
      }
      return false
    }
  }, [bridge, generation, identity, pairingAvailable, sessionId, workspaceId])

  useEffect(() => { void refreshList() }, [refreshList])
  useEffect(() => {
    setScreen(null)
    if (!sessionId) return
    void refreshScreen()
    const timer = window.setInterval(() => { void refreshScreen() }, 2500)
    return () => window.clearInterval(timer)
  }, [refreshScreen, sessionId])

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
    if (requestLock.current || !sessionId || !line || /[\u0000-\u001f\u007f]/u.test(line)
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
      <input id="workspace-console-line" type="text" autoComplete="off" maxLength={4096} value={line} onChange={(event) => setLine(event.currentTarget.value)} disabled={!pairingAvailable || !sessionId || busy} />
      <button type="submit" disabled={!pairingAvailable || !sessionId || busy || !line || /[\u0000-\u001f\u007f]/u.test(line) || new TextEncoder().encode(line).byteLength > 4096}>{busy ? 'Working…' : 'Send line'}</button>
    </form>
    {message && <p className={`workspace-console-message console-${message.kind}`} role={message.kind === 'error' || message.kind === 'ambiguous' ? 'alert' : 'status'}>{message.text}</p>}
  </section>
}
