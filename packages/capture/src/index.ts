/**
 * meetcap-capture — the shared, backend-agnostic recording engine behind
 * meetcap-renderer (Electron) and meetcap-web (browser). Application code
 * usually consumes one of those (or meetcap-client for runtime negotiation)
 * rather than this package directly; import from here when building a custom
 * backend (e.g. the future desktop-agent transport).
 */
export {
  createCaptureRecorder,
  type CaptureRecorder,
  type CaptureBackend,
  type CaptureRecorderOptions,
  type RecorderState,
  type RecordingChunk,
  type AcquiredStreams,
  type RecordingStore,
  type StoreSession,
  type StoreOpenArgs,
  type StartOptionsBase,
  type CompletionInfo,
} from './recorder'
export {
  PermissionDeniedError,
  StartTimeoutError,
  BridgeUnavailableError,
  type DeniedMedia,
} from './errors'
export {
  pickMimeType,
  pickVideoMimeType,
  buildFilename,
  computeDuration,
  deniedMedia,
  withTimeout,
} from './util'
