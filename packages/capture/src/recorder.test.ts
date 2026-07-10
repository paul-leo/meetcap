import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionStatus } from 'meetcap-core'
import { createCaptureRecorder, type AcquiredStreams, type CaptureBackend, type RecordingStore, type StartOptionsBase } from './recorder'
import { PermissionDeniedError } from './errors'

/** Minimal MediaRecorder double: manual chunk emission, real state transitions. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = () => true
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  mimeType: string
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }
  start() {
    this.state = 'recording'
  }
  pause() {
    this.state = 'paused'
  }
  resume() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.onstop?.()
  }
  emit(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) })
  }
}

const granted: PermissionStatus = { platform: 'darwin', screen: 'granted', microphone: 'granted', camera: 'granted' }

interface TestStart extends StartOptionsBase {
  camera?: boolean
}
interface TestClose {
  key: string
  chunks: number
}
interface TestResult {
  closedKey: string | null
  durationMs: number
  mimeType: string
  videoSource: string | null
}

function makeBackend(overrides: Partial<CaptureBackend<TestStart, TestClose, TestResult>> = {}) {
  const written: Array<{ chunkIndex: number; size: number }> = []
  const cleanup = vi.fn()
  const acquired: AcquiredStreams = {
    mixed: {} as MediaStream,
    hasSystemAudio: true,
    videoSource: null,
    cleanup,
  }
  const aborted = vi.fn(async () => {})
  const store: RecordingStore<TestClose> = {
    async open() {
      return {
        recordingKey: 'rec-1',
        async writeChunk(chunkIndex, blob) {
          written.push({ chunkIndex, size: blob.size })
        },
        async close() {
          return { key: 'rec-1', chunks: written.length }
        },
        abort: aborted,
      }
    },
  }
  const backend: CaptureBackend<TestStart, TestClose, TestResult> = {
    snapshotPermissions: async () => granted,
    needsCamera: (o) => o.camera === true,
    acquire: async () => acquired,
    store,
    buildResult: ({ closed, durationMs, mimeType, videoSource }) => ({
      closedKey: closed?.key ?? null,
      durationMs,
      mimeType,
      videoSource,
    }),
    startTimeoutMsDefault: 0,
    ...overrides,
  }
  return { backend, written, cleanup, aborted }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  FakeMediaRecorder.instances = []
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createCaptureRecorder', () => {
  it('records: start → chunks persisted in order → stop → complete with assembled result', async () => {
    const { backend, written } = makeBackend()
    const rec = createCaptureRecorder(backend)
    const states: string[] = []
    const completes: TestResult[] = []
    rec.on('statechange', (s) => states.push(s)).on('complete', (r) => completes.push(r))

    await rec.start({ id: 'zoom', app: 'Zoom' })
    expect(rec.state).toBe('recording')
    expect(rec.recordingKey).toBe('rec-1')

    const mr = FakeMediaRecorder.instances[0]
    mr.emit(10)
    mr.emit(20)
    rec.stop()
    await flush()

    expect(written.map((w) => w.chunkIndex)).toEqual([0, 1])
    expect(states).toEqual(['recording', 'idle'])
    expect(completes).toHaveLength(1)
    expect(completes[0].closedKey).toBe('rec-1')
    expect(completes[0].mimeType).toContain('audio/webm')
  })

  it('fails fast with PermissionDeniedError when the pre-flight snapshot is denied', async () => {
    const { backend } = makeBackend({
      snapshotPermissions: async () => ({ ...granted, microphone: 'denied' }),
    })
    const acquire = vi.spyOn(backend, 'acquire')
    const rec = createCaptureRecorder(backend)
    const errors: unknown[] = []
    rec.on('error', (e) => errors.push(e))

    await expect(rec.start()).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(errors).toHaveLength(1)
    expect((errors[0] as PermissionDeniedError).denied).toEqual(['microphone'])
    expect(acquire).not.toHaveBeenCalled()
    expect(rec.state).toBe('idle')
  })

  it('only counts a denied camera when the start options need one', async () => {
    const { backend } = makeBackend({
      snapshotPermissions: async () => ({ ...granted, camera: 'denied' }),
    })
    const rec = createCaptureRecorder(backend)
    await expect(rec.start(null, { camera: true })).rejects.toBeInstanceOf(PermissionDeniedError)
    // Without the camera requirement the same snapshot must pass.
    await expect(rec.start(null, {})).resolves.toBeUndefined()
    expect(rec.state).toBe('recording')
  })

  it('stop() during a pending start aborts it and releases the acquired streams', async () => {
    let release!: (v: AcquiredStreams) => void
    const cleanup = vi.fn()
    const { backend } = makeBackend({
      acquire: () => new Promise<AcquiredStreams>((r) => (release = r)),
    })
    const rec = createCaptureRecorder(backend)
    const states: string[] = []
    rec.on('statechange', (s) => states.push(s))

    const pending = rec.start()
    await flush() // let start reach the acquire await
    rec.stop() // aborts the pending start via the epoch bump
    release({ mixed: {} as MediaStream, hasSystemAudio: false, videoSource: null, cleanup })
    await pending

    expect(cleanup).toHaveBeenCalled() // late streams released
    expect(states).toEqual([]) // never reached 'recording'
    expect(rec.state).toBe('idle')
  })

  it('a failed start closes the half-open store session (no phantom interrupted recording)', async () => {
    const { backend, aborted } = makeBackend()
    // Store opens fine, but MediaRecorder construction explodes.
    vi.stubGlobal(
      'MediaRecorder',
      class {
        static isTypeSupported = () => true
        constructor() {
          throw new Error('boom')
        }
      },
    )
    const rec = createCaptureRecorder(backend)
    await expect(rec.start()).rejects.toThrow('boom')
    await flush()
    expect(aborted).toHaveBeenCalled()
    expect(rec.state).toBe('idle')
  })

  it('persist: false skips the store entirely and completes with closed = null', async () => {
    const { backend } = makeBackend()
    const open = vi.spyOn(backend.store!, 'open')
    const rec = createCaptureRecorder(backend, { persist: false })
    const completes: TestResult[] = []
    rec.on('complete', (r) => completes.push(r))

    await rec.start()
    FakeMediaRecorder.instances[0].emit(5)
    rec.stop()
    await flush()

    expect(open).not.toHaveBeenCalled()
    expect(rec.recordingKey).toBeNull()
    expect(completes[0].closedKey).toBeNull()
  })

  it('pause/resume excludes paused time from the reported duration', async () => {
    vi.useFakeTimers()
    try {
      const { backend } = makeBackend()
      const rec = createCaptureRecorder(backend)
      const completes: TestResult[] = []
      rec.on('complete', (r) => completes.push(r))

      await rec.start()
      vi.advanceTimersByTime(3000) // 3s recording
      rec.pause()
      vi.advanceTimersByTime(10_000) // 10s paused — must not count
      rec.resume()
      vi.advanceTimersByTime(2000) // 2s recording
      rec.stop()
      await vi.runAllTimersAsync()

      expect(completes[0].durationMs).toBe(5000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('video source switches the mimeType to video/webm', async () => {
    const { backend } = makeBackend({
      acquire: async () => ({
        mixed: {} as MediaStream,
        hasSystemAudio: false,
        videoSource: 'screen',
        cleanup: () => {},
      }),
    })
    const rec = createCaptureRecorder(backend)
    const completes: TestResult[] = []
    rec.on('complete', (r) => completes.push(r))
    await rec.start()
    rec.stop()
    await flush()
    expect(completes[0].mimeType).toContain('video/webm')
    expect(completes[0].videoSource).toBe('screen')
  })
})
