---
"meetcap-main": minor
---

Detection now defaults to process-only everywhere; window detection is opt-in.

`resolveMeeting`'s default policy moves from `'either'` to `'process'`, aligning it with `startDetector` (whose default was already `'process'`). Rationale: window enumeration requires elevated permissions on macOS (screen recording / Sequoia picker) and flickers under real desktop conditions (a minimized or fully occluded window drops out of the window list), while a meeting-scoped process signal needs zero permissions and is stable. Opt into window signals explicitly with `require: 'either'` / `'window'` / `'window+process'`.

Note: under the default, only rules with a `meetingProcess` are detectable (of the presets, Zoom). The demo gains a `MEETCAP_DEMO_REQUIRE` env knob for opting into window detection in tests.
