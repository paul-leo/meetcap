// Capture-state shapes shared between bar renderer and the source menu.
interface CapState {
  screen: { on: boolean; sourceId: string | null }
  camera: { on: boolean; deviceId: string | null }
  mic: { on: boolean; deviceId: string | null }
  sys: { on: boolean }
}
type CapPatch = {
  screen?: { on?: boolean; sourceId?: string }
  camera?: { on?: boolean; deviceId?: string }
  mic?: { on?: boolean; deviceId?: string }
  sys?: { on?: boolean }
}

// Shared shape of the preload's `window.recorderApp` channel.
interface RecorderAppBridge {
  reportState(state: string): void
  reportMeeting(active: boolean): void
  library(): Promise<Array<{ filePath: string; name: string; size: number; mtimeMs: number }>>
  openFolder(): Promise<void>
  reveal(filePath: string): Promise<void>
  showLibrary(): Promise<void>
  hideBar(): Promise<void>
  pip(show: boolean, deviceId?: string | null): Promise<void>
  sourceMenu(payload: {
    state: CapState
    screens: Array<{ id: string; label: string }>
    windows: Array<{ id: string; label: string }>
    cams: Array<{ id: string; label: string }>
    mics: Array<{ id: string; label: string }>
  }): Promise<CapPatch | null>
  onToggleRecord(cb: () => void): void
  onLibraryUpdated(cb: () => void): void
}

interface Window {
  recorderApp: RecorderAppBridge
}
