# 记忆探索结果（memory）

## 一、需求理解（Phase 2）

- **What（要理解什么）**：`docs/design/task-5-frontend/work.md` 要求在 Task 1–4 的 Host 能力之上实现**完整前端 UI**（WorkflowList/DagEditor/RunView/讨论面板）+ **把插件固化到 `cordis.yml` 静态组合**。产出落在 `ui` 包（7 个 client 组件）+ 挂载固化（静态组合 4 包，移除动态插件原型）。
- **Boundaries（范围）**：仅 Task 5 前端 + 固化。Host 能力（引擎 CRUD/执行/生命周期 RPC、`sandore/*` 事件、`sandore_*` 工具）已由 Task 1–4 落地，本 Task **不改引擎与后端**，只在 `ui` 包内补齐 Client 组件并把 4 包固化为 `cordis.yml` 静态组合。核心记忆来源是 `docs/design/task-5-frontend/design.md`（权威规格，自包含提取）、`docs/design/overall-design.md`（§5 D1–D9、§6.1/6.2 Slot 细节）、`docs/engine/dsh-workflow-implementation.md`（T1–T13 拆分，Task 5 = T12+T13），以及 DSH 源码 `D:\project-code\llm\deepseek-harness`（`packages/client/ui-workspace`、`packages/client/ui-workflow-run`、`packages/extensions/ui-cordis`、`packages/client/ui-primitives`）。
- **Goal（目标）**：为 Task 5 的实现/设计提供事实依据——明确 Task 1–4 已落地的 Host 基线（RPC 全量、事件全量、UI 仍是 ping 占位）、前端要复用的 DSH 范式落点（footer 按钮/展开面板、`conversation.chat.node` keyed 节点、workspace 列表风格、ui-primitives 组件），以及 `cordis.yml` 静态组合的精确格式与「动态插件原型」的指代。
- **Project Context**：Task 1–4 已归档（`furina/archive/2026-08-15-task-{1,2,3}-*`、`2026-08-16-task-4-*`）。当前 `furina/changes/task-5-frontend/` 为新 change（`artifacts: []` 为空）。Task 5 只动 `ui` 包 + 挂载固化；`workflow`/`microflow`/`tool` 三包在 Task 1–4 已完成。

## 二、项目现状（当前状态事实）

| 位置 | 现状 |
|---|---|
| `packages/sandore/ui/src/index.ts` | Host 半为**空 `apply(): void {}`**（纯 UI 插件 Node 半无逻辑）。 |
| `packages/sandore/ui/src/client/index.ts` | Task 1 原型捷径：`inject = ['slots', 'locale']`；`ctx.slots.inject('sidebar.footer.action', ...)` 注册 `id: 'sandore-btn'` 按钮；`host` 是**本地 JSON 桩**（`host.call('sandore.ping')` 返回字面量 `{ pong, service, time }`），注释注明「原型捷径……生产链路接入 `ctx.remote` 的生成贡献后替换」。**未接真实 RPC、未注册 `conversation.chat.node` 讨论节点**。 |
| `packages/sandore/ui/src/client/host.ts` | `HostCall`（`call(method, args?): Promise<unknown>`）、`PingResponse`、`isPingResponse` 类型守卫。 |
| `packages/sandore/ui/src/client/locales.ts` | `NS = 'sandore'`，zh/en 字典（button.trigger/panel.orchestrate/panel.add/panel.state.* 等），`LocaleNamespaceMap` 声明合并 `sandore`。 |
| `packages/sandore/ui/src/client/WorkflowButton.tsx` | `sidebar.footer.action` 按钮（`IconBranchOutline16` + `useState` 面板开关 + `wide` 窄栏适配），渲染 `WorkflowPanel`。 |
| `packages/sandore/ui/src/client/WorkflowPanel.tsx` | 占位三态列表（`PLACEHOLDER_ROWS` 硬编码）+ 「编排」toggle + 「新增」Button + ping 往返验证按钮。 |
| `packages/sandore/ui/package.json` | `dsh.client` 声明（inject: runtime/locale/ui-sidebar，platform web）、`exports["./client"]`、peerDeps 含 `ui-slots`/`ui-primitives`/`ui-sidebar`/`react@18`。 |
| `packages/sandore/workflow/src/remote.ts` | `SandoreRemote extends TypertRemoteService`（`super(ctx, 'sandore')`），**全部 RPC 已实现**：`ping` + 定义 CRUD（`listDefinitions`/`createDefinition`/`updateDefinition`/`deleteDefinition`/`getYaml`/`updateYaml`）+ Job CRUD（`listJobs`/`createJob`/`getJob`/`updateJob`/`deleteJob`）+ 实例（`listInstances`/`startInstance`/`deleteInstance`/`getInstanceState`/`abortInstance`）+ 生命周期（`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`）+ `getArtifacts`/`listProviders`/`listModels`。**无 `getDiscussion`/`addChatMessage`**（讨论数据由 `sandore/*` Session 事件承载，D8/D9 取代）。wire 入参 zod schema 齐备。 |
| `packages/sandore/workflow/src/seam.ts` | 13 个 `sandore/*` 事件**双声明**（Cordis `Events` + Session `SessionEventMap`）；`SandoreEngine` 抽象类 11 方法；`SandoreEngineStub`。 |
| `packages/sandore/workflow/src/types.ts` / `schema.ts` | `WorkflowTaskState`/`ExecutedStepDefault`/`StageContract`/`PendingQuestion`/`PendingPermission` 等类型 + 存储域三表（`definitions`/`jobs`/`state`）schema 完整。 |
| `packages/sandore/tool/src/index.ts` | `createSandoreTools()` 返回 **8 个 `sandore_*` 工具**定义（getState/startInstance/abortInstance/pauseStep/resumeStep/pauseAllSteps/resumeAllPaused/retryStep）。 |
| `packages/sandore/microflow/` | StageExecutor/StepRunner/BranchEvaluator/Finalize/Loop 全部落地。 |
| `cordis.yml` | **sandore 仓库内无任何 `cordis.yml`**；DSH 仓库内**无任何 `sandore` 引用**（`grep -rn sandore` 于 DSH 无命中）。挂载格式以 design.md §7.1 的 `- insert:` 块为准。 |

## 三、核心硬约束（不可违反）

1. **纯插件，不改任何 DSH 源码**；**零外部 Agent SDK**，全用 DSH `ctx.*` 服务（前端用 `ctx.slots`/`ctx.locale`/`ctx.sessions`/`ctx.remote`/`ctx.conversationEvents`/`ctx.theme`）。
2. **UI 能复用 DSH 就复用**（`ui-primitives`/theme token/locale/标准 hook/消息渲染/交互卡片），不能复用就照着 DSH 风格自绘成一样（`AGENTS.md` 同义）。
3. **命名沿用**：`ctx.sandoreEngine` / `sandore/*`（13 事件）/ `sandore_*`（工具，下划线）/ `sandore.*`（RPC，点号）/ 4 包。
4. **D5**：事件/SSE 全用 DSH，零自建——前端数据获取 = `host.call('sandore.*')` RPC + DSH 事件订阅（`sandore/*` Session 事件 / `session/projection` 帧），**不用独立 axios/fetch**。
5. **D8**：讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制；`ui-conversation` 的消息组件全部 package-internal 不可跨插件 import，只能走 Slot + primitives 自绘。
6. **DAG 可视化**：先 `ui-primitives` 简化实现（节点列表 + 连线示意），**不引入 React Flow**（DSH 前端依赖未必包含，后续增强再评估）。

## 四、命名空间决策（D1，沿用 Task 1）

| 概念 | 命名 |
|---|---|
| Service key | `ctx.sandoreEngine`（`abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`） |
| 事件前缀 | `sandore/*`（Cordis `Events` + Session `SessionEventMap` 双声明，13 事件已在 seam.ts 全部声明） |
| 模型工具 | `sandore_*`（下划线，8 个，已在 tool 包落地） |
| RPC 方法 | `sandore.*`（`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`） |
| 存储域 | `sandore`（`definitions`/`jobs`/`state` 三表） |
| 前端包 | `@deepseek-ai/dsh-client-ui-sandore`（`dsh.client` + `exports["./client"]`） |

## 五、Task 5 产出与关键设计决策（work.md + design.md）

### 5.1 产出文件清单（work.md）

- `packages/sandore/ui/`（Client 插件，声明 `dsh.client` + `exports["./client"]`）：
  - `WorkflowButton.tsx` —— `sidebar.footer.action` 按钮（设置上方入口，已存在，需接真实 RPC + 面板三态）
  - `WorkflowPanel.tsx` —— 展开面板（仿 workspace 风格：header 搜索/编排/新增 + 三态列表，已存在占位，需重写）
  - `InstanceList.tsx` / `DefinitionList.tsx` —— 默认态实例列表（按工作区分组）/ 编排态定义列表（**新增**）
  - `DagEditor.tsx` —— 编排器（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存）（**新增**）
  - `RunView.tsx` —— 执行详情（轨迹/产物/交互控件 + 「打开讨论」按钮）（**新增**）
  - `DagStepNodeView.tsx` —— `sandore-step` 讨论节点（`conversation.chat.node` keyed，D8）（**新增**）
- 挂载固化：`cordis.yml` 静态组合 4 包（`workflow` + `microflow` + `tool` + `ui`），移除动态插件原型。

### 5.2 关键决策（Task 5 直接相关）

- **D6**：入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方，自包含 client 状态，参考 ui-cordis）；**不用** `conversation.view` tab 作为主入口。
- **D7**：前端复用 DSH 组件与设计语言（`ui-primitives`/theme/locale/消息渲染/交互卡片），与 DSH web 风格一致。
- **D8**：讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制——每个 Step 折叠为一个 `sandore-step` 节点（`ConversationNodeDefinition` + `conversation.chat.node` keyed），内联最后结果消息，点击跳转子对话页。
- **D9**：宿主主代理在 `completed` 后自然降级为自由对话（无 DefaultSessionManager）；`sandore_*` 工具仅挂宿主 Session。
- **数据获取**：`host.call('sandore.*')` RPC（点号）+ DSH 事件订阅（`sandore/*` Session 事件 / `session/projection` 帧）；不用独立 axios/fetch。
- **讨论面板导航**：讨论面板（`sandore-step` 节点）渲染在**宿主 Session 的 chat 视图**（`conversation.chat.node` keyed），RunView 头部「打开讨论」按钮 → `ctx.sessions.open(hostSessionId)`。
- **内联结果来源**：引擎在 append `sandore/step-completed` 事件时把子代理最终结果（`finalAssistantOutput`）塞进事件 payload → renderer 直接从 `sandore-step` 节点 state 取结果，绕开跨会话读 snapshot。
- **交互复用**：问答 = `PendingQuestion`（`ui-user-questions` 导出）+ `PendingWait<'question'>`；权限 = `PendingWait<'approval'>`；权限模式 = DSH permission presets（子代理继承父级，无 `permissionMode`）。
- **挂载固化**：`cordis.yml` 静态组合用 `- insert:` 块（见 design.md §7.1），`workflow` 配 `config.defaultTimeoutMs`；「移除动态插件原型」= 移除 `ui` 客户端的本地 JSON 桩 `host`（`client/index.ts` 注释标注的「原型捷径」），替换为真实 `ctx.remote` 生成的 RPC 桥（Task 1 遗留的 `harness.handle`/`cordis_define`/`cordis_run` 动态原型本就未进入产出）。

## 六、DSH 源码范式落点（已核实的参考实现）

以下范式来自 DSH 源码 `D:\project-code\llm\deepseek-harness`：

1. **footer 按钮 + 展开面板范式（已核实）**：`packages/extensions/ui-cordis/src/client/index.ts`。`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'cordis-panel', locale: NS, inject: (): CordisPanelFace => ({ hooks, ... }) }, CordisPanel))`。这是工作流入口按钮（`id: 'sandore-btn'`）+ 展开面板的照抄范本。

2. **`conversation.chat.node` keyed + `ConversationNodeDefinition`（已核实，D8 复用范式）**：`packages/client/ui-workflow-run/src/client/index.ts` + `workflow-definition.ts`。
   - `index.ts`：`export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']`；`ctx.conversationEvents.register(workflowRunDefinition)` + `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'workflow-run', locale: NS, inject: (): WorkflowRunInjected => ({ openSession: (id) => { ctx.sessions.open(id) } }) }, WorkflowRunPanel))`。
   - `workflow-definition.ts`：`ConversationNodeDefinition<WorkflowState>` = `{ kind: 'workflow-run', target: 'chat', match(event), start(ctx, match), update(ctx, match), buildViewNode(ctx) }`；`declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData } }`。D8 的 `sandore-step` 节点（`kind='sandore-step'`、`key='sandore-step'`）照抄此三件套。

3. **Client runtime 服务（已核实）**：`packages/client/runtime/src/client/index.ts` 声明 `slots`（`SlotRegistry`）、`conversationEvents`（`ConversationEventRegistry`）、`sessions`（`ISessions`）；`ConversationNodeDefinition` 契约在 `packages/client/runtime/src/client/contract/conversation.ts`（`ConversationMatchResult`/`ConversationNodeContext`/`ChatConversationViewNode`）。`remote` 服务由 `@deepseek-ai/dsh-api-remotes` 提供（ui-cordis `import type {} from '@deepseek-ai/dsh-api-remotes/client'` 后使用 `ctx.remote.*` 与 `ctx.remote.$on(...)`）。

4. **workspace 列表风格（已核实文件）**：`packages/client/ui-workspace/src/client/`——`WorkspaceBrowser.tsx`/`WorkspaceBrowser.module.css`/`Rows.tsx`/`tree.ts`/`stores.ts`（header 搜索 + 分组/平铺列表观感）。workspace 的 header 与分组逻辑包内私有不可 import，工作流用 `@deepseek-ai/dsh-client-ui-primitives` 自绘同款观感；`useSessions`/`useWorkspaces` 是框架全局 hook，用于「实例 → 父 session → workspace」分组映射（分组依据 = `workspace.sessionIds` 显式成员表）。

5. **ui-primitives 组件（已核实文件）**：`packages/client/ui-primitives/src/`——`Button.tsx`/`Input.tsx`/`StateDot.tsx`/`Modal.tsx`/`Menu.tsx`/`Pill.tsx`/`SearchBlock.tsx`/`Toast.tsx` + `markdown/MarkdownText.tsx`/`markdown/MessageText.tsx`/`markdown/CodeBlock.tsx` + `icons/index.tsx`（含 `IconBranchOutline16`/`IconPlusOutline16`）。内联最后结果消息照抄 `ui-workflow-run` 引用的 `AssistantMarkdown`/`UserStyleBubble`/`ToolCallTree` 薄胶水（约 100 行级）。

6. **`cordis.yml` 静态组合格式（已核实）**：`examples/web-cordis/cordis.yml` 是「PATCH OVERLAY over the web profile」——`- insert:` 块内列 `{ id, name: '@deepseek-ai/dsh-xxx', config? }`；`- id: webserver, config: { ... }` 可覆盖现有行。sandore 的 4 包固化沿用此 `- insert:` 块（design.md §7.1 已给出精确行）。

## 七、Task 5 验证标准（完成门槛，来自 work.md）

1. **完整 UI 可用**：列表 → 编排 → 执行 → 讨论 → 交互全链路。
2. **WorkflowList**：工作流定义/Job/实例列表 CRUD 正常（`host.call('sandore.*')` 拉数据）。
3. **DagEditor**：Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存正常（`host.call('sandore.updateYaml')`）。
4. **RunView**：执行轨迹（`executedSteps[]` + `stageInfos[]` 只读）/ 产物（`getArtifacts`，运行中轮询）/ 交互控件（暂停/恢复/重试/问答/权限）正常；「打开讨论」按钮 → `ctx.sessions.open(hostSessionId)`。
5. **讨论面板**：`sandore-step` 节点正确渲染（复用 `ui-workflow-run` 的 `ConversationNodeDefinition` + `conversation.chat.node` keyed）。
6. **插件随 `cordis.yml` 静态组合稳定加载**，启动即生效（移除动态插件原型）。
7. **风格一致性**：UI 视觉与交互融入 DSH web（复用 ui-primitives/theme/locale）。
