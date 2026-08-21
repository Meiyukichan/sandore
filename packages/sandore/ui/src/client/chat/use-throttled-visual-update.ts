/**
 * use-throttled-visual-update：抄自 DSH `packages/client/ui-conversation/src/client/chat/use-throttled-visual-update.ts`。
 * 非必需视觉对齐的帧节流调度（ReasoningRow 摘要滚动用）。逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/use-throttled-visual-update
 */
import { useCallback, useLayoutEffect, useRef } from 'react'

const DEFAULT_INTERVAL_FRAMES = 3

/**
 * Return a stable scheduler that coalesces visual updates over a frame interval.
 * @param update - DOM alignment to run after the throttle interval.
 * @param intervalFrames - frames to wait before applying the latest alignment.
 * @returns a stable function that schedules the latest update.
 */
export function useThrottledVisualUpdate(
  update: () => void,
  intervalFrames = DEFAULT_INTERVAL_FRAMES,
): () => void {
  const updateRef = useRef(update)
  updateRef.current = update
  const pendingFrameRef = useRef<number | null>(null)

  useLayoutEffect(() => () => {
    if (pendingFrameRef.current === null) return
    cancelAnimationFrame(pendingFrameRef.current)
    pendingFrameRef.current = null
  }, [])

  return useCallback(() => {
    if (pendingFrameRef.current !== null) return
    let remainingFrames = intervalFrames
    const advance = (): void => {
      remainingFrames -= 1
      if (remainingFrames > 0) {
        pendingFrameRef.current = requestAnimationFrame(advance)
        return
      }
      pendingFrameRef.current = null
      updateRef.current()
    }
    pendingFrameRef.current = requestAnimationFrame(advance)
  }, [intervalFrames])
}
