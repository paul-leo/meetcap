# meetcap-core

Shared TypeScript types and the IPC contract for [`meetcap-main`](../main) and [`meetcap-renderer`](../renderer). Dependency-free — safe to import from any process.

## Install

```bash
npm install meetcap-core
```

## What's inside

- **Types** — `MeetingInfo`, `MeetingRule`, `DetectionResult`, `DetectorEvent`, `RecordingResult`, `PermissionStatus`, `MeetcapBridge`.
- **`IPC`** — the single source of truth for channel names shared by main and renderer.
- **`exposeMeetcapBridge`** (`meetcap-core/preload`) — wire the whole IPC surface onto `window.meetcap` in one call.

## Preload usage

```ts
// preload.ts
import { contextBridge, ipcRenderer } from 'electron'
import { exposeMeetcapBridge } from 'meetcap-core/preload'

exposeMeetcapBridge(contextBridge, ipcRenderer) // → window.meetcap
```

`window.meetcap` then exposes `detectOnce`, `onDetectorEvent`, `listWindows`, `mediaAccess`, `openRecording` / `writeRecordingChunk` / `closeRecording`, `enableLoopbackAudio`, `disableLoopbackAudio` — consumed by `meetcap-renderer`.

## License

MIT
