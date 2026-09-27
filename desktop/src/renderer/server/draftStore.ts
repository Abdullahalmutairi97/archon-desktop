/**
 * Bounded, local persistence for the small-file editor's unsaved drafts.
 *
 * Only file text is stored, never credentials or connection data. Drafts are
 * capped per file and in total, evicted oldest-first, and cleared on save or
 * discard. Storage failures degrade to no persistence rather than breaking the
 * editor.
 */
const STORAGE_KEY = 'archon.reconstruction.drafts.v1'
const MAX_DRAFTS = 8
const MAX_DRAFT_BYTES = 16 * 1024
const MAX_TOTAL_BYTES = 128 * 1024

interface DraftEntry {
  content: string
  savedAt: number
}

type DraftMap = Record<string, Record<string, DraftEntry>>

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function load(): DraftMap {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as DraftMap
  } catch {
    return {}
  }
}

function persist(map: DraftMap): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // A full or unavailable store must not break editing.
  }
}

export function readDraft(workspaceId: string, path: string): string | null {
  if (!workspaceId || !path) return null
  const entry = load()[workspaceId]?.[path]
  return entry && typeof entry.content === 'string' ? entry.content : null
}

export function writeDraft(workspaceId: string, path: string, content: string): void {
  if (!workspaceId || !path) return
  if (byteLength(content) > MAX_DRAFT_BYTES) return
  const map = load()
  const workspace = map[workspaceId] ?? {}
  workspace[path] = { content, savedAt: Date.now() }
  map[workspaceId] = workspace
  const entries: { workspaceId: string; path: string; savedAt: number; bytes: number }[] = []
  for (const [w, paths] of Object.entries(map)) {
    for (const [p, entry] of Object.entries(paths)) {
      entries.push({ workspaceId: w, path: p, savedAt: entry.savedAt, bytes: byteLength(entry.content) })
    }
  }
  entries.sort((left, right) => left.savedAt - right.savedAt)
  while (entries.length > MAX_DRAFTS || entries.reduce((total, entry) => total + entry.bytes, 0) > MAX_TOTAL_BYTES) {
    const victim = entries.shift()
    if (!victim) break
    delete map[victim.workspaceId]?.[victim.path]
    if (map[victim.workspaceId] && Object.keys(map[victim.workspaceId]).length === 0) delete map[victim.workspaceId]
  }
  persist(map)
}

export function clearDraft(workspaceId: string, path: string): void {
  const map = load()
  if (!map[workspaceId]?.[path]) return
  delete map[workspaceId][path]
  if (Object.keys(map[workspaceId]).length === 0) delete map[workspaceId]
  persist(map)
}
