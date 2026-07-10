/**
 * Build-time stub for hybrid web/Electron codebases whose **web build must not
 * ship recording code at all**. Alias `meetcap-renderer` to
 * `meetcap-renderer/stub` in the web bundler config (one line — see the
 * integration playbook) and every entry point keeps its shape:
 * `isBridgeAvailable()` is false, `getCapabilities().mode` is 'unavailable',
 * and anything that would record rejects with `BridgeUnavailableError`.
 */
import type { InterruptedRecording, MeetingInfo, PermissionStatus, RecordingResult } from 'meetcap-core'
import { BridgeUnavailableError } from 'meetcap-capture'
import type { Recorder, CreateRecorderOptions, StartOptions, RendererCapabilities } from './recorder'
import type { DetectorClient, CreateDetectorClientOptions } from './detector'

export type { Recorder, CreateRecorderOptions, StartOptions, RendererCapabilities }
export type { RecorderState, RecordingChunk } from 'meetcap-capture'
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

export function isBridgeAvailable(): boolean {
  return false
}

export async function getCapabilities(): Promise<RendererCapabilities> {
  return { mode: 'unavailable', detection: false, systemAudio: 'none', silentStart: false, persistence: 'none', video: [] }
}

const unavailable = () => Promise.reject(new BridgeUnavailableError('recording is stubbed out of this build'))

export function createRecorder(_options: CreateRecorderOptions = {}): Recorder {
  const handlers = new Set<(err: unknown) => void>()
  const recorder = {
    on(event: string, fn: unknown) {
      if (event === 'error') handlers.add(fn as (err: unknown) => void)
      return recorder
    },
    off(event: string, fn: unknown) {
      if (event === 'error') handlers.delete(fn as (err: unknown) => void)
      return recorder
    },
    async start(_m: MeetingInfo | null = null, _opts: StartOptions = {}) {
      const err = new BridgeUnavailableError('recording is stubbed out of this build')
      handlers.forEach((fn) => fn(err))
      throw err
    },
    pause() {},
    resume() {},
    stop() {},
    state: 'idle' as const,
    recordingKey: null,
    destroy() {
      handlers.clear()
    },
  }
  return recorder as unknown as Recorder
}

export function createDetectorClient(_options: CreateDetectorClientOptions = {}): DetectorClient {
  const client = {
    on: () => client,
    off: () => client,
    current: null,
    isInMeeting: false,
    destroy() {},
  }
  return client as unknown as DetectorClient
}

const NA: PermissionStatus = { platform: 'n/a', screen: 'n/a', microphone: 'n/a', camera: 'n/a' }

export const listInterruptedRecordings = (): Promise<InterruptedRecording[]> => Promise.resolve([])
export const requestPermissions = (): Promise<PermissionStatus> => Promise.resolve(NA)
export const getPermissionStatus = (): Promise<PermissionStatus> => Promise.resolve(NA)
export const openScreenRecordingSettings = (): Promise<void> => Promise.resolve()
export const openPrivacySettings = (_pane: 'screen' | 'microphone' | 'camera'): Promise<void> => Promise.resolve()
export const readRecording = (_filePath: string): Promise<Uint8Array> => unavailable() as Promise<Uint8Array>
export const deleteRecording = (_filePath: string): Promise<void> => unavailable() as Promise<void>
export const recordingExists = (_filePath: string): Promise<boolean> => Promise.resolve(false)

export type { RecordingResult, InterruptedRecording, PermissionStatus, MeetingInfo } from 'meetcap-core'
export type { DetectorClient, CreateDetectorClientOptions } from './detector'
