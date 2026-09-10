export {}

declare global {
  interface Window {
    archon?: {
      readClipboardImage(): Promise<string | null>
      getConnection(): Promise<{ serverUrl: string; token: string; secureStorage: boolean }>
      setConnection(value: { serverUrl: string; token: string }): Promise<{ serverUrl: string; token: string; secureStorage: boolean }>
      getSettings(): Promise<Record<string, unknown>>
      setSettings(value: Record<string, unknown>): Promise<Record<string, unknown>>
      importAsset(value: { kind: 'background' | 'mark'; name: string; dataUrl: string }): Promise<{ id: string; label: string; file: string; url: string; addedAt: string }>
      getVersion(): Promise<string>
      getReleaseInfo(): Promise<{ currentVersion: string; version: string; size: number; sha256: string; updateAvailable: boolean; changes: string[] }>
      updateAndRestart(): Promise<void>
      minimize(): Promise<void>
      maximize(): Promise<boolean>
      close(): Promise<void>
      openExternal(url: string): Promise<void>
    }
  }
}
