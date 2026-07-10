/**
 * Vue composable over the web recorder. Duplicate-adapted from
 * meetcap-renderer's composable (the repo's parallel-copy pattern).
 *
 *   import { useRecorder } from 'meetcap-web/vue'
 *   const { start, stop, state, elapsedMs, permissionIssue } = useRecorder({ shared: true })
 *
 * `vue` is an optional peer dependency.
 */
import { computed, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import type { MeetingInfo } from 'meetcap-core'
import { PermissionDeniedError, type RecorderState, type RecordingChunk } from 'meetcap-capture'
import {
  createRecorder,
  type WebCreateRecorderOptions,
  type WebRecorder,
  type WebRecordingResult,
  type WebStartOptions,
} from './recorder'

export interface UseRecorderOptions extends WebCreateRecorderOptions {
  /** Called per timeslice — use for incremental/segmented upload. */
  onChunk?: (chunk: RecordingChunk) => void
  /**
   * Share one app-global recorder across all components. A recording is
   * app-global state — with `shared: true`, unmounting only unsubscribes this
   * component and the recording keeps running. Default false.
   */
  shared?: boolean
}

/** Which media permissions blocked the last start — render permission-help UI from this. */
export interface PermissionIssue {
  screen: boolean
  microphone: boolean
  camera: boolean
}

let sharedRecorder: WebRecorder | null = null
const getSharedRecorder = (options?: WebCreateRecorderOptions): WebRecorder =>
  (sharedRecorder ??= createRecorder(options))

export function useRecorder(options?: UseRecorderOptions): {
  state: Ref<RecorderState>
  lastResult: Ref<WebRecordingResult | null>
  /** Live recorded duration (ms), paused time excluded; corrected from `complete`. */
  elapsedMs: Ref<number>
  /** Last recorder error (cleared when the next start() begins). */
  error: Ref<unknown>
  /** Set when `error` is a PermissionDeniedError; null otherwise. */
  permissionIssue: ComputedRef<PermissionIssue | null>
  /** Rejects on failure — same contract as recorder.start(). Display capture needs a real click. */
  start: (meeting?: MeetingInfo | null, opts?: WebStartOptions) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
} {
  const state = ref<RecorderState>('idle')
  const lastResult = ref<WebRecordingResult | null>(null)
  const elapsedMs = ref(0)
  const error = ref<unknown>(null)
  const recorder = options?.shared ? getSharedRecorder(options) : createRecorder(options)

  // Duration ticker: accumulate wall-clock only while recording, so paused
  // time is excluded — mirrors the recorder's own duration accounting.
  let elapsed = 0
  let lastTickAt = 0
  let timer: ReturnType<typeof setInterval> | null = null
  const stopTicker = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  const startTicker = () => {
    stopTicker()
    lastTickAt = Date.now()
    timer = setInterval(() => {
      const now = Date.now()
      elapsed += now - lastTickAt
      lastTickAt = now
      elapsedMs.value = elapsed
    }, 1000)
  }

  let prev: RecorderState = recorder.state
  const onState = (s: RecorderState) => {
    if (s === 'recording') {
      if (prev === 'idle') {
        elapsed = 0
        elapsedMs.value = 0
      }
      startTicker()
    } else {
      if (prev === 'recording' && timer) elapsed += Date.now() - lastTickAt
      stopTicker()
      elapsedMs.value = elapsed
    }
    prev = s
    state.value = s
  }
  const onComplete = (r: WebRecordingResult) => {
    stopTicker()
    elapsed = r.durationMs
    elapsedMs.value = r.durationMs
    lastResult.value = r
  }
  const onError = (err: unknown) => {
    error.value = err
  }
  const onChunk = options?.onChunk

  recorder.on('statechange', onState).on('complete', onComplete).on('error', onError)
  if (onChunk) recorder.on('chunk', onChunk)
  // A shared recorder may already be mid-recording when this component mounts.
  state.value = recorder.state
  if (recorder.state === 'recording') startTicker()

  onUnmounted(() => {
    stopTicker()
    recorder.off('statechange', onState).off('complete', onComplete).off('error', onError)
    if (onChunk) recorder.off('chunk', onChunk)
    if (!options?.shared) recorder.destroy()
  })

  const permissionIssue = computed<PermissionIssue | null>(() =>
    error.value instanceof PermissionDeniedError
      ? {
          screen: error.value.denied.includes('screen'),
          microphone: error.value.denied.includes('microphone'),
          camera: error.value.denied.includes('camera'),
        }
      : null,
  )

  return {
    state,
    lastResult,
    elapsedMs,
    error,
    permissionIssue,
    start: (meeting, opts) => {
      error.value = null
      return recorder.start(meeting, opts)
    },
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    stop: () => recorder.stop(),
  }
}
