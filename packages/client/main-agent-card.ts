/**
 * main-agent-card.ts（呈现层统一 · 真机验收修正）：主代理卡片的**出现条件**探测。
 *
 * 用户决策 3 修正后的规格（真机验收提出）：
 * > 「你把主代理的消息怎么插入到这个 step 下面了？我要求的是作为一个新的 step 插入啊！
 * >  而且是主代理有消息才插入」
 *
 * 于是「什么时候出现」由本模块负责，两条硬条件（缺一不可）：
 * 1. **用户已从运行页主代理输入壳发出过消息**（`requested`，模块级 store，
 *    见 main-agent-chat.ts 的 `requestMainAgentChat`）；
 * 2. **主代理之后真的产出了助手输出**——发送那一刻记下宿主会话的助手输出条数做**基线**，
 *    只认基线之后新增的那条（`mainAgentChatShown`）。
 *
 * 为什么必须带基线：宿主会话在实例运行期间本来就有一条助手输出（主代理回复「已启动工作流」），
 * 不带基线的话卡片会在用户什么都没发的时候就冒出来；而「用户发了、主代理还没回」的那一瞬间
 * 也不该出现空壳/占位/标题（用户明确要求「连空壳都不要」）。
 *
 * 数据面复用 step 面板那一套（`createStepChatViewSource` → rc.1 ChatSnapshot 的
 * `order` + `nodes.source`），不新造通道：`[data-main-agent-chat]` 内容由 StepChatPanel
 * 的 `variant='main'` 渲染，本模块只回答「出现吗」。
 *
 * 与 React 无关的判定全部落在 main-agent-chat.ts 的纯函数里（`mainAgentOutputCount` /
 * `mainAgentCardShown`），本文件只做订阅与基线状态机，便于单测（jsdom）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-card
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

import { mainAgentCardShown, mainAgentOutputCount } from './main-agent-chat.ts'
import { stepChatSessionsOf } from './StepChatPanel.tsx'
import { createStepChatViewSource, type StepChatBindingLike } from './step-chat-source.ts'

/** sessions 服务未安装时的空订阅（useSyncExternalStore subscribe 侧）。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined

/** {@link useMainAgentCard} 的返回值。 */
export interface MainAgentCardGate {
  /** 是否渲染主代理卡片（= 主代理会话里有助手消息）。 */
  readonly shown: boolean
  /**
   * 主代理会话里的助手消息条数（卡片的折叠状态机用它判断「有新消息」：
   * 条数增加 ⇒ 自动展开一次，见 UnifiedTimeline 的 MainAgentChatBlock）。
   */
  readonly outputCount: number
}

/**
 * 主代理卡片的出现条件（需求 3 修正版；见文件头）。
 *
 * 订阅链：`sessions.list`（宿主会话可能晚于运行视图出现 → binding 出现即重解析）
 * → `sessions.binding(hostSessionId)` → `uiConversation.binding(binding).target('chat')`
 * （`createStepChatViewSource`）→ `read().order` + `node(key).kind`。
 * 任何一环缺失都按「没有助手输出」处理（不渲染卡片，绝不抛）。
 *
 * **为什么这里要开一次会话窗**：DSH 的 ChatSnapshot 由 app 级会话视图在**开窗后**装配
 * （拉历史 + 消费 mux 帧，见 StepChatPanel 的 `openSessionWindow`）——不开窗则 `read().ok`
 * 恒假、条数恒 0，卡片永远不会出现。故探测期走与面板**同一条**开窗路径（幂等、失败静默）；
 * 它不碰输入内核、不接管任何 DOM 根（这正是「独立输入框」决策的一部分）。
 * @param hostSessionId - 宿主（主代理）会话 id。
 * @returns `{ shown }`：主代理会话里有助手消息 → true。
 */
export function useMainAgentCard(hostSessionId: string): MainAgentCardGate {
  const sessions = stepChatSessionsOf()
  // 会话列表订阅：binding 可用性由列表决定（会话晚出现 → 列表变化 → 重解析 binding）。
  useSyncExternalStore(
    sessions === undefined ? NOOP_SUBSCRIBE : sessions.list.subscribe,
    () => (sessions === undefined ? undefined : sessions.list.getSnapshot()),
  )
  const binding = sessions?.binding(hostSessionId as SessionId)
  // 开窗（幂等；失败静默——快照会以 openState='error' 反映，由卡片内的面板承担占位）。
  useEffect(() => {
    if (binding === undefined) return
    const opener = (binding.session as unknown as { open?: () => Promise<void> }).open
    if (typeof opener !== 'function') return
    void opener.call(binding.session).catch(() => {
      // 开窗失败不在此处理：read().ok 保持假 → 卡片不出现（与「主代理没回话」同一表现）。
    })
  }, [binding])
  const feed = useMemo(
    () => createStepChatViewSource(binding as unknown as StepChatBindingLike | undefined),
    [binding],
  )
  // 整列订阅（与面板同源：target 每次发布都通知，含按 rAF 合并的流式帧）。
  const read = useSyncExternalStore(
    feed === undefined ? NOOP_SUBSCRIBE : (onStoreChange) => feed!.subscribe(onStoreChange),
    () => feed?.read(),
  )
  // 助手输出条数：order 只是 key 列表，逐 key 读 kind（节点缓存由 feed 内部保持，身份稳定）。
  const count = useMemo(
    () => (feed === undefined
      ? 0
      : mainAgentOutputCount(read?.order ?? [], key => feed.node(key)?.kind)),
    [feed, read],
  )
  // 出现条件 = 主代理会话里有助手消息（`> 0`）：视图未就绪 → 条数 0 → 不渲染（连空壳都没有）。
  return { shown: mainAgentCardShown(count), outputCount: count }
}
