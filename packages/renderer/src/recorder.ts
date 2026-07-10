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
import type { MeetingInfo, PermissionStatus, RecordingResult } from 'meetcap-core'
import { PermissionDeniedError, StartTimeoutError } from './errors'
import {
  buildFilename,
  computeDuration,
  deniedMedia,
  pickMimeType,
  pickVideoMimeType,
  withTimeout,
} from './util'

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
  /**
   * Backstop for `start()`: reject if the audio streams aren't acquired within
   * this many ms (the native getDisplayMedia layer can hang forever when
   * screen-recording permission is missing — the known-denied case is caught
   * instantly by a permission pre-flight, this covers the rest). Default
   * 15000; `0` disables.
   */
  startTimeoutMs?: number
}

export interface StartOptions {
  /** Resume an interrupted logical recording — its key from listInterruptedRecordings(). */
  resumeKey?: string
  /**
   * Add a video track to the recording (output becomes `video/webm`):
   * - `'screen'` — the user's screen (the same capture that already provides
   *   system audio; no extra permission beyond Screen Recording).
   * - `'camera'` — the user's camera (`getUserMedia`; prompts/needs Camera
   *   permission on first use).
   * Omit for audio-only (the default, previous behavior).
   */
  video?: 'screen' | 'camera'
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
  /** Unsubscribe a handler added with on() — for shared recorders that outlive a subscriber. */
  off(event: 'statechange', fn: StateHandler): Recorder
  off(event: 'complete', fn: CompleteHandler): Recorder
  off(event: 'chunk', fn: ChunkHandler): Recorder
  off(event: 'error', fn: ErrorHandler): Recorder
  /**
   * Start capturing. `meeting` names the file; `opts.resumeKey` continues a
   * recording. Rejects (and emits `error`) when the capture can't start —
   * with `PermissionDeniedError` when an OS media permission is denied, or
   * `StartTimeoutError` when the native layer never delivers the streams.
   */
  start(meeting?: MeetingInfo | null, opts?: StartOptions): Promise<void>
  /** Pause capturing within the same segment/file. No-op unless `recording`. */
  pause(): void
  /** Resume a paused capture (same segment/file). No-op unless `paused`. */
  resume(): void
  /**
   * Stop capturing; fires `complete` once the segment is finalized. Called
   * while a `start()` is still pending, it aborts that start instead.
   */
  stop(): void
  readonly state: RecorderState
  /** Logical-recording key of the in-progress/last recording (null if none / not persisting). */
  readonly recordingKey: string | null
  destroy(): void
}

interface MixedStream {
  mixed: MediaStream
  hasSystemAudio: boolean
  /** The video source actually captured (null = audio-only). */
  videoSource: 'screen' | 'camera' | null
  cleanup: () => void
}

async function buildMixedStream(video?: 'screen' | 'camera'): Promise<MixedStream> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })

  // Camera before the display capture, so its native prompt isn't buried
  // behind the loopback flow; release the mic if it fails.
  let camera: MediaStream | null = null
  if (video === 'camera') {
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    } catch (err) {
      mic.getTracks().forEach((t) => t.stop())
      throw err
    }
  }

  await window.meetcap.enableLoopbackAudio()
  let system: MediaStream
  try {
    system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch (err) {
    mic.getTracks().forEach((t) => t.stop())
    camera?.getTracks().forEach((t) => t.stop())
    throw err
  } finally {
    await window.meetcap.disableLoopbackAudio()
  }
  // The display capture always carries a screen video track (it's how the
  // loopback audio is granted). Keep it when recording the screen; otherwise
  // stop it immediately so no video is captured that wasn't asked for.
  const screenTrack = video === 'screen' ? (system.getVideoTracks()[0] ?? null) : null
  if (!screenTrack) system.getVideoTracks().forEach((t) => t.stop())
  const hasSystemAudio = system.getAudioTracks().length > 0

  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  ctx.createMediaStreamSource(mic).connect(dest)
  if (hasSystemAudio) ctx.createMediaStreamSource(system).connect(dest)

  const videoTrack = screenTrack ?? camera?.getVideoTracks()[0] ?? null
  const mixed = videoTrack
    ? new MediaStream([...dest.stream.getAudioTracks(), videoTrack])
    : dest.stream

  return {
    mixed,
    hasSystemAudio,
    videoSource: videoTrack ? (video ?? null) : null,
    cleanup: () => {
      mic.getTracks().forEach((t) => t.stop())
      system.getTracks().forEach((t) => t.stop())
      camera?.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
  }
}

export function createRecorder(options: CreateRecorderOptions = {}): Recorder {
  const prefix = options.filenamePrefix ?? 'meetcap'
  const timesliceMs = options.timesliceMs ?? 1000
  const persistToDisk = options.persistToDisk ?? true
  const startTimeoutMs = options.startTimeoutMs ?? 15000
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
  let videoSource: 'screen' | 'camera' | null = null
  // Serializes disk writes so chunks land in capture order (webm header first).
  let writeChain: Promise<void> = Promise.resolve()
  // Bumped by every start() and by stop()/destroy() while no recorder exists,
  // so a pending start() notices it was superseded/aborted after each await.
  let startEpoch = 0

  const setState = (s: RecorderState) => {
    state = s
    stateHandlers.forEach((fn) => fn(s))
  }
  const emitError = (err: unknown) => errorHandlers.forEach((fn) => fn(err))

  const safePermissions = async (): Promise<PermissionStatus | null> => {
    try {
      return await window.meetcap.mediaAccess()
    } catch {
      return null
    }
  }

  // Wrap failures that are really permission problems (declined prompt, or a
  // timeout while a permission is denied) into PermissionDeniedError with a
  // fresh snapshot, so callers can explain them without another round-trip.
  const translateStartError = async (err: unknown): Promise<unknown> => {
    if (err instanceof PermissionDeniedError) return err
    const isTimeout = err instanceof StartTimeoutError
    const isNativeDenial =
      typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'NotAllowedError'
    if (!isTimeout && !isNativeDenial) return err
    const perms = await safePermissions()
    const denied = perms ? deniedMedia(perms) : []
    if (perms && denied.length > 0) return new PermissionDeniedError(denied, perms, err)
    return isTimeout ? new StartTimeoutError(err.timeoutMs, perms ?? err.permissions) : err
  }

  const recorder: Recorder = {
    on(event, fn) {
      if (event === 'statechange') stateHandlers.add(fn as StateHandler)
      else if (event === 'complete') completeHandlers.add(fn as CompleteHandler)
      else if (event === 'chunk') chunkHandlers.add(fn as ChunkHandler)
      else errorHandlers.add(fn as ErrorHandler)
      return recorder
    },

    off(event, fn) {
      if (event === 'statechange') stateHandlers.delete(fn as StateHandler)
      else if (event === 'complete') completeHandlers.delete(fn as CompleteHandler)
      else if (event === 'chunk') chunkHandlers.delete(fn as ChunkHandler)
      else errorHandlers.delete(fn as ErrorHandler)
      return recorder
    },

    async start(m = null, opts = {}) {
      if (state !== 'idle') return
      const epoch = ++startEpoch
      meeting = m
      const video = opts.video
      try {
        // Pre-flight: a known-denied permission fails fast instead of letting
        // getDisplayMedia hang (on macOS the loopback display-media handler
        // never calls back when screen recording is denied).
        let perms: PermissionStatus | null = null
        try {
          perms = await window.meetcap.mediaAccess()
        } catch {
          // best-effort gate — the timeout below still covers the hang
        }
        if (perms) {
          const denied = deniedMedia(perms, video === 'camera')
          if (denied.length > 0) throw new PermissionDeniedError(denied, perms)
        }
        if (epoch !== startEpoch) return

        const built = await withTimeout(
          buildMixedStream(video),
          startTimeoutMs,
          () => new StartTimeoutError(startTimeoutMs, perms),
          (late) => late.cleanup(),
        )
        if (epoch !== startEpoch) {
          // Aborted (stop/destroy) or superseded by a newer start(): release
          // our streams without touching the newer session's state.
          built.cleanup()
          return
        }
        cleanup = built.cleanup
        hasSystemAudio = built.hasSystemAudio
        videoSource = built.videoSource
        startedAt = Date.now()
        pausedAccumMs = 0
        pausedAt = null
        chunkIndex = 0
        writeChain = Promise.resolve()
        const mimeType = videoSource ? pickVideoMimeType() : pickMimeType()

        if (persistToDisk) {
          const filename = buildFilename(meeting, new Date(), prefix)
          const handle = await window.meetcap.openRecording({
            filename,
            recordingKey: opts.resumeKey,
            meeting,
            mimeType,
          })
          if (epoch !== startEpoch) {
            built.cleanup()
            if (cleanup === built.cleanup) cleanup = null
            void window.meetcap.closeRecording(handle.id).catch(() => {})
            return
          }
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
        const error = await translateStartError(err)
        if (epoch === startEpoch) {
          cleanup?.()
          cleanup = null
          hasSystemAudio = false
          videoSource = null
          // Close a half-open segment so it doesn't linger as a phantom
          // "interrupted" recording.
          const id = openId
          openId = null
          if (id) void window.meetcap.closeRecording(id).catch(() => {})
        }
        emitError(error)
        throw error
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
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        // No active recording — but a start() may be pending; bumping the
        // epoch makes it abort (and release its streams) at its next check.
        startEpoch++
        return
      }
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
              videoSource,
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

/** Open the macOS Screen Recording privacy pane (no-op on other platforms). Alias of openPrivacySettings('screen'). */
export function openScreenRecordingSettings() {
  return window.meetcap.openScreenRecordingSettings()
}

/**
 * Open the macOS System Settings privacy pane for the given media — pair it
 * with `PermissionDeniedError.denied` to send the user straight to the right
 * switch. Screen recording additionally needs an app restart after toggling.
 * No-op off macOS.
 */
export function openPrivacySettings(pane: 'screen' | 'microphone' | 'camera') {
  return window.meetcap.openPrivacySettings(pane)
}

/** Current permission status without prompting. */
export function getPermissionStatus() {
  return window.meetcap.mediaAccess()
}

/**
 * Read a recording's bytes for upload — e.g.
 * `new File([await readRecording(r.filePath)], name, { type: r.mimeType })`.
 * Restricted to files inside the recordings directory.
 */
export function readRecording(filePath: string) {
  return window.meetcap.readRecording(filePath)
}

/**
 * Delete a recording file (e.g. after a successful upload). Manifests whose
 * segments are all gone are cleaned up with it. Restricted to the recordings
 * directory.
 */
export function deleteRecording(filePath: string) {
  return window.meetcap.deleteRecording(filePath)
}

/** Whether a recording file still exists (check before offering a resume/re-upload). */
export function recordingExists(filePath: string) {
  return window.meetcap.recordingExists(filePath)
}
