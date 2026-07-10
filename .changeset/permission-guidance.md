---
"meetcap-core": minor
"meetcap-main": minor
"meetcap-renderer": minor
---

Permission guidance: deep-link every relevant macOS privacy pane, and document what host apps must declare.

- New `openPrivacySettings(pane: 'screen' | 'microphone' | 'camera')` (bridge + renderer export) — pair with `PermissionDeniedError.denied` to send the user straight to the right switch. `openScreenRecordingSettings()` stays as the `'screen'` alias.
- Docs: the Permissions guide gains a query→guide loop example and a **"What your app must declare"** section — `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` Info.plist keys, hardened-runtime entitlements, and the screen-recording TCC flow (no plist key; toggle + restart) — with the demo's electron-builder config as a copyable reference. Missing declarations previously failed in ways that looked like meetcap bugs.
