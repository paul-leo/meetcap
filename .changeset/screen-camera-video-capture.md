---
"meetcap-core": minor
"meetcap-main": minor
"meetcap-renderer": minor
---

Recordings can now include a video track — the user's screen or camera — chosen per recording:

- `recorder.start(meeting, { video: 'screen' | 'camera' })` adds a video track; output becomes `video/webm` (VP9→VP8→bare fallback via new `pickVideoMimeType`). Audio-only stays the default and unchanged.
- `'screen'` reuses the display capture that already provides loopback system audio (no extra permission); `'camera'` requests the camera via `getUserMedia` (native prompt on first use).
- `RecordingResult.videoSource: 'screen' | 'camera' | null` reports what was captured; `PermissionStatus` gains `camera` (mediaAccess/requestPermissions snapshots — no camera pre-prompt, it appears on the first camera recording); a denied camera rejects `start()` with `PermissionDeniedError` whose `denied` includes `'camera'`; hooks' `permissionIssue` gains `camera: boolean`.
- Demo: video-source selector + `<video>` preview of the saved file.
