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

function createWindow(index = 0) {
  const win = new BrowserWindow({
    width: 900,
    height: 760,
    // Cascade multi-window runs: a fully occluded window can drop out of
    // macOS's window enumeration, which would read as detection flicker.
    x: 60 + index * 220,
    y: 60 + index * 120,
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

// Test knobs (see docs/integration-playbook.md):
//   MEETCAP_DEMO_WINDOWS=2       — multi-window: every window receives the same
//                                  detector broadcasts (gate your UI in real apps)
//   MEETCAP_DEMO_END_GRACE_MS=8000 — debounce meeting-ended to observe grace behavior
const windowCount = Math.max(1, Number(process.env.MEETCAP_DEMO_WINDOWS) || 1)
const endGraceMs = Number(process.env.MEETCAP_DEMO_END_GRACE_MS) || 0

app.whenReady().then(() => {
  for (let i = 0; i < windowCount; i++) createWindow(i)
  // Main-process poller; broadcasts meeting-detected / meeting-ended to renderers.
  // 'either' = window OR meeting-only process (Zoom's CptHost/aomhost), so a
  // minimized/hidden meeting window doesn't read as "meeting ended".
  startDetector({ intervalMs: 3000, require: 'either', endGraceMs })
})

app.on('window-all-closed', () => app.quit())
