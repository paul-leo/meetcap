# meetcap-renderer

The **renderer-process** half of [meetcap](https://github.com/paul-leo/meetcap): subscribe to meeting detection **and** capture mic + system (loopback) audio, mix, record to webm, and save — in any Electron app. Pair it with [`meetcap-main`](../main) and [`meetcap-core`](../core).

Import this in the **renderer** only. Requires `window.meetcap` (wired by `meetcap-core/preload`) and `initRecorderMain()` running in the main process.

## Install

```bash
npm install meetcap-renderer meetcap-core
```

## Usage

```ts
import { createDetectorClient, createRecorder } from 'meetcap-renderer'

const detector = createDetectorClient()
const recorder = createRecorder()

detector.on('meeting-detected', (m) => recorder.start(m)) // or show a prompt first
detector.on('meeting-ended', () => recorder.stop())        // call ends → stop & save
recorder.on('complete', (r) => console.log(r.filePath, r.segments))

// mid-call controls — pause/resume stay in the SAME file/segment:
recorder.pause()   // state → 'paused'; no chunks written while paused
recorder.resume()  // continue the same recording
recorder.stop()    // finalize the .webm (durationMs excludes paused time)
```

The detector client and recorder are independent — use either or both.

### Segmented (streaming) upload

```ts
recorder.on('chunk', ({ index, blob }) => uploadPart(index, blob)) // per timeslice
recorder.on('complete', (r) => finishUpload(r.recordingKey))
```

## Framework hooks

```ts
import { useRecorder } from 'meetcap-renderer/react' // or 'meetcap-renderer/vue'
const { state, lastResult, start, pause, resume, stop } = useRecorder()
```

`react` / `vue` are optional peer dependencies.

## License

MIT
