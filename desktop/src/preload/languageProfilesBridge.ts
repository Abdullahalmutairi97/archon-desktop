import type { LanguageProfilesBridge, LanguageProfilesDto } from '../shared/bridge/types'
import { LANGUAGE_PROFILES_CHANNELS, parseLanguageProfilesRequest, parseLanguageProfilesResponse } from '../shared/bridge/validation'
import type { LocalCodexIpcInvoker } from './localCodexBridge'

function invoke(ipc: LocalCodexIpcInvoker, input: unknown): Promise<LanguageProfilesDto> {
  const request = parseLanguageProfilesRequest(LANGUAGE_PROFILES_CHANNELS.list, [input])
  return ipc.invoke(LANGUAGE_PROFILES_CHANNELS.list, request)
    .then((value) => parseLanguageProfilesResponse(LANGUAGE_PROFILES_CHANNELS.list, value) as LanguageProfilesDto)
}

/** Read-only surface: it reports pinned artefacts and known gaps, never a value. */
export function createLanguageProfilesBridge(ipc: LocalCodexIpcInvoker): LanguageProfilesBridge {
  return Object.freeze({
    list: (input: Parameters<LanguageProfilesBridge['list']>[0]) => invoke(ipc, input),
  }) satisfies LanguageProfilesBridge
}
