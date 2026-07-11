// Shared shape of the preload's `window.recorderApp` channel.
interface RecorderAppBridge {
  reportState(state: string): void
  reportMeeting(active: boolean): void
  library(): Promise<Array<{ filePath: string; name: string; size: number; mtimeMs: number }>>
  openFolder(): Promise<void>
  reveal(filePath: string): Promise<void>
  showLibrary(): Promise<void>
  hideBar(): Promise<void>
  pip(show: boolean): Promise<void>
  sourceMenu(current: { mode: string; pip: boolean }): Promise<{ mode?: string; pip?: boolean } | null>
  onToggleRecord(cb: () => void): void
  onLibraryUpdated(cb: () => void): void
}

interface Window {
  recorderApp: RecorderAppBridge
}
