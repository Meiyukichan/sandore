/**
 * 主代理会话内的「工作流」tab（DSH 原生会话视图席位 `conversation.view`）。
 *
 * ## 挂载点与理由（为什么是这条槽）
 * 用户在**主代理会话页**要一个 tab。DSH 的会话页（中心列）里，tab 条就是
 * `ui-conversation` 的 `conversation.session.header` 渲染的
 * `[role="tablist"]`（`ConversationSessionHeader`，`tabs.length > 1` 才出现），
 * 而每个 tab 的内容由 **`conversation.view` 这个 per-session list 槽**提供
 * （`ConversationSession`：`renderSlot('conversation.view', owner, { only: active.id })`）。
 * 也就是说：**DSH 自己就已经有「会话 tab」形态**，我们只需要往 `conversation.view`
 * 注册一条就能拿到与 Chat/Trajectory **完全一致**的 tab 视觉（同一份 CSS Module 的
 * `.tab/.tabActive`，含 2px 下划线激活条），并且天然按会话切换、天然出现在
 * **主代理会话页**（不是侧栏、不是我们自己的 overlay）。
 *
 * 走 DSH 槽而不是继续自挂载的原因：自挂载（`view-seat.tsx` 那条）是「中心列尾子容器 +
 * 全局 CSS 隐藏会话列」的整体替换，**没有 tab 语义**，也没法只占用会话页的一小部分；
 * 而用户要的正是「会话页里的一个 tab」（会话内容切回来必须还在）。
 * `<ConversationSession>` 按激活视图渲染，切回 Chat 时我们的面板整棵卸载、会话内容原样恢复。
 *
 * ## 内容 = 侧栏那套工作流页面本体（**同一份组件，不复制、不裁剪**）
 * 面板体直接渲染 {@link WorkflowOverlay}——与「侧边栏点开工作流」得到的是**同一个组件**：
 * 左栏列表（标题/收起、实例↔编排模式切换、搜索框、「运行工作流」/「新增定义」按钮、
 * 实例列表 ↔ 定义列表 ↔ 库列表）、拖动列宽、右栏编辑器/执行视图，全部照旧。用户口径：
 * 「tab 的内容必须几乎完全等于侧边栏点开得到的那个页面，交互入口都要在」。
 *
 * 两个宿主只差**三个参数**（全部是 `WorkflowOverlayProps`）：
 * 1. `alwaysVisible`：tab 常驻（不受 `workflow-store.open` 影响；那份 store 与侧栏共享，
 *    照读 open 会让「关掉侧栏」把 tab 里的页面一起变成 null）；
 * 2. `hostFilter = 本会话 id`：实例列表**只列绑定到本会话的实例**（硬约束：不得列出别的
 *    会话的实例；过滤在 `InstanceList` 的**数据层**做，别的会话的实例根本不进组件树），
 *    右栏执行视图也只渲染属于本会话的实例；
 * 3. `showDiscussionInput = false`：不渲染运行视图底部的讨论输入面（该 tab 里不得出现
 *    讨论输入框/主代理输入框）。
 *
 * ## DOM 锚点（e2e/单测）
 * 面板根 `[data-sandore-tab-panel="workflow"]` + `[data-sandore-tab-session]`（宿主会话 id）；
 * 面板内部沿用页面本体的既有锚点（`[data-sandore-wf-view]` / `[data-sandore-wf-list]` /
 * `[data-sandore-wf-editor]` / `[data-sandore-run-view]` …）。
 * 本面板**不产出** `[data-main-agent-input]` / `[data-sandore-disc-input]` /
 * `[data-composer-input]` 任何一个输入锚点（`showDiscussionInput=false`）。
 * tab 按钮本身由 DSH 渲染（`role="tab"`，标签文本 = 本插件字典的 `tab.workflow`），
 * **不**由本文件产出锚点：那是 DSH 的 DOM，禁止改 DSH 源码；e2e 按 `role=tab` +
 * 可访问名定位（见 m22）。
 * @module @deepseek-ai/dsh-client-ui-sandore/src/client/main-agent-workflow-tab
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 槽名/槽 props 的类型增强（'conversation.view' 与 SessionStandardProps.sessionId）
// 随该包的类型入口生效；下面 register 的 options/component 形状由它校验。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

import { NS } from './locales.ts'
import { WorkflowOverlay } from './WorkflowOverlay.tsx'
import css from './main-agent-workflow-tab.module.css'

/**
 * 本 tab 在 DSH `conversation.view` 槽里的条目 id（也是 tab 的稳定标识；
 * 与 ui-chat 的 `chat`、ui-trajectory 的 `trajectory` 互异，不覆盖任何既有 tab）。
 */
export const WORKFLOW_VIEW_ID = 'sandore-workflow'

/** 本 tab 面板根的稳定 data 锚点选择器（e2e 用）。 */
export const WORKFLOW_TAB_PANEL_SELECTOR = '[data-sandore-tab-panel="workflow"]'

/** 注册进 `conversation.view` 的组件 props（strict session 槽 ⇒ 一定有 `sessionId`）。 */
export interface SandoreWorkflowTabProps {
  /** 当前会话 id（框架按 scope='session' 注入）；DSH 的 instanceId 恒等于它。 */
  sessionId: string
}

/**
 * 「工作流」tab 面板：渲染**侧栏那套工作流页面本体**，按本会话过滤实例、不带讨论输入面。
 *
 * face / locale / workspaces 全部经 `seat-bridge` 读取（`WorkflowOverlay` 自己读）——
 * 与侧栏席位同一条桥、同一份 face、同一份 `workflow-store`，因此两个宿主看到的是同一份
 * 页面状态与同一路刷新信号（这是「几乎完全等于侧栏那个页面」的直接后果）。
 * @param props - 框架注入的会话身份（见 {@link SandoreWorkflowTabProps}）。
 * @returns 面板（face 未就绪时页面本体自身渲染 null——装配顺序上不会发生，防御即可）。
 */
export function SandoreWorkflowTab({ sessionId }: SandoreWorkflowTabProps) {
  return (
    <div
      className={css.panel}
      data-sandore-tab-panel="workflow"
      data-sandore-tab-session={sessionId}
      // 铺满语义标记（**照 DSH 轨迹 tab**）：`ui-conversation` 的 ConversationRoot 用
      // `:has([data-conversation-composer-overlay])` 切到「视图自持滚动」的版式——
      // `.scrollBody` 不再保留滚动条槽、`.viewArea` 变 `flex:1 1 0 / overflow:hidden`，
      // 并隐藏会话列两侧的**宽度拖拽条**（`.root:has(...) .widthHandle { display:none }`，
      // 见 `ui-conversation/src/client/skeleton/ConversationRoot.module.css:275-277,376-411`）。
      // 没有这个标记时，本 tab 会带上 Chat 那一族的列宽拖拽手柄（用户真机看到的
      // 「左右拉伸」入口），轨迹 tab 则没有 —— 这是两个 tab 版式不一致的根因。
      // 值不重要（空标记），与 `TrajectoryView` 的 `data-conversation-composer-overlay=""` 同款。
      data-conversation-composer-overlay=""
    >
      <WorkflowOverlay
        // key 随会话变化：换会话时页面整棵重挂（避免上一个会话的临时 UI 状态
        // 短暂串到新会话的 tab 里）。
        key={sessionId}
        alwaysVisible
        hostFilter={sessionId}
        showDiscussionInput={false}
      />
    </div>
  )
}

/**
 * 把「工作流」tab 注册进 DSH 的 `conversation.view` 槽（会话 header 的 tab 条）。
 *
 * 走 `slots.inject` + `slots.register`（与 `orchestration-tool-view.tsx`、ui-trajectory
 * 同一写法）：槽由 ui-conversation 声明，未装配时回调不执行（不报错）；返回的 disposer
 * 随插件 fiber 卸载一起撤下（tab 消失，会话页回到单一 Chat 视图）。
 *
 * 标签经 `label` thunk 读 `ctx.locale.bind(NS)`：注册期文本随当前语言解析，
 * 切语言后 `refreshViews`（监听 locale 的既有实现）会重读并刷新 tab 文本，无需重新注册。
 * @param ctx - 本插件的 client ctx（必须已 inject `slots` 与 `locale`）。
 */
export function registerMainAgentWorkflowTab(ctx: ClientContext): void {
  const label = (): string => ctx.locale.bind(NS)('tab.workflow')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: WORKFLOW_VIEW_ID,
    // 排在 Chat（order 0）与 Trajectory（order 10）之后：主代理会话的 tab 条里
    // 「对话 | 轨迹 | 工作流」——工作流是附加视图，不抢首位。
    order: 20,
    label,
  }, SandoreWorkflowTab))
}
