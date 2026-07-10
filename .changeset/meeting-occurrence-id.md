---
"meetcap-core": minor
"meetcap-main": minor
"meetcap-renderer": minor
---

Every detected meeting now carries a unique per-occurrence `meetingId`, so recordings and events can be correlated with a specific meeting and back-to-back meetings no longer blur together.

- `MeetingInfo.meetingId?: string` — minted by the detector when a meeting occurrence is first seen, stable across polls until it ends. Flows unchanged through detector events, `openRecording`, the on-disk manifest and `RecordingResult.meeting`.
- `meeting-ended` now carries the `MeetingInfo` that ended (previously `null`), same `meetingId` as its `meeting-detected` — consumers can finally tell *which* meeting ended. `DetectorEvent.meeting` is now non-nullable.
- A meeting swap (e.g. Zoom ends and Teams starts within one poll interval) now emits `meeting-ended` (old id) followed by `meeting-detected` (new id) in the same tick; previously no events fired and the change was invisible.
- Renderer `meeting-ended` handlers receive the ended meeting: `detector.on('meeting-ended', (m) => ...)`. Existing zero-arg callbacks keep working.
- `detectOnce()` returns the tracked occurrence (with its `meetingId`) when the poller is already following a meeting.

Migration: only consumers that read `evt.meeting` on raw `meeting-ended` IPC events and expected `null` need updating; the id is optional everywhere else.
