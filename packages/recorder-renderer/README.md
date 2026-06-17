# meetcap-recorder-renderer

Renderer-process half of [meetcap recording](https://github.com/paul-leo/zoom-record-demo). Records **both sides** of a call — your microphone *and* the other party's voice (system / loopback audio) — mixes them, and **streams the result straight to disk** (flat memory; crash-safe partial file).

```bash
npm install meetcap-recorder-renderer meetcap-core
```

Pair it with [`meetcap-recorder-main`](../recorder-main) (which injects the macOS loopback flags and handles disk writes) and the [`meetcap-core/preload`](../core) bridge.

### Framework-agnostic

```ts
import { createRecorder } from 'meetcap-recorder-renderer'

const rec = createRecorder()
rec.on('complete', (result) => {
  // Already on disk — no save step. result.filePath → <downloads>/meetcap/meetcap-Zoom-….webm
  console.log(result.filePath, result.durationMs, 'ms · systemAudio:', result.hasSystemAudio)
})
await rec.start(meeting) // meeting is optional metadata for the filename
// …later: rec.stop()
```

### React

```tsx
import { useRecorder } from 'meetcap-recorder-renderer/react'
const { start, stop, state, lastResult, save } = useRecorder()
```

### Vue

```vue
<script setup lang="ts">
import { useRecorder } from 'meetcap-recorder-renderer/vue'
const { start, stop, state, lastResult, save } = useRecorder()
</script>
```

## Platform notes

- **macOS 13.2+** — loopback works via the flags injected by `meetcap-recorder-main`. Older macOS may return an empty system track; the recorder records mic-only and sets `hasSystemAudio: false` instead of failing.
- **Windows 10+** — WASAPI loopback. **Linux** — PulseAudio.

## Pure API (testable, no Electron)

`pickMimeType()` and `buildFilename(meeting, date, prefix)` are exported from the root.

## License

MIT
