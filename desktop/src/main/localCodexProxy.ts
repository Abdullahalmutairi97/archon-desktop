/** Main-process-only operations accepted by the local owner proxy. */
export type LocalCodexProxyRequest =
  | { operation: 'projects.list' }
  | { operation: 'sessions.list'; projectId: string }
  | { operation: 'workspaces.register'; rootPath: string }
  | { operation: 'turns.start'; projectId: string; prompt: string; sessionId?: string }
  | { operation: 'turns.cancel'; taskId: string }
  | { operation: 'approvals.answer'; approvalId: string; allow: boolean }
  | { operation: 'events.list'; after: number; limit: number }

export interface LocalCodexProxyEventRecord {
  seq: number
  event: unknown
}

export interface LocalCodexProxyEventBatch {
  cursor: number
  latest: number
  oldest: number
  reset: boolean
  events: readonly LocalCodexProxyEventRecord[]
}
