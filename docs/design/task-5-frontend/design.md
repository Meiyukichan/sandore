# Task 5 前端 + 固化 — 设计文档

> 本文档从 `docs/engine/dsh-workflow.md` 与 `docs/engine/dynamic-workflow-engine.md` 中提取与 Task 5「前端 + 固化」相关的全部内容，重新组织为一份自包含的设计文档。
> 
> **来源文档**：
> - `dsh-workflow.md` — DSH 插件化设计（§6 Client 端设计、§7 数据流与 RPC、§8 挂载与集成）
> - `dynamic-workflow-engine.md` — 引擎 v2.6 技术设计（§12 chat.json 增量讨论数据、§22 后端服务层、§23 前端架构）

---

## 本文档范围

本文档定义 Task 5 的完整实现范围：**前端 UI + 固化**。具体包含：

| 模块 | 说明 |
|------|------|
| **WorkflowList** | 工作流定义/Job/实例列表 CRUD |
| **DagEditor** | DAG 编排器 + YAML 预览 |
| **RunView** | 执行轨迹 + 多 session 组合讨论时间线 + 产物 + 交互控件 |
| **挂载固化** | `cordis.yml` 静态组合 |
| **测试与文档** | 验证标准：完整 UI 可用（列表→编排→执行→讨论→交互），插件随 `cordis.yml` 稳定加载 |

---

## 1. 整体 UI 结构

### 1.1 入口：sidebar.footer.action 按钮 + 展开 WorkflowPanel（仿 workspace 风格）

> **经探索确认的硬约束**：sidebar 子 slot 由 `ui-sidebar` 声明并渲染，"声明即独占"，**插件无法新增 `sidebar.workflows` 常驻分组**（需改 ui-sidebar 源码，违反「纯插件」约束）。工作流管理 UI 入口 = **`sidebar.footer.action` 按钮 + 点击展开面板**，该 slot 位于设置按钮上方（`SidebarRoot.tsx:181` "Footer actions stack above Settings"），参考 `ui-cordis` 的 footer 按钮 + 展开 CordisPanel 先例。

```
sidebar（footArea，设置上方）
└── [工作流 按钮]（sidebar.footer.action）★
        └── 点击展开 WorkflowPanel（仿 workspace 风格，ui-primitives 自绘）
            ├── header：搜索图标 | 「编排」toggle + 「新增」按钮
            ├── 默认态（编排 off）：工作流实例列表（按工作区分组）
            ├── 编排态（编排 on）：工作流定义列表 → 点定义进 DagEditor
            └── 新增：默认态→新增实例；编排态→新增定义
```

**风格参考**：完全仿 `ui-workspace` 的 WorkspaceBrowser 观感（header 搜索+操作按钮 + 分组/平铺列表）。workspace 的 header 组件与分组逻辑包内私有不可 import，工作流用 `@deepseek-ai/dsh-client-ui-primitives` 自绘同款观感；`useSessions`/`useWorkspaces` 是框架全局 hook，用于「实例 → 父 session → workspace」分组映射（分组依据 = `workspace.sessionIds` 显式成员表，非 cwd）。

**DagEditor / RunView 承载（两级下钻 + 宽展开，D6 自包含原则的自然延伸）**：
- sidebar 展开面板宽约 260-300px，承载结构化编辑器（DagEditor）和执行详情（RunView）偏窄。WorkflowPanel 采用**两级下钻**：列表态（窄 rail，仅三态列表）↔ 编辑/执行态（**宽展开 layer**，参考 `ui-cordis` 的 `CordisPanel` `wide ? css.layer : css.rail` 形态）。
- 点定义 → 下钻到 DagEditor（宽展开）；点实例 → 下钻到 RunView（宽展开）；返回按钮回到列表态。全程面板自包含 client 状态（`open` + `view` 栈），零新增 slot 注册。
- **不选 `conversation.view` tab**（session-maybe scope，与「管理 UI 应全局」的 D6 理由有张力）；**不选 `shell.overlay`**（modal 全帧浮层，与「融入 DSH web」的嵌入式风格有偏差）。

### 1.2 Slot 注册

`ui` 的 Client 插件 `apply(ctx)` 注册：

```ts
export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui: dict')

  // 1) 工作流入口按钮（sidebar.footer.action，位置在设置上面）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sandore-btn',
    locale: NS,
    inject: () => ({
      hooks: { open: createPanelStore() },   // 面板开关状态（自包含）
    }),
  }, WorkflowButton))  // 点击展开 WorkflowPanel

  // 2) 讨论面板的 sandore-step 节点（conversation.chat.node keyed，见 §5.3）
  //    （在宿主 Session 的 chat 视图里渲染，非管理 UI 内）
}
```

> **决策 D6（工作流管理 UI 入口，经探索收敛）**：入口是 **`sidebar.footer.action` 按钮 + 点击展开仿 workspace 风格的 WorkflowPanel**（设置上方）。纯插件约束下放弃了「常驻 sidebar 分组」（需改 ui-sidebar）；也放弃了「conversation.view tab 为主入口」（管理 UI 应全局、贴近侧栏导航）；完整交互（编排/新增/三态/分组）在展开面板内实现；无跨 scope 联动难点（面板开关是插件自有 client 状态，参考 ui-cordis）。

### 1.3 DSH Slot 结构参考

DSH 前端是**三栏布局**（`packages/client/ui-layout`），顶级 slot 由 `ui-layout` 在 `root` 上声明：

```
root
├── sidebar            (single, root scope)   —— 整条左栏，被 ui-sidebar 占据
│   ├── sidebar.workspaces  (single)          —— 工作区/会话浏览
│   ├── sidebar.settings    (single)          —— 底部设置位
│   └── sidebar.footer.action (list)          —— 设置上方的附加动作位（工作流入口）★
├── conversation       (single, session-maybe)—— 整条中栏，被 ui-conversation 占据
│   └── conversation.session (single, session) —— 会话体
│       └── conversation.chat.node (keyed)     —— 消息节点（sandore-step 讨论节点）★
├── details            (single, session scope) —— 右栏
└── shell.overlay      (list, root scope)     —— 全帧浮层
```

> 注：`sidebar.footer.action` 位于 foot 区域、**settings 上方**（`SidebarRoot.tsx` footArea 里 footerActions 在 settingsArea 之上）。工作流入口用它；讨论面板（sandore-step 节点）用 `conversation.chat.node`（keyed，仿 `ui-workflow-run`），两者分离。

与本需求直接相关的两个 slot：

1. **`sidebar.footer.action`**（list，root scope）：设置上方的附加动作位，**可加性（additive）**——注册 `id: 'sandore-btn'` 即在工作流按钮（设置上面）。这就是「工作流入口」落点。
2. **`conversation.chat.node`**（keyed，session scope）：消息流里的节点渲染——`sandore-step` 讨论节点注册 `key: 'sandore-step'`（仿 `ui-workflow-run` 的 `key: 'workflow-run'`）。

> 参考实现：`packages/extensions/ui-cordis`（`sidebar.footer.action` 按钮 + 展开 CordisPanel）、`packages/client/ui-workflow-run`（`conversation.chat.node` keyed 渲染）。

---

## 2. 前端技术栈与风格一致性

> **决策 D7（前端复用 DSH 组件与设计语言）**：工作流 UI 是 DSH Web 的一个视图，必须**视觉与交互上融入 DSH web**——复用 DSH 已有的组件基元、theme token、locale、消息渲染、交互卡片，不自建平行的设计语言或 UI 库。

| 项 | 选择 | 说明 |
|---|---|---|
| 框架 | React（DSH client 统一） | 与 DSH 前端一致 |
| 组件基元 | `packages/client/ui-primitives`（按钮/输入/列表/对话框/徽章等） | 复用，不引第三方 UI 库 |
| 样式 | DSH theme token（`ctx.theme` + `styles.insert`，CSS 变量） | 与 DSH web 同主题、明暗色自适应 |
| i18n | `ctx.locale`（zh/en，与 DSH 统一） | 复用 DSH 的 locale 服务 |
| 消息/讨论渲染 | 复用 `ui-conversation` 的消息渲染 + `conversation.chat.node` 节点定义（参考 `ui-workflow-run`） | 见 §4 |
| 交互卡片 | 复用 DSH 问答/权限 UI（`ui-user-questions` / 权限卡片） | 不重造 Question/Permission 卡片 |
| 工具调用展示 | 复用 `ui-tool` 的工具卡片（`tool.call.toolview`） | Step 内工具调用可视化 |
| 数据获取 | `host.call()` RPC + DSH 事件订阅 | 不用独立 axios/fetch |
| DAG 可视化 | 先简化（ui-primitives），React Flow 作为后续增强 | 见下注 |

> **关于 React Flow**：原 sandore 前端用 React Flow + Dagre。DSH 前端依赖里**未必包含 React Flow**。首推**先用 ui-primitives 实现简化版 DAG 视图**（节点列表 + 连线示意），避免引入新的重依赖；确需完整 DAG 编辑体验时再评估引入 React Flow 的代价。

> 补充：以下是原 sandore 前端（`dynamic-workflow-engine.md §23`）的技术栈，作为语义参考：

```
React 19.1 + Vite 6.4 + TypeScript 5.7
Tailwind CSS 4.3 + i18next 25.2 + react-i18next 15.5
@xyflow/react (React Flow v12) + @dagrejs/dagre — DAG 可视化编辑器
react-syntax-highlighter — 代码高亮
CodeMirror 6 — YAML 预览
react-markdown + remark-gfm + remark-breaks — Markdown 渲染
react-resizable-panels — 可拖拽双面板布局
lucide-react — 图标库
zod 4 — Schema 验证（前端 workflowTypes.ts 与后端共享类型）
```

---

## 3. WorkflowList（列表态）

### 3.1 职责

工作流定义列表 + Job 列表 + 实例列表的 CRUD 入口。

### 3.2 原 sandore 前端参考（`dynamic-workflow-engine.md §23.3.2`）

原 sandore 的 `WorkflowLabSidebar` 包含两个标签页：

- **工作流标签**：CRUD + DAG 编辑入口
- **作业标签**：创建 Job → 执行（`POST /instances`）→ 展开实例列表
- **实例列表**：每 3s 轮询实例状态 + 待处理交互

在 DSH 中，这些能力统一集成到 `WorkflowList` 组件中：

```
WorkflowList
├── 工作流定义列表
│   ├── 新建/导入/删除
│   └── 点击 → 进入 DagEditor（编排态）
├── Job 列表
│   ├── CRUD（createJob / getJob / updateJob / deleteJob）
│   └── 展开实例列表
└── 实例列表
    ├── 轮询实例状态
    ├── 待处理交互提示
    └── 点击 → 进入 RunView（执行态）
```

---

## 4. DagEditor（编排态）

### 4.1 职责

Stage DAG 可视化编辑 + Step 编辑 + YAML 预览。

### 4.2 原 sandore 前端参考（`dynamic-workflow-engine.md §23.3.3`）

原 sandore 的 `WorkflowDagEditor` 基于 React Flow + Dagre 自动布局的**两层钻取**编辑器：

1. **Stage DAG**：顶层视图，Stage 节点 + 有向边
2. **Step DAG**：点击 Stage 进入，Step 节点 + 分支/循环边

**验证**：
- `hasDagCycle()` — Kahn 算法循环检测
- `hasParallelStages()` — 执行阶段串行规则
- `findCycleSources()` — DFS 着色找反向边

保存流程：DAG 状态 → `dagStateToYaml()` → `PUT /defines/:id/yaml`

### 4.3 DSH 中的实现

在 DSH 中，DagEditor 作为 `WorkflowView` 的编排态渲染：

```
DagEditor
├── Stage DAG 可视化
│   ├── 简化实现：ui-primitives 节点列表 + 连线示意
│   └── 增强实现（后续）：React Flow + Dagre 自动布局
├── Step 编辑
│   ├── 命令类型（prompt/shell/agent/skill/mcp）
│   ├── 输入/输出映射（inputFrom/outputTo）
│   ├── 透传变量（passThroughVars）
│   └── 门禁配置（gates）
└── YAML 预览 + 保存
    └── host.call('sandore.updateYaml')
```

---

## 5. RunView（执行态）

### 5.1 职责

执行轨迹 + 讨论面板（`sandore-step` Chat 节点，复用 `ui-workflow-run`）+ 产物面板 + 交互控件。

### 5.2 RunView 结构

```
RunView
├── 头部：实例状态 + 「打开讨论」按钮（★ 经探索补：ctx.sessions.open(hostSessionId) 跳到宿主会话）
│         —— 讨论面板（sandore-step 节点）渲染在「宿主 Session 的 chat 视图」里，不在管理 UI 内
├── 执行轨迹（WorkflowReadOnlyPipeline）
│   ├── executedSteps[] + stageInfos[] 只读视图
│   ├── ReadOnlyStep：状态图标 + 步骤名称 + 访问计数徽章 + 待处理交互按钮
│   └── FlatExecutionPipeline：按 stageInfos 分组，Stage 间 V 形箭头
├── 产物面板（WorkflowArtifactPanel）
│   └── GET /artifacts，5s 轮询（运行中时）
└── 交互控件
    ├── 暂停/恢复/重试
    ├── 问答回复（QuestionCard / PermissionCard）
```

> **讨论面板的导航（经探索确认）**：讨论面板（`sandore-step` 节点）渲染在**宿主 Session 的 chat 视图**（`conversation.chat.node` keyed 渲染），而管理 UI 的 RunView 在 `conversation.view` tab 里。两者是不同位置：
> - **宿主 Session 会自动出现在侧边栏**（非 subagent origin 的 `agents.create` 会话不过滤；引擎建宿主时 `meta.cwd` 必填，否则重启后冷会话从列表消失）。
> - RunView 头部放「打开讨论」按钮 → `ctx.sessions.open(hostSessionId)`（`ui-workflow-run` 的 `openSession` 同款）。
> - 用户也可直接在侧边栏点击宿主会话（标题 = `工作流实例 xxx`，由 `sessionTitle.rename` 设置）。

> **宿主会话标题补设（Task 5 host 侧最小增量，探索确认）**：`ctx.sessionTitle.rename(session, title)` 是 DSH 现成服务（`SessionTitleService`，`rename` 产生 `source: { kind: 'user' }` 的用户标题，优先于默认 fallback 自动摘要）。当前引擎建宿主 Session 时未设置，Task 5 补：`workflow` 包 `inject` 加 `sessionTitle`，创建宿主 Session 后 `ctx.sessionTitle.rename(handle.session, \`工作流实例 ${instanceId}\`)`，让侧边栏一眼辨识「这是哪个工作流实例的宿主会话」，而非「首条消息自动摘要」。
    └── 终态消息路由（默认会话 / @mention 重试）
```

### 5.3 讨论面板：复用 ui-workflow-run 的 Chat 节点机制（关键）

> **决策 D8（最终版，经探索 DSH 源码确认）**：DSH 的对话消息组件**不可跨插件 import**（`ui-conversation` 消息组件全部 package-internal），但 DSH 提供官方「多子代理组合」范本 `ui-workflow-run`（`packages/client/ui-workflow-run/`）——它通过 `ConversationNodeDefinition` + `conversation.chat.node` keyed slot 把多个子代理 run 折叠成主对话里的节点，**这套机制与主对话页面完全一致，直接复用**。因此工作流的讨论面板**不是自定义 UI**，而是让每个 Step 成为主对话消息流里的一个 `sandore-step` Chat 节点。

#### 5.3.1 复用机制（照抄 ui-workflow-run 三件套）

```
① ConversationNodeDefinition（kind='sandore-step', target='chat'）
   ├── match: sandore/step-start | step-completed | step-failed | ... 事件
   ├── start/update: 折叠 { stepId, childId, name, status, loopIteration }
   ├── buildViewNode: 返回 ChatConversationViewNode（data 含 childId）
   └── declare module 扩展 ChatNodeDataMap { 'sandore-step': DagStepChatData }

② conversation.chat.node keyed 渲染器（key='sandore-step'）
   ├── inject: (sessionId) => ({ getChildSession(id), openSession(id) })
   └── 渲染 DagStepNodeView

③ 内联消息：primitives 自绘（照抄薄胶水）
   ├── MarkdownText / MessageText（@deepseek-ai/dsh-client-ui-primitives，可 import）
   ├── 照抄 AssistantMarkdown.tsx(~110行) / UserStyleBubble(~100行) / ToolCallTree(~105行)
   └── 结果来源（经探索修正）：引擎在 append `sandore/step-completed` 事件时把「子代理最终结果」
        （宿主侧 `ctx.sessions.get(childId)` + `finalAssistantOutput(childSession.events)`）塞进事件 payload
        → renderer 直接从 `sandore-step` 节点 state 取结果，绕开跨会话读 snapshot
        （客户端 `binding(childId)` 需子会话窗口 open，不可靠）
```

#### 5.3.2 Step 节点渲染规则

```
主对话消息流（宿主 Session，完全复用 DSH 消息 UI 的节点体系）
├── [sandore-step 节点 A] ── 状态徽章 + 名称 + 内联「最后结果消息」（primitives 自绘）
│       ├── 执行中：running 状态，无结果消息
│       ├── 完成：内联该 Step 子会话最后一条 assistant 结果消息（returnPrompt）
│       ├── 失败：红色边框 + errorDetail
│       └── 暂停：琥珀色边框 + 会话快照
├── [用户消息]（右对齐气泡，DSH 原生渲染）
├── [sandore-step 节点 B] ── 内联最后结果消息
└── ...
```

#### 5.3.3 点击跳转子对话页 + 生命周期控件（复用 DSH 原生）

- 点击 Step 节点 → `ctx.sessions.open(childId)`，跳到该 Step 子代理 Session 的完整对话页（DSH 默认 UI）。
- 子对话页 composer **自动**提供生命周期控件（DSH 原生，零工作流插件代码）：
  - **暂停**：`interruptible = running && continuable` → 独立 Stop 按钮 → `subagent.interrupt`
  - **继续**：Send → `subagent.prompt`（follow-up 加入子代理 FIFO inbox）
  - **fork 重试**：TurnTail onBranch → `forkAt(seq)`
- continue / revert 两种重试模式需在 Step 节点补「重试」按钮（映射 `sandore_retryStep`）。

#### 5.3.4 关于 @xxx（重要差异）

原 sandore 的「`@Step` → 定向恢复/重试」**不能复用 DSH 的 @ 源**——DSH 的 `@` 提及源（`ctx.inputTriggers`）是**故意惰性**的：只插入字面 `@label ` 文本，**不解析成 continuation 地址**（`ui-subagent` README 明确声明）。复用 DSH 后该交互被更自然的原生交互取代：**进入 Step 子对话页 Send**（即「指定会话发送消息继续」）。若仍需「主对话内 @Step 路由」，需自行扩展 `ctx.inputTriggers` 实现 mention 源，但**首推前者**（零新增机制）。

#### 5.3.5 问答 / 审批复用

| 交互 | 复用 | 自绘 |
|---|---|---|
| 问答（askUserQuestion） | `PendingQuestion`（`ui-user-questions` 已导出）+ `PendingWait<'question'>` | QuestionFlow 卡片 ~100 行（照抄 QuestionComposer） |
| 权限/审批 | `PendingWait<'approval'>` 载体 + 应答编码 | Approval 卡片 ~50 行（照抄 ApprovalPanel） |
| 权限模式 | DSH permission presets（**子代理继承父级**） | 无 |

#### 5.3.6 原 sandore 讨论面板参考（`dynamic-workflow-engine.md §23.3.5`，仅作语义对照）

原 sandore 的 `WorkflowDiscussionPanel` 是 `chat.json` 的主要消费者，GitHub 评论卡风格（Step 消息/用户消息/暂停/失败/@提及/重试三模式选择器）。**迁移到 DSH 后这些自定义 UI 全部被「sandore-step 节点 + DSH 原生消息 UI + 子对话页 composer + PendingWait 交互」取代**，本小节仅保留作语义对照，不再自建讨论面板。

- **Step 消息**：Agent 头像 + 名称 + 状态徽章 + 循环标签 (#1.2) → 迁移为 `sandore-step` 节点 + primitives 自绘
- **@提及系统**（@Step 定向恢复/广播恢复/重试）→ 迁移为「主代理编排器工具」（见 task-4 §2.9）+「子对话页 Send」
- **内联交互**（QuestionCard/PermissionCard）→ 迁移为 `PendingQuestion`/`PendingWait` 载体 + 自写薄卡片

**数据获取**：不再有独立的 discussion API，改为「宿主 Session 的 `sandore/*` Session 事件 → `sandore-step` 节点折叠」，子代理最终结果已在 `step-completed` 事件 payload 中（引擎 append 时用 `finalAssistantOutput` 填充），renderer 直接从 `sandore-step` 节点 state 取；实时性由 apiproxy SSE `session/event` 帧驱动，去重由 ConversationNodeDefinition 的事件折叠天然保证。

### 5.4 讨论面板数据源：chat.json 结构（原 v2.6 语义，DSH 里由 Session 事件承载）

> 以下内容提取自 `dynamic-workflow-engine.md §12`，作为讨论面板数据源的语义参考。**⚠️ DSH 迁移后，`chat.json` 文件由宿主 Session 的事件日志（`sandore/*` Session 事件 + `ctx.sessionPersistence`）取代**，本节仅作 ChatState 数据结构模型参考。

#### 5.4.1 设计理念

`chat.json` 是面向前端的增量讨论数据，与 `work.json` 的全量覆盖模式不同，采用**追加式**写入：

- 新 Step 出现 → 追加消息
- 已有 Step 状态更新 → 就地合并
- 暂停 → 重命名消息 ID（添加后缀）
- 恢复 → 追加新消息

#### 5.4.2 数据结构

```typescript
ChatState {
  taskId, jobId, workflowId, cwd, status, originalInput
  messages[]: ChatMessage
  pendingInteractions[]
  createdAt, updatedAt
}

ChatMessage {
  id: string               // step-{uuid} 或 usr-{uuid}
  type: 'step' | 'user'
  data: ChatStepData | ChatUserData
  createdAt, updatedAt
}

ChatStepData {
  name, status, returnPrompt, sessionId, stageId, stageName
  loopIteration?: number[]   // 嵌套循环路径 [1, 2] = 第1次循环第2次迭代
  finalizeMeta?, branchMeta?, loopMeta?
  pausedAt?, resumedAt?, resumePrompt?, sessionMessages?
}

ChatUserData {
  at: string               // @stepId 路由目标（空=全局）
  domain: string            // 消息域
  content: string
}
```

#### 5.4.3 同步机制 — syncChatState

`syncChatState(workState, jobId)` 从 `work.json` 增量同步到 `chat.json`：

1. 加载现有 `chat.json` 或创建新的
2. 确保原始输入消息存在
3. 从 `workState.executedSteps` 扁平收集所有步骤项（V2.3: 不再递归循环容器）
4. 对于每个步骤：已存在 → 就地更新；新的 → 追加
5. **暂停重命名条目保留为历史记录**：`stepId-XXXX` 格式的条目不会被修改或删除
6. 从 `work.json` 同步 `pendingInteractions`

#### 5.4.4 异步写入队列

`enqueueChatWrite(jobId, instanceId, fn)` 序列化每个实例对 `chat.json` 的写入，防止并发读-修改-写竞争。使用 `Map<string, Promise<void>>` 维护每个实例的 Promise 链。

#### 5.4.5 暂停/恢复/重试的 chat.json 操作

- **`renameStepMessage()`**：暂停/重试时，将 step 消息 ID 重命名为 `stepId-{4位hex后缀}`，V2.4: 新增 `status?` 参数可指定状态（paused/failed）
- **`appendStepMessage()`**：恢复/重试后，追加新的 step 消息（使用原始 stepId，无后缀）
- **`addChatUserMessage()`**：追加用户消息，返回生成的 `usr-{uuid}` ID
- **`pruneOrphanedStepMessages()`**：V2.4 新增 — 重试前清理 chat.json 中该 stepId 的孤立消息（无对应 executedStep 的消息条目）

#### 5.4.6 崩溃恢复 — reconcileChatState

`reconcileChatState(workState, jobId)` 在崩溃恢复时调用：

- 追加 `work.json` 中存在但 `chat.json` 中缺失的步骤
- **不重建或重新排序**现有消息

### 5.5 产物面板（WorkflowArtifactPanel）

原 sandore 前端参考（`dynamic-workflow-engine.md §23.3.7`）：

`GET /api/workflows/jobs/:jobId/instances/:instanceId/artifacts?stageId=...`，5s 轮询（运行中时）。

分层显示：Step 条目 → Agent 回答 + 文件产物。循环产物支持迭代选项卡。

### 5.6 执行轨迹视图（WorkflowReadOnlyPipeline）

原 sandore 前端参考（`dynamic-workflow-engine.md §23.3.6`）：

渲染 `executedSteps[]` + `stageInfos[]` 的只读视图：

- `ReadOnlyStep`：状态图标 + 步骤名称 + 访问计数徽章 + 待处理交互按钮 + 分支/完成指示器
- `FlatExecutionPipeline`：按 `stageInfos` 分组，Stage 间 V 形箭头（`clipPath` 多边形），每个 Stage 卡片内平铺 `ReadOnlyStep` 列表

### 5.7 SSE 与实时更新

原 sandore 前端参考（`dynamic-workflow-engine.md §23.4`）：

#### 5.7.1 架构

```
┌────────────────────────────────────────────────────────────┐
│ SSEManager 单例（全局唯一 EventSource）                     │
│   └── EventSource /api/events/subscriptions/:subId        │
│       ├── event: instance → 实例频道分发                    │
│       └── event: session   → 会话频道分发                   │
│   动态管理：addSubscription('instance'/'session', id)       │
│   去重：EventDeduplicator（subscriptionId + type + event.id）│
├────────────────────────────────────────────────────────────┤
│ useChat(sessionId)                                         │
│   ├── useChatHistory → GET /session/:id/messages (分页50)  │
│   └── useChatStream  → sseManager.subscribe('session',sid)│
│         ├── message.updated      → 开始流式指示             │
│         ├── message.part.updated → 累积流式 parts          │
│         ├── message.part.delta   → 文本/推理增量           │
│         └── session.idle        → 合并 parts → messages    │
├────────────────────────────────────────────────────────────┤
│ DiscussionPanel (SSE 驱动)                                 │
│   ├── GET /instances/:instanceId/discussion (初始加载)     │
│   └── useSSEEvent → workflow.chat_updated/failed/aborted   │
│         └── fetchData() 增量刷新                            │
├────────────────────────────────────────────────────────────┤
│ App 轮询 (5s 间隔)                                         │
│   └── GET /instances/:instanceId → 更新 stages/steps 状态  │
└────────────────────────────────────────────────────────────┘
```

#### 5.7.2 关键原则

- **单一 EventSource**：整个应用只有一个 SSE 连接（SSEManager 单例），通过 `addSubscription`/`removeSubscription` 动态管理 instance/session 频道
- **POST fire-and-forget**：`/chat` 和 `/command` 不等待响应，SSE 传递所有结果
- **idle 合并**：`session.idle` 时将流式 parts 合并为完整 messages，去重防止与历史冲突
- **工具部分深度合并**：保留 `input` 数据，仅更新 `state` 字段

#### 5.7.3 性能优化

| 优化 | 实现 |
|------|------|
| React.memo | `MemoizedUserMessage` / `MemoizedAssistantMessage`，自定义比较 (ID + parts) |
| 滑动窗口 | `useSlidingWindow` — IntersectionObserver，视口外消息变为 60px 占位符，缓冲区 5 条 |
| 流式 Markdown | 流式期间跳过语法高亮，使用普通 `<pre>` |
| 讨论面板去重 | 比较 `updatedAt` + `messages.length` + `pendingInteractions` 的 ID 集合（非仅 length） |
| Provider 单例 | `ProvidersProvider` Context 确保所有消费者共享一次 fetch |

### 5.8 前端类型系统

原 sandore 前端参考（`dynamic-workflow-engine.md §23.5`）：

前端类型 (`workflowTypes.ts`) 与后端 Zod Schema 保持同步：

| 前端类型 | 后端类型 | 说明 |
|---------|---------|------|
| `SandoreState` | `WorkflowDefinition` | DAG 工作流定义 |
| `DagStage` | `WorkflowStage` | Stage（含流控字段） |
| `DagStep` | `WorkflowStep` | Step（命令 + 流控合并 + rules + gates） |
| `GatesConfig` | `GatesSchema` | V2.4: 门控配置（primary/secondary） |
| `CommandType` | `CommandType` | `'prompt' \| 'shell' \| 'skill' \| 'mcp' \| 'agent'` |
| `StepStatus` | `StepStatusEnum` | 含 `paused` 的 7 种状态 |
| `ExecutedStepDefault` | `ExecutedStepDefault` | 扁平执行条目（V2.3: 唯一类型，含 loopIteration/loopMeta） |
| `DagBranch` | `DagBranch` | `expectation?` 可选 = 并行 |
| `DagLoop` | `DagLoop` | 含 `next` 字段 |

**ID 格式**：`wfl-{uuid}` / `stg-{uuid}` / `step-{uuid}` / `ipt-{uuid}` / `opt-{uuid}`

### 5.9 YAML 序列化

原 sandore 前端参考（`dynamic-workflow-engine.md §23.6`）：

前端维护两套 YAML 序列化：

| 格式 | 函数 | 结构 |
|------|------|------|
| V1 (1.0) | `stateToYaml()` / `yamlToState()` | stages > scenarios > tasks |
| V2 (2.0) | `dagStateToYaml()` / `dagYamlToState()` | stages[].steps[] (流控) + 顶层 steps[] (定义) |

V2 YAML 结构：
```yaml
workflow:
  id: wfl-xxx
  engine: v2                   # V2.4: 引擎标识
  skills: [skill-a]            # V2.4: 技能列表
  mcps: [mcp-tool]             # V2.4: MCP 工具列表
  agents: [agent-x]            # V2.4: Agent 列表
  rules:                       # V2.4: 规则键值对
    chinese-output: "所有输出使用中文"
  gates:                       # V2.4: 门控配置
    primary: { enabled: true }
    secondary: { enabled: false, prompt: "..." }
  stages:
    - id: stg-xxx
      rules: [chinese-output]  # V2.4: Stage 级规则引用
      steps:
        - id: step-xxx        # 仅流控 (next, branches, loop, condition)
          next: step-yyy
  steps:                       # 顶层定义
    - id: step-xxx
      name: 分析
      command: { type: agent, value: { promptText: "agent-x" } }  # V2.4: promptText 替代 agentTemplate
      rules: [chinese-output]  # V2.4: Step 级规则引用
      gates: { primary: { enabled: false } }  # V2.4: Step 级门控覆盖
```

**V1→V2 迁移**：`dagYamlToState()` 自动检测 V1 格式，将 `scenarios[].tasks[]` 转换为 `steps[]`，映射旧版类型名。

---

## 6. 数据流与 RPC

### 6.0 RPC 接线（typert 生成 + `ctx.remote.$mount`，DSH 官方范式）

> 设计文档早期写 `host.call('sandore.*')`，那是**动态插件**（`cordis_define`/`cordis_run`）的 Package-private RPC，**不适用于持久化插件**。Task 1 已定 `SandoreRemote extends TypertRemoteService + @Remote`，其客户端消费走 DSH 官方 Typert 机制（对齐 `message-feedback`/`commands`/`goal` 等官方包，参考 `packages/api/remotes/src/client/index.ts` 的集中 `$mount` + `ui-commands` 的 `ctx.remote.commands.list`）：

```
workflow 包（Host）：SandoreRemote + @Remote('listInstances') 等
    │  手写 lib/typert.remote-client.js（27 个 InvocationDescriptor）+ .d.ts（见下方「typert 构建局限」）
    │  package.json 加 "./remote" 导出（指向手写 lib/typert.remote-client.js）
    ▼
ui 包（Client）：
    import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'   // default import
    await ctx.remote.$mount(sandoreRemote)                                  // apply(ctx) 内挂载，返回 disposer
    const defs = await ctx.remote.sandore.listDefinitions({})               // 调 ctx.remote.sandore.*
```

- `ctx.remote.sandore.*` 的命名空间 = `SandoreRemote` 的 `super(ctx, 'sandore')` service key
- 本节下文的 `host.call('sandore.*')` 一律等价于 `ctx.remote.sandore.*`

> **typert 构建局限（第三方仓库无法真正跑通 → 手写生成物，官方合法回退）**：`typert generator` 硬编码 monorepo workspace 假设（`WorkspaceTypertGenerator(root)` + `WorkspaceAnalyzer.discoverPackages()` 扫描 workspace 内的 `packages/*/*` 源码做 wire 类型拆分），而 sandore 是**第三方仓库**，`@deepseek-ai/dsh-typert-protocol` 来自 **npm 发布版**（node_modules，只有 lib 产物、无 workspace 源码 face），generator 无法识别其类型结构，build 无法真正跑通。因此：
> - **workflow 包 build 移除 `typertPlugin`**，改为普通 `tsc` + `tsdown` 打包（无 typert 生成步骤，build 无错误）；
> - **手写 `lib/typert.remote-client.js`**（27 个 RPC 的 `InvocationDescriptor`，结构见 `gateway.client.spec.ts` 的 `directDescriptor()`）+ `lib/typert.remote-client.d.ts`（类型声明），`typeSymbol`/`schema` 引用 workflow 的 `./types` 导出，**静态保留**（改 `@Remote` 方法时手动同步，typecheck + `$mount` 挂载 + 27 RPC 类型化作为验收兜底）；
> - **ui 包正常跑 clientBundle**（`import sandoreRemote from '.../remote'` + `$mount`）。
> - **不 vendor protocol**（避免复制 ~800 行 protocol 源码进 sandore 带来的包名冲突、运行时解析改指 vendor 版、长期同步维护）。

### 6.1 端到端数据流（以「执行一个工作流」为例）

```
用户（DSH Web）
  │
  ▼ 点击「工作流」按钮（sidebar.footer.action，设置上方）
  │   → 展开 WorkflowPanel（面板开关，自包含 client 状态）
  │
  ▼ WorkflowPanel（默认态：实例列表，按工作区分组）渲染
  │   host.call('sandore.listInstances') ──► Host RPC ──► 存储域 state 表
  │   ◄── 实例列表（JSON）
  │
  ▼ 点击「编排」toggle → 定义列表
  │   host.call('sandore.listDefinitions') ──► 存储域 definitions 表
  │   ◄── 定义列表（JSON）
  │
  ▼ 「新增」→ 定义（编排态）：进入空 DagEditor 新建 YAML
  │
  ▼ 选择 Job → 点击「执行」
  │   host.call('sandore.startInstance', { jobId, originalInput })
  │       │
  │       ▼ Host: workflow → ctx.sandoreEngine.startInstance()
  │            ├── 解析 YAML → WorkflowDefinition
  │            ├── 创建 DagRun（注册到 workflowManager）
  │            ├── 创建「工作流宿主 Session」（承载 chat.json 事件）
  │            └── 引擎异步执行（StageExecutor 逐 Stage 执行）
  │                 ├── Step: ctx.agents.create() → send → 监听事件 → 读输出
  │                 ├── shell: ctx.shell.run()
  │                 ├── finalize: ctx.llm.stream()（fork/临时会话）
  │                 └── 持久化: 存储域快照 + sandore/* 事件
  │
  ▼ RunView（执行态）渲染
  │   轮询 host.call('sandore.getState') + 订阅 sandore/* 事件推送
  │   ◄── 实时状态 / 讨论 / 产物
  │
  ▼ 进入终态（completed）→ 宿主 Session 自然降级为自由对话 agent（D9，无额外挂载）
       failed 态：主代理可用 sandore_retryStep 工具重试
```

### 6.2 RPC 清单（`workflow`）

| 方法名 | 说明 | 对应原 Express 路由 |
|---|---|---|
| `listDefinitions` / `createDefinition` / `updateDefinition` / `deleteDefinition` / `getYaml` / `updateYaml` | 定义 CRUD + YAML | `/api/workflows/defines/*` |
| `listJobs` / `createJob` / `getJob` / `updateJob` / `deleteJob` | Job CRUD | `/api/workflows/jobs/*` |
| `listInstances` / `startInstance` / `deleteInstance` / `getInstanceState` / `abortInstance` | 实例生命周期 | `/jobs/:id/instances/*` |
| `getDiscussion` / `addChatMessage` | 讨论/聊天 | `.../discussion` + `.../chat/message` |
| `getArtifacts` | 产物查询 | `.../artifacts` |
| `replyQuestion` / `replyPermission` | 交互回复 | `.../question/reply` + `.../permission/reply` |
| `pauseStep` / `resumeStep` / `pauseAll` / `resumeAll` / `retryStep` | 暂停/恢复/重试 | `.../pause` / `.../resume` / `.../retry` |
| `listProviders` / `listModels` | Provider/Model（复用 `ctx.llm`） | `/providers/*` |
| （D9 修正：无 default-session RPC——宿主 Session 自然延续，用普通会话 RPC） | — | — |

### 6.3 原 REST API 语义 → 现 RPC 映射参考

> 以下内容提取自 `dynamic-workflow-engine.md §22`，作为「原 REST API 语义 → 现 RPC 映射」的参考。

#### 6.3.1 Workflow 定义

| Method | Path | SDK 函数 |
|--------|------|---------|
| POST | `/defines` | `createWorkflowDef()` |
| GET | `/defines` | `listWorkflowDefs()` |
| GET | `/defines/:id` | `getWorkflowDef()` |
| PUT | `/defines/:id` | `updateWorkflowDef()` |
| DELETE | `/defines/:id` | `deleteWorkflowDef()` |
| GET | `/defines/:id/yaml` | `getWorkflowYaml()` |
| PUT | `/defines/:id/yaml` | `updateWorkflowYaml()` |

#### 6.3.2 Job 与 Instance

| Method | Path | SDK 函数 | 引擎交互 |
|--------|------|---------|---------|
| POST | `/jobs` | `createJobDef()` | — |
| GET | `/jobs` | `listJobDefs()` | 异步触发 `recoverOrphanedInstances()` |
| GET | `/jobs/:id` | `getJobDef()` | — |
| PUT | `/jobs/:id` | `updateJobDef()` | — |
| DELETE | `/jobs/:id` | `deleteJobDef()` | — |
| GET | `/jobs/:id/instances` | `listInstances()` | 从活跃引擎或 work.json 丰富状态 |
| POST | `/jobs/:id/instances` | `startInstance()` | 创建 WorkflowEngineV2 + engine.execute() |
| GET | `/jobs/:id/instances/:iid` | `getInstanceState()` | workflowManager → loadWorkflowState() |
| DELETE | `/jobs/:id/instances/:iid` | `deleteInstance()` | 删除 jobs.json 条目 + 实例目录 |
| GET | `.../artifacts?stageId=` | `getInstanceArtifacts()` | 读取 sessionMeta.outputJson 文件 |
| GET | `.../discussion` | `getInstanceDiscussion()` | 读取 chat.json（含崩溃恢复） |
| POST | `.../chat/message` | `addInstanceChatMessage()` | 写入 chat.json（atStepId）；若实例处于 paused 状态，自动 `resumeAllSteps()`。**D9 修正**：迁移后无「转默认会话」路由——终态消息直接在宿主 Session 里由主代理自然处理（编排器降级为自由对话）；`failed` 态的重试走主代理 `sandore_retryStep` 工具 |
| POST | `.../abort` | `abortInstance()` | engine.abort() |
| PATCH | `.../permission-mode` | ~~`updateInstancePermissionMode()`~~ **D9/权限修正后废弃**：DSH 无 permissionMode，权限由宿主 Session 的 permission preset 决定，Step 子代理继承父级 |

#### 6.3.3 交互与暂停/恢复

| Method | Path | SDK 函数 | 引擎交互 |
|--------|------|---------|---------|
| POST | `.../question/reply` | `replyQuestion()` | engine.replyQuestion() |
| POST | `.../permission/reply` | `replyPermission()` | engine.replyPermission() |
| POST | `.../steps/:stepId/pause` | `pauseStep()` | workflowEventBus.publishPauseStep() |
| POST | `.../steps/:stepId/resume` | `resumeStep()` | body: `{ resumePrompt?, message? }` → V2.4: 若有 message，先写 chat.json（用 step name），再 publishResumeStep() |
| POST | `.../pause` | `pauseAllSteps()` | workflowEventBus.publishPauseAll() |
| POST | `.../resume` | `resumeAllSteps()` | body: `{ resumePrompt }` → workflowEventBus.publishResumeAll() |
| POST | `.../steps/:stepId/retry` | `retryStep()` | V2.4: body: `{ mode, message, revertMessageId? }` → 写 chat.json → 销毁旧引擎 → 创建新引擎 → `engine.retryFromStep()` |
| GET | `.../steps/:stepId/messages` | `getSessionMsgs()` | V2.4: 获取 Step SDK 会话消息列表（用于 revert 模式选择回退点），返回 `{messageId, content, role, timestamp}[]` |

**关键设计**：暂停/恢复走 EventBus 发布-订阅模式，而非直接调用引擎方法。API 层不需要持有引擎实例引用。V2.4: 重试改为直接调用方式（需要销毁旧引擎→创建新引擎，EventBus 不适用）。

#### 6.3.4 Provider/Model 查询

| Method | Path | SDK 函数 |
|--------|------|---------|
| GET | `/providers` | `listProviders()` |
| GET | `/providers/all-models` | `listAllModels()` |
| GET | `/providers/:id/models` | `listProviderModels()` |

#### 6.3.5 文件系统操作

| Method | Path | 说明 |
|--------|------|------|
| GET | `/fs/directories?parent=` | 列出子目录（无 parent 时 Windows 返回盘符列表，Unix 返回 `/`） |
| POST | `/fs/mkdir` | 递归创建目录，body: `{ dirPath }`；已存在返回 409 |

#### 6.3.6 默认会话（v2.6）

| Method | Path | 说明 |
|--------|------|------|
| GET | `.../default-session` | 获取默认会话元数据 |
| POST | `.../default-session/chat` | 向默认会话发送消息（fire-and-forget） |
| DELETE | `.../default-session` | 关闭默认会话 |

#### 6.3.7 终态消息路由

工作流进入终态后，用户在输入框发送的消息按实例状态 + 是否 `@mention` 分流：

| 实例状态 | 输入形态 | 路由目标 |
|---------|---------|---------|
| `completed` | 任意消息 | 默认会话（`sendToDefaultSession`） |
| `failed` | `@mention` 失败 Step | 原重试逻辑（`retryStep`，V2.4 行为不变） |
| `failed` | 直接消息（无 @mention） | 默认会话（`sendToDefaultSession`） |

> **failed 态两条路径并存**：`failed` 状态下 `@mention` 仍是之前的重试逻辑；不带 `@mention` 的直接消息走挂载的默认会话。重试成功后工作流转为 `completed`，默认会话保持存活，用户可继续在其上对话。

---

## 7. 挂载与固化

### 7.1 静态组合（生产）

在目标 Web 组合的 `cordis.yml`（或 agent preset）中插入插件行：

```yaml
- insert:
    - id: workflow
      name: '@deepseek-ai/dsh-sandore-workflow'
      config:
        # 引擎配置（遵循 DSH "No hardcoded tunables" 约定）
        defaultTimeoutMs: 7200000
        # 注：无 permissionMode 配置（权限修正后废弃——权限由宿主 Session 的
        # permission preset 决定，Step 子代理继承父级）
    - id: microflow
      name: '@deepseek-ai/dsh-sandore-microflow'
    - id: tool
      name: '@deepseek-ai/dsh-sandore-tool'
    - id: ui
      name: '@deepseek-ai/dsh-client-ui-sandore'
```

> 包的 `package.json` 需要：Host 包正常声明；`ui` 声明 `dsh.client`（`platform: 'web'`）+ `exports["./client"]`，其 bundle 由 `ctx.clientModules` 扫描并组合进 `window.__DSH_BOOT__`。
>
> **Config 约定**（DSH「No hardcoded tunables」）：`workflow`（Provider）用 `static Config = z.object({...})`（schemastery）声明可配置项（`defaultTimeoutMs`/`maxConcurrentSteps` 等），Loader 在启动前自动校验；引擎内部不得硬编码这些 tunable，统一通过 `config` 解析（默认值走显式 `resolve(request): Spec` 步骤，而非隐藏的 `?? default`）。

### 7.2 原型验证（动态插件）

在正式落包前，可用 DSH 的**动态 Cordis 插件**机制（`cordis_define`/`cordis_run`）做快速原型：先定义 Host 半（`ctx.sandoreEngine` 的最小实现 + `harness.handle` RPC）与 Client 半（`sidebar.footer.action` 按钮 + 展开 WorkflowPanel），验证 slot 注入与 RPC 链路后再固化到仓库包。

### 7.3 依赖注入清单与 Provider 声明

`workflow`（Provider）的 `inject` 与 `static Config`：

```ts
import z from '@deepseek-ai/schemastery'
import { SandoreEngine } from '@deepseek-ai/dsh-sandore-workflow'

class SandoreEngineRuntime extends SandoreEngine {
  static inject = [
    'sessions',           // 工作流宿主 Session（chat.json 事件日志）
    'sessionPersistence', // 会话持久化（崩溃恢复）
    'subagents',          // 可续接子代理（Step 执行）
    'llm',                // 分支评估/finalize 临时推理
    'shell',              // shell 类型 Step（简单命令）
    'fs',                 // 产物/文件读写
    'storageDomain',      // work.json 状态快照（schema 验证 KV）
  ]
  // 可选（用 ctx.get() 软依赖）：
  //   ctx.subprocess —— shell Step 需 stdin 注入/流式/终端时
  //   ctx.sandbox    —— 需要显式沙箱约束时（默认走组合级 sandboxMode）

  static Config = z.object({
    defaultTimeoutMs: z.natural().default(7200000),
    maxConcurrentSteps: z.natural().default(0),   // 0 = 不限（对齐 v2.5 停用并发限制）
    // 注：无 permissionMode（权限修正后废弃——子代理继承宿主 Session 的 permission preset）
  })

  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx)  // super(ctx, 'sandoreEngine')
    this.config = config
  }
  // ...
}
export default SandoreEngineRuntime
```

### 7.4 包结构

按 DSH 仓库布局（`packages/<group>/<pkg>/`），新建一个 capability 组 `packages/sandore/`：

```
packages/sandore/
├── workflow/                     # seam + Stage 编排引擎 + @Remote RPC
│   └── src/
│       ├── index.ts                  # abstract class SandoreEngine + Provider（SandoreEngineRuntime）
│       ├── types.ts                  # WorkflowDefinition / DagRun / StepResult 等类型
│       ├── schema.ts                 # Zod Schema + TS 类型
│       ├── events.ts                 # sandore/* 事件声明（Cordis declaration merging）
│       ├── workflow-engine.ts        # 核心引擎（Stage 编排，移植 + 改用 DSH 服务）
│       ├── dag-navigator.ts          # DAG 导航
│       ├── lifecycle-manager.ts      # 生命周期（暂停/恢复/中止）
│       ├── interaction-manager.ts    # 交互管理（问答/权限）
│       ├── persistence.ts            # 持久化（存储域 + Session 事件）
│       ├── recovery-manager.ts       # 崩溃恢复
│       ├── host-agent.ts             # 宿主主代理（D9 修正，取代 default-session-manager）
│       └── remote.ts                 # @Remote RPC 方法（CRUD + 实例操作）
├── microflow/                    # Stage 内部执行（v3 微流程复用核心）
│   └── src/
│       ├── stage-executor.ts         # StageExecutor
│       ├── step-runner.ts            # Step 执行器（ctx.subagents/ctx.shell）
│       ├── branch-evaluator.ts       # 分支评估（ctx.llm）
│       ├── finalize-manager.ts       # 收尾（FinalizeAssessor + GateEvaluator）
│       ├── loop-manager.ts           # 循环管理
│       └── file-utils.ts             # 变量替换 + glob→regex
├── tool/                         # Consumer: 模型工具（sandore_*）
│   └── src/
│       └── index.ts                  # 注册 sandore_* 工具（per-instance 闭包捕获）
└── ui/                           # Client 插件
    └── src/
        ├── index.ts                  # apply(ctx) → 注册 sidebar.footer.action 按钮 + conversation.chat.node
        └── client/
            ├── WorkflowButton.tsx    # 设置上方的「工作流」入口按钮（footer.action）
            ├── WorkflowPanel.tsx     # 展开面板（仿 workspace 风格：header 搜索/编排/新增 + 三态列表）
            ├── InstanceList.tsx      # 默认态：实例列表（按工作区分组）
            ├── DefinitionList.tsx    # 编排态：定义列表
            ├── DagEditor.tsx         # 编排器（点定义进入）
            ├── RunView.tsx           # 执行详情（轨迹/产物/交互控件）
            └── DagStepNodeView.tsx   # 讨论面板的 sandore-step 节点（conversation.chat.node keyed）
```

### 7.5 命名空间

| 概念 | DSH 中命名 |
|---|---|
| 引擎 Service | `ctx.sandoreEngine`（`SandoreEngine`） |
| 事件前缀 | `sandore/*` |
| 模型工具 | `sandore_*`（主代理编排器工具） |
| Host 包 | `@deepseek-ai/dsh-sandore-workflow`、`dsh-sandore-microflow`、`dsh-sandore-tool` |
| 前端包 | `@deepseek-ai/dsh-client-ui-sandore` |

> **决策 D1**：新引擎不扩展 `ctx.workflowEngine`（其接口为「脚本编排」设计），而是新开一个 `ctx.sandoreEngine` Service，避免语义冲突。

---

## 8. 验证标准

Task 5 完成的验证标准：

| 验证项 | 说明 |
|--------|------|
| **完整 UI 可用** | 列表→编排→执行→讨论→交互 全链路可用 |
| **WorkflowList** | 工作流定义/Job/实例列表 CRUD 正常 |
| **DagEditor** | DAG 编排器 + YAML 预览 + 保存正常 |
| **RunView** | 执行轨迹 + 讨论面板（`sandore-step` Chat 节点，复用 `ui-workflow-run`）+ 产物 + 交互控件正常 |
| **插件随 `cordis.yml` 稳定加载** | 静态组合方式挂载，启动即生效 |
| **风格一致性** | UI 视觉与交互融入 DSH web（复用 ui-primitives/theme/locale） |

---

## 附录：设计决策汇总

| 编号 | 内容 |
|---|---|
| D1 | 新引擎用 `ctx.sandoreEngine` + `sandore/*` 事件，不扩展 `ctx.workflowEngine` |
| D6 | 工作流管理 UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方，仿 workspace 风格，自包含 client 状态）；放弃常驻 sidebar 分组与 conversation.view tab 主入口 |
| D7 | **前端复用 DSH 组件与设计语言**（ui-primitives/theme/locale/消息渲染/交互卡片），与 DSH web 风格一致 |
| D8 | **讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制**（`ConversationNodeDefinition` + `conversation.chat.node` keyed）：每个 Step 折叠为一个 `sandore-step` 节点，内联最后结果消息 |
| D9 | **主代理 = 工作流编排器，身份不切换**：「默认挂载会话」= 宿主 Session 自然延续（无需 DefaultSessionManager）；广播恢复改为「自然语言 → 主代理显式调用 `sandore_*` 工具」 |

---

## 附录：前端与引擎完整交互图

> 提取自 `dynamic-workflow-engine.md §23.7`

```
┌───────────────────────────────────────────────────────────────────┐
│                        前端 (React)                               │
│                                                                   │
│  WorkflowDagEditor ──PUT /yaml──► API ──writeWorkflowYaml()──► 文件│
│       │                                                           │
│  WorkflowLabSidebar ──POST /instances──► API ──startInstance()──► 引擎│
│       │                                                           │
│  WorkflowDiscussionPanel ──GET /discussion──► API ──chat.json──► 持久化│
│       │                    POST /chat/message──► API ──addChatUserMessage()│
│       │                    POST /pause──► API ──EventBus──► 引擎   │
│       │                    POST /resume──► API ──EventBus──► 引擎  │
│       │                    POST /steps/:stepId/retry──► API ──retryStep()──► 新引擎 │
│       │                    GET /steps/:stepId/messages──► API ──getSessionMsgs()──► SDK │
│       │                                                           │
│  SessionChatView ──GET /messages──► API ──getSessionMsgs()──► SDK │
│       │           EventSource /events──► API ──sdkSseManager.subscribe()──► SDK│
│       │           POST /chat──► API ──sendSessionChat()──► SDK    │
│       │                                                           │
│  WorkflowInteractionDialog ──POST /question/reply──► API ──engine.replyQuestion()│
│       │                    POST /permission/reply──► API ──engine.replyPermission()│
│       │                                                           │
│  WorkflowArtifactPanel ──GET /artifacts──► API ──output.json──► 文件│
└───────────────────────────────────────────────────────────────────┘
```
