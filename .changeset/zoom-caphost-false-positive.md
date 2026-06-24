---
"meetcap-main": patch
---

Fix Zoom false positive: `caphost` is Zoom Workplace's capture/screenshot helper that runs while the app is merely open (e.g. the login screen), not a meeting. Removed it from the Zoom rule's `meetingProcess` so being signed in no longer reads as "in a meeting". The genuine meeting-only helpers `CptHost` and `aomhost` (spawned on join, gone on leave) remain.
