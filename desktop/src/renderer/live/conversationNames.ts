/**
 * Local names for server conversations. The server has no rename route, so a
 * name the owner gives a conversation is kept on this computer, per server,
 * and shown instead of the server's title. It never reaches the server.
 */
const KEY_PREFIX = 'archon.reconstruction.conversationNames.v1:'
export const MAX_CONVERSATION_NAME = 120
const MAX_NAMES = 500

export type ConversationNames = Readonly<Record<string, string>>

function storageKey(serverUrl: string | null): string | null {
  return serverUrl ? `${KEY_PREFIX}${serverUrl}` : null
}

/** A single trimmed line without control characters, or null when empty. */
export function cleanConversationName(value: string): string | null {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return cleaned ? cleaned.slice(0, MAX_CONVERSATION_NAME) : null
}

export function readConversationNames(serverUrl: string | null, storage: Pick<Storage, 'getItem'> = localStorage): ConversationNames {
  const key = storageKey(serverUrl)
  if (!key) return {}
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const names: Record<string, string> = {}
    for (const [id, name] of Object.entries(parsed).slice(0, MAX_NAMES)) {
      const cleaned = typeof name === 'string' ? cleanConversationName(name) : null
      if (/^[A-Za-z0-9_-]{1,206}$/u.test(id) && cleaned) names[id] = cleaned
    }
    return names
  } catch {
    return {}
  }
}

/** Set or clear (null) one name and return the new map; storage failures keep it in memory only. */
export function writeConversationName(
  serverUrl: string | null,
  names: ConversationNames,
  sessionId: string,
  name: string | null,
  storage: Pick<Storage, 'setItem'> = localStorage,
): ConversationNames {
  const next: Record<string, string> = { ...names }
  const cleaned = name === null ? null : cleanConversationName(name)
  if (cleaned) next[sessionId] = cleaned
  else delete next[sessionId]
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_NAMES))) delete next[id]
  const key = storageKey(serverUrl)
  if (key) {
    try { storage.setItem(key, JSON.stringify(next)) } catch { /* private or full storage: keep it for this session */ }
  }
  return next
}
