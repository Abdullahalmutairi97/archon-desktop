import type { ModelCatalogResult } from '../../shared/bridge/types'
import type { LiveRuntime } from './liveModels'

/**
 * The last model chosen per runtime, kept like the shell preferences in
 * `appearance/themes.ts`: one versioned localStorage key, tolerant reads, and
 * nothing but provider and model ids (never a credential).
 */
const COMPOSER_KEY = 'archon.reconstruction.composer.v1'
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/u

/** The only provider the server's Prime runner forwards; Pi is not offered a catalog. */
export const PRIME_MODEL_PROVIDER = 'openai-codex'

export type ModelChoice = { provider: typeof PRIME_MODEL_PROVIDER; model: string }

type StoredModels = Partial<Record<LiveRuntime, { provider: string; model: string }>>

function readAll(storage: Pick<Storage, 'getItem'>): StoredModels {
  try {
    const raw = storage.getItem(COMPOSER_KEY)
    if (!raw) return {}
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return {}
    const models = (value as { models?: unknown }).models
    if (!models || typeof models !== 'object') return {}
    const result: StoredModels = {}
    for (const runtime of ['prime', 'pi'] as const) {
      const entry = (models as Record<string, unknown>)[runtime]
      if (entry && typeof entry === 'object') {
        const { provider, model } = entry as { provider?: unknown; model?: unknown }
        if (typeof provider === 'string' && PROVIDER_ID.test(provider) && typeof model === 'string' && MODEL_ID.test(model)) {
          result[runtime] = { provider, model }
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

export function readLastModel(runtime: LiveRuntime, storage: Pick<Storage, 'getItem'> = localStorage): { provider: string; model: string } | null {
  return readAll(storage)[runtime] ?? null
}

/** `null` records "use the server default" by forgetting the runtime's choice. */
export function saveLastModel(
  runtime: LiveRuntime,
  choice: ModelChoice | null,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): void {
  try {
    const models = readAll(storage)
    if (choice) models[runtime] = { provider: choice.provider, model: choice.model }
    else delete models[runtime]
    storage.setItem(COMPOSER_KEY, JSON.stringify({ models }))
  } catch { /* preview may run with storage disabled */ }
}

/**
 * Models a runtime will really run. Prime forwards only `openai-codex` models
 * from the server catalog; Pi and checkout conversations get no choices.
 */
export function modelChoicesFor(runtime: LiveRuntime | null, catalog: ModelCatalogResult | null): ModelChoice[] {
  if (runtime !== 'prime' || !catalog) return []
  const provider = catalog.providers.find((item) => item.id === PRIME_MODEL_PROVIDER)
  return provider ? provider.models.map((model) => ({ provider: PRIME_MODEL_PROVIDER, model })) : []
}

/** The remembered choice when the catalog still offers it; otherwise the server default. */
export function rememberedChoice(runtime: LiveRuntime | null, choices: readonly ModelChoice[]): ModelChoice | null {
  if (!runtime) return null
  const stored = readLastModel(runtime)
  return stored ? choices.find((choice) => choice.provider === stored.provider && choice.model === stored.model) ?? null : null
}
