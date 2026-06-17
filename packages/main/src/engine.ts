import type { MeetingInfo, MeetingRule, ProcessInfo, WindowSource, DetectorEvent } from 'meetcap-core'
import { presets, toMatcher } from './rules'

export interface DetectorConfig {
  /** Rules to match against. Defaults to the built-in `presets`. */
  rules?: MeetingRule[]
  /**
   * Which signal proves "in a meeting". A window title is precise but fragile
   * (a minimized/hidden window vanishes from `desktopCapturer`); a meeting-only
   * process (`rule.meetingProcess`, e.g. Zoom's `CptHost`) is robust to that.
   *
   * - `'either'` (default): window **or** meeting-process — most robust; window
   *   title is preferred for metadata when present, else the process carries it.
   * - `'process'`: only a `meetingProcess` match counts (window ignored). Best
   *   when the meeting window is often minimized.
   * - `'window'`: only a window-title match; the process is attached as a cue.
   * - `'window+process'`: require BOTH a window title and a `process` of the
   *   SAME rule — strictest, fewest false positives.
   */
  require?: 'either' | 'process' | 'window' | 'window+process'
}

/** First rule whose window matcher hits one of the given sources. */
export function matchWindow(sources: WindowSource[], rules: MeetingRule[]): MeetingInfo | null {
  for (const rule of rules) {
    const test = toMatcher(rule.window)
    const hit = sources.find((s) => test(s.name))
    if (hit) return { id: rule.id, app: rule.app, windowName: hit.name, sourceId: hit.id }
  }
  return null
}

/** First rule whose process matcher hits one of the given processes. */
export function matchProcess(
  procs: ProcessInfo[],
  rules: MeetingRule[],
): { rule: MeetingRule; process: string } | null {
  for (const rule of rules) {
    const test = toMatcher(rule.process)
    const hit = procs.find((p) => test(p.name))
    if (hit) return { rule, process: hit.name }
  }
  return null
}

/**
 * First rule whose **meeting-only** process matcher (`rule.meetingProcess`) hits.
 * This is the "in a meeting" signal that survives a minimized/hidden window.
 * Rules without `meetingProcess` are skipped (they detect by window only).
 */
export function matchMeetingProcess(
  procs: ProcessInfo[],
  rules: MeetingRule[],
): { rule: MeetingRule; process: string } | null {
  for (const rule of rules) {
    if (!rule.meetingProcess) continue
    const test = toMatcher(rule.meetingProcess)
    const hit = procs.find((p) => test(p.name))
    if (hit) return { rule, process: hit.name }
  }
  return null
}

/** Attach the rule's process (if running) to a window match as a confidence cue. */
function withProcessCue(
  win: MeetingInfo,
  procs: ProcessInfo[],
  rules: MeetingRule[],
): MeetingInfo {
  const rule = rules.find((r) => r.id === win.id)
  const test = toMatcher(rule?.process)
  const proc = procs.find((p) => test(p.name))
  return { ...win, process: proc?.name ?? null }
}

/** Build a MeetingInfo from a meeting-process match, reusing window metadata if same rule. */
function fromProcess(match: { rule: MeetingRule; process: string }, win: MeetingInfo | null): MeetingInfo {
  const sameWin = win && win.id === match.rule.id ? win : null
  return {
    id: match.rule.id,
    app: match.rule.app,
    windowName: sameWin?.windowName,
    sourceId: sameWin?.sourceId,
    process: match.process,
  }
}

/**
 * Pure detection: given the current window sources and processes, return the
 * matched meeting (or null). This is what the main-process poller calls each tick.
 */
export function resolveMeeting(
  sources: WindowSource[],
  procs: ProcessInfo[],
  config: DetectorConfig = {},
): MeetingInfo | null {
  const rules = config.rules ?? presets
  const policy = config.require ?? 'either'
  const win = matchWindow(sources, rules)

  if (policy === 'window') {
    return win ? withProcessCue(win, procs, rules) : null
  }

  if (policy === 'window+process') {
    if (!win) return null
    const rule = rules.find((r) => r.id === win.id)
    const test = toMatcher(rule?.process)
    const hit = procs.find((p) => test(p.name))
    return hit ? { ...win, process: hit.name } : null
  }

  // 'process' / 'either' use the meeting-only process as the robust signal.
  const procMatch = matchMeetingProcess(procs, rules)

  if (policy === 'process') {
    return procMatch ? fromProcess(procMatch, win) : null
  }

  // 'either' (default): window OR meeting-process; prefer richer window metadata.
  if (win) return withProcessCue(win, procs, rules)
  if (procMatch) return fromProcess(procMatch, win)
  return null
}

/**
 * Edge detector: turns a stream of per-tick results into detected/ended events.
 * Mirrors the lab's `lastHadMeeting` logic but as a pure, testable unit.
 */
export function createDetectionState() {
  let current: MeetingInfo | null = null
  return {
    /** Feed one detection result; returns an edge event, or null if unchanged. */
    update(result: MeetingInfo | null): DetectorEvent | null {
      const had = current !== null
      const has = result !== null
      if (has && !had) {
        current = result
        return { type: 'meeting-detected', meeting: result }
      }
      if (!has && had) {
        current = null
        return { type: 'meeting-ended', meeting: null }
      }
      current = result
      return null
    },
    get current(): MeetingInfo | null {
      return current
    },
  }
}
