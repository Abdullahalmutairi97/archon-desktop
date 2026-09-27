import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isAllowedReconstructionNavigation,
  reconstructionWindowSecurity,
} from './windowSecurity'
import { createConnectionService } from './connectionService'
import { registerBridgeHandlers } from './registerBridge'
import { TrustedShellFrameGuard, type TrustedShellIpcEvent } from './security/TrustedShellFrameGuard'
import { BackendTransport } from './transport/backendTransport'

const RECONSTRUCTION_PROFILE = 'archon-desktop-reconstruction-dev'

app.setName('Archon Desktop Reconstruction')
app.setPath('userData', join(app.getPath('appData'), RECONSTRUCTION_PROFILE))

const trustedFrame = new TrustedShellFrameGuard()
const connection = createConnectionService(new BackendTransport())

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
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
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
    webPreferences: {
      ...reconstructionWindowSecurity,
      preload: join(__dirname, '../preload/index.js'),
    },
  })

  const rendererFile = join(__dirname, '../renderer/index.html')
  const rendererFileUrl = pathToFileURL(rendererFile).href
  const devOrigin = getRendererDevOrigin()
  const trustedDocumentUrl = devOrigin ? `${devOrigin}/` : rendererFileUrl
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      trustedFrame.invalidateNavigation(window.webContents)
    }
  })
  window.webContents.on('did-finish-load', () => {
    const loaded = window.webContents.getURL()
    if (!isAllowedReconstructionNavigation(loaded, devOrigin, rendererFileUrl)) {
      trustedFrame.unregister(window)
      return
    }
    try {
      trustedFrame.register(window, trustedDocumentUrl)
    } catch {
      trustedFrame.unregister(window)
    }
  })
  window.on('closed', () => trustedFrame.unregister(window))
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
  registerBridgeHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => handler(event, ...args)),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  }, (event) => trustedFrame.assertTrusted(event as TrustedShellIpcEvent), connection)
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
