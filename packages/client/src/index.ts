/**
 * meetcap-client — runtime negotiation for hybrid web/Electron codebases.
 * One install: records through the Electron backend (loopback system audio,
 * disk persistence, meeting detection) when the `window.meetcap` preload
 * bridge is present, and through the browser backend (getDisplayMedia /
 * streams capture + IndexedDB) everywhere else.
 *
 *   import { createRecorder, getCapabilities, useMeetingDetector } from 'meetcap-client'
 *   const caps = await getCapabilities()   // { mode: 'electron' | 'web', ... }
 *   const rec = createRecorder()           // right backend, same Recorder surface
 *
 * Pure-Electron apps should depend on meetcap-renderer directly (no web code
 * in the bundle); pure-web apps on meetcap-web. This package is for codebases
 * that genuinely run in both.
 */
import type { MeetingInfo, RecordingResult } from 'meetcap-core'
import type { CaptureRecorder } from 'meetcap-capture'
import {
  createRecorder as createElectronRecorder,
  createDetectorClient as createElectronDetectorClient,
  isBridgeAvailable,
  getCapabilities as rendererCapabilities,
  type CreateRecorderOptions as ElectronCreateRecorderOptions,
  type StartOptions as ElectronStartOptions,
  type DetectorClient,
  type CreateDetectorClientOptions,
} from 'meetcap-renderer'
import {
  createRecorder as createWebRecorder,
  getCapabilities as webCapabilities,
  type WebCreateRecorderOptions,
  type WebStartOptions,
  type WebRecordingResult,
  type WebCapabilities,
} from 'meetcap-web'

export { isBridgeAvailable }
export type { DetectorClient, CreateDetectorClientOptions }
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
  type RecorderState,
  type RecordingChunk,
} from 'meetcap-capture'
export type { MeetingInfo, PermissionStatus, RecordingResult } from 'meetcap-core'
export type { WebRecordingResult, CaptureSource } from 'meetcap-web'

/** Union options: Electron reads `video`, web reads `source`; both read `resumeKey`. */
export interface StartOptions extends ElectronStartOptions, WebStartOptions {}
export interface CreateRecorderOptions extends ElectronCreateRecorderOptions, WebCreateRecorderOptions {}

/** Union result — narrow on `filePath` (Electron: string|null) vs `segments: number[]` (web). */
export type ClientRecordingResult = RecordingResult | WebRecordingResult

export type Recorder = CaptureRecorder<StartOptions, ClientRecordingResult>

/** The negotiated backend for this environment. */
export function mode(): 'electron' | 'web' {
  return isBridgeAvailable() ? 'electron' : 'web'
}

export function createRecorder(options: CreateRecorderOptions = {}): Recorder {
  return (mode() === 'electron'
    ? createElectronRecorder(options)
    : createWebRecorder(options)) as unknown as Recorder
}

export interface ClientCapabilities {
  /** 'electron' with the bridge, 'web' without. P2 adds 'agent' (paired desktop app). */
  mode: 'electron' | 'web'
  detection: boolean
  systemAudio: 'native' | 'display-share'
  silentStart: boolean
  persistence: 'disk' | 'idb'
  video: WebCapabilities['video']
}

/**
 * What this environment can do — gate recording UI and the "install the
 * desktop enhancer" guidance on this. Async by design: the P2 local-agent
 * probe slots into this call with zero API change.
 */
export async function getCapabilities(): Promise<ClientCapabilities> {
  if (mode() === 'electron') {
    const caps = await rendererCapabilities()
    return {
      mode: 'electron',
      detection: caps.detection,
      systemAudio: 'native',
      silentStart: caps.silentStart,
      persistence: 'disk',
      video: caps.video,
    }
  }
  const caps = await webCapabilities()
  return {
    mode: 'web',
    detection: false,
    systemAudio: caps.systemAudio,
    silentStart: false,
    persistence: 'idb',
    video: caps.video,
  }
}

/**
 * Meeting detection when available (Electron), an inert client otherwise —
 * `current` stays null and no events fire, so shared code needs no branching.
 */
export function createDetectorClient(options: CreateDetectorClientOptions = {}): DetectorClient {
  if (mode() === 'electron') return createElectronDetectorClient(options)
  const client = {
    on: () => client,
    off: () => client,
    current: null,
    isInMeeting: false,
    destroy() {},
  }
  return client as unknown as DetectorClient
}
