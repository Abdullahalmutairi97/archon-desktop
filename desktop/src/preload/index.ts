import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('archon', {
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  getConnection: () => ipcRenderer.invoke('connection:get'),
  setConnection: (value: { serverUrl: string; token: string }) => ipcRenderer.invoke('connection:set', value),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (value: Record<string, unknown>) => ipcRenderer.invoke('settings:merge', value),
  importAsset: (value: { kind: 'background' | 'mark'; name: string; dataUrl: string }) => ipcRenderer.invoke('asset:import', value),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getReleaseInfo: () => ipcRenderer.invoke('app:release-info'),
  updateAndRestart: () => ipcRenderer.invoke('app:update-and-restart'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
})
