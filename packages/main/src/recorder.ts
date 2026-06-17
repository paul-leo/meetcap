/**
 * Main-process recorder setup. Call once, at the top of your main entry,
 * BEFORE `app.whenReady()` — `initMain()` appends Chromium feature flags that
 * must be set before the app initializes:
 *
 *   import { initRecorderMain } from 'meetcap-main'
 *   initRecorderMain()
 *
 * It (1) injects the macOS loopback feature flags + registers the
 * enable/disable-loopback-audio handlers (via electron-audio-loopback), and
 * (2) registers the streaming recording IPC (open/write/close/list) + media-access.
 *
 * Recordings stream to disk chunk-by-chunk, so memory stays flat and a crash
 * leaves a partial-but-playable file. A sidecar manifest (`<key>.meetcap.json`)
 * tracks a logical recording across segments, enabling crash recovery / resume.
 */
import { app, desktopCapturer, ipcMain, shell, systemPreferences } from 'electron'
import { initMain } from 'electron-audio-loopback'
import {
  IPC,
  type CloseRecordingResult,
  type InterruptedRecording,
  type OpenRecordingArgs,
  type PermissionStatus,
  type RecordingHandle,
  type RecordingManifest,
} from 'meetcap-core'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { addSegment, closeSegment, createManifest, finalizeManifest, isInterrupted } from './manifest'

export interface InitRecorderMainOptions {
  /** Directory for saved recordings. Default `<downloads>/meetcap`. */
  saveDir?: string
  /** Reveal the finished file in the OS file manager. Default `true`. */
  revealInFolder?: boolean
}

interface OpenEntry {
  stream: fs.WriteStream
  filePath: string
  manifestPath: string
  recordingKey: string
  segmentIndex: number
  startedAt: number
}

export function initRecorderMain(options: InitRecorderMainOptions = {}): void {
  // Inject macOS loopback flags + register enable/disable-loopback-audio IPC.
  initMain()

  const revealInFolder = options.revealInFolder ?? true
  const open = new Map<string, OpenEntry>()

  const dir = () => options.saveDir ?? path.join(app.getPath('downloads'), 'meetcap')
  const manifestPathFor = (key: string) => path.join(dir(), `${key}.meetcap.json`)
  const readManifest = (p: string): RecordingManifest =>
    JSON.parse(fs.readFileSync(p, 'utf8')) as RecordingManifest
  const writeManifest = (p: string, m: RecordingManifest) => fs.writeFileSync(p, JSON.stringify(m, null, 2))
  const segPaths = (saveDir: string, m: RecordingManifest) =>
    m.segments.map((s) => path.join(saveDir, s.file))

  ipcMain.handle(
    IPC.recordingOpen,
    (_evt, args: OpenRecordingArgs): RecordingHandle => {
      const saveDir = dir()
      fs.mkdirSync(saveDir, { recursive: true })
      const startedAt = Date.now()

      // Resume an existing logical recording, or start a new one.
      let manifest: RecordingManifest
      let recordingKey: string
      if (args.recordingKey && fs.existsSync(manifestPathFor(args.recordingKey))) {
        recordingKey = args.recordingKey
        manifest = readManifest(manifestPathFor(recordingKey))
      } else {
        recordingKey = randomUUID()
        manifest = createManifest({
          key: recordingKey,
          meeting: args.meeting ?? null,
          mimeType: args.mimeType ?? 'audio/webm',
          createdAt: startedAt,
        })
      }

      const filePath = path.join(saveDir, args.filename)
      const segmentIndex = addSegment(manifest, args.filename, startedAt)
      const manifestPath = manifestPathFor(recordingKey)
      writeManifest(manifestPath, manifest)

      const id = randomUUID()
      open.set(id, {
        stream: fs.createWriteStream(filePath),
        filePath,
        manifestPath,
        recordingKey,
        segmentIndex,
        startedAt,
      })
      return { id, path: filePath, recordingKey, segmentIndex }
    },
  )

  ipcMain.handle(
    IPC.recordingWrite,
    (_evt, { id, chunk }: { id: string; chunk: ArrayBuffer }): Promise<void> => {
      const entry = open.get(id)
      if (!entry) throw new Error(`meetcap: unknown recording id ${id}`)
      return new Promise((resolve, reject) => {
        entry.stream.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()))
      })
    },
  )

  ipcMain.handle(
    IPC.recordingClose,
    (_evt, { id, durationMs }: { id: string; durationMs?: number }): Promise<CloseRecordingResult> => {
      const entry = open.get(id)
      if (!entry) throw new Error(`meetcap: unknown recording id ${id}`)
      open.delete(id)
      return new Promise((resolve) => {
        entry.stream.end(() => {
          const saveDir = dir()
          const manifest = readManifest(entry.manifestPath)
          closeSegment(manifest, entry.segmentIndex, durationMs ?? Date.now() - entry.startedAt)
          finalizeManifest(manifest)
          writeManifest(entry.manifestPath, manifest)
          if (revealInFolder) shell.showItemInFolder(entry.filePath)
          resolve({ filePath: entry.filePath, recordingKey: entry.recordingKey, segments: segPaths(saveDir, manifest) })
        })
      })
    },
  )

  ipcMain.handle(IPC.recordingList, (): InterruptedRecording[] => {
    const saveDir = dir()
    if (!fs.existsSync(saveDir)) return []
    const out: InterruptedRecording[] = []
    for (const f of fs.readdirSync(saveDir)) {
      if (!f.endsWith('.meetcap.json')) continue
      try {
        const m = readManifest(path.join(saveDir, f))
        if (!isInterrupted(m) || m.segments.length === 0) continue
        const files = segPaths(saveDir, m).filter((p) => fs.existsSync(p))
        if (files.length === 0) continue
        out.push({
          key: m.key,
          meeting: m.meeting,
          mimeType: m.mimeType,
          segmentFiles: files,
          lastSegmentPath: files[files.length - 1],
        })
      } catch {
        // skip unreadable/corrupt manifests
      }
    }
    return out
  })

  ipcMain.handle(IPC.mediaAccess, (): PermissionStatus => {
    if (process.platform !== 'darwin') {
      return { platform: process.platform, screen: 'n/a', microphone: 'n/a' }
    }
    return {
      platform: 'darwin',
      screen: systemPreferences.getMediaAccessStatus('screen'),
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
    }
  })

  // Pre-flight permissions so the first recording isn't blocked by a prompt.
  ipcMain.handle(IPC.requestPermissions, async (): Promise<PermissionStatus> => {
    if (process.platform !== 'darwin') {
      return { platform: process.platform, screen: 'n/a', microphone: 'n/a' }
    }
    // Mic: native prompt (returns once the user answers).
    try {
      await systemPreferences.askForMediaAccess('microphone')
    } catch {
      // ignore — status is read below regardless
    }
    // Screen recording can't be granted programmatically. A getSources() call
    // registers the app in System Settings → Privacy → Screen Recording so the
    // user can toggle it (then the app must restart to pick it up).
    let screen = systemPreferences.getMediaAccessStatus('screen')
    if (screen !== 'granted') {
      try {
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      } catch {
        // ignore
      }
      screen = systemPreferences.getMediaAccessStatus('screen')
    }
    return { platform: 'darwin', screen, microphone: systemPreferences.getMediaAccessStatus('microphone') }
  })

  ipcMain.handle(IPC.openScreenSettings, () => {
    if (process.platform === 'darwin') {
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      )
    }
  })
}
