import type { LocalCodexBridge, LocalCodexEvent, LocalCodexTurnStatusDto } from '../shared/bridge/types'
import {
  LOCAL_CODEX_CHANNELS,
  parseLocalCodexEvent,
  parseLocalCodexRequest,
  parseLocalCodexResponse,
} from '../shared/bridge/validation'

export interface LocalCodexIpcInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

function invokeLocalCodex<T>(
  ipc: LocalCodexIpcInvoker,
  channel: string,
  args: readonly unknown[],
): Promise<T> {
  const request = parseLocalCodexRequest(channel, args)
  return ipc.invoke(request.channel, ...request.args)
    .then((value) => parseLocalCodexResponse(request.channel, value) as T)
}

/** Build the fixed, renderer-safe local Codex API. */
export function createLocalCodexBridge(ipc: LocalCodexIpcInvoker): LocalCodexBridge {
  const localCodex = Object.freeze({
    listProjects: () => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['listProjects']>>>(
      ipc, LOCAL_CODEX_CHANNELS.listProjects, [],
    ),
    listSessions: (projectId: string) => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['listSessions']>>>(
      ipc, LOCAL_CODEX_CHANNELS.listSessions, [{ projectId }],
    ),
    registerProject: () => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['registerProject']>>>(
      ipc, LOCAL_CODEX_CHANNELS.registerProject, [],
    ),
    registerWorkspace: (input: Parameters<LocalCodexBridge['registerWorkspace']>[0]) => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['registerWorkspace']>>>(
      ipc, LOCAL_CODEX_CHANNELS.registerWorkspace, [input],
    ),
    startTurn: (input: Parameters<LocalCodexBridge['startTurn']>[0]) => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['startTurn']>>>(
      ipc, LOCAL_CODEX_CHANNELS.startTurn, [input],
    ),
    getLatestTurnStatus: () => invokeLocalCodex<LocalCodexTurnStatusDto | null>(
      ipc, LOCAL_CODEX_CHANNELS.latestTurnStatus, [],
    ),
    getTurnStatus: (input: Parameters<NonNullable<LocalCodexBridge['getTurnStatus']>>[0]) => invokeLocalCodex<LocalCodexTurnStatusDto>(
      ipc, LOCAL_CODEX_CHANNELS.turnStatus, [input],
    ),
    cancelTurn: (input: Parameters<LocalCodexBridge['cancelTurn']>[0]) => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['cancelTurn']>>>(
      ipc, LOCAL_CODEX_CHANNELS.cancelTurn, [input],
    ),
    answerApproval: (input: Parameters<LocalCodexBridge['answerApproval']>[0]) => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['answerApproval']>>>(
      ipc, LOCAL_CODEX_CHANNELS.answerApproval, [input],
    ),
    subscribe: (listener: (event: LocalCodexEvent) => void): (() => void) => {
      if (typeof listener !== 'function' || !ipc.on || !ipc.removeListener) {
        throw new TypeError('Local Codex event subscription is unavailable.')
      }
      const onEvent = (_event: unknown, ...args: unknown[]) => {
        if (args.length !== 1) return
        let safeEvent: LocalCodexEvent
        try {
          safeEvent = parseLocalCodexEvent(args[0])
        } catch {
          return
        }
        listener(safeEvent)
      }
      ipc.on(LOCAL_CODEX_CHANNELS.event, onEvent)
      let active = true
      return () => {
        if (!active) return
        active = false
        ipc.removeListener?.(LOCAL_CODEX_CHANNELS.event, onEvent)
      }
    },
  }) satisfies LocalCodexBridge
  return localCodex
}
