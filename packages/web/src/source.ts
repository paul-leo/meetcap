/**
 * Capture-source resolution — the pure half of the web backend, split out so
 * the defaults are unit-testable without media devices.
 */

export type CaptureSource =
  | { kind: 'mic' }
  | { kind: 'display'; mic?: boolean; video?: boolean }
  | { kind: 'camera'; mic?: boolean }
  | { kind: 'streams'; streams: MediaStream[]; mic?: boolean }

export interface SourcePlan {
  wantsMic: boolean
  wantsCamera: boolean
  wantsDisplay: boolean
  /** Keep the display capture's video track in the recording. */
  keepDisplayVideo: boolean
  streams: MediaStream[]
}

/**
 * Resolve a CaptureSource (default `{ kind: 'mic' }`) into an acquisition
 * plan. Notable defaults: display/camera mix the mic in unless told not to;
 * `streams` does NOT (a caller wiring WebRTC remote audio adds its own mic
 * track deliberately — and the zero-permission path must stay zero-prompt).
 */
export function sourcePlan(source: CaptureSource = { kind: 'mic' }): SourcePlan {
  switch (source.kind) {
    case 'mic':
      return { wantsMic: true, wantsCamera: false, wantsDisplay: false, keepDisplayVideo: false, streams: [] }
    case 'display':
      return {
        wantsMic: source.mic ?? true,
        wantsCamera: false,
        wantsDisplay: true,
        keepDisplayVideo: source.video ?? true,
        streams: [],
      }
    case 'camera':
      return { wantsMic: source.mic ?? true, wantsCamera: true, wantsDisplay: false, keepDisplayVideo: false, streams: [] }
    case 'streams':
      return {
        wantsMic: source.mic ?? false,
        wantsCamera: false,
        wantsDisplay: false,
        keepDisplayVideo: false,
        streams: source.streams,
      }
  }
}

/** What the recording's video track shows, for WebRecordingResult.videoSource. */
export function planVideoSource(
  plan: SourcePlan,
  hasVideoTrack: boolean,
): 'screen' | 'camera' | 'custom' | null {
  if (!hasVideoTrack) return null
  if (plan.keepDisplayVideo && plan.wantsDisplay) return 'screen'
  if (plan.wantsCamera) return 'camera'
  return 'custom'
}
