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

async function buildMixedStream(video?: 'screen' | 'camera'): Promise<AcquiredStreams> {
  if (!isBridgeAvailable()) throw new BridgeUnavailableError()
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
  needsCamera: (opts) => opts.video === 'camera',
  acquire: (opts) => buildMixedStream(opts.video),
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
