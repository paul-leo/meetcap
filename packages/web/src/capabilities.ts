/**
 * What this environment can do — product UIs gate their recording affordances
 * (and their "install the desktop enhancer" guidance) on this report.
 * Async by design: the P2 desktop-agent probe slots into this call with zero
 * API change (mode becomes 'agent' when a paired local agent is reachable).
 */
export interface WebCapabilities {
  mode: 'web'
  /** Meeting detection needs a native process — never available on the pure web. */
  detection: false
  /** System audio comes from what the user shares (tab / screen), not a silent tap. */
  systemAudio: 'display-share'
  /** Capture always needs a user gesture on the web. */
  silentStart: false
  persistence: 'idb'
  video: Array<'screen' | 'camera'>
}

export async function getCapabilities(): Promise<WebCapabilities> {
  return {
    mode: 'web',
    detection: false,
    systemAudio: 'display-share',
    silentStart: false,
    persistence: 'idb',
    video: ['screen', 'camera'],
  }
}
