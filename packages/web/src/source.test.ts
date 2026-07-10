import { describe, expect, it } from 'vitest'
import { planVideoSource, sourcePlan } from './source'

describe('sourcePlan', () => {
  it('defaults to mic-only', () => {
    expect(sourcePlan()).toEqual({
      wantsMic: true,
      wantsCamera: false,
      wantsDisplay: false,
      keepDisplayVideo: false,
      streams: [],
    })
  })

  it('display mixes mic and keeps the video track by default', () => {
    const p = sourcePlan({ kind: 'display' })
    expect(p.wantsMic).toBe(true)
    expect(p.wantsDisplay).toBe(true)
    expect(p.keepDisplayVideo).toBe(true)
  })

  it('display can drop mic and video explicitly', () => {
    const p = sourcePlan({ kind: 'display', mic: false, video: false })
    expect(p.wantsMic).toBe(false)
    expect(p.keepDisplayVideo).toBe(false)
  })

  it('camera mixes mic by default', () => {
    expect(sourcePlan({ kind: 'camera' }).wantsMic).toBe(true)
  })

  it('streams does NOT mix mic by default — the zero-permission path stays zero-prompt', () => {
    const streams = [{} as MediaStream]
    const p = sourcePlan({ kind: 'streams', streams })
    expect(p.wantsMic).toBe(false)
    expect(p.streams).toBe(streams)
  })
})

describe('planVideoSource', () => {
  it('is null without a video track', () => {
    expect(planVideoSource(sourcePlan({ kind: 'display' }), false)).toBeNull()
  })
  it('maps display video to screen', () => {
    expect(planVideoSource(sourcePlan({ kind: 'display' }), true)).toBe('screen')
  })
  it('maps camera to camera', () => {
    expect(planVideoSource(sourcePlan({ kind: 'camera' }), true)).toBe('camera')
  })
  it('maps caller-provided video to custom', () => {
    expect(planVideoSource(sourcePlan({ kind: 'streams', streams: [] }), true)).toBe('custom')
  })
})
