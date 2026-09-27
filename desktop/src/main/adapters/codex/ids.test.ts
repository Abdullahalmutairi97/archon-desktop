import { describe, expect, it } from 'vitest'
import {
  fromCodexSessionId,
  isCodexProjectId,
  isCodexSessionId,
  isCodexTaskId,
  makeCodexProjectId,
  makeCodexTaskId,
  toCodexSessionId,
} from './ids'

describe('local Codex identity namespaces', () => {
  it('keeps Codex thread, project, and task ids in distinct prefixes', () => {
    expect(toCodexSessionId('thread-a')).toBe('codex:thread-a')
    expect(fromCodexSessionId('codex:thread-a')).toBe('thread-a')
    expect(makeCodexProjectId('p-1')).toBe('codex-project:p-1')
    expect(makeCodexTaskId('t-1')).toBe('codex-task:t-1')
    expect(isCodexSessionId('codex:thread-a')).toBe(true)
    expect(isCodexProjectId('codex:thread-a')).toBe(false)
    expect(isCodexTaskId('codex-project:p-1')).toBe(false)
  })

  it('rejects empty, oversized, control-character, and cross-namespace ids', () => {
    expect(() => toCodexSessionId('')).toThrow()
    expect(() => toCodexSessionId('thread\0a')).toThrow()
    expect(() => makeCodexProjectId('x'.repeat(300))).toThrow()
    expect(() => fromCodexSessionId('codex-project:p1')).toThrow()
    expect(isCodexTaskId('codex-task:')).toBe(false)
  })
})
