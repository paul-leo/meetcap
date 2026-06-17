/**
 * meetcap-recorder-renderer — renderer-process audio capture.
 *
 * Captures mic + system (loopback) audio, mixes, records to a webm/opus Blob,
 * and saves via `window.meetcap`. Import this in the renderer only; the
 * main-process setup is `meetcap-recorder-main`.
 *
 * Framework hooks: `meetcap-recorder-renderer/react`, `.../vue`.
 */
export {
  createRecorder,
  listInterruptedRecordings,
  type Recorder,
  type RecorderState,
  type CreateRecorderOptions,
  type StartOptions,
  type RecordingChunk,
} from './renderer'
export { pickMimeType, buildFilename } from './util'
export type { RecordingResult, InterruptedRecording } from 'meetcap-core'
