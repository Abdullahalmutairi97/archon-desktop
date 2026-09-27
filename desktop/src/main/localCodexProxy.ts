/** Main-process-only operations accepted by the local owner proxy. */
export type LocalCodexProxyRequest =
  | { operation: 'projects.list' }
  | { operation: 'sessions.list'; projectId: string }
  | { operation: 'workspaces.register'; rootPath: string }
  | { operation: 'turns.start'; projectId: string; prompt: string; sessionId?: string }
  | { operation: 'turns.cancel'; taskId: string }
  | { operation: 'turns.list'; limit: number }
  | { operation: 'turns.status'; taskId: string }
  | { operation: 'approvals.answer'; approvalId: string; allow: boolean }
  | { operation: 'events.list'; after: number; limit: number }
  | { operation: 'workspace.terminals.list'; workspaceId: string }
  | { operation: 'workspace.terminals.create'; workspaceId: string; expectedGeneration: number }
  | { operation: 'workspace.terminals.screen'; workspaceId: string; sessionId: string; lines: number }
  | { operation: 'workspace.terminals.input'; workspaceId: string; sessionId: string; line: string }
  | { operation: 'workspace.terminals.interrupt'; workspaceId: string; sessionId: string }
  | { operation: 'workspace.terminals.stop'; workspaceId: string; sessionId: string }

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
