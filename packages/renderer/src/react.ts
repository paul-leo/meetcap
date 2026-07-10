/**
 * React hooks over the recorder and detector.
 *
 *   import { useRecorder, useMeetingDetector } from 'meetcap-renderer/react'
 *   const { meeting, isInMeeting } = useMeetingDetector({ onDetected: showBanner })
 *   const { start, stop, state, elapsedMs, permissionIssue } = useRecorder({ shared: true })
 *
 * `react` is an optional peer dependency.
 */
import { useEffect, useRef, useState } from 'react'
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

export interface UseRecorder {
  state: RecorderState
  /** The last finished recording (already written to disk unless persistToDisk is off). */
  lastResult: RecordingResult | null
  /** Live recorded duration (ms), paused time excluded; corrected from `complete`. */
  elapsedMs: number
  /** Last recorder error (cleared when the next start() begins). */
  error: unknown
  /** Set when `error` is a PermissionDeniedError; null otherwise. */
  permissionIssue: PermissionIssue | null
  /** Rejects on failure (e.g. PermissionDeniedError) — same contract as recorder.start(). */
  start: (meeting?: MeetingInfo | null, opts?: StartOptions) => Promise<void>
  pause: () => void
  resume: () => void
  stop: () => void
}

// One app-global recorder for `shared: true` mounts, created with the options
// of the first such mount. Never destroyed — a recording must survive any
// individual component.
let sharedRecorder: Recorder | null = null
const getSharedRecorder = (options?: CreateRecorderOptions): Recorder =>
  (sharedRecorder ??= createRecorder(options))

export function useRecorder(options?: UseRecorderOptions): UseRecorder {
  const ref = useRef<Recorder | null>(null)
  const [state, setState] = useState<RecorderState>('idle')
  const [lastResult, setLastResult] = useState<RecordingResult | null>(null)
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
    const onComplete = (r: RecordingResult) => {
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

export interface UseMeetingDetectorOptions {
  /** A meeting occurrence began (also fired once for a meeting already in progress at startup). */
  onDetected?: (meeting: MeetingInfo) => void
  /** The meeting ended — same `meetingId` as its onDetected. */
  onEnded?: (meeting: MeetingInfo) => void
}

export interface UseMeetingDetector {
  /** The tracked meeting occurrence (with its `meetingId`), or null. */
  meeting: MeetingInfo | null
  isInMeeting: boolean
}

// One app-global detector client shared by every useMeetingDetector mount,
// kept for the app's lifetime — detection state must not reset when
// components unmount. syncInitial catches a meeting already in progress.
let sharedDetector: DetectorClient | null = null
const getSharedDetector = (): DetectorClient =>
  (sharedDetector ??= createDetectorClient({ syncInitial: true }))

export function useMeetingDetector(options: UseMeetingDetectorOptions = {}): UseMeetingDetector {
  const [meeting, setMeeting] = useState<MeetingInfo | null>(null)
  // Latest-ref pattern: callbacks may change every render without resubscribing.
  const callbacks = useRef(options)
  callbacks.current = options

  useEffect(() => {
    const client = getSharedDetector()
    // Level sync for late mounts; callbacks stay edge-only (the initial probe
    // fires meeting-detected once, through the client's handler set).
    setMeeting(client.current)
    const onDetected = (m: MeetingInfo) => {
      setMeeting(m)
      callbacks.current.onDetected?.(m)
    }
    const onEnded = (m: MeetingInfo) => {
      setMeeting(null)
      callbacks.current.onEnded?.(m)
    }
    client.on('meeting-detected', onDetected).on('meeting-ended', onEnded)
    return () => {
      client.off('meeting-detected', onDetected).off('meeting-ended', onEnded)
    }
  }, [])

  return { meeting, isInMeeting: meeting !== null }
}
