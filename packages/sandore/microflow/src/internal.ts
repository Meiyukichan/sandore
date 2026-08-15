/**
 * microflow 包内部工具函数（不进入公开 API）。
 *
 * `describeError`/`textSummary` 仅供本包内部模块（`stage-executor.ts`）复用，
 * 不从 `index.ts` re-export，避免泄漏到 microflow 公开 API。
 * @module @deepseek-ai/dsh-sandore-microflow/src/internal
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

/** 渲染任意抛出值为可读消息（诊断用，永不按消息路由）。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 提取 ContentBlock[] 的纯文本摘要（仅 text 块，按序拼接）。 */
export function textSummary(output: readonly ContentBlock[] | undefined): string {
  if (output === undefined) {
    return '';
  }
  const texts: string[] = [];
  for (const block of output) {
    if (block.type === 'text') {
      texts.push(block.text);
    }
  }
  return texts.join('\n');
}
