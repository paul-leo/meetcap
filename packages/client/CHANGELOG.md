# meetcap-client

## 0.5.0

### Minor Changes

- 6e22ccd: Layered packaging + browser-native recording:

  - **meetcap-capture** (new): the shared backend-agnostic recording engine — state machine, epoch abort, pause accounting, ordered chunk persistence — with stream acquisition / persistence / permissions injected per environment. First direct state-machine unit tests.
  - **meetcap-web** (new): browser recording with sources `mic` / `camera` / `display` (share picker; tab & system audio per platform) / `streams` (e.g. WebRTC remote audio — zero-permission), IndexedDB crash-safe persistence (per-chunk transactions, Web Locks live-detection, resume-as-segments), Permissions-API snapshots, React/Vue hooks. Single-audio-source captures bypass Web Audio entirely, so programmatic starts don't record silence from a suspended AudioContext.
  - **meetcap-client** (new): runtime negotiation for hybrid web/Electron codebases — Electron backend when `window.meetcap` exists, web backend otherwise; unified `getCapabilities()`.
  - **meetcap-renderer**: internally rebuilt on meetcap-capture (public API unchanged); new `isBridgeAvailable()`, typed `BridgeUnavailableError`, `getCapabilities()` and a `meetcap-renderer/stub` subpath for hybrid apps whose web build must ship no recording code.
  - New `examples/web-demo` (harness-driveable) and `docs/web-recording.md` incl. the package-picking guide.

### Patch Changes

- Updated dependencies [6e22ccd]
  - meetcap-capture@0.5.0
  - meetcap-web@0.5.0
  - meetcap-renderer@0.5.0
