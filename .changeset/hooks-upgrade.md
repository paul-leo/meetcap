---
"meetcap-renderer": minor
---

React/Vue hooks grow up to app-level recording UI:

- `useRecorder({ shared: true })` — one app-global recorder shared across components; unmounting only unsubscribes, so a recording survives route changes. Default stays per-component.
- New reactive `elapsedMs` (live recorded duration, paused time excluded, corrected from `complete`), `error` (last failure, cleared on next start) and `permissionIssue` (`{ screen, microphone }` derived from `PermissionDeniedError`).
- New `useMeetingDetector({ onDetected, onEnded })` in both frameworks: reactive `meeting` (with `meetingId`) and `isInMeeting` over a shared detector client that also catches a meeting already in progress at startup.
- `Recorder` and `DetectorClient` gain `off(event, fn)`; `createDetectorClient({ syncInitial: true })` probes `detectOnce()` on creation and fires `meeting-detected` for an in-progress meeting.
