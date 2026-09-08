export type ConnectionInput = { serverUrl: string; token: string }

export function normalizeConnection(value: ConnectionInput): ConnectionInput {
  return { serverUrl: value.serverUrl.trim().replace(/\/+$/, ''), token: value.token.trim() }
}
