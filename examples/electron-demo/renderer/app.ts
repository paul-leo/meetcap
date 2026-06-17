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
import { createRecorder } from 'meetcap-recorder-renderer'
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
})
recorder.on('error', (e) => log('ERROR: ' + ((e as Error)?.message || String(e))))
recorder.on('complete', (result) => {
  // Streamed straight to disk — the file is already complete on stop.
  log(`complete: ${(result.durationMs / 1000).toFixed(1)}s · systemAudio=${result.hasSystemAudio}`)
  log(`saved → ${result.filePath}`)
  const audio = document.createElement('audio')
  audio.controls = true
  audio.src = `file://${result.filePath}` // preview from disk (no in-memory blob)
  $('result').innerHTML = ''
  $('result').appendChild(audio)
  const note = document.createElement('div')
  note.className = 'k'
  note.style.marginTop = '6px'
  note.textContent = `saved → ${result.filePath}`
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
$('btn-start').onclick = () => recorder.start(currentMeeting)
$('btn-stop-banner').onclick = () => recorder.stop()
$('btn-dismiss').onclick = () => hideBanner()
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
