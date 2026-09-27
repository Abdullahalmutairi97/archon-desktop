import { randomUUID } from 'node:crypto'

export const CODEX_ID_PREFIX = Object.freeze({
  session: 'codex:',
  project: 'codex-project:',
  task: 'codex-task:',
} as const)

const MAX_LOCAL_ID_COMPONENT_LENGTH = 240
const SAFE_ID_COMPONENT = /^[A-Za-z0-9._:-]+$/

function validComponent(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_LOCAL_ID_COMPONENT_LENGTH
    && SAFE_ID_COMPONENT.test(value)
}

function requireComponent(value: string): string {
  if (!validComponent(value)) throw new TypeError('Invalid local Codex identity component.')
  return value
}

function isNamespacedId(value: unknown, prefix: string): value is string {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false
  return validComponent(value.slice(prefix.length))
}

export function toCodexSessionId(threadId: string): string {
  return `${CODEX_ID_PREFIX.session}${requireComponent(threadId)}`
}

export function fromCodexSessionId(sessionId: string): string {
  if (!isCodexSessionId(sessionId)) throw new TypeError('Not an Archon-owned Codex session id.')
  return sessionId.slice(CODEX_ID_PREFIX.session.length)
}

export function isCodexSessionId(value: unknown): value is string {
  return isNamespacedId(value, CODEX_ID_PREFIX.session)
}

export function makeCodexProjectId(suffix: string = randomUUID()): string {
  return `${CODEX_ID_PREFIX.project}${requireComponent(suffix)}`
}

export function isCodexProjectId(value: unknown): value is string {
  return isNamespacedId(value, CODEX_ID_PREFIX.project)
}

export function makeCodexTaskId(suffix: string = randomUUID()): string {
  return `${CODEX_ID_PREFIX.task}${requireComponent(suffix)}`
}

export function isCodexTaskId(value: unknown): value is string {
  return isNamespacedId(value, CODEX_ID_PREFIX.task)
}
