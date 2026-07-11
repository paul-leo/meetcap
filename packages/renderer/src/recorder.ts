/**
 * Renderer-side recorder — the Electron backend for the shared meetcap-capture
 * engine. Captures microphone + system (loopback) audio, mixes them with the
 * Web Audio API, and (by default) **streams** the webm output to disk
 * chunk-by-chunk via `window.meetcap` — flat memory, crash-safe partial file.
 * Each timeslice is also emitted as a `chunk` event for incremental upload.
 *
 *   import { createRecorder } from 'meetcap-renderer'
 *   const rec = createRecorder()
 *   rec.on('chunk', ({ blob }) => uploadPart(blob))      // optional: segmented upload
 *   rec.on('complete', (r) => console.log(r.filePath))   // whole-file on disk
 *   await rec.start(meeting)
 *   // resume after a crash:  await rec.start(meeting, { resumeKey })
 *
 * Requires `window.meetcap` (see meetcap-core/preload) and `initRecorderMain()`.
 * In a hybrid web/Electron codebase the web build may import this package
 * safely — gate with `isBridgeAvailable()` (start() rejects with
 * `BridgeUnavailableError` when the bridge is missing), or alias the
 * `meetcap-renderer/stub` subpath to drop recording code entirely.
 */
import type { CloseRecordingResult, MeetingInfo, RecordingResult } from 'meetcap-core'
import {
  BridgeUnavailableError,
  createCaptureRecorder,
  type AcquiredStreams,
  type CaptureBackend,
  type CaptureRecorder,
  type RecordingStore,
} from 'meetcap-capture'
import { createCameraBubbleTrack, type CameraBubbleOptions, type CompositeHandle } from './composite'

export { createCameraBubbleTrack, type CameraBubbleOptions, type CompositeHandle } from './composite'

export type { RecorderState, RecordingChunk } from 'meetcap-capture'

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
  /**
   * Composable capture spec — every input is an independent toggle, so any
   * combination works (screen + camera-as-bubble apps toggle camera off here
   * and film their own overlay; podcast apps run mic-only; etc.). Wins over
   * `video` when both are given. Defaults reproduce the classic behavior:
   * `{ screen: <video==='screen'>, systemAudio: true, mic: true, camera: <video==='camera'> }`.
   */
  capture?: CaptureSpec
}

/** Independent input toggles; `true` = on with the default device. */
export interface CaptureSpec {
  /** Record the screen (or a specific screen/window from listWindows()). */
  screen?: boolean | { sourceId?: string }
  /** Capture the other side / system audio (loopback). Default true. */
  systemAudio?: boolean
  /** Capture the microphone (optionally a specific input device). Default true. */
  mic?: boolean | { deviceId?: string }
  /** Record the camera as the video track when `screen` is off. */
  camera?: boolean | { deviceId?: string }
  /**
   * When both `screen` and `camera` are on: composite the camera into the
   * recorded video as a circular picture-in-picture bubble. Meant for WINDOW
   * captures, where a floating overlay window isn't part of the captured
   * pixels. Full-screen captures usually skip this and film an on-screen
   * overlay instead. Default false (screen track wins, camera unused).
   */
  cameraBubble?: boolean | CameraBubbleOptions
}

/**
 * The recorder surface — the shared capture engine specialized to Electron's
 * start options and disk-backed RecordingResult.
 */
export type Recorder = CaptureRecorder<StartOptions, RecordingResult>

/** Whether the `window.meetcap` preload bridge is present in this environment. */
export function isBridgeAvailable(): boolean {
  return typeof window !== 'undefined' && typeof (window as { meetcap?: unknown }).meetcap === 'object'
}

/** Normalize StartOptions (legacy `video` or composable `capture`) into one plan. */
export function resolveCaptureSpec(opts: StartOptions): {
  screen: boolean
  screenSourceId: string | null
  systemAudio: boolean
  mic: boolean
  micDeviceId: string | null
  camera: boolean
  cameraDeviceId: string | null
  cameraBubble: CameraBubbleOptions | null
} {
  const c = opts.capture
  const on = (v: boolean | object | undefined, dflt: boolean) => (v === undefined ? dflt : v !== false)
  const idOf = (v: boolean | { sourceId?: string } | { deviceId?: string } | undefined, key: 'sourceId' | 'deviceId') =>
    (typeof v === 'object' && v !== null && (v as Record<string, string | undefined>)[key]) || null
  if (!c) {
    return {
      screen: opts.video === 'screen',
      screenSourceId: null,
      systemAudio: true,
      mic: true,
      micDeviceId: null,
      camera: opts.video === 'camera',
      cameraDeviceId: null,
      cameraBubble: null,
    }
  }
  return {
    screen: on(c.screen, false),
    screenSourceId: idOf(c.screen, 'sourceId'),
    systemAudio: c.systemAudio !== false,
    mic: on(c.mic, true),
    micDeviceId: idOf(c.mic, 'deviceId'),
    camera: on(c.camera, false),
    cameraDeviceId: idOf(c.camera, 'deviceId'),
    cameraBubble: c.cameraBubble ? (c.cameraBubble === true ? {} : c.cameraBubble) : null,
  }
}

async function buildMixedStream(opts: StartOptions): Promise<AcquiredStreams> {
  if (!isBridgeAvailable()) throw new BridgeUnavailableError()
  const spec = resolveCaptureSpec(opts)
  const owned: MediaStream[] = []
  const stopOwned = () => owned.forEach((s) => s.getTracks().forEach((t) => t.stop()))

  try {
    let mic: MediaStream | null = null
    if (spec.mic) {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: spec.micDeviceId ? { deviceId: { exact: spec.micDeviceId } } : true,
        video: false,
      })
      owned.push(mic)
    }
    // Camera before the display capture, so its native prompt isn't buried
    // behind the loopback flow.
    let camera: MediaStream | null = null
    if (spec.camera) {
      camera = await navigator.mediaDevices.getUserMedia({
        video: spec.cameraDeviceId ? { deviceId: { exact: spec.cameraDeviceId } } : true,
        audio: false,
      })
      owned.push(camera)
    }

    // The display capture serves double duty: the screen video track AND the
    // loopback system audio. It runs when either is wanted.
    let system: MediaStream | null = null
    if (spec.screen || spec.systemAudio) {
      await window.meetcap.setLoopbackSource(spec.screenSourceId)
      await window.meetcap.enableLoopbackAudio()
      try {
        system = await navigator.mediaDevices.getDisplayMedia({
          video: true, // the handler always needs a video source to grant loopback
          audio: spec.systemAudio,
        })
        owned.push(system)
      } finally {
        await window.meetcap.disableLoopbackAudio()
      }
      // Keep the screen track only when the screen is being recorded.
      if (!spec.screen) system.getVideoTracks().forEach((t) => t.stop())
    }

    const screenTrack = spec.screen ? (system?.getVideoTracks()[0] ?? null) : null
    const hasSystemAudio = spec.systemAudio && (system?.getAudioTracks().length ?? 0) > 0

    const audioSources = [
      ...(mic ? [mic] : []),
      ...(system && hasSystemAudio ? [system] : []),
    ]
    const audioTracks = audioSources.flatMap((s) => s.getAudioTracks())

    // screen + camera + cameraBubble → composite the camera into the frame.
    let compositor: CompositeHandle | null = null
    const cameraTrack = camera?.getVideoTracks()[0] ?? null
    if (screenTrack && cameraTrack && spec.cameraBubble) {
      compositor = await createCameraBubbleTrack(screenTrack, cameraTrack, spec.cameraBubble)
    }
    const videoTrack = compositor?.track ?? screenTrack ?? cameraTrack

    // Single audio source: raw track, no AudioContext (also avoids recording
    // silence from a suspended context on programmatic starts).
    let mixedAudioTracks: MediaStreamTrack[]
    let ctx: AudioContext | null = null
    if (audioTracks.length <= 1) {
      mixedAudioTracks = audioTracks
    } else {
      ctx = new AudioContext()
      const dest = ctx.createMediaStreamDestination()
      audioSources.forEach((s) => ctx!.createMediaStreamSource(s).connect(dest))
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
      mixedAudioTracks = dest.stream.getAudioTracks()
    }

    if (mixedAudioTracks.length === 0 && !videoTrack) {
      throw new Error('meetcap: nothing to capture — every input in the capture spec is off')
    }
    const mixed = new MediaStream([...mixedAudioTracks, ...(videoTrack ? [videoTrack] : [])])

    return {
      mixed,
      hasSystemAudio,
      videoSource: screenTrack ? 'screen' : videoTrack ? 'camera' : null,
      cleanup: () => {
        compositor?.stop()
        stopOwned()
        if (ctx) void ctx.close()
      },
    }
  } catch (err) {
    stopOwned()
    throw err
  }
}

// Disk persistence over the preload bridge — one segment per store session.
const bridgeStore: RecordingStore<CloseRecordingResult> = {
  async open(args) {
    if (!isBridgeAvailable()) throw new BridgeUnavailableError()
    const handle = await window.meetcap.openRecording({
      filename: args.filename,
      recordingKey: args.recordingKey,
      meeting: args.meeting,
      mimeType: args.mimeType,
    })
    return {
      recordingKey: handle.recordingKey,
      async writeChunk(_chunkIndex, blob) {
        const buf = await blob.arrayBuffer()
        await window.meetcap.writeRecordingChunk(handle.id, buf)
      },
      close(durationMs) {
        return window.meetcap.closeRecording(handle.id, durationMs)
      },
      // Close the half-open segment so it doesn't linger as a phantom
      // "interrupted" recording after a failed/aborted start.
      async abort() {
        await window.meetcap.closeRecording(handle.id)
      },
    }
  },
}

const electronBackend: CaptureBackend<StartOptions, CloseRecordingResult, RecordingResult> = {
  snapshotPermissions() {
    // No bridge → skip the pre-flight; acquire() raises BridgeUnavailableError.
    if (!isBridgeAvailable()) return Promise.resolve(null)
    return window.meetcap.mediaAccess()
  },
  needsCamera: (opts) => resolveCaptureSpec(opts).camera,
  acquire: (opts) => buildMixedStream(opts),
  store: bridgeStore,
  buildResult: ({ closed, durationMs, mimeType, hasSystemAudio, videoSource, meeting }) => ({
    filePath: closed?.filePath ?? null,
    recordingKey: closed?.recordingKey ?? null,
    segments: closed?.segments ?? [],
    durationMs,
    mimeType,
    hasSystemAudio,
    videoSource: videoSource as 'screen' | 'camera' | null,
    meeting,
  }),
  startTimeoutMsDefault: 15000,
}

export function createRecorder(options: CreateRecorderOptions = {}): Recorder {
  return createCaptureRecorder(electronBackend, {
    filenamePrefix: options.filenamePrefix,
    timesliceMs: options.timesliceMs,
    persist: options.persistToDisk,
    startTimeoutMs: options.startTimeoutMs,
  })
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

/** What this environment can do — hybrid apps gate their recording UI on this. */
export interface RendererCapabilities {
  /** 'electron' when the preload bridge is present; 'unavailable' otherwise (e.g. a web build). */
  mode: 'electron' | 'unavailable'
  detection: boolean
  systemAudio: 'native' | 'none'
  silentStart: boolean
  persistence: 'disk' | 'none'
  video: Array<'screen' | 'camera'>
}

export async function getCapabilities(): Promise<RendererCapabilities> {
  if (!isBridgeAvailable()) {
    return { mode: 'unavailable', detection: false, systemAudio: 'none', silentStart: false, persistence: 'none', video: [] }
  }
  return {
    mode: 'electron',
    detection: true,
    systemAudio: 'native',
    silentStart: true,
    persistence: 'disk',
    video: ['screen', 'camera'],
  }
}
