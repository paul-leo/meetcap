/**
 * meetcap-core — shared types and IPC contract for meetcap-main / meetcap-renderer.
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
  /**
   * Processes that exist ONLY while a meeting is active — not when the client is
   * merely open (e.g. Zoom's `CptHost` / `aomhost`, spawned for a call and torn
   * down when it ends). Same matcher semantics as `window`.
   *
   * This is the strong "in a meeting" signal for the `'process'` and `'either'`
   * policies: it survives the meeting window being minimized/hidden (when
   * `desktopCapturer` can't see the title). A rule with no `meetingProcess` is
   * never detected by process — it relies on window detection only, so put
   * *meeting-scoped* helper names here, never the always-on app process.
   */
  meetingProcess?: Array<RegExp | string> | ((name: string) => boolean)
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

/** A finished recording (one stop() call = one segment of a logical recording). */
export interface RecordingResult {
  /** Absolute path of this segment's file, or null when disk persistence is off. */
  filePath: string | null
  /** Logical-recording id this segment belongs to (null when not persisting). */
  recordingKey: string | null
  /** All segment file paths of the logical recording (for whole/segmented upload). */
  segments: string[]
  durationMs: number
  mimeType: string
  hasSystemAudio: boolean
  meeting: MeetingInfo | null
}

/** Handle returned when a segment starts streaming to disk. */
export interface RecordingHandle {
  /** Opaque id used to write chunks and close this segment. */
  id: string
  /** Absolute path this segment's chunks are appended to. */
  path: string
  /** Logical-recording id (new or resumed). */
  recordingKey: string
  /** 0-based index of this segment within the logical recording. */
  segmentIndex: number
}

/** Arguments to open a recording segment. */
export interface OpenRecordingArgs {
  /** Filename for this segment (e.g. from buildFilename). */
  filename: string
  /** Resume an existing logical recording by key; omit to start a new one. */
  recordingKey?: string
  meeting?: MeetingInfo | null
  mimeType?: string
}

/** Result of closing a segment. */
export interface CloseRecordingResult {
  filePath: string
  recordingKey: string
  /** All segment file paths of the (now finalized) logical recording. */
  segments: string[]
}

/** One segment within a logical recording's manifest. */
export interface RecordingSegment {
  file: string
  startedAt: number
  durationMs?: number
  status: 'active' | 'closed'
}

/** Sidecar manifest tracking a logical recording across segments/restarts. */
export interface RecordingManifest {
  key: string
  meeting: MeetingInfo | null
  mimeType: string
  createdAt: number
  status: 'active' | 'finalized'
  segments: RecordingSegment[]
}

/** A recording that never finalized (process died mid-capture) — resumable. */
export interface InterruptedRecording {
  key: string
  meeting: MeetingInfo | null
  mimeType: string
  /** Absolute paths of all segment files written so far. */
  segmentFiles: string[]
  /** The last (partial-but-playable) segment file. */
  lastSegmentPath: string
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
  /**
   * Pre-flight: request mic + screen-recording permission up front (e.g. at
   * app start / a settings screen) so the first recording isn't blocked by a
   * prompt. On macOS the mic prompt is native; screen recording can't be
   * granted silently — the app is registered in the list and you should send
   * the user to settings (then restart). Returns the resulting status.
   */
  requestPermissions(): Promise<PermissionStatus>
  /** Open the macOS Screen Recording privacy pane (no-op elsewhere). */
  openScreenRecordingSettings(): Promise<void>
  /** Open a recording segment and start streaming (new or resumed). */
  openRecording(args: OpenRecordingArgs): Promise<RecordingHandle>
  /** Append one chunk of bytes to an open segment (called per timeslice). */
  writeRecordingChunk(id: string, chunk: ArrayBuffer): Promise<void>
  /** Finalize a segment + its logical recording; returns paths. */
  closeRecording(id: string, durationMs?: number): Promise<CloseRecordingResult>
  /** List recordings that never finalized (resumable after a crash/exit). */
  listInterruptedRecordings(): Promise<InterruptedRecording[]>
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
  requestPermissions: 'meetcap:request-permissions',
  openScreenSettings: 'meetcap:open-screen-settings',
  recordingOpen: 'meetcap:recording-open',
  recordingWrite: 'meetcap:recording-write',
  recordingClose: 'meetcap:recording-close',
  recordingList: 'meetcap:recording-list',
  enableLoopback: 'enable-loopback-audio',
  disableLoopback: 'disable-loopback-audio',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
