/**
 * One suite, two implementations: the in-memory reference and the IndexedDB
 * adapter (fake-indexeddb) must behave identically — that's what keeps the
 * IDB adapter honest and thin.
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdbStore, createMemoryStore, type WebRecordingStore } from './store'

const blob = (bytes: number, fill = 0) => new Blob([new Uint8Array(bytes).fill(fill)])

let dbCounter = 0
const factories: Array<[string, () => WebRecordingStore]> = [
  ['memory', () => createMemoryStore()],
  ['idb', () => createIdbStore(`meetcap-web-test-${dbCounter++}`)],
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each(factories)('WebRecordingStore (%s)', (_name, makeStore) => {
  const openArgs = { filename: 'rec.webm', meeting: { id: 'zoom', app: 'Zoom' }, mimeType: 'audio/webm' }

  it('writes chunks, closes, and reads the recording back in order', async () => {
    const store = makeStore()
    const s = await store.open(openArgs)
    await s.writeChunk(0, blob(10, 1))
    await s.writeChunk(1, blob(20, 2))
    await s.writeChunk(2, blob(5, 3))
    const closed = await s.close(3000)

    expect(closed.recordingKey).toBe(s.recordingKey)
    expect(closed.segments).toEqual([0])

    const all = await store.listManifests()
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('finalized')
    expect(all[0].segments[0]).toMatchObject({ status: 'closed', durationMs: 3000, chunkCount: 3 })

    const back = await store.readRecording(s.recordingKey)
    expect(back.size).toBe(35)
    // order check: first byte of the concatenation comes from chunk 0
    const bytes = new Uint8Array(await back.arrayBuffer())
    expect(bytes[0]).toBe(1)
    expect(bytes[10]).toBe(2)
    expect(bytes[30]).toBe(3)
  })

  it('resume appends a new segment to the same manifest', async () => {
    const store = makeStore()
    const s1 = await store.open(openArgs)
    await s1.writeChunk(0, blob(10))
    await s1.close(1000)

    const s2 = await store.open({ ...openArgs, recordingKey: s1.recordingKey })
    expect(s2.recordingKey).toBe(s1.recordingKey)
    await s2.writeChunk(0, blob(7))
    const closed = await s2.close(500)
    expect(closed.segments).toEqual([0, 1])

    expect((await store.readSegment(s1.recordingKey, 0)).size).toBe(10)
    expect((await store.readSegment(s1.recordingKey, 1)).size).toBe(7)
    expect((await store.readRecording(s1.recordingKey)).size).toBe(17)
  })

  it('an unclosed session shows up as interrupted (chunks survive the "crash")', async () => {
    const store = makeStore()
    const s = await store.open(openArgs)
    await s.writeChunk(0, blob(10))
    // no close() — the tab died
    const interrupted = await store.listInterrupted()
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0].key).toBe(s.recordingKey)
    expect((await store.readSegment(s.recordingKey, 0)).size).toBe(10)
  })

  it('excludes recordings whose web lock is still held (live in another tab)', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, cb: () => Promise<unknown>) => cb().catch(() => {}),
        query: async () => ({ held: [{ name: 'meetcap-web:recording:locked-key' }] }),
      },
    })
    const store = makeStore()
    const s = await store.open(openArgs)
    await s.writeChunk(0, blob(1))
    // simulate: OUR key is reported as held
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, cb: () => Promise<unknown>) => cb().catch(() => {}),
        query: async () => ({ held: [{ name: `meetcap-web:recording:${s.recordingKey}` }] }),
      },
    })
    expect(await store.listInterrupted()).toHaveLength(0)
  })

  it('abort drops the segment — and the whole manifest when it was the only one', async () => {
    const store = makeStore()
    const s = await store.open(openArgs)
    await s.writeChunk(0, blob(10))
    await s.abort()
    expect(await store.listManifests()).toHaveLength(0)
    expect(await store.listInterrupted()).toHaveLength(0)
  })

  it('abort on a resumed segment keeps the earlier segments', async () => {
    const store = makeStore()
    const s1 = await store.open(openArgs)
    await s1.writeChunk(0, blob(10))
    await s1.close(1000)
    const s2 = await store.open({ ...openArgs, recordingKey: s1.recordingKey })
    await s2.abort()
    const all = await store.listManifests()
    expect(all).toHaveLength(1)
    expect(all[0].segments.map((x) => x.segmentIndex)).toEqual([0])
  })

  it('deleteRecording removes manifest and chunks', async () => {
    const store = makeStore()
    const s = await store.open(openArgs)
    await s.writeChunk(0, blob(10))
    await s.close(100)
    await store.deleteRecording(s.recordingKey)
    expect(await store.listManifests()).toHaveLength(0)
    expect((await store.readRecording(s.recordingKey)).size).toBe(0)
  })
})

describe('memory store extras', () => {
  it('close() assembles the blob (the only copy in persist:false mode)', async () => {
    const store = createMemoryStore()
    const s = await store.open({ filename: 'x.webm', meeting: null, mimeType: 'audio/webm' })
    await s.writeChunk(0, blob(10))
    await s.writeChunk(1, blob(5))
    const closed = await s.close(1000)
    expect(closed.blob?.size).toBe(15)
  })
})
