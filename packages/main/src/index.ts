/**
 * meetcap-main — the main-process half of meetcap: meeting detection +
 * recorder setup. Import this in your Electron main process only (it pulls in
 * `desktopCapturer` / `ps-list` / loopback flags — never bundle it into a
 * renderer). The renderer half is `meetcap-renderer`.
 *
 *   import { initRecorderMain, startDetector } from 'meetcap-main'
 *   initRecorderMain()                       // before app.whenReady()
 *   app.whenReady().then(() => startDetector({ require: 'window' }))
 *
 * Use only what you need — detection and recording are independent.
 */

// Recorder (main-process setup: loopback flags + streaming save + media-access)
export { initRecorderMain, type InitRecorderMainOptions } from './recorder'

// Detection (main-process poller + rule engine)
export { startDetector, type StartDetectorOptions, type Detector } from './detector'
export { presets, toMatcher } from './rules'
export {
  matchWindow,
  matchProcess,
  resolveMeeting,
  createDetectionState,
  type DetectorConfig,
} from './engine'

export type { MeetingRule, MeetingInfo, DetectorEvent } from 'meetcap-core'
