/**
 * fork 会话历史注入工具（fork-based 判断 + 上下文压缩共用）。
 *
 * 从当前 step 的子代理会话 fork 出一个分支，取 fork 会话的 derived LLM messages
 * （基于 surface 折叠的全量消息历史），供判断/压缩 LLM 请求作为 `messages` 前缀注入。
 * fork 失败（source 非 live / 合成 session / OPEN_TURN 等）返回 undefined（调用方降级）。
 *
 * **设计（fork-based 判断）**：判断不再手动传 I/O 文本——fork 会话携带全量历史，
 * AI 在 fork 会话上跑判断即可见全部 I/O（缺陷 2/4 的会话机制从「一次性临时会话 +
 * 手动传 I/O」改为「fork + 全量历史」）。DSH 契约：`GenerateOptions.sessionId` 只作
 * 路由戳记、不自动加载历史；历史加载是调用方职责——本工具把 `child.deriveMessages()`
 * 拼进 `llm.stream({ messages: [...history, judgePrompt] })`，实现「fork 全量历史注入」
 * （落地缺陷 24 的「完整注入 fork 会话历史」卡点）。
 * @module @deepseek-ai/dsh-sandore-microflow/src/fork-session
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Message } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

/** fork 会话历史注入结果（derived messages + fork 会话 id）。 */
export interface ForkStepHistory {
  /**
   * fork 会话的 derived LLM messages（全量历史，surface 折叠后）。深冻结的共享消息对象，
   * 拼进 `llm.stream` 的 `messages` 数组作为历史前缀只读不改。
   */
  readonly messages: readonly Message[];
  /** fork 出的 child session id（作 LLM 请求 `sessionId` 戳记 + `sessionHandle`）。 */
  readonly forkSessionId: string;
}

/**
 * fork step 会话并取其 derived LLM messages 全量历史（fork-based 判断的会话机制核心）。
 *
 * `stepSessionId` 必须是 live session（真实子代理 `sessionMeta.childId`，`synthetic === false`）；
 * 合成 session（prompt/shell）或非 live id 令 `sessions.fork` 抛 `SESSION_NOT_FOUND`，此处
 * 捕获并返回 undefined（调用方降级为一次性临时会话，不传历史）。`sessions` 服务未注册时
 * 同样返回 undefined。省略或空串直接返回 undefined。
 *
 * 返回的 `messages` 是 fork 会话截至 fork 点的全量 derived 历史——判断 AI 据此可见当前
 * step 的完整输入输出与工具调用轨迹，无需调用方手动拼装 I/O 文本。
 */
export function forkStepSessionMessages(
  ctx: Context,
  stepSessionId: string | undefined,
): ForkStepHistory | undefined {
  if (stepSessionId === undefined || stepSessionId === '') {
    return undefined;
  }
  const sessions = ctx.get('sessions');
  if (sessions === undefined) {
    return undefined;
  }
  try {
    const child = sessions.fork(SessionId(stepSessionId));
    return { messages: child.deriveMessages(), forkSessionId: child.id };
  } catch {
    return undefined;
  }
}
