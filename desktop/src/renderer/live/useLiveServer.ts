import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionDescription, DesktopBridge } from '../../shared/bridge/types'
import { readConversationNames, writeConversationName, type ConversationNames } from './conversationNames'
import { liveProjects, liveSessions, operationErrorCode, type LiveProject, type LiveSession } from './liveModels'

/** Rows the shared session list asks for; the server may cap it further. */
export const LIVE_SESSION_LIMIT = 200
/** How often a disconnected view re-reads the local connection description. */
export const DISCONNECTED_RECHECK_MS = 3_000

/** A usable server connection. Everything loaded under it is discarded when `generation` changes. */
export type LiveScope = {
  bridge: DesktopBridge
  generation: number
  serverUrl: string | null
  /** Same-user pairing is active, so terminals and services can be used. */
  localPairingAvailable: boolean
}

export type LiveStatus = 'checking' | 'unavailable' | 'disconnected' | 'loading' | 'ready' | 'rejected' | 'error'

export type LiveServer = {
  status: LiveStatus
  scope: LiveScope | null
  projects: readonly LiveProject[]
  sessions: readonly LiveSession[]
  /** A same-scope reload is running while the previous rows stay visible. */
  refreshing: boolean
  /** Re-read the connection and reload projects and sessions. */
  refresh(): void
  /** Give a conversation a local name on this computer, or clear it with null. */
  renameSession(sessionId: string, name: string | null): void
}

type DescribeState = { bridge: DesktopBridge; description: ConnectionDescription | null }

type Collections =
  | { bridge: DesktopBridge; generation: number; state: 'loading' }
  | { bridge: DesktopBridge; generation: number; state: 'ready'; projects: LiveProject[]; sessions: LiveSession[]; refreshing: boolean }
  | { bridge: DesktopBridge; generation: number; state: 'error'; rejected: boolean }

const NO_PROJECTS: readonly LiveProject[] = []
const NO_SESSIONS: readonly LiveSession[] = []

/**
 * Resolve the desktop connection each time the shell changes route (as the
 * Server work route does) and load server projects and sessions for it.
 * Responses that arrive for an earlier connection generation are ignored.
 */
export function useLiveServer(bridge: DesktopBridge | undefined, routeKey: string): LiveServer {
  const describeSerial = useRef(0)
  const collectionSerial = useRef(0)
  const [describeState, setDescribeState] = useState<DescribeState | null>(null)
  const [describeRequest, setDescribeRequest] = useState(0)
  const [reload, setReload] = useState(0)
  const [collections, setCollections] = useState<Collections | null>(null)

  useEffect(() => {
    if (!bridge) return
    const requestId = ++describeSerial.current
    void Promise.resolve().then(() => bridge.connection.describe()).then((description) => {
      if (describeSerial.current === requestId) setDescribeState({ bridge, description })
    }).catch(() => {
      if (describeSerial.current === requestId) setDescribeState({ bridge, description: null })
    })
    return () => {
      if (describeSerial.current === requestId) describeSerial.current += 1
    }
  }, [bridge, routeKey, describeRequest])

  const description = describeState && describeState.bridge === bridge ? describeState.description : undefined
  const configured = description?.configured === true
  const generation = description?.generation ?? -1
  const validGeneration = Number.isSafeInteger(generation) && generation >= 0
  const serverUrl = description?.serverUrl ?? null

  // A connection saved elsewhere (another view, another window) does not change
  // the route, so re-read it when the window regains focus, and every few
  // seconds while nothing is connected. The read is local IPC, not the network.
  useEffect(() => {
    if (!bridge) return
    const reread = () => setDescribeRequest((value) => value + 1)
    window.addEventListener('focus', reread)
    const timer = configured ? undefined : window.setInterval(reread, DISCONNECTED_RECHECK_MS)
    return () => {
      window.removeEventListener('focus', reread)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [bridge, configured])
  const localPairingAvailable = description?.localPairingAvailable === true

  useEffect(() => {
    const requestId = ++collectionSerial.current
    if (!bridge || !configured || !validGeneration) {
      setCollections(null)
      return () => { collectionSerial.current += 1 }
    }
    setCollections((current) => current && current.bridge === bridge && current.generation === generation && current.state === 'ready'
      ? { ...current, refreshing: true }
      : { bridge, generation, state: 'loading' })
    void Promise.all([
      bridge.api.invoke('projects.list', {}),
      bridge.api.invoke('sessions.list', { limit: LIVE_SESSION_LIMIT }),
    ]).then(([projects, sessions]) => {
      if (collectionSerial.current !== requestId) return
      setCollections({
        bridge,
        generation,
        state: 'ready',
        projects: liveProjects(projects.projects),
        sessions: liveSessions(sessions.sessions),
        refreshing: false,
      })
    }).catch((error: unknown) => {
      if (collectionSerial.current === requestId) {
        setCollections({ bridge, generation, state: 'error', rejected: operationErrorCode(error) === 'unauthorized' })
      }
    })
    return () => {
      if (collectionSerial.current === requestId) collectionSerial.current += 1
    }
  }, [bridge, configured, generation, validGeneration, reload])

  const [names, setNames] = useState<{ serverUrl: string | null; names: ConversationNames }>({ serverUrl: null, names: {} })
  useEffect(() => { setNames({ serverUrl, names: readConversationNames(serverUrl) }) }, [serverUrl])
  const currentNames = names.serverUrl === serverUrl ? names.names : null
  const renameSession = useCallback((sessionId: string, name: string | null) => {
    setNames((current) => ({
      serverUrl,
      names: writeConversationName(serverUrl, current.serverUrl === serverUrl ? current.names : readConversationNames(serverUrl), sessionId, name),
    }))
  }, [serverUrl])

  const refresh = useCallback(() => {
    setDescribeRequest((value) => value + 1)
    setReload((value) => value + 1)
  }, [])

  const scope = useMemo<LiveScope | null>(
    () => bridge && configured && validGeneration ? { bridge, generation, serverUrl, localPairingAvailable } : null,
    [bridge, configured, generation, validGeneration, serverUrl, localPairingAvailable],
  )

  const current = collections && scope && collections.bridge === scope.bridge && collections.generation === scope.generation
    ? collections
    : null
  let status: LiveStatus
  if (description === undefined) status = 'checking'
  else if (description === null || (configured && !validGeneration)) status = 'unavailable'
  else if (!configured) status = 'disconnected'
  else if (!current || current.state === 'loading') status = 'loading'
  else if (current.state === 'error') status = current.rejected ? 'rejected' : 'error'
  else status = 'ready'

  return {
    status,
    scope,
    projects: current?.state === 'ready' ? current.projects : NO_PROJECTS,
    sessions: current?.state === 'ready' ? named(current.sessions, currentNames) : NO_SESSIONS,
    refreshing: current?.state === 'ready' && current.refreshing,
    refresh,
    renameSession,
  }
}

function named(sessions: readonly LiveSession[], names: ConversationNames | null): readonly LiveSession[] {
  if (!names || !Object.keys(names).length) return sessions
  return sessions.map((session) => names[session.id]
    ? { ...session, title: names[session.id], locallyNamed: true }
    : session)
}
