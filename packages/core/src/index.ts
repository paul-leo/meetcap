/**
 * meetcap-core — shared types and IPC contract for meetcap-detector / meetcap-recorder.
 *
 * This package is dependency-free (no electron import) so types can be consumed
 * from any process. The preload bridge helper lives in `meetcap-core/preload`.
 */

/** A meeting app matched by the detector. */
export interface MeetingInfo {
  /** Rule id that matched, e.g. "zoom". */
  id: string
  /** Display name, e.g. "Zoom". */
  app: string
  /** The window title that matched (when matched by window). */
  windowName?: string
  /** desktopCapturer source id for the matched window (when available). */
  sourceId?: string
  /** Process name that corroborated the match (when matched by process). */
  process?: string | null
}

/** A detection rule. Built-in `presets` follow this shape; users can add their own. */
export interface MeetingRule {
  /** Stable id, e.g. "zoom". */
  id: string
  /** Display name, e.g. "Zoom". */
  app: string
  /**
   * Window-title matchers. A string is treated as a case-insensitive substring,
   * a RegExp is tested directly, a function receives the raw title.
   */
  window?: Array<RegExp | string> | ((title: string) => boolean)
  /** Process-name matchers, same semantics as `window`. */
  process?: Array<RegExp | string> | ((name: string) => boolean)
}

/** A window/screen source as enumerated by desktopCapturer. */
export interface WindowSource {
  id: string
  name: string
}

/** A running process (subset of ps-list output). */
export interface ProcessInfo {
  name: string
  pid: number
}

/** Result of a single detection pass. `null` means no meeting. */
export type DetectionResult = MeetingInfo | null

/** Edge event broadcast from main → renderer by the detector. */
export interface DetectorEvent {
  type: 'meeting-detected' | 'meeting-ended'
  meeting: MeetingInfo | null
}

/** A finished recording. The audio is already on disk (streamed during capture). */
export interface RecordingResult {
  /** Absolute path of the written file. */
  filePath: string
  durationMs: number
  mimeType: string
  hasSystemAudio: boolean
  meeting: MeetingInfo | null
}

/** A recording handle returned when capture starts (streaming to disk). */
export interface RecordingHandle {
  /** Opaque id used to write chunks and close the recording. */
  id: string
  /** Absolute path the chunks are being appended to. */
  path: string
}

/** macOS media-permission snapshot (other platforms report "n/a"). */
export interface PermissionStatus {
  platform: string
  screen: string
  microphone: string
}

/**
 * The surface exposed on `window.meetcap` by `exposeMeetcapBridge`.
 * Renderer-side packages (`/renderer`, `/react`, `/vue`) depend on this shape.
 */
export interface MeetcapBridge {
  /** One-shot detection (rarely needed; the poller pushes events instead). */
  detectOnce(): Promise<DetectionResult>
  /** Subscribe to detector edge events. Returns an unsubscribe function. */
  onDetectorEvent(cb: (evt: DetectorEvent) => void): () => void
  /** Debug: enumerate all visible windows and screens. */
  listWindows(): Promise<WindowSource[]>
  /** macOS permission status. */
  mediaAccess(): Promise<PermissionStatus>
  /** Open a recording file and start streaming. Returns an id + the path. */
  openRecording(filename: string): Promise<RecordingHandle>
  /** Append one chunk of bytes to an open recording (called per timeslice). */
  writeRecordingChunk(id: string, chunk: ArrayBuffer): Promise<void>
  /** Finalize an open recording; returns the absolute path. */
  closeRecording(id: string): Promise<string>
  /** Enable the loopback display-media handler (electron-audio-loopback). */
  enableLoopbackAudio(): Promise<void>
  /** Disable the loopback display-media handler. */
  disableLoopbackAudio(): Promise<void>
}

declare global {
  interface Window {
    meetcap: MeetcapBridge
  }
}

/**
 * IPC channel names shared by main and renderer. Single source of truth so the
 * two sides never drift. `enable/disableLoopback` are fixed by
 * electron-audio-loopback and MUST stay these exact strings.
 */
export const IPC = {
  detectOnce: 'meetcap:detect-once',
  detectorEvent: 'meetcap:detector-event',
  listWindows: 'meetcap:list-windows',
  mediaAccess: 'meetcap:media-access',
  recordingOpen: 'meetcap:recording-open',
  recordingWrite: 'meetcap:recording-write',
  recordingClose: 'meetcap:recording-close',
  enableLoopback: 'enable-loopback-audio',
  disableLoopback: 'disable-loopback-audio',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
