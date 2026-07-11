// Capture-state shapes shared between bar renderer and the pickers.
interface CapState {
  screen: { on: boolean; sourceId: string | null }
  camera: { on: boolean; deviceId: string | null }
  mic: { on: boolean; deviceId: string | null }
  sys: { on: boolean }
}

/** A screen/window entry for the visual picker (real thumbnails). */
interface CaptureSource {
  id: string
  kind: 'screen' | 'window'
  name: string
  thumbnail: string | null
  appIcon: string | null
}

/** What the picker window resolves back to the bar. */
interface PickResult {
  sourceId: string
  label: string
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
  /** Grow/shrink the bar window (bottom edge stays anchored) for popovers. */
  barHeight(h: number): Promise<void>
  /** Enumerate screens + windows with real thumbnails (picker window). */
  captureSources(): Promise<CaptureSource[]>
  /** Open the visual picker; resolves to the choice or null on cancel. */
  pickScreen(currentId: string | null): Promise<PickResult | null>
  /** Picker window → main: report the choice (or null) and close. */
  pickerDone(result: PickResult | null): void
  onToggleRecord(cb: () => void): void
  onLibraryUpdated(cb: () => void): void
}

interface Window {
  recorderApp: RecorderAppBridge
}
