// meetcap Recorder — main process. Menu-bar (tray) app: the panel window is
// summoned from the tray, recording runs in the renderer via meetcap, files
// land in ~/Movies/meetcap Recorder. Meeting detection runs process-only
// (zero permissions) and badges the tray while a meeting is live.
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { initRecorderMain, startDetector } = require('meetcap-main')

const SAVE_DIR = path.join(app.getPath('videos'), 'meetcap Recorder')

// MUST run before app.whenReady — injects the loopback Chromium flags.
initRecorderMain({ saveDir: SAVE_DIR, revealInFolder: false })

// App-level IPC: the library view (meetcap's bridge covers read/delete/exists;
// enumerating finished recordings is the app's own concern).
ipcMain.handle('recorder-app:library', () => {
  if (!fs.existsSync(SAVE_DIR)) return []
  return fs
    .readdirSync(SAVE_DIR)
    .filter((f) => f.endsWith('.webm'))
    .map((f) => {
      const p = path.join(SAVE_DIR, f)
      const st = fs.statSync(p)
      return { filePath: p, name: f, size: st.size, mtimeMs: st.mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
})
ipcMain.handle('recorder-app:open-folder', () => {
  fs.mkdirSync(SAVE_DIR, { recursive: true })
  void shell.openPath(SAVE_DIR)
})

let panel = null
let tray = null
let recording = false
let inMeeting = false

// 16x16 template circle, filled while recording (macOS tints template images).
function trayIcon(active) {
  const size = 16
  const c = active ? 0xff : 0x00
  const buf = Buffer.alloc(size * size * 4)
  const cx = 7.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cx)
      const i = (y * size + x) * 4
      const inside = active ? d <= 6 : d <= 6 && d >= 4.6
      if (inside) {
        buf[i] = c
        buf[i + 1] = active ? 0x2b : 0x00
        buf[i + 2] = active ? 0x2b : 0x00
        buf[i + 3] = 0xff
      }
    }
  }
  const img = nativeImage.createFromBuffer(buf, { width: size, height: size })
  if (!active) img.setTemplateImage(true)
  return img
}

function createPanel() {
  panel = new BrowserWindow({
    width: 460,
    height: 640,
    show: false,
    resizable: true,
    fullscreenable: false,
    title: 'meetcap Recorder',
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  panel.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // Menu-bar app semantics: closing hides, quit lives in the tray menu.
  panel.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      panel.hide()
    }
  })
}

function togglePanel() {
  if (!panel) createPanel()
  if (panel.isVisible()) panel.hide()
  else {
    panel.show()
    panel.focus()
  }
}

function refreshTray() {
  tray.setImage(trayIcon(recording))
  tray.setToolTip(
    recording ? 'meetcap Recorder — recording…' : inMeeting ? 'meetcap Recorder — meeting detected' : 'meetcap Recorder',
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: recording ? 'Recording…' : inMeeting ? 'Meeting detected' : 'Idle', enabled: false },
      { type: 'separator' },
      { label: 'Open panel', click: togglePanel },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true
          app.quit()
        },
      },
    ]),
  )
}

// Renderer reports recording state so the tray reflects it.
ipcMain.on('recorder-app:state', (_e, s) => {
  recording = s === 'recording' || s === 'paused'
  refreshTray()
})
ipcMain.on('recorder-app:meeting', (_e, active) => {
  inMeeting = active
  refreshTray()
})

app.whenReady().then(() => {
  tray = new Tray(trayIcon(false))
  tray.on('click', togglePanel)
  refreshTray()
  createPanel()
  panel.once('ready-to-show', () => panel.show()) // first launch: show the panel
  // Process-only detection: zero extra permissions; renderer shows the banner.
  startDetector({ intervalMs: 3000, endGraceMs: 15_000 })
  if (app.dock) app.dock.hide() // menu-bar app: no Dock icon
})

app.on('window-all-closed', () => {
  // keep running in the tray
})
