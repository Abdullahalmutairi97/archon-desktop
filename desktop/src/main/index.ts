import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { spawn } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isAllowedReconstructionNavigation,
  reconstructionWindowSecurity,
} from './windowSecurity'
import { createConnectionService } from './connectionService'
import { registerBridgeHandlers } from './registerBridge'
import { TrustedShellFrameGuard, type TrustedShellIpcEvent } from './security/TrustedShellFrameGuard'
import { CredentialStore } from './storage/credentialStore'
import { ProfileStore } from './storage/profileStore'
import { BackendTransport } from './transport/backendTransport'
import { LocalPairingClient, resolveLocalPairingSocketPath } from './localPairingClient'
import { OwnedCodexMetadataStore } from './adapters/codex/metadata'
import { acquireCodexOwnerLease, type CodexOwnerLease } from './adapters/codex/ownerLease'
import type { CodexChildProcess } from './adapters/codex/appServer'
import {
  createCodexChildEnvironment,
  createLocalCodexRuntimeFactory,
  LocalCodexController,
  resolveCodexExecutable,
} from './localCodexController'
import { registerLocalCodex } from './registerLocalCodex'
import { registerWorkspaceConsole } from './registerWorkspaceConsole'
import { registerWorkspacePreview } from './registerWorkspacePreview'
import { registerLanguageProfiles } from './registerLanguageProfiles'
import { registerWorkspaceServices } from './registerWorkspaceServices'
import { WorkspacePreviewController } from './workspacePreview'
import type { LocalCodexIpcController } from './registerLocalCodex'
import { LocalCodexBackendAdapter } from './localCodexBackendAdapter'
import { minimizeInsteadOfClosingForActiveWork } from './windowLifecycle'

const RECONSTRUCTION_PROFILE = 'archon-desktop-reconstruction-dev'

app.setName('Archon Desktop Reconstruction')
app.setPath('userData', join(app.getPath('appData'), RECONSTRUCTION_PROFILE))

const trustedFrame = new TrustedShellFrameGuard()
let mainWindow: BrowserWindow | undefined
let localCodexController: LocalCodexController | undefined
let localCodexBackendAdapter: LocalCodexBackendAdapter | undefined
let localCodexOwnerLease: CodexOwnerLease | undefined
let unregisterLocalCodex: (() => void) | undefined
let unregisterWorkspaceConsole: (() => void) | undefined
let unregisterWorkspaceServices: (() => void) | undefined
let unregisterLanguageProfiles: (() => void) | undefined
let unregisterWorkspacePreview: (() => void) | undefined
let workspacePreviewController: WorkspacePreviewController | undefined
let quitRequested = false

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
  mainWindow = window

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
  window.on('closed', () => {
    trustedFrame.unregister(window)
    if (mainWindow === window) mainWindow = undefined
  })
  window.on('close', (event) => {
    minimizeInsteadOfClosingForActiveWork(
      event,
      window,
      localCodexController?.hasActiveWork ?? false,
      quitRequested,
    )
  })
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

void app.whenReady().then(async () => {
  const profileStore = new ProfileStore({ profileRoot: app.getPath('userData') })
  const credentialStore = new CredentialStore({
    profileRoot: profileStore.paths.profileRoot,
    safeStorage,
  })
  let localPairing: LocalPairingClient | undefined
  try {
    const socketPath = resolveLocalPairingSocketPath(process.env.ARCHON_DESKTOP_DATA_DIR, userInfo().homedir)
    localPairing = new LocalPairingClient({ socketPath })
  } catch {
    // An unavailable or invalid local pairing path leaves the app in its disconnected state.
  }
  const connection = await createConnectionService(new BackendTransport(), credentialStore, { localPairing })
  let localCodexBridge: LocalCodexIpcController
  const pickProjectDirectory = async (): Promise<string | null> => {
    const owner = mainWindow
    if (!owner || owner.isDestroyed()) return null
    const result = await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  }
  try {
    if (process.env.ARCHON_DESKTOP_CODEX_OWNER === 'backend') {
      // The backend worker owns the same metadata profile in this explicit mode.
      // Never construct an Electron owner or fall back to one after proxy failure.
      localCodexBackendAdapter = new LocalCodexBackendAdapter({ connection, pickProjectDirectory })
      localCodexBridge = localCodexBackendAdapter
    } else {
      localCodexOwnerLease = await acquireCodexOwnerLease(profileStore.paths.codexMetadataDirectory, 'electron-main')
      const codexMetadata = new OwnedCodexMetadataStore(profileStore.paths.codexMetadataDirectory)
      const homeDirectory = process.env.HOME && isAbsolute(process.env.HOME) ? process.env.HOME : homedir()
      const codexHomeDirectory = process.env.CODEX_HOME === undefined
        ? join(homeDirectory, '.codex')
        : process.env.CODEX_HOME
      const codexEnvironment = createCodexChildEnvironment({ homeDirectory, codexHomeDirectory })
      const codexCommand = await resolveCodexExecutable(process.env.ARCHON_CODEX_EXECUTABLE, app.isPackaged)
      const codexRuntime = createLocalCodexRuntimeFactory({
        metadata: codexMetadata,
        command: codexCommand,
        env: codexEnvironment,
        spawn: (command, args, options) => spawn(command, args, {
          ...options,
          env: { ...options.env },
        }) as unknown as CodexChildProcess,
      })
      localCodexController = new LocalCodexController({
        metadata: codexMetadata,
        protectedRoots: [codexEnvironment.CODEX_HOME],
        createRuntime: codexRuntime,
        pickProjectDirectory,
      })
      localCodexBridge = localCodexController
    }
  } catch {
    try { localCodexController?.close() } catch { /* Keep the connection bridge available. */ }
    localCodexController = undefined
    localCodexOwnerLease?.releaseSync()
    localCodexOwnerLease = undefined
    localCodexBackendAdapter?.close()
    localCodexBackendAdapter = undefined
    localCodexBridge = {
      listProjects: async () => [],
      listSessions: async () => [],
      registerProject: async () => { throw new Error('Local Codex is unavailable.') },
      registerWorkspaceRoot: async () => { throw new Error('Local Codex is unavailable.') },
      startTurn: async () => { throw new Error('Local Codex is unavailable.') },
      cancelTurn: async () => false,
      answerApproval: () => false,
      subscribe: () => () => undefined,
    }
  }
  unregisterLocalCodex = registerLocalCodex({
    ipc: {
      handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => handler(event, ...args)),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
    },
    guard: (event) => trustedFrame.assertTrusted(event as TrustedShellIpcEvent),
    trustedFrame,
    controller: localCodexBridge,
    getWorkspaceRoot: async (workspaceId) => (await connection.getPairedLocalWorkspace(workspaceId)).root,
    getWindow: () => mainWindow,
  })
  unregisterWorkspaceConsole = registerWorkspaceConsole({
    ipc: {
      handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => handler(event, ...args)),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
    },
    guard: (event) => trustedFrame.assertTrusted(event as TrustedShellIpcEvent),
    invokePairedLocalCodex: connection.invokePairedLocalCodex,
    getWindow: () => mainWindow,
  })
  unregisterWorkspaceServices = registerWorkspaceServices({
    ipc: {
      handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => handler(event, ...args)),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
    },
    guard: (event) => trustedFrame.assertTrusted(event as TrustedShellIpcEvent),
    invokePairedLocalCodex: connection.invokePairedLocalCodex,
  })
  unregisterLanguageProfiles = registerLanguageProfiles({
    ipc: {
      handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => handler(event, ...args)),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
    },
    guard: (event) => trustedFrame.assertTrusted(event as TrustedShellIpcEvent),
    invokePairedLocalCodex: connection.invokePairedLocalCodex,
  })
  workspacePreviewController = new WorkspacePreviewController(() => mainWindow)
  unregisterWorkspacePreview = registerWorkspacePreview({
    ipc: {
      handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => handler(event, ...args)),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
    },
    guard: (event) => trustedFrame.assertTrusted(event as TrustedShellIpcEvent),
    invokePairedLocalCodex: connection.invokePairedLocalCodex,
    serverUrl: async () => (await connection.describe()).serverUrl,
    open: async (url, bounds) => { await workspacePreviewController?.open(url, bounds) },
    setBounds: (bounds) => workspacePreviewController?.setBounds(bounds) ?? false,
    close: () => workspacePreviewController?.close() ?? false,
  })
  registerBridgeHandlers({
    handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => handler(event, ...args)),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  }, (event) => trustedFrame.assertTrusted(event as TrustedShellIpcEvent), connection)
  createMainWindow()
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    else mainWindow.show()
    mainWindow.focus()
  })
})

app.on('before-quit', () => {
  quitRequested = true
  unregisterLocalCodex?.()
  unregisterLocalCodex = undefined
  unregisterWorkspaceConsole?.()
  unregisterWorkspaceConsole = undefined
  unregisterWorkspaceServices?.()
  unregisterWorkspaceServices = undefined
  unregisterLanguageProfiles?.()
  unregisterLanguageProfiles = undefined
  unregisterWorkspacePreview?.()
  unregisterWorkspacePreview = undefined
  workspacePreviewController?.close()
  workspacePreviewController = undefined
  localCodexBackendAdapter?.close()
  localCodexBackendAdapter = undefined
  localCodexController?.close()
  localCodexController = undefined
  localCodexOwnerLease?.releaseSync()
  localCodexOwnerLease = undefined
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
