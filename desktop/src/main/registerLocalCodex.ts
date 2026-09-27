import type { LocalCodexEvent, LocalCodexProjectDto, LocalCodexTurnDto } from '../shared/bridge/types'
import {
  LOCAL_CODEX_CHANNELS,
  parseLocalCodexEvent,
  parseLocalCodexRequest,
  parseLocalCodexResponse,
} from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import type { TrustedShellFrameGuard, TrustedShellIpcEvent, ShellFrameLike, ShellWebContentsLike } from './security/TrustedShellFrameGuard'
import { assertBoundedIpcPayload } from './security/TrustedShellFrameGuard'

export interface LocalCodexWindowLike {
  isDestroyed(): boolean
  webContents: ShellWebContentsLike & {
    mainFrame: ShellFrameLike
    send(channel: string, ...args: unknown[]): void
  }
}

export interface LocalCodexIpcController {
  listProjects(): Promise<readonly LocalCodexProjectDto[]>
  registerProject(): Promise<LocalCodexProjectDto | null>
  startTurn(input: { projectId: string; prompt: string }): Promise<LocalCodexTurnDto>
  cancelTurn(input: { taskId: string }): Promise<boolean>
  answerApproval(input: { approvalId: string; allow: boolean }): boolean
  subscribe(listener: (event: LocalCodexEvent) => void): () => void
}

export interface RegisterLocalCodexOptions {
  ipc: IpcRegistrar
  guard(event: unknown): boolean | void
  trustedFrame: Pick<TrustedShellFrameGuard, 'assertTrusted'>
  controller: LocalCodexIpcController
  getWindow(): LocalCodexWindowLike | undefined
}

const LOCAL_CODEX_INVOKE_CHANNELS = Object.freeze([
  LOCAL_CODEX_CHANNELS.listProjects,
  LOCAL_CODEX_CHANNELS.registerProject,
  LOCAL_CODEX_CHANNELS.startTurn,
  LOCAL_CODEX_CHANNELS.cancelTurn,
  LOCAL_CODEX_CHANNELS.answerApproval,
] as const)

function assertTrusted(guard: RegisterLocalCodexOptions['guard'], event: unknown): void {
  if (guard(event) === false) throw new Error('Untrusted desktop frame')
}

export function registerLocalCodex(options: RegisterLocalCodexOptions): () => void {
  const stopEvents = options.controller.subscribe((event) => {
    let safeEvent: LocalCodexEvent
    try {
      safeEvent = parseLocalCodexEvent(event)
      assertBoundedIpcPayload(safeEvent)
    } catch {
      return
    }
    const window = options.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    try {
      options.trustedFrame.assertTrusted({
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
      } satisfies TrustedShellIpcEvent)
      window.webContents.send(LOCAL_CODEX_CHANNELS.event, safeEvent)
    } catch {
      // A stale, navigating, or destroyed window must not receive task or approval data.
    }
  })

  for (const channel of LOCAL_CODEX_INVOKE_CHANNELS) {
    options.ipc.handle(channel, async (event, ...args) => {
      assertTrusted(options.guard, event)
      assertBoundedIpcPayload(args)
      const request = parseLocalCodexRequest(channel, args)
      let result: unknown
      try {
        switch (request.channel) {
          case LOCAL_CODEX_CHANNELS.listProjects:
            result = await options.controller.listProjects()
            break
          case LOCAL_CODEX_CHANNELS.registerProject:
            result = await options.controller.registerProject()
            break
          case LOCAL_CODEX_CHANNELS.startTurn:
            result = await options.controller.startTurn(request.args[0] as { projectId: string; prompt: string })
            break
          case LOCAL_CODEX_CHANNELS.cancelTurn:
            result = await options.controller.cancelTurn(request.args[0] as { taskId: string })
            break
          case LOCAL_CODEX_CHANNELS.answerApproval:
            result = options.controller.answerApproval(request.args[0] as { approvalId: string; allow: boolean })
            break
        }
      } catch {
        assertTrusted(options.guard, event)
        throw new Error(request.channel === LOCAL_CODEX_CHANNELS.startTurn
          ? 'Local Codex could not start. Check that Codex is installed and signed in, then try again.'
          : 'Local Codex request failed.')
      }
      assertTrusted(options.guard, event)
      assertBoundedIpcPayload(result)
      return parseLocalCodexResponse(request.channel, result)
    })
  }

  return () => {
    stopEvents()
    for (const channel of LOCAL_CODEX_INVOKE_CHANNELS) options.ipc.removeHandler(channel)
  }
}
