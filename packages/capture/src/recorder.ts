/**
 * The shared recording engine — everything about capturing that is NOT
 * environment-specific: the state machine (idle/recording/paused), event
 * fan-out, the start-epoch abort protocol, pause-aware duration accounting,
 * ordered chunk persistence (writeChain), and MediaRecorder wiring.
 *
 * Environments plug in a `CaptureBackend` for the three points that genuinely
 * differ between Electron and the browser:
 *   1. stream acquisition (loopback system audio vs getDisplayMedia/streams)
 *   2. persistence (disk over IPC vs IndexedDB vs memory-only)
 *   3. permission snapshots (macOS TCC vs the Permissions API)
 *
 * Consumers use `meetcap-renderer` (Electron), `meetcap-web` (browser) or
 * `meetcap-client` (runtime negotiation) — this package is their engine.
 */
import type { MeetingInfo, PermissionStatus } from 'meetcap-core'
import { PermissionDeniedError, StartTimeoutError } from './errors'
import { buildFilename, computeDuration, deniedMedia, pickMimeType, pickVideoMimeType, withTimeout } from './util'

export type RecorderState = 'idle' | 'recording' | 'paused'

export interface RecordingChunk {
  /** 0-based chunk index within this segment. */
  index: number
  /** The chunk bytes (upload directly: `fetch(url, { body: blob })`). */
  blob: Blob
  mimeType: string
}

/** Streams handed back by a backend's acquire(). */
export interface AcquiredStreams {
  mixed: MediaStream
  hasSystemAudio: boolean
  /** What the video track shows ('screen' | 'camera' | 'custom'), null = audio-only. */
  videoSource: string | null
  cleanup: () => void
}

export interface StoreOpenArgs {
  filename: string
  recordingKey?: string
  meeting: MeetingInfo | null
  mimeType: string
}

/** Opaque per-segment persistence session (Electron: IPC handle; web: IDB rows). */
export interface StoreSession<TClose> {
  recordingKey: string
  writeChunk(chunkIndex: number, blob: Blob): Promise<void>
  close(durationMs?: number): Promise<TClose>
  /** Best-effort discard of a half-open segment after a failed/aborted start. */
  abort(): Promise<void>
}

export interface RecordingStore<TClose> {
  open(args: StoreOpenArgs): Promise<StoreSession<TClose>>
}

/** Base start options every backend understands; backends extend with their own. */
export interface StartOptionsBase {
  /** Resume an interrupted logical recording — its key from the environment's interrupted list. */
  resumeKey?: string
}

/** Everything a completed recording needs from the engine to assemble a result. */
export interface CompletionInfo<TClose> {
  closed: TClose | null
  durationMs: number
  mimeType: string
  hasSystemAudio: boolean
  videoSource: string | null
  meeting: MeetingInfo | null
  recordingKey: string | null
}

export interface CaptureBackend<TStartOptions extends StartOptionsBase, TClose, TResult> {
  /**
   * Permission snapshot for the fail-fast pre-flight (null = unavailable,
   * pre-flight is skipped and acquisition errors carry the load).
   */
  snapshotPermissions(): Promise<PermissionStatus | null>
  /** Whether these start options need the camera (pre-flight denial scope). */
  needsCamera(opts: TStartOptions): boolean
  /** Acquire and mix the streams for these options. */
  acquire(opts: TStartOptions): Promise<AcquiredStreams>
  /** Persistence, or null for chunk-events-only (in-memory) operation. */
  store: RecordingStore<TClose> | null
  /** Assemble the environment's result type when a recording finalizes. */
  buildResult(info: CompletionInfo<TClose>): TResult
  /** Default start timeout (Electron: hang guard; web: 0 — a picker is open). */
  startTimeoutMsDefault: number
}

export interface CaptureRecorderOptions {
  /** Filename prefix for saved recordings. Default `meetcap`. */
  filenamePrefix?: string
  /** MediaRecorder timeslice in ms (how often a chunk is emitted/flushed). Default 1000. */
  timesliceMs?: number
  /** Persist via the backend's store (when it has one). Default true. */
  persist?: boolean
  /** Reject start() if streams aren't acquired in time; default from the backend; `0` disables. */
  startTimeoutMs?: number
}

type StateHandler = (state: RecorderState) => void
type ChunkHandler = (chunk: RecordingChunk) => void
type ErrorHandler = (err: unknown) => void

export interface CaptureRecorder<TStartOptions extends StartOptionsBase, TResult> {
  on(event: 'statechange', fn: StateHandler): this
  on(event: 'complete', fn: (result: TResult) => void): this
  on(event: 'chunk', fn: ChunkHandler): this
  on(event: 'error', fn: ErrorHandler): this
  /** Unsubscribe a handler added with on() — for shared recorders that outlive a subscriber. */
  off(event: 'statechange', fn: StateHandler): this
  off(event: 'complete', fn: (result: TResult) => void): this
  off(event: 'chunk', fn: ChunkHandler): this
  off(event: 'error', fn: ErrorHandler): this
  /**
   * Start capturing. Rejects (and emits `error`) when the capture can't start —
   * `PermissionDeniedError` when a required OS/browser permission is denied,
   * `StartTimeoutError` when streams never arrive within the timeout.
   */
  start(meeting?: MeetingInfo | null, opts?: TStartOptions): Promise<void>
  /** Pause capturing within the same segment. No-op unless `recording`. */
  pause(): void
  /** Resume a paused capture (same segment). No-op unless `paused`. */
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

export function createCaptureRecorder<TStartOptions extends StartOptionsBase, TClose, TResult>(
  backend: CaptureBackend<TStartOptions, TClose, TResult>,
  options: CaptureRecorderOptions = {},
): CaptureRecorder<TStartOptions, TResult> {
  const prefix = options.filenamePrefix ?? 'meetcap'
  const timesliceMs = options.timesliceMs ?? 1000
  const persist = (options.persist ?? true) && backend.store !== null
  const startTimeoutMs = options.startTimeoutMs ?? backend.startTimeoutMsDefault

  type CompleteHandler = (result: TResult) => void
  const stateHandlers = new Set<StateHandler>()
  const completeHandlers = new Set<CompleteHandler>()
  const chunkHandlers = new Set<ChunkHandler>()
  const errorHandlers = new Set<ErrorHandler>()

  let state: RecorderState = 'idle'
  let mediaRecorder: MediaRecorder | null = null
  let cleanup: (() => void) | null = null
  let session: StoreSession<TClose> | null = null
  let recordingKey: string | null = null
  let chunkIndex = 0
  let startedAt = 0
  let pausedAccumMs = 0 // total of finished pauses
  let pausedAt: number | null = null // start of an in-progress pause (null = recording)
  let meeting: MeetingInfo | null = null
  let hasSystemAudio = false
  let videoSource: string | null = null
  // Serializes persistence writes so chunks land in capture order (webm header first).
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
      return await backend.snapshotPermissions()
    } catch {
      return null
    }
  }

  // Wrap failures that are really permission problems (declined prompt, or a
  // timeout while a permission is denied) into PermissionDeniedError with a
  // fresh snapshot, so callers can explain them without another round-trip.
  const translateStartError = async (err: unknown, needCamera: boolean): Promise<unknown> => {
    if (err instanceof PermissionDeniedError) return err
    const isTimeout = err instanceof StartTimeoutError
    const isNativeDenial =
      typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'NotAllowedError'
    if (!isTimeout && !isNativeDenial) return err
    const perms = await safePermissions()
    const denied = perms ? deniedMedia(perms, needCamera) : []
    if (perms && denied.length > 0) return new PermissionDeniedError(denied, perms, err)
    return isTimeout ? new StartTimeoutError(err.timeoutMs, perms ?? err.permissions) : err
  }

  const recorder: CaptureRecorder<TStartOptions, TResult> = {
    on(event: string, fn: unknown) {
      if (event === 'statechange') stateHandlers.add(fn as StateHandler)
      else if (event === 'complete') completeHandlers.add(fn as CompleteHandler)
      else if (event === 'chunk') chunkHandlers.add(fn as ChunkHandler)
      else errorHandlers.add(fn as ErrorHandler)
      return recorder
    },

    off(event: string, fn: unknown) {
      if (event === 'statechange') stateHandlers.delete(fn as StateHandler)
      else if (event === 'complete') completeHandlers.delete(fn as CompleteHandler)
      else if (event === 'chunk') chunkHandlers.delete(fn as ChunkHandler)
      else errorHandlers.delete(fn as ErrorHandler)
      return recorder
    },

    async start(m = null, opts = {} as TStartOptions) {
      if (state !== 'idle') return
      const epoch = ++startEpoch
      meeting = m
      const needCamera = backend.needsCamera(opts)
      try {
        // Pre-flight: a known-denied permission fails fast instead of letting
        // stream acquisition hang or throw an opaque error later.
        const perms = await safePermissions()
        if (perms) {
          const denied = deniedMedia(perms, needCamera)
          if (denied.length > 0) throw new PermissionDeniedError(denied, perms)
        }
        if (epoch !== startEpoch) return

        const built = await withTimeout(
          backend.acquire(opts),
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

        if (persist && backend.store) {
          const filename = buildFilename(meeting, new Date(), prefix)
          const opened = await backend.store.open({
            filename,
            recordingKey: opts.resumeKey,
            meeting,
            mimeType,
          })
          if (epoch !== startEpoch) {
            built.cleanup()
            if (cleanup === built.cleanup) cleanup = null
            void opened.abort().catch(() => {})
            return
          }
          session = opened
          recordingKey = opened.recordingKey
        } else {
          session = null
          recordingKey = null
        }

        mediaRecorder = new MediaRecorder(built.mixed, { mimeType })
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size === 0) return
          const index = chunkIndex++
          chunkHandlers.forEach((fn) => fn({ index, blob: e.data, mimeType }))
          if (session) {
            const s = session
            writeChain = writeChain.then(() => s.writeChunk(index, e.data))
          }
        }
        mediaRecorder.start(timesliceMs)
        setState('recording')
      } catch (err) {
        const error = await translateStartError(err, needCamera)
        if (epoch === startEpoch) {
          cleanup?.()
          cleanup = null
          hasSystemAudio = false
          videoSource = null
          // Discard a half-open segment so it doesn't linger as a phantom
          // "interrupted" recording.
          const s = session
          session = null
          if (s) void s.abort().catch(() => {})
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
        const s = session
        void writeChain
          .then(() => (s ? s.close(durationMs) : null))
          .then((closed) => {
            const result = backend.buildResult({
              closed,
              durationMs,
              mimeType: mr.mimeType,
              hasSystemAudio,
              videoSource,
              meeting,
              recordingKey: s?.recordingKey ?? null,
            })
            cleanup?.()
            cleanup = null
            mediaRecorder = null
            session = null
            setState('idle')
            completeHandlers.forEach((fn) => fn(result))
          })
          .catch((err) => {
            cleanup?.()
            cleanup = null
            mediaRecorder = null
            session = null
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
