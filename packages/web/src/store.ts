/**
 * Browser persistence for recordings — the web implementation of
 * meetcap-capture's RecordingStore. IndexedDB is the default: every chunk is
 * committed in its own transaction, so a crashed/closed tab loses at most the
 * final timeslice and the recording is resumable (same manifest/segment model
 * as the Electron disk store, minus file paths).
 *
 * Web Locks mark recordings that are live in *some* tab, so the interrupted
 * list never offers a recording that's still being written elsewhere.
 */
import type { MeetingInfo } from 'meetcap-core'
import type { RecordingStore, StoreOpenArgs, StoreSession } from 'meetcap-capture'

export interface WebRecordingSegment {
  segmentIndex: number
  filename: string
  startedAt: number
  durationMs?: number
  status: 'active' | 'closed'
  /** Written at close; stale after a crash (the chunks store holds the truth). */
  chunkCount: number
}

/** Mirror of the Electron sidecar manifest, keyed in IDB instead of a file. */
export interface WebRecordingManifest {
  key: string
  meeting: MeetingInfo | null
  mimeType: string
  createdAt: number
  status: 'active' | 'finalized'
  segments: WebRecordingSegment[]
}

/** What close() hands back to the engine for result assembly. */
export interface WebCloseInfo {
  recordingKey: string
  /** Segment indexes of the logical recording. */
  segments: number[]
  /** Memory store only: the whole recording, since nothing persists it. */
  blob?: Blob
}

export interface InterruptedWebRecording {
  key: string
  meeting: MeetingInfo | null
  mimeType: string
  segments: number[]
}

export interface WebRecordingStore extends RecordingStore<WebCloseInfo> {
  listManifests(): Promise<WebRecordingManifest[]>
  /** Manifests still 'active' and not locked by a live recorder in any tab. */
  listInterrupted(): Promise<InterruptedWebRecording[]>
  /** One segment = one MediaRecorder run = one independently playable webm. */
  readSegment(key: string, segmentIndex: number): Promise<Blob>
  /**
   * Every chunk of every segment concatenated. Directly playable only when the
   * recording has a single segment — segments are separate encoder runs, the
   * same caveat as Electron's separate segment files.
   */
  readRecording(key: string): Promise<Blob>
  deleteRecording(key: string): Promise<void>
}

const LOCK_PREFIX = 'meetcap-web:recording:'

type LocksApi = {
  request(name: string, cb: (lock: unknown) => Promise<unknown>): Promise<unknown>
  query(): Promise<{ held?: Array<{ name?: string }> }>
}
const locksApi = (): LocksApi | null =>
  typeof navigator !== 'undefined' && 'locks' in navigator ? (navigator.locks as unknown as LocksApi) : null

/** Hold a web lock for a recording's lifetime; resolve-to-release. */
function acquireLock(key: string): () => void {
  const locks = locksApi()
  if (!locks) return () => {}
  let release: () => void = () => {}
  void locks.request(LOCK_PREFIX + key, () => new Promise<void>((r) => (release = r)))
  return () => release()
}

async function lockedKeys(): Promise<Set<string>> {
  const locks = locksApi()
  if (!locks) return new Set()
  try {
    const { held = [] } = await locks.query()
    return new Set(
      held
        .map((l) => l.name ?? '')
        .filter((n) => n.startsWith(LOCK_PREFIX))
        .map((n) => n.slice(LOCK_PREFIX.length)),
    )
  } catch {
    return new Set()
  }
}

const newKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `rec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

// ---------------------------------------------------------------------------
// Shared session logic over an abstract chunk/manifest backend, so the IDB and
// memory implementations can't drift apart.

interface StoreBackend {
  getManifest(key: string): Promise<WebRecordingManifest | undefined>
  putManifest(m: WebRecordingManifest): Promise<void>
  deleteManifest(key: string): Promise<void>
  allManifests(): Promise<WebRecordingManifest[]>
  putChunk(key: string, segmentIndex: number, chunkIndex: number, blob: Blob): Promise<void>
  chunksOf(key: string, segmentIndex?: number): Promise<Blob[]>
  deleteChunks(key: string, segmentIndex?: number): Promise<void>
  /** Memory store returns the assembled blob at close; IDB has no need. */
  assembleOnClose: boolean
}

function makeStore(backend: StoreBackend): WebRecordingStore {
  async function open(args: StoreOpenArgs): Promise<StoreSession<WebCloseInfo>> {
    const existing = args.recordingKey ? await backend.getManifest(args.recordingKey) : undefined
    const manifest: WebRecordingManifest = existing ?? {
      key: newKey(),
      meeting: args.meeting,
      mimeType: args.mimeType,
      createdAt: Date.now(),
      status: 'active',
      segments: [],
    }
    manifest.status = 'active'
    const segmentIndex = manifest.segments.length
      ? manifest.segments[manifest.segments.length - 1].segmentIndex + 1
      : 0
    manifest.segments.push({
      segmentIndex,
      filename: args.filename,
      startedAt: Date.now(),
      status: 'active',
      chunkCount: 0,
    })
    await backend.putManifest(manifest)
    const releaseLock = acquireLock(manifest.key)
    let written = 0

    return {
      recordingKey: manifest.key,
      async writeChunk(chunkIndex, blob) {
        written++
        await backend.putChunk(manifest.key, segmentIndex, chunkIndex, blob)
      },
      async close(durationMs) {
        const m = (await backend.getManifest(manifest.key)) ?? manifest
        const seg = m.segments.find((s) => s.segmentIndex === segmentIndex)
        if (seg) {
          seg.status = 'closed'
          seg.durationMs = durationMs
          seg.chunkCount = written
        }
        m.status = 'finalized'
        await backend.putManifest(m)
        releaseLock()
        const info: WebCloseInfo = { recordingKey: m.key, segments: m.segments.map((s) => s.segmentIndex) }
        if (backend.assembleOnClose) {
          info.blob = new Blob(await backend.chunksOf(m.key), { type: m.mimeType })
        }
        return info
      },
      // Failed/aborted start: drop this segment (and the manifest when it was
      // the only one) so nothing shows up as a phantom interrupted recording.
      async abort() {
        await backend.deleteChunks(manifest.key, segmentIndex)
        const m = await backend.getManifest(manifest.key)
        if (m) {
          m.segments = m.segments.filter((s) => s.segmentIndex !== segmentIndex)
          if (m.segments.length === 0) await backend.deleteManifest(m.key)
          else await backend.putManifest(m)
        }
        releaseLock()
      },
    }
  }

  return {
    open,
    listManifests: () => backend.allManifests(),
    async listInterrupted() {
      const [all, locked] = await Promise.all([backend.allManifests(), lockedKeys()])
      return all
        .filter((m) => m.status === 'active' && !locked.has(m.key) && m.segments.length > 0)
        .map((m) => ({ key: m.key, meeting: m.meeting, mimeType: m.mimeType, segments: m.segments.map((s) => s.segmentIndex) }))
    },
    async readSegment(key, segmentIndex) {
      const m = await backend.getManifest(key)
      return new Blob(await backend.chunksOf(key, segmentIndex), { type: m?.mimeType })
    },
    async readRecording(key) {
      const m = await backend.getManifest(key)
      return new Blob(await backend.chunksOf(key), { type: m?.mimeType })
    },
    async deleteRecording(key) {
      await backend.deleteChunks(key)
      await backend.deleteManifest(key)
    },
  }
}

// ---------------------------------------------------------------------------
// IndexedDB backend

const DB_VERSION = 1

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, DB_VERSION)
    r.onupgradeneeded = () => {
      const db = r.result
      if (!db.objectStoreNames.contains('manifests')) db.createObjectStore('manifests', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath: ['key', 'segmentIndex', 'chunkIndex'] })
      }
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/** Chunk range for one recording (optionally one segment) on the compound key. */
const chunkRange = (key: string, segmentIndex?: number) =>
  segmentIndex === undefined
    ? IDBKeyRange.bound([key, 0, 0], [key, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])
    : IDBKeyRange.bound([key, segmentIndex, 0], [key, segmentIndex, Number.MAX_SAFE_INTEGER])

/** Crash-safe IndexedDB store (default database `meetcap-web`). */
export function createIdbStore(dbName = 'meetcap-web'): WebRecordingStore {
  let dbPromise: Promise<IDBDatabase> | null = null
  const db = () => (dbPromise ??= openDb(dbName))
  const tx = async (store: 'manifests' | 'chunks', mode: IDBTransactionMode) =>
    (await db()).transaction(store, mode).objectStore(store)

  return makeStore({
    assembleOnClose: false,
    getManifest: async (key) => req<WebRecordingManifest | undefined>((await tx('manifests', 'readonly')).get(key)),
    putManifest: async (m) => {
      await req((await tx('manifests', 'readwrite')).put(m))
    },
    deleteManifest: async (key) => {
      await req((await tx('manifests', 'readwrite')).delete(key))
    },
    allManifests: async () => req<WebRecordingManifest[]>((await tx('manifests', 'readonly')).getAll()),
    putChunk: async (key, segmentIndex, chunkIndex, blob) => {
      await req((await tx('chunks', 'readwrite')).put({ key, segmentIndex, chunkIndex, blob }))
    },
    chunksOf: async (key, segmentIndex) => {
      const rows = await req<Array<{ blob: Blob }>>((await tx('chunks', 'readonly')).getAll(chunkRange(key, segmentIndex)))
      return rows.map((r) => r.blob) // getAll on the compound primary key returns key order
    },
    deleteChunks: async (key, segmentIndex) => {
      await req((await tx('chunks', 'readwrite')).delete(chunkRange(key, segmentIndex)))
    },
  })
}

// ---------------------------------------------------------------------------
// In-memory backend — persist:false mode and the reference for store tests.

export function createMemoryStore(): WebRecordingStore {
  const manifests = new Map<string, WebRecordingManifest>()
  const chunks = new Map<string, Blob>() // "key/segment/chunk" → blob
  const id = (key: string, s: number, c: number) => `${key}/${s}/${c}`

  const entriesOf = (key: string, segmentIndex?: number) =>
    [...chunks.entries()]
      .map(([k, blob]) => {
        const [rk, s, c] = k.split('/')
        return { rk, s: Number(s), c: Number(c), blob }
      })
      .filter((e) => e.rk === key && (segmentIndex === undefined || e.s === segmentIndex))
      .sort((a, b) => a.s - b.s || a.c - b.c)

  return makeStore({
    assembleOnClose: true,
    getManifest: async (key) => {
      const m = manifests.get(key)
      return m ? structuredClone(m) : undefined
    },
    putManifest: async (m) => {
      manifests.set(m.key, structuredClone(m))
    },
    deleteManifest: async (key) => {
      manifests.delete(key)
    },
    allManifests: async () => [...manifests.values()].map((m) => structuredClone(m)),
    putChunk: async (key, s, c, blob) => {
      chunks.set(id(key, s, c), blob)
    },
    chunksOf: async (key, segmentIndex) => entriesOf(key, segmentIndex).map((e) => e.blob),
    deleteChunks: async (key, segmentIndex) => {
      entriesOf(key, segmentIndex).forEach((e) => chunks.delete(id(key, e.s, e.c)))
    },
  })
}
