import type { LocalCodexProxyRequest } from './localCodexProxy'
import { LANGUAGE_PROFILES_CHANNELS, parseLanguageProfilesBackendResponse, parseLanguageProfilesRequest } from '../shared/bridge/validation'
import type { IpcRegistrar } from './registerBridge'
import { assertBoundedIpcPayload } from './security/TrustedShellFrameGuard'

export interface RegisterLanguageProfilesOptions {
  ipc: IpcRegistrar
  guard(event: unknown): boolean | void
  invokePairedLocalCodex(request: LocalCodexProxyRequest): Promise<unknown>
}

const channels = Object.freeze(Object.values(LANGUAGE_PROFILES_CHANNELS))

function assertTrusted(guard: RegisterLanguageProfilesOptions['guard'], event: unknown): void {
  if (guard(event) === false) throw new Error('Untrusted desktop frame')
}

/** Fixed main-process IPC surface for the read-only language-profile report. */
export function registerLanguageProfiles(options: RegisterLanguageProfilesOptions): () => void {
  for (const channel of channels) {
    options.ipc.handle(channel, async (event, ...args) => {
      assertTrusted(options.guard, event)
      assertBoundedIpcPayload(args)
      const input = parseLanguageProfilesRequest(channel, args)
      try {
        const response = await options.invokePairedLocalCodex({
          operation: 'workspace.languageProfiles.list',
          workspaceId: input.workspaceId,
        })
        assertTrusted(options.guard, event)
        assertBoundedIpcPayload(response)
        return parseLanguageProfilesBackendResponse(channel, response)
      } catch {
        assertTrusted(options.guard, event)
        // Never leak backend paths, digests or errors through IPC errors.
        throw new Error('Language profile report is unavailable. Refresh after the backend is reachable; the app will not retry automatically.')
      }
    })
  }
  return () => { for (const channel of channels) options.ipc.removeHandler(channel) }
}
