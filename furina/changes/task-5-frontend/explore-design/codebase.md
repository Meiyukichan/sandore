# Task 5 前端 + 固化 — 代码库探索结果

> 探索目标：严格按 `docs/design/task-5-frontend/work.md` 与 `design.md` 理解 Task 5（前端 UI + 挂载固化）的当前代码现状、可复用 DSH 参考实现、以及设计与现状之间的客观差异。本报告只陈述事实，不含实现方案。

---

## Exploration Result

- `furina config show project.sourcecode codebases` 返回：`project.sourcecode=src/`，`codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`。
- 唯一 codebase 元素 `docs/codebase` 目录**为空**（0 个文件），因此 Phase 3（furina-codebase 探索）无返回内容。
- 注：`project.sourcecode=src/` 指向的仓库根 `src/` 目录**不存在**；本项目真实源码位于 `packages/sandore/*`。以下补充探索直接覆盖真实源码与 DSH 参考源码。

## Supplementary Exploration Result

### 一、需求理解

- **What**：Task 5 要在 Task 1–4 已完成的 Host 引擎能力之上，实现完整前端 UI（WorkflowList/DagEditor/RunView/`sandore-step` 讨论节点）并把 4 个包固化到 `cordis.yml` 静态组合。
- **Boundaries**：`packages/sandore/ui/`（Client 插件，`dsh.client` + `exports["./client"]`）+ 挂载固化（DSH 目标组合的 `cordis.patch.yml`）；硬约束为「纯插件不改 DSH 源码」「零外部 Agent SDK」「能复用 DSH 就复用，不能复用就照 DSH 风格自绘」。
- **Goal**：摸清现状（ui 包已到什么程度）、后端已暴露的 RPC/事件/类型面、以及 DSH 侧可复用的 slot/组件/节点机制，为 Task 5 的实现提供事实依据。
- **Project Context**：本项目是 DSH（deepseek-harness）的 sandore 工作流引擎插件，仓库根为 `D:\project-code\llm\sandore`；DSH 参考源码在 `D:\project-code\llm\deepseek-harness`。

---

### 二、当前仓库状态（Task 1–4 已提交，Task 5 尚未开始）

最近提交（`git log --oneline`）：

```
5c9fb7f feat(sandore): Task 4 生命周期——交互/暂停恢复/重试/崩溃恢复/宿主主代理
ab65bda feat(sandore): Task 3 完整 DAG — agent/skill/mcp Step + 分支 + 循环 + Finalize
f4f56fc feat(sandore): 引擎最小可用（类型+YAML+CRUD+持久化+线性执行）
0773b85 feat(sandore): 工作流引擎 DSH 插件骨架（Task 1）
```

`furina/changes.json` 中 `task-5-frontend` 是**当前活动变更**（features=0，artifacts=[]），说明 Task 5 尚未产出实现。

`packages/sandore/` 下 4 个包：

| 包 | 包名 | 状态 |
|---|---|---|
| `workflow/` | `@deepseek-ai/dsh-sandore-workflow` | Task 1–4 完整 |
| `microflow/` | `@deepseek-ai/dsh-sandore-microflow` | Task 1–4 完整 |
| `tool/` | `@deepseek-ai/dsh-sandore-tool` | Task 1–4 完整 |
| `ui/` | `@deepseek-ai/dsh-client-ui-sandore` | **仅 Task 1 原型桩**（见下） |

### 三、后端已暴露的 RPC / 事件 / 类型面（前端可消费的事实）

#### 3.1 Host RPC（`packages/sandore/workflow/src/remote.ts`）

`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')` 定 wire namespace，`@Remote('name')` 定 method，构成端点 `sandore.<method>`。实际方法清单：

- 健康检查：`ping`
- 定义 CRUD：`listDefinitions` / `createDefinition` / `updateDefinition` / `deleteDefinition` / `getYaml` / `updateYaml`
- Job CRUD：`listJobs(workflowId?)` / `createJob` / `getJob` / `updateJob` / `deleteJob`
- 实例生命周期：`listInstances(jobId?)` / `startInstance` / `deleteInstance` / `getInstanceState` / `abortInstance`
- 交互：`replyQuestion` / `replyPermission`
- 暂停/恢复/重试：`pauseStep` / `resumeStep` / `pauseAll` / `resumeAll` / `retryStep`
- 产物/Provider：`getArtifacts(instanceId, stageId?)` / `listProviders` / `listModels(provider)`

关键 wire 类型（remote.ts 内定义）：`WorkflowDefinitionEntry`、`JobEntry`、`InstanceSummary`（instanceId/jobId/workflowId/status/createdAt/updatedAt）、`ArtifactEntry`（stepId/stageId/outputToId/files/returnPrompt）。`retryStep` 入参 `mode` 限定 `continue|revert|fork`。

> 注：设计文档 §6.2 还列出 `getDiscussion` / `addChatMessage`，但当前 `remote.ts` **没有**这两个方法（D8/D9 已改为「宿主 Session 的 `sandore/*` 事件 + 主代理自然延续」承载讨论数据，无独立 discussion RPC）。

#### 3.2 事件面（`packages/sandore/workflow/src/seam.ts`）

13 个 `sandore/*` 事件双声明：`@deepseek-ai/cordis` `Events` + `@deepseek-ai/dsh-session/types` `SessionEventMap`。前端讨论节点关心的是 Session 事件（宿主 Session 的事件日志），当前 payload 形状：

```
'sandore/start'           : { taskId, workflowId, jobId }
'sandore/stage-start'     : { taskId, stageId }
'sandore/stage-completed' : { taskId, stageId, stageContract }
'sandore/step-start'      : { stepId, childId }
'sandore/step-completed'  : { stepId, childId, output: ContentBlock[] }
'sandore/step-failed'     : { stepId, childId, error }
'sandore/step-paused'     : { stepId, childId }
'sandore/step-resumed'    : { stepId, childId, resumePrompt? }
'sandore/step-retried'    : { stepId, mode }
'sandore/question'        : { question: PendingQuestionEntry }
'sandore/permission'      : { permission: PendingPermissionEntry }
'sandore/end'             : { taskId, jobId, result }
'sandore/aborted'         : { taskId }
```

`step-completed` 的 `output` 已经是「子代理最终结果」：`workflow-engine.ts` 的 `emitStepCompleted` 直接透传 StageExecutor 钩子 `onStepCompleted(step, childId, output)`，而 `microflow/src/step-runner.ts`（`let output = finalAssistantOutput(child.session.events)`）用 `finalAssistantOutput`（`microflow/src/subagents.ts`）从子会话事件算出 `ContentBlock[]`。即设计 §5.3.1 的「结果塞进事件 payload」这一条**后端已满足**。

#### 3.3 类型/Schema 面（`workflow/src/schema.ts` + `types.ts`）

- 定义层：`WorkflowDefinition` / `WorkflowStage` / `WorkflowStep` / `CommandConfig`（五类型 discriminated union：agent/prompt/shell/skill/mcp）/ `InputFromItem` / `OutputToItem` / `PassThroughVar` / `DagBranch` / `DagLoop` / `GatesSchema`。
- 运行时层：`WorkflowTaskState`（`executedSteps[]` + `stageInfos[]` + `pendingInteractions[]` + `stageContracts` + `passThroughVars` 等）；`ExecutedStepDefault`（含 `status`/`visitCount`/`loopIteration?`/`finalizeMeta?`/`branchMeta?`/`retryHistory?`/`output?`/`sessionMeta?` 等）；`StageInfo`（id/name/status）；`StageContract`（含 `artifacts[{stepId,outputToId,files,returnPrompt?}]`）。
- `types.ts` 另提供 browser-safe 的 `DagInstanceState` / `DagRun` / `DagRunStatus` / `ExecutedStepDefault` / `StageInfo` / `StageContract` / `StepStatus`（`'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'`）。
- 存储层：`sandoreDomainSpec` 三表 `definitions` / `jobs` / `state`（`persistence.ts` 暴露 `ctx.sandorePersistence`）。
- ID 前缀：`wfl-`（定义）/ `job-`（Job）/ 实例 ID 为 `YYYYMMDD-HHmmss-xxx`（`workflow-engine.ts` `makeInstanceId()`）；Step 子会话 `childId = step-{stepId}-{execId 前 8 位}`。

#### 3.4 宿主 Session / 主代理（D9）

`workflow-engine.ts` `startInstance`：`ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup: createHostAgentSetup(...) })` 创建宿主主代理；`host-agent.ts` 的 `createHostAgentSetup` 注册 8 个 `sandore_*` 工具（`tool/src/index.ts`：`sandore_getState`/`startInstance`/`abortInstance`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllPaused`/`retryStep`）+ 注入编排器 system prompt section。

- **事实缺口**：设计 §5.2 说宿主会话标题 = `工作流实例 xxx` 由 `sessionTitle.rename` 设置，但当前 `host-agent.ts` / `workflow-engine.ts` **没有**任何 `sessionTitle` 调用。DSH 侧该服务存在：`@deepseek-ai/dsh-session-title`（`ctx.sessionTitle`，`rename(session, title)` / `refresh` / `get`），见 `D:\project-code\llm\deepseek-harness\packages\session\session-title\src\index.ts`。

#### 3.5 Config（Provider 声明）

`SandoreEngineRuntime` / `SandoreEngineStub` 的 `static Config`（schemastery）当前声明 4 个字段：`defaultTimeoutMs`（默认 7200000）、`maxConcurrentSteps`（默认 0）、`defaultProvider`（`z.string()`，无默认）、`defaultModel`（`z.string()`，无默认）。`SandoreConfig` TS 接口将 `defaultProvider`/`defaultModel` 标为可选。

- **事实差异**：设计 §7.1/§7.3 的 `config` 只列 `defaultTimeoutMs`（与 `maxConcurrentSteps`），不含 `defaultProvider`/`defaultModel`。当前实现的 Config 多了后两个必填字段。

---

### 四、`ui` 包现状（Task 1 原型桩，非 Task 5 完整实现）

`packages/sandore/ui/` 现有文件：

```
package.json          — 声明 dsh.client（platform: web，inject: client-runtime/locale/ui-sidebar）+ exports["./client"]；peerDeps 含 ui-slots/ui-primitives/ui-sidebar/react 18
src/index.ts          — Host 半：空 apply()（纯 UI 插件 Node 半）
src/client/index.ts   — 注册 sidebar.footer.action（id 'sandore-btn'），inject { host }（字面量 host.call 桩，仅处理 sandore.ping）
src/client/host.ts    — HostCall 接口 call(method, args)；PingResponse + isPingResponse
src/client/locales.ts — NS 'sandore'；zh/en 字典（button.trigger / panel.title / panel.orchestrate / panel.add / panel.state.* / panel.ping.*）
src/client/WorkflowButton.tsx   — footer.action 按钮（照抄 ui-cordis CordisPanel 的按钮结构）
src/client/WorkflowPanel.tsx    — 占位面板：编排 toggle + 新增按钮 + 三态占位列表 + ping 往返
src/client/WorkflowButton.module.css / WorkflowPanel.module.css
src/css-modules.d.ts / tsconfig.json
```

已具备（Task 1 验证过的部分）：
- `sidebar.footer.action` 按钮 + 展开面板的**插槽注册与组件 props 类型组合**（`PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`），与 `ui-cordis` 同款。
- locale 注册（`ctx.locale.register(NS, { zh, en })` + `LocaleNamespaceMap` 声明合并）。
- `wide`（rail/wide 双态）渲染分支。

**尚未实现**（Task 5 需补，`work.md` 产出清单）：
- `InstanceList.tsx` / `DefinitionList.tsx`（三态/分组列表，按工作区分组）
- `DagEditor.tsx`（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存）
- `RunView.tsx`（执行轨迹/产物/交互控件 + 「打开讨论」按钮）
- `DagStepNodeView.tsx`（`conversation.chat.node` keyed 渲染，`sandore-step` 节点）
- `conversation.chat.node` 的 keyed 注册（`key: 'sandore-step'`）+ `ConversationNodeDefinition`
- 真实 RPC 桥（当前 `host.call` 是 `sandore.ping` 字面量桩，未接 `ctx.remote`）

---

### 五、DSH 参考实现（Task 5 可复用的机制与组件，均位于 `D:\project-code\llm\deepseek-harness`）

#### 5.1 `sidebar.footer.action` 插槽（`packages/client/ui-sidebar`）

- 契约 `src/client/contract/slots.ts`：`'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }`，owner 仅 `{ wide: boolean }`。
- 渲染位 `src/client/SidebarRoot.tsx`（第 182–188 行）：`footArea` 内 `footerActions` 在 `settingsArea` **之上**（"Footer actions stack above Settings"），确认「设置上方入口」的落点。

#### 5.2 footer 按钮 + 展开面板范本（`packages/extensions/ui-cordis`）

- `src/client/index.ts`：`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name, id, locale, inject: (): CordisPanelFace => ({ hooks, on* }) }, CordisPanel))`。
- `src/client/CordisPanel.tsx`：面板组件 props = `PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>`；`useState(open)` 开关；`wide ? css.layer : css.layer + css.rail` 外层；`<section>` header（title）+ body（分组 `<h3>` + `<ul>` 列表）+ 底部 badge 按钮。是 WorkflowPanel 最直接的结构参照。
- 内部 store 用 `HostObservable`（`@deepseek-ai/dsh-client-ui-slots`），面板通过 `useInventory(snapshot => ...)` 类 hook 订阅。

#### 5.3 `conversation.chat.node` keyed 节点机制（`packages/client/ui-workflow-run`）

- `src/client/index.ts`：
  - `ctx.conversationEvents.register(workflowRunDefinition)` 注册节点定义。
  - `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name, key: 'workflow-run', locale: NS, inject: (): WorkflowRunInjected => ({ openSession: (id) => { ctx.sessions.open(id) } }) }, WorkflowRunPanel))`。
- `src/client/workflow-definition.ts`：
  - `ConversationNodeDefinition`（kind `'workflow-run'`，`target: 'chat'`），`match`/`start`/`update`/`buildViewNode` 四函数折叠多事件为一个节点。
  - `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData } }` 扩展 keyed 节点 payload 注册表。
- `src/client/WorkflowRunPanel.tsx`：keyed 渲染组件 props = `PropsRuntime<'conversation.chat.node', 'workflow-run'> & PropsLocale<'workflowRun'> & WorkflowRunInjected`；用 `DisclosureRow` + `StateDot`（`ui-primitives`）渲染状态/成员；点击成员 `openSession(member.childId)` 跳子会话。

`ConversationNodeDefinition` 接口定义在 `packages/client/runtime/src/client/contract/conversation.ts`（`kind`/`target`/`match(event)`/`start(context, match, reader)`/`update(context, match)`/`publication?`/`buildLocationData?`/`buildViewNode?`）。

#### 5.4 `conversation.chat.node` 插槽契约（`packages/client/ui-conversation`）

- `src/client/contract/slots.ts`：`'conversation.chat.node': { kind: 'keyed'; scope: 'session'; owner: ChatNodeOwnerProps; keyProps: { [Kind]: { node: ChatNode<Kind> } }; hookContext: string; inject: ChatNodeTurnDataInjected }`。
- `ChatNodeOwnerProps`（供 renderer 使用）：`selectedCallId?` / `cwd?` / `openFile(path)` / `inspectCall(callId)` / `forkAt(seq)` / `loadImage` / `fileMentions`。`forkAt(seq)` 即 fork 重试入口。
- `src/client/contract/chat-nodes.ts`：`ChatNodeDataMap`（merge-extensible，空基表）与 `ChatNode<Kind>` 类型。

#### 5.5 可复用的 `ui-primitives` 导出（`packages/client/ui-primitives/src/index.ts`）

`StateDot`/`StateDotState`、`DisclosureRow`/`DisclosureRowProps`、`Button`/`ButtonVariant`、`Pill`、`Input`、`Menu`、`Modal`、`Tooltip`、`Toast`、`HoverCard`、`JsonTree`、`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`、`MarkdownText`、`MessageText`、`CodeBlock`、`JsonBlock`、`extractMarkdownPlainText`、`icons/*`（含 `IconBranchOutline16`/`IconPlusOutline16` 等）。全部通过 `--dsw-*` theme token 样式化。

#### 5.6 框架全局 hook / 服务（`packages/client/runtime`）

- `ctx.sessions.open(id)`（`ui-workflow-run` 已示范「打开讨论/子会话」用法）。
- `useSessions` / `useWorkspaces`（`src/client/contract/sessions.ts` / `workspaces.ts`）；`WorkspaceView.sessionIds` 显式成员表是「实例 → 父 session → workspace」分组的依据（`ui-workspace/src/client/WorkspaceBrowser.tsx` 第 280 行 `workspaces.flatMap(w => w.sessionIds)` 即为分组范式）。
- `ctx.workspaces`（`IWorkspaces`，含 `connectWorkspace`/`startSession`/`rename`/`delete`/`insertSessionBefore`/`archiveSession` 等）。

#### 5.7 挂载固化目标（`cordis.yml` / `cordis.patch.yml`）

本仓库内**没有** `cordis.yml`。DSH 目标 Web 组合在 `D:\project-code\llm\deepseek-harness`：

- `packages/bundle/web-app/cordis.patch.yml`：web 面组合，含 `dsh.client` browser roster（`modules`/`connection`/`client-runtime`/`ui-theme`/`locale`/`ui-layout`/`ui-sidebar`/`ui-conversation`/`ui-tool`/`ui-cordis`/`ui-workflow-run`/`ui-workspace`/`ui-user-questions` …）。Task 5 的 4 个 sandore 包需按 `insert:` 行静态插入（`ui` 行是 `dsh.client` 行，其余三包为 Host 行），并移除动态插件原型。
- 另有 `packages/bundle/base/cordis.patch.yml` 与 `packages/bundle/headless/cordis.patch.yml`。

#### 5.8 客户端 RPC 接线（Typert）

- Host 侧：`TypertRemoteService`（`packages/typert/protocol/src/index.ts`）— `super(ctx, 'sandore')` 绑定 service key 与 wire namespace，`@Remote('name')` 标记方法。
- Client 侧：`ctx.remote`（`TypertClientRemote`，`declare module '@deepseek-ai/cordis' { interface Context { remote: TypertClientRemote } }`），经 `ctx.remote.$mount(contribution)` 挂载各命名空间生成的 `TypertRemoteContribution`（见 `packages/api/remotes/src/client/index.ts`：`ctx.remote.$mount(commandsRemote)` 等）。
- **事实缺口**：`workflow` 包当前 `package.json` 的 `exports` 只有 `.` / `./types` / `./src/*` / `./package.json`，**没有** `./remote` 客户端贡献模块；`ui` 包当前用字面量 `host.call('sandore.ping')` 桩。设计 §6.2 的「`host.call('sandore.*')`」尚未落到真实 Typert 客户端接线。

---

### 六、设计与现状的客观差异汇总（供 Task 5 对齐）

| # | 项 | 设计文档 | 当前代码事实 |
|---|---|---|---|
| 1 | ui 包完整度 | 7 个组件 + 固化 | 仅 WorkflowButton + WorkflowPanel 占位 + ping 桩 |
| 2 | 讨论数据 RPC | §6.2 含 `getDiscussion`/`addChatMessage` | remote.ts 无这两个方法（改由 Session 事件承载） |
| 3 | `sandore-step` 折叠态字段 | `{ stepId, childId, name, status, loopIteration }` | Session 事件 `step-*` payload 仅 `{ stepId, childId[, output/error/resumePrompt] }`，**无 `name`/`loopIteration`**（需从 `getInstanceState` 或事件补充） |
| 4 | 宿主会话标题 | `sessionTitle.rename` → `工作流实例 xxx` | 后端未调用 `sessionTitle` |
| 5 | Provider Config 字段 | §7.3 仅 `defaultTimeoutMs`/`maxConcurrentSteps` | 当前 Config 另含 `defaultProvider`/`defaultModel`（`z.string()` 无默认） |
| 6 | 客户端 RPC | `host.call('sandore.*')` | ui 用字面量桩；workflow 无 `./remote` 客户端贡献 |
| 7 | 挂载固化 | `cordis.yml` 静态组合 4 包 | 本仓库无 cordis.yml；目标组合在 DSH `packages/bundle/web-app/cordis.patch.yml` |

---

### 七、关键文件路径清单

**本仓库（`D:\project-code\llm\sandore`）：**
- `docs/design/task-5-frontend/work.md`、`docs/design/task-5-frontend/design.md`（Task 5 权威规格）
- `AGENTS.md`（「能复用 DSH 就复用，不能复用就照风格做成一样」）
- `packages/sandore/workflow/src/remote.ts`（RPC）、`seam.ts`（`ctx.sandoreEngine` + 13 事件）、`schema.ts`/`types.ts`（类型）、`workflow-engine.ts`（宿主 Session/执行/事件双发）、`host-agent.ts`（8 工具 setup）、`persistence.ts`（存储域）
- `packages/sandore/microflow/src/subagents.ts`（`finalAssistantOutput`）、`step-runner.ts`（output 计算）
- `packages/sandore/tool/src/index.ts`（`sandore_*` 工具）
- `packages/sandore/ui/**`（当前原型桩）

**DSH 参考（`D:\project-code\llm\deepseek-harness`）：**
- `packages/extensions/ui-cordis/src/client/{index.ts,slots.ts,CordisPanel.tsx}`（footer 按钮 + 面板范本）
- `packages/client/ui-workflow-run/src/client/{index.ts,workflow-definition.ts,WorkflowRunPanel.tsx}`（Chat 节点三件套）
- `packages/client/ui-sidebar/src/client/{contract/slots.ts,SidebarRoot.tsx}`（`sidebar.footer.action` 契约与渲染位）
- `packages/client/ui-conversation/src/client/contract/{slots.ts,chat-nodes.ts}`（`conversation.chat.node` 契约 + `ChatNodeDataMap`）
- `packages/client/runtime/src/client/contract/conversation.ts`（`ConversationNodeDefinition`）
- `packages/client/ui-primitives/src/index.ts`（可复用组件基元）
- `packages/bundle/web-app/cordis.patch.yml`（挂载固化目标组合）
- `packages/session/session-title/src/index.ts`（`ctx.sessionTitle.rename`）
- `packages/typert/protocol/src/index.ts` + `packages/api/remotes/src/client/index.ts`（Typert RPC 客户端接线）
