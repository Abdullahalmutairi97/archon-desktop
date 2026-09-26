import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isAllowedReconstructionNavigation,
  reconstructionWindowSecurity,
} from './windowSecurity'

const RECONSTRUCTION_PROFILE = 'archon-desktop-reconstruction-dev'

app.setName('Archon Desktop Reconstruction')
app.setPath('userData', join(app.getPath('appData'), RECONSTRUCTION_PROFILE))

function getRendererDevOrigin(): string | undefined {
  if (app.isPackaged) return undefined
  const configured = process.env.ELECTRON_RENDERER_URL
  if (!configured) return undefined
  try {
    const url = new URL(configured)
    if (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === '5173' &&
      !url.username &&
      !url.password
    ) {
      return url.origin
    }
  } catch {
    return undefined
  }
  return undefined
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    webPreferences: { ...reconstructionWindowSecurity },
  })

  const rendererFile = join(__dirname, '../renderer/index.html')
  const rendererFileUrl = pathToFileURL(rendererFile).href
  const devOrigin = getRendererDevOrigin()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, destination) => {
    if (!isAllowedReconstructionNavigation(destination, devOrigin, rendererFileUrl)) {
      event.preventDefault()
    }
  })

  if (devOrigin && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(rendererFile)
  }
  return window
}

void app.whenReady().then(() => {
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
