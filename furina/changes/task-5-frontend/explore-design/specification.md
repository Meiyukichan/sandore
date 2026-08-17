# Task 5 前端 + 固化 — 规格探索结果

> 探索类型：specification
> 探索对象：`docs/design/task-5-frontend/work.md` 及其要求（design.md / dsh-workflow.md §6/§7/§8 / overall-design.md D6–D9 / DSH 源码参考）
> 语言：中文

---

## 一、需求理解

- **What**：在 Task 1–4 已落地的 Host 能力（`workflow`/`microflow`/`tool` 三个 Host 包）之上，实现完整的 DSH Web 前端 UI（WorkflowList / DagEditor / RunView / `sandore-step` 讨论节点），并把 4 个插件包通过 `cordis.yml` 静态组合固化。
- **Boundaries**：范围限定在 `packages/sandore/ui/`（Client 插件）与挂载固化的 cordis.yml 配置；不改任何 DSH 源码、不引入外部 Agent SDK；讨论面板复用 DSH 的 `ui-workflow-run` Chat 节点机制，管理 UI 复用 `ui-primitives`/theme/locale 自绘。
- **Goal**：理解 Task 5 的权威规格（UI 结构、Slot 注册、数据流与 RPC、挂载固化、验证标准）以及当前代码（Task 1–4 产出 + DSH 参考包）的实际状态，为准确实施 Task 5 提供事实依据。

---

## 二、权威规格要点（来自 design.md / dsh-workflow.md / overall-design.md）

### 2.1 硬约束与产出

- **纯插件**：不改任何 DSH 源码；**零外部 Agent SDK**。
- **UI 复用优先**：能复用 DSH 就复用（`ui-primitives`/theme token/locale/标准 hook），不能复用就照 DSH 风格自绘（见项目 `AGENTS.md`）。
- 产出 7 个文件（`packages/sandore/ui/`）：
  1. `WorkflowButton.tsx` — `sidebar.footer.action` 按钮（设置上方入口）
  2. `WorkflowPanel.tsx` — 展开面板（仿 workspace 风格：header 搜索/编排/新增 + 三态列表）
  3. `InstanceList.tsx` / `DefinitionList.tsx` — 默认态实例列表（按工作区分组）/ 编排态定义列表
  4. `DagEditor.tsx` — 编排器（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存）
  5. `RunView.tsx` — 执行详情（轨迹/产物/交互控件 + 「打开讨论」按钮）
  6. `DagStepNodeView.tsx` — `sandore-step` 讨论节点（`conversation.chat.node` keyed，D8）

### 2.2 关键决策（D6–D9）

| 编号 | 内容 |
|---|---|
| D6 | 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方，自包含 client 状态）；放弃常驻 sidebar 分组与 `conversation.view` tab 主入口 |
| D7 | 前端复用 DSH 组件与设计语言（ui-primitives/theme/locale/消息渲染/交互卡片），与 DSH web 风格一致 |
| D8 | 讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制：每个 Step 折叠为一个 `sandore-step` 节点（`ConversationNodeDefinition` + `conversation.chat.node` keyed），内联最后结果消息，点击跳转子对话页 |
| D9 | 宿主主代理在 `completed` 后自然降级为自由对话（无 DefaultSessionManager）；`sandore_*` 工具仅挂宿主 Session |

### 2.3 Slot 注册（design.md §1.2）

`ui` Client 插件 `apply(ctx)` 注册两处：

```ts
export const inject = ['slots', 'locale', 'sessions']  // 规格示意
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action', id: 'sandore-btn', locale: NS,
  inject: () => ({ hooks: { open: createPanelStore() } }),
}, WorkflowButton))

// 讨论面板 sandore-step 节点在 conversation.chat.node keyed（宿主 Session 的 chat 视图）
```

### 2.4 RPC 清单（design.md §6.2 / dsh-workflow.md §7.2）

定义 CRUD、Job CRUD、实例生命周期、`getDiscussion`/`addChatMessage`、`getArtifacts`、`replyQuestion`/`replyPermission`、`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`、`listProviders`/`listModels`；D9 修正后**无 default-session RPC**。

### 2.5 挂载固化（§7.1 / §8.1）

在目标 Web 组合的 `cordis.yml` 插入 4 包：

```yaml
- insert:
    - id: workflow
      name: '@deepseek-ai/dsh-sandore-workflow'
      config: { defaultTimeoutMs: 7200000 }
    - id: microflow
      name: '@deepseek-ai/dsh-sandore-microflow'
    - id: tool
      name: '@deepseek-ai/dsh-sandore-tool'
    - id: ui
      name: '@deepseek-ai/dsh-client-ui-sandore'
```

`ui` 需声明 `dsh.client`（`platform: 'web'`）+ `exports["./client"]`，其 bundle 由 `ctx.clientModules` 扫描组合进 `window.__DSH_BOOT__`。

### 2.6 验证标准（Task 5 完成门槛）

列表 → 编排 → 执行 → 讨论 → 交互全链路可用；WorkflowList（定义/Job/实例 CRUD）、DagEditor（YAML 预览 + 保存）、RunView（轨迹/产物/交互控件）正常；`sandore-step` 节点正确渲染（复用 ui-workflow-run）；插件随 cordis.yml 静态组合稳定加载；UI 融入 DSH web。

---

## 三、当前代码现状（Task 1–4 已落地）

### 3.1 包结构

`packages/sandore/` 下 4 包均已存在：

- `workflow/` — seam + Stage 编排引擎 + @Remote RPC（文件：`seam.ts`、`types.ts`、`schema.ts`、`workflow-engine.ts`、`dag-navigator.ts`、`lifecycle-manager.ts`、`interaction-manager.ts`、`persistence.ts`、`recovery-manager.ts`、`host-agent.ts`、`remote.ts`、`yaml-parser.ts`、`errors.ts`、`engine-surface.ts`、`shell.ts`）
- `microflow/` — `stage-executor.ts`、`step-runner.ts`、`branch-evaluator.ts`、`finalize-manager.ts`、`loop-manager.ts`、`file-utils.ts`、`subagents.ts`、`internal.ts`
- `tool/` — `index.ts`（`sandore_*` 工具）
- `ui/` — Task 1 占位（见 §3.4）

### 3.2 Host RPC 实际方法（`workflow/src/remote.ts`，Typert 协议）

`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`，端点即 `sandore.<method>`：

- `ping()` → `PingResponse`
- 定义 CRUD：`listDefinitions` / `createDefinition({yaml})` / `updateDefinition(id,{name,version,description})` / `deleteDefinition(id)` / `getYaml(id)` / `updateYaml(id, yaml)`
- Job CRUD：`listJobs(workflowId?)` / `createJob({name,workflowId,cwd?})` / `getJob(id)` / `updateJob(id,{name,cwd?})` / `deleteJob(id)`
- 实例：`listInstances(jobId?)` / `startInstance({jobId,originalInput,cwd?})` / `deleteInstance(instanceId)` / `getInstanceState(instanceId)` / `abortInstance(instanceId)`
- 交互：`replyQuestion({instanceId,requestId,answers})` / `replyPermission({instanceId,requestId,reply:'once'|'always'|'reject'})`
- 生命周期：`pauseStep({instanceId,stepId})` / `resumeStep({instanceId,stepId,resumePrompt?})` / `pauseAll({instanceId})` / `resumeAll({instanceId,resumePrompt?})` / `retryStep({instanceId,stepId,mode:'continue'|'revert'|'fork',message})`
- 产物/Provider：`getArtifacts(instanceId, stageId?)` / `listProviders()` / `listModels(provider)`

> **命名差异（事实）**：规格 §6.1 数据流写的是 `host.call('sandore.getState')`，但实际 RPC 方法名是 `getInstanceState`（返回 `WorkflowTaskState` 全量快照）；引擎 Service 层（`seam.ts`）另有 `getState(instanceId): DagInstanceState`（返回精简快照），两者字段范围不同。

### 3.3 事件（`workflow/src/seam.ts`）

13 个 `sandore/*` 事件**双声明**：

- Cordis `Events`：`sandore/start`、`stage-start`、`stage-completed`、`step-start`、`step-completed`、`step-failed`、`step-paused`、`step-resumed`、`step-retried`、`question`、`permission`、`end`、`aborted`
- Session `SessionEventMap`（`declare module '@deepseek-ai/dsh-session/types'`）：同名前缀，载荷为 `{ stepId, childId, output? }`、`{ question }`、`{ permission }` 等

**关键事实**：这些是 **Session 事件**（引擎在 `workflow-engine.ts` 用 `session.append('sandore/step-start', {...})` 写入宿主 Session log），只有 append 进 log 的事件才会被 `ConversationNodeDefinition` 折叠（D8）并被 apiproxy `session/event` 帧透传；`ctx.emit` 同名 Cordis 事件只是引擎内部可选触发源。

`sandore/step-completed` 载荷含 `output: ContentBlock[]`（引擎 append 前用 `ctx.sessions.get(childId)` + `finalAssistantOutput` 填充子代理最终结果，renderer 直接从节点 state 取结果，绕开跨会话读 snapshot）。

### 3.4 数据模型（`workflow/src/schema.ts` / `types.ts`）

- `WorkflowTaskState`（`getInstanceState` 返回值）：`taskId/jobId/workflowId/cwd/status/originalInput/currentStageId/executedSteps[]/stageInfos[]/pendingInteractions[]/pendingQueue[]/visitCounts/passThroughVars/activeLoopIterationStack/activeLoopNodeId/activeLoopStack/pausedChildIds[]/stageContracts/createdAt/updatedAt`
- `ExecutedStepDefault`：`id/stepId/stageId/name/status/command/inputFrom/outputTo/passThroughVars/sessionMeta/finalizeMeta/visitCount/branchMeta/error/pausedAt/resumedAt/resumePrompt/sessionMessages/pauseEntryId/loopIteration/loopMeta/retryHistory/parentSessionId/output`
- `StepSessionMeta`：`{ childId, synthetic, command, hostSessionId? }`
- 状态枚举：`StepStatus`（blocked/ready/interacting/running/completed/failed/paused，7 态）、`DagRunStatus`（pending/running/interacting/completed/failed/aborted/paused）
- 存储域三表 `sandore`：`definitions`（key=workflowId，value 含 YAML 文本封顶 65536）/ `jobs`（key=jobId）/ `state`（key=instanceId）
- `StageContract`：`{ stageId, stageName, status, artifacts[], passThroughVars, contractArtifacts, completedAt, errorDetail? }`（`getArtifacts` 的数据源）

### 3.5 引擎关键事实（与 RunView / 讨论面板直接相关）

- **宿主 Session id = instanceId**：`workflow-engine.ts` 里 `ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup: ... })`。因此 RunView 的「打开讨论」按钮 = `ctx.sessions.open(instanceId)`。
- 宿主主代理 setup（`host-agent.ts`）注册 8 个 `sandore_*` 工具：`sandore_getState` / `sandore_startInstance` / `sandore_abortInstance` / `sandore_pauseStep` / `sandore_resumeStep` / `sandore_pauseAllSteps` / `sandore_resumeAllPaused` / `sandore_retryStep`。
- 暂停登记表用 `pausedChildIds`（存子代理 SessionId），DSH 无 paused 状态枚举。
- `recovery-manager` 提供崩溃恢复 + 孤儿实例扫描（`Service.init` 自动触发）。

### 3.6 ui 包当前状态（Task 1 占位）

`packages/sandore/ui/src/` 现有：

- `index.ts`（Host 半空壳 `apply(){}`）
- `client/index.ts`（注册 `sidebar.footer.action`，`inject = ['slots','locale']`；**本地 JSON 桩 `host.call`** 只认 `sandore.ping`）
- `client/WorkflowButton.tsx`（footer 按钮 + 展开 WorkflowPanel 占位，import 了 `IconBranchOutline16`）
- `client/WorkflowPanel.tsx`（占位三态列表 + ping 往返验证按钮）
- `client/host.ts`（`HostCall.call(method, args)` 字面量原型桥 + `PingResponse` 类型守卫）
- `client/locales.ts`（`NS='sandore'`，zh/en 字典 + `LocaleNamespaceMap` 声明合并）
- `client/WorkflowButton.module.css` / `WorkflowPanel.module.css` / `css-modules.d.ts`

`ui/package.json` 已声明：`dsh.client`（`inject: [dsh-client-runtime, dsh-client-locale, dsh-client-ui-sidebar]`，`platform: 'web'`）+ `exports["./client"]`；peerDeps 含 `@deepseek-ai/dsh-client-ui-primitives` / `dsh-client-ui-slots` / `react@^18` 等。

---

## 四、DSH 参考实现（Task 5 复用点）

### 4.1 `ui-workflow-run`（D8 讨论节点范本，最核心）

路径 `packages/client/ui-workflow-run/src/client/`：

- `index.ts`：`inject = ['conversationEvents','slots','sessions','locale']`；三件事：
  1. `ctx.conversationEvents.register(workflowRunDefinition)`
  2. `ctx.effect(() => ctx.locale.register(NS, { zh, en }))`
  3. `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name:'conversation.chat.node', key:'workflow-run', locale:NS, inject: (): WorkflowRunInjected => ({ openSession: id => ctx.sessions.open(id) }) }, WorkflowRunPanel))`
- `workflow-definition.ts`：
  - `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData } }`
  - `ConversationNodeDefinition<State>` 五字段：`kind` / `target:'chat'` / `match(event)`（返回 `{ id, role:'start'|'update' } | null`）/ `start(context, match, reader)` / `update(context, match)` / `buildViewNode(context): ChatConversationViewNode | null`（含 `key/kind/id/target/anchorSeq/location/visibility/data`）
- `WorkflowRunPanel.tsx`：keyed 渲染器 props 组成 = `PropsRuntime<'conversation.chat.node','workflow-run'> & PropsLocale<'workflowRun'> & WorkflowRunInjected`；用 `useSessions(selector, shallowEqual)` 读 SessionListState（`.ids` / `.byId[childId]`（含 `.origin/.parentId/.running`）），`DisclosureRow`/`StateDot`/`IconChevronRightOutline14` 自绘折叠行；`openSession(childId)` 跳转。

`ConversationNodeDefinition` 契约（`packages/client/runtime/src/client/contract/conversation.ts`）已确认：`match(event: SessionEvent)`、`start`、`update`、`publication?`、`buildLocationData?`、`buildViewNode?`；`ChatConversationViewNode` 必含 `anchorSeq/location/visibility`。

### 4.2 `ui-cordis`（footer 按钮 + 展开面板范本）

路径 `packages/extensions/ui-cordis/src/client/`：

- `index.ts`：`sidebar.footer.action` 注册形态 = `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name:'sidebar.footer.action', id:'cordis-panel', locale:NS, inject: (): CordisPanelFace => ({ hooks:{...}, onXxx }) }, CordisPanel))`。
- `CordisPanel.tsx`：`PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>`；组件内 `useState(open)` 控制展开，`wide` prop 区分窄栏/展开；`useSessions(state => state.current)` 读当前会话。
- `slots.ts`：`InjectFace`/`PropsRuntime`/`PropsLocale`/`HostObservable` 均来自 `@deepseek-ai/dsh-client-ui-slots`。

### 4.3 `ui-workspace`（WorkspaceBrowser 风格 + 全局 hook 范本）

路径 `packages/client/ui-workspace/src/client/`：

- `index.ts`：`inject = ['slots','sessions','workspaces','locale']`；通过 `ctx.sessions.search(query, signal)`、`ctx.sessions.open(id)`、`ctx.sessions.binding(id)?.session`、`ctx.sessions.fork({ sessionId, increaseTitle })`、`ctx.workspaces.startSession/create/rename/delete/insertBefore/archiveSession/insertSessionBefore` 驱动列表。
- `stores.ts`：`defineStore({ init, persist:'dsh.workspace.view.v5', actions })` → `EngineStoreHandle`，经 `ctx.slots.register({ ..., store: createWorkspaceViewStore() })` 传入（slot register 支持 `store` 选项，跨重载持久化）。
- 说明：workspace 的 header/分组逻辑包内私有不可 import，工作流需用 `ui-primitives` 自绘同款观感。

### 4.4 `ui-primitives` 可用组件（可 import）

`packages/client/ui-primitives/src/index.ts` 导出：`StateDot`、`DisclosureRow`、`Button`、`Pill`、`Input`、`Menu`、`HoverCard`、`Modal`、`RiskConfirmation`、`Tooltip`、`Toast`、`JsonTree`、`TerminalBlock`/`ReadBlock`/`DiffBlock`/`SearchBlock`/`WebBlock`、`CodeBlock`/`JsonBlock`/`MarkdownText`/`MessageText`、`extractMarkdownPlainText`、`writeClipboard`、`useAnchoredMaxHeight`、`icons/*`（含 `IconBranchOutline16`、`IconPlusOutline16`、`IconChevronRightOutline14`、`IconCordisPluginOutline14` 等）。

### 4.5 Client→Host RPC 的 DSH 两种既有机制（事实）

1. **`ctx.remote`（Typert Remote，第一方编译进包的机制）**：`packages/api/remotes/src/client/index.ts` 在 `apply` 里显式 `ctx.remote.$mount(contribution)` 挂载 5 个命名空间（commands/goals/dynamicCordisRunner/pluginInventory/messageFeedback），`inject = ['remote']`；客户端经 `inject` 里声明 `'remote.messageFeedback'` 后调用 `ctx.remote.messageFeedback.list(...)`，返回 `Promise<RemoteResult<T>>`（`{ ok:true; value } | { ok:false; error }`）。宿主导入 `TypertRemoteService` + `@Remote` 装饰器，构建时由 `packages/typert/generator`（tsdown 插件）生成 `typert.host.js` 与 `typert.remote-client.js`（如 `@deepseek-ai/dsh-message-feedback/remote`、`/typert` 子路径）。
2. **`host.call` / `harness.handle`（动态 Cordis 插件沙箱机制）**：`cordis-client-runner` 里 `host.call(method, args)` 配 `harness.handle(method, fn)`，走 `Remote` 命名空间。

> **与 Task 5 相关的现状差距（事实记录）**：sandore `workflow/package.json` 的 `exports` 只有 `.`/`./types`/`./src/*`，**没有** `./remote`（typert.remote-client）子路径；4 个 sandore 包 `scripts` 均只有 `"typecheck": "tsc --noEmit"`，**没有 build/tsdown 配置**；DSH 的 `api/remotes` 客户端装配清单**不含 sandore 命名空间**。当前 `ui/src/client/index.ts` 的 `host.call` 是 Task 1 的本地桩（只处理 `sandore.ping`，其余抛错）。

### 4.6 cordis.yml 静态组合格式（DSH 先例）

`deepseek-harness/examples/web-cordis/cordis.yml` 展示补丁式叠加（PATCH OVERLAY）：`- id: webserver config: {...}` 覆盖 + `- insert: [{ id, name }]` 插入插件行。sandore 仓库本身**没有 cordis.yml**（挂载目标在 DSH 侧 Web 组合）。

---

## 五、关键发现汇总（与 Task 5 实施强相关的事实）

1. **宿主 Session id == instanceId**：RunView「打开讨论」= `ctx.sessions.open(instanceId)`；Step 子会话 id 在 `ExecutedStepDefault.sessionMeta.childId` / `parentSessionId`。
2. **讨论面板数据源 = 宿主 Session 的 `sandore/*` Session 事件**，不是独立 discussion API；`ConversationNodeDefinition` 折叠事件去重，`sandore/step-completed` 已内联 `output`。
3. **RPC 命名**：实际远端方法是 `getInstanceState`（非 `getState`）；`getArtifacts` 从 `stageContracts` 派生；无 `getDiscussion`/`addChatMessage`/`listProviderModels` 远端方法（规格 §6.2 所列与 `remote.ts` 实现存在差异）。
4. **RPC 通道现状**：`host.call` 为桩；`ctx.remote.sandore` 命名空间未在 DSH `api/remotes` 装配、sandore 未导出 `./remote`、无构建步骤生成 Typert 客户端产物。
5. **挂载固化**：4 包均无 build 脚本；`ui` 已声明 `dsh.client` + `exports["./client"]`；cordis.yml 目标在 DSH Web 组合（sandore 仓库无 cordis.yml）。
6. **`sessionTitle.rename`（规格 §5.2「标题 = 工作流实例 xxx」）在当前代码中未见实现**——宿主会话经 `ctx.agents.create({ sessionId, meta:{cwd}, setup })` 创建，未显式设置标题。
7. **UI 复用面已确认可用**：`sidebar.footer.action`（root scope list，owner prop 仅 `wide`）、`conversation.chat.node`（keyed）、`conversationEvents.register`、`useSessions`/`useWorkspaces` 全局 hook、`ctx.sessions.open/search/binding`、`ctx.slots.register`（支持 `store`/`locale`/`key`/`children`）、`defineStore` 持久化、`ui-primitives` 组件清单。
