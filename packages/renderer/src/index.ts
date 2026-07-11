/**
 * meetcap-renderer — the renderer-process half of meetcap: the detector client
 * (subscribes to the main poller) + audio capture (mic + system/loopback audio,
 * mix, record to webm, save via `window.meetcap`). Import this in the renderer
 * only; the main-process half is `meetcap-main`.
 *
 *   import { createDetectorClient, createRecorder } from 'meetcap-renderer'
 *   const detector = createDetectorClient()
 *   const recorder = createRecorder()
 *   detector.on('meeting-detected', (m) => recorder.start(m))
 *
 * Framework hooks: `meetcap-renderer/react`, `meetcap-renderer/vue`.
 * Use only what you need — the detector client and recorder are independent.
 */

// Recorder
export {
  createRecorder,
  listInterruptedRecordings,
  requestPermissions,
  openScreenRecordingSettings,
  openPrivacySettings,
  getPermissionStatus,
  readRecording,
  deleteRecording,
  recordingExists,
  isBridgeAvailable,
  getCapabilities,
  type RendererCapabilities,
  type Recorder,
  type RecorderState,
  type CreateRecorderOptions,
  type StartOptions,
  type CaptureSpec,
  resolveCaptureSpec,
  type RecordingChunk,
  createCameraBubbleTrack,
  type CameraBubbleOptions,
  type CompositeHandle,
} from './recorder'
// Shared engine surface (errors + pure utils) — re-exported from meetcap-capture
// so existing meetcap-renderer imports keep working unchanged.
export {
  PermissionDeniedError,
  StartTimeoutError,
  BridgeUnavailableError,
  type DeniedMedia,
  pickMimeType,
  pickVideoMimeType,
  buildFilename,
  computeDuration,
  deniedMedia,
  withTimeout,
} from 'meetcap-capture'

// Detector client
export {
  createDetectorClient,
  type DetectorClient,
  type CreateDetectorClientOptions,
} from './detector'

export type {
  RecordingResult,
  InterruptedRecording,
  PermissionStatus,
  MeetingInfo,
} from 'meetcap-core'
