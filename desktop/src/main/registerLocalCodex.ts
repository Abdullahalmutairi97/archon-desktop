import type { LocalCodexEvent, LocalCodexProjectDto, LocalCodexSessionDto, LocalCodexTurnDto } from '../shared/bridge/types'
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
  listSessions(projectId: string): Promise<readonly LocalCodexSessionDto[]>
  registerProject(): Promise<LocalCodexProjectDto | null>
  registerWorkspaceRoot(rootPath: string): Promise<LocalCodexProjectDto>
  startTurn(input: { projectId: string; prompt: string; sessionId?: string }): Promise<LocalCodexTurnDto>
  cancelTurn(input: { taskId: string }): Promise<boolean>
  answerApproval(input: { approvalId: string; allow: boolean }): boolean | Promise<boolean>
  subscribe(listener: (event: LocalCodexEvent) => void): () => void
}

export interface RegisterLocalCodexOptions {
  ipc: IpcRegistrar
  guard(event: unknown): boolean | void
  trustedFrame: Pick<TrustedShellFrameGuard, 'assertTrusted'>
  controller: LocalCodexIpcController
  /** Resolves an owner-scoped server identity over the active local pairing; never supplied by the renderer. */
  getWorkspaceRoot(workspaceId: string): Promise<string>
  getWindow(): LocalCodexWindowLike | undefined
}

const LOCAL_CODEX_INVOKE_CHANNELS = Object.freeze([
  LOCAL_CODEX_CHANNELS.listProjects,
  LOCAL_CODEX_CHANNELS.listSessions,
  LOCAL_CODEX_CHANNELS.registerProject,
  LOCAL_CODEX_CHANNELS.registerWorkspace,
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
          case LOCAL_CODEX_CHANNELS.listSessions:
            result = await options.controller.listSessions((request.args[0] as { projectId: string }).projectId)
            break
          case LOCAL_CODEX_CHANNELS.registerProject:
            result = await options.controller.registerProject()
            break
          case LOCAL_CODEX_CHANNELS.registerWorkspace: {
            const { workspaceId } = request.args[0] as { workspaceId: string }
            const rootPath = await options.getWorkspaceRoot(workspaceId)
            result = await options.controller.registerWorkspaceRoot(rootPath)
            break
          }
          case LOCAL_CODEX_CHANNELS.startTurn:
            result = await options.controller.startTurn(request.args[0] as { projectId: string; prompt: string; sessionId?: string })
            break
          case LOCAL_CODEX_CHANNELS.cancelTurn:
            result = await options.controller.cancelTurn(request.args[0] as { taskId: string })
            break
          case LOCAL_CODEX_CHANNELS.answerApproval:
            result = await options.controller.answerApproval(request.args[0] as { approvalId: string; allow: boolean })
            break
        }
      } catch {
        assertTrusted(options.guard, event)
        throw new Error(request.channel === LOCAL_CODEX_CHANNELS.startTurn
          ? 'Local Codex could not confirm the turn start. Check the conversation list before starting another turn.'
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
