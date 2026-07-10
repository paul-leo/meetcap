import { describe, it, expect } from 'vitest'
import {
  matchWindow,
  matchProcess,
  matchMeetingProcess,
  resolveMeeting,
  createDetectionState,
} from './engine'
import { presets } from './rules'
import type { MeetingRule } from 'meetcap-core'

const win = (name: string, id = 'window:1') => ({ id, name })
const proc = (name: string, pid = 1) => ({ name, pid })

describe('matchWindow', () => {
  it('matches the localized Zoom title "Zoom会议"', () => {
    const m = matchWindow([win('Zoom会议')], presets)
    expect(m?.id).toBe('zoom')
    expect(m?.app).toBe('Zoom')
    expect(m?.windowName).toBe('Zoom会议')
  })

  it('matches English "Zoom Meeting"', () => {
    expect(matchWindow([win('Zoom Meeting')], presets)?.id).toBe('zoom')
  })

  it('does not match a plain browser tab title', () => {
    expect(matchWindow([win('Inbox (3) - Google Chrome')], presets)).toBeNull()
    expect(matchWindow([win('zoom pricing - notes')], presets)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(matchWindow([win('Finder'), win('微信')], presets)).toBeNull()
  })
})

describe('matchProcess', () => {
  it('finds the zoom process', () => {
    expect(matchProcess([proc('zoom.us'), proc('Finder')], presets)?.rule.id).toBe('zoom')
    expect(matchProcess([proc('CptHost')], presets)?.rule.id).toBe('zoom')
  })

  it('returns null when no meeting process is running', () => {
    expect(matchProcess([proc('Finder'), proc('node')], presets)).toBeNull()
  })
})

describe('matchMeetingProcess', () => {
  it('matches Zoom meeting-only helpers (CptHost / aomhost)', () => {
    expect(matchMeetingProcess([proc('CptHost')], presets)?.rule.id).toBe('zoom')
    expect(matchMeetingProcess([proc('aomhost')], presets)?.rule.id).toBe('zoom')
  })

  it('does NOT match the always-on app process (zoom.us) — app open ≠ in a meeting', () => {
    expect(matchMeetingProcess([proc('zoom.us')], presets)).toBeNull()
  })

  it('skips rules without meetingProcess', () => {
    expect(matchMeetingProcess([proc('Teams'), proc('wemeetapp')], presets)).toBeNull()
  })
})

describe('resolveMeeting', () => {
  it('window policy: title alone is enough, process attached as cue', () => {
    const m = resolveMeeting([win('Zoom会议')], [proc('zoom.us')], { require: 'window' })
    expect(m?.id).toBe('zoom')
    expect(m?.process).toBe('zoom.us')
  })

  it('window policy: title without process still matches (process=null)', () => {
    const m = resolveMeeting([win('Zoom会议')], [proc('Finder')], { require: 'window' })
    expect(m?.id).toBe('zoom')
    expect(m?.process).toBeNull()
  })

  it('window+process policy: requires both of the same rule', () => {
    expect(resolveMeeting([win('Zoom会议')], [proc('Finder')], { require: 'window+process' })).toBeNull()
    expect(resolveMeeting([win('Zoom会议')], [proc('zoom.us')], { require: 'window+process' })?.id).toBe('zoom')
  })

  it('process policy: meeting-only process detects with NO window (minimized/hidden)', () => {
    const m = resolveMeeting([], [proc('CptHost')], { require: 'process' })
    expect(m?.id).toBe('zoom')
    expect(m?.process).toBe('CptHost')
    expect(m?.windowName).toBeUndefined()
  })

  it('process policy: app open but not in a meeting (zoom.us only) → null', () => {
    expect(resolveMeeting([], [proc('zoom.us')], { require: 'process' })).toBeNull()
  })

  it('default policy is process: window detection stays OFF unless opted in', () => {
    // A perfect window-title match alone must NOT detect under the default —
    // zoom.us is running but its meeting-only process (CptHost) is not.
    expect(resolveMeeting([win('Zoom会议')], [proc('zoom.us')])).toBeNull()
  })

  it('default policy (process): survives a minimized window via meeting process', () => {
    // window gone, but CptHost alive → still detected
    const m = resolveMeeting([], [proc('CptHost')])
    expect(m?.id).toBe('zoom')
    expect(m?.process).toBe('CptHost')
  })

  it('either policy (opt-in): window present is preferred for metadata (windowName kept)', () => {
    const m = resolveMeeting([win('Zoom会议')], [proc('CptHost')], { require: 'either' })
    expect(m?.id).toBe('zoom')
    expect(m?.windowName).toBe('Zoom会议')
    expect(m?.process).toBe('CptHost')
  })

  it('either policy: app open, no meeting (zoom.us only, no window) → null', () => {
    expect(resolveMeeting([], [proc('zoom.us')], { require: 'either' })).toBeNull()
  })

  it('supports a fully custom rule', () => {
    const rules: MeetingRule[] = [{ id: 'mymeet', app: 'MyMeet', window: [/MyMeet 通话/], process: [/mymeet/i] }]
    const m = resolveMeeting([win('MyMeet 通话中')], [proc('mymeet-helper')], { rules, require: 'either' })
    expect(m?.id).toBe('mymeet')
    expect(m?.app).toBe('MyMeet')
  })

  it('supports a function window matcher', () => {
    const rules: MeetingRule[] = [{ id: 'fn', app: 'Fn', window: (t) => t.includes('SECRET') }]
    expect(resolveMeeting([win('a SECRET call')], [], { rules, require: 'either' })?.id).toBe('fn')
    expect(resolveMeeting([win('nothing')], [], { rules })).toBeNull()
  })
})

describe('createDetectionState', () => {
  // Deterministic occurrence ids: occ-0, occ-1, …
  const stateWithIds = (endGraceMs?: number) => {
    let n = 0
    return createDetectionState({ generateId: () => `occ-${n++}`, endGraceMs })
  }
  const zoom = { id: 'zoom', app: 'Zoom', windowName: 'Zoom会议' }
  const teams = { id: 'teams', app: 'Microsoft Teams', windowName: 'Standup | Teams' }

  it('emits detected (with a minted meetingId) on entry and ended on exit', () => {
    const s = stateWithIds()
    expect(s.update(null)).toEqual([])
    expect(s.update(zoom)).toEqual([
      { type: 'meeting-detected', meeting: { ...zoom, meetingId: 'occ-0' } },
    ])
    expect(s.update(zoom)).toEqual([]) // still in meeting → no repeat
    expect(s.current).toEqual({ ...zoom, meetingId: 'occ-0' })
    expect(s.update(null)).toEqual([
      { type: 'meeting-ended', meeting: { ...zoom, meetingId: 'occ-0' } },
    ])
    expect(s.update(null)).toEqual([])
    expect(s.current).toBeNull()
  })

  it('keeps the meetingId across polls while metadata churns', () => {
    const s = stateWithIds()
    s.update(zoom)
    expect(s.update({ ...zoom, windowName: 'Zoom Meeting — renamed' })).toEqual([])
    expect(s.current?.meetingId).toBe('occ-0')
    expect(s.current?.windowName).toBe('Zoom Meeting — renamed')
  })

  it('mints a fresh meetingId on re-entry', () => {
    const s = stateWithIds()
    s.update(zoom)
    s.update(null)
    const evts = s.update(zoom)
    expect(evts).toHaveLength(1)
    expect(evts[0].meeting.meetingId).toBe('occ-1')
  })

  it('a meeting swap emits ended(old) then detected(new) in one update', () => {
    const s = stateWithIds()
    s.update(zoom)
    expect(s.update(teams)).toEqual([
      { type: 'meeting-ended', meeting: { ...zoom, meetingId: 'occ-0' } },
      { type: 'meeting-detected', meeting: { ...teams, meetingId: 'occ-1' } },
    ])
    expect(s.current?.meetingId).toBe('occ-1')
  })

  it('default generator mints a UUID-shaped id', () => {
    const s = createDetectionState()
    const [evt] = s.update(zoom)
    expect(evt.meeting.meetingId).toMatch(/^[0-9a-f-]{36}$/)
  })

  describe('endGraceMs', () => {
    it('suppresses the ended event until the grace window elapses', () => {
      const s = stateWithIds(5000)
      s.update(zoom, 0)
      expect(s.update(null, 1000)).toEqual([]) // disappearance noticed, grace starts
      expect(s.update(null, 4000)).toEqual([]) // still within grace
      expect(s.current?.meetingId).toBe('occ-0') // meeting still considered active
      expect(s.update(null, 6000)).toEqual([
        { type: 'meeting-ended', meeting: { ...zoom, meetingId: 'occ-0' } },
      ])
      expect(s.current).toBeNull()
    })

    it('a reappearance within grace is the same continuous meeting', () => {
      const s = stateWithIds(5000)
      s.update(zoom, 0)
      s.update(null, 1000)
      expect(s.update(zoom, 3000)).toEqual([]) // revived — no ended, no re-detected
      expect(s.current?.meetingId).toBe('occ-0')
      // ...and a later real end starts a fresh grace window
      s.update(null, 10_000)
      expect(s.update(null, 14_000)).toEqual([])
      expect(s.update(null, 15_000)).toHaveLength(1)
    })

    it('a different meeting during grace ends the old one immediately', () => {
      const s = stateWithIds(5000)
      s.update(zoom, 0)
      s.update(null, 1000)
      expect(s.update(teams, 2000)).toEqual([
        { type: 'meeting-ended', meeting: { ...zoom, meetingId: 'occ-0' } },
        { type: 'meeting-detected', meeting: { ...teams, meetingId: 'occ-1' } },
      ])
    })

    it('grace 0 (default) ends on the next null poll', () => {
      const s = stateWithIds()
      s.update(zoom, 0)
      expect(s.update(null, 1)).toHaveLength(1)
    })
  })
})
