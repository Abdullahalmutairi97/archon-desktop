import { CodexAppServerClient } from './appServer'
import type { CodexAppServerClientOptions } from './appServer'
import {
  CodexApprovalBroker,
  createCodexApprovalHooks,
} from './approvalBroker'
import type {
  CodexApprovalBrokerOptions,
  ResolvedCodexApprovalContext,
} from './approvalBroker'
import { OwnedCodexMetadataStore } from './metadata'
import { CodexOwnedFileService } from './pathAccess'

export * from './appServer'
export * from './approvalBroker'
export * from './ids'
export * from './metadata'
export * from './pathAccess'

export interface CodexAdapterCoreOptions {
  profileDirectory: string
  appServer: Omit<CodexAppServerClientOptions, 'onProcessStart' | 'onDisconnect' | 'onServerRequest'>
  approvals: Omit<CodexApprovalBrokerOptions, 'onPrompt' | 'isTaskActive'> & {
    onPrompt: CodexApprovalBrokerOptions['onPrompt']
    isTaskActive: CodexApprovalBrokerOptions['isTaskActive']
    resolveContext: (request: Parameters<NonNullable<CodexAppServerClientOptions['onServerRequest']>>[0]) => ResolvedCodexApprovalContext | undefined
  }
}

export interface CodexAdapterCore {
  metadata: OwnedCodexMetadataStore
  files: CodexOwnedFileService
  approvals: CodexApprovalBroker
  appServer: CodexAppServerClient
  close(): void
}

/**
 * Compose the injected-profile adapter core. No Codex process is started until
 * `appServer.request()` is called, and all process creation is injected for
 * fixture testing and main-process ownership.
 */
export async function createCodexAdapterCore(options: CodexAdapterCoreOptions): Promise<CodexAdapterCore> {
  const metadata = new OwnedCodexMetadataStore(options.profileDirectory)
  await metadata.load()
  const files = new CodexOwnedFileService(metadata)
  const approvals = new CodexApprovalBroker({
    timeoutMs: options.approvals.timeoutMs,
    onPrompt: options.approvals.onPrompt,
    isTaskActive: options.approvals.isTaskActive,
  })
  const hooks = createCodexApprovalHooks(approvals, options.approvals.resolveContext)
  const appServer = new CodexAppServerClient({
    ...options.appServer,
    ...hooks,
  })
  return Object.freeze({
    metadata,
    files,
    approvals,
    appServer,
    close() {
      appServer.close()
      approvals.close()
    },
  })
}
