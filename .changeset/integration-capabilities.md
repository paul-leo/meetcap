---
"meetcap-core": minor
"meetcap-main": minor
"meetcap-renderer": minor
---

Three integration capabilities that production apps previously had to hand-roll:

- **Custom session partitions**: `initRecorderMain({ partition: 'persist:main' })` binds the loopback display-media handler to the session your windows actually use (it previously landed on the default session only, making `getDisplayMedia` fail with "Not supported" on partitioned windows). meetcap now owns the handler and always settles the request — when screen sources can't be enumerated the request is denied so the renderer rejects instead of hanging forever.
- **Recording file access**: new bridge methods `readRecording(filePath): Promise<Uint8Array>`, `deleteRecording(filePath)` and `recordingExists(filePath)` (exported from meetcap-renderer, new IPC channels in meetcap-core) cover the upload → cleanup → crash-recovery-check lifecycle without custom IPC. All three are restricted to files inside the recordings directory; `deleteRecording` also sweeps manifests whose segments are all gone.
- **Debounced meeting boundaries**: `startDetector({ endGraceMs })` treats a meeting that disappears and reappears (same rule id) within the window as one continuous meeting — same `meetingId`, no `ended`/`detected` churn from poll flicker (minimized windows, process blips). Default 0 keeps current behavior.

Also new: `docs/integration-playbook.md` — production patterns and a migration table for apps replacing 0.1.x workarounds.
