const { app, BrowserWindow } = require('electron')
const path = require('node:path')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, frame: false, show: true, webPreferences: { sandbox: true, contextIsolation: true } })
  await win.loadFile(path.resolve(process.env.ARCHON_REFERENCE_FILE))
})
app.on('window-all-closed', () => app.quit())
