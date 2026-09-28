/**
 * Runtime compatibility: the one place the desktop turns a runtime manifest and a
 * provider authentication state into what a person may choose.
 *
 * The rules are deliberately pessimistic. A runtime that reports itself available
 * still proves nothing about authentication, provider access or a native session,
 * so an absent or unverified authentication state never renders as ready. Every
 * capability the server publishes has a row here, and a test fails if a new
 * manifest key is not covered, so a capability cannot quietly disappear from the
 * interface.
 */

export interface RuntimeManifestRecord {
  readonly id: string
  readonly available?: boolean
  readonly availability_check?: string
  readonly executable_digest?: string | null
  readonly version?: string | null
  readonly version_verified?: boolean
  readonly manifest_version?: number
  readonly capabilities?: Readonly<Record<string, unknown>>
  readonly modes?: readonly { readonly id: string; readonly label: string; readonly restricted: boolean }[]
  readonly availability_note?: string
  readonly sandboxed?: boolean
  readonly chat_only?: boolean
  readonly [key: string]: unknown
}

export interface ProviderAuthState {
  readonly provider: string
  readonly state: 'unavailable' | 'unverified' | 'verified'
  readonly references: number
  readonly lastFailureReason: string | null
}

export interface RuntimeCompatibilityRow {
  readonly id: string
  readonly state: 'ready' | 'unverified' | 'unavailable'
  readonly heading: string
  readonly reason: string
  readonly facts: readonly { readonly key: string; readonly label: string; readonly value: string }[]
  readonly capabilities: readonly { readonly key: string; readonly label: string; readonly value: string }[]
}

/** Every manifest key this build presents, keyed by the manifest's own name. */
export const RUNTIME_CAPABILITY_FIELDS = Object.freeze([
  { key: 'modalities', label: 'Modalities', format: 'list' },
  { key: 'resume', label: 'Resume', format: 'flag' },
  { key: 'fork', label: 'Fork', format: 'flag' },
  { key: 'steer', label: 'Steer', format: 'flag' },
  { key: 'approval', label: 'Approval', format: 'flag' },
  { key: 'read_only', label: 'Read-only', format: 'flag' },
  { key: 'chat_only', label: 'Chat-only', format: 'flag' },
  { key: 'reconnect', label: 'Reconnect', format: 'text' },
  { key: 'resource_formats', label: 'Resource formats', format: 'list' },
  { key: 'transports', label: 'Transports', format: 'list' },
] as const)

export const RUNTIME_IDENTITY_FIELDS = Object.freeze([
  { key: 'available', label: 'Executable' },
  { key: 'availability_check', label: 'Availability check' },
  { key: 'version', label: 'Declared version' },
  { key: 'version_verified', label: 'Version verified' },
  { key: 'executable_digest', label: 'Executable digest' },
  { key: 'manifest_version', label: 'Manifest version' },
  { key: 'sandboxed', label: 'Sandboxed' },
] as const)

function formatValue(value: unknown, format: 'list' | 'flag' | 'text'): string {
  if (format === 'list') {
    if (!Array.isArray(value) || value.length === 0) return 'none declared'
    return value.map((item) => String(item)).join(', ')
  }
  if (format === 'flag') {
    // A capability the server does not claim is unsupported, and says so.
    if (value === true) return 'supported'
    if (value === false) return 'unsupported'
    return 'not declared'
  }
  if (typeof value === 'string' && value.length > 0) return value
  if (value === null || value === undefined) return 'not declared'
  return String(value)
}

/**
 * Describe what may be chosen for one runtime.
 *
 * `authState` is the matching provider authentication state, or null when the
 * server reports none: either way a runtime without a verified state is only
 * "unverified", never ready.
 */
export function describeRuntimeCompatibility(
  runtimes: readonly RuntimeManifestRecord[],
  authStates: readonly ProviderAuthState[],
  providersForRuntime: Readonly<Record<string, string>> = { prime: 'prime', pi: 'pi' },
): readonly RuntimeCompatibilityRow[] {
  return runtimes.map((runtime) => {
    const provider = providersForRuntime[runtime.id] ?? runtime.id
    const auth = authStates.find((state) => state.provider === provider) ?? null
    const capabilities = runtime.capabilities ?? {}
    const facts = RUNTIME_IDENTITY_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      value: formatValue((runtime as Record<string, unknown>)[field.key], 'text'),
    }))
    const capabilityRows = RUNTIME_CAPABILITY_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      value: formatValue(capabilities[field.key], field.format),
    }))
    const heading = runtime.version && typeof runtime.version === 'string'
      ? `${runtime.id} ${runtime.version}`
      : runtime.id

    if (runtime.available === false) {
      return Object.freeze({
        id: runtime.id, state: 'unavailable' as const, heading,
        reason: 'The configured executable is not an executable file on this server.',
        facts: Object.freeze(facts), capabilities: Object.freeze(capabilityRows),
      })
    }
    if (runtime.version_verified !== true) {
      return Object.freeze({
        id: runtime.id, state: 'unverified' as const, heading,
        reason: 'The version is declared by the adapter, not verified against the executable.',
        facts: Object.freeze(facts), capabilities: Object.freeze(capabilityRows),
      })
    }
    if (auth === null || auth.state !== 'verified') {
      const detail = auth === null
        ? 'no authentication state is registered for this provider'
        : auth.state === 'unavailable'
          ? 'the referenced credential is absent'
          : 'no brokered call has succeeded from this host yet'
      return Object.freeze({
        id: runtime.id, state: 'unverified' as const, heading,
        reason: `Authentication is unverified: ${detail}.`,
        facts: Object.freeze(facts), capabilities: Object.freeze(capabilityRows),
      })
    }
    return Object.freeze({
      id: runtime.id, state: 'ready' as const, heading,
      reason: 'The executable, its declared version and one brokered provider call were observed on this host.',
      facts: Object.freeze(facts), capabilities: Object.freeze(capabilityRows),
    })
  })
}
