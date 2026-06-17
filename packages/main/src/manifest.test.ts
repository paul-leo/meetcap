import { describe, it, expect } from 'vitest'
import { createManifest, addSegment, closeSegment, finalizeManifest, isInterrupted } from './manifest'

const base = () => createManifest({ key: 'k1', meeting: null, mimeType: 'audio/webm', createdAt: 1000 })

describe('manifest lifecycle', () => {
  it('starts active and empty', () => {
    const m = base()
    expect(m.status).toBe('active')
    expect(m.segments).toEqual([])
    expect(isInterrupted(m)).toBe(true)
  })

  it('adds and closes segments', () => {
    const m = base()
    const i0 = addSegment(m, 'seg-a.webm', 1000)
    const i1 = addSegment(m, 'seg-b.webm', 2000)
    expect([i0, i1]).toEqual([0, 1])
    expect(m.segments[0]).toMatchObject({ file: 'seg-a.webm', status: 'active' })

    closeSegment(m, 0, 500)
    expect(m.segments[0]).toMatchObject({ status: 'closed', durationMs: 500 })
    expect(m.segments[1].status).toBe('active') // independent
  })

  it('finalize flips status and clears interrupted', () => {
    const m = base()
    addSegment(m, 'seg-a.webm', 1000)
    closeSegment(m, 0, 1234)
    expect(isInterrupted(m)).toBe(true) // active until finalized
    finalizeManifest(m)
    expect(m.status).toBe('finalized')
    expect(isInterrupted(m)).toBe(false)
  })

  it('resume = add a second segment to an existing manifest', () => {
    const m = base()
    addSegment(m, 'seg-1.webm', 1000)
    closeSegment(m, 0, 1000)
    // crash before finalize → still interrupted, one closed + (re-open) new segment
    const i = addSegment(m, 'seg-2.webm', 5000)
    expect(i).toBe(1)
    expect(m.segments.map((s) => s.file)).toEqual(['seg-1.webm', 'seg-2.webm'])
    expect(isInterrupted(m)).toBe(true)
  })

  it('closeSegment on a missing index is a no-op', () => {
    const m = base()
    expect(() => closeSegment(m, 5, 100)).not.toThrow()
  })
})
