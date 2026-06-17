/**
 * Renderer-side recorder. Captures microphone + system (loopback) audio, mixes
 * them with the Web Audio API, and (by default) **streams** the webm/opus output
 * to disk chunk-by-chunk via `window.meetcap` — flat memory, crash-safe partial
 * file. Each timeslice is also emitted as a `chunk` event for incremental upload.
 *
 *   import { createRecorder } from 'meetcap-renderer'
 *   const rec = createRecorder()
 *   rec.on('chunk', ({ blob }) => uploadPart(blob))      // optional: segmented upload
 *   rec.on('complete', (r) => console.log(r.filePath))   // whole-file on disk
 *   await rec.start(meeting)
 *   // resume after a crash:  await rec.start(meeting, { resumeKey })
 *
 * Requires `window.meetcap` (see meetcap-core/preload) and `initRecorderMain()`.
 */
import type { MeetingInfo, RecordingResult } from 'meetcap-core'
import { buildFilename, computeDuration, pickMimeType } from './util'

export type RecorderState = 'idle' | 'recording' | 'paused'

export interface RecordingChunk {
  /** 0-based chunk index within this segment. */
  index: number
  /** The chunk bytes (upload directly: `fetch(url, { body: blob })`). */
  blob: Blob
  mimeType: string
}

export interface CreateRecorderOptions {
  /** Filename prefix for saved recordings. Default `meetcap`. */
  filenamePrefix?: string
  /** MediaRecorder timeslice in ms (how often a chunk is emitted/flushed). Default 1000. */
  timesliceMs?: number
  /** Stream to disk (file + manifest + resume). Default true. Set false for upload-only. */
  persistToDisk?: boolean
}

export interface StartOptions {
  /** Resume an interrupted logical recording — its key from listInterruptedRecordings(). */
  resumeKey?: string
}

type StateHandler = (state: RecorderState) => void
type CompleteHandler = (result: RecordingResult) => void
type ChunkHandler = (chunk: RecordingChunk) => void
type ErrorHandler = (err: unknown) => void

export interface Recorder {
  on(event: 'statechange', fn: StateHandler): Recorder
  on(event: 'complete', fn: CompleteHandler): Recorder
  on(event: 'chunk', fn: ChunkHandler): Recorder
  on(event: 'error', fn: ErrorHandler): Recorder
  /** Start capturing. `meeting` names the file; `opts.resumeKey` continues a recording. */
  start(meeting?: MeetingInfo | null, opts?: StartOptions): Promise<void>
  /** Pause capturing within the same segment/file. No-op unless `recording`. */
  pause(): void
  /** Resume a paused capture (same segment/file). No-op unless `paused`. */
  resume(): void
  /** Stop capturing; fires `complete` once the segment is finalized. */
  stop(): void
  readonly state: RecorderState
  /** Logical-recording key of the in-progress/last recording (null if none / not persisting). */
  readonly recordingKey: string | null
  destroy(): void
}

interface MixedStream {
  mixed: MediaStream
  hasSystemAudio: boolean
  cleanup: () => void
}

async function buildMixedStream(): Promise<MixedStream> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

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
  const persistToDisk = options.persistToDisk ?? true
  const stateHandlers = new Set<StateHandler>()
  const completeHandlers = new Set<CompleteHandler>()
  const chunkHandlers = new Set<ChunkHandler>()
  const errorHandlers = new Set<ErrorHandler>()

  let state: RecorderState = 'idle'
  let mediaRecorder: MediaRecorder | null = null
  let cleanup: (() => void) | null = null
  let openId: string | null = null
  let recordingKey: string | null = null
  let chunkIndex = 0
  let startedAt = 0
  let pausedAccumMs = 0 // total of finished pauses
  let pausedAt: number | null = null // start of an in-progress pause (null = recording)
  let meeting: MeetingInfo | null = null
  let hasSystemAudio = false
  // Serializes disk writes so chunks land in capture order (webm header first).
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
      else if (event === 'chunk') chunkHandlers.add(fn as ChunkHandler)
      else errorHandlers.add(fn as ErrorHandler)
      return recorder
    },

    async start(m = null, opts = {}) {
      if (state !== 'idle') return
      meeting = m
      try {
        const built = await buildMixedStream()
        cleanup = built.cleanup
        hasSystemAudio = built.hasSystemAudio
        startedAt = Date.now()
        pausedAccumMs = 0
        pausedAt = null
        chunkIndex = 0
        writeChain = Promise.resolve()
        const mimeType = pickMimeType()

        if (persistToDisk) {
          const filename = buildFilename(meeting, new Date(), prefix)
          const handle = await window.meetcap.openRecording({
            filename,
            recordingKey: opts.resumeKey,
            meeting,
            mimeType,
          })
          openId = handle.id
          recordingKey = handle.recordingKey
        } else {
          openId = null
          recordingKey = null
        }

        mediaRecorder = new MediaRecorder(built.mixed, { mimeType })
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size === 0) return
          const index = chunkIndex++
          chunkHandlers.forEach((fn) => fn({ index, blob: e.data, mimeType }))
          if (openId) {
            const id = openId
            writeChain = writeChain.then(async () => {
              const buf = await e.data.arrayBuffer()
              await window.meetcap.writeRecordingChunk(id, buf)
            })
          }
        }
        mediaRecorder.start(timesliceMs)
        setState('recording')
      } catch (err) {
        emitError(err)
        cleanup?.()
        cleanup = null
        openId = null
      }
    },

    pause() {
      if (state !== 'recording' || mediaRecorder?.state !== 'recording') return
      mediaRecorder.pause()
      pausedAt = Date.now()
      setState('paused')
    },

    resume() {
      if (state !== 'paused' || mediaRecorder?.state !== 'paused') return
      if (pausedAt !== null) pausedAccumMs += Date.now() - pausedAt
      pausedAt = null
      mediaRecorder.resume()
      setState('recording')
    },

    stop() {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') return
      const mr = mediaRecorder
      const durationMs = computeDuration(startedAt, Date.now(), pausedAccumMs, pausedAt)
      mr.onstop = () => {
        const id = openId
        void writeChain
          .then(() => (id ? window.meetcap.closeRecording(id, durationMs) : null))
          .then((closed) => {
            const result: RecordingResult = {
              filePath: closed?.filePath ?? null,
              recordingKey: closed?.recordingKey ?? null,
              segments: closed?.segments ?? [],
              durationMs,
              mimeType: mr.mimeType,
              hasSystemAudio,
              meeting,
            }
            cleanup?.()
            cleanup = null
            mediaRecorder = null
            openId = null
            setState('idle')
            completeHandlers.forEach((fn) => fn(result))
          })
          .catch((err) => {
            cleanup?.()
            cleanup = null
            mediaRecorder = null
            openId = null
            setState('idle')
            emitError(err)
          })
      }
      mr.stop()
    },

    get state() {
      return state
    },

    get recordingKey() {
      return recordingKey
    },

    destroy() {
      this.stop()
      stateHandlers.clear()
      completeHandlers.clear()
      chunkHandlers.clear()
      errorHandlers.clear()
    },
  }
  return recorder
}

/** List interrupted (resumable) recordings. Thin wrapper over the bridge. */
export function listInterruptedRecordings() {
  return window.meetcap.listInterruptedRecordings()
}

/**
 * Pre-flight permissions (mic + screen recording) up front — call at app start
 * or from a settings screen so the first recording isn't blocked by a prompt.
 * Returns the resulting status; on macOS, screen recording may still need the
 * user to toggle it in System Settings + restart (see openScreenRecordingSettings).
 */
export function requestPermissions() {
  return window.meetcap.requestPermissions()
}

/** Open the macOS Screen Recording privacy pane (no-op on other platforms). */
export function openScreenRecordingSettings() {
  return window.meetcap.openScreenRecordingSettings()
}

/** Current permission status without prompting. */
export function getPermissionStatus() {
  return window.meetcap.mediaAccess()
}
