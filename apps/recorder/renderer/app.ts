// meetcap Recorder — panel UI. Everything capture-related is meetcap 0.5.0;
// this file is product glue: tray state, timer, banner, library.
import {
  createDetectorClient,
  createRecorder,
  getPermissionStatus,
  openPrivacySettings,
  deleteRecording,
  PermissionDeniedError,
  type MeetingInfo,
} from 'meetcap-renderer'

declare global {
  interface Window {
    recorderApp: {
      reportState(state: string): void
      reportMeeting(active: boolean): void
      library(): Promise<Array<{ filePath: string; name: string; size: number; mtimeMs: number }>>
      openFolder(): Promise<void>
    }
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLElement

// ── permissions ───────────────────────────────────────────────────────────────
async function refreshPerms() {
  const p = await getPermissionStatus()
  const cls: Record<string, string> = { granted: 'ok', denied: 'bad', restricted: 'bad', 'not-determined': 'warn' }
  const set = (id: string, label: string, v: string) => {
    const el = $(id)
    el.textContent = `${label}: ${v}`
    el.className = 'pill ' + (cls[v] ?? '')
  }
  set('perm-screen', 'screen', p.screen)
  set('perm-mic', 'mic', p.microphone)
}
void refreshPerms()

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
  const btn = $('btn-record') as HTMLButtonElement
  if (s === 'recording') {
    btn.textContent = '■ Stop & save'
    btn.className = 'big danger'
    $('btn-pause').style.display = ''
    $('btn-resume').style.display = 'none'
    startTick()
  } else if (s === 'paused') {
    $('btn-pause').style.display = 'none'
    $('btn-resume').style.display = ''
    stopTick()
  } else {
    btn.textContent = '● Start recording'
    btn.className = 'big'
    $('btn-pause').style.display = 'none'
    $('btn-resume').style.display = 'none'
    stopTick()
  }
})

recorder.on('complete', (r) => {
  elapsed = r.durationMs
  renderTimer()
  status(`saved · ${(r.durationMs / 1000).toFixed(1)}s · systemAudio=${r.hasSystemAudio}${r.videoSource ? ' · ' + r.videoSource : ''}`)
  elapsed = 0
  void refreshLibrary()
})

recorder.on('error', (e) => status('error: ' + ((e as Error)?.message || String(e))))

const status = (t: string) => ($('status-line').textContent = t)

async function startRecording(meeting: MeetingInfo | null) {
  const video = ($('video-source') as HTMLSelectElement).value as '' | 'screen' | 'camera'
  elapsed = 0
  renderTimer()
  status('starting…')
  try {
    await recorder.start(meeting, video ? { video } : {})
    status(video ? `recording ${video} + audio` : 'recording audio')
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      status(`permission denied: ${err.denied.join(', ')} — opening System Settings`)
      for (const pane of err.denied) void openPrivacySettings(pane)
    } else {
      status('start failed: ' + ((err as Error)?.message || String(err)))
    }
    void refreshPerms()
  }
}

$('btn-record').onclick = () => {
  if (recorder.state === 'idle') void startRecording(currentMeeting)
  else recorder.stop()
}
$('btn-pause').onclick = () => recorder.pause()
$('btn-resume').onclick = () => recorder.resume()

// ── meeting detection banner ──────────────────────────────────────────────────
const detector = createDetectorClient({ syncInitial: true })
detector.on('meeting-detected', (m) => {
  currentMeeting = m
  $('banner-app').textContent = m.app
  $('banner').classList.add('show')
  window.recorderApp.reportMeeting(true)
})
detector.on('meeting-ended', (m) => {
  if (currentMeeting && currentMeeting.meetingId !== m.meetingId) return
  currentMeeting = null
  $('banner').classList.remove('show')
  window.recorderApp.reportMeeting(false)
  if (recorder.state !== 'idle') recorder.stop() // meeting over → save
})
$('btn-banner-record').onclick = () => void startRecording(currentMeeting)

// ── library ───────────────────────────────────────────────────────────────────
function fmtSize(n: number) {
  return n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
}

async function refreshLibrary() {
  const items = await window.recorderApp.library()
  $('lib-count').textContent = items.length ? `· ${items.length}` : ''
  const root = $('library')
  root.innerHTML = items.length ? '' : '<div class="k" style="padding-top:8px">no recordings yet — hit record</div>'
  for (const it of items) {
    const div = document.createElement('div')
    div.className = 'item'
    const name = document.createElement('span')
    name.className = 'name'
    name.title = it.name
    name.textContent = `${it.name} · ${fmtSize(it.size)}`
    div.appendChild(name)
    const btn = (label: string, cls: string, fn: () => void) => {
      const b = document.createElement('button')
      b.textContent = label
      b.className = cls
      b.onclick = fn
      div.appendChild(b)
    }
    btn('Play', 'ghost', () => {
      const media = document.createElement(it.name.includes('screen') || it.size > 5 << 20 ? 'video' : 'audio')
      media.controls = true
      media.src = `file://${it.filePath}`
      const player = $('player')
      player.innerHTML = ''
      player.appendChild(media)
    })
    btn('Delete', 'ghost', async () => {
      await deleteRecording(it.filePath)
      $('player').innerHTML = ''
      void refreshLibrary()
    })
    root.appendChild(div)
  }
}
$('btn-refresh').onclick = () => void refreshLibrary()
$('btn-open-folder').onclick = () => void window.recorderApp.openFolder()
void refreshLibrary()
