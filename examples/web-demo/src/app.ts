// meetcap-web demo — browser-only recording, no Electron anywhere.

// Connect the harness-fe runtime to the local solo gateway so an AI agent can
// inspect/drive this page over MCP (same gateway as the electron demo, 47620).
// Gated behind a build-time flag: `npm start` instruments, `npm run build` strips.
declare const __HARNESS_ENABLED__: boolean
if (__HARNESS_ENABLED__) {
  ;(window as unknown as { __HARNESS_FE__?: unknown }).__HARNESS_FE__ = {
    projectId: 'meetcap-web-demo',
    mcpUrl: 'ws://127.0.0.1:47620/ws',
    overlay: true,
    consent: 'off', // loopback dev only
  }
  void import('@harness-fe/runtime')
}

import {
  createRecorder,
  getCapabilities,
  getPermissionStatus,
  requestPermissions,
  listRecordings,
  listInterruptedRecordings,
  readRecording,
  deleteRecording,
  PermissionDeniedError,
  type CaptureSource,
  type WebRecordingManifest,
} from 'meetcap-web'

const $ = (id: string) => document.getElementById(id) as HTMLElement

function log(msg: string) {
  const el = $('log')
  const t = new Date().toISOString().slice(11, 19)
  el.textContent += `[${t}] ${msg}\n`
  el.scrollTop = el.scrollHeight
}

function pill(el: HTMLElement, text: string, cls = '') {
  el.textContent = text
  el.className = 'pill' + (cls ? ' ' + cls : '')
}

// ── capabilities + permissions ────────────────────────────────────────────────
void getCapabilities().then((caps) => {
  const row = $('caps-row')
  for (const [k, v] of Object.entries(caps)) {
    const s = document.createElement('span')
    s.className = 'pill'
    s.textContent = `${k}: ${Array.isArray(v) ? v.join('+') : v}`
    row.appendChild(s)
  }
  log(`capabilities: mode=${caps.mode} persistence=${caps.persistence} systemAudio=${caps.systemAudio}`)
})

async function refreshPerms() {
  const p = await getPermissionStatus()
  const map: Record<string, string> = { granted: 'ok', denied: 'bad', 'not-determined': 'warn', unknown: 'warn' }
  pill($('perm-mic'), `mic: ${p.microphone}`, map[p.microphone] ?? '')
  pill($('perm-cam'), `camera: ${p.camera ?? 'unknown'}`, map[p.camera ?? ''] ?? '')
}
void refreshPerms()
$('btn-perms').onclick = async () => {
  await requestPermissions()
  await refreshPerms()
}
$('btn-perms-cam').onclick = async () => {
  await requestPermissions({ camera: true })
  await refreshPerms()
}

// ── recorder ──────────────────────────────────────────────────────────────────
const recorder = createRecorder({ filenamePrefix: 'meetcap-web' })
let chunkCount = 0
let toneStop: (() => void) | null = null

recorder.on('statechange', (s) => {
  pill($('rec-state'), s, s === 'recording' ? 'ok' : '')
  ;($('btn-stop') as HTMLButtonElement).disabled = s === 'idle'
  log(`recorder: ${s}`)
})
recorder.on('chunk', ({ index }) => {
  chunkCount = index + 1
  pill($('rec-chunks'), `chunks: ${chunkCount}`)
})
recorder.on('complete', (r) => {
  log(
    `complete: key=${r.recordingKey?.slice(0, 8)} · ${(r.durationMs / 1000).toFixed(1)}s · ` +
      `systemAudio=${r.hasSystemAudio} · video=${r.videoSource ?? 'none'} · segments=[${r.segments.join(',')}]`,
  )
  toneStop?.()
  toneStop = null
  void refreshList()
})
recorder.on('error', (e) => log('ERROR: ' + ((e as Error)?.message || String(e))))

async function startWith(source: CaptureSource, resumeKey?: string) {
  chunkCount = 0
  pill($('rec-chunks'), 'chunks: 0')
  try {
    await recorder.start(null, { source, ...(resumeKey ? { resumeKey } : {}) })
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      log(`start rejected: ${err.message} (mic=${err.permissions.microphone} cam=${err.permissions.camera})`)
    } else if (err instanceof DOMException && err.name === 'NotAllowedError') {
      log('share picker cancelled (user choice — not a permission problem)')
    } else {
      log('start failed: ' + ((err as Error)?.message || String(err)))
    }
    toneStop?.()
    toneStop = null
  }
}

/**
 * Synthetic source: a quiet 440 Hz tone — zero permissions, automation-friendly.
 * Prefers MediaStreamTrackGenerator (real samples with NO AudioContext, so it
 * works without user activation — synthetic clicks in automation don't count);
 * falls back to Web Audio elsewhere (needs a real gesture there).
 */
function makeToneStream(): MediaStream {
  const Gen = (window as unknown as { MediaStreamTrackGenerator?: new (init: { kind: string }) => MediaStreamTrack & { writable: WritableStream } }).MediaStreamTrackGenerator
  const AudioDataCtor = (window as unknown as { AudioData?: new (init: object) => unknown }).AudioData
  if (Gen && AudioDataCtor) {
    const generator = new Gen({ kind: 'audio' })
    const writer = generator.writable.getWriter()
    const sampleRate = 48000
    const frameSamples = 4800 // 100ms frames
    let ts = 0
    let phase = 0
    const timer = setInterval(() => {
      const data = new Float32Array(frameSamples)
      for (let i = 0; i < frameSamples; i++) {
        data[i] = Math.sin(phase) * 0.05
        phase += (2 * Math.PI * 440) / sampleRate
      }
      const frame = new AudioDataCtor({
        format: 'f32',
        sampleRate,
        numberOfFrames: frameSamples,
        numberOfChannels: 1,
        timestamp: ts,
        data,
      })
      ts += (frameSamples / sampleRate) * 1_000_000
      void writer.write(frame).catch(() => {})
    }, 100)
    toneStop = () => {
      clearInterval(timer)
      void writer.close().catch(() => {})
    }
    log('tone source: MediaStreamTrackGenerator (no AudioContext)')
    return new MediaStream([generator])
  }
  const ctx = new AudioContext()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  gain.gain.value = 0.05
  osc.frequency.value = 440
  const dest = ctx.createMediaStreamDestination()
  osc.connect(gain).connect(dest)
  osc.start()
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  log(`tone source: AudioContext (state=${ctx.state})`)
  toneStop = () => {
    osc.stop()
    void ctx.close()
  }
  return dest.stream
}

$('btn-tone').onclick = () => void startWith({ kind: 'streams', streams: [makeToneStream()] })
$('btn-mic').onclick = () => void startWith({ kind: 'mic' })
$('btn-camera').onclick = () => void startWith({ kind: 'camera' })
$('btn-display').onclick = () => void startWith({ kind: 'display' })
$('btn-stop').onclick = () => recorder.stop()

// ── recordings library ────────────────────────────────────────────────────────
async function refreshList() {
  const [all, interrupted] = await Promise.all([listRecordings(), listInterruptedRecordings()])
  const interruptedKeys = new Set(interrupted.map((r) => r.key))
  const root = $('recordings')
  root.innerHTML = ''
  if (all.length === 0) {
    root.innerHTML = '<div class="k" style="padding-top:8px">no recordings yet</div>'
    return
  }
  for (const m of all.sort((a, b) => b.createdAt - a.createdAt)) {
    root.appendChild(renderItem(m, interruptedKeys.has(m.key)))
  }
}

function renderItem(m: WebRecordingManifest, isInterrupted: boolean): HTMLElement {
  const div = document.createElement('div')
  div.className = 'item'
  div.dataset.key = m.key
  const label = document.createElement('span')
  label.textContent = `${m.key.slice(0, 8)} · ${m.mimeType} · ${m.segments.length} segment(s)`
  div.appendChild(label)
  if (isInterrupted) {
    const b = document.createElement('span')
    b.className = 'badge'
    b.textContent = 'interrupted'
    div.appendChild(b)
  }

  const btn = (text: string, cls: string, fn: () => void) => {
    const b = document.createElement('button')
    b.textContent = text
    b.className = cls
    b.onclick = fn
    div.appendChild(b)
  }
  btn('Play', 'ghost', async () => {
    const blob = await readRecording(m.key)
    log(`readRecording(${m.key.slice(0, 8)}) → ${blob.size} bytes`)
    const media = document.createElement(m.mimeType.startsWith('video') ? 'video' : 'audio')
    media.controls = true
    media.src = URL.createObjectURL(blob)
    const player = $('player')
    player.innerHTML = ''
    player.appendChild(media)
  })
  btn('Download', 'ghost', async () => {
    const blob = await readRecording(m.key)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = m.segments[0]?.filename ?? `${m.key}.webm`
    a.click()
  })
  if (isInterrupted) {
    btn('Resume (tone)', '', () => void startWith({ kind: 'streams', streams: [makeToneStream()] }, m.key))
  }
  btn('Delete', 'danger', async () => {
    await deleteRecording(m.key)
    log(`deleted ${m.key.slice(0, 8)}`)
    void refreshList()
  })
  return div
}

$('btn-refresh').onclick = () => void refreshList()
void refreshList()
