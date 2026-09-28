import type { DesktopBridge } from '../../shared/bridge/types'
import type { WorkspaceReadOnlyFilePort } from './WorkspaceFileBrowser'

/** The checkout file operations a file browser uses, bound to one desktop bridge. */
export function workspaceFilePort(bridge: DesktopBridge): WorkspaceReadOnlyFilePort {
  return {
    list: (workspaceId, path, limit) => bridge.api.invoke('workspaces.files.list', { workspaceId, path, limit }),
    read: (workspaceId, path, maxBytes) => bridge.api.invoke('workspaces.files.read', { workspaceId, path, maxBytes }),
    search: (workspaceId, query) => bridge.api.invoke('workspaces.files.search', { workspaceId, query }),
    write: (workspaceId, path, expectedContent, content) => bridge.api.invoke('workspaces.files.write', {
      workspaceId, path, expectedContent, content,
    }),
    create: (workspaceId, path, content) => bridge.api.invoke('workspaces.files.create', {
      workspaceId, path, content,
    }),
    diff: (workspaceId, path) => bridge.api.invoke('workspaces.files.diff', { workspaceId, path }),
  }
}
