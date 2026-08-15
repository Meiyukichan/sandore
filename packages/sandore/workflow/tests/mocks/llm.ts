/**
 * 内存 mock LLM（测试专用，非发布面）。
 *
 * 提供 `listProviders`/`listModels`/`stream` 等价语义：`stream` 记录每次调用
 * 并委托 `streamHandler`，测试按需注入固定 chunk 流。以
 * `ctx.provide('llm', …)` 注入，避免在单元测试中拉起真实模型后端。
 * @module @deepseek-ai/dsh-sandore-workflow/tests/mocks/llm
 */
import type {
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';

/** 生成一段单 text block 的固定 chunk 流（含 `block-end` 与 `finish`）。 */
export function textChunks(text: string, reason: FinishReason = { kind: 'stop' }): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason };
  })();
}

/** 内存 mock LLM：记录 stream 调用并可注入流实现。 */
export class FakeLlm {
  readonly providers: LlmProviderInfo[] = [];
  readonly models = new Map<string, LlmModelInfo[]>();
  readonly calls: GenerateOptions[] = [];
  streamHandler: (options: GenerateOptions) => AsyncIterable<StreamChunk> = () => textChunks('');

  listProviders(): LlmProviderInfo[] {
    return [...this.providers];
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    return [...(this.models.get(provider) ?? [])];
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options);
    return this.streamHandler(options);
  }
}
