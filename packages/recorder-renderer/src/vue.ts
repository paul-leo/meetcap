/**
 * Vue composable over the recorder.
 *
 *   import { useRecorder } from 'meetcap-recorder-renderer/vue'
 *   const { start, stop, state, lastResult } = useRecorder()
 *
 * `vue` is an optional peer dependency.
 */
import { onUnmounted, ref, type Ref } from 'vue'
import type { MeetingInfo, RecordingResult } from 'meetcap-core'
import {
  createRecorder,
  type CreateRecorderOptions,
  type RecorderState,
  type RecordingChunk,
  type StartOptions,
} from './renderer'

export interface UseRecorderOptions extends CreateRecorderOptions {
  /** Called per timeslice — use for incremental/segmented upload. */
  onChunk?: (chunk: RecordingChunk) => void
}

export function useRecorder(options?: UseRecorderOptions): {
  state: Ref<RecorderState>
  lastResult: Ref<RecordingResult | null>
  start: (meeting?: MeetingInfo | null, opts?: StartOptions) => Promise<void>
  stop: () => void
} {
  const state = ref<RecorderState>('idle')
  const lastResult = ref<RecordingResult | null>(null)
  const recorder = createRecorder(options)
  recorder.on('statechange', (s) => (state.value = s))
  recorder.on('complete', (r) => (lastResult.value = r))
  if (options?.onChunk) recorder.on('chunk', options.onChunk)
  onUnmounted(() => recorder.destroy())

  return {
    state,
    lastResult,
    start: (meeting, opts) => recorder.start(meeting, opts),
    stop: () => recorder.stop(),
  }
}
