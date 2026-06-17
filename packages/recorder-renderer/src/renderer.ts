/**
 * Renderer-side recorder. Captures microphone + system (loopback) audio, mixes
 * them with the Web Audio API, and **streams** the webm/opus output to disk
 * chunk-by-chunk via `window.meetcap` — so memory stays flat regardless of
 * recording length, and a mid-session crash leaves a partial-but-playable file.
 *
 *   import { createRecorder } from 'meetcap-recorder-renderer'
 *   const rec = createRecorder()
 *   rec.on('complete', (r) => console.log('saved to', r.filePath))
 *   await rec.start(meeting)
 *   // …later: rec.stop()
 *
 * Requires `window.meetcap` (see meetcap-core/preload) and the main process to
 * have called `initRecorderMain()`.
 */
import type { MeetingInfo, RecordingResult } from 'meetcap-core'
import { buildFilename, pickMimeType } from './util'

export type RecorderState = 'idle' | 'recording'

export interface CreateRecorderOptions {
  /** Filename prefix for saved recordings. Default `meetcap`. */
  filenamePrefix?: string
  /** MediaRecorder timeslice in ms (how often a chunk is flushed to disk). Default 1000. */
  timesliceMs?: number
}

type StateHandler = (state: RecorderState) => void
type CompleteHandler = (result: RecordingResult) => void
type ErrorHandler = (err: unknown) => void

export interface Recorder {
  on(event: 'statechange', fn: StateHandler): Recorder
  on(event: 'complete', fn: CompleteHandler): Recorder
  on(event: 'error', fn: ErrorHandler): Recorder
  /** Start capturing. `meeting` is attached to the result and names the file. */
  start(meeting?: MeetingInfo | null): Promise<void>
  /** Stop capturing; fires `complete` once the file is finalized on disk. */
  stop(): void
  readonly state: RecorderState
  destroy(): void
}

interface MixedStream {
  mixed: MediaStream
  hasSystemAudio: boolean
  cleanup: () => void
}

async function buildMixedStream(): Promise<MixedStream> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

  // electron-audio-loopback: enable the loopback display-media handler, capture,
  // then disable. We ask for video (required to trigger the handler) and drop it.
  await window.meetcap.enableLoopbackAudio()
  let system: MediaStream
  try {
    system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } finally {
    await window.meetcap.disableLoopbackAudio()
  }
  system.getVideoTracks().forEach((t) => t.stop())
  const hasSystemAudio = system.getAudioTracks().length > 0

  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  ctx.createMediaStreamSource(mic).connect(dest)
  if (hasSystemAudio) ctx.createMediaStreamSource(system).connect(dest)

  return {
    mixed: dest.stream,
    hasSystemAudio,
    cleanup: () => {
      mic.getTracks().forEach((t) => t.stop())
      system.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
  }
}

export function createRecorder(options: CreateRecorderOptions = {}): Recorder {
  const prefix = options.filenamePrefix ?? 'meetcap'
  const timesliceMs = options.timesliceMs ?? 1000
  const stateHandlers = new Set<StateHandler>()
  const completeHandlers = new Set<CompleteHandler>()
  const errorHandlers = new Set<ErrorHandler>()

  let state: RecorderState = 'idle'
  let mediaRecorder: MediaRecorder | null = null
  let cleanup: (() => void) | null = null
  let recordingId: string | null = null
  let filePath = ''
  let startedAt = 0
  let meeting: MeetingInfo | null = null
  let hasSystemAudio = false
  // Serializes chunk writes so they reach disk in capture order (webm requires
  // the header chunk first). Each ondataavailable links onto this chain.
  let writeChain: Promise<void> = Promise.resolve()

  const setState = (s: RecorderState) => {
    state = s
    stateHandlers.forEach((fn) => fn(s))
  }
  const emitError = (err: unknown) => errorHandlers.forEach((fn) => fn(err))

  const recorder: Recorder = {
    on(event, fn) {
      if (event === 'statechange') stateHandlers.add(fn as StateHandler)
      else if (event === 'complete') completeHandlers.add(fn as CompleteHandler)
      else errorHandlers.add(fn as ErrorHandler)
      return recorder
    },

    async start(m = null) {
      if (mediaRecorder?.state === 'recording') return
      meeting = m
      try {
        const built = await buildMixedStream()
        cleanup = built.cleanup
        hasSystemAudio = built.hasSystemAudio
        startedAt = Date.now()
        writeChain = Promise.resolve()

        const filename = buildFilename(meeting, new Date(), prefix)
        const handle = await window.meetcap.openRecording(filename)
        recordingId = handle.id
        filePath = handle.path

        const mimeType = pickMimeType()
        mediaRecorder = new MediaRecorder(built.mixed, { mimeType })
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size === 0 || !recordingId) return
          const id = recordingId
          // Append to the write chain → ordered, one chunk in flight at a time.
          writeChain = writeChain.then(async () => {
            const buf = await e.data.arrayBuffer()
            await window.meetcap.writeRecordingChunk(id, buf)
          })
        }
        mediaRecorder.start(timesliceMs)
        setState('recording')
      } catch (err) {
        emitError(err)
        cleanup?.()
        cleanup = null
        recordingId = null
      }
    },

    stop() {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return
      const mr = mediaRecorder
      mr.onstop = () => {
        const id = recordingId
        void writeChain
          .then(() => (id ? window.meetcap.closeRecording(id) : filePath))
          .then((savedPath) => {
            const result: RecordingResult = {
              filePath: savedPath || filePath,
              durationMs: Date.now() - startedAt,
              mimeType: mr.mimeType,
              hasSystemAudio,
              meeting,
            }
            cleanup?.()
            cleanup = null
            mediaRecorder = null
            recordingId = null
            setState('idle')
            completeHandlers.forEach((fn) => fn(result))
          })
          .catch((err) => {
            cleanup?.()
            cleanup = null
            mediaRecorder = null
            recordingId = null
            setState('idle')
            emitError(err)
          })
      }
      mr.stop()
    },

    get state() {
      return state
    },

    destroy() {
      this.stop()
      stateHandlers.clear()
      completeHandlers.clear()
      errorHandlers.clear()
    },
  }
  return recorder
}
