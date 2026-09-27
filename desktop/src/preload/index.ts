import { contextBridge, ipcRenderer } from 'electron'
import { createDesktopBridge } from './bridge'

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('archon', createDesktopBridge(ipcRenderer))
}
