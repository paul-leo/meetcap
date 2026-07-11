import { describe, it, expect, vi } from 'vitest'
import {
  pickMimeType,
  pickVideoMimeType,
  buildFilename,
  computeDuration,
  deniedMedia,
  withTimeout,
} from './util'
import { PermissionDeniedError, StartTimeoutError } from './errors'

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

describe('pickVideoMimeType', () => {
  it('prefers vp9+opus when supported', () => {
    expect(pickVideoMimeType(() => true)).toBe('video/webm;codecs=vp9,opus')
  })
  it('falls back to vp8+opus', () => {
    expect(pickVideoMimeType((t) => t.includes('vp8'))).toBe('video/webm;codecs=vp8,opus')
  })
  it('falls back to bare video/webm', () => {
    expect(pickVideoMimeType(() => false)).toBe('video/webm')
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
  it('omits the app segment with no meeting and honors a custom prefix', () => {
    expect(buildFilename(null, date, 'rec')).toBe('rec-2026-06-17T14-30-45.webm')
  })
})

describe('deniedMedia', () => {
  const status = (screen: string, microphone: string) => ({ platform: 'darwin', screen, microphone })

  it('returns nothing when everything is granted', () => {
    expect(deniedMedia(status('granted', 'granted'))).toEqual([])
  })
  it('reports denied screen', () => {
    expect(deniedMedia(status('denied', 'granted'))).toEqual(['screen'])
  })
  it('reports restricted as blocked', () => {
    expect(deniedMedia(status('granted', 'restricted'))).toEqual(['microphone'])
  })
  it('reports both when both are blocked', () => {
    expect(deniedMedia(status('denied', 'denied'))).toEqual(['screen', 'microphone'])
  })
  it('treats not-determined as non-blocking (prompt still possible)', () => {
    expect(deniedMedia(status('not-determined', 'not-determined'))).toEqual([])
  })
  it('treats n/a (non-darwin) as non-blocking', () => {
    expect(deniedMedia({ platform: 'win32', screen: 'n/a', microphone: 'n/a' })).toEqual([])
  })
  it('ignores a denied camera unless the recording needs it', () => {
    const s = { platform: 'darwin', screen: 'granted', microphone: 'granted', camera: 'denied' }
    expect(deniedMedia(s)).toEqual([])
    expect(deniedMedia(s, true)).toEqual(['camera'])
  })
  it('tolerates snapshots without a camera field (older mains)', () => {
    expect(deniedMedia({ platform: 'darwin', screen: 'granted', microphone: 'granted' }, true)).toEqual([])
  })
})

describe('withTimeout', () => {
  it('passes through a resolution before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, () => new Error('timeout'))).resolves.toBe('ok')
  })
  it('passes through a rejection before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, () => new Error('timeout'))).rejects.toThrow(
      'boom',
    )
  })
  it('rejects with the provided error after the timeout', async () => {
    vi.useFakeTimers()
    try {
      const p = withTimeout(new Promise(() => {}), 500, () => new Error('timed out'))
      const assertion = expect(p).rejects.toThrow('timed out')
      vi.advanceTimersByTime(500)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
  it('disposes a late resolution via onLate', async () => {
    vi.useFakeTimers()
    try {
      let resolveLate!: (v: string) => void
      const late = new Promise<string>((r) => (resolveLate = r))
      const onLate = vi.fn()
      const p = withTimeout(late, 500, () => new Error('timed out'), onLate)
      const assertion = expect(p).rejects.toThrow('timed out')
      vi.advanceTimersByTime(500)
      await assertion
      resolveLate('stream')
      await Promise.resolve() // let the onLate continuation run
      expect(onLate).toHaveBeenCalledWith('stream')
    } finally {
      vi.useRealTimers()
    }
  })
  it('ms <= 0 disables the timeout', async () => {
    let resolve!: (v: string) => void
    const p = withTimeout(new Promise<string>((r) => (resolve = r)), 0, () => new Error('timeout'))
    resolve('ok')
    await expect(p).resolves.toBe('ok')
  })
})

describe('start() error types', () => {
  it('PermissionDeniedError carries code, denied list and snapshot', () => {
    const perms = { platform: 'darwin', screen: 'denied', microphone: 'granted' }
    const err = new PermissionDeniedError(['screen'], perms)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PermissionDeniedError)
    expect(err.name).toBe('PermissionDeniedError')
    expect(err.code).toBe('permission-denied')
    expect(err.denied).toEqual(['screen'])
    expect(err.permissions).toBe(perms)
    expect(err.message).toContain('screen')
  })
  it('PermissionDeniedError preserves the original cause', () => {
    const cause = new Error('NotAllowedError')
    const err = new PermissionDeniedError(['microphone'], { platform: 'darwin', screen: 'granted', microphone: 'denied' }, cause)
    expect(err.cause).toBe(cause)
  })
  it('StartTimeoutError carries code, timeout and snapshot', () => {
    const err = new StartTimeoutError(15000, null)
    expect(err).toBeInstanceOf(StartTimeoutError)
    expect(err.name).toBe('StartTimeoutError')
    expect(err.code).toBe('start-timeout')
    expect(err.timeoutMs).toBe(15000)
    expect(err.permissions).toBeNull()
    expect(err.message).toContain('15000')
  })
})
