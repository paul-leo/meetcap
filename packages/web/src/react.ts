/**
 * React hook over the web recorder. Duplicate-adapted from meetcap-renderer's
 * hook (the repo's parallel-copy pattern) — no detector hook here: meeting
 * detection needs a native process and doesn't exist on the pure web.
 *
 *   import { useRecorder } from 'meetcap-web/react'
 *   const { start, stop, state, elapsedMs, permissionIssue } = useRecorder({ shared: true })
 *
 * `react` is an optional peer dependency.
 */
import { useEffect, useRef, useState } from 'react'
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
   * component and the recording keeps running (route changes don't kill it).
   * The shared instance is created once, with the options of the first mount
   * that asked for it. Default false: per-component recorder, destroyed on
   * unmount.
   */
  shared?: boolean
}

/** Which media permissions blocked the last start — render permission-help UI from this. */
export interface PermissionIssue {
  screen: boolean
  microphone: boolean
  camera: boolean
}

export interface UseRecorder {
  state: RecorderState
  lastResult: WebRecordingResult | null
  /** Live recorded duration (ms), paused time excluded; corrected from `complete`. */
  elapsedMs: number
  /** Last recorder error (cleared when the next start() begins). */
  error: unknown
  /** Set when `error` is a PermissionDeniedError; null otherwise. */
  permissionIssue: PermissionIssue | null
  /** Rejects on failure — same contract as recorder.start(). Display capture needs a real click. */
  start: (meeting?: MeetingInfo | null, opts?: WebStartOptions) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
}

let sharedRecorder: WebRecorder | null = null
const getSharedRecorder = (options?: WebCreateRecorderOptions): WebRecorder =>
  (sharedRecorder ??= createRecorder(options))

export function useRecorder(options?: UseRecorderOptions): UseRecorder {
  const ref = useRef<WebRecorder | null>(null)
  const [state, setState] = useState<RecorderState>('idle')
  const [lastResult, setLastResult] = useState<WebRecordingResult | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    const recorder = options?.shared ? getSharedRecorder(options) : createRecorder(options)
    ref.current = recorder

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
        setElapsedMs(elapsed)
      }, 1000)
    }

    let prev: RecorderState = recorder.state
    const onState = (s: RecorderState) => {
      if (s === 'recording') {
        if (prev === 'idle') {
          elapsed = 0
          setElapsedMs(0)
        }
        startTicker()
      } else {
        if (prev === 'recording' && timer) elapsed += Date.now() - lastTickAt
        stopTicker()
        setElapsedMs(elapsed)
      }
      prev = s
      setState(s)
    }
    const onComplete = (r: WebRecordingResult) => {
      stopTicker()
      elapsed = r.durationMs
      setElapsedMs(r.durationMs)
      setLastResult(r)
    }
    const onError = (err: unknown) => setError(err)
    const onChunk = options?.onChunk

    recorder.on('statechange', onState).on('complete', onComplete).on('error', onError)
    if (onChunk) recorder.on('chunk', onChunk)
    // A shared recorder may already be mid-recording when this component mounts.
    setState(recorder.state)
    if (recorder.state === 'recording') startTicker()

    return () => {
      stopTicker()
      recorder.off('statechange', onState).off('complete', onComplete).off('error', onError)
      if (onChunk) recorder.off('chunk', onChunk)
      if (!options?.shared) recorder.destroy()
      ref.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const permissionIssue: PermissionIssue | null =
    error instanceof PermissionDeniedError
      ? {
          screen: error.denied.includes('screen'),
          microphone: error.denied.includes('microphone'),
          camera: error.denied.includes('camera'),
        }
      : null

  return {
    state,
    lastResult,
    elapsedMs,
    error,
    permissionIssue,
    start: (meeting, opts) => {
      setError(null)
      return ref.current?.start(meeting, opts) ?? Promise.resolve()
    },
    pause: () => ref.current?.pause(),
    resume: () => ref.current?.resume(),
    stop: () => ref.current?.stop(),
  }
}
