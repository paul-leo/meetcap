// meetcap Recorder — main process. The primary UI is a floating control BAR
// (frameless pill, bottom-center, always on top) — not a full window. The
// recorder lives in the bar's renderer so it survives everything else; the
// library is an on-demand secondary window. Tray toggles the bar.
const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, ipcMain, shell, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { initRecorderMain, startDetector } = require('meetcap-main')

const SAVE_DIR = path.join(app.getPath('videos'), 'meetcap Recorder')

// MUST run before app.whenReady — injects the loopback Chromium flags.
initRecorderMain({ saveDir: SAVE_DIR, revealInFolder: false })

let bar = null
let library = null
let pip = null
let tray = null
let recording = false
let inMeeting = false

const BAR_W = 420
const BAR_H = 54

// ── windows ───────────────────────────────────────────────────────────────────

function createBar() {
  const { workArea } = screen.getPrimaryDisplay()
  bar = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    x: workArea.x + Math.round((workArea.width - BAR_W) / 2),
    y: workArea.y + workArea.height - BAR_H - 28,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  bar.setAlwaysOnTop(true, 'floating')
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  bar.loadFile(path.join(__dirname, 'renderer', 'bar.html'))
  // NOTE: transparent windows may never fire ready-to-show on macOS — show
  // on did-finish-load instead.
  bar.webContents.once('did-finish-load', () => bar.show())
  bar.on('closed', () => (bar = null))
}

function toggleBar() {
  if (!bar) return createBar()
  if (bar.isVisible()) bar.hide()
  else bar.show()
}

function showLibrary() {
  if (library && !library.isDestroyed()) {
    library.show()
    library.focus()
    return
  }
  library = new BrowserWindow({
    width: 420,
    height: 520,
    title: 'Recordings',
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  library.loadFile(path.join(__dirname, 'renderer', 'library.html'))
  library.on('closed', () => (library = null))
}

// Camera PiP bubble — zero compositing: the screen capture just films it.
function showPip(deviceId) {
  if (pip && !pip.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  const SIZE = 180
  pip = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    x: workArea.x + 24,
    y: workArea.y + workArea.height - SIZE - 24,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
  })
  pip.setAlwaysOnTop(true, 'screen-saver')
  pip.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  pip.loadFile(path.join(__dirname, 'renderer', 'pip.html'), deviceId ? { query: { deviceId } } : undefined)
  pip.on('closed', () => (pip = null))
}
function hidePip() {
  if (pip && !pip.isDestroyed()) pip.close()
  pip = null
}

// ── tray ──────────────────────────────────────────────────────────────────────

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

function refreshTray() {
  tray.setImage(trayIcon(recording))
  tray.setToolTip(
    recording ? 'meetcap Recorder — recording…' : inMeeting ? 'meetcap Recorder — meeting detected' : 'meetcap Recorder',
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: recording ? 'Recording…' : inMeeting ? 'Meeting detected' : 'Idle', enabled: false },
      { type: 'separator' },
      { label: 'Show / hide bar', accelerator: 'CommandOrControl+Shift+M', click: toggleBar },
      { label: 'Recordings…', click: showLibrary },
      { type: 'separator' },
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

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.on('recorder-app:state', (_e, s) => {
  recording = s === 'recording' || s === 'paused'
  refreshTray()
  if (!recording && library && !library.isDestroyed()) library.webContents.send('recorder-app:library-updated')
})
ipcMain.on('recorder-app:meeting', (_e, active) => {
  inMeeting = active
  refreshTray()
  if (active && bar && !bar.isVisible()) bar.show() // surface the bar when a meeting appears
})

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
ipcMain.handle('recorder-app:reveal', (_e, filePath) => shell.showItemInFolder(filePath))
ipcMain.handle('recorder-app:show-library', () => showLibrary())
ipcMain.handle('recorder-app:hide-bar', () => bar?.hide())
ipcMain.handle('recorder-app:pip', (_e, show, deviceId) => (show ? showPip(deviceId) : hidePip()))

// Source menu — four independent toggles with device submenus, macOS-native.
// The renderer supplies current state + enumerated devices; one click = one
// adjustment; the updated state is resolved back.
ipcMain.handle('recorder-app:source-menu', (e, p) => {
  return new Promise((resolve) => {
    let result = null
    const set = (patch) => () => (result = patch)
    const radio = (items, currentId, make) =>
      items.map((it) => ({ label: it.label, type: 'radio', checked: currentId === it.id, click: set(make(it.id)) }))

    const screenSources = radio(p.screens, p.state.screen.sourceId, (id) => ({ screen: { sourceId: id } }))
    const windowSources = radio(p.windows, p.state.screen.sourceId, (id) => ({ screen: { sourceId: id } }))
    const menu = Menu.buildFromTemplate([
      {
        label: 'Screen',
        type: 'checkbox',
        checked: p.state.screen.on,
        click: set({ screen: { on: !p.state.screen.on } }),
      },
      {
        label: '    Source',
        enabled: p.state.screen.on,
        submenu: [
          ...screenSources,
          ...(windowSources.length ? [{ type: 'separator' }, { label: 'Windows', enabled: false }, ...windowSources] : []),
        ],
      },
      { type: 'separator' },
      {
        label: 'Camera',
        type: 'checkbox',
        checked: p.state.camera.on,
        enabled: p.cams.length > 0,
        click: set({ camera: { on: !p.state.camera.on } }),
      },
      ...(p.cams.length > 1
        ? [{ label: '    Device', enabled: p.state.camera.on, submenu: radio(p.cams, p.state.camera.deviceId ?? p.cams[0].id, (id) => ({ camera: { deviceId: id } })) }]
        : []),
      {
        label: 'Microphone',
        type: 'checkbox',
        checked: p.state.mic.on,
        enabled: p.mics.length > 0,
        click: set({ mic: { on: !p.state.mic.on } }),
      },
      ...(p.mics.length > 1
        ? [{ label: '    Device', enabled: p.state.mic.on, submenu: radio(p.mics, p.state.mic.deviceId ?? p.mics[0].id, (id) => ({ mic: { deviceId: id } })) }]
        : []),
      {
        label: 'System audio',
        type: 'checkbox',
        checked: p.state.sys.on,
        click: set({ sys: { on: !p.state.sys.on } }),
      },
    ])
    menu.popup({
      window: BrowserWindow.fromWebContents(e.sender),
      callback: () => resolve(result),
    })
  })
})

// ── lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  tray = new Tray(trayIcon(false))
  tray.on('click', toggleBar)
  refreshTray()
  createBar()
  // Process-only detection: zero extra permissions; the bar shows the chip.
  startDetector({ intervalMs: 3000, endGraceMs: 15_000 })
  // Global shortcuts: toggle recording / toggle bar.
  globalShortcut.register('CommandOrControl+Shift+R', () => bar?.webContents.send('recorder-app:toggle-record'))
  globalShortcut.register('CommandOrControl+Shift+M', toggleBar)
  if (app.dock) app.dock.hide()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  // keep running in the tray
})
