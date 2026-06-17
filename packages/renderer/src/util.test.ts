import { describe, it, expect } from 'vitest'
import { pickMimeType, buildFilename, computeDuration } from './util'

describe('computeDuration', () => {
  it('is wall-clock when never paused', () => {
    expect(computeDuration(1000, 6000, 0, null)).toBe(5000)
  })
  it('subtracts finished pauses', () => {
    // recorded 1000→6000 (5s), but 2s of that was paused
    expect(computeDuration(1000, 6000, 2000, null)).toBe(3000)
  })
  it('subtracts an in-progress pause too', () => {
    // paused at 4000, now 6000 → 2s open pause excluded
    expect(computeDuration(1000, 6000, 0, 4000)).toBe(3000)
  })
  it('combines finished and in-progress pauses', () => {
    expect(computeDuration(1000, 10000, 2000, 8000)).toBe(5000) // 9s - 2s - 2s
  })
  it('never goes negative', () => {
    expect(computeDuration(1000, 1000, 5000, null)).toBe(0)
  })
})

describe('pickMimeType', () => {
  it('prefers opus when supported', () => {
    expect(pickMimeType((t) => t === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus')
  })
  it('falls back to audio/webm when opus is not supported', () => {
    expect(pickMimeType(() => false)).toBe('audio/webm')
  })
})

describe('buildFilename', () => {
  const date = new Date('2026-06-17T14:30:45.123Z')

  it('uses the app name and a filesystem-safe timestamp', () => {
    expect(buildFilename({ id: 'zoom', app: 'Zoom' }, date)).toBe('meetcap-Zoom-2026-06-17T14-30-45.webm')
  })
  it('normalizes spaces in the app name', () => {
    expect(buildFilename({ id: 'teams', app: 'Microsoft Teams' }, date)).toBe(
      'meetcap-Microsoft-Teams-2026-06-17T14-30-45.webm',
    )
  })
  it('falls back to "meeting" with no meeting and honors a custom prefix', () => {
    expect(buildFilename(null, date, 'rec')).toBe('rec-meeting-2026-06-17T14-30-45.webm')
  })
})
