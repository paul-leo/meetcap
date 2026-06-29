/**
 * Main-process detector. Polls desktopCapturer (window titles) and ps-list
 * (process names) on an interval, runs the rule engine, and broadcasts
 * detected/ended edge events to all renderer windows over IPC.
 *
 *   import { startDetector } from 'meetcap-main'
 *   const detector = startDetector({ require: 'window' })
 *   // …later: detector.stop()
 */
import { BrowserWindow, desktopCapturer, ipcMain } from 'electron'
import { IPC, type MeetingInfo, type ProcessInfo, type WindowSource } from 'meetcap-core'
import { createDetectionState, matchWindow, resolveMeeting, type DetectorConfig } from './engine'
import { presets } from './rules'

export interface StartDetectorOptions extends DetectorConfig {
  /** Polling interval in ms. Default 3000. */
  intervalMs?: number
}

export interface Detector {
  stop(): void
}

async function listWindowSources(): Promise<WindowSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1, height: 1 },
  })
  return sources.map((s) => ({ id: s.id, name: s.name }))
}

async function listProcesses(): Promise<ProcessInfo[]> {
  try {
    // ps-list is ESM-only; dynamic import works from this CommonJS build.
    const { default: psList } = await import('ps-list')
    const procs = await psList()
    return procs.map((p) => ({ name: p.name, pid: p.pid }))
  } catch {
    return []
  }
}

export function startDetector(opts: StartDetectorOptions = {}): Detector {
  const intervalMs = opts.intervalMs ?? 3000
  const rules = opts.rules ?? presets
  const state = createDetectionState()

  const policy = opts.require ?? 'process'

  async function detectOnce(): Promise<MeetingInfo | null> {
    // Skip desktopCapturer entirely when the policy doesn't need window titles.
    // On macOS 15 Sequoia, getSources can trigger the SCContentSharingPicker
    // permission dialog even for types:['window'], so we only call it when needed.
    const sources = policy === 'process' ? [] : await listWindowSources()
    if (policy === 'window' && !matchWindow(sources, rules)) return null
    const procs = await listProcesses()
    return resolveMeeting(sources, procs, opts)
  }

  ipcMain.handle(IPC.detectOnce, () => detectOnce())
  ipcMain.handle(IPC.listWindows, async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 1, height: 1 },
    })
    return sources.map((s) => ({ id: s.id, name: s.name }))
  })

  const tick = async () => {
    try {
      const evt = state.update(await detectOnce())
      if (evt) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.detectorEvent, evt)
        }
      }
    } catch {
      // swallow per-tick errors; next tick retries
    }
  }

  const timer = setInterval(tick, intervalMs)
  void tick()

  return {
    stop() {
      clearInterval(timer)
      ipcMain.removeHandler(IPC.detectOnce)
      ipcMain.removeHandler(IPC.listWindows)
    },
  }
}
