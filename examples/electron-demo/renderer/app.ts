// meetcap demo — UI wiring. Consumes meetcap-detector + meetcap-recorder via
// their renderer entries (which talk to the main process over window.meetcap).

// Connect the harness-fe runtime to the local solo gateway so an AI agent can
// inspect/drive this window over MCP (console at http://127.0.0.1:47620/console).
// Port 47620 is meetcap's own — keeps the gateway off harness's default 47729 and
// any other dev server. Solo mode is loopback + tokenless, so this example just
// always instruments. Keep behind a flag if you copy this into a shipping app.
;(window as unknown as { __HARNESS_FE__?: unknown }).__HARNESS_FE__ = {
  projectId: 'meetcap-demo',
  mcpUrl: 'ws://127.0.0.1:47620/ws',
  overlay: true,
}
void import('@harness-fe/runtime')

import { createDetectorClient } from 'meetcap-detector/renderer'
import { createRecorder, listInterruptedRecordings } from 'meetcap-recorder-renderer'
import type { MeetingInfo } from 'meetcap-core'

const $ = (id: string) => document.getElementById(id) as HTMLElement

function log(msg: string) {
  const el = $('log')
  const t = new Date().toISOString().slice(11, 19)
  el.textContent += `[${t}] ${msg}\n`
  el.scrollTop = el.scrollHeight
}

function setPill(el: HTMLElement, text: string, cls = '') {
  el.textContent = text
  el.className = 'pill' + (cls ? ' ' + cls : '')
}

async function refreshPerms() {
  const p = await window.meetcap.mediaAccess()
  const map: Record<string, string> = {
    granted: 'ok', denied: 'bad', restricted: 'bad', 'not-determined': 'warn', 'n/a': '', unknown: 'warn',
  }
  setPill($('perm-screen'), `screen: ${p.screen}`, map[p.screen] ?? 'warn')
  setPill($('perm-mic'), `mic: ${p.microphone}`, map[p.microphone] ?? 'warn')
  log(`platform=${p.platform} screen=${p.screen} mic=${p.microphone}`)
}

const detector = createDetectorClient()
const recorder = createRecorder()
let currentMeeting: MeetingInfo | null = null
let recTimer: ReturnType<typeof setInterval> | null = null
let resumeKey: string | null = null // set when resuming an interrupted recording

// ── banner / recording UI ─────────────────────────────────────────────────────
function showBanner(m: MeetingInfo) {
  currentMeeting = m
  $('banner-app').textContent = m.app
  $('banner').classList.add('show')
  setPill($('det-state'), 'meeting', 'ok')
}
function hideBanner() {
  $('banner').classList.remove('show')
  setPill($('det-state'), 'no meeting')
}
function enterRecordingUI() {
  $('banner-idle-text').style.display = 'none'
  $('banner-rec-text').style.display = ''
  $('btn-start').style.display = 'none'
  $('btn-dismiss').style.display = 'none'
  $('btn-stop-banner').style.display = ''
  const start = Date.now()
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000)
    $('rec-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }, 500)
}
function exitRecordingUI() {
  if (recTimer) { clearInterval(recTimer); recTimer = null }
  $('banner-idle-text').style.display = ''
  $('banner-rec-text').style.display = 'none'
  $('btn-start').style.display = ''
  $('btn-dismiss').style.display = ''
  $('btn-stop-banner').style.display = 'none'
}

// ── recorder events ───────────────────────────────────────────────────────────
recorder.on('statechange', (s) => {
  log(`recorder: ${s}`)
  if (s === 'recording') enterRecordingUI()
  else exitRecordingUI()
  // Reflect state on the standalone record button too.
  ;($('btn-record') as HTMLButtonElement).textContent =
    s === 'recording' ? '■ Stop recording' : '● Record now'
})
recorder.on('error', (e) => log('ERROR: ' + ((e as Error)?.message || String(e))))

// Per-timeslice chunks — this is the segmented-upload firehose. Here we just
// tally them to show the streaming is live; a real app would upload each blob.
let chunkBytes = 0
recorder.on('chunk', ({ index, blob }) => {
  chunkBytes += blob.size
  if (index % 5 === 0) log(`chunk #${index} · ${(chunkBytes / 1024).toFixed(0)} KB streamed so far`)
})

recorder.on('complete', (result) => {
  chunkBytes = 0
  log(
    `complete: ${(result.durationMs / 1000).toFixed(1)}s · systemAudio=${result.hasSystemAudio} · ${result.segments.length} segment(s)`,
  )
  log(`saved → ${result.filePath}`)
  $('result').innerHTML = ''
  if (result.filePath) {
    const audio = document.createElement('audio')
    audio.controls = true
    audio.src = `file://${result.filePath}` // preview from disk (no in-memory blob)
    $('result').appendChild(audio)
  }
  const note = document.createElement('div')
  note.className = 'k'
  note.style.marginTop = '6px'
  note.textContent = result.segments.length
    ? `recording ${result.recordingKey?.slice(0, 8)} · segments:\n${result.segments.join('\n')}`
    : 'no file (persistToDisk off)'
  note.style.whiteSpace = 'pre-wrap'
  $('result').appendChild(note)
})

// ── detector events ───────────────────────────────────────────────────────────
detector.on('meeting-detected', (m) => {
  log(`meeting-detected: ${m.app} — "${m.windowName}" (process: ${m.process ?? 'n/a'})`)
  showBanner(m)
})
detector.on('meeting-ended', () => {
  log('meeting-ended')
  currentMeeting = null
  if (recorder.state === 'recording') recorder.stop()
  hideBanner()
})

// ── buttons ───────────────────────────────────────────────────────────────────
// Start a recording, consuming a pending resumeKey (set by the Resume banner).
function startRecording() {
  const opts = resumeKey ? { resumeKey } : undefined
  if (resumeKey) log(`resuming recording ${resumeKey.slice(0, 8)} (new segment)`)
  void recorder.start(currentMeeting, opts)
  resumeKey = null
}
$('btn-start').onclick = () => startRecording()
$('btn-stop-banner').onclick = () => recorder.stop()
$('btn-dismiss').onclick = () => hideBanner()
$('btn-record').onclick = () =>
  recorder.state === 'recording' ? recorder.stop() : startRecording()
$('btn-list').onclick = async () => {
  const wins = await window.meetcap.listWindows()
  log(`--- ${wins.length} sources ---`)
  wins.forEach((w) => log(`  ${w.id}  ${w.name}`))
}

// ── init ──────────────────────────────────────────────────────────────────────
void refreshPerms()
// Sync initial state in case a meeting is already in progress on load.
window.meetcap.detectOnce().then((m) => {
  if (m) showBanner(m)
  else setPill($('det-state'), 'scanning', 'warn')
})

// Crash recovery: surface recordings that never finalized (process died mid-capture).
void listInterruptedRecordings().then((list) => {
  if (list.length === 0) return
  log(`found ${list.length} interrupted recording(s) from a previous run`)
  const rec = list[0]
  const bar = document.createElement('div')
  bar.className = 'card'
  bar.style.borderColor = '#4a3410'
  bar.innerHTML =
    `<div class="row" style="justify-content:space-between">` +
    `<div>Interrupted recording <strong>${rec.key.slice(0, 8)}</strong> — ${rec.segmentFiles.length} segment(s). Resume?</div>` +
    `<button id="btn-resume">Resume</button></div>`
  document.querySelector('main')!.prepend(bar)
  ;($('btn-resume') as HTMLButtonElement).onclick = () => {
    resumeKey = rec.key
    currentMeeting = rec.meeting
    bar.remove()
    startRecording()
  }
})
