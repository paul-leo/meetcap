// meetcap Recorder — main process. The primary UI is a floating control BAR
// (frameless pill, bottom-center, always on top) — not a full window. The
// recorder lives in the bar's renderer so it survives everything else; the
// library is an on-demand secondary window. Tray toggles the bar.
const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, ipcMain, shell, screen, desktopCapturer } = require('electron')
const path = require('path')
const fs = require('fs')
const { initRecorderMain, startDetector } = require('meetcap-main')

const SAVE_DIR = path.join(app.getPath('videos'), 'meetcap Recorder')

// MUST run before app.whenReady — injects the loopback Chromium flags.
initRecorderMain({ saveDir: SAVE_DIR, revealInFolder: false })

let bar = null
let library = null
let pip = null
let picker = null
let tray = null
let recording = false
let inMeeting = false

const BAR_W = 540
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
  // Never record ourselves: exclude the bar from screen captures (the PiP
  // camera bubble stays capturable on purpose — the screen capture films it).
  bar.setContentProtection(true)
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

// Popovers render inside the bar window and open upward — the renderer asks
// for more height; keep the BOTTOM edge anchored so the bar itself never moves.
ipcMain.handle('recorder-app:bar-height', (_e, h) => {
  if (!bar || bar.isDestroyed()) return
  const b = bar.getBounds()
  const height = Math.max(BAR_H, Math.min(Math.round(h), 480))
  bar.setBounds({ x: b.x, y: b.y + b.height - height, width: b.width, height })
})

// Live thumbnails for the visual screen/window picker. listWindows() in
// meetcap-main deliberately fetches 1×1 thumbnails (detection only) — the
// picker needs real previews, so this is app-level.
const OWN_WINDOW_TITLES = new Set(['meetcap Recorder', 'Recordings', 'Choose what to share'])
ipcMain.handle('recorder-app:capture-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 360, height: 225 },
    fetchWindowIcons: true,
  })
  return sources
    .filter((s) => s.id.startsWith('screen:') || (s.name && !OWN_WINDOW_TITLES.has(s.name)))
    .map((s, i) => ({
      id: s.id,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      name: s.name || (s.id.startsWith('screen:') ? `Screen ${i + 1}` : 'Untitled window'),
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }))
})

// The visual picker — a frameless modal centered on the bar's display
// (Screens / Windows tabs with thumbnails). Resolves to {sourceId, label}
// or null on cancel/close.
ipcMain.handle('recorder-app:pick-screen', (_e, currentId) => {
  return new Promise((resolve) => {
    if (picker && !picker.isDestroyed()) {
      picker.focus()
      resolve(null)
      return
    }
    const disp = bar && !bar.isDestroyed() ? screen.getDisplayMatching(bar.getBounds()) : screen.getPrimaryDisplay()
    const W = 760
    const H = 540
    picker = new BrowserWindow({
      width: W,
      height: H,
      x: disp.workArea.x + Math.round((disp.workArea.width - W) / 2),
      y: disp.workArea.y + Math.round((disp.workArea.height - H) / 2),
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
    picker.setAlwaysOnTop(true, 'floating')
    let result = null
    const onDone = (_ev, r) => {
      result = r
      if (picker && !picker.isDestroyed()) picker.close()
    }
    ipcMain.once('recorder-app:picker-done', onDone)
    picker.on('closed', () => {
      ipcMain.removeListener('recorder-app:picker-done', onDone)
      picker = null
      resolve(result)
    })
    picker.loadFile(path.join(__dirname, 'renderer', 'picker.html'), currentId ? { query: { current: currentId } } : undefined)
    picker.webContents.once('did-finish-load', () => picker && picker.show())
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
