/** Main-process-only operations accepted by the local owner proxy. */
import type { WorkspaceConsoleKeyEvent, WorkspaceServiceDefinitionInput } from '../shared/bridge/types'

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
  | { operation: 'workspace.terminals.attach.open'; workspaceId: string; sessionId: string; expectedGeneration: number; mode: 'control' | 'read-only' }
  | { operation: 'workspace.terminals.attach.claim'; workspaceId: string; sessionId: string; ticket: string }
  | { operation: 'workspace.terminals.attach.screen'; workspaceId: string; sessionId: string; attachId: string; lines: number }
  | { operation: 'workspace.terminals.attach.input'; workspaceId: string; sessionId: string; attachId: string; events: readonly WorkspaceConsoleKeyEvent[] }
  | { operation: 'workspace.terminals.attach.detach'; workspaceId: string; sessionId: string; attachId: string }
  | { operation: 'workspace.services.list'; workspaceId: string }
  | { operation: 'workspace.services.define'; workspaceId: string; definition: WorkspaceServiceDefinitionInput }
  | { operation: 'workspace.services.remove'; workspaceId: string; name: string; confirm: boolean }
  | { operation: 'workspace.services.start'; workspaceId: string; name: string }
  | { operation: 'workspace.services.stop'; workspaceId: string; name: string; confirm: boolean }
  | { operation: 'workspace.services.logs'; workspaceId: string; name: string; lines: number }
  | { operation: 'workspace.services.preview.open'; workspaceId: string; name: string; expectedGeneration: number; portName: string | null }

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
