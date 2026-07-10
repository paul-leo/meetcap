/**
 * Vue composables over the recorder and detector.
 *
 *   import { useRecorder, useMeetingDetector } from 'meetcap-renderer/vue'
 *   const { meeting, isInMeeting } = useMeetingDetector({ onDetected: showBanner })
 *   const { start, stop, state, elapsedMs, permissionIssue } = useRecorder({ shared: true })
 *
 * `vue` is an optional peer dependency.
 */
import { computed, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import type { MeetingInfo, RecordingResult } from 'meetcap-core'
import {
  createRecorder,
  type CreateRecorderOptions,
  type Recorder,
  type RecorderState,
  type RecordingChunk,
  type StartOptions,
} from './recorder'
import { createDetectorClient, type DetectorClient } from './detector'
import { PermissionDeniedError } from 'meetcap-capture'

export interface UseRecorderOptions extends CreateRecorderOptions {
  /** Called per timeslice — use for incremental/segmented upload. */
  onChunk?: (chunk: RecordingChunk) => void
  /**
   * Share one app-global recorder across all components. A recording is
   * app-global state — with `shared: true`, unmounting only unsubscribes this
   * component and the recording keeps running (route changes don't kill it).
   * The shared instance is created once, with the options of the first mount
   * that asked for it. Default false: per-component recorder, destroyed on
   * unmount (previous behavior).
   */
  shared?: boolean
}

/** Which media permissions blocked the last start — render permission-help UI from this. */
export interface PermissionIssue {
  screen: boolean
  microphone: boolean
  camera: boolean
}

// One app-global recorder for `shared: true` mounts, created with the options
// of the first such mount. Never destroyed — a recording must survive any
// individual component.
let sharedRecorder: Recorder | null = null
const getSharedRecorder = (options?: CreateRecorderOptions): Recorder =>
  (sharedRecorder ??= createRecorder(options))

export function useRecorder(options?: UseRecorderOptions): {
  state: Ref<RecorderState>
  lastResult: Ref<RecordingResult | null>
  /** Live recorded duration (ms), paused time excluded; corrected from `complete`. */
  elapsedMs: Ref<number>
  /** Last recorder error (cleared when the next start() begins). */
  error: Ref<unknown>
  /** Set when `error` is a PermissionDeniedError; null otherwise. */
  permissionIssue: ComputedRef<PermissionIssue | null>
  /** Rejects on failure (e.g. PermissionDeniedError) — same contract as recorder.start(). */
  start: (meeting?: MeetingInfo | null, opts?: StartOptions) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
} {
  const state = ref<RecorderState>('idle')
  const lastResult = ref<RecordingResult | null>(null)
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
  const onComplete = (r: RecordingResult) => {
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

export interface UseMeetingDetectorOptions {
  /** A meeting occurrence began (also fired once for a meeting already in progress at startup). */
  onDetected?: (meeting: MeetingInfo) => void
  /** The meeting ended — same `meetingId` as its onDetected. */
  onEnded?: (meeting: MeetingInfo) => void
}

// One app-global detector client shared by every useMeetingDetector mount,
// kept for the app's lifetime — detection state must not reset when
// components unmount. syncInitial catches a meeting already in progress.
let sharedDetector: DetectorClient | null = null
const getSharedDetector = (): DetectorClient =>
  (sharedDetector ??= createDetectorClient({ syncInitial: true }))

export function useMeetingDetector(options: UseMeetingDetectorOptions = {}): {
  /** The tracked meeting occurrence (with its `meetingId`), or null. */
  meeting: Ref<MeetingInfo | null>
  isInMeeting: ComputedRef<boolean>
} {
  const client = getSharedDetector()
  // Level sync for late mounts; callbacks stay edge-only (the initial probe
  // fires meeting-detected once, through the client's handler set).
  const meeting = ref<MeetingInfo | null>(client.current)

  const onDetected = (m: MeetingInfo) => {
    meeting.value = m
    options.onDetected?.(m)
  }
  const onEnded = (m: MeetingInfo) => {
    meeting.value = null
    options.onEnded?.(m)
  }
  client.on('meeting-detected', onDetected).on('meeting-ended', onEnded)

  onUnmounted(() => {
    client.off('meeting-detected', onDetected).off('meeting-ended', onEnded)
  })

  return {
    meeting,
    isInMeeting: computed(() => meeting.value !== null),
  }
}
