/**
 * React hook over the recorder.
 *
 *   import { useRecorder } from 'meetcap-recorder-renderer/react'
 *   const { start, stop, state, lastResult } = useRecorder()
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
} from './renderer'

export interface UseRecorderOptions extends CreateRecorderOptions {
  /** Called per timeslice — use for incremental/segmented upload. */
  onChunk?: (chunk: RecordingChunk) => void
}

export interface UseRecorder {
  state: RecorderState
  /** The last finished recording (already written to disk unless persistToDisk is off). */
  lastResult: RecordingResult | null
  start: (meeting?: MeetingInfo | null, opts?: StartOptions) => Promise<void>
  stop: () => void
}

export function useRecorder(options?: UseRecorderOptions): UseRecorder {
  const ref = useRef<Recorder | null>(null)
  const [state, setState] = useState<RecorderState>('idle')
  const [lastResult, setLastResult] = useState<RecordingResult | null>(null)

  useEffect(() => {
    const recorder = createRecorder(options)
    ref.current = recorder
    recorder.on('statechange', setState)
    recorder.on('complete', setLastResult)
    if (options?.onChunk) recorder.on('chunk', options.onChunk)
    return () => recorder.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    state,
    lastResult,
    start: (meeting, opts) => ref.current?.start(meeting, opts) ?? Promise.resolve(),
    stop: () => ref.current?.stop(),
  }
}
