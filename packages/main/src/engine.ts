import type { MeetingInfo, MeetingRule, ProcessInfo, WindowSource, DetectorEvent } from 'meetcap-core'
import { randomUUID } from 'node:crypto'
import { presets, toMatcher } from './rules'

export interface DetectorConfig {
  /** Rules to match against. Defaults to the built-in `presets`. */
  rules?: MeetingRule[]
  /**
   * Which signal proves "in a meeting". A window title is precise but fragile
   * (a minimized/hidden — or fully occluded — window vanishes from
   * `desktopCapturer`), and enumerating windows needs elevated permissions on
   * macOS; a meeting-only process (`rule.meetingProcess`, e.g. Zoom's
   * `CptHost`) needs no permissions and is robust to all of that.
   *
   * - `'process'` (default): only a `meetingProcess` match counts (window
   *   ignored). Avoids `desktopCapturer` entirely — no screen-recording
   *   permission, no macOS Sequoia picker dialog, no occlusion flicker.
   *   Window detection stays OFF unless you opt in. Note: only rules with a
   *   `meetingProcess` are detectable (of the presets, Zoom).
   * - `'either'`: window **or** meeting-process — broadest rule coverage;
   *   window title is preferred for metadata when present. Opt-in: touches
   *   desktopCapturer.
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
  // Default aligned with startDetector: process-only — detection then needs
  // no window enumeration (permissions) at all. Window signals are opt-in.
  const policy = config.require ?? 'process'
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

  // 'either' (opt-in): window OR meeting-process; prefer richer window metadata.
  if (win) return withProcessCue(win, procs, rules)
  if (procMatch) return fromProcess(procMatch, win)
  return null
}

export interface DetectionStateOptions {
  /** Injectable occurrence-id generator (deterministic tests). Default randomUUID. */
  generateId?: () => string
  /**
   * Grace window (ms) before a disappeared meeting is declared ended. Poll
   * results flicker — a minimized window loses its title, a meeting process
   * blips — and each flicker would otherwise fire a false `meeting-ended`.
   * Within the grace window the same rule id reappearing is the same
   * continuous meeting: same `meetingId`, no events. `0` (default) ends
   * immediately. The ended event fires on the first `update()` at/after the
   * deadline, so worst-case latency is `endGraceMs` + one poll interval.
   */
  endGraceMs?: number
}

/**
 * Edge detector: turns a stream of per-tick results into detected/ended events,
 * minting a unique `meetingId` per meeting **occurrence** (stable across polls,
 * new on every entry). Two consecutive polls are the same occurrence when their
 * rule `id` matches — so metadata churn (window title changes) keeps the id,
 * while an app swap (Zoom → Teams within one interval) yields an ended+detected
 * pair. Known limit: leaving one Zoom call and joining another within a single
 * poll interval is indistinguishable and keeps the same id.
 */
export function createDetectionState(options: DetectionStateOptions = {}) {
  const generateId = options.generateId ?? randomUUID
  const endGraceMs = options.endGraceMs ?? 0
  let current: MeetingInfo | null = null
  // Wall-clock start of the pending disappearance (null = meeting visible).
  // Timestamps are injected via update(result, now) so this stays pure.
  let pendingEndSince: number | null = null
  return {
    /** Feed one detection result; returns 0–2 edge events (swap = ended + detected). */
    update(result: MeetingInfo | null, now: number = Date.now()): DetectorEvent[] {
      if (result === null) {
        if (current === null) return []
        if (endGraceMs > 0) {
          if (pendingEndSince === null) {
            pendingEndSince = now
            return []
          }
          if (now - pendingEndSince < endGraceMs) return []
        }
        const ended = current
        current = null
        pendingEndSince = null
        return [{ type: 'meeting-ended', meeting: ended }]
      }
      if (current === null) {
        current = { ...result, meetingId: generateId() }
        pendingEndSince = null
        return [{ type: 'meeting-detected', meeting: current }]
      }
      if (current.id === result.id) {
        // Same occurrence — refresh metadata, keep its id, cancel any pending
        // end (a reappearance within grace is the same continuous meeting).
        current = { ...result, meetingId: current.meetingId }
        pendingEndSince = null
        return []
      }
      const ended = current
      current = { ...result, meetingId: generateId() }
      pendingEndSince = null
      return [
        { type: 'meeting-ended', meeting: ended },
        { type: 'meeting-detected', meeting: current },
      ]
    },
    /** The tracked occurrence; stays non-null during a pending (grace) end. */
    get current(): MeetingInfo | null {
      return current
    },
  }
}
