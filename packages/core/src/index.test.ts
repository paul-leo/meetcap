import { describe, it, expect } from 'vitest'
import { IPC } from './index'

describe('IPC channel contract', () => {
  it('is the single source of truth and must not drift', () => {
    // Snapshot: changing a channel name is a breaking change across main/renderer.
    expect(IPC).toEqual({
      detectOnce: 'meetcap:detect-once',
      detectorEvent: 'meetcap:detector-event',
      listWindows: 'meetcap:list-windows',
      mediaAccess: 'meetcap:media-access',
      recordingOpen: 'meetcap:recording-open',
      recordingWrite: 'meetcap:recording-write',
      recordingClose: 'meetcap:recording-close',
      recordingList: 'meetcap:recording-list',
      enableLoopback: 'enable-loopback-audio',
      disableLoopback: 'disable-loopback-audio',
    })
  })

  it('keeps the loopback channels exactly as electron-audio-loopback expects', () => {
    expect(IPC.enableLoopback).toBe('enable-loopback-audio')
    expect(IPC.disableLoopback).toBe('disable-loopback-audio')
  })
})
