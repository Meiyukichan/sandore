/**
 * searchable-hidden（B3 step-view 版）：保持子树挂载的前提下应用可搜索隐藏态。
 * 抄自 DSH 0.1.2-rc.1 `ui-chat/src/client/chat/searchable-hidden.ts`（只读参考
 * deepseek-harness），逐字保留。
 *
 * B3 用途（与 rc.1 ChatNodeSeat / AssistantMarkdown.ProcessReasoning 同款）：
 * - turn-process 折叠的成员行壳：`hidden="until-found"` 挂到行壳 → 折叠行不占
 *   布局但浏览器 find 命中时经 `beforematch` 展开（reveal = 打开进程披露）；
 * - assistant 答复行内联推理（data-turn-process-inline）：同样隐藏/揭示语义。
 *
 * jsdom（单测环境）无 until-found 布局语义，但 setAttribute/事件监听均可用，
 * 测试只断言 data-* 与回调面，不断言布局。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/step-view/searchable-hidden
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Apply searchable hidden state without unmounting a stable subtree.
 * @param hidden - whether the subtree is currently hidden.
 * @param reveal - callback for browser find's `beforematch` reveal.
 * @returns ref for the stable subtree root.
 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden && element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    if (hidden) element.setAttribute('hidden', 'until-found')
    else element.removeAttribute('hidden')
  }, [hidden, reveal])
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    element.addEventListener('beforematch', reveal)
    return () => { element.removeEventListener('beforematch', reveal) }
  }, [reveal])
  return ref
}
