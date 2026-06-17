/**
 * Renderer-side detector client. Subscribes to the main-process broadcast and
 * re-exposes it as a small framework-agnostic event emitter.
 *
 *   import { createDetectorClient } from 'meetcap-renderer'
 *   const detector = createDetectorClient()
 *   detector.on('meeting-detected', (m) => console.log('in', m.app))
 *   detector.on('meeting-ended', () => console.log('out'))
 *
 * Requires `window.meetcap` (see meetcap-core/preload).
 */
import type { MeetingInfo } from 'meetcap-core'

type DetectedHandler = (meeting: MeetingInfo) => void
type EndedHandler = () => void

export interface DetectorClient {
  on(event: 'meeting-detected', fn: DetectedHandler): DetectorClient
  on(event: 'meeting-ended', fn: EndedHandler): DetectorClient
  readonly current: MeetingInfo | null
  readonly isInMeeting: boolean
  destroy(): void
}

export function createDetectorClient(): DetectorClient {
  const detected = new Set<DetectedHandler>()
  const ended = new Set<EndedHandler>()
  let current: MeetingInfo | null = null

  const unsubscribe = window.meetcap.onDetectorEvent((evt) => {
    if (evt.type === 'meeting-detected') {
      current = evt.meeting
      if (evt.meeting) detected.forEach((fn) => fn(evt.meeting as MeetingInfo))
    } else {
      current = null
      ended.forEach((fn) => fn())
    }
  })

  const client: DetectorClient = {
    on(event: 'meeting-detected' | 'meeting-ended', fn: DetectedHandler | EndedHandler) {
      if (event === 'meeting-detected') detected.add(fn as DetectedHandler)
      else ended.add(fn as EndedHandler)
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
