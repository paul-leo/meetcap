# meetcap-renderer

## 0.5.0

### Minor Changes

- 6e22ccd: Layered packaging + browser-native recording:

  - **meetcap-capture** (new): the shared backend-agnostic recording engine — state machine, epoch abort, pause accounting, ordered chunk persistence — with stream acquisition / persistence / permissions injected per environment. First direct state-machine unit tests.
  - **meetcap-web** (new): browser recording with sources `mic` / `camera` / `display` (share picker; tab & system audio per platform) / `streams` (e.g. WebRTC remote audio — zero-permission), IndexedDB crash-safe persistence (per-chunk transactions, Web Locks live-detection, resume-as-segments), Permissions-API snapshots, React/Vue hooks. Single-audio-source captures bypass Web Audio entirely, so programmatic starts don't record silence from a suspended AudioContext.
  - **meetcap-client** (new): runtime negotiation for hybrid web/Electron codebases — Electron backend when `window.meetcap` exists, web backend otherwise; unified `getCapabilities()`.
  - **meetcap-renderer**: internally rebuilt on meetcap-capture (public API unchanged); new `isBridgeAvailable()`, typed `BridgeUnavailableError`, `getCapabilities()` and a `meetcap-renderer/stub` subpath for hybrid apps whose web build must ship no recording code.
  - New `examples/web-demo` (harness-driveable) and `docs/web-recording.md` incl. the package-picking guide.

### Patch Changes

- Updated dependencies [6e22ccd]
  - meetcap-capture@0.5.0

## 0.4.0

### Minor Changes

- 964b9b6: Permission guidance: deep-link every relevant macOS privacy pane, and document what host apps must declare.

  - New `openPrivacySettings(pane: 'screen' | 'microphone' | 'camera')` (bridge + renderer export) — pair with `PermissionDeniedError.denied` to send the user straight to the right switch. `openScreenRecordingSettings()` stays as the `'screen'` alias.
  - Docs: the Permissions guide gains a query→guide loop example and a **"What your app must declare"** section — `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` Info.plist keys, hardened-runtime entitlements, and the screen-recording TCC flow (no plist key; toggle + restart) — with the demo's electron-builder config as a copyable reference. Missing declarations previously failed in ways that looked like meetcap bugs.

### Patch Changes

- Updated dependencies [964b9b6]
  - meetcap-core@0.4.0

## 0.3.0

### Minor Changes

- f6a61b2: Recordings can now include a video track — the user's screen or camera — chosen per recording:

  - `recorder.start(meeting, { video: 'screen' | 'camera' })` adds a video track; output becomes `video/webm` (VP9→VP8→bare fallback via new `pickVideoMimeType`). Audio-only stays the default and unchanged.
  - `'screen'` reuses the display capture that already provides loopback system audio (no extra permission); `'camera'` requests the camera via `getUserMedia` (native prompt on first use).
  - `RecordingResult.videoSource: 'screen' | 'camera' | null` reports what was captured; `PermissionStatus` gains `camera` (mediaAccess/requestPermissions snapshots — no camera pre-prompt, it appears on the first camera recording); a denied camera rejects `start()` with `PermissionDeniedError` whose `denied` includes `'camera'`; hooks' `permissionIssue` gains `camera: boolean`.
  - Demo: video-source selector + `<video>` preview of the saved file.

### Patch Changes

- Updated dependencies [f6a61b2]
  - meetcap-core@0.3.0

## 0.2.0

### Minor Changes

- 81d6f77: React/Vue hooks grow up to app-level recording UI:

  - `useRecorder({ shared: true })` — one app-global recorder shared across components; unmounting only unsubscribes, so a recording survives route changes. Default stays per-component.
  - New reactive `elapsedMs` (live recorded duration, paused time excluded, corrected from `complete`), `error` (last failure, cleared on next start) and `permissionIssue` (`{ screen, microphone }` derived from `PermissionDeniedError`).
  - New `useMeetingDetector({ onDetected, onEnded })` in both frameworks: reactive `meeting` (with `meetingId`) and `isInMeeting` over a shared detector client that also catches a meeting already in progress at startup.
  - `Recorder` and `DetectorClient` gain `off(event, fn)`; `createDetectorClient({ syncInitial: true })` probes `detectOnce()` on creation and fires `meeting-detected` for an in-progress meeting.

- 8d3f043: Three integration capabilities that production apps previously had to hand-roll:

  - **Custom session partitions**: `initRecorderMain({ partition: 'persist:main' })` binds the loopback display-media handler to the session your windows actually use (it previously landed on the default session only, making `getDisplayMedia` fail with "Not supported" on partitioned windows). meetcap now owns the handler and always settles the request — when screen sources can't be enumerated the request is denied so the renderer rejects instead of hanging forever.
  - **Recording file access**: new bridge methods `readRecording(filePath): Promise<Uint8Array>`, `deleteRecording(filePath)` and `recordingExists(filePath)` (exported from meetcap-renderer, new IPC channels in meetcap-core) cover the upload → cleanup → crash-recovery-check lifecycle without custom IPC. All three are restricted to files inside the recordings directory; `deleteRecording` also sweeps manifests whose segments are all gone.
  - **Debounced meeting boundaries**: `startDetector({ endGraceMs })` treats a meeting that disappears and reappears (same rule id) within the window as one continuous meeting — same `meetingId`, no `ended`/`detected` churn from poll flicker (minimized windows, process blips). Default 0 keeps current behavior.

  Also new: `docs/integration-playbook.md` — production patterns and a migration table for apps replacing 0.1.x workarounds.

- cb62682: Every detected meeting now carries a unique per-occurrence `meetingId`, so recordings and events can be correlated with a specific meeting and back-to-back meetings no longer blur together.

  - `MeetingInfo.meetingId?: string` — minted by the detector when a meeting occurrence is first seen, stable across polls until it ends. Flows unchanged through detector events, `openRecording`, the on-disk manifest and `RecordingResult.meeting`.
  - `meeting-ended` now carries the `MeetingInfo` that ended (previously `null`), same `meetingId` as its `meeting-detected` — consumers can finally tell _which_ meeting ended. `DetectorEvent.meeting` is now non-nullable.
  - A meeting swap (e.g. Zoom ends and Teams starts within one poll interval) now emits `meeting-ended` (old id) followed by `meeting-detected` (new id) in the same tick; previously no events fired and the change was invisible.
  - Renderer `meeting-ended` handlers receive the ended meeting: `detector.on('meeting-ended', (m) => ...)`. Existing zero-arg callbacks keep working.
  - `detectOnce()` returns the tracked occurrence (with its `meetingId`) when the poller is already following a meeting.

  Migration: only consumers that read `evt.meeting` on raw `meeting-ended` IPC events and expected `null` need updating; the id is optional everywhere else.

- d30ecd7: `recorder.start()` now rejects when the capture can't begin, instead of resolving into limbo (#7).

  - Rejects with `PermissionDeniedError` (`code: 'permission-denied'`) when an OS media permission is denied/restricted — carries `denied: ('screen'|'microphone')[]` and a `permissions` snapshot so no second `getPermissionStatus()` round-trip is needed.
  - A permission pre-flight fails fast before `getDisplayMedia` can hang (macOS: the loopback display-media handler never calls back when screen recording is denied); a new `startTimeoutMs` option (default 15000, `0` disables) backstops the remaining hang cases with `StartTimeoutError` (`code: 'start-timeout'`).
  - `stop()`/`destroy()` during a pending `start()` now abort it (previously a silent no-op that leaked the pending native request).
  - A start that fails after opening its disk segment now closes it, so no phantom "interrupted recording" is left behind.

  Migration: fire-and-forget callers (`void recorder.start(...)`) should add a `.catch()` — every rejection is still emitted as an `error` event, but the promise no longer swallows failures.

### Patch Changes

- Updated dependencies [8d3f043]
- Updated dependencies [cb62682]
  - meetcap-core@0.2.0

## 0.1.0

### Minor Changes

- 54598c6: First release of meetcap — detect a meeting and record both sides of the audio in any Electron app.

  - **Detection** (`meetcap-main`): poll window titles + processes against built-in rules (Zoom / Teams / Tencent / Lark) or custom ones. Selectable `require` modes — `'either'` (default), `'process'`, `'window'`, `'window+process'` — plus a `meetingProcess` rule field so a minimized/hidden meeting window no longer reads as "ended".
  - **Recording** (`meetcap-main` setup + `meetcap-renderer` capture): mic + system (loopback) audio, mixed and streamed to disk chunk-by-chunk (flat memory, crash-safe partial file), with a sidecar manifest for segments / resume. `pause()` / `resume()` hold within the same file; `durationMs` excludes paused time.
  - **Renderer** (`meetcap-renderer`): framework-agnostic recorder + detector client, plus React (`/react`) and Vue (`/vue`) hooks.
  - **Core** (`meetcap-core`): shared types, the IPC contract, and the `window.meetcap` preload bridge.

### Patch Changes

- Updated dependencies [54598c6]
  - meetcap-core@0.1.0
