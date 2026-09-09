/**
 * 宿主 → 直接子代理的 prompt 投递通道（上游 `ctx.subagents.followup` 已删，见
 * commit ec493c2db8——投递统一为 steer/queue 两通道）。
 *
 * `createChildPromptDelivery(subagents)` 在引擎初始化期解析一次可用通道，返回
 * {@link ChildPromptDelivery} 形态的投递函数（全部调用点共用：sendStepMessage
 * @mention、ask-detect 回答注回、LifecycleManager/RecoveryManager 包装、finalize
 * secondary 门禁纠正重试）。通道解析顺序：
 *
 * 1. **上游 HEAD 运行时符号** `Symbol.for('dsh.subagent.deliverPrompt')`（harness
 *    参照源码 internal.ts L41 `deliverSubagentPrompt`，6 参分发：末位 delivery 模式，
 *    固定传 `'queue'`——独立 FIFO 轮次语义，等价旧 followup）。本地 dev 实例（--patch
 *    挂 harness workspace）命中此通道。
 * 2. **npm dsh-subagent@0.1.2-rc.1 符号** `Symbol.for('dsh.subagent.queuePrompt')`
 *    （internal.ts `queueSubagentPrompt`，5 参 Queue 分发；`queueHostSubagentPrompt`
 *    即对此符号的便捷封装）。与已安装包同版本的部署命中此通道。
 * 3. **降级 followup**：宿主运行时两者皆未实现（旧宿主 / 测试 mock `FakeSubagents`）
 *    时，结构探测 `subagents.followup`（本接缝已删除该接口方法，仅运行时鸭子探测，
 *    保住 mock 测试语义与旧宿主兼容）。
 *
 * 三者皆无（真实部署的正常组合不会发生）时在工厂期抛可读错误——fail loud，避免
 * 触发投递时才炸。
 *
 * **为何以 `Symbol.for` 直接探测而不用 `@deepseek-ai/dsh-subagent/internal` 导入**：
 * ① 符号经全局注册表进程稳定（上游设计意图：跨模块副本共享 internal 契约），字符
 * 串键即契约本体，便捷封装只是符号分发；② 静态 import 会把 dsh-subagent 的 d.ts
 * （含其 cordis `Context.subagents` 增广）拉进类型程序，与 sandore 接缝的同名增广
 * 合并后 `ctx.subagents` 被解析为 DSH 类型，破坏接缝调用点类型（实测，同
 * fork-session.ts 文件头「上游适配」注释）；③ npm 0.1.2-rc.1 与 harness HEAD 的
 * internal 契约符号名不同（`queuePrompt` vs `deliverPrompt`），逐符号探测天然兼容
 * 两种运行时。
 * @module @meiyukichan/dsh-sandore/workflow/src/subagent-delivery
 */
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm';

import type { Agent, ChildPromptDelivery, MessageId, SessionId, SubagentRuntime } from '../microflow/subagents';

/**
 * 上游 HEAD（harness 参照源码）internal 的进程稳定投递符号：
 * `runtime[deliverPrompt](parent, childId, content, source, signal, 'queue'|'steer')`。
 */
const DELIVER_PROMPT: unique symbol = Symbol.for('dsh.subagent.deliverPrompt');

/** npm dsh-subagent@0.1.2-rc.1 internal 的进程稳定 Queue 投递符号（5 参，无模式位）。 */
const QUEUE_PROMPT: unique symbol = Symbol.for('dsh.subagent.queuePrompt');

/** HEAD 符号分发面的最小结构（internal.ts `HostPromptDeliverer`）。 */
interface HeadPromptDeliverer {
  [DELIVER_PROMPT](
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
    delivery: 'queue' | 'steer',
  ): Promise<MessageId>;
}

/** 旧 `subagents.followup` 的结构面（降级通道鸭子探测用，接缝已删除该接口方法）。 */
interface FollowupFallback {
  followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: { readonly source: MessageSource; readonly signal: AbortSignal },
  ): Promise<MessageId>;
}

/** 解析后的 queue 投递通道（parent/childId/content/source/signal → inbox 消息 id）。 */
type QueueDeliverer = (
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
) => Promise<MessageId>;

/**
 * 解析可用的 queue 投递通道（HEAD 符号 → npm rc 符号）；两者皆无返回 undefined
 * （由工厂降级 followup）。
 */
function resolveQueueDeliverer(subagents: SubagentRuntime): QueueDeliverer | undefined {
  const runtime = subagents as unknown as Record<symbol, unknown>;
  // ① HEAD 运行时符号：末位 delivery 模式固定 'queue'（独立 FIFO 轮次语义）。
  const headDeliverer = runtime[DELIVER_PROMPT];
  if (typeof headDeliverer === 'function') {
    return (parent, childId, content, source, signal) =>
      (headDeliverer as HeadPromptDeliverer[typeof DELIVER_PROMPT])(parent, childId, content, source, signal, 'queue');
  }
  // ② npm 0.1.2-rc.1 符号：5 参 Queue 分发（queueHostSubagentPrompt 的内联等价——
  // 该封装仅做 runtime[queuePrompt](parent, childId, content, source, signal)）。
  const rcDeliverer = runtime[QUEUE_PROMPT];
  if (typeof rcDeliverer === 'function') {
    return (parent, childId, content, source, signal) =>
      (rcDeliverer as (
        parent: Agent,
        childId: SessionId,
        content: ContentBlock[],
        source: MessageSource,
        signal: AbortSignal,
      ) => Promise<MessageId>)(parent, childId, content, source, signal);
  }
  return undefined;
}

/**
 * 把 `ctx.subagents` 运行时封装为统一的子代理 prompt 投递函数（见模块头通道解析
 * 顺序）。工厂期 eager 解析通道：queue 符号缺失时降级 followup，两者皆无抛可读错误。
 * @param subagents - `ctx.subagents` 子代理运行时（服务实例进程内稳定，通道探测一次）。
 * @returns `(parent, childId, content, source, signal?) => Promise<MessageId>` 投递函数。
 * @throws 未找到任何可用投递通道（queue 符号未实现且 followup 缺失）时抛错。
 */
export function createChildPromptDelivery(subagents: SubagentRuntime): ChildPromptDelivery {
  const queue = resolveQueueDeliverer(subagents);
  if (queue !== undefined) {
    return (parent, childId, content, source, signal) =>
      queue(parent, childId, content, source, signal ?? new AbortController().signal);
  }
  // ③ 降级 followup（旧宿主 / 测试 mock）：'queue' 投递的独立 FIFO 轮次语义即旧
  // followup 语义，options 形状原样对齐旧接口（source + signal）。
  const followup = (subagents as unknown as FollowupFallback).followup;
  if (typeof followup === 'function') {
    return (parent, childId, content, source, signal) =>
      followup.call(subagents, parent, childId, content, { source, signal: signal ?? new AbortController().signal });
  }
  throw new Error(
    'createChildPromptDelivery: no child prompt delivery channel available '
    + '(subagent runtime implements neither the queue prompt symbol nor followup)',
  );
}
