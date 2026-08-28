/**
 * turn-assistant：抄自 DSH `packages/client/ui-conversation/src/client/chat/turn-assistant.ts`。
 * 收集一个 Assistant 生命周期中的可见散文（turn-tail 复制按钮取文本用）。逐字保留。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/chat/turn-assistant
 */
import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Collect visible prose from one Assistant lifecycle.
 * @param blocks - Assistant content blocks.
 * @returns concatenated text blocks.
 */
export function assistantText(blocks: readonly AssistantBlock[]): string {
  return blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('')
}
