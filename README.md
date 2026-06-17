# meetcap

**Detect a meeting and record both sides of the audio — in any Electron app.**

meetcap answers one question honestly: can an Electron app notice you've joined a meeting (Zoom / Teams / 腾讯会议 / 飞书) and record *both* your microphone *and* the other party's voice (system / loopback audio), then save it locally — with a hardened, production-style config?

It ships as a main-process half, a renderer-process half, and a shared core — take only what you need (detection and recording are independent in each half).

![meetcap demo walkthrough](docs/assets/demo-walkthrough.gif)

*The runnable [`examples/electron-demo`](examples/electron-demo): a meeting (Zoom) is **detected** → a banner offers to record → **pause / resume** mid-call → **stop** (or the meeting ends) saves a `.webm` with `systemAudio=true`. Driven and captured via [harness-fe](docs/debugging.md).*

| Package | Process | What it does |
|---|---|---|
| [`meetcap-main`](packages/main) | main | Detection (window-title + process poller, rule engine) **and** recorder setup (macOS loopback flags + streaming save + media-access). |
| [`meetcap-renderer`](packages/renderer) | renderer | Detector client (subscribe to events) **and** capture: mic + system audio, mix, record, save. Framework-agnostic + React/Vue hooks. |
| [`meetcap-core`](packages/core) | shared | Shared types, the IPC contract, and the `window.meetcap` preload bridge. |

The split is by **process**, not by feature — so you never import a main-only API (`desktopCapturer`, `ps-list`, loopback flags) into a renderer bundle. Within each half, detection and recording are independent: use one, the other, or both.

## Quick start

```bash
npm install meetcap-core meetcap-main meetcap-renderer
```

```ts
// main.ts — runs before app.whenReady()
import { initRecorderMain, startDetector } from 'meetcap-main'
initRecorderMain()
app.whenReady().then(() => { createWindow(); startDetector({ require: 'either' }) })

// preload.ts
import { contextBridge, ipcRenderer } from 'electron'
import { exposeMeetcapBridge } from 'meetcap-core/preload'
exposeMeetcapBridge(contextBridge, ipcRenderer)

// renderer
import { createDetectorClient, createRecorder } from 'meetcap-renderer'
const detector = createDetectorClient()
const recorder = createRecorder()
detector.on('meeting-detected', (m) => recorder.start(m))   // banner → user confirms → start
detector.on('meeting-ended', () => recorder.stop())          // call ends → stop & save
recorder.on('complete', (r) => console.log(r.filePath))      // saved to disk

// mid-call controls — pause/resume stay in the SAME file/segment:
recorder.pause()    // freezes capture (no chunks written while paused)
recorder.resume()   // continues the same recording
recorder.stop()     // finalizes the .webm
```

See [`examples/electron-demo`](examples/electron-demo) for a complete, runnable app, and the **[recording lifecycle & integration guide](docs/recording-lifecycle.md)** for which events to wire, when recording starts/ends, segmented vs whole-file upload, and crash-resume.

## Architecture: who runs where

Electron splits this work across two processes; meetcap hides the split behind `/main` and `/renderer` entries.

```
 main process                          renderer process
 ────────────                          ────────────────
 desktopCapturer (window titles)  ┐
 ps-list (process names)          �├─ detect ──► broadcast ──► createDetectorClient / hooks
 rule engine                      ┘                              (meeting-detected / ended)

 initMain() loopback flags        ┐                          getUserMedia(mic)
 save-recording (fs)              ┤◄─ window.meetcap (IPC) ─►  getDisplayMedia(loopback)
 media-access                     ┘                          AudioContext mix → MediaRecorder
```

- **Detection** is essentially main-process — `desktopCapturer` and `ps-list` are main-only. The poller broadcasts edge events; the renderer just subscribes.
- **Recording** is renderer-process capture (`getUserMedia` / `getDisplayMedia` / `MediaRecorder`) plus main-process flag injection and disk writes.

## Platform support

| | Detection | Mic | System / loopback audio |
|---|---|---|---|
| **macOS 13.2+** | ✅ window + process | ✅ | ✅ via `MacLoopbackAudioForScreenShare` flags (injected) |
| **macOS < 13.2** | ✅ | ✅ | ⚠️ may be empty → records mic-only, `hasSystemAudio:false` |
| **Windows 10+** | ✅ | ✅ | ✅ WASAPI loopback |
| **Linux** | ✅ | ✅ | ✅ PulseAudio |

On macOS, grant **Screen Recording** + **Microphone** to your app (System Settings → Privacy & Security), then restart.

## Custom rules

Adapt to any meeting client without touching meetcap internals:

```ts
import { presets, startDetector } from 'meetcap-main'
startDetector({
  rules: [
    ...presets,
    {
      id: 'mymeet',
      app: 'MyMeet',
      window: [/MyMeet 通话/],
      process: [/mymeet/i],
      meetingProcess: [/mymeet-call/i], // a process that exists ONLY during a call
    },
  ],
})
```

Strings match as case-insensitive substrings, RegExps test directly, or pass a function.

**Detection modes** (`require`): how meetcap decides you're in a call.

| mode | proves "in a meeting" by | notes |
|---|---|---|
| `'either'` *(default)* | a meeting window **or** a `meetingProcess` | most robust — a minimized/hidden window doesn't read as "ended" |
| `'process'` | only a `meetingProcess` | window ignored; best when the call window is usually minimized |
| `'window'` | only a window title | precise but fragile (lost when the window is hidden) |
| `'window+process'` | both, same rule | strictest, fewest false positives |

`meetingProcess` is the key to robust detection: list the helper process a client spawns **only during a call** (Zoom's `CptHost` / `aomhost`), never the always-on app process (`zoom.us`) — otherwise merely opening the app reads as a meeting.

## Known limitations

- **Browser-based meetings** (Google Meet / Zoom Web in a tab) are **not** reliably detected — a browser tab has no distinctive process and a messy title. Recording still works (loopback captures whatever plays), only auto-detection is out of scope for now.
- No transcription / speaker diarization yet — meetcap captures audio; turning it into notes is downstream.

## Download / Install the demo app

Try meetcap without a toolchain — build the demo into a real, installable macOS app:

```bash
pnpm install
pnpm dist:app     # turbo build + electron-builder → examples/electron-demo/dist/meetcap-<ver>-arm64.dmg
```

Open the `.dmg`, drag **meetcap** to Applications, then launch it. On first run:

- The build is **unsigned** (local/dev): macOS Gatekeeper blocks it → **right-click → Open** once (or `xattr -dr com.apple.quarantine /Applications/meetcap.app`).
- Grant **Microphone** when prompted, and **Screen Recording** in System Settings → Privacy & Security (then relaunch) — that's what captures the other party's voice.

Recordings land in `~/Downloads/meetcap/`. For signed, notarized distribution (no Gatekeeper friction, stable permissions across updates) add a Developer ID identity + notarization in `examples/electron-demo/electron-builder.yml` — see comments there.

## Develop

```bash
pnpm install
pnpm build        # turbo: builds all packages
pnpm test         # vitest: rule engine, state machine, pure helpers
pnpm demo         # build + launch examples/electron-demo
pnpm dist:app     # package the demo into a downloadable macOS .dmg
```

## Debugging the demo

The demo is wired for AI-agent debugging via [harness-fe](https://github.com/Morphicai/harness-fe) in **solo mode** — a tokenless local gateway on `127.0.0.1:47620`. Install the skill (`npx @harness-fe/skill install`), reload MCP (`.mcp.json` is committed), run `pnpm demo`, and an agent can stream console/network/DOM and drive the window. Full guide: [docs/debugging.md](docs/debugging.md).

## Release

Changesets-driven. In a PR: `pnpm changeset` to declare bumps. On merge to `main`, CI opens a **Version Packages** PR; merging it publishes to npm (OIDC trusted publishing with NPM_TOKEN fallback). See `.github/workflows/release.yml`.

## License

MIT
