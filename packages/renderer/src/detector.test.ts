import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DetectorEvent, MeetingInfo } from 'meetcap-core'
import { createDetectorClient } from './detector'

const zoom: MeetingInfo = { id: 'zoom', app: 'Zoom', meetingId: 'occ-1' }

/** Stub window.meetcap with a controllable detector-event feed + detectOnce. */
function stubBridge(detectOnceResult: MeetingInfo | null = null) {
  let emit: ((evt: DetectorEvent) => void) | null = null
  const unsubscribe = vi.fn()
  ;(globalThis as { window?: unknown }).window = {
    meetcap: {
      detectOnce: vi.fn(async () => detectOnceResult),
      onDetectorEvent: (cb: (evt: DetectorEvent) => void) => {
        emit = cb
        return unsubscribe
      },
    },
  }
  return { emit: (evt: DetectorEvent) => emit?.(evt), unsubscribe }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('createDetectorClient', () => {
  it('tracks detected/ended and notifies handlers with the meeting', () => {
    const bridge = stubBridge()
    const client = createDetectorClient()
    const detected = vi.fn()
    const ended = vi.fn()
    client.on('meeting-detected', detected).on('meeting-ended', ended)

    bridge.emit({ type: 'meeting-detected', meeting: zoom })
    expect(client.current).toEqual(zoom)
    expect(client.isInMeeting).toBe(true)
    expect(detected).toHaveBeenCalledWith(zoom)

    bridge.emit({ type: 'meeting-ended', meeting: zoom })
    expect(client.current).toBeNull()
    expect(ended).toHaveBeenCalledWith(zoom)
  })

  it('off() unsubscribes a single handler without destroying the client', () => {
    const bridge = stubBridge()
    const client = createDetectorClient()
    const a = vi.fn()
    const b = vi.fn()
    client.on('meeting-detected', a).on('meeting-detected', b)
    client.off('meeting-detected', a)

    bridge.emit({ type: 'meeting-detected', meeting: zoom })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith(zoom)
  })

  it('syncInitial adopts an in-progress meeting and fires meeting-detected once', async () => {
    stubBridge(zoom)
    const client = createDetectorClient({ syncInitial: true })
    const detected = vi.fn()
    client.on('meeting-detected', detected) // registered right after creation — probe is async

    await Promise.resolve() // let the detectOnce() continuation run
    expect(client.current).toEqual(zoom)
    expect(detected).toHaveBeenCalledTimes(1)
    expect(detected).toHaveBeenCalledWith(zoom)
  })

  it('syncInitial does not override a meeting delivered by an edge event first', async () => {
    const other: MeetingInfo = { id: 'teams', app: 'Teams', meetingId: 'occ-2' }
    const bridge = stubBridge(zoom) // stale probe result
    const client = createDetectorClient({ syncInitial: true })
    bridge.emit({ type: 'meeting-detected', meeting: other }) // edge event wins the race

    await Promise.resolve()
    expect(client.current).toEqual(other)
  })

  it('syncInitial with no meeting in progress stays idle', async () => {
    stubBridge(null)
    const client = createDetectorClient({ syncInitial: true })
    const detected = vi.fn()
    client.on('meeting-detected', detected)

    await Promise.resolve()
    expect(client.current).toBeNull()
    expect(detected).not.toHaveBeenCalled()
  })

  it('destroy() unsubscribes from the bridge', () => {
    const bridge = stubBridge()
    const client = createDetectorClient()
    client.destroy()
    expect(bridge.unsubscribe).toHaveBeenCalled()
  })
})
