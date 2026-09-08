import { app, BrowserWindow, clipboard, ipcMain, protocol, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

protocol.registerSchemesAsPrivileged([{ scheme: 'archon-asset', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true, stream: true } }])
import { fileURLToPath } from 'node:url'
import { isTrustedNavigation } from './navigation'

const here = dirname(fileURLToPath(import.meta.url))
if (process.platform === 'linux' && process.env.ARCHON_E2E_ALLOW_PLAINTEXT_SAFE_STORAGE === '1') {
  safeStorage.setUsePlainTextEncryption(true)
}
const connectionPath = () => join(app.getPath('userData'), 'connection.json')
const archonHome = () => join(app.getPath('home'), '.archon')
const settingsPath = () => join(archonHome(), 'settings.json')
let settingsWriteQueue: Promise<void> = Promise.resolve()

function productVersion() {
  const reported = app.getVersion()
  if (reported !== process.versions.electron) return reported
  for (const candidate of [resolve(here, '../..', 'package.json'), join(app.getAppPath(), 'package.json')]) {
    try {
      const version = String(JSON.parse(readFileSync(candidate, 'utf8')).version || '')
      if (version && version !== process.versions.electron) return version
    } catch { /* try the next package location */ }
  }
  return reported
}

async function readDesktopSettings(): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown> } catch { return {} }
}

async function writeDesktopSettings(value: Record<string, unknown>) {
  const target = settingsPath()
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await import('node:fs/promises').then(({ rename }) => rename(temporary, target))
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get', async () => { await settingsWriteQueue; return readDesktopSettings() })
  ipcMain.handle('settings:merge', async (_event, patch: Record<string, unknown>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings patch')
    let result: Record<string, unknown> = {}
    const operation = settingsWriteQueue.then(async () => {
      result = { ...(await readDesktopSettings()), ...patch }
      await writeDesktopSettings(result)
    })
    settingsWriteQueue = operation.then(() => undefined, () => undefined)
    await operation
    return result
  })
  ipcMain.handle('asset:import', async (_event, input: { kind: 'background' | 'mark'; name: string; dataUrl: string }) => {
    if (!input || !['background', 'mark'].includes(input.kind)) throw new Error('Invalid asset kind')
    const match = /^data:image\/(png|jpeg|webp|svg\+xml);base64,([a-z0-9+/=]+)$/i.exec(input.dataUrl || '')
    if (!match || (match[1].toLowerCase() === 'svg+xml' && input.kind !== 'mark')) throw new Error('Use a PNG, JPEG, WebP, or SVG mark')
    const bytes = Buffer.from(match[2], 'base64')
    if (!bytes.length || bytes.length > 10_000_000) throw new Error('Image must be under 10 MB')
    if (match[1].toLowerCase() === 'svg+xml') {
      const svg = bytes.toString('utf8')
      if (!/<svg[\s>]/i.test(svg) || /<script|<foreignObject|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test(svg)) throw new Error('SVG mark contains unsafe content')
    }
    const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase() === 'svg+xml' ? 'svg' : match[1].toLowerCase()
    const id = input.kind === 'mark' ? 'mark' : randomUUID()
    const folder = join(archonHome(), input.kind === 'mark' ? 'brand' : 'backgrounds')
    const file = join(folder, `${id}.${extension}`)
    mkdirSync(folder, { recursive: true })
    const temporary = `${file}.tmp`
    await writeFile(temporary, bytes, { mode: 0o600 })
    await import('node:fs/promises').then(({ rename }) => rename(temporary, file))
    const assetFolder = input.kind === 'mark' ? 'brand' : 'backgrounds'
    return { id, label: input.name.slice(0, 120), file, url: `archon-asset://local/${assetFolder}/${encodeURIComponent(`${id}.${extension}`)}`, addedAt: new Date().toISOString() }
  })
}
type Stored = { serverUrl?: string; token?: string }
type Connection = { serverUrl: string; token: string; secureStorage: boolean }

function readConnection(): Connection {
  let stored: Stored = {}
  try { if (existsSync(connectionPath())) stored = JSON.parse(readFileSync(connectionPath(), 'utf8')) } catch { stored = {} }
  let token = ''
  if (stored.token && safeStorage.isEncryptionAvailable()) {
    try { token = safeStorage.decryptString(Buffer.from(stored.token, 'base64')) } catch { token = '' }
  }
  return { serverUrl: stored.serverUrl || '', token, secureStorage: safeStorage.isEncryptionAvailable() }
}

function saveConnection(value: { serverUrl: string; token: string }): Connection {
  const parsed = new URL(value.serverUrl)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Server URL must use HTTP or HTTPS')
  if (value.token && (value.token.length < 16 || value.token.length > 1024)) throw new Error('Connection token is invalid')
  const secure = !value.token || safeStorage.isEncryptionAvailable()
  const stored: Stored = { serverUrl: parsed.toString().replace(/\/$/, '') }
  if (value.token && safeStorage.isEncryptionAvailable()) stored.token = safeStorage.encryptString(value.token).toString('base64')
  const target = connectionPath()
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  writeFileSync(temporary, JSON.stringify(stored, null, 2), { mode: 0o600 })
  renameSync(temporary, target)
  // When OS keyring-backed safeStorage is unavailable, keep the token only in
  // the returned in-memory connection. It is never written to disk.
  return { serverUrl: stored.serverUrl || '', token: value.token, secureStorage: secure }
}

type DesktopRelease = { version: string; size: number; sha256: string }

function newerVersion(remote: string, current: string) {
  const left = remote.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const right = current.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0)
  }
  return false
}

async function remoteRelease() {
  const connection = readConnection()
  if (!connection.serverUrl || !connection.token) throw new Error('Connect to the Archon server before checking for updates')
  const response = await fetch(new URL('/api/desktop/release', `${connection.serverUrl}/`), { headers: { Authorization: `Bearer ${connection.token}` } })
  if (!response.ok) throw new Error(response.status === 404 ? 'No desktop release is available on the server' : `Update check failed (${response.status})`)
  const release = await response.json() as DesktopRelease
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(release.version) || !Number.isSafeInteger(release.size) || release.size <= 0 || !/^[a-f0-9]{64}$/i.test(release.sha256)) throw new Error('The server returned invalid release metadata')
  const currentVersion = productVersion()
  return { ...release, currentVersion, updateAvailable: newerVersion(release.version, currentVersion) }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1040, minHeight: 680,
    backgroundColor: '#161826', title: 'Archon Desktop', frame: false,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isTrustedNavigation(url, join(here, '../renderer/index.html'), process.env.ELECTRON_RENDERER_URL)
    if (!allowed) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))
}

app.whenReady().then(() => {
  protocol.handle('archon-asset', (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'local') return new Response('Not found', { status: 404 })
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!/^(brand|backgrounds)\/[a-z0-9._-]+$/i.test(relative)) return new Response('Not found', { status: 404 })
    const root = resolve(archonHome())
    const target = resolve(root, relative)
    if (!target.startsWith(`${root}/`) || !existsSync(target)) return new Response('Not found', { status: 404 })
    const contentTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
    const contentType = contentTypes[extname(target).toLowerCase()]
    if (!contentType) return new Response('Unsupported asset', { status: 415 })
    return new Response(new Uint8Array(readFileSync(target)), { headers: { 'content-type': contentType, 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
  })
  registerSettingsIpc()
  app.on('web-contents-created', (_event, contents) => {
    contents.session.setPermissionCheckHandler((_webContents, permission, _origin, details) => permission === 'media' && details.mediaType === 'audio')
    contents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => callback(permission === 'media' && 'mediaTypes' in details && Boolean(details.mediaTypes?.includes('audio'))))
  })
  ipcMain.handle('clipboard:read-image', () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    return image.toPNG().toString('base64')
  })
  ipcMain.handle('connection:get', () => readConnection())
  ipcMain.handle('connection:set', (_event, value) => saveConnection(value))
  ipcMain.handle('app:version', () => productVersion())
  ipcMain.handle('app:release-info', async () => {
    const release = await remoteRelease()
    return {
      ...release,
      changes: [
        'Server-owned tasks and replayable live activity',
        'Encrypted device connection and isolated chat mode',
        'Seven themes, complete RTL mirroring and device-local appearance assets',
        'Honest process-group cancellation and resilient session continuity',
      ],
    }
  })
  ipcMain.handle('app:update-and-restart', async () => {
    const image = process.env.APPIMAGE
    if (!image || !existsSync(image)) throw new Error('Updates can only be installed from the packaged AppImage')
    const release = await remoteRelease()
    if (!release.updateAvailable) throw new Error('Archon Desktop is already up to date')
    const connection = readConnection()
    const response = await fetch(new URL('/api/desktop/update', `${connection.serverUrl}/`), { headers: { Authorization: `Bearer ${connection.token}` } })
    if (!response.ok) throw new Error(`Update download failed (${response.status})`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256.toLowerCase()) throw new Error('Downloaded update failed integrity verification')
    const temporary = `${image}.next`
    await writeFile(temporary, bytes, { mode: 0o755 })
    await import('node:fs/promises').then(({ rename }) => rename(temporary, image))
    app.relaunch({ execPath: image })
    app.exit(0)
  })
  ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.handle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
