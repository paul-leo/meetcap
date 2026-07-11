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

// ── capture state: four independent toggles, each with its OWN selector ─────
const cap: CapState = {
  screen: { on: true, sourceId: null },
  camera: { on: false, deviceId: null },
  mic: { on: true, deviceId: null },
  sys: { on: true },
}
let screenLabel = 'Screen 1'

function renderInputs() {
  $('tgl-screen').classList.toggle('on', cap.screen.on)
  $('tgl-camera').classList.toggle('on', cap.camera.on)
  $('tgl-mic').classList.toggle('on', cap.mic.on)
  $('tgl-sys').classList.toggle('on', cap.sys.on)
  $('screen-label').textContent = screenLabel
}

async function listDevices(kind: 'videoinput' | 'audioinput') {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const fallback = kind === 'videoinput' ? 'Camera' : 'Microphone'
  return devices.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))
}

// simple on/off toggles
$('tgl-screen').onclick = () => {
  cap.screen.on = !cap.screen.on
  renderInputs()
}
$('tgl-sys').onclick = () => {
  cap.sys.on = !cap.sys.on
  renderInputs()
}
const toggleDevice = (kind: 'camera' | 'mic', deviceKind: 'videoinput' | 'audioinput', what: string) => async () => {
  if (!cap[kind].on && (await listDevices(deviceKind)).length === 0) {
    new Notification(`No ${what} found`, { body: `Connect a ${what} to enable this input` })
    return
  }
  cap[kind].on = !cap[kind].on
  renderInputs()
}
$('tgl-camera').onclick = toggleDevice('camera', 'videoinput', 'camera')
$('tgl-mic').onclick = toggleDevice('mic', 'audioinput', 'microphone')

// screen chooser → the visual picker window (Screens / Windows thumbnails)
$('pick-screen').onclick = async () => {
  closePopover()
  const r = await window.recorderApp.pickScreen(cap.screen.sourceId)
  if (r) {
    cap.screen.sourceId = r.sourceId
    cap.screen.on = true
    screenLabel = r.label.length > 28 ? r.label.slice(0, 28) + '…' : r.label
    renderInputs()
  }
}

// ── camera/mic device popover (opens upward; window grows to fit) ───────────
const pop = $('pop')
const BASE_H = 54
let popKind: 'camera' | 'mic' | null = null

let meterStream: MediaStream | null = null
let meterCtx: AudioContext | null = null
let meterRaf = 0
async function startMeter(deviceId: string | null) {
  stopMeter()
  try {
    meterStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    })
  } catch {
    return // no permission yet — the meter is a bonus, not a blocker
  }
  meterCtx = new AudioContext()
  const analyser = meterCtx.createAnalyser()
  analyser.fftSize = 512
  meterCtx.createMediaStreamSource(meterStream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  const loop = () => {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) {
      const d = (v - 128) / 128
      sum += d * d
    }
    const rms = Math.sqrt(sum / buf.length)
    const fill = pop.querySelector<HTMLElement>('.fill')
    if (fill) fill.style.width = `${Math.min(100, Math.round(rms * 300))}%`
    meterRaf = requestAnimationFrame(loop)
  }
  loop()
}
function stopMeter() {
  cancelAnimationFrame(meterRaf)
  meterStream?.getTracks().forEach((t) => t.stop())
  meterStream = null
  void meterCtx?.close().catch(() => {})
  meterCtx = null
}

function closePopover() {
  if (!popKind) return
  popKind = null
  pop.hidden = true
  stopMeter()
  void window.recorderApp.barHeight(BASE_H)
}

async function openPopover(kind: 'camera' | 'mic', anchor: HTMLElement) {
  if (popKind === kind) return closePopover()
  closePopover()
  popKind = kind
  const devices = await listDevices(kind === 'camera' ? 'videoinput' : 'audioinput')
  if (popKind !== kind) return // closed (Esc/outside click) while enumerating
  const state = cap[kind]

  pop.innerHTML =
    kind === 'mic'
      ? '<div class="meter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/></svg><div class="track"><div class="fill"></div></div></div>'
      : ''
  if (devices.length === 0) {
    pop.insertAdjacentHTML('beforeend', `<div class="none">No ${kind === 'camera' ? 'cameras' : 'microphones'} found</div>`)
  }

  const renderRows = () => {
    pop.querySelectorAll('.row').forEach((r) => r.remove())
    const currentId = state.deviceId ?? devices[0]?.id ?? null
    for (const d of devices) {
      const row = document.createElement('button')
      row.className = 'row'
      row.innerHTML = `<span class="check">${d.id === currentId ? '✓' : ''}</span>`
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = d.label
      row.title = d.label
      row.appendChild(name)
      row.onclick = () => {
        state.deviceId = d.id
        state.on = true
        renderInputs()
        renderRows()
        if (kind === 'mic') void startMeter(d.id)
      }
      pop.appendChild(row)
    }
  }
  renderRows()

  // anchor horizontally near the chevron, clamped to the window
  const rect = anchor.getBoundingClientRect()
  pop.style.left = `${Math.max(6, Math.min(rect.left + rect.width / 2 - 130, window.innerWidth - 266))}px`
  pop.hidden = false
  // grow the window upward so the popover is actually visible
  void window.recorderApp.barHeight(BASE_H + pop.offsetHeight + 14)
  if (kind === 'mic') void startMeter(state.deviceId)
}

$('pick-camera').onclick = () => void openPopover('camera', $('pick-camera'))
$('pick-mic').onclick = () => void openPopover('mic', $('pick-mic'))
document.addEventListener('mousedown', (e) => {
  if (!popKind) return
  const t = e.target as Node
  if (pop.contains(t) || $('pick-camera').contains(t) || $('pick-mic').contains(t)) return
  closePopover()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopover()
})

renderInputs()

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
  if (s !== 'idle') closePopover() // the selectors are idle-only UI
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
  // Camera placement depends on what the screen capture can see:
  //  - full screen → floating PiP bubble; the screen capture films it for free
  //  - a single window → the overlay isn't part of the window's pixels, so the
  //    camera is composited into the recording itself (cameraBubble)
  //  - no screen → the camera IS the video track
  const isWindowSource = cap.screen.sourceId?.startsWith('window:') ?? false
  const cameraAsPip = cap.camera.on && cap.screen.on && !isWindowSource
  const cameraComposited = cap.camera.on && cap.screen.on && isWindowSource
  if (cameraAsPip) await window.recorderApp.pip(true, cap.camera.deviceId)
  try {
    await recorder.start(meeting, {
      capture: {
        screen: cap.screen.on ? { sourceId: cap.screen.sourceId ?? undefined } : false,
        systemAudio: cap.sys.on,
        mic: cap.mic.on ? { deviceId: cap.mic.deviceId ?? undefined } : false,
        camera: cap.camera.on && !cameraAsPip ? { deviceId: cap.camera.deviceId ?? undefined } : false,
        cameraBubble: cameraComposited,
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
