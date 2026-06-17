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
import { createRecorder, type CreateRecorderOptions, type RecorderState } from './renderer'

export function useRecorder(options?: CreateRecorderOptions): {
  state: Ref<RecorderState>
  lastResult: Ref<RecordingResult | null>
  start: (meeting?: MeetingInfo | null) => Promise<void>
  stop: () => void
} {
  const state = ref<RecorderState>('idle')
  const lastResult = ref<RecordingResult | null>(null)
  const recorder = createRecorder(options)
  recorder.on('statechange', (s) => (state.value = s))
  recorder.on('complete', (r) => (lastResult.value = r))
  onUnmounted(() => recorder.destroy())

  return {
    state,
    lastResult,
    start: (meeting) => recorder.start(meeting),
    stop: () => recorder.stop(),
  }
}
