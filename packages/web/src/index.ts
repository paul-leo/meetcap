/**
 * meetcap-web — browser-native recording: mic / camera / shared tab or screen
 * (getDisplayMedia) / caller-provided streams (e.g. WebRTC remote audio),
 * mixed and recorded to webm, persisted crash-safe to IndexedDB.
 *
 *   import { createRecorder, readRecording, deleteRecording } from 'meetcap-web'
 *
 * No Electron required. Hybrid web/Electron codebases: see meetcap-client
 * (runtime negotiation) or meetcap-renderer (Electron-only).
 */
export {
  createRecorder,
  listRecordings,
  listInterruptedRecordings,
  readSegment,
  readRecording,
  deleteRecording,
  getDefaultStore,
  type WebRecorder,
  type WebCreateRecorderOptions,
  type WebStartOptions,
  type WebRecordingResult,
  type CaptureSource,
  type RecorderState,
  type RecordingChunk,
} from './recorder'
export { sourcePlan, planVideoSource, type SourcePlan } from './source'
export {
  createIdbStore,
  createMemoryStore,
  type WebRecordingStore,
  type WebRecordingManifest,
  type WebRecordingSegment,
  type WebCloseInfo,
  type InterruptedWebRecording,
} from './store'
export { getPermissionStatus, requestPermissions, mapPermissionState } from './permissions'
export { getCapabilities, type WebCapabilities } from './capabilities'

// Shared engine surface (errors + pure utils), same names as meetcap-renderer.
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

export type { MeetingInfo, PermissionStatus } from 'meetcap-core'
