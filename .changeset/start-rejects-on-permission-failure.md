---
"meetcap-renderer": minor
---

`recorder.start()` now rejects when the capture can't begin, instead of resolving into limbo (#7).

- Rejects with `PermissionDeniedError` (`code: 'permission-denied'`) when an OS media permission is denied/restricted — carries `denied: ('screen'|'microphone')[]` and a `permissions` snapshot so no second `getPermissionStatus()` round-trip is needed.
- A permission pre-flight fails fast before `getDisplayMedia` can hang (macOS: the loopback display-media handler never calls back when screen recording is denied); a new `startTimeoutMs` option (default 15000, `0` disables) backstops the remaining hang cases with `StartTimeoutError` (`code: 'start-timeout'`).
- `stop()`/`destroy()` during a pending `start()` now abort it (previously a silent no-op that leaked the pending native request).
- A start that fails after opening its disk segment now closes it, so no phantom "interrupted recording" is left behind.

Migration: fire-and-forget callers (`void recorder.start(...)`) should add a `.catch()` — every rejection is still emitted as an `error` event, but the promise no longer swallows failures.
