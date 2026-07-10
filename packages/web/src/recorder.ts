/**
 * Browser recorder — the web backend for the shared meetcap-capture engine.
 * Captures the mic, camera, a shared tab/window/screen (getDisplayMedia) or
 * caller-provided streams (e.g. WebRTC remote audio), mixes all audio tracks,
 * records to webm, and persists crash-safe to IndexedDB.
 *
 *   import { createRecorder } from 'meetcap-web'
 *   const rec = createRecorder()
 *   rec.on('complete', (r) => upload(await readRecording(r.recordingKey!)))
 *   await rec.start(null, { source: { kind: 'display' } })   // from a real click!
 *
 * Capture caveats the API can't hide (documented, not worked around):
 * - `{ kind: 'display' }` must be called from transient user activation — the
 *   browser shows its share picker every time; there is no silent capture on
 *   the web (that's what the Electron/agent backends are for).
 * - System audio depends on what the user picks: a *tab* shares tab audio
 *   broadly; the *entire screen* shares system audio on Windows/ChromeOS and,
 *   since Chrome 141 on macOS 14.2+, on macOS; a *window* has no audio.
 */
import type { MeetingInfo, PermissionStatus } from 'meetcap-core'
import {
  createCaptureRecorder,
  type AcquiredStreams,
  type CaptureBackend,
  type CaptureRecorder,
  type StartOptionsBase,
} from 'meetcap-capture'
import { getPermissionStatus } from './permissions'
import { planVideoSource, sourcePlan, type CaptureSource } from './source'
import {
  createIdbStore,
  createMemoryStore,
  type WebCloseInfo,
  type WebRecordingStore,
} from './store'

export type { RecorderState, RecordingChunk } from 'meetcap-capture'
export type { CaptureSource }

export interface WebStartOptions extends StartOptionsBase {
  /**
   * What to capture (default `{ kind: 'mic' }`). `{ kind: 'display' }` must be
   * called from a real user gesture — the browser opens its share picker.
   */
  source?: CaptureSource
}

export interface WebRecordingResult {
  recordingKey: string | null
  /** Segment indexes of the logical recording (Electron's analog is file paths). */
  segments: number[]
  durationMs: number
  mimeType: string
  hasSystemAudio: boolean
  videoSource: 'screen' | 'camera' | 'custom' | null
  meeting: MeetingInfo | null
  /**
   * Only with `persist: false` — the whole recording, since nothing persisted
   * it. Persisted recordings: use `readRecording(recordingKey)` instead, which
   * keeps recorder memory flat.
   */
  blob?: Blob
}

export interface WebCreateRecorderOptions {
  /** Filename prefix stored in the manifest (used by download UIs). Default `meetcap`. */
  filenamePrefix?: string
  /** MediaRecorder timeslice in ms (chunk cadence). Default 1000. */
  timesliceMs?: number
  /** Persist to IndexedDB (crash-safe, resumable). Default true; false = memory + result.blob. */
  persist?: boolean
  /**
   * Reject start() if streams aren't acquired in time. Default 0 (disabled) —
   * unlike Electron's hang guard, a pending getDisplayMedia here means the
   * user is looking at the browser's share picker; timing that out would be
   * a bug, not a rescue.
   */
  startTimeoutMs?: number
  /** Injectable persistence (tests; the P2 desktop-agent backend). Default: shared IDB store. */
  store?: WebRecordingStore
}

export type WebRecorder = CaptureRecorder<WebStartOptions, WebRecordingResult>

// One shared IDB store so free functions (read/delete/list) and every
// recorder see the same database.
let defaultStore: WebRecordingStore | null = null
export function getDefaultStore(): WebRecordingStore {
  return (defaultStore ??= createIdbStore())
}

async function buildCaptureStream(source?: CaptureSource): Promise<AcquiredStreams> {
  const plan = sourcePlan(source)
  const owned: MediaStream[] = [] // streams WE acquired (caller-provided ones are not ours to stop)
  const stopOwned = () => owned.forEach((s) => s.getTracks().forEach((t) => t.stop()))

  try {
    let mic: MediaStream | null = null
    if (plan.wantsMic) {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      owned.push(mic)
    }
    let camera: MediaStream | null = null
    if (plan.wantsCamera) {
      camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      owned.push(camera)
    }
    let display: MediaStream | null = null
    if (plan.wantsDisplay) {
      // Must run under transient user activation — the browser shows a picker.
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      owned.push(display)
      if (!plan.keepDisplayVideo) display.getVideoTracks().forEach((t) => t.stop())
    }

    const hasSystemAudio = (display?.getAudioTracks().length ?? 0) > 0
    const audioSources = [
      ...(mic ? [mic] : []),
      ...(display && hasSystemAudio ? [display] : []),
      ...plan.streams.filter((s) => s.getAudioTracks().length > 0),
    ]
    const audioTracks = audioSources.flatMap((s) => s.getAudioTracks())

    const videoTrack =
      (plan.keepDisplayVideo ? display?.getVideoTracks()[0] : undefined) ??
      camera?.getVideoTracks()[0] ??
      plan.streams.flatMap((s) => s.getVideoTracks())[0] ??
      null

    // Single audio source: use the raw track — no AudioContext at all. This
    // matters beyond efficiency: without user activation (e.g. programmatic
    // starts), a fresh AudioContext sits 'suspended' and would record silence.
    if (audioTracks.length <= 1) {
      const tracks = [...(audioTracks[0] ? [audioTracks[0]] : []), ...(videoTrack ? [videoTrack] : [])]
      return {
        mixed: new MediaStream(tracks),
        hasSystemAudio,
        videoSource: planVideoSource(plan, videoTrack !== null),
        cleanup: stopOwned,
      }
    }

    // Multiple sources: mix via Web Audio. The context may start 'suspended'
    // outside user activation — resume is best-effort (browsers allow it when
    // an audio capture is live, which mic/display sources are).
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    audioSources.forEach((s) => ctx.createMediaStreamSource(s).connect(dest))
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})

    const mixed = videoTrack
      ? new MediaStream([...dest.stream.getAudioTracks(), videoTrack])
      : dest.stream

    return {
      mixed,
      hasSystemAudio,
      videoSource: planVideoSource(plan, videoTrack !== null),
      cleanup: () => {
        stopOwned()
        void ctx.close()
      },
    }
  } catch (err) {
    stopOwned()
    throw err
  }
}

function webBackend(store: WebRecordingStore): CaptureBackend<WebStartOptions, WebCloseInfo, WebRecordingResult> {
  return {
    snapshotPermissions(): Promise<PermissionStatus | null> {
      return getPermissionStatus().catch(() => null)
    },
    needsCamera: (opts) => opts.source?.kind === 'camera',
    acquire: (opts) => buildCaptureStream(opts.source),
    store,
    buildResult: ({ closed, durationMs, mimeType, hasSystemAudio, videoSource, meeting }) => ({
      recordingKey: closed?.recordingKey ?? null,
      segments: closed?.segments ?? [],
      durationMs,
      mimeType,
      hasSystemAudio,
      videoSource: videoSource as WebRecordingResult['videoSource'],
      meeting,
      ...(closed?.blob ? { blob: closed.blob } : {}),
    }),
    startTimeoutMsDefault: 0,
  }
}

export function createRecorder(options: WebCreateRecorderOptions = {}): WebRecorder {
  // persist:false still runs through a store — the in-memory one — so the
  // manifest/segment/resume semantics stay identical and close() hands the
  // engine an assembled blob (the only copy of the bytes).
  const store = options.store ?? (options.persist === false ? createMemoryStore() : getDefaultStore())
  return createCaptureRecorder(webBackend(store), {
    filenamePrefix: options.filenamePrefix,
    timesliceMs: options.timesliceMs,
    persist: true,
    startTimeoutMs: options.startTimeoutMs ?? 0,
  })
}

// Free functions over the shared default store (mirror the Electron wrappers).
export const listRecordings = () => getDefaultStore().listManifests()
export const listInterruptedRecordings = () => getDefaultStore().listInterrupted()
export const readSegment = (key: string, segmentIndex: number) => getDefaultStore().readSegment(key, segmentIndex)
export const readRecording = (key: string) => getDefaultStore().readRecording(key)
export const deleteRecording = (key: string) => getDefaultStore().deleteRecording(key)
