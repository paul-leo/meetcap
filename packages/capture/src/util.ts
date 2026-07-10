import type { MeetingInfo, PermissionStatus } from 'meetcap-core'
import type { DeniedMedia } from './errors'

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
 * Best supported mime type for recordings WITH a video track (screen/camera).
 * Prefers VP9 (better quality/bitrate), falls back to VP8, then bare webm.
 */
export function pickVideoMimeType(isSupported?: (type: string) => boolean): string {
  const check =
    isSupported ??
    ((type: string) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type))
  for (const t of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']) {
    if (check(t)) return t
  }
  return 'video/webm'
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
 * Which media permissions are hard-blocked (`denied`/`restricted`) in a
 * snapshot. `granted`, `not-determined` (prompt still possible) and `n/a`
 * (non-darwin) are not blocking. Camera is only checked when the recording
 * actually needs it (`needCamera`) — and only if the snapshot reports it
 * (older mains don't).
 */
export function deniedMedia(status: PermissionStatus, needCamera = false): DeniedMedia[] {
  const blocked = (s: string | undefined) => s === 'denied' || s === 'restricted'
  const out: DeniedMedia[] = []
  if (blocked(status.screen)) out.push('screen')
  if (blocked(status.microphone)) out.push('microphone')
  if (needCamera && blocked(status.camera)) out.push('camera')
  return out
}

/**
 * Reject with `makeError()` if `p` doesn't settle within `ms` (`ms <= 0`
 * disables). If `p` resolves after the timeout already fired, `onLate`
 * receives the value so its resources can be released (e.g. stop tracks).
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  makeError: () => Error,
  onLate?: (value: T) => void,
): Promise<T> {
  if (ms <= 0) return p
  return new Promise<T>((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // The raced promise may still settle later — dispose a late value and
      // swallow a late rejection so it doesn't surface as unhandled.
      p.then(
        (v) => onLate?.(v),
        () => {},
      )
      reject(makeError())
    }, ms)
    p.then(
      (v) => {
        if (timedOut) return
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        if (timedOut) return
        clearTimeout(timer)
        reject(e)
      },
    )
  })
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
