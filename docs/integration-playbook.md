# Integration playbook — production patterns

Patterns that real Electron apps need when meetcap graduates from the demo to a
product: custom session partitions, uploading and cleaning up recordings,
debounced meeting boundaries, and multi-window apps. If you built workarounds
for any of these on meetcap ≤0.1.x, see the [migration table](#migrating-off-01x-workarounds)
at the end — each one now has a first-class replacement.

## Picking a package (layered since 0.5)

Pure Electron → `meetcap-renderer` · pure web → `meetcap-web` · hybrid
codebase that records on both → `meetcap-client` (runtime negotiation) ·
hybrid whose web build must NOT record → `meetcap-renderer` + gate with
`isBridgeAvailable()`, or alias `meetcap-renderer/stub` in the web bundler to
drop recording code entirely. Details and the web capture matrix:
[web-recording](./web-recording.md).

## Custom session partitions

The loopback display-media handler is bound **per session**. If your windows
use a partition (`new BrowserWindow({ webPreferences: { partition: 'persist:main' } })`),
a handler bound to the default session is invisible to them and
`getDisplayMedia` fails with *"Not supported"*. Tell meetcap which partition
your recording windows live on:

```ts
initRecorderMain({ partition: 'persist:main' })
```

Omit it when your windows use the default session. Either way, meetcap's
handler always settles the display-media request — if screen sources can't be
enumerated (e.g. screen-recording permission missing), the request is denied
and the renderer's `start()` rejects (typically as `PermissionDeniedError`)
instead of hanging.

Note: while a recording is starting, a concurrent `getDisplayMedia` call from
the same session (e.g. a screen-share picker) would receive the loopback
stream. The handler is only bound between `start()` acquiring its streams —
enable → capture → disable — so keep recording starts and screen-share
prompts from racing in the same session.

## Upload, then clean up

`persistToDisk` (the default) streams the recording to disk and `complete`
hands you `filePath`. Three bridge methods cover the full upload lifecycle —
all of them are restricted to files inside the recordings directory:

```ts
import { readRecording, deleteRecording, recordingExists } from 'meetcap-renderer'

recorder.on('complete', async (r) => {
  if (!r.filePath) return
  const bytes = await readRecording(r.filePath)            // Uint8Array
  const file = new File([bytes], basename(r.filePath), { type: r.mimeType })
  await uploadToYourBackend(file, { meetingId: r.meeting?.meetingId })
  await deleteRecording(r.filePath)                        // manifest cleaned up too
})
```

- **Don't buffer chunks in memory to build the upload Blob** — that defeats
  the flat-memory streaming design. Read the file back once at `complete`
  (or upload incrementally from the `chunk` event).
- **Keep the file on upload failure** and persist `{ filePath, meetingId,
  startTime }` (localStorage or similar) keyed by `meetingId`. On next
  launch: `recordingExists(filePath)` → `readRecording` → re-upload →
  `deleteRecording`. Use `meetingId` as your backend's idempotency key so a
  retry and a late original can't double-submit.
- Crash recovery for *unfinished* recordings is separate:
  `listInterruptedRecordings()` + `start(meeting, { resumeKey })` (see
  [recording-lifecycle](./recording-lifecycle.md)).

## Meeting boundaries: `endGraceMs` + `meetingId`

Detection is poll-based and flickers: a minimized window loses its title, a
meeting helper process blips, and each flicker would fire a false
`meeting-ended`. Debounce it in the main process so every window sees the
same edges:

```ts
startDetector({ endGraceMs: 20_000 })
```

Semantics:

- A meeting that disappears and reappears (same rule id) within the window is
  **one continuous meeting** — same `meetingId`, no events fired.
- The real end is reported once the meeting has been gone for `endGraceMs`
  (worst case + one poll interval), carrying the meeting that ended.
- A *different* meeting app appearing during the grace window ends the old
  meeting immediately: `meeting-ended`(old id) + `meeting-detected`(new id).
- `detectOnce()` and detector state keep reporting the meeting as active
  during the grace window.

"User dismissed the prompt for this meeting" is application state, not
detector state — key your dismissal on `meeting.meetingId` and ignore further
events for that id, rather than trying to reset the detector.

## App-global recording UI with hooks

A recording is app-global state: it must survive route changes and component
unmounts. The React/Vue hooks support that directly:

```tsx
// Any component, any route — all bind to the same app-global recorder.
const { state, elapsedMs, error, permissionIssue, start, stop } =
  useRecorder({ shared: true })

// Meeting awareness anywhere, with occurrence identity built in.
const { meeting, isInMeeting } = useMeetingDetector({
  onDetected: (m) => showPrompt(m),          // m.meetingId identifies the occurrence
  onEnded: (m) => stopIfRecording(m.meetingId),
})
```

- `shared: true` — one recorder for the whole app, created on first use;
  unmounting a component only unsubscribes it. Without it (default) the
  recorder is per-component and destroyed on unmount.
- `elapsedMs` — live recorded duration, paused time excluded, corrected from
  `complete.durationMs`. No hand-rolled timers.
- `error` / `permissionIssue` — the last failure, with
  `{ screen, microphone }` pre-derived from `PermissionDeniedError` so
  permission-help UI is a render expression.
- `useMeetingDetector` shares one detector client app-wide and syncs a
  meeting already in progress at startup (`onDetected` fires for it too).
  Non-hook code gets the same via `createDetectorClient({ syncInitial: true })`.

## Multi-window apps

- The detector broadcasts edge events to **all** windows. Run the
  detection-consuming UI (prompt banner, recording controls) in exactly one
  window — gate by your app's main-window/main-tab notion — or every window
  will prompt for the same meeting.
- A "who is allowed to record right now" mutex across windows or features is
  application policy; meetcap intentionally doesn't own it. `meetingId` gives
  the shared vocabulary: all windows agree on which meeting an event belongs to.

## Permission UX

`start()` rejects with `PermissionDeniedError` carrying `denied`
(`['screen' | 'microphone']`) and a `permissions` snapshot — render your help
UI from that and deep-link with `openScreenRecordingSettings()`. Pre-flight at
app start with `requestPermissions()` so the first recording isn't blocked by
a prompt. Details in [recording-lifecycle](./recording-lifecycle.md#permissions--request-up-front).

## Migrating off 0.1.x workarounds

| If you built… | Replace with |
|---|---|
| A watchdog that treats "start() resolved but never reached `recording`" as failure, plus a permission pre-flight before start | Delete both — `start()` rejects with `PermissionDeniedError` / `StartTimeoutError` (snapshot attached) |
| Your own per-meeting session UUID | `meeting.meetingId` — minted per occurrence, stable across polls, carried on both `meeting-detected` and `meeting-ended` |
| Hijacked `enable/disable-loopback-audio` IPC handlers to rebind the display-media handler onto your partition's session | `initRecorderMain({ partition })` |
| Custom IPC to read/delete/existence-check recording files (with a saveDir path guard) | `readRecording` / `deleteRecording` / `recordingExists` |
| Accumulating every `chunk` in memory to build the upload Blob | `readRecording(filePath)` at `complete` |
| A renderer-side grace/debounce wrapper around the detector client | `startDetector({ endGraceMs })` — debounced once in main, consistent across windows |
| An init-time `detectOnce()` probe to catch a meeting already in progress | Still valid — and it now returns the tracked occurrence with its `meetingId` |
