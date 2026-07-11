// meetcap Recorder — the floating control bar. The recorder LIVES here (this
// window is the app's always-alive surface); the library is a separate
// on-demand window. Everything capture-related is meetcap 0.5.0.
declare const __HARNESS_ENABLED__: boolean
if (__HARNESS_ENABLED__) {
  ;(window as unknown as { __HARNESS_FE__?: unknown }).__HARNESS_FE__ = {
    projectId: 'meetcap-recorder',
    mcpUrl: 'ws://127.0.0.1:47620/ws',
    overlay: false,
    consent: 'off',
  }
  void import('@harness-fe/runtime')
}

import {
  createDetectorClient,
  createRecorder,
  openPrivacySettings,
  PermissionDeniedError,
  type MeetingInfo,
} from 'meetcap-renderer'

const $ = (id: string) => document.getElementById(id) as HTMLElement

// ── capture state: four independent toggles ─────────────────────────────────
const cap: CapState = {
  screen: { on: true, sourceId: null },
  camera: { on: false, deviceId: null },
  mic: { on: true, deviceId: null },
  sys: { on: true },
}

const ICON = {
  screen: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M9 21h6M12 17v4"/>',
  camera: '<path d="M15 10l4.5-2.5v9L15 14"/><rect x="2.5" y="6" width="12.5" height="12" rx="2"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>',
  sys: '<path d="M4 10v4h4l5 4V6l-5 4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>',
}

// The source button shows one mini icon per ENABLED input — reads at a glance.
function renderSource() {
  const icons = [
    cap.screen.on ? ICON.screen : null,
    cap.camera.on ? ICON.camera : null,
    cap.mic.on ? ICON.mic : null,
    cap.sys.on ? ICON.sys : null,
  ].filter(Boolean)
  $('source-icons').innerHTML = icons.length
    ? icons.map((i) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${i}</svg>`).join('')
    : '<span class="none">nothing selected</span>'
}

async function enumerate() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`
  const cams = devices.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: label(d, i, 'Camera') }))
  const mics = devices.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: label(d, i, 'Microphone') }))
  const sources = await window.meetcap.listWindows().catch(() => [])
  const screens = sources.filter((w) => w.id.startsWith('screen:')).map((w, i) => ({ id: w.id, label: w.name || `Screen ${i + 1}` }))
  const windows = sources
    .filter((w) => w.id.startsWith('window:') && w.name)
    .slice(0, 12)
    .map((w) => ({ id: w.id, label: w.name.length > 40 ? w.name.slice(0, 40) + '…' : w.name }))
  return { cams, mics, screens, windows }
}

$('btn-source').onclick = async () => {
  const { cams, mics, screens, windows } = await enumerate()
  // No device → the toggle can't be on.
  if (cams.length === 0) cap.camera.on = false
  if (mics.length === 0) cap.mic.on = false
  const patch = await window.recorderApp.sourceMenu({ state: cap, screens, windows, cams, mics })
  if (patch) {
    if (patch.screen?.on !== undefined) cap.screen.on = patch.screen.on
    if (patch.screen?.sourceId !== undefined) {
      cap.screen.sourceId = patch.screen.sourceId
      cap.screen.on = true
    }
    if (patch.camera?.on !== undefined) cap.camera.on = patch.camera.on
    if (patch.camera?.deviceId !== undefined) cap.camera.deviceId = patch.camera.deviceId
    if (patch.mic?.on !== undefined) cap.mic.on = patch.mic.on
    if (patch.mic?.deviceId !== undefined) cap.mic.deviceId = patch.mic.deviceId
    if (patch.sys?.on !== undefined) cap.sys.on = patch.sys.on
  }
  renderSource()
}
renderSource()

// ── recorder + timer ──────────────────────────────────────────────────────────
const recorder = createRecorder({ filenamePrefix: 'recording' })
let currentMeeting: MeetingInfo | null = null

let elapsed = 0
let lastTick = 0
let timer: ReturnType<typeof setInterval> | null = null
const renderTimer = () => {
  const s = Math.floor(elapsed / 1000)
  $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const startTick = () => {
  lastTick = Date.now()
  timer ??= setInterval(() => {
    elapsed += Date.now() - lastTick
    lastTick = Date.now()
    renderTimer()
  }, 500)
}
const stopTick = () => {
  if (timer) clearInterval(timer)
  timer = null
}

recorder.on('statechange', (s) => {
  window.recorderApp.reportState(s)
  document.body.classList.toggle('recording', s !== 'idle')
  if (s === 'recording') {
    $('btn-pause').style.display = ''
    $('btn-resume').style.display = 'none'
    startTick()
  } else if (s === 'paused') {
    $('btn-pause').style.display = 'none'
    $('btn-resume').style.display = ''
    stopTick()
  } else {
    stopTick()
    void window.recorderApp.pip(false)
  }
})

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

recorder.on('complete', (r) => {
  elapsed = 0
  renderTimer()
  // System notification with a one-click path to the file.
  const n = new Notification('Recording saved', {
    body: `${fmtDur(r.durationMs)}${r.videoSource ? ' · ' + r.videoSource : ''}${r.hasSystemAudio ? ' · system audio' : ''}`,
    silent: true,
  })
  if (r.filePath) n.onclick = () => void window.recorderApp.reveal(r.filePath as string)
})

recorder.on('error', () => {
  /* surfaced via notification below on start failure */
})

async function startRecording(meeting: MeetingInfo | null) {
  if (!cap.screen.on && !cap.camera.on && !cap.mic.on && !cap.sys.on) {
    new Notification('Nothing to record', { body: 'Enable at least one input in the source menu' })
    return
  }
  elapsed = 0
  renderTimer()
  // Camera with screen = floating bubble (the screen capture films it);
  // camera without screen = the recorded video track itself.
  const cameraAsBubble = cap.camera.on && cap.screen.on
  if (cameraAsBubble) await window.recorderApp.pip(true, cap.camera.deviceId)
  try {
    await recorder.start(meeting, {
      capture: {
        screen: cap.screen.on ? { sourceId: cap.screen.sourceId ?? undefined } : false,
        systemAudio: cap.sys.on,
        mic: cap.mic.on ? { deviceId: cap.mic.deviceId ?? undefined } : false,
        camera: cap.camera.on && !cap.screen.on ? { deviceId: cap.camera.deviceId ?? undefined } : false,
      },
    })
  } catch (err) {
    void window.recorderApp.pip(false)
    if (err instanceof PermissionDeniedError) {
      new Notification('Permission needed', { body: `Denied: ${err.denied.join(', ')} — opening System Settings` })
      for (const pane of err.denied) void openPrivacySettings(pane)
    } else {
      new Notification('Could not start recording', { body: ((err as Error)?.message || String(err)).replace(/^meetcap: /, '') })
    }
  }
}

function toggleRecord() {
  if (recorder.state === 'idle') void startRecording(currentMeeting)
  else recorder.stop()
}
$('btn-rec').onclick = toggleRecord
$('btn-pause').onclick = () => recorder.pause()
$('btn-resume').onclick = () => recorder.resume()
window.recorderApp.onToggleRecord(toggleRecord) // ⌘⇧R

// ── meeting detection chip ────────────────────────────────────────────────────
const detector = createDetectorClient({ syncInitial: true })
detector.on('meeting-detected', (m) => {
  currentMeeting = m
  $('meet-app').textContent = m.app
  $('meet-chip').classList.add('show')
  window.recorderApp.reportMeeting(true)
})
detector.on('meeting-ended', (m) => {
  if (currentMeeting && currentMeeting.meetingId !== m.meetingId) return
  currentMeeting = null
  $('meet-chip').classList.remove('show')
  window.recorderApp.reportMeeting(false)
  if (recorder.state !== 'idle') recorder.stop() // meeting over → save
})
$('meet-chip').onclick = () => {
  if (recorder.state === 'idle') void startRecording(currentMeeting)
}

// ── misc ──────────────────────────────────────────────────────────────────────
$('btn-library').onclick = () => void window.recorderApp.showLibrary()
$('btn-hide').onclick = () => void window.recorderApp.hideBar()
