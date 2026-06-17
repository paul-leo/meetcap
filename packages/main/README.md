# meetcap-main

The **main-process** half of [meetcap](https://github.com/paul-leo/meetcap): detect native meeting clients (Zoom / Teams / Tencent / Lark) **and** set up loopback recording — in any Electron app. Pair it with [`meetcap-renderer`](../renderer) and [`meetcap-core`](../core).

Import this in the Electron **main process only** — it reaches for `desktopCapturer`, `ps-list`, and the macOS loopback flags.

## Install

```bash
npm install meetcap-main meetcap-core
```

## Usage

```ts
// main.ts — run initRecorderMain() BEFORE app.whenReady()
import { initRecorderMain, startDetector } from 'meetcap-main'

initRecorderMain() // macOS loopback flags + recording IPC (open/write/close) + media-access

app.whenReady().then(() => {
  createWindow()
  const detector = startDetector({ require: 'either' }) // broadcasts meeting-detected / -ended
  // …later: detector.stop()
})
```

Detection and recording setup are independent — call only what you need.

## Detection modes — `startDetector({ require })`

| mode | proves "in a meeting" by | notes |
|---|---|---|
| `'either'` *(default)* | a meeting window **or** a `meetingProcess` | robust — a minimized/hidden window doesn't read as "ended" |
| `'process'` | only a `meetingProcess` | window ignored |
| `'window'` | only a window title | precise but fragile |
| `'window+process'` | both, same rule | strictest |

### Custom rules

```ts
import { presets, startDetector } from 'meetcap-main'

startDetector({
  rules: [
    ...presets,
    {
      id: 'mymeet',
      app: 'MyMeet',
      window: [/MyMeet 通话/],          // window-title matchers (string = substring, or RegExp/fn)
      process: [/mymeet/i],             // corroborating process names
      meetingProcess: [/mymeet-call/i], // process that exists ONLY during a call (robust signal)
    },
  ],
})
```

Put the *meeting-scoped* helper (Zoom's `CptHost` / `aomhost`) in `meetingProcess`, never the always-on app process (`zoom.us`) — otherwise merely opening the app reads as a meeting.

## Recording

`initRecorderMain()` registers the streaming recording IPC consumed by `meetcap-renderer` — audio streams to disk chunk-by-chunk (flat memory, crash-safe partial file), tracked by a sidecar manifest for segments / resume. Saved to `~/Downloads/meetcap/` by default (`initRecorderMain({ saveDir })` to change).

See the [recording lifecycle guide](../../docs/recording-lifecycle.md) for the full picture.

## License

MIT
