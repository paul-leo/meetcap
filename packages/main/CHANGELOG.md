# meetcap-main

## 0.3.0

### Minor Changes

- 7e9a010: Detection now defaults to process-only everywhere; window detection is opt-in.

  `resolveMeeting`'s default policy moves from `'either'` to `'process'`, aligning it with `startDetector` (whose default was already `'process'`). Rationale: window enumeration requires elevated permissions on macOS (screen recording / Sequoia picker) and flickers under real desktop conditions (a minimized or fully occluded window drops out of the window list), while a meeting-scoped process signal needs zero permissions and is stable. Opt into window signals explicitly with `require: 'either'` / `'window'` / `'window+process'`.

  Note: under the default, only rules with a `meetingProcess` are detectable (of the presets, Zoom). The demo gains a `MEETCAP_DEMO_REQUIRE` env knob for opting into window detection in tests.

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

### Patch Changes

- Updated dependencies [8d3f043]
- Updated dependencies [cb62682]
  - meetcap-core@0.2.0

## 0.1.2

### Patch Changes

- 69faff8: fix(detector): skip desktopCapturer when policy is 'process', default to 'process'

  When `require` is `'process'`, `listWindowSources()` is now skipped entirely so
  `desktopCapturer.getSources` is never called — eliminating the macOS Sequoia
  SCContentSharingPicker permission dialog for process-only detection.

  Default policy changed from `'either'` to `'process'` to avoid the permission
  prompt out of the box.

## 0.1.1

### Patch Changes

- 3fb51b6: Fix Zoom false positive: `caphost` is Zoom Workplace's capture/screenshot helper that runs while the app is merely open (e.g. the login screen), not a meeting. Removed it from the Zoom rule's `meetingProcess` so being signed in no longer reads as "in a meeting". The genuine meeting-only helpers `CptHost` and `aomhost` (spawned on join, gone on leave) remain.

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
