/**
 * Preload bridge helper. Call this from your Electron preload script to expose
 * the full meetcap IPC surface on `window.meetcap` in one line:
 *
 *   import { exposeMeetcapBridge } from 'meetcap-core/preload'
 *   import { contextBridge, ipcRenderer } from 'electron'
 *   exposeMeetcapBridge(contextBridge, ipcRenderer)
 *
 * Structurally typed (no `electron` import) so this package stays dependency-free.
 */
import { IPC } from './index'
import type { DetectorEvent, MeetcapBridge } from './index'

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (...args: unknown[]) => void): void
}

interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void
}

export function exposeMeetcapBridge(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
  key = 'meetcap',
): void {
  const bridge: MeetcapBridge = {
    detectOnce: () => ipcRenderer.invoke(IPC.detectOnce) as ReturnType<MeetcapBridge['detectOnce']>,
    onDetectorEvent: (cb: (evt: DetectorEvent) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload as DetectorEvent)
      ipcRenderer.on(IPC.detectorEvent, listener)
      return () => ipcRenderer.removeListener(IPC.detectorEvent, listener as (...args: unknown[]) => void)
    },
    listWindows: () => ipcRenderer.invoke(IPC.listWindows) as ReturnType<MeetcapBridge['listWindows']>,
    mediaAccess: () => ipcRenderer.invoke(IPC.mediaAccess) as ReturnType<MeetcapBridge['mediaAccess']>,
    requestPermissions: () =>
      ipcRenderer.invoke(IPC.requestPermissions) as ReturnType<MeetcapBridge['requestPermissions']>,
    openScreenRecordingSettings: () => ipcRenderer.invoke(IPC.openScreenSettings) as Promise<void>,
    openPrivacySettings: (pane: Parameters<MeetcapBridge['openPrivacySettings']>[0]) =>
      ipcRenderer.invoke(IPC.openPrivacySettings, { pane }) as Promise<void>,
    openRecording: (args: Parameters<MeetcapBridge['openRecording']>[0]) =>
      ipcRenderer.invoke(IPC.recordingOpen, args) as ReturnType<MeetcapBridge['openRecording']>,
    writeRecordingChunk: (id: string, chunk: ArrayBuffer) =>
      ipcRenderer.invoke(IPC.recordingWrite, { id, chunk }) as Promise<void>,
    closeRecording: (id: string, durationMs?: number) =>
      ipcRenderer.invoke(IPC.recordingClose, { id, durationMs }) as ReturnType<MeetcapBridge['closeRecording']>,
    listInterruptedRecordings: () =>
      ipcRenderer.invoke(IPC.recordingList) as ReturnType<MeetcapBridge['listInterruptedRecordings']>,
    readRecording: (filePath: string) =>
      ipcRenderer.invoke(IPC.recordingRead, { filePath }) as ReturnType<MeetcapBridge['readRecording']>,
    deleteRecording: (filePath: string) =>
      ipcRenderer.invoke(IPC.recordingDelete, { filePath }) as Promise<void>,
    recordingExists: (filePath: string) =>
      ipcRenderer.invoke(IPC.recordingExists, { filePath }) as Promise<boolean>,
    setLoopbackSource: (sourceId: string | null) =>
      ipcRenderer.invoke(IPC.setLoopbackSource, { sourceId }) as Promise<void>,
    enableLoopbackAudio: () => ipcRenderer.invoke(IPC.enableLoopback) as Promise<void>,
    disableLoopbackAudio: () => ipcRenderer.invoke(IPC.disableLoopback) as Promise<void>,
  }
  contextBridge.exposeInMainWorld(key, bridge)
}
