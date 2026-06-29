---
"meetcap-main": patch
---

fix(detector): skip desktopCapturer when policy is 'process', default to 'process'

When `require` is `'process'`, `listWindowSources()` is now skipped entirely so
`desktopCapturer.getSources` is never called — eliminating the macOS Sequoia
SCContentSharingPicker permission dialog for process-only detection.

Default policy changed from `'either'` to `'process'` to avoid the permission
prompt out of the box.
