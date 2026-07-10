/**
 * Renderer-side detector client. Subscribes to the main-process broadcast and
 * re-exposes it as a small framework-agnostic event emitter.
 *
 *   import { createDetectorClient } from 'meetcap-renderer'
 *   const detector = createDetectorClient()
 *   detector.on('meeting-detected', (m) => console.log('in', m.app, m.meetingId))
 *   detector.on('meeting-ended', (m) => console.log('out', m.meetingId))
 *
 * Requires `window.meetcap` (see meetcap-core/preload).
 */
import type { MeetingInfo } from 'meetcap-core'

type DetectedHandler = (meeting: MeetingInfo) => void
/** Receives the meeting that ended (same `meetingId` as its detected event). */
type EndedHandler = (meeting: MeetingInfo) => void

export interface CreateDetectorClientOptions {
  /**
   * Probe once with detectOnce() on creation; if a meeting is already being
   * tracked, adopt it as `current` and fire `meeting-detected` handlers.
   * Catches the "window created mid-meeting" case where the edge event was
   * broadcast before this client existed. The probe is async (one IPC round
   * trip), so handlers registered right after createDetectorClient() still
   * receive it. Default false.
   */
  syncInitial?: boolean
}

export interface DetectorClient {
  on(event: 'meeting-detected', fn: DetectedHandler): DetectorClient
  on(event: 'meeting-ended', fn: EndedHandler): DetectorClient
  /** Unsubscribe a handler added with on() — for shared clients that outlive a subscriber. */
  off(event: 'meeting-detected', fn: DetectedHandler): DetectorClient
  off(event: 'meeting-ended', fn: EndedHandler): DetectorClient
  readonly current: MeetingInfo | null
  readonly isInMeeting: boolean
  destroy(): void
}

export function createDetectorClient(options: CreateDetectorClientOptions = {}): DetectorClient {
  const detected = new Set<DetectedHandler>()
  const ended = new Set<EndedHandler>()
  let current: MeetingInfo | null = null

  const unsubscribe = window.meetcap.onDetectorEvent((evt) => {
    if (evt.type === 'meeting-detected') {
      current = evt.meeting
      if (evt.meeting) detected.forEach((fn) => fn(evt.meeting))
    } else {
      // An older main may still send meeting: null on ended — fall back to the
      // meeting we were tracking so handlers always receive one.
      const endedMeeting = evt.meeting ?? current
      current = null
      if (endedMeeting) ended.forEach((fn) => fn(endedMeeting))
    }
  })

  if (options.syncInitial) {
    void window.meetcap
      .detectOnce()
      .then((m) => {
        // Only adopt if no edge event beat the probe to it.
        if (m && current === null) {
          current = m
          detected.forEach((fn) => fn(m))
        }
      })
      .catch(() => {
        // best-effort probe — edge events still arrive
      })
  }

  const client: DetectorClient = {
    on(event: 'meeting-detected' | 'meeting-ended', fn: DetectedHandler | EndedHandler) {
      if (event === 'meeting-detected') detected.add(fn as DetectedHandler)
      else ended.add(fn as EndedHandler)
      return client
    },

    off(event: 'meeting-detected' | 'meeting-ended', fn: DetectedHandler | EndedHandler) {
      if (event === 'meeting-detected') detected.delete(fn as DetectedHandler)
      else ended.delete(fn as EndedHandler)
      return client
    },
    get current() {
      return current
    },
    get isInMeeting() {
      return current !== null
    },
    destroy() {
      unsubscribe()
      detected.clear()
      ended.clear()
    },
  }
  return client
}
