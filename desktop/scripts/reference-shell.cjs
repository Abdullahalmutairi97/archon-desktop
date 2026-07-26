const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 900, frame: false, show: true, webPreferences: { sandbox: true, contextIsolation: true } })
  win.loadURL('http://127.0.0.1:9320/Archon%20Desktop%20v2.dc.html')
})
app.on('window-all-closed', () => app.quit())
