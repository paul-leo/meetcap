# Web recording (meetcap-web)

Browser-native recording with the same engine, events and crash-safety model
as the Electron packages — no Electron anywhere. This is the lifecycle guide
for the IndexedDB-backed model; the Electron equivalent is
[recording-lifecycle](./recording-lifecycle.md).

## Picking a package (the layering)

| Your app | Install | Why |
|---|---|---|
| Pure Electron | `meetcap-renderer` | Loopback system audio, disk persistence, meeting detection; zero web code in the bundle |
| Pure web | `meetcap-web` | This package; zero Electron API surface |
| Hybrid (one bundle for web + Electron shell), web should record | `meetcap-client` | Runtime negotiation: Electron backend when `window.meetcap` exists, web backend otherwise |
| Hybrid, web must NOT record | `meetcap-renderer` only | Import-safe on web; gate UI with `isBridgeAvailable()`; or alias `meetcap-renderer/stub` in the web build to drop recording code entirely |

All four share `meetcap-capture` (the engine) underneath — same `Recorder`
surface, same errors, same hooks patterns.

## What the web can capture

```ts
import { createRecorder } from 'meetcap-web'
const rec = createRecorder()

await rec.start(null, { source: { kind: 'mic' } })                       // default
await rec.start(null, { source: { kind: 'camera' } })                    // + mic; video/webm
await rec.start(null, { source: { kind: 'display' } })                   // + mic; share picker
await rec.start(null, { source: { kind: 'streams', streams: [remote] } })// e.g. WebRTC remote audio
```

| Source | Prompt / gesture | System audio | Video |
|---|---|---|---|
| `mic` | mic permission once | — | — |
| `camera` | mic + camera permission | — | camera (`video/webm`) |
| `display` | **real user click required** (browser share picker, every time) | what the user shares: a *tab* → tab audio (Chromium, all platforms); *entire screen* → system audio on Windows/ChromeOS and macOS 14.2+ with Chrome 141+; a *window* → none | shared surface (`video: false` to drop) |
| `streams` | none — zero-permission path | n/a | first video track (`videoSource: 'custom'`) |

- **Same-page meetings need no capture permission at all**: feed the WebRTC
  remote audio (plus your own mic track) through `streams` — highest quality,
  works in every browser.
- The share picker cannot be pre-answered or skipped; there is no silent
  capture on the web. That's the Electron/agent backends' job.
- Cancelling the picker rejects with the raw `NotAllowedError` — a user
  choice, deliberately NOT wrapped into `PermissionDeniedError`.

## Persistence: IndexedDB, crash-safe

Chunks are committed one transaction each (db `meetcap-web`), so a crashed or
closed tab loses at most the final timeslice:

```ts
import {
  listRecordings, listInterruptedRecordings,
  readSegment, readRecording, deleteRecording,
} from 'meetcap-web'

rec.on('complete', async (r) => {
  const blob = await readRecording(r.recordingKey!)   // upload it
  await deleteRecording(r.recordingKey!)
})

// next visit — crash recovery:
for (const it of await listInterruptedRecordings()) {
  // offer resume: rec.start(meeting, { resumeKey: it.key, source: ... })
}
```

- Recordings live in the **origin's quota**; consider
  `navigator.storage.persist()` to resist eviction.
- A recording that's live in another tab is excluded from the interrupted
  list via Web Locks.
- Multi-segment recordings (`resumeKey`) concatenate with `readRecording`,
  but only a single segment is directly playable — segments are independent
  encoder runs, the same caveat as Electron's separate segment files.
- `persist: false` keeps everything in memory and hands the bytes back as
  `result.blob`.

## Permissions

`getPermissionStatus()` → `{ platform: 'web', screen: 'unknown', microphone, camera }`
via the Permissions API (`prompt` maps to `'not-determined'`, same vocabulary
as Electron; `screen` is honestly unknown — the picker is the answer).
`requestPermissions({ camera? })` pre-flights the native prompts.
A known-denied mic/camera makes `start()` reject with `PermissionDeniedError`
(`denied`, `permissions` snapshot) — identical handling to Electron.

## Known constraints

- MediaRecorder's streamed webm reports `Infinity` duration until seeked —
  a Chromium quirk of streaming containers, not data loss.
- Programmatic starts (no user activation) work for `mic`/`streams`/`camera`
  captures; when multiple audio sources force a Web Audio mix, the engine
  resumes the context best-effort (browsers allow it while a live capture
  exists). `display` always needs the gesture.
- `getCapabilities()` reports `{ mode: 'web', detection: false, ... }` —
  meeting detection requires a native process and will arrive via the
  desktop-agent backend (P2), which slots into the same call.
