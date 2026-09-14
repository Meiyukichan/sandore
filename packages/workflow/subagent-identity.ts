/**
 * 引擎自己 `agents.create` 建会话时的 **DSH 子代理身份补写**（防「会话记录损坏」）。
 *
 * ## 为什么需要（真机缺陷 · 2026-09）
 * DSH 的子代理列表（宿主主代理左上角下拉 / `list_agents` 工具）按**会话身份投影**渲染每个
 * 子代理：会话头带 `origin:'subagent'` 的会话会被枚举，但它的「子代理身份」来自
 * `subagent/descriptor` 这条会话事件（正常由 subagent provider 在创建期随 seed 写入：
 * `@deepseek-ai/dsh-subagent` 的 `seedDescriptorTurn`）。缺失该事件时 DSH 判定为
 * **损坏**（`packages/subagent/subagent/src/list-children.ts` 的 `corrupt` 分支：
 * 身份投影为 `undefined`，或其 seq < `inheritedEventCount`），UI 文案即「会话记录损坏」。
 *
 * sandore 的两条路径**绕过 provider** 直接 `agents.create`（因为需要自带 seed）：
 * - 收尾评估 fork / 路由判断 fork（`microflow/fork-session.ts` 的 `forkStepSubagent`）；
 * - 重试 fork/revert（`workflow/recovery-manager.ts` 的新段会话）。
 * 于是每个被评估的 step 都会在列表里留下一个「损坏」子代理——真机现象正是「每个 step
 * 下面多一个 uuid 形态的『会话记录损坏』」。
 *
 * 本模块在创建后补写同一条身份事件（`one-shot` 语义：这些子代理由引擎驱动单轮/少量轮次，
 * 不做 DSH 冷恢复），使列表显示为正常条目而不是损坏项。
 * @module @meiyukichan/dsh-sandore/workflow/src/subagent-identity
 */
import { SessionId } from '@deepseek-ai/dsh-session';

import type { Context } from '@deepseek-ai/cordis';

/** DSH `subagent/descriptor` 事件类型名（`@deepseek-ai/dsh-subagent` descriptor.ts:38 的映射键）。 */
export const SUBAGENT_DESCRIPTOR_EVENT = 'subagent/descriptor';

/**
 * 描述符格式版本，逐字对齐 DSH `SUBAGENT_DESCRIPTOR_VERSION`
 * （`@deepseek-ai/dsh-subagent` descriptor.ts:48；上游新增组合输入时会 +1）。
 */
export const SUBAGENT_DESCRIPTOR_VERSION = 3;

/**
 * sandore 内部创建的会话在描述符里声明的 `provider` 标记。
 *
 * 这些子代理不是由任何 DSH subagent provider 建立的（引擎直接 `agents.create` + 自己的
 * 投递通道驱动），故不用假的 provider 名；`one-shot` 模式下该字段不参与冷恢复。
 */
export const INTERNAL_SUBAGENT_PROVIDER = 'sandore-engine';

/** 需要读写的会话最小面（DSH `Session` 的结构子集）。 */
interface DescriptorSession {
  snapshotEvents(): readonly { readonly type: string; readonly seq: number }[];
  /**
   * **本会话自有**事件的起始 seq（= 继承前缀长度；DSH `Session.firstLiveSeq`
   * = `SessionLogOffset(seed.length)`，见 `core/session/src/index.ts:555`）。
   *
   * 判定「已存在的那条身份事件是不是**祖先**的」必须用到它：fork 的 seed 里会带着被
   * fork 会话**自己**的 `subagent/descriptor`（seq 0），只看「有没有该事件」会被它骗过去。
   */
  readonly firstLiveSeq: number;
  append(type: string, data: unknown): unknown;
}

/** 会话服务最小面。 */
interface SessionsSeam {
  get(id: SessionId): DescriptorSession | undefined;
}

/**
 * 为引擎自建的子代理会话补写 `subagent/descriptor` 身份事件（幂等）。
 *
 * ## 判定规则（对齐 DSH）
 * DSH 列表判定「身份是否有效」= 身份投影存在**且** `identity.seq >= inheritedEventCount`
 * （`list-children.ts:354-358`）；身份投影本身是 `subagent/descriptor` 事件的
 * **last-wins** fold（`subagent/projection.ts:158-177`：注释明确写了「fork seed 会重放
 * 祖先的 descriptor，子代理自己的必须覆盖它」）。
 *
 * ## 为什么不能只看「有没有该事件」（2026-09 真机缺陷根因）
 * 收尾评估 / 路由判断 / 重试都是**以 step 子代理会话为 seed** 建的 fork：而 step 子代理
 * 会话的 seed 里**带着它自己的** `subagent/descriptor`（seq 0）。于是 fork 会话里天然
 * 存在一条 descriptor —— 但它是**祖先的**、seq 落在继承前缀内 → DSH 判 `corrupt`
 * （UI「会话记录损坏」）。原先的幂等守卫「已有该类型事件就返回」被这条祖先事件骗过，
 * 补写**永不发生**，缺陷因此长期存在。
 *
 * 现在的判据：**最后一条** descriptor 的 seq 是否落在**自有区间**（`>= firstLiveSeq`）。
 * 落在继承前缀里 → 追加一条自有身份，让 last-wins fold 取到它。
 *
 * @param ctx - 引擎上下文（取 `sessions` 服务；缺失时静默返回 false）。
 * @param childId - 子代理会话 id（纯 UUID 或 DSH 分配的 id）。
 * @param label - 列表展示用的创建标签（可读文本，如 `finalize 分析 · <uuid>`）。
 * @returns 是否已存在/成功写入**自有**身份事件。
 */
export function ensureSubagentDescriptor(ctx: Context, childId: string, label: string | undefined): boolean {
  const sessions = ctx.get('sessions') as SessionsSeam | undefined;
  if (sessions === undefined) return false;
  const session = sessions.get(SessionId(childId));
  if (session === undefined) return false;
  // **自有区间**起点：`firstLiveSeq === 0`（无 seed）或 `=== seed.length`（fork）。
  const ownedFrom = Math.max(0, Number(session.firstLiveSeq ?? 0));
  // 最后一条 descriptor 的 seq（last-wins 语义下它就是当前身份来源）。
  const last = [...session.snapshotEvents()].reverse().find(event => event.type === SUBAGENT_DESCRIPTOR_EVENT);
  if (last !== undefined && last.seq >= ownedFrom) {
    // 已经存在**自有**身份（provider 建的子代理 / 本函数补过）→ 幂等返回。
    return true;
  }
  session.append(SUBAGENT_DESCRIPTOR_EVENT, {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: INTERNAL_SUBAGENT_PROVIDER,
    ...(label === undefined || label === '' ? {} : { label }),
  });
  return true;
}
