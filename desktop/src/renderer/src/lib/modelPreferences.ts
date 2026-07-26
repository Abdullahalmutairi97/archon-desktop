import type { ModelCatalog } from './types'

export type ModelRef = { provider: string; model: string }
const STORAGE_KEY = 'archon.chatModels'
const CHANGE_EVENT = 'archon:model-pins-changed'

export function modelKey(value: ModelRef): string { return `${value.provider}\u0000${value.model}` }
export function modelFromKey(value: string): ModelRef | undefined {
  const separator = value.indexOf('\u0000')
  if (separator < 1 || separator === value.length - 1) return undefined
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) }
}

function availableKeys(catalog?: ModelCatalog): Set<string> {
  return new Set((catalog?.providers || []).flatMap((provider) => provider.models.map((model) => modelKey({ provider: provider.id, model }))))
}

export function readPinnedModels(catalog?: ModelCatalog): ModelRef[] {
  const available = availableKeys(catalog)
  let values: string[] = []
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (Array.isArray(parsed)) values = parsed.filter((value): value is string => typeof value === 'string')
  } catch { values = [] }
  const decoded = values.map(modelFromKey)
  const valid = decoded.filter((value): value is ModelRef => value !== undefined && available.has(modelKey(value)))
  if (valid.length || !catalog?.current.provider || !catalog.current.model) return valid
  const current = { provider: catalog.current.provider, model: catalog.current.model }
  return available.has(modelKey(current)) ? [current] : []
}

export function writePinnedModels(values: ModelRef[]): void {
  const unique = Array.from(new Map(values.map((value) => [modelKey(value), value])).values()).slice(0, 24)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(unique.map(modelKey)))
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

export function togglePinnedModel(value: ModelRef, catalog?: ModelCatalog): ModelRef[] {
  const current = readPinnedModels(catalog)
  const key = modelKey(value)
  const next = current.some((item) => modelKey(item) === key) ? current.filter((item) => modelKey(item) !== key) : [...current, value]
  writePinnedModels(next)
  return next
}

export function onPinnedModelsChange(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}
