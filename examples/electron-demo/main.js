// Electron main process for the meetcap demo.
//
// Production-style hardened config on purpose: contextIsolation:true,
// nodeIntegration:false. Detection + recording setup are 3 lines thanks to the
// meetcap-* packages; everything process-specific lives inside them.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const { initRecorderMain, startDetector } = require('meetcap-main')

// MUST run before app is ready — initRecorderMain injects the macOS loopback
// Chromium feature flags via electron-audio-loopback.
initRecorderMain()

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 760,
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  // Main-process poller; broadcasts meeting-detected / meeting-ended to renderers.
  // 'either' = window OR meeting-only process (Zoom's CptHost/aomhost), so a
  // minimized/hidden meeting window doesn't read as "meeting ended".
  startDetector({ intervalMs: 3000, require: 'either' })
})

app.on('window-all-closed', () => app.quit())
