// meetcap Recorder — panel UI. Everything capture-related is meetcap 0.5.0;
// this file is product glue: mode selection, tray state, timer, banner, library.
// Dev-only: connect harness-fe to the local solo gateway so tests can drive
// the panel (build:dist strips this — the shipped app never reaches for it).
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
      pip(show: boolean): Promise<void>
    }
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const status = (t: string) => ($('status-line').textContent = t)

// ── capture mode (segmented) ──────────────────────────────────────────────────
type Mode = '' | 'screen' | 'camera'
let mode: Mode = 'screen'

const HINTS: Record<Mode, string[]> = {
  screen: ['Screen', 'System audio', 'Microphone'],
  '': ['System audio', 'Microphone'],
  camera: ['Camera', 'Microphone'],
}

let pipOn = false

function renderHint() {
  const chips = HINTS[mode].map((h) => `<span class="chip">${h}</span>`)
  $('capture-hint').innerHTML = chips.join('')
  if (mode === 'screen') {
    const t = document.createElement('span')
    t.className = 'chip toggle' + (pipOn ? ' on' : '')
    t.textContent = pipOn ? '● Camera bubble' : '○ Camera bubble'
    t.title = 'Show your camera in a floating bubble — the screen recording films it'
    t.onclick = () => {
      pipOn = !pipOn
      renderHint()
    }
    $('capture-hint').appendChild(t)
  }
}

for (const el of Array.from(document.querySelectorAll<HTMLElement>('.mode'))) {
  el.onclick = () => {
    document.querySelectorAll('.mode').forEach((m) => m.classList.remove('active'))
    el.classList.add('active')
    mode = (el.dataset.mode ?? '') as Mode
    renderHint()
  }
}
renderHint()

// ── permissions ───────────────────────────────────────────────────────────────
async function refreshPerms() {
  const p = await getPermissionStatus()
  const chips = $('perm-chips')
  chips.innerHTML = ''
  const add = (label: string, v: string, pane: 'screen' | 'microphone') => {
    if (v === 'granted' || v === 'n/a') return // only surface problems
    const c = document.createElement('span')
    c.className = 'chip bad'
    c.textContent = `${label}: ${v === 'not-determined' ? 'needs setup' : v}`
    c.title = 'Open System Settings'
    c.onclick = () => void openPrivacySettings(pane)
    chips.appendChild(c)
  }
  add('Screen', p.screen, 'screen')
  add('Mic', p.microphone, 'microphone')
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
  document.body.classList.toggle('recording', s !== 'idle')
  document.body.classList.toggle('paused', s === 'paused')
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
    void window.recorderApp.pip(false) // recording over → bubble goes away
  }
})

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

recorder.on('complete', (r) => {
  const parts = [fmtDur(r.durationMs)]
  if (r.videoSource) parts.push(r.videoSource === 'screen' ? 'screen' : 'camera')
  if (r.hasSystemAudio) parts.push('system audio')
  status(`Saved · ${parts.join(' · ')}`)
  elapsed = 0
  renderTimer()
  void refreshLibrary()
})

recorder.on('error', (e) => {
  if (!(e instanceof PermissionDeniedError)) status(((e as Error)?.message || String(e)).replace(/^meetcap: /, ''))
})

async function startRecording(meeting: MeetingInfo | null) {
  elapsed = 0
  renderTimer()
  status('')
  if (mode === 'screen' && pipOn) await window.recorderApp.pip(true)
  try {
    await recorder.start(meeting, mode ? { video: mode } : {})
  } catch (err) {
    void window.recorderApp.pip(false)
    if (err instanceof PermissionDeniedError) {
      status(`Permission needed: ${err.denied.join(', ')} — opening System Settings`)
      for (const pane of err.denied) void openPrivacySettings(pane)
    }
    void refreshPerms()
  }
}

$('btn-record').onclick = () => void startRecording(currentMeeting)
$('btn-stop').onclick = () => recorder.stop()
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
const ICONS = {
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13"/></svg>',
}

function fmtSize(n: number) {
  return n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
}
function fmtWhen(ms: number) {
  const d = Date.now() - ms
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return new Date(ms).toLocaleDateString()
}

async function refreshLibrary() {
  const items = await window.recorderApp.library()
  $('lib-count').textContent = items.length ? `(${items.length})` : ''
  const root = $('library')
  root.innerHTML = items.length ? '' : '<div class="empty">No recordings yet</div>'
  for (const it of items) {
    const div = document.createElement('div')
    div.className = 'item'
    div.innerHTML = `
      <div class="thumb">${ICONS.film}</div>
      <div class="meta">
        <div class="t" title="${it.name}">${it.name.replace(/\.webm$/, '')}</div>
        <div class="s">${fmtWhen(it.mtimeMs)} · ${fmtSize(it.size)}</div>
      </div>
      <div class="actions"></div>`
    const actions = div.querySelector('.actions') as HTMLElement
    const btn = (svg: string, cls: string, title: string, fn: () => void) => {
      const b = document.createElement('button')
      b.className = 'icon-btn ' + cls
      b.title = title
      b.innerHTML = svg
      b.onclick = fn
      actions.appendChild(b)
    }
    btn(ICONS.play, '', 'Play', () => {
      const media = document.createElement('video')
      media.controls = true
      media.autoplay = false
      media.src = `file://${it.filePath}`
      const player = $('player')
      player.innerHTML = ''
      player.appendChild(media)
    })
    btn(ICONS.trash, 'danger', 'Delete', async () => {
      await deleteRecording(it.filePath)
      $('player').innerHTML = ''
      void refreshLibrary()
    })
    root.appendChild(div)
  }
}
$('btn-open-folder').onclick = () => void window.recorderApp.openFolder()
void refreshLibrary()
