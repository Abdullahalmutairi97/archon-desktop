import { describe, expect, it } from 'vitest'
import { documentKeyId, executionScopeId, makeDocumentKey, sameExecutionScope } from '../../shared/domain/identity'
import { queueCounts } from '../../shared/domain/queue'
import { FIXTURE_PROJECTS, FIXTURE_SESSIONS, FIXTURE_TASKS, runtimeLabel } from './fixtures'

describe('synthetic runtime fixtures', () => {
  it('keeps server Prime, server Pi, and this-PC Codex identities distinct', () => {
    const [prime, pi, codex] = FIXTURE_SESSIONS
    expect(runtimeLabel(prime.scope.runtime)).toContain('Server fixture')
    expect(runtimeLabel(pi.scope.runtime)).toContain('Pi')
    expect(runtimeLabel(codex.scope.runtime)).toContain('THIS PC')
    expect(sameExecutionScope(prime.scope, pi.scope)).toBe(false)
    expect(prime.scope.connectionId).toBe(pi.scope.connectionId)
    expect(codex.scope.connectionId).not.toBe(prime.scope.connectionId)
    expect(new Set(FIXTURE_SESSIONS.map((session) => executionScopeId(session.scope))).size).toBe(3)
    expect(FIXTURE_PROJECTS.map((project) => project.runtime)).toEqual(['prime', 'pi', 'codex'])
  })

  it('uses full scope plus path for synthetic document identity', () => {
    const [prime, pi] = FIXTURE_SESSIONS
    const primeKey = makeDocumentKey(prime.scope, 'README.md')
    const piKey = makeDocumentKey(pi.scope, 'README.md')
    expect(documentKeyId(primeKey)).not.toBe(documentKeyId(piKey))
  })

  it('counts active and queued fixtures separately from review-required outcomes', () => {
    expect(queueCounts(FIXTURE_TASKS)).toEqual({ running: 1, queued: 1 })
    expect(FIXTURE_TASKS.find((task) => task.recoveryState === 'review_required')?.status).toBe('interrupted')
  })
})
