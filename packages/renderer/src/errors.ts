/**
 * Typed errors thrown by `recorder.start()`. Both carry the permission
 * snapshot taken at failure time so callers can explain the failure to the
 * user without a second `getPermissionStatus()` round-trip.
 */
import type { PermissionStatus } from 'meetcap-core'

export type DeniedMedia = 'screen' | 'microphone'

/** `start()` failed because an OS media permission is denied or restricted. */
export class PermissionDeniedError extends Error {
  readonly code = 'permission-denied' as const

  constructor(
    /** Which permissions blocked the start. */
    readonly denied: DeniedMedia[],
    /** Permission snapshot at failure time. */
    readonly permissions: PermissionStatus,
    cause?: unknown,
  ) {
    super(`meetcap: permission denied (${denied.join(', ')})`, { cause })
    this.name = 'PermissionDeniedError'
  }
}

/**
 * `start()` did not acquire the audio streams within `startTimeoutMs` — the
 * native layer never called back (e.g. macOS getDisplayMedia left pending)
 * and the permission status doesn't explain why.
 */
export class StartTimeoutError extends Error {
  readonly code = 'start-timeout' as const

  constructor(
    readonly timeoutMs: number,
    /** Permission snapshot at failure time (null if it couldn't be read). */
    readonly permissions: PermissionStatus | null,
  ) {
    super(`meetcap: start() timed out after ${timeoutMs}ms waiting for audio streams`)
    this.name = 'StartTimeoutError'
  }
}
