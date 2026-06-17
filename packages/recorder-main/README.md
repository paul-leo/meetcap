# meetcap-recorder-main

Main-process half of [meetcap recording](https://github.com/paul-leo/zoom-record-demo). Call once, at the top of your Electron main entry, **before** `app.whenReady()`:

```bash
npm install meetcap-recorder-main meetcap-core
```

```ts
import { initRecorderMain } from 'meetcap-recorder-main'

initRecorderMain() // or { saveDir, revealInFolder }
```

It (1) injects the macOS loopback Chromium feature flags + registers the enable/disable-loopback-audio handlers (via [`electron-audio-loopback`](https://github.com/alectrocute/electron-audio-loopback)), and (2) registers the streaming recording IPC (`open` / `write` / `close`) and `media-access`.

Recordings are **streamed to disk** as they're captured (one timeslice appended per chunk), so memory stays flat regardless of length and a mid-session crash leaves a partial-but-playable file.

The renderer half — capture, mix, record — is [`meetcap-recorder-renderer`](../recorder-renderer).

## Options

| Option | Default | Meaning |
|---|---|---|
| `saveDir` | `<downloads>/meetcap` | Directory for saved recordings. |
| `revealInFolder` | `true` | Reveal the saved file in the OS file manager. |

## License

MIT
