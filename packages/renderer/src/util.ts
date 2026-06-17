import type { MeetingInfo } from 'meetcap-core'

/**
 * Pick the best supported recording mime type. `isSupported` is injectable so
 * this stays unit-testable outside a browser (defaults to MediaRecorder).
 */
export function pickMimeType(isSupported?: (type: string) => boolean): string {
  const check =
    isSupported ??
    ((type: string) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type))
  return check('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
}

/**
 * Real recording duration, excluding any paused time. `pausedAccumMs` is the
 * total of already-finished pauses; `pausedAt` is the start of an in-progress
 * pause (null if currently recording). Passed in (no hidden clock) so it stays
 * deterministic and testable.
 */
export function computeDuration(
  startedAt: number,
  now: number,
  pausedAccumMs: number,
  pausedAt: number | null,
): number {
  const openPause = pausedAt === null ? 0 : Math.max(0, now - pausedAt)
  return Math.max(0, now - startedAt - pausedAccumMs - openPause)
}

/**
 * Build a recording filename: `<prefix>-<app>-<YYYY-MM-DDTHH-MM-SS>.webm`.
 * `date` is passed in (no hidden clock) so this is deterministic and testable.
 */
export function buildFilename(
  meeting: MeetingInfo | null,
  date: Date,
  prefix = 'meetcap',
): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const app = (meeting?.app || 'meeting').replace(/\s+/g, '-')
  return `${prefix}-${app}-${stamp}.webm`
}
