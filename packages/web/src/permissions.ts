/**
 * Browser-flavored permission snapshots. Maps the Permissions API onto the
 * same PermissionStatus vocabulary the Electron side uses, so consumers (and
 * `deniedMedia`) render both identically:
 *   granted → 'granted' · denied → 'denied' · prompt → 'not-determined'
 * `screen` is always 'unknown' — display-capture isn't reliably queryable;
 * the user answers the browser's picker per capture instead.
 */
import type { PermissionStatus } from 'meetcap-core'

type QueryFn = (name: string) => Promise<{ state: string }>

const defaultQuery: QueryFn = (name) =>
  navigator.permissions.query({ name: name as PermissionName })

export function mapPermissionState(state: string): string {
  if (state === 'granted') return 'granted'
  if (state === 'denied') return 'denied'
  if (state === 'prompt') return 'not-determined'
  return 'unknown'
}

/** Current permission status without prompting. `query` is injectable for tests. */
export async function getPermissionStatus(query: QueryFn = defaultQuery): Promise<PermissionStatus> {
  const probe = async (name: string) => {
    try {
      return mapPermissionState((await query(name)).state)
    } catch {
      return 'unknown' // Permissions API absent (older Safari) or name unsupported
    }
  }
  const [microphone, camera] = await Promise.all([probe('microphone'), probe('camera')])
  return { platform: 'web', screen: 'unknown', microphone, camera }
}

/**
 * Pre-flight the native prompts by probing getUserMedia (tracks are stopped
 * immediately). Mic always; camera only when asked — an unexplained camera
 * prompt erodes trust. Returns the resulting snapshot.
 */
export async function requestPermissions(opts: { camera?: boolean } = {}): Promise<PermissionStatus> {
  const probe = async (constraints: MediaStreamConstraints) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      // denial is reflected in the snapshot below
    }
  }
  await probe({ audio: true })
  if (opts.camera) await probe({ video: true })
  return getPermissionStatus()
}
