# meetcap-capture

The shared, backend-agnostic recording engine behind the meetcap family — the
capture state machine (idle/recording/paused events, start-epoch abort
protocol, pause-aware duration accounting, ordered crash-safe chunk
persistence, MediaRecorder wiring) with the three environment-specific
concerns injected as a `CaptureBackend`:

1. **stream acquisition** — Electron loopback system audio vs browser
   `getDisplayMedia`/caller-provided streams
2. **persistence** — disk over IPC vs IndexedDB vs memory-only
3. **permission snapshots** — macOS TCC vs the Permissions API

Application code usually consumes one of the packaged backends instead:

| Package | Environment |
|---|---|
| `meetcap-renderer` | Electron renderer (loopback system audio, disk persistence, meeting detection) |
| `meetcap-web` | Any browser (display/tab/camera/stream capture, IndexedDB persistence) |
| `meetcap-client` | Hybrid web/Electron codebases — runtime negotiation between the two |

Import from here when building a custom backend (e.g. a desktop-agent
transport):

```ts
import { createCaptureRecorder, type CaptureBackend } from 'meetcap-capture'

const recorder = createCaptureRecorder(myBackend, { timesliceMs: 1000 })
recorder.on('chunk', ({ blob }) => upload(blob))
await recorder.start(meeting)
```

Also exports the shared errors (`PermissionDeniedError`, `StartTimeoutError`,
`BridgeUnavailableError`) and pure utilities (`pickMimeType`,
`pickVideoMimeType`, `buildFilename`, `computeDuration`, `deniedMedia`,
`withTimeout`) that every backend package re-exports.
