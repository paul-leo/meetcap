import type { MeetingRule } from 'meetcap-core'

/** Compile a rule matcher into a predicate. Strings = case-insensitive substring. */
export function toMatcher(
  matchers: Array<RegExp | string> | ((s: string) => boolean) | undefined,
): (s: string) => boolean {
  if (!matchers) return () => false
  if (typeof matchers === 'function') return matchers
  return (s: string) =>
    matchers.some((m) =>
      typeof m === 'string' ? s.toLowerCase().includes(m.toLowerCase()) : m.test(s),
    )
}

/**
 * Built-in rules for the common native meeting clients. Window-title patterns
 * are the precise "in a meeting" signal; `meetingProcess` is the robust one
 * (survives a minimized/hidden window); `process` corroborates / is a cue.
 * Localized titles are covered (e.g. "Zoom会议", "腾讯会议").
 *
 * `meetingProcess` is only set where a meeting-scoped helper process is known
 * (Zoom). Other clients detect by window until their meeting-only process names
 * are confirmed — add `meetingProcess` to opt them into process detection.
 *
 * Browser-based meetings (Google Meet / Zoom Web in a tab) are intentionally
 * not reliably covered — see the root README "Known limitations".
 */
export const presets: MeetingRule[] = [
  {
    id: 'zoom',
    app: 'Zoom',
    window: [/zoom\s*meeting/i, /zoom\s*会议/i],
    process: [/zoom\.us/i, /\bzoom\b/i, /CptHost/i],
    // Meeting-only helper: spawned for a call, gone when it ends (not when the
    // app is merely open — that's `zoom.us`). Robust to a minimized window.
    // NOTE: `caphost` is Zoom Workplace's capture/screenshot helper — it runs
    // while the app is merely open (e.g. the login screen), so it is NOT a
    // meeting signal and must stay out of this list (false-positive otherwise).
    meetingProcess: [/CptHost/i, /aomhost/i],
  },
  {
    id: 'teams',
    app: 'Microsoft Teams',
    window: [/microsoft teams.*call/i, /teams.*meeting/i],
    process: [/Teams/i, /ms-teams/i],
  },
  {
    id: 'tencent',
    app: '腾讯会议',
    window: [/腾讯会议.*通话/, /腾讯会议/, /voov meeting/i],
    process: [/wemeetapp/i, /WeMeet/i, /腾讯会议/],
  },
  {
    id: 'lark',
    app: '飞书 / Lark',
    window: [/飞书.*会议/, /lark.*meeting/i],
    process: [/Lark/i, /Feishu/i, /飞书/],
  },
]
