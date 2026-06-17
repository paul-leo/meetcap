/**
 * Main-process recorder setup. Call once, at the top of your main entry,
 * BEFORE `app.whenReady()` — `initMain()` appends Chromium feature flags that
 * must be set before the app initializes:
 *
 *   import { initRecorderMain } from 'meetcap-recorder-main'
 *   initRecorderMain()
 *
 * It (1) injects the macOS loopback feature flags + registers the
 * enable/disable-loopback-audio handlers (via electron-audio-loopback), and
 * (2) registers the streaming recording IPC (open/write/close) + media-access.
 *
 * Recordings are streamed to disk chunk-by-chunk as they are captured, so only
 * one ~timeslice of audio is ever held in memory and a mid-session crash leaves
 * a partial-but-playable file rather than losing everything.
 */
import { app, ipcMain, shell, systemPreferences } from 'electron'
import { initMain } from 'electron-audio-loopback'
import { IPC, type PermissionStatus, type RecordingHandle } from 'meetcap-core'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface InitRecorderMainOptions {
  /** Directory for saved recordings. Default `<downloads>/meetcap`. */
  saveDir?: string
  /** Reveal the finished file in the OS file manager. Default `true`. */
  revealInFolder?: boolean
}

export function initRecorderMain(options: InitRecorderMainOptions = {}): void {
  // Inject macOS loopback flags + register enable/disable-loopback-audio IPC.
  initMain()

  const revealInFolder = options.revealInFolder ?? true
  const open = new Map<string, { stream: fs.WriteStream; filePath: string }>()

  const saveDir = () => options.saveDir ?? path.join(app.getPath('downloads'), 'meetcap')

  ipcMain.handle(IPC.recordingOpen, (_evt, { filename }: { filename: string }): RecordingHandle => {
    const dir = saveDir()
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, filename)
    const id = randomUUID()
    open.set(id, { stream: fs.createWriteStream(filePath), filePath })
    return { id, path: filePath }
  })

  ipcMain.handle(
    IPC.recordingWrite,
    (_evt, { id, chunk }: { id: string; chunk: ArrayBuffer }): Promise<void> => {
      const entry = open.get(id)
      if (!entry) throw new Error(`meetcap: unknown recording id ${id}`)
      // Backpressure-aware append: resolve once the chunk is flushed/buffered.
      return new Promise((resolve, reject) => {
        entry.stream.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()))
      })
    },
  )

  ipcMain.handle(IPC.recordingClose, (_evt, { id }: { id: string }): Promise<string> => {
    const entry = open.get(id)
    if (!entry) throw new Error(`meetcap: unknown recording id ${id}`)
    open.delete(id)
    return new Promise((resolve) => {
      entry.stream.end(() => {
        if (revealInFolder) shell.showItemInFolder(entry.filePath)
        resolve(entry.filePath)
      })
    })
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
}
