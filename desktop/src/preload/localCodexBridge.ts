import type { LocalCodexBridge, LocalCodexEvent } from '../shared/bridge/types'
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
    registerProject: () => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['registerProject']>>>(
      ipc, LOCAL_CODEX_CHANNELS.registerProject, [],
    ),
    startTurn: (input: Parameters<LocalCodexBridge['startTurn']>[0]) => invokeLocalCodex<Awaited<ReturnType<LocalCodexBridge['startTurn']>>>(
      ipc, LOCAL_CODEX_CHANNELS.startTurn, [input],
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
