export interface ReconstructionBuildMetadata {
  appVersion: string
  channel: 'reconstruction'
  sourceCommit: string
  baselineParity: 'unverified'
  liveConnectionsEnabled: boolean
}

declare const __ARCHON_BUILD_METADATA__: ReconstructionBuildMetadata

export const buildMetadata = __ARCHON_BUILD_METADATA__
