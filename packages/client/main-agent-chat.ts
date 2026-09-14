/**
 * main-agent-chat.ts（呈现层统一 · 本批）：运行页「主代理席位」的纯逻辑。
 *
 * ## 背景（用户决策 1/3/4 + 两轮真机修正）
 * 运行视图底部那个输入框是**独立实现**的主代理输入框（见 main-agent-input.tsx），消息投递到
 * **主代理会话（= 实例宿主会话）**；主代理一旦产出助手消息，运行页就把**主代理的会话视图**
 * 作为**一张独立的卡片**插入步骤列表——位置紧跟**当前正在执行的 step**（真机验收后的修正：
 * 早期实现把它嵌套进某张 step 卡片内部，落到了已完成的 step 上；现在卡片与 step 卡片
 * **同级**，见 UnifiedTimeline.tsx 的 `MainAgentChatBlock` 与 {@link mainAgentInsertIndexIn}）。
 *
 * 本模块只承载与 React 无关的事，便于单测：
 * 1. **宿主会话 id 解析**（{@link mainAgentSessionIdOf}）：引擎侧的恒等式是
 *    `hostSessionId ≡ instanceId`，但历史实例的段仍可能没有 `sessionMeta.hostSessionId`；
 *    故先取段上的 `parentSessionId`，缺失时回退 `instanceId`。
 * 2. **出现条件**（{@link mainAgentOutputCount} / {@link mainAgentCardShown}）：主代理会话里
 *    **有助手消息**就出现（真机反馈修正：不再要求「用户先在运行页发过消息」——启动注入让主代理
 *    自己汇报「工作流已启动」时就该出现）；没有任何助手消息则**连空壳都不渲染**。
 *    卡片位置固定为步骤列表最后一张、默认折叠（都在 UnifiedTimeline 里实现）。
 *
 * 注：原先这里还有「中止主代理当前 turn」的动作探测（`mainAgentTurnCancelOf`），随输入框区
 * 那个停止按钮一起删除（真机反馈第三轮要求去掉输入框区的按钮，见文件尾注释）。
 *
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-chat
 */

/** 段上的最小读取面（RunView 的 activeSegments / UnifiedTimeline 的 step 项都满足）。 */
export interface MainAgentStepLike {
  /** 段对应的 step 定义 id（`ExecutedStep.stepId` 在归一前是可选的，故这里也放宽）。 */
  readonly stepId?: string | undefined
  readonly status: string
  /** 段持久化的 `sessionMeta.hostSessionId`（历史实例可能缺）。 */
  readonly parentSessionId?: string | undefined
}

/**
 * 解析实例的**宿主（主代理）会话 id**。
 *
 * 优先取任意一段的 `parentSessionId`（引擎在真实子代理段写 `sessionMeta.hostSessionId`，
 * 恒等于宿主会话 id）；全部缺失（历史实例 / 尚无真实子代理段）时回退 `instanceId`
 * ——引擎侧的恒等式 `hostSessionId ≡ instanceId` 使这条回退与真实值等价
 * （见 packages/workflow/workflow-engine.ts 的 `startInstance`）。
 * @param steps - 本实例的 step 段（RunView 的 activeSegments）。
 * @param instanceId - 实例 id（兜底值）。
 * @returns 宿主会话 id（永不为空串：instanceId 非空即返回它）。
 */
export function mainAgentSessionIdOf(
  steps: readonly MainAgentStepLike[],
  instanceId: string,
): string {
  for (const step of steps) {
    const parent = step.parentSessionId
    if (parent !== undefined && parent !== '') return parent
  }
  return instanceId
}

/**
 * 主代理会话的**助手输出条数**（`order` 里 kind === 'assistant-step' 的节点数）。
 *
 * 用途：出现条件判定的输入（{@link mainAgentCardShown}）——`> 0` 即「主代理有消息」。
 * @param order - 会话视图的节点 key 顺序（`feed.read().order`）。
 * @param kindOf - key → 节点 kind（`feed.node(key)?.kind`）。
 * @returns 助手步骤节点条数。
 */
export function mainAgentOutputCount(
  order: readonly string[],
  kindOf: (key: string) => string | undefined,
): number {
  let count = 0
  for (const key of order) {
    if (kindOf(key) === 'assistant-step') count += 1
  }
  return count
}

/**
 * 主代理卡片是否渲染：**主代理会话里有助手消息就出现**（真机反馈修正后的规格）。
 *
 * 用户规格原话：「主代理的消息只有在主代理有消息更新的时候才插入到 discuss，作为一个 step
 * 插入」——「有消息更新」= 主代理会话里出现了助手消息（启动注入后主代理自己汇报
 * 「工作流已启动…」也算）。故这里**不再要求**「用户先在运行页发过消息」：那条硬条件会让
 * 启动汇报被吞掉（真机上表现为「卡片怎么都不出来」）。
 *
 * 「没有新消息就不渲染、不留空壳」保留为：助手输出条数为 0 ⇒ false（连壳/标题都不产出）。
 * @param count - 当前助手输出条数（{@link mainAgentOutputCount}）。
 * @returns 是否渲染卡片。
 */
export function mainAgentCardShown(count: number): boolean {
  return count > 0
}

// 注：原先这里还有一个「中止主代理当前 turn」的动作探测（`mainAgentTurnCancelOf`，探测
// `binding.ctx` 上的 `conversation.cancel`），供运行页输入框旁那个「停止生成」按钮做
// 双语义（暂停实例 + 中止主代理 turn）用。真机反馈第三轮要求**去掉输入框区的按钮**后，
// 该按钮与这条探测链一并删除（不留半死代码）：暂停改由 **DSH 中心列输入框自带的
// 「停止生成」** 触发——DSH 取消宿主主代理 turn，引擎据此把实例判为 `paused`
// （`workflow-engine.ts` 的 host-turn-abort 分支，架构决策 6）。
