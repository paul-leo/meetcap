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

// ── source state ──────────────────────────────────────────────────────────────
type Mode = '' | 'screen' | 'camera'
let mode: Mode = 'screen'
let pipOn = false

const SOURCE_META: Record<Mode, { label: string; icon: string }> = {
  screen: {
    label: 'Screen',
    icon: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M9 21h6M12 17v4"/>',
  },
  '': {
    label: 'Audio',
    icon: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>',
  },
  camera: {
    label: 'Camera',
    icon: '<path d="M15 10l4.5-2.5v9L15 14"/><rect x="2.5" y="6" width="12.5" height="12" rx="2"/>',
  },
}

function renderSource() {
  ;($('source-label') as HTMLElement).textContent = SOURCE_META[mode].label + (pipOn && mode === 'screen' ? ' + cam' : '')
  ;($('source-icon') as HTMLElement).innerHTML = SOURCE_META[mode].icon
}
renderSource()

$('btn-source').onclick = async () => {
  const choice = await window.recorderApp.sourceMenu({ mode, pip: pipOn })
  if (!choice) return
  if (choice.mode !== undefined) mode = choice.mode as Mode
  if (choice.pip !== undefined) pipOn = choice.pip
  renderSource()
}

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
  elapsed = 0
  renderTimer()
  if (mode === 'screen' && pipOn) await window.recorderApp.pip(true)
  try {
    await recorder.start(meeting, mode ? { video: mode } : {})
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
