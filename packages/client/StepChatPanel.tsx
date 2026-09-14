/**
 * StepChatPanel：内嵌子代理消息面板——「看起来就是 DSH 子代理会话页的对话区」。
 *
 * 数据面与 DSH ChatView 同源：`sessions.binding(childId).session` 是
 * `ISession & ObservableSnapshot<ConversationSnapshot>`（`@deepseek-ai/dsh-client-runtime/client`
 * 公开面），经 `useSyncExternalStore` 订阅；挂载时 cast 调用 `Session.open()` 开窗
 * （拉历史 + 消费 mux 帧，幂等 + 失败静默）。
 *
 * 渲染面抄自 DSH 0.1.2-rc.1 ChatView（`ui-chat/src/client/chat/`，逐 kind 视觉在
 * `step-view/` 目录）：
 * - user/steering 消息右侧气泡（用户图标 + 文本/图片 + 时钟/复制动作）
 * - agent 消息 markdown 正文（AssistantMarkdown + ReasoningRow Think 行 + 图片），
 *   流式 partial 经 `streaming` 标记增量渲染
 * - 工具调用（ToolCallView + ToolRow：16px leading + 标题 + 摘要 + IN/OUT 展开 +
 *   terminal/read/diff/search/web 卡片材质 + 文件路径打开链接，运行中 sweep、失败红字）
 * - 命令行（CommandCard）；上下文注入（ContextInjectionRow + ContextBody 各 form）
 * - compaction / model-retry / turn-error / turn-max-tokens / unknown JSON 行
 * - turn-process 披露头（已完结 turn 的进程折叠条：工具/消息/subagent 计数 +
 *   chevron，展开恢复成员行）+ 进程成员行折叠（含答复行内联推理 data-turn-process-inline）
 * - turn-tail（已完结 turn 的尾部动作行：时钟 + ran-for/用量静态读数 + 复制 +
 *   branch(fork)；usageAction 明细浮层裁剪，见 step-view/TurnTailNodeView.tsx）
 * - 运行中 TurnStatus（Deep diving… 呼吸灯 + 计时）
 * - 消息行平铺在面板内滚动容器（`step-chat-panel.module.css` 的 .stepChatScroll），
 *   随 UnifiedTimeline 滚动（无 toBottom 跟随按钮）
 *
 * 批 A（完整消息 + 折叠语义 + 滚动契约 + 原生出口）：
 * - **不裁剪任何消息**：面板渲染会话加载窗的全部 order（真正的截断是 DSH 会话
 *   加载窗本身——一页 50 条 + `session.getSnapshot().hasMore`），窗首按 rc.1
 *   ChatView 同款渲染「加载更早」按钮（`.stepChatOlder`，`hasMore` 为真才出现，
 *   `loadingOlder` 中 disabled），点击走 `session.loadOlder()`（见
 *   step-chat-paging.ts 的分页能力面）并做 **prepend 保位**（加载前记
 *   scrollHeight，落地后 `scrollTop += Δ`，DSH ChatView 同款语义）；
 *   `loadThrough(seq)` 已留能力出口（两代运行时皆探测，rc.6 缺失即 no-op），
 *   本批不接 UI——轮次轴 unloaded 锚点跳转后续接。
 * - **折叠守卫对齐官方**：真实 `hasMore` 逐行传入 `stepChatProcessSeatOf` 的
 *   `historyIncomplete`（rc.1 ChatNodeSeat.processWindowReady 要求
 *   `!historyIncomplete`——窗口不全时整轮不折叠，避免误隐窗口外仍在的成员行；
 *   官方在 ChatView 处即 `historyIncomplete={hasMore}`）。
 * - **滚动契约**：面板自己的滚动容器挂 `data-conversation-scroll`（**只有卡片
 *   自己的滚动器**；外层 RunView/UnifiedTimeline 的滚动元素绝不可加此属性——
 *   它会抢走 DSH 的 `closest('[data-conversation-scroll]')` 归属，见
 *   RunView.module.css 注释），并在其上发布 4 个变量（--dsh-composer-height /
 *   --dsh-conversation-viewport-height / --dsh-chat-content-width /
 *   --dsh-composer-side-clearance，见下方 scrollVars effect 注释）。
 * - **官方原生出口**：error 态「用 DSH 原生对话打开」按钮 → `sessions.openSubagent
 *   ({ parentSessionId, childSessionId, mode:'continuable' })`（rc.6 公开面即此行
 *   形状；parent 缺失时回退 subagentAddress/open，见 openInHost）。
 *
 * 批 A2（自动补齐完整历史——让「完整消息」成为默认体验，同时恢复官方折叠）：
 * - 面板**可见**且 `hasMore` 时自动连续 `loadOlder()` 直到窗口补齐：页数上限
 *   `STEP_CHAT_AUTOFILL_MAX_PAGES`（10 页 = 500 条）、失败按 1s→3s 有界退避后
 *   停止、卸载/换会话按 generation 守卫作废在飞结果；驱动与 React/DOM 无关
 *   （step-chat-autofill.ts，可单测）。补齐后 `hasMore === false` → 进程折叠语义
 *   恢复官方行为（historyIncomplete 依赖它），手动「加载更早」按钮随之消失。
 * - 自动补齐与手动点击**共用同一条保位路径**（loadOlderPreserving：量
 *   scrollHeight → loadOlder → rAF 按 ΔscrollHeight 补偿 scrollTop）：自动补齐
 *   不会把正在读的用户推走；已在顶部（scrollTop≈0）时补偿后仍在顶部。
 * - 进行中在列首显示轻量提示行「正在加载更早的消息…」
 *   （`run.step.chat.paging.autofill`，zh/en 对称），上限/失败/门关闭后提示消失、
 *   手动按钮交回用户。
 * - 可见性用 IntersectionObserver 观测本卡片自己的滚动视口；宿主没有稳定可见性
 *   信号（无 IntersectionObserver 的非浏览器宿主）时退化为「挂载即视为可见」。
 *
 * 时间线组件树不携带 cordis ctx，`apply()` 时经 `installStepChatSessions` /
 * `installStepChatWorkspaces` 注入 sessions / workspaces 服务到模块级单例
 * （install/dispose 配对保证 HMR/卸载不串台）。
 *
 * B1（渲染对齐 DSH 0.1.2-rc.1 ChatView，数据/容器底座）：
 * - StepChatBody 改为「面板内滚动容器」（root 结构见 step-chat-panel.module.css）：
 *   `.stepChatScroll[data-conversation-scroll]` 内放
 *   `.stepChatColumn[data-chat-flow]`（行平铺 + TurnStatus），占位/error 态仍在
 *   容器外；保守 max-height + overflow-y:auto（step 卡不给高度约束，见 CSS 注释）。
 * - 新增 view-node 渲染通道（`createStepChatViewSource` 消费 rc.1 ChatSnapshot）：
 *   view 面可用且 order 非空 → 按 order 渲染逐 key 行（B1 骨架行；
 *   B2a 起已实现 kind——user/steering/assistant-step/context/system-prompt——
 *   走 step-view/ 的 rc.1 逐 kind 视觉（右对齐用户气泡、markdown 正文 +
 *   Think 行 + 已停止标记、上下文注入披露行、system prompt 披露行）；
 *   B2b 追加八 kind——compaction/manual-compaction/model-retry/turn-error/
 *   turn-max-tokens/unknown/command/tool-call（压缩标记、命令行（fallback 卡）、
 *   重试披露、turn 错误/上限通知、未知事件 JSON 行、工具行树（rc.1 无 occupant
 *   时的 GenericToolCard fallback 视觉））；B3 追加 turn-tail/turn-process（已完结
 *   轮的尾部动作行 + 进程披露折叠，见 StepChatViewRow 注释——全部注册 kind 至此
 *   有真实视图，占位行仅剩未知 kind 兜底）；B4a 追加右侧轮次轴
 *   （TurnNavigator，rc.1 ChatView 同款视觉：loaded 轴 + 滚动采样/锚点定位，
 *   详见 turn-rail.ts / step-view/TurnNavigator.tsx 头注释）；view 面不可用或
 *   order 空时显示空态占位（run.step.chat.empty）。
 * - B4b：简化对话输入框（同风格 composer，输入框在滚动容器**外**——rc.1
 *   composer 亦在 ChatView 外，B4a 确认零冲突；见 ComposerBar.tsx）：仅
 *   open+running 时显示（排队注入），发送走 stepChatComposerSendOf 装配的
 *   scope conversation 优先 / session.prompt('queue') 兜底，错误行在输入框上方。
 *   **需求 1（本次变更）：面板不再挂载输入框**——ComposerBar 及其模块图保留为唯一
 *   恢复入口（见其文件头），面板侧的接线（composerSend / composerBinding /
 *   hostSessionId 三个 props、`data-step-chat-composer-seat`、`@` 触发菜单、排队
 *   提示与发送错误行）全部删除；run 级 DiscussionInput（`[data-sandore-disc-input]`，
 *   含 @step 定点发送）不受影响。
 * - 行级订阅粒度对齐 ChatView：外层订阅 target（覆盖全部发布）+ 每行经
 *   `feed.nodeSource(key)`（ChatNodeStore.source(key)）独立订阅（memo 行 + uSES）。
 *   B2b：工具行需要 cwd（路径摘要相对化）与 onOpenFile（路径链接打开）——StepChatBody
 *   把既有 cwd/requestOpenFile 沿 StepChatViewRow 传入工具行。
 *
 * 批 B1（step 内嵌输入框改为「复用 DSH 输入内核 + 自绘壳」＋ 新增 @step）：
 * - 输入框：ComposerBar 双路。`sessions.binding(childId)` 作为**内核探测入口**经
 *   `composerBinding` 下传（`binding.ctx` = `sessions.scope(childId)`，DSH 输入壳
 *   `conversation.input.for(actx)` 在此解析）；内核可用 → DSH Lexical 编辑器绑到自绘
 *   contenteditable 壳，提交走 `input.submit('queue')`；探测失败 → 既有 textarea
 *   降级路径（行为不变）。详见 step-view/ComposerBar.tsx 文件头。
 *   **需求 1 起面板不再挂载它**（下一条的 @step 数据面因此只剩 RunView 侧快照读取）。
 * - @step 数据面：面板把 RunView 既有轮询结果（instanceId + executedSteps）经
 *   `instanceId`/`steps` props 收下，`buildStepMentionEntries` 转条目后登记进
 *   step-chat-registry（**零新 RPC**）；@step source 以子会话 id 反查 + 作用域守卫。
 *
 * 批 B2（面板内重试 + 宿主编辑器根抢占防护）：
 * - **重试**：`retry` 端口（RunView 装配的 `remote.retryStep` /
 *   `remote.listRevertBoundaries` 薄封装，零新 RPC）在面板层按 `stepRetryVisible`
 *   收窄一次；重试行渲染在**面板底部动作位**（`data-step-chat-retry-seat`，见
 *   StepRetryRow.tsx）。需求 1 起 `message` 是**固定默认串**
 *   （`run.step.chat.retry.defaultMessage`——面板没有草稿可作载荷），
 *   `revertBoundary` 仅 revert 模式携带。成功后面板靠 RunView 既有轮询刷新段；
 *   **fork/revert 会换 childId**，故 UnifiedTimeline 的挂载点带
 *   `key={item.childId ?? item.stepId}`，换值即重挂面板（不会停在已 dispose 的旧会话上）。
 * - **宿主根抢占防护**：`hostSessionId`（= `sessions.list.getSnapshot().current`，
 *   面板已订阅该列表）原本下传给 ComposerBar，等于本会话 id 时**不绑内核**（宿主原生
 *   对话页正显示该子代理，根归它的 InputBar）——见 step-view/ComposerBar.tsx 的两道守卫。
 *   需求 1 起面板不再绑输入内核，故该 prop 与守卫接线从本文件删除（守卫本体随
 *   ComposerBar 一起保留在恢复入口里）。
 *
 * 批 B3（加固：重试入口在占位态也可达）：
 * - B2 的重试行原本只挂在 composer seat 内，而 seat 只随 `openState === 'open'` 渲染 →
 *   **F1 场景**（failed 段的子代理已被 DSH dispose，binding 重拉耗尽或 open 恒被拒）
 *   面板长期停在 loading/error 占位，唯一的恢复入口被占位态藏掉、引擎「子代理会话
 *   已销毁」也无处展示。
 * - 现在三个占位分支（cold/loading、error 的 agent-busy loading、error）在占位文案
 *   下方一并渲染 `StepChatPlaceholderRetry`（占位文案与既有断言不变）；error 分支的
 *   「查看会话 / 用 DSH 原生对话打开」两个出口按钮原样保留，重试行追加在其下方。
 * - 可见性单点收窄：`retryPort = stepRetryVisible(retry?.target) ? retry : undefined`
 *   在同一渲染里算一次，open 态的底部动作位与占位分支共用 → `retry` 缺失或目标不可
 *   重试时占位态**不新增任何 DOM**；两态互斥，DOM 锚点
 *   `data-step-chat-retry-row` / `data-step-chat-retry-submit` 两种态统一。
 * - 重试 message 恒为本地化默认串（需求 1 起 open 态也没有草稿，`draft` 概念消失）。
 *
 * 呈现层统一（本批）：**主代理席位（variant='main'）**——本面板同时承载「主代理会话的
 * DSH 会话视图」：用户从运行页底部输入框（= 主代理输入壳，见 DiscussionInput.tsx）发出
 * 消息后，UnifiedTimeline 把本面板（`variant='main'`，sessionId = 实例宿主会话 id）挂到
 * **正在执行的那个 step 卡片内、该 step 现有会话面板的下方**——视觉上让主代理看起来也是
 * 一个 step agent 在响应；没有正在执行的 step 时退化为挂在步骤列表末尾（判定见
 * main-agent-chat.ts 的 `mainAgentAnchorStepIdOf`）。
 * 与子代理面板**同源**：同一套 binding → step-chat-source → step-view/ 行组件，不另造
 * 渲染器。两处差异（见 {@link StepChatVariant}）：① 开窗走 plain open（宿主会话没有
 * subagent 地址）；② 根锚点是 `data-main-agent-chat`（**不带** `data-step-chat`——
 * 后者是 f2「shell 步不挂会话面板」能力边界断言的计数对象，主代理对话块绝不能混进去）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/StepChatPanel
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  type ConversationTimelineSnapshot, type ISessions, type SessionFace, type SessionId,
  type SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'

import { stepChatNodePreview } from './chat-view-contract.ts'
import { resolveWorkspacePath } from './workspace-path.ts'
import { formatOpenError, stepChatRebindDelayMs, stepChatRetryDelayMs } from './step-chat-retry.ts'
// 批 A：更早历史分页（hasMore/loadingOlder 读取面 + loadOlder/loadThrough 能力 +
// prepend 保位纯函数；见 step-chat-paging.ts 头注释）。
import {
  stepChatPagingOf,
  stepChatPagingOfSession,
  stepChatPrependScrollTopOf,
  STEP_CHAT_NO_PAGING,
  type StepChatPagingState,
} from './step-chat-paging.ts'
// 批 A2：自动补齐完整历史（框架无关驱动：触发门 / 页数上限 / 失败退避 /
// loadingOlder 并发守卫 / 卸载 generation；见 step-chat-autofill.ts 头注释）。
import {
  createStepChatAutofill,
  type StepChatAutofillGate,
  type StepChatAutofillPorts,
  type StepChatAutofillRun,
} from './step-chat-autofill.ts'
import {
  createStepChatViewSource, applyStepChatTransport, buildStepChatAddress,
  openStepChatSessionInHost, type StepChatHostSessionsLike,
  type StepChatBindingLike as SourceStepChatBinding,
  type StepChatViewFeed,
} from './step-chat-source.ts'
import { formatRunDuration } from './chat-utils/message-chrome.ts'
import { ImageGallery, type SandoreRenderMessageImages } from './chat/attachment/MessageImage.tsx'
import { createImageLoader, type SandoreImageAttachmentRef } from './chat/attachment/image-attachment.ts'
import { messageImageLabels } from './chat/attachment/image-labels.ts'
// B2a：view-node 行的 rc.1 逐 kind 渲染（新目录 step-view/，独立于旧视觉路径）。
import { StepChatUserMessageView } from './step-view/UserMessageView.tsx'
import { StepChatAssistantStepView } from './step-view/AssistantStepView.tsx'
import { StepChatContextView } from './step-view/ContextInjectionRow.tsx'
import { StepChatSystemPromptView } from './step-view/SystemPromptRow.tsx'
import { StepChatCompactionView } from './step-view/CompactionItem.tsx'
import { StepChatCommandView, StepChatManualCompactionView } from './step-view/CommandCard.tsx'
import {
  StepChatModelRetryView, StepChatTurnErrorView, StepChatTurnMaxTokensView,
  StepChatUnknownView,
} from './step-view/NoticeRow.tsx'
import { StepChatToolCallView } from './step-view/tool/ToolCallView.tsx'
import { StepChatTurnTailView } from './step-view/TurnTailNodeView.tsx'
import { StepChatTurnProcessView } from './step-view/TurnProcessNodeView.tsx'
import { useSearchableHidden } from './step-view/searchable-hidden.ts'
// B4a：右侧轮次轴（loaded-only rail + 滚动采样/锚点定位的纯辅助；unloaded/
// outline/分页裁剪见 turn-rail.ts 与 TurnNavigator.tsx 头注释）。
import { TurnNavigator } from './step-view/TurnNavigator.tsx'
// 需求 1：面板**不再**挂载输入框（`step-view/ComposerBar.tsx` 保留为唯一恢复入口，
// 见其文件头「需求 1」段），故这里不再 import ComposerBar / stepChatComposerSendOf /
// stepChatComposerBindingOf —— 面板内没有发送通道、没有输入内核绑定、没有 @ 触发菜单。
// 批 B2：面板内「重试」（failed 的真实子代理 step → 面板底部动作区的重试行）。
// 可见性/载荷/回退点/错误映射全部是纯函数（step-view/step-retry.ts）；面板只做
// 「按可见性在底部动作位渲染重试行」这一件事。需求 1 起 message 是**固定默认串**
// （面板已无草稿可作载荷，见 step-view/StepRetryRow.tsx 头注释）。
import { stepRetryVisible, type StepChatRetryPort } from './step-view/step-retry.ts'
// 批 B3：占位态（cold/loading/agent-busy loading/error）也可达的重试行——open 态在
// 面板底部动作位（`data-step-chat-retry-seat`）渲染同一个组件，两态互斥（e2e 选择器
// `data-step-chat-retry-row` 统一）。
import { StepRetryRow } from './step-view/StepRetryRow.tsx'
// 批 B1：@step 提及源的数据面——面板把自己的 Step 快照登记进模块级 registry
// （@step source 以子会话 id 反查；作用域守卫见 step-chat-registry.ts）。
import {
  buildStepMentionEntries,
  installStepChatInstance,
  type StepMentionEntry,
  type StepMentionStepLike,
} from './step-chat-registry.ts'
import {
  STEP_CHAT_EMPTY_RAIL_ITEMS,
  STEP_CHAT_LANDING_CLEARANCE_PX,
  STEP_CHAT_SAMPLE_INTERVAL_MS,
  stepChatAnchorRowIn,
  stepChatRailItemsOf,
  stepChatSameRailItems,
  stepChatSampleTurnAt,
  stepChatScrollRowTo,
  stepChatTurnRowIn,
  type StepChatTurnRailItem,
} from './step-view/turn-rail.ts'
import {
  stepChatAssistantStepPayloadOf,
  stepChatProcessSeatOf,
  stepChatReasoningHiddenOf,
  stepChatRowViewKindOf,
  stepChatTailHasLaterChatNode,
  stepChatTailIsLatestTurn,
  stepChatTailRunMsOf,
  stepChatTurnProcessPresentationOf,
  stepChatTurnTailPayloadOf,
  stepChatTurnsWithContentOf,
} from './step-view/step-row-data.ts'
import viewCss from './step-chat-panel.module.css'
import css from './timeline.module.css'

/** sessions 服务未安装时的空订阅（useSyncExternalStore subscribe 侧）。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined

/**
 * 批 A（A3）：面板在滚动视口上发布的滚动契约变量键全表（卸载时按此表清除本组件
 * 写过的内联值；宿主继承值本就没写进内联，不受影响）。
 */
const SCROLL_VAR_KEYS = [
  '--dsh-composer-height',
  '--dsh-conversation-viewport-height',
  '--dsh-chat-content-width',
  '--dsh-composer-side-clearance',
] as const

/** workspaces 服务的最小注入面（`openPath` 为主；runtime WorkspaceRuntime 结构满足）。 */
export interface StepChatWorkspacesLike {
  openPath(path: string): Promise<void>
}

// ── 模块级 sessions/workspaces 持有（apply() 注入，卸载清除） ──────────────

let sessionsService: ISessions | undefined
let workspacesService: StepChatWorkspacesLike | undefined

/**
 * 安装 sessions 服务到模块级单例（插件 apply 时经 ctx.effect 调用）。
 * @param sessions - `ctx.sessions`（ISessions 公开面）。
 * @returns disposer：插件卸载时清除（避免残留引用串台）。
 */
export function installStepChatSessions(sessions: ISessions): () => void {
  sessionsService = sessions
  return () => {
    if (sessionsService === sessions) sessionsService = undefined
  }
}

/**
 * 安装 workspaces 服务到模块级单例（插件 apply 时经 ctx.effect 调用；文件路径打开用）。
 * @param workspaces - `ctx.workspaces` 的 openPath 面（宿主缺省该能力时传 undefined，
 *   面板 fileLink 静默降级，见 getStepChatWorkspaces）。
 * @returns disposer：插件卸载时清除。
 */
export function installStepChatWorkspaces(workspaces: StepChatWorkspacesLike | undefined): () => void {
  workspacesService = workspaces
  return () => {
    if (workspacesService === workspaces) workspacesService = undefined
  }
}

/** 读取 sessions 服务（未安装返回 undefined，面板渲染降级占位）。 */
function getStepChatSessions(): ISessions | undefined {
  return sessionsService
}

/**
 * 读取 sessions 服务（**公开形态**）：运行页的主代理席位（DiscussionInput.tsx）也要
 * 解析宿主会话的 `binding`（输入内核挂载 + 「中止主代理当前 turn」的动作探测），
 * 故把上面那份读取面导出（同一模块级单例，install/dispose 语义不变）。
 */
export function stepChatSessionsOf(): ISessions | undefined {
  return sessionsService
}

/**
 * 面板语义（呈现层统一 · 本批）：
 * - `'subagent'`（默认）：step 内嵌会话面板——子代理会话，经 `configureSubagent` 装配
 *   continuable 地址开窗（见开窗 effect）。
 * - `'main'`：**主代理席位**——实例宿主会话（= 主代理）的 DSH 会话视图，在用户从运行页
 *   底部输入框发出消息后挂到「正在执行的那个 step」下方（UnifiedTimeline 装配）。
 *   与子代理面板共用同一套数据面/行组件（同源机制，不另造渲染器）；差别只有两处：
 *   ① 开窗走 plain open（宿主会话没有 subagent 地址）；
 *   ② 根的 DOM 锚点是 `data-main-agent-chat` 而不是 `data-step-chat`——后者是 f2 的
 *   「shell 步不挂会话面板」能力边界断言的计数对象，主代理对话块绝不能混进去。
 */
export type StepChatVariant = 'subagent' | 'main'

/** 面板根的 DOM 锚点属性（见 {@link StepChatVariant}）。 */
function rootAnchorAttrs(variant: StepChatVariant): { readonly 'data-step-chat'?: ''; readonly 'data-main-agent-chat'?: '' } {
  return variant === 'main' ? { 'data-main-agent-chat': '' } : { 'data-step-chat': '' }
}

/** 读取 workspaces 服务（未安装返回 undefined，文件链接降级为纯文本）。 */
function getStepChatWorkspaces(): StepChatWorkspacesLike | undefined {
  return workspacesService
}

/** 会话绑定面（`sessions.binding` 返回；含开窗 cast 所需的 open）。 */
interface StepChatBindingLike {
  readonly session: SessionFace
}

/** 开窗：Session.open() 在具体类上（不在 ISession 接口面），cast 调用；失败静默。 */
function openSessionWindow(binding: StepChatBindingLike): void {
  const session = binding.session as unknown as { open(): Promise<void> }
  session.open().catch(() => {
    // 开窗失败走快照 openState='error'，面板降级占位；无需在此抛错。
  })
}

/** 面板内文件打开的错误对话框文案（与 ChatView 的 FileOpenErrorDialog 同族）。 */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/** ProducedFiles 打开会话工作区 `.`（与 ChatView 一致）。 */
function isFolderOpenPath(path: string): boolean {
  return path === '.'
}

/** 运行中 turn 的 turn/start 时间（TurnStatus 锚点；与 ChatView 一致；timeline 缺失返回 null）。 */
function runningTurnStartTime(timeline: ConversationTimelineSnapshot | null): number | null {
  if (timeline === null) return null
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open' && turn.start !== undefined) latest = turn.start.time
  }
  return latest
}

/**
 * 读原始 timeline 的 turnOrder 数字数组（B3 turn-tail 的 isLatestTurn 判定；
 * 结构探测，形状不符 → 空数组）。
 */
function stepTimelineOrderOf(raw: unknown): readonly number[] {
  if (typeof raw !== 'object' || raw === null) return []
  const order = (raw as { turnOrder?: unknown }).turnOrder
  if (!Array.isArray(order)) return []
  const turns: number[] = []
  for (const entry of order) {
    if (typeof entry === 'number' && Number.isFinite(entry)) turns.push(entry)
  }
  return turns
}

/** Turn 级模型活动标签（抄自 ChatView 的 TurnStatus：整轮运行期间不闪烁）。 */
function TurnStatus({ startTime, t }: {
  /** 运行中 turn 的 turn/start 时间；null 回退到挂载时间。 */
  startTime: number | null
  t: TranslateNS<'sandore'>
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={viewCss.turnStatus} role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className={viewCss.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      )}
    </div>
  )
}

/**
 * 面板根：解析 binding（订阅会话列表——子代理会话可能晚于 step 出现，host 流推送
 * 进列表后 binding 才可解析），绑定可用后挂载 `StepChatBody`。
 *
 * Round 25：binding 缺失（子代理 settle/dispose 后 host 广播 `session-removed` →
 * client 列表移除该 child）时按退避序列有界重拉 host 会话列表（`sessions.refresh()`，
 * host 列表包含持久化冷会话，refresh 后 child 可重新绑定）；达上限后停在 loading
 * 占位，避免对已删除 child 空转。
 */
export function StepChatPanel({ sessionId, parentSessionId, instanceId, steps, retry, variant = 'subagent', t }: {
  readonly sessionId: string
  /** 子代理的父（宿主主代理）会话 id（引擎在真实子代理段 sessionMeta.hostSessionId
   *  携带；缺失时回退当前会话——运行视图宿主页的 current 恒等于 parent）。 */
  readonly parentSessionId?: string | undefined
  /** 批 B1：本面板所属工作流实例 id（@step 提及登记用；缺省不登记）。 */
  readonly instanceId?: string | undefined
  /** 批 B1：本实例的 Step 执行段（RunView 的 getInstanceState 片段，零新 RPC）。 */
  readonly steps?: readonly StepMentionStepLike[] | undefined
  /** 批 B2：重试端口（本段定位片段 + retryStep/listRevertBoundaries 调用面）。
   *  缺省 = 不渲染重试行（旧调用方/测试不传即降级）。 */
  readonly retry?: StepChatRetryPort | undefined
  /** 面板语义：子代理 step 面板（默认）/ 主代理席位（见 {@link StepChatVariant}）。 */
  readonly variant?: StepChatVariant | undefined
  readonly t: TranslateNS<'sandore'>
}) {
  const sessions = getStepChatSessions()

  // Round 25：binding 重解析纪元（refresh 完成后 +1 强制重渲染以重解析 binding）。
  const [rebindEpoch, setRebindEpoch] = useState(0)
  const rebindAttempt = useRef(0)

  // 订阅会话列表快照：binding 可用性由「列表包含 / 已 scoped」决定，列表变化时
  // 重解析 binding（子代理会话新建后由 host 流推送进列表）。
  useSyncExternalStore(
    sessions === undefined ? NOOP_SUBSCRIBE : sessions.list.subscribe,
    () => (sessions === undefined ? undefined : sessions.list.getSnapshot()),
  )

  const binding = sessions?.binding(sessionId as SessionId)

  // parent 缺失时回退列表 current（子代理直接 parent = 实例宿主会话 = 运行视图宿主页）。
  const listCurrent = sessions?.list.getSnapshot().current
  const effectiveParent = parentSessionId ?? listCurrent

  // B1：view-node 数据源（rc.1 ChatSnapshot 的 order/nodes/… 直接读取面，
  // 见 step-chat-source.ts / chat-view-contract.ts）。view 面可用且 order 非空时
  // StepChatBody 走逐 key 行骨架，否则显示空态占位。
  const viewFeed = useMemo(
    () => createStepChatViewSource(binding as unknown as SourceStepChatBinding | undefined),
    [binding],
  )

  // 开窗前先装配 subagent-kind 传输地址。2026-09-09 真实 probe 实证：rc.1 宿主对
  // plain open（kind:'session'）的子代理会话恒返 `session/agent-busy`（运行中与
  // settle 后都拒，非瞬态）；唯一可行通道是 `{kind:'subagent', parentSessionId,
  // childSessionId, mode:'continuable'}`（运行中即可流式）。Session.configureSubagent
  // （两代运行时均有）把绑定实例切到 addressed history，此后 open() 走 subagents
  // 路由。parent 未知时暂不 open（等待段 meta/列表带出 parent），避免无谓的
  // agent-busy 错误态。
  useEffect(() => {
    if (binding === undefined) return
    if (variant === 'main') {
      // 主代理席位：宿主会话是**普通顶层会话**，没有 subagent 地址可装配
      // （configureSubagent 只对子代理会话有意义；硬装会把 plain 会话切到 subagents
      // 路由 → host 拒「not a subagent」）。直接 plain open 即可：它本来就是 DSH
      // 中心列里的那个会话，open 语义与中心列一致（拉历史 + 消费 mux 帧）。
      openSessionWindow(binding)
      return
    }
    const ready = applyStepChatTransport(binding.session, effectiveParent, sessionId)
    if (!ready) return
    openSessionWindow(binding)
  }, [binding, effectiveParent, sessionId, variant])

  // Round 25：binding 缺失时按退避序列重拉 host 会话列表（有界）。成功恢复绑定或
  // 列表重新包含该 child 后计数清零；child 确已删除则停在 loading 占位。
  // 注：`sessions.refresh()` 在 client-runtime 公开面（ISessions）未导出（rc.6），
  // 但运行时具体类存在且幂等只读（仅重拉 session.list，不改变 history transport
  // 路由）；cast 调用，缺失时降级为等待列表自然变化。
  useEffect(() => {
    if (sessions === undefined) return
    if (binding !== undefined) {
      rebindAttempt.current = 0
      return
    }
    const delay = stepChatRebindDelayMs(rebindAttempt.current)
    if (delay === undefined) return
    rebindAttempt.current += 1
    const timer = setTimeout(() => {
      const refreshList = (sessions as unknown as { refresh?(): Promise<void> }).refresh
      if (refreshList === undefined) return // 公开面缺失：等待列表自然变化（host 推送）
      void refreshList.call(sessions as never)
        .then(() => { setRebindEpoch(value => value + 1) })
        .catch(() => {
          // 重拉失败：等待下一轮退避重试。
        })
    }, delay)
    return () => { clearTimeout(timer) }
  }, [sessions, sessionId, binding, rebindEpoch])

  if (binding === undefined) {
    return (
      <div className={css.stepChatPanel} {...rootAnchorAttrs(variant)}>
        <div className={css.stepChatLoading}>{t('run.step.chat.loading')}</div>
      </div>
    )
  }

  // error 态重试耗尽后的「打开会话」逃生口（onOpenSession）：走 DSH 官方原生
  // 出口 `sessions.openSubagent(address)`——把宿主会话视图切到该子代理会话，可看
  // 完整消息流并继续对话（rc.6 公开面 ISessions.openSubagent 的入参就是
  // `{ parentSessionId, childSessionId, mode: 'continuable' }`，见
  // @deepseek-ai/dsh-subagent 的 SubagentAddress）。
  //
  // 地址装配优先级（批 A，A4）：
  // 1. `parentSessionId`（引擎 sessionMeta.hostSessionId，运行视图宿主页等价于
  //    current）已知 → 直接组 continuable 地址调 openSubagent；
  // 2. parent 缺失 → 回退 `sessions.subagentAddress(id)`（host catalog 已发现并
  //    保留的地址）+ openSubagent；
  // 3. 仍无 → 回退 `sessions.open(id)`（plain；可能被 host 以 session/agent-busy
  //    拒或对已 disposed 会话同步抛——catch + console.error，绝不向上抛）。
  // 注意 openSubagent 与 binding.session.configureSubagent 是两条独立通道：前者
  // 切「宿主视图」（本函数的用户可见出口），后者切「本面板的 history transport」
  // （见上方开窗 effect）；此处只负责前者。
  const openInHost = (): void => {
    const sessions = getStepChatSessions()
    if (sessions === undefined) return
    // 统一入口（与 RunView 的 step 标题同一函数）：**打开与历史加载装配同一个 durable 地址**，
    // 修复真机「历史加载失败：subagent Sessions require their durable parent address」——
    // 普通 open 会把 subagent 地址清成 undefined，故打开后必须再装配一次（见
    // step-chat-source.ts 的 `openStepChatSessionInHost`）。
    openStepChatSessionInHost(sessions as unknown as StepChatHostSessionsLike, {
      childSessionId: sessionId,
      variant,
      ...(effectiveParent === undefined ? {} : { parentSessionId: effectiveParent }),
    })
  }

  // 批 B2/B3：**唯一**的重试端口收窄点——panel 层按 `stepRetryVisible` 判定一次，
  // open 态的底部动作位与占位态的 StepRetryRow 共用同一个值。可见性为假（status 非
  // failed / shell 合成段 / commandType 不在子代理码表 / stepId 空）时到处都不渲染
  // 重试行，占位分支不会多出任何 DOM（下游 undefined 即「没这个功能」，不再二次判断）。
  const retryPort = stepRetryVisible(retry?.target) ? retry : undefined

  return (
    <StepChatBody
      session={binding.session}
      viewFeed={viewFeed}
      sessionId={sessionId}
      instanceId={instanceId}
      steps={steps}
      retry={retryPort}
      variant={variant}
      t={t}
      onOpenSession={openInHost}
      onOpenNative={openInHost}
    />
  )
}

/**
 * B1/B2a/B3：view-node 行——按 key 渲染 + 行级订阅（详见上方模块注释与
 * chat-view-contract.ts：memo 行 + ChatNodeStore.source(key) per-key 订阅，
 * 对齐 ChatView/ChatNodeSeat 的订阅粒度）。B2a/B2b 已实现 kind 走 step-view/
 * 的 rc.1 逐 kind 渲染组件（switch 经 stepChatRowViewKindOf 归一分发）；B3
 * 接手 turn-tail（尾部动作行）与 turn-process（进程披露头/成员行折叠），占位
 * 摘要行仅剩未知 kind 兜底。
 *
 * B3 行壳职责（= rc.1 ChatNodeSeat 的过程折叠判定移植，见
 * step-row-data.ts stepChatProcessSeatOf）：
 * - 每行另订阅引擎 per-turn 进程展示（整列发布通知 + processOf(key) 重读；
 *   展示对象身份稳定 → 只在实际变化时重渲，等价 rc.1 useChatNodeProcess）；
 * - 行壳按 stepChatProcessSeatOf 判定 member/answer/compactAnswer/hidden，
 *   useSearchableHidden 把折叠成员行/未激活控制节点行隐藏为
 *   `hidden="until-found"`（保留 DOM 与锚点、浏览器 find 可揭示）；
 * - 折叠开关（rc.1 actions.setTurnProcessOpen 的 store 持久化）→ StepChatBody
 *   的轮次级本地展开态（processOpenTurns/onProcessOpenChange，面板内只读
 *   展开/折叠、不跨会话持久）。
 * DOM 锚点（B4 轮次轴 / toBottom / scroll 恢复用）：data-chat-anchor-key /
 * data-chat-flow-key / data-chat-flow-kind / data-chat-turn 挂在行壳（与 ChatView
 * flowItem 同职责）；进程行另挂 data-turn-process-member/-hidden/-answer。
 */
const StepChatViewRow = memo(function StepChatViewRow({ feed, nodeKey, t, renderMessageImages, cwd, onOpenFile, onFork, processOpenTurns, onProcessOpenChange, historyIncomplete, instanceId }: {
  readonly feed: StepChatViewFeed
  readonly nodeKey: string
  readonly t: TranslateNS<'sandore'>
  /** 附件渲染器（既有 ImageGallery/ImageLoader 通道；step-view 行直传）。 */
  readonly renderMessageImages: SandoreRenderMessageImages
  /** 会话工作区根（工具行路径摘要相对显示；未知时省略）。 */
  readonly cwd?: string | undefined
  /** 打开文件路径（工具行路径链接；面板 workspaces 通道）。 */
  readonly onOpenFile?: ((path: string) => void) | undefined
  /** 以会话 seq 为锚 fork（B3 turn-tail 分支动作）。 */
  readonly onFork: (seq: number) => void
  /** 已展开的进程轮次级集合（同轮多行共享同一开关值；StepChatBody 持有）。 */
  readonly processOpenTurns: readonly number[]
  /** 回写轮次级进程展开态（面板内只读展开/折叠）。 */
  readonly onProcessOpenChange: (turn: number, open: boolean) => void
  /** 批 A：窗口不完整（= 会话快照 hasMore，逐行直传；官方 ChatNodeSeat 同款）。 */
  readonly historyIncomplete: boolean
  /**
   * 面板所在实例 id（= 宿主/主代理会话 id）。
   *
   * 用途仅一处：工具行内嵌的「工作流导航」在 `sandore_workflow_control` 省略
   * `instanceId` 入参时按恒等式（调用会话 ≡ instanceId）兜底解析目标实例。
   */
  readonly instanceId?: string | undefined
}) {
  // 行级源（引擎 store 内部缓存：同一 builder 实例跨发布身份稳定，只在自身节点
  // 身份变化时通知；store 重建（视图注册表刷新）时身份变化，uSES 自动重订阅）。
  const nodeSource = feed.nodeSource(nodeKey)
  const node = useSyncExternalStore(
    // 兜底（源暂缺）：退回整列订阅——每次发布重读本行节点。
    nodeSource === undefined
      ? (onStoreChange) => feed.subscribe(onStoreChange)
      : nodeSource.subscribe,
    () => feed.node(nodeKey),
  )
  // B3：进程展示反应源（等价 rc.1 ChatNodeSeat 的 useChatNodeProcess per-key
  // processSource）。引擎 processSource 的通知经整列发布到达；uSES 快照取引擎
  // 展示对象本身（身份稳定），只在展示实际变化（turn 闭合/边界移动/计数变化）
  // 时触发行重渲，不随流式帧空转。宿主无 processSource → processOf 恒
  // undefined → 行不折叠（rc.1 无进程投影的等价呈现）。
  const processRaw = useSyncExternalStore(feed.subscribe, () => feed.processOf(nodeKey))
  const presentation = stepChatTurnProcessPresentationOf(processRaw)
  const specTurn = presentation?.spec.turn
  const processOpen = specTurn !== undefined && processOpenTurns.includes(specTurn)
  // 揭示回调：折叠成员行/答复行被浏览器 find 命中或焦点困住时打开轮次级折叠。
  const revealProcess = useCallback(() => {
    if (specTurn !== undefined) onProcessOpenChange(specTurn, true)
  }, [onProcessOpenChange, specTurn])
  // B3 行壳判定（纯函数；compactTranscript 恒 true = 面板按 rc.1 compact 语义）。
  // 批 A：historyIncomplete 由面板传真实 hasMore（官方 ChatView 的
  // `historyIncomplete={hasMore}`）——窗口不全时 windowReady 恒假，整行不折叠。
  // node 缺席（行源暂空）时无行可隐藏 → seat null（hooks 先于下方 early return）。
  const assistantPayload = node?.kind === 'assistant-step'
    ? stepChatAssistantStepPayloadOf(node.data)
    : null
  const seat = node === undefined
    ? null
    : stepChatProcessSeatOf({
      kind: node.kind,
      anchorSeq: node.anchorSeq,
      assistantStep: assistantPayload === null ? undefined : assistantPayload.step,
      presentation,
      open: processOpen,
      historyIncomplete,
    })
  const wrapperRef = useSearchableHidden(seat?.hidden ?? false, revealProcess)
  if (node === undefined || seat === null) return null
  // B2a/B2b/B3 已实现视图族（纯函数可单测；未知 kind → undefined → 占位摘要行）。
  const viewKind = stepChatRowViewKindOf(node.kind)
  let body: ReactNode
  /**
   * turn-tail 被**主动抑制**的原因（只有 turn-tail 行可能置位；行壳挂
   * `data-turn-tail-suppressed` 供真机取证「到底哪条规则挡住了它」）：
   * - `empty-turn`：本 turn 没有任何内容行（被 park 的结算通知留下的空壳 turn）；
   * - `no-closing`：本 turn 没有带正文的结算 assistant（rc.1 无动作行语义）。
   */
  let tailSuppressed: 'empty-turn' | 'no-closing' | undefined
  switch (viewKind) {
    case 'user':
    case 'steering':
      body = (
        <StepChatUserMessageView
          data={node.data}
          renderMessageImages={renderMessageImages}
          t={t}
        />
      )
      break
    case 'assistant-step': {
      // B3：答复行内联推理折叠（rc.1 AssistantNodeView.reasoningHidden：进程
      // 折叠中 + 本行即最终答复 + spec.inlineReasoning → 推理块隐藏，随轮次级
      // 展开态揭示——data-turn-process-inline 见 AssistantMarkdown.ProcessReasoning）。
      const reasoningHidden = assistantPayload !== null
        && stepChatReasoningHiddenOf(presentation, assistantPayload.step, processOpen, seat.answer)
      body = (
        <StepChatAssistantStepView
          data={node.data}
          renderMessageImages={renderMessageImages}
          reasoningHidden={reasoningHidden || undefined}
          revealProcess={seat.answer ? revealProcess : undefined}
          t={t}
        />
      )
      break
    }
    case 'context':
      body = <StepChatContextView data={node.data} t={t} />
      break
    case 'system-prompt':
      body = <StepChatSystemPromptView data={node.data} t={t} />
      break
    case 'compaction':
      body = <StepChatCompactionView data={node.data} t={t} />
      break
    case 'command':
      body = <StepChatCommandView data={node.data} t={t} />
      break
    case 'manual-compaction':
      body = <StepChatManualCompactionView data={node.data} t={t} />
      break
    case 'model-retry':
      body = <StepChatModelRetryView data={node.data} t={t} />
      break
    case 'turn-error':
      body = <StepChatTurnErrorView data={node.data} t={t} />
      break
    case 'turn-max-tokens':
      body = <StepChatTurnMaxTokensView data={node.data} t={t} />
      break
    case 'unknown':
      body = <StepChatUnknownView data={node.data} t={t} />
      break
    case 'tool-call':
      body = (
        <StepChatToolCallView
          data={node.data}
          cwd={cwd}
          onOpenFile={onOpenFile}
          instanceId={instanceId}
          t={t}
        />
      )
      break
    case 'turn-process': {
      // 进程披露头（折叠条）。seat.hidden（controllerInactive——turn 未闭合/
      // 无答复边界）由行壳 hidden 承担；视图解析失败 → null（空壳行）。
      body = (
        <StepChatTurnProcessView
          data={node.data}
          open={processOpen}
          onToggle={(open) => { if (specTurn !== undefined) onProcessOpenChange(specTurn, open) }}
          t={t}
        />
      )
      break
    }
    case 'turn-tail': {
      // 尾部动作行：closing 缺席/不可读 → null（rc.1 无槽注入时不产动作行；
      // 行壳空壳 + :empty 规则不占布局，锚点仍在）。
      const tail = stepChatTurnTailPayloadOf(node.data)
      // ① **空 turn 不渲染尾部动作行**（用户真机「主代理会话里一堆空白行」）：被 park 的
      //    结算通知在 DSH 侧留下 `turn/start` + `turn/end{blocked}` 的空壳 turn（引擎侧
      //    无法消除，见 step-row-data.ts 的判据注释），这类 turn 里除了尾部动作行什么都没有；
      //    若照常渲染，用户看到的就是「一串只有时钟/图标的空白行」。
      //    turn 号读不出来时按「有内容」处理（fail-open：只认能证明为空的）。
      //    先判空 turn 再判 closing：两条都能挡住时，对外记的是**用户口径**的那条。
      const turnHasContent = tail.turn === undefined
        ? true
        : stepChatTurnsWithContentOf(feed.nodesSnapshot()).has(tail.turn)
      if (!turnHasContent) {
        tailSuppressed = 'empty-turn'
        body = null
      } else if (tail.closing === null || tail.closing.finalNode === undefined) {
        tailSuppressed = 'no-closing'
        body = null
      } else {
        const timelineRaw = feed.timeline()
        body = (
          <StepChatTurnTailView
            data={node.data}
            reveal={stepChatTailIsLatestTurn(stepTimelineOrderOf(timelineRaw), tail.turn)
              ? 'always'
              : 'hover'}
            runMs={stepChatTailRunMsOf(timelineRaw, tail.turn, tail.time)}
            hasLaterNode={stepChatTailHasLaterChatNode(
              feed.nodesSnapshot(),
              node.key,
              tail.turn,
            )}
            onBranch={onFork}
            t={t}
          />
        )
      }
      break
    }
    default: {
      const summary = stepChatNodePreview(node)
      body = (
        <div className={viewCss.stepChatViewPlaceholder}>
          <span className={viewCss.stepChatViewKind}>{node.kind}</span>
          <span className={viewCss.stepChatViewKey}>{node.key}</span>
          {summary !== undefined && <span className={viewCss.stepChatViewSummary}>{summary}</span>}
        </div>
      )
    }
  }
  return (
    <div
      ref={wrapperRef}
      className={viewCss.stepChatViewRow}
      data-chat-anchor-key={node.key}
      data-chat-flow-key={node.key}
      data-chat-flow-kind={node.kind}
      data-chat-turn={node.location?.turn}
      data-turn-process-member={seat.member || undefined}
      data-turn-process-hidden={seat.hidden || undefined}
      data-turn-process-answer={seat.compactAnswer || undefined}
      data-turn-tail-suppressed={tailSuppressed}
    >
      {body}
    </div>
  )
})

/**
 * 批 B3：**占位态的重试行**——让重试入口在面板没能开窗时依然可达。
 *
 * 为什么需要它（B2 遗留的唯一实质风险）：重试行原本只挂在 composer seat 内，而
 * composer seat 只在 `openState === 'open'` 那条分支渲染。F1 场景（failed 段的
 * 子代理已被 DSH dispose——binding 重拉耗尽或 open 恒被拒）下面板长期停在
 * loading/error 占位，于是「唯一的恢复入口」被自己的占位态藏掉了，引擎的
 * 「子代理会话已销毁…不能重试」也无处展示。重试行恰恰不需要会话开窗：它只读
 * `port.target`（段定位片段）+ 两个已有 RPC（retryStep / listRevertBoundaries）。
 *
 * 去重策略（同一组件、不重复渲染）：
 * - 本组件**只在三个占位分支**里渲染，open 态分支（底部动作位
 *   `data-step-chat-retry-seat`）完全不经过它——两态互斥，任一时刻面板内最多一份
 *   重试行；
 * - 与 open 态那份共用同一个 `data-step-chat-retry-row` 锚点（组件本体复用
 *   `StepRetryRow`，不另写一份视觉），e2e 用同一选择器即可覆盖两种态；
 * - 可见性在 `StepChatBody` 收窄一次（`stepRetryVisible`），`retry` 为 undefined
 *   时本组件**不产出任何 DOM**（不新增占位包裹层），占位态与批 B2 前逐字节一致。
 *
 * 提交 message 是固定默认串（`run.step.chat.retry.defaultMessage`）：需求 1 起面板
 * 没有输入面也就没有草稿，open 态与占位态走同一条
 * `stepRetryMessageOf('', 默认串)` 路径。
 *
 * @param props - `retry`：已收窄的重试端口（undefined = 不渲染）；`t`：本地化。
 * @returns 重试行（或 null）。
 */
function StepChatPlaceholderRetry({ retry, t }: {
  readonly retry?: StepChatRetryPort | undefined
  readonly t: TranslateNS<'sandore'>
}) {
  if (retry === undefined) return null
  return (
    <div className={viewCss.stepChatPlaceholderRetry} data-step-chat-retry-placeholder>
      <StepRetryRow port={retry} t={t} />
    </div>
  )
}

/**
 * 面板主体：订阅会话快照（ObservableSnapshot 的 uSES 两侧）+ view-node 数据源，
 * 渲染逐 key 行。
 *
 * 导出（批 A）：jsdom 冒烟测试要渲染真实主体（「加载更早」按钮的可见/禁用/调用、
 * 滚动契约变量的发布），而 StepChatPanel 自身还要求 sessions 服务与 binding 装配
 * 才能挂载到这一层——直接导出主体比在测试里搭一套 sessions 桩更省且更贴被测面。
 * 调用方仍应经 StepChatPanel（它负责 binding/开窗/重试端口装配；需求 1 起不再负责
 * 任何发送通道——面板没有输入框）。
 */
export function StepChatBody({ session, viewFeed, sessionId, instanceId, steps, retry, variant = 'subagent', t, onOpenSession, onOpenNative }: {
  readonly session: SessionFace
  /** B1 view-node 数据源（rc.1 ChatSnapshot 读取面；undefined = 无 target → 空态）。 */
  readonly viewFeed: StepChatViewFeed | undefined
  readonly sessionId: string
  /** 批 B1：本面板所属实例 id（@step 登记；缺省不登记）。 */
  readonly instanceId?: string | undefined
  /** 批 B1：本实例的 Step 执行段（@step 候选/序列化数据源）。 */
  readonly steps?: readonly StepMentionStepLike[] | undefined
  /** 批 B2/B3：重试端口（仅 failed 的真实子代理段可见）。可见时在 **open 态**
   *  渲染于面板底部动作位（`data-step-chat-retry-seat`），在 **占位态**
   *  （cold/loading/agent-busy loading/error）渲染于占位文案下方
   *  （`StepChatPlaceholderRetry`）——两态互斥，任一时刻面板内只有一份重试行
   *  （同一 `data-step-chat-retry-row` 锚点）。 */
  readonly retry?: StepChatRetryPort | undefined
  /** 面板语义：子代理 step 面板（默认）/ 主代理席位（根锚点换 `data-main-agent-chat`）。 */
  readonly variant?: StepChatVariant | undefined
  readonly t: TranslateNS<'sandore'>
  /** error 态重试耗尽后的「打开会话」逃生口（openSubagent/兜底 open）。 */
  readonly onOpenSession: () => void
  /** 批 A（A4）：error 态「用 DSH 原生对话打开」按钮（同一出口，面板侧实现）。 */
  readonly onOpenNative: () => void
}) {
  // 面板根的 DOM 锚点（见 StepChatVariant）：主代理席位绝不带 data-step-chat。
  const anchorAttrs = rootAnchorAttrs(variant)
  // 批 B3：重试端口收窄（**定义在任何早返回之前**——占位分支与下方的底部动作位
  // 共用同一个值）。纯计算、无 hook，故不影响 hooks 顺序。
  //
  // 双保险：`StepChatPanel` 已在装配处按 `stepRetryVisible` 收窄一次（运行期真路径），
  // 这里再收窄一次是给**直接渲染 StepChatBody** 的调用方/测试兜底——可见性为假时
  // 占位分支与底部动作位都不产出重试行 DOM。
  const retryPort = stepRetryVisible(retry?.target) ? retry : undefined

  // Session.subscribe/getSnapshot 是原型方法（依赖 this），须经箭头包装再交给
  // uSES（DSH 消费侧同样 `fn => session.subscribe(fn)`）。
  const snapshot = useSyncExternalStore(
    (onStoreChange) => session.subscribe(onStoreChange),
    () => session.getSnapshot(),
  )
  // B1 view-node 整列订阅：target 每次装配发布都通知（覆盖全部节点更新，含按 rAF
  // 合并的流式帧）；read() 的值身份随发布变化 → 本层在结构/内容变化时重渲列。
  const viewRead = useSyncExternalStore(
    viewFeed === undefined ? NOOP_SUBSCRIBE : (onStoreChange) => viewFeed!.subscribe(onStoreChange),
    () => viewFeed?.read(),
  )
  // 渲染通道开关：view 面可用且其 order 非空 → view-node 行骨架；否则显示空态
  // 占位（不渲染旧视觉行）。
  const useViewRows = viewFeed !== undefined && (viewRead?.order.length ?? 0) > 0

  // ── 批 B1：@step 提及登记 ────────────────────────────────────────────────
  // 面板带着 RunView 既有 state 片段（instanceId + executedSteps），把本实例的
  // Step 快照登记进模块级 registry —— 时间线组件树不携带 ctx，@step source（注册在
  // client 根）只能经这个单例读到候选。**零新 RPC**：数据就是 run 视图既有轮询结果。
  // 登记键 = 实例（一个实例多个 step 卡都登记同一份，后写覆盖），条目以
  // sessionMeta.childId 索引，@step source 据此做作用域守卫（非本实例会话 → 空候选）。
  // steps 引用已由 RunView 归一（stepChatReuseSegments），故本 memo 与下游登记
  // effect 只在内容真变时重跑（轮询空转不重建条目）。
  const mentionEntries = useMemo(
    () => (instanceId === undefined ? [] : buildStepMentionEntries(steps, instanceId)),
    [instanceId, steps],
  )
  useEffect(() => {
    // 无真实子代理会话（合成会话/尚未起会话）时不登记：@step 无事可提。
    if (instanceId === undefined || mentionEntries.length === 0) return undefined
    return installStepChatInstance(instanceId, mentionEntries)
  }, [instanceId, mentionEntries])

  // 面板内滚动视口 / 消息列（B4a 轮次轴的滚动采样与锚点定位共用；批 A 的分页
  // 保位与滚动变量发布也挂在这一对节点上）。滚动视口即「本张 step 卡片自己的
  // 滚动器」——见下方 data-conversation-scroll 注释。
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const chatColumnRef = useRef<HTMLDivElement | null>(null)

  // ── 批 A（A1）：更早历史分页 ────────────────────────────────────────────────
  // 面板不裁剪消息：渲染的是会话加载窗的全部 order（真正的截断在 DSH 加载窗本身，
  // 一页 50 条）。快照的 hasMore/loadingOlder 决定「加载更早」按钮的可见/禁用
  // （rc.1 ChatView 同款），hasMore 同时逐行下传为进程折叠守卫（A2）。
  const pagingState: StepChatPagingState = stepChatPagingOf(snapshot)
  // 分页能力（loadOlder 必在；loadThrough 为 rc.1 预留出口，rc.6 运行时缺失 → no-op）。
  const paging = useMemo(() => stepChatPagingOfSession(session), [session])
  // 飞行中的 loadOlder 票据（同一刻的重复投递——手动点击 + 自动补齐——复用同一
  // promise，见 loadOlderPreserving；跨渲染保持）。
  const pagingInFlightRef = useRef<Promise<void> | null>(null)
  // 卸载守卫：补偿要等 prepend 提交后的下一帧，期间组件可能已卸载（不得碰 DOM）。
  const pagingGenerationRef = useRef(0)
  useEffect(() => () => { pagingGenerationRef.current += 1 }, [])

  /**
   * 「加载更早」一页——手动按钮与自动补齐（批 A2）**共用同一条路径**：
   * rc.1 ChatView loadOlderAnchored 的面板等价形式——加载前量 scrollHeight，
   * loadOlder 落地（DOM 已提交 prepend）后把 scrollTop 补回 ΔscrollHeight，
   * 视线停在原来那一行（DSH 同款 prepend 保位语义；见 step-chat-paging.ts）。
   * 补偿走 rAF 而非快照订阅：prepend 的 DOM 提交可能分多帧，rAF 里量到的是该帧
   * 真实几何，Δ≤0（失败/空页）时纯函数返回原值。已在顶部（scrollTop≈0）时
   * ΔscrollHeight 补偿后仍在顶部——「贴顶阅读」的自然行为。
   * 注：不用持久 anchorRef 持有锚点行——面板行可能 hidden="until-found"（进程
   * 折叠）而不参与布局；ΔscrollHeight 是面板结构下等价且更鲁棒的保位量。
   * @returns 该页的完成 promise；**失败时拒绝**（自动补齐据此退避重试；手动点击
   *   侧自行吞掉，见 handleLoadOlderClick）。同一刻已有在飞页时返回**同一**
   *   promise，绝不重复投递。
   */
  const loadOlderPreserving = useCallback((): Promise<void> => {
    const inFlight = pagingInFlightRef.current
    if (inFlight !== null) return inFlight
    const container = scrollContainerRef.current
    const before = container === null
      ? undefined
      : { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop }
    const generation = pagingGenerationRef.current
    let flight: Promise<void> = Promise.resolve()
    flight = paging.loadOlder().then(
      () => {
        if (generation !== pagingGenerationRef.current) return // 已卸载：不碰 DOM
        const el = scrollContainerRef.current
        if (el === null || before === undefined) return
        requestAnimationFrame(() => {
          if (generation !== pagingGenerationRef.current) return
          const target = scrollContainerRef.current
          if (target === null) return
          target.scrollTop = stepChatPrependScrollTopOf(before, {
            scrollHeight: target.scrollHeight,
            scrollTop: target.scrollTop,
          })
        })
      },
    ).finally(() => {
      if (pagingInFlightRef.current === flight) pagingInFlightRef.current = null
    })
    pagingInFlightRef.current = flight
    return flight
    // 注：loadThrough(seq)（轮次轴未加载轮次跳转）能力已装配在 paging 上，
    // 本批不接 UI —— 后续批次在 TurnNavigator 的 unloaded 锚点分支调用
    // `paging.loadThrough(item.anchor.seq)`。
  }, [paging])

  /** 手动「加载更早」：失败已在快照 openState/loadingOlder 回落，点击侧只吞掉拒绝。 */
  const handleLoadOlderClick = useCallback((): void => {
    void loadOlderPreserving().catch(() => {})
  }, [loadOlderPreserving])

  // ── 批 A2：自动补齐完整历史（驱动 = step-chat-autofill.ts）──────────────────
  //
  // 面板可见性：IntersectionObserver 观测**本卡片自己的滚动视口**。宿主没有稳定
  // 的「卡片是否在视口内」信号可用，故面板自己量；`IntersectionObserver` 不存在
  // （jsdom/非浏览器宿主）时退化为「挂载即视为可见」——挂载即开始自动补齐，
  // 不因缺少可见性信号而永不补齐。
  // 初值取反：IO 可用时先按「不可见」起手（初始光标可能落在屏幕外的长会话卡片
  // 不该抢先花带宽/内存去补齐），等 observe 后必到的首次回调给出真值。
  const [autofillVisible, setAutofillVisible] = useState(
    () => typeof IntersectionObserver === 'undefined',
  )
  const autofillVisibleRef = useRef(autofillVisible)
  autofillVisibleRef.current = autofillVisible
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setAutofillVisible(true)
      return undefined
    }
    const container = scrollContainerRef.current
    if (container === null) return undefined
    const observer = new IntersectionObserver((entries) => {
      let intersecting = false
      for (const entry of entries) {
        if (entry.isIntersecting) intersecting = true
      }
      setAutofillVisible(intersecting)
    })
    observer.observe(container)
    return () => { observer.disconnect() }
    // 容器只随开窗态出现/消失（无 view 行时它也在），故以 openState 为依赖重挂。
  }, [snapshot.openState])

  /** 自动补齐进行中（列首轻量提示行；驱动经 onActiveChange 回写）。 */
  const [autofillActive, setAutofillActive] = useState(false)
  // 会话实例 ref：端口每轮读**最新**快照/实例（binding 重解析会换 session 对象）。
  const sessionRef = useRef(session)
  sessionRef.current = session

  /**
   * 一轮补齐之间的「快照稳定」等待：让出到下一帧（prepend 的 DOM 提交与快照发布
   * 都在该帧内落地）。隐藏标签页里浏览器会挂起 rAF，故并行挂一个 16ms 定时器
   * 兜底，两者取先到者——驱动绝不会卡在这一步。
   */
  const settleForSnapshot = useCallback((): Promise<void> => new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { finish() })
    setTimeout(finish, 16)
  }), [])

  /**
   * 驱动端口（**每轮**重读：驱动不缓存任何面板状态）。初值门恒关/能力为 no-op，
   * 真正的实现由渲染体在 effects 之前刷新（驱动只在 effect 里触发，读到的是当拍
   * 实现）。
   */
  const autofillPortsOf = useRef<() => StepChatAutofillPorts>(() => ({
    readGate: (): StepChatAutofillGate => ({
      bindingReady: false,
      visible: false,
      openState: 'cold',
      failed: true,
      paging: STEP_CHAT_NO_PAGING,
    }),
    loadOlder: () => Promise.resolve(),
  }))
  autofillPortsOf.current = (): StepChatAutofillPorts => ({
    readGate: (): StepChatAutofillGate => {
      const live = sessionRef.current.getSnapshot()
      // 错误态探测走结构读取（照 step-chat-paging.ts 的防御风格）：旧宿主/异常
      // 快照可能整个缺 openError 字段，那种情况按「无错」处理，不误关补齐门。
      const openError = (live as { openError?: unknown }).openError
      return {
        // 本组件挂载即 binding 就绪（StepChatPanel 解析出 binding 才渲染主体）。
        bindingReady: true,
        visible: autofillVisibleRef.current,
        openState: live.openState,
        failed: openError !== null && openError !== undefined,
        paging: stepChatPagingOf(live),
      }
    },
    loadOlder: loadOlderPreserving,
    settle: settleForSnapshot,
    onActiveChange: setAutofillActive,
  })

  // 驱动实例：随分页能力（= 会话）重建；cleanup 里 dispose（卸载/会话切换的
  // generation 守卫——在飞页与退避定时器全部作废，不可能再投递）。
  const autofillRunRef = useRef<StepChatAutofillRun | null>(null)
  useEffect(() => {
    const run = createStepChatAutofill(() => autofillPortsOf.current())
    autofillRunRef.current = run
    run.trigger()
    return () => {
      if (autofillRunRef.current === run) autofillRunRef.current = null
      run.dispose()
    }
  }, [paging])

  // 门输入变化（可见性 / 开窗态 / 是否仍有更早历史 / 行是否就绪）→ 再触发一次：
  // 进行中与已闩锁（上限/失败）都是 no-op，故不会重复投递也不会无界重启。
  useEffect(() => {
    autofillRunRef.current?.trigger()
  }, [autofillVisible, snapshot.openState, pagingState.hasMore, useViewRows])

  const loadOlderLabel = pagingState.loadingOlder
    ? t('run.step.chat.paging.loading')
    : t('run.step.chat.paging.loadOlder')

  // Round 25：open 失败粘滞自愈——openState='error' 时有界退避重试 open()。
  // Session.open() 对 'error' 会重跑 doOpen（瞬时失败——短 turn 子代理
  // settle/dispose 过渡窗口——可自愈）；成功（'open'）后计数清零；达上限后停在
  // error 占位并展示 openError（便于现场锁定确切错误码）。
  const retryAttempt = useRef(0)
  useEffect(() => {
    if (snapshot.openState === 'open') {
      retryAttempt.current = 0
      return
    }
    if (snapshot.openState !== 'error') return
    const delay = stepChatRetryDelayMs(retryAttempt.current)
    if (delay === undefined) return // 已达重试上限：停在 error 占位（openError 可见）。
    retryAttempt.current += 1
    const timer = setTimeout(() => {
      const opener = session as unknown as { open(): Promise<void> }
      void opener.open().catch(() => {
        // 重试失败：openState 保持 error，退避序列在下次 error 触发时继续。
      })
    }, delay)
    return () => { clearTimeout(timer) }
  }, [snapshot.openState, session])

  // Round 25（settle 重 open）：运行中子代理 open() 被 host 以 session/agent-busy 拒绝
  // （turn 未 settle、parent address 未 durable）是瞬态——等 turn settle
  // （snapshot.running→false）后重 open()。Round 25 的 3 次退避（1s→3s→10s）对长
  // turn 子代理可能不够；running→false 是 open 可用的权威信号——settle 后自动重
  // open，全程无需用户手动重点击。
  // settleReopenedRef 守卫（防失控）：仅「running 由 true→false 且 openState 仍为
  // error + agent-busy」的 settle 转换沿触发一次 open()，触发后置位；若每次快照都
  // 携带新的 openError 实例而 running 恒 false，无守卫会在每帧重发 open() 形成无
  // 退避紧循环打爆 host——置位后该稳态不再重发。openState 离开 error（open 成功/
  // 恢复）或 running 重新为 true 时复位，允许下一轮 settle 转换沿再触发一次。
  const settleReopenedRef = useRef(false)
  useEffect(() => {
    if (snapshot.openState !== 'error') {
      settleReopenedRef.current = false
      return
    }
    if (snapshot.openError?.code !== 'session/agent-busy') {
      // 非 agent-busy 的 error：settle 重 open 不介入，由 Round 25 有界退避负责。
      return
    }
    if (snapshot.running) {
      // 仍 running：等 settle；此沿复位守卫，真正的 running→false 转换沿才触发。
      settleReopenedRef.current = false
      return
    }
    if (settleReopenedRef.current) return
    settleReopenedRef.current = true
    const opener = session as unknown as { open(): Promise<void> }
    void opener.open().catch(() => {
      // settle 后 open 仍失败：保持 error 占位（Round 25 继续退避）。
    })
  }, [snapshot.openState, snapshot.openError, snapshot.running, session])

  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  const fileOpenRequest = useRef(0)
  const sessions = getStepChatSessions()

  // 会话 cwd（workspace root）：路径摘要相对其显示；与 ChatView 的
  // `useSessions(s => s.byId[sessionId]?.cwd)` 同源。
  const cwd = sessions?.list.getSnapshot().byId[sessionId as SessionId]?.cwd

  // 文件打开：解析 cwd 后经 workspaces.openPath 打开宿主默认应用；失败弹对话框。
  const requestOpenFile = useCallback((path: string) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    const workspaces = getStepChatWorkspaces()
    if (workspaces === undefined) {
      setFileOpenError(null)
      setFileOpenBusy(false)
      return
    }
    const listCwd = sessions?.list.getSnapshot().byId[sessionId as SessionId]?.cwd
    void workspaces.openPath(resolveWorkspacePath(listCwd, path)).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t(isFolderOpenPath(path) ? 'fileOpen.folderUnknown' : 'fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [sessions, sessionId, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
  }, [])

  // 分支（fork）：以结算 seq 为锚 fork 会话并在列表中就绪后打开（与 DSH forkAt 同语义）。
  const forkAt = useCallback((seq: number) => {
    const sessionsService = getStepChatSessions()
    if (sessionsService === undefined) return
    sessionsService.fork({ sessionId: sessionId as SessionId, atSeq: seq, increaseTitle: true })
      .then((childId) => { sessionsService.open(childId) })
      .catch(() => {
        // Fork 或子会话重命名失败保持原会话视图不动（DSH 同）。
      })
  }, [sessionId])

  // B3：turn-process 折叠展开态（轮次级本地状态）。rc.1 的
  // actions.setTurnProcessOpen（store 跨会话持久 + transcript 模式设置）在面板
  // 裁剪为「面板内只读展开/折叠、不跨会话持久」：同轮多行（披露头 + 成员行 +
  // 答复行）必须共享同一开关值，故状态提升到列层，StepChatViewRow 经 props
  // 读取/回写（行壳自身只按 key 计算折叠判定）。viewFeed 换会话时清空。
  const [processOpenTurns, setProcessOpenTurns] = useState<readonly number[]>([])
  useEffect(() => {
    setProcessOpenTurns([])
  }, [viewFeed])
  const handleProcessOpenChange = useCallback((turn: number, open: boolean) => {
    setProcessOpenTurns(current => open
      ? (current.includes(turn) ? current : [...current, turn])
      : current.filter(value => value !== turn))
  }, [])

  // ── 批 A（A3）：滚动契约变量发布 ───────────────────────────────────────────
  // 面板自己的滚动视口发布 DSH ConversationRoot 在滚动体上发布的同族变量
  // （只读参考 ui-conversation skeleton/ConversationRoot.tsx 的 seatResizeRef）：
  //   --dsh-composer-height                 面板**底部动作位**实测高度（无动作位 0px）
  //   --dsh-conversation-viewport-height    本滚动视口 clientHeight
  //   --dsh-chat-content-width              会话列宽（宿主未提供时的面板回退值）
  //   --dsh-composer-side-clearance         侧留白（DSH 默认 16px；已有值不覆盖）
  // 需求 1：面板不再内嵌输入框，底部动作位改由重试行（`data-step-chat-retry-seat`）
  // 占据——量它即「面板底部被占掉的高度」，变量名沿用 DSH 契约名（消费方在 DSH 侧）。
  // 为什么发在滚动器上：DSH 侧的一切「滚动归属 + 浮层避让」都以
  // `closest('[data-conversation-scroll]')` 找到的元素为坐标原点（ChatView 的
  // scrollerOf、InputBar 的 clearance），面板既然自己持滚动器就自己承担发布。
  //
  // 实现用**回调 ref + 两个 ref 的联动重挂**（不是 useLayoutEffect）：滚动容器在
  // loading/error 态不渲染（下面早返回的是占位 div），effect 首跑时 ref 仍为
  // null，之后不会再跑一次——回调 ref 则在节点挂载的那一刻就发布第一组值
  // （绘制前完成，无首帧跳变），卸载时清掉自己写过的键。
  //
  // 只清自己写过的键：宿主祖先已给的 --dsh-chat-content-width /
  // --dsh-composer-side-clearance 不属于本组件，删除会改坏会话页（也绝不覆盖
  // 已有值——只在「内联与继承皆无」时补面板默认值）。
  const scrollObserverRef = useRef<ResizeObserver | null>(null)
  const retrySeatRef = useRef<HTMLDivElement | null>(null)
  const [retrySeat, setRetrySeat] = useState<HTMLDivElement | null>(null)
  const publishScrollVarsRef = useRef<() => void>(() => {})
  publishScrollVarsRef.current = () => {
    const container = scrollContainerRef.current
    if (container === null) return
    const composerHeight = retrySeatRef.current?.offsetHeight ?? 0
    container.style.setProperty('--dsh-composer-height', `${String(composerHeight)}px`)
    container.style.setProperty(
      '--dsh-conversation-viewport-height',
      `${String(container.clientHeight)}px`,
    )
    const inherited = (name: string): boolean => container.style.getPropertyValue(name) !== ''
      || window.getComputedStyle(container).getPropertyValue(name).trim() !== ''
    // 宿主（会话页 .root）未提供列宽时，回退为面板消息列自己的 max-width 语义
    // （step-chat-panel.module.css 的 .stepChatColumn 同值）：百分比回退在这里
    // 无法用 var() 表达（var(--x, 100%) 里的百分比按消费属性解析，写进内联变量
    // 会在别的消费点变成另一层含义），故实测滚动视口内容宽。
    if (!inherited('--dsh-chat-content-width')) {
      const style = window.getComputedStyle(container)
      const inner = container.clientWidth
        - Number.parseFloat(style.paddingLeft)
        - Number.parseFloat(style.paddingRight)
      if (Number.isFinite(inner) && inner > 0) {
        container.style.setProperty('--dsh-chat-content-width', `${String(inner)}px`)
      }
    }
    // rc.1 的 clearance 由会话页 .root 声明为 16px 常量；面板作为独立树根
    // （可能在会话树之外）补同一个默认值。
    if (!inherited('--dsh-composer-side-clearance')) {
      container.style.setProperty('--dsh-composer-side-clearance', '16px')
    }
  }
  const scrollVarsRef = useCallback((container: HTMLDivElement | null): void => {
    const previous = scrollContainerRef.current
    scrollObserverRef.current?.disconnect()
    scrollObserverRef.current = null
    scrollContainerRef.current = container
    // 卸载/换节点：清掉本组件写过的实测键（宿主继承值本就没被写进内联）。
    const drop = previous ?? container
    if (drop !== null) {
      for (const name of SCROLL_VAR_KEYS) drop.style.removeProperty(name)
    }
    if (container === null) return
    publishScrollVarsRef.current()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { publishScrollVarsRef.current() })
    observer.observe(container) // 视口尺寸变化 → viewport-height 跟随
    const seat = retrySeatRef.current
    if (seat !== null) observer.observe(seat) // 底部动作位长高 → composer-height 跟随
    scrollObserverRef.current = observer
  }, [])
  const retryVarsRef = useCallback((seat: HTMLDivElement | null): void => {
    retrySeatRef.current = seat
    setRetrySeat(seat)
  }, [])
  // 底部动作位挂载/卸载 → 重挂 observer（观察新 seat）并立刻重发高度（挂载时 0 → 实测）。
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (container === null) return
    const observer = scrollObserverRef.current
    if (observer !== null && retrySeat !== null) observer.observe(retrySeat)
    publishScrollVarsRef.current()
  }, [retrySeat])

  // 历史图片加载器：session.readAttachment → blob/data URL，卸载释放。
  const imageLoader = useMemo(() => createImageLoader(session), [session])
  useEffect(() => () => { imageLoader.dispose() }, [imageLoader])
  const renderMessageImages = useCallback<SandoreRenderMessageImages>(
    owner => (
      <ImageGallery
        images={owner.images as readonly { attachment: SandoreImageAttachmentRef }[]}
        load={imageLoader.load}
        align={owner.align}
        labels={messageImageLabels(t)}
      />
    ),
    [imageLoader, t],
  )

  // ── B4a：右侧轮次轴（TurnNavigator）────────────────────────────────────
  // rail items：view 面 navigation.items()（loaded-only；过滤/排序/runMs 见
  // turn-rail.ts）。归一结果做恒等缓存：发布间内容未变（含纯流式帧）时复用旧
  // 数组——TurnNavigator 是 memo，items 引用稳定则刻度 DOM 不随帧重建
  // （rc.1 对 memoized rail 的同一要求）。无 viewFeed → 空轴。
  const [railItems, setRailItems] = useState<readonly StepChatTurnRailItem[]>(STEP_CHAT_EMPTY_RAIL_ITEMS)
  useEffect(() => {
    if (viewFeed === undefined || !useViewRows) {
      setRailItems(STEP_CHAT_EMPTY_RAIL_ITEMS)
      return
    }
    const candidate = stepChatRailItemsOf(viewFeed.navigationItems(), viewFeed.timeline())
    setRailItems(current => stepChatSameRailItems(current, candidate) ? current : candidate)
  }, [useViewRows, viewFeed, viewRead])

  // active 轮次（行级 state 放 StepChatBody；TurnNavigator 只消费）。采样/节流
  // 端口全部走 ref（效果只挂一次；每渲染刷新实现），语义对齐 rc.1 ChatView：
  // scroll 事件只登记 pending，500ms 后采样一次；scrollend/列尺寸变化立即补
  // 一次终样（几何变化没有 scroll 事件——流式内容改行高、图片加载等）。
  const [activeTurn, setActiveTurn] = useState<number | null>(null)
  const samplePendingRef = useRef(false)
  const sampleTimerRef = useRef<number | undefined>(undefined)
  const sampleActiveTurnRef = useRef<() => void>(() => {})
  const scheduleSampleRef = useRef<() => void>(() => {})
  const flushSampleRef = useRef<() => void>(() => {})
  sampleActiveTurnRef.current = () => {
    const container = scrollContainerRef.current
    if (container === null || !useViewRows || railItems.length === 0) {
      setActiveTurn(null)
      return
    }
    const next = stepChatSampleTurnAt(container, railItems)
    setActiveTurn(current => current === next ? current : next)
  }
  scheduleSampleRef.current = () => {
    if (samplePendingRef.current) return
    samplePendingRef.current = true
    sampleTimerRef.current ??= window.setTimeout(() => {
      sampleTimerRef.current = undefined
      samplePendingRef.current = false
      sampleActiveTurnRef.current()
    }, STEP_CHAT_SAMPLE_INTERVAL_MS)
  }
  flushSampleRef.current = () => {
    if (sampleTimerRef.current !== undefined) {
      window.clearTimeout(sampleTimerRef.current)
      sampleTimerRef.current = undefined
    }
    samplePendingRef.current = false
    sampleActiveTurnRef.current()
  }
  useEffect(() => {
    const container = scrollContainerRef.current
    const column = chatColumnRef.current
    if (container === null || column === null || !useViewRows) {
      setActiveTurn(null)
      return undefined
    }
    const schedule = (): void => { scheduleSampleRef.current() }
    const flush = (): void => { flushSampleRef.current() }
    container.addEventListener('scroll', schedule, { passive: true })
    container.addEventListener('scrollend', flush, { passive: true })
    // 行高/视口几何变化（流式追加、披露展开、图片加载）没有 scroll 事件：
    // 列与滚动视口都量，活动刻度随内容长高而跟随（rc.1 同款 ResizeObserver）。
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      observer.observe(container)
      observer.observe(column)
    }
    flushSampleRef.current()
    return () => {
      container.removeEventListener('scroll', schedule)
      container.removeEventListener('scrollend', flush)
      observer?.disconnect()
      if (sampleTimerRef.current !== undefined) {
        window.clearTimeout(sampleTimerRef.current)
        sampleTimerRef.current = undefined
      }
      samplePendingRef.current = false
    }
  }, [useViewRows, railItems])

  // 定位（rc.1 ChatView.navigateToTurn 的 loaded 分支 = landOnRow，B4a 面板内
  // 容器实现）：按锚点 key 找可见行；行 hidden="until-found"（折叠的进程成员行
  // 等）时先按 rc.1 语义处理——rc.1 的 anchorElement 只认可见行、锚点不可见即
  // 放弃，面板另加一步同轮次可见行回退（披露头/后续行仍可落点）；整轮无可见
  // 行才放弃（与 rc.1 行为一致，避免 removeAttribute 与进程折叠态打架）。
  const navigateToTurn = useCallback((item: StepChatTurnRailItem): void => {
    const container = scrollContainerRef.current
    if (container === null || item.anchor.kind !== 'loaded') return
    const row = stepChatAnchorRowIn(container, item.anchor.key)
      ?? stepChatTurnRowIn(container, item.turn)
    if (row === null) return
    stepChatScrollRowTo(container, row, STEP_CHAT_LANDING_CLEARANCE_PX)
    setActiveTurn(current => current === item.turn ? current : item.turn)
  }, [])

  if (snapshot.openState === 'cold' || snapshot.openState === 'loading') {
    return (
      <div className={css.stepChatPanel} {...anchorAttrs}>
        <div className={css.stepChatLoading}>{t('run.step.chat.loading')}</div>
        <StepChatPlaceholderRetry retry={retryPort} t={t} />
      </div>
    )
  }
  if (snapshot.openState === 'error') {
    // Round 25：error 占位附带 openError（code/message），便于现场锁定确切错误码；
    // 有界退避重试进行中时此处维持占位，恢复后自动切回对话流。重试耗尽后用户可
    // 点「查看会话」手动切到宿主子代理视图（承接原 !supported 分支的 onOpenSession）。
    const detail = formatOpenError(snapshot.openError)
    if (snapshot.openError?.code === 'session/agent-busy') {
      // 运行中子代理：open() 被 host 以 session/agent-busy 拒绝（turn 未 settle、
      // parent address 未 durable）——瞬态，显示 loading（非 error，避免 error
      // 闪烁）；重试由 settle effect（running→false 后自动重 open）与 Round 25
      // 退避共同承担。
      return (
        <div className={css.stepChatPanel} {...anchorAttrs}>
          <div className={css.stepChatLoading}>{t('run.step.chat.loading')}</div>
          <StepChatPlaceholderRetry retry={retryPort} t={t} />
        </div>
      )
    }
    return (
      <div className={css.stepChatPanel} {...anchorAttrs}>
        <div className={css.stepChatError}>{t('run.step.chat.error')}</div>
        {detail !== undefined && (
          <div className={css.stepChatErrorDetail} data-step-chat-error-detail>{detail}</div>
        )}
        <div className={css.stepChatEmptyActions}>
          <Button variant="outline" onClick={onOpenSession}>{t('run.step.chat.openSession')}</Button>
          {/* 批 A（A4）：官方原生出口——把宿主会话视图切到该子代理会话（openSubagent
              的 continuable 地址），在 DSH 自己的对话页里看完整消息流/继续输入。 */}
          <Button variant="outline" onClick={onOpenNative} data-step-chat-open-native>
            {t('run.step.chat.openNative')}
          </Button>
        </div>
        <StepChatPlaceholderRetry retry={retryPort} t={t} />
      </div>
    )
  }

  // Turn 级加载信号锚点：读 ChatSnapshot 的 timeline；缺失 → null 回退挂载时间。
  const chatTimeline = viewFeed === undefined ? null : (viewFeed.timeline() ?? null)
  const runningTurnStart = runningTurnStartTime(
    chatTimeline as ConversationTimelineSnapshot | null,
  )

  return (
    <div className={css.stepChatPanel} {...anchorAttrs}>
      {/* B1：面板内滚动视口（结构对齐 ChatView root>scroll>column；滚动语义与
          深浅色/字号跟随变量见 step-chat-panel.module.css 文件头注释）。
          B4a：首子节点 = 轮次轴槽位（zero-height sticky，浮在右缘，不占列），
          滚动采样/锚点定位都以本容器为滚动视口。
          批 A（A3）：挂 `data-conversation-scroll`（DSH 的滚动归属标记，属性名与
          官方 ConversationRoot.scrollBody 完全一致）。**只有这张卡片自己的滚动器
          可以带它**——外层 RunView 的消息滚动区（RunView.module.css 的
          .feedScroll）与 UnifiedTimeline 的任何滚动元素都**不得**标此属性：DSH 用
          `closest('[data-conversation-scroll]')` 反查坐标原点（ChatView.scrollerOf /
          InputBar.clearance），多个或错误的宿主会夺走滚动归属。scrollVarsRef 在
          该节点上发布 4 个滚动契约变量（见 publishScrollVarsRef 注释）。 */}
      <div ref={scrollVarsRef} className={viewCss.stepChatScroll} data-conversation-scroll="">
        {/* B4a：右侧轮次轴。loaded-only rail；单轮（items<2）只挂零高槽位不画
              刻度；无 view 行时 items 恒空 → 同。activeTurn 由滚动采样维护。
              **需求修正（真机）**：discussion（variant=main）里**不再**渲染这条「每轮」
              刻度——用户要求 discussion 的轮次条改成「每 step 一档」
              （见 step-view/StepRail.tsx，挂在运行视图的消息列上）；
              step 子代理面板（variant=subagent）保持既有行为不变。 */}
        {variant !== 'main' && (
          <TurnNavigator
            items={railItems}
            activeTurn={activeTurn}
            onNavigate={navigateToTurn}
            t={t}
          />
        )}
        <div ref={chatColumnRef} className={viewCss.stepChatColumn} data-chat-flow="">
          {/* 批 A（A1）：更早历史分页（rc.1 ChatView 的 .older 行：居中胶囊按钮）。
              hasMore 才出现；loadingOlder 中 disabled（文案切加载中）。
              批 A2：自动补齐进行中时该行换成同一位置的轻量提示（按钮此时本就
              disabled，且自动补齐正连续投递）——补齐结束（hasMore=false / 上限 /
              失败 / 门关闭）后提示消失，手动按钮交回用户继续逐页续看。 */}
          {pagingState.hasMore && (
            autofillActive ? (
              <div
                className={viewCss.stepChatOlder}
                data-step-chat-autofill=""
                role="status"
                aria-live="polite"
              >
                <span className={viewCss.stepChatAutofillHint}>
                  {t('run.step.chat.paging.autofill')}
                </span>
              </div>
            ) : (
              <div className={viewCss.stepChatOlder}>
                <button
                  type="button"
                  disabled={pagingState.loadingOlder}
                  data-step-chat-load-older
                  onClick={handleLoadOlderClick}
                >
                  {loadOlderLabel}
                </button>
              </div>
            )
          )}
          {useViewRows ? (
            viewRead!.order.map((nodeKey) => (
              <StepChatViewRow
                key={nodeKey}
                feed={viewFeed!}
                nodeKey={nodeKey}
                t={t}
                renderMessageImages={renderMessageImages}
                cwd={cwd}
                onOpenFile={requestOpenFile}
                onFork={forkAt}
                processOpenTurns={processOpenTurns}
                onProcessOpenChange={handleProcessOpenChange}
                historyIncomplete={pagingState.hasMore}
                instanceId={instanceId}
              />
            ))
          ) : (
            <div className={css.stepChatEmpty}>{t('run.step.chat.empty')}</div>
          )}
          {/* Turn 级加载信号（与 ChatView 一致：整轮运行期间不闪烁）。 */}
          {snapshot.running && <TurnStatus startTime={runningTurnStart} t={t} />}
        </div>
      </div>
      {/* 面板底部动作位（滚动容器外）。**需求 1 起这里不再有输入框**：面板内嵌的
          ComposerBar（含 `@` 触发菜单、排队提示、发送错误行）已整块移除，其挂载点
          与接线 props（composerSend / composerBinding / hostSessionId）不复存在。
          当前占据该位的只有 failed 段的**重试行**（仅当 `retryPort` 可见时渲染：
          可见性判定 = step-view/step-retry.ts 的 stepRetryVisible，在早返回之前
          收窄一次，占位分支的 `StepChatPlaceholderRetry` 共用同一份值——两态互斥，
          重试行不会同时出现两份）。重试 message 是固定默认串（面板没有草稿，
          见 step-view/StepRetryRow.tsx 头注释）。
          批 A（A3）滚动契约：本 seat 的实测高度经 retryVarsRef 上报为
          `--dsh-composer-height`（官方 ConversationRoot 的 data-composer-seat 同
          职责；无动作位时该变量为 0px）。 */}
      {retryPort !== undefined && (
        <div ref={retryVarsRef} data-step-chat-retry-seat>
          <StepRetryRow port={retryPort} t={t} />
        </div>
      )}
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          path={fileOpenError.path}
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** 宿主拒绝打开路径时的页内对话框（抄自 ChatView 的 FileOpenErrorDialog）。 */
function FileOpenErrorDialog({ path, message, busy, onClose, onRetry, t }: {
  path: string
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: TranslateNS<'sandore'>
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t(isFolderOpenPath(path) ? 'fileOpen.folderTitle' : 'fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={viewCss.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={viewCss.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}
