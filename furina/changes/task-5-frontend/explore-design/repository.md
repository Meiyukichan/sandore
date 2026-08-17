# Task 5 前端 + 固化 — 仓库材料探索报告

> 探索类型：repository
> 目标仓库：`D:\project-code\llm\sandore`（sandore DSH 插件仓库）+ `D:\project-code\llm\deepseek-harness`（DSH 参考源码）
> 任务来源：`docs/design/task-5-frontend/work.md`（权威规格 `docs/design/task-5-frontend/design.md`）
> 输出文件：`furina/changes/task-5-frontend/explore-design/repository.md`

---

## 一、需求理解（Phase 2）

### 1. What（要理解什么）

Task 5 在 Task 1–4 已交付的 Host 能力（`ctx.sandoreEngine` 引擎 + `sandore/*` Session 事件 + `sandore.*` RPC + `sandore_*` 编排器工具）之上，实现**完整前端 UI + 挂载固化**：

1. **WorkflowList**：工作流定义 / Job / 实例列表 CRUD 入口（默认态实例列表按工作区分组 + 编排态定义列表）。
2. **DagEditor**：Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存。
3. **RunView**：执行轨迹（`executedSteps`/`stageInfos` 只读）+ 产物面板 + 交互控件（暂停/恢复/重试/问答/权限）。
4. **讨论面板**：每个 Step 折叠为一个 `sandore-step` Chat 节点（`conversation.chat.node` keyed，复用 `ui-workflow-run` 机制，D8）。
5. **挂载固化**：`cordis.yml` 静态组合 4 包（`workflow` + `microflow` + `tool` + `ui`），移除动态插件原型。

### 2. Boundaries（探索范围）

- 范围：sandore 仓库当前代码状态（Task 1–4 已落地，特别是 `ui` 包现状、Host RPC 面、`sandore/*` Session 事件载荷）+ `./furina/` 归档（Task 1–4 历史参考）+ Task 5 权威规格（`design.md`）+ DSH 源码中 UI 复用参考（`ui-workflow-run`/`ui-primitives`/`ui-cordis`/`ui-workspace`/`ui-sidebar`）+ `cordis.yml` 挂载格式。
- 不在范围：引擎/Host 侧实现（Task 1–4 已交付）、`docs/engine/dynamic-workflow-engine.md` 的 v2.6 REST 后端细节（仅作语义对照）。

### 3. Goal（探索目的）

准确掌握 Task 5 的落点与 DSH 前端 API 真实面，回答：

- sandore 仓库当前代码的**确切状态**（`ui` 包已有什么、缺什么；Host RPC 有哪些方法、缺哪些；事件载荷是否内联子代理最终结果）。
- DSH 前端可复用组件的**真实形状**（`ConversationNodeDefinition` + `conversation.chat.node` keyed 三件套、`ui-primitives` 导出清单、`sidebar.footer.action` 注册范式、`useSessions`/`useWorkspaces` 全局 hook）。
- `cordis.yml` 静态组合的**真实格式**与 sandore 仓库中挂载落点现状。

---

## 二、仓库材料配置与历史参考（Phase 3）

### 2.1 仓库材料配置

`furina config show exploration.repository` 返回单元素：

```json
[{ "path": "./furina/", "type": "directory", "description": "The location of Furina Artifacts ... archived changes and ongoing changes ..." }]
```

探索 `./furina/` 结果：

- `furina/changes.json`：当前 active change = `task-5-frontend`（`features: 0`、`todo: 0`、`artifacts: []`，`createdAt: 2026-08-16T12:23:57Z`）；archive = `task-1-skeleton`、`task-2-minimal-engine`、`task-3-full-dag`、`task-4-lifecycle`（均已 closed）。
- `furina/changes/task-5-frontend/` 目录当前为空（本次探索产出目录 `explore-design/` 为新建）。
- 四个归档含完整 artifacts（proposal/design/specs/plan/api/explore-design/explore-coding）。

### 2.2 历史归档要点（Task 5 承接）

> 由 `furina/archive/2026-08-15-task-{1,2,3}-*/` + `2026-08-16-task-4-*/` 的 `design.md` + `explore-design/repository.md` 汇总。

- **命名空间（Task 1 确立，贯穿所有 Task）**：`ctx.sandoreEngine`（Service）/ `sandore/*`（13 事件，**Session 事件**，`session.append` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`）/ `sandore.*`（RPC，点号）/ `sandore_*`（工具，下划线，Task 4 已交付 8 个）/ 4 包 `@deepseek-ai/dsh-sandore-workflow`、`dsh-sandore-microflow`、`dsh-sandore-tool`、`@deepseek-ai/dsh-client-ui-sandore`。
- **Task 1 已交付**：4 包骨架 + `sidebar.footer.action`（`id: 'sandore-btn'`）按钮 + WorkflowPanel ping 占位 + 最小 `sandore.ping` RPC 往返。
- **Task 2 已交付**：类型体系（Zod schema 三层）+ YAML 解析 + 定义/Job/实例 CRUD + `sandore` 存储域三表 + shell/prompt Step 线性执行。
- **Task 3 已交付**：五类 Command（agent/skill/mcp 可续接子代理 + shell/prompt）、DAG 调度、循环、Finalize。
- **Task 4 已交付**：交互/暂停/恢复/重试三模式/崩溃恢复 + 宿主主代理（`host-agent.ts`）+ 8 个 `sandore_*` 工具（`tool/src/index.ts`）。
- **关键决策（Task 5 沿用）**：D5（事件/SSE 全用 DSH，零自建）；D6（UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel）；D7（复用 ui-primitives/theme/locale）；D8（讨论面板复用 `ui-workflow-run` Chat 节点机制）；D9（宿主主代理自然降级，无 DefaultSessionManager）。

---

## 三、sandore 仓库现状（Task 4 已落地代码，Task 5 承接面）

### 3.1 `ui` 包现状（Task 5 的主要改造点）

`packages/sandore/ui/` 当前仅有 **Task 1 原型**，距 Task 5 目标差距如下：

| 设计目标（design.md §7.4） | 现状 |
|---|---|
| `WorkflowButton.tsx`（footer.action 入口按钮） | **已存在**（Task 1 原型，可用） |
| `WorkflowPanel.tsx`（展开面板） | **已存在**（Task 1 占位：三态列表 + ping 往返） |
| `InstanceList.tsx`（默认态实例列表，按工作区分组） | **缺失** |
| `DefinitionList.tsx`（编排态定义列表） | **缺失** |
| `DagEditor.tsx`（编排器 + YAML 预览/保存） | **缺失** |
| `RunView.tsx`（执行详情） | **缺失** |
| `DagStepNodeView.tsx`（`sandore-step` 讨论节点） | **缺失** |

**已存在文件的关键内容**：

- `src/client/index.ts`：`export const inject = ['slots', 'locale']`；`apply(ctx)` 注册 locale + `sidebar.footer.action`（`id: 'sandore-btn'`），`inject: (): WorkflowButtonFace => ({ host })`。`host` 是**本地 JSON 桩**（`host.call('sandore.ping')` 字面量），非 `ctx.remote` 生成贡献（注释明示「生产链路接入 `ctx.remote` 后替换」）。
- `src/client/WorkflowButton.tsx`：`PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`，`useState` 自包含 `open` 开关，渲染 `{open && <WorkflowPanel .../>}` + footer 按钮。已正确用 `wide` 区分 rail/wide。
- `src/client/WorkflowPanel.tsx`：`t: TranslateNS<'sandore'>` + `host: HostCall`；三态占位行 + `sandore.ping` 往返。**尚无** `useSessions`/`useWorkspaces` 分组、编排 toggle 的实际数据、新增/CRUD。
- `src/client/host.ts`：`HostCall { call(method, args?) }` + `PingResponse` + `isPingResponse`。
- `src/client/locales.ts`：`NS = 'sandore'`，zh/en 文案；`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }`。
- `src/index.ts`（Host 半）：`export function apply(): void {}`（空壳，纯 UI 插件范式正确）。
- `package.json`：`dsh.client` 已声明（`platform: 'web'`），但 **`inject` 数组不完整**——当前仅 `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-sidebar"]`；`exports["./client"]` 已就位。`peerDependencies` 已含 `dsh-client-ui-slots`/`dsh-client-ui-primitives`/`dsh-client-ui-sidebar`，但缺 `dsh-client-runtime` 之外的 `sessions` 相关、`dsh-client-ui-conversation`（D8 讨论节点 `conversationEvents`/`conversation.chat.node` 需要）。

### 3.2 Host RPC 面（`workflow/src/remote.ts`，`SandoreRemote extends TypertRemoteService`）

`super(ctx, 'sandore')` 定 wire namespace，`@Remote('name')` 定 method，端点 = `sandore.<method>`。已实现方法清单：

| 类别 | 方法 | 签名要点 |
|---|---|---|
| 健康检查 | `ping` | → `{ pong, service, time }` |
| 定义 CRUD | `listDefinitions` / `createDefinition(input:{yaml})` / `updateDefinition(id, input)` / `deleteDefinition(id)` / `getYaml(id)` / `updateYaml(id, yaml)` | `createDefinition` 解析验证 YAML → 生成 `wfl-{uuid}` |
| Job CRUD | `listJobs(workflowId?)` / `createJob(input:{name,workflowId,cwd?})` / `getJob(id)` / `updateJob(id, input)` / `deleteJob(id)` | `createJob` 校验 workflowId 存在 |
| 实例生命周期 | `listInstances(jobId?)` / `startInstance(input:{jobId,originalInput,cwd?})` / `deleteInstance(instanceId)` / `getInstanceState(instanceId)` / `abortInstance(instanceId)` | `listInstances` 从 `state` 表派生 `InstanceSummary[]` |
| 交互回复 | `replyQuestion(input:{instanceId,requestId,answers})` / `replyPermission(input:{instanceId,requestId,reply:'once'\|'always'\|'reject'})` | zod 校验后转发引擎 |
| 暂停/恢复/重试 | `pauseStep({instanceId,stepId})` / `resumeStep({instanceId,stepId,resumePrompt?})` / `pauseAll({instanceId})` / `resumeAll({instanceId,resumePrompt?})` / `retryStep({instanceId,stepId,mode:'continue'\|'revert'\|'fork',message})` | 转发 `ctx.sandoreEngine` |
| 产物 | `getArtifacts(instanceId, stageId?)` | 从 `state.stageContracts` 扁平化 `ArtifactEntry[]`（`stepId/stageId/outputToId/files/returnPrompt?`） |
| Provider/Model | `listProviders()` / `listModels(provider)` | 透传 `ctx.llm` |

**关键缺口（相对 design.md §6.2 RPC 清单）**：`getDiscussion` / `addChatMessage` **不存在**（D8/D9 修正后，讨论数据由宿主 Session 的 `sandore/*` 事件承载，非 RPC）。`listProviders`/`listModels` 存在。**无** default-session RPC（D9）。

**wire 类型（`remote.ts` 导出，前端可直接对应）**：`WorkflowDefinitionEntry`（`WorkflowDefinitionRecord` + `id`）、`JobEntry`（`JobRecord` + `id`）、`InstanceSummary`（`{instanceId,jobId,workflowId,status,createdAt,updatedAt}`）、`ArtifactEntry`、`CreateDefinitionInput`/`UpdateDefinitionInput`/`CreateJobInput`/`UpdateJobInput`/`StartInstanceInput`/`ReplyQuestionInput`/`ReplyPermissionInput`/`PauseStepInput`/`ResumeStepInput`/`PauseAllInput`/`ResumeAllInput`/`RetryStepInput`。

### 3.3 `sandore/*` Session 事件（`workflow/src/seam.ts` 双声明，13 个）

`SessionEventMap` 合并声明（`declare module '@deepseek-ai/dsh-session/types'`），**纯数据载荷**（驱动 D8 讨论面板折叠 + apiproxy 透传）：

```
sandore/start { taskId, workflowId, jobId }
sandore/stage-start { taskId, stageId }
sandore/stage-completed { taskId, stageId, stageContract }
sandore/step-start { stepId, childId }
sandore/step-completed { stepId, childId, output: ContentBlock[] }   ★ output 内联子代理最终结果
sandore/step-failed { stepId, childId, error }
sandore/step-paused { stepId, childId }
sandore/step-resumed { stepId, childId, resumePrompt? }
sandore/step-retried { stepId, mode }
sandore/question { question: PendingQuestionEntry }
sandore/permission { permission: PendingPermissionEntry }
sandore/end { taskId, jobId, result: DagResultInfo }
sandore/aborted { taskId }
```

**已 emit**（`workflow-engine.ts` 的 `emitXxx` + `emitContained` + `safeAppend` 双发，全部就位）：13 个事件均有 `emitXxx` 辅助函数并已接线。

**D8 关键确认**：`sandore/step-completed` 的 `output` 来自 `StageExecutor` 的 `onStepCompleted(step, childId, output)` hook → `emitStepCompleted` → `session.append('sandore/step-completed', { stepId, childId, output })`；`output` 在 `microflow/src/step-runner.ts` 中由 `finalAssistantOutput(child.session.events)` 产出（`ContentBlock[]`）。即**事件 payload 已内联子代理最终结果**，前端 renderer 可直接从 `sandore-step` 节点 state 取结果，无需跨会话读 snapshot。

### 3.4 宿主 Session / 主代理（`workflow-engine.ts` + `host-agent.ts`）

- 宿主 Session：`ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup: createHostAgentSetup({ instanceId, engine }) })`。**`hostSessionId = instanceId`**（instanceId 格式 `YYYYMMDD-HHmmss-xxx`）。`meta.cwd` 必填（否则重启后冷会话从侧边栏列表消失）。
- `createHostAgentSetup`（`host-agent.ts`）：`setup(agentCtx)` 内注册 8 个 `sandore_*` 工具（闭包捕获 `instanceId`）+ `agentCtx.systemPrompt.section({ name: 'sandore-host', order: 116, ... })`。`completed` 后 resume/retry/pause 类工具对已完成实例返回 no-op，`getState` 始终可用（自然降级语义）。
- **8 个 `sandore_*` 工具**（`tool/src/index.ts`）：`sandore_getState` / `sandore_startInstance` / `sandore_abortInstance` / `sandore_pauseStep` / `sandore_resumeStep` / `sandore_pauseAllSteps` / `sandore_resumeAllPaused` / `sandore_retryStep`；返回 `SandoreToolResult { ok, reason?, error?, state?, run? }`。
- **注意（相对 design.md §5.2 的小差异）**：当前引擎**未**调用 `sessionTitle.rename` 或 `session.rename` 设置宿主会话标题（grep `sessionTitle|session.rename|title|rename` 仅命中测试与 `updateJob` 的 `name` 字段）。design.md §5.2 所述「标题 = 工作流实例 xxx，由 `sessionTitle.rename` 设置」在当前代码中**未实现**，Task 5 需确认是否补（否则侧边栏宿主会话显示默认自动标题）。

### 3.5 运行时/存储类型（前端 RunView/DagEditor 数据源）

- `DagInstanceState`（`getState` 返回，`types.ts`）：`{ taskId, jobId, workflowId, status, originalInput, currentStageId, executedSteps: ExecutedStepDefault[], stageInfos: StageInfo[], pendingQueue, createdAt, updatedAt }`。
- `ExecutedStepDefault`：`{ type:'default', id, stepId?, stageId, name, status(7态 StepStatus), command?, inputFrom?, outputTo?, passThroughVars?, sessionMeta?{childId,synthetic,command,hostSessionId?}, finalizeMeta?, visitCount, branchMeta?, error?, pausedAt?, resumedAt?, resumePrompt?, sessionMessages?, pauseEntryId?, loopIteration?, loopMeta?, retryHistory?, parentSessionId?, output? }`。
- `WorkflowTaskState`（`getInstanceState` 返回，`schema.ts`，存储域 `state` 表 value）：含 `pendingInteractions`（`PendingQuestionEntry`/`PendingPermissionEntry` 联合）、`stageContracts`、`visitCounts`、`passThroughVars` 等。
- `WorkflowDefinitionRecord`（定义存储）：`{ yaml, name, version, description?, createdAt, updatedAt }`；`JobRecord`：`{ name, workflowId, cwd?, createdAt, updatedAt }`。
- 状态枚举：`DagRunStatus = 'pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused'`；`StepStatus = 'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'`。

### 3.6 `microflow` / `tool` / `workflow` 包与挂载现状

- `microflow` 包：Stage/Step 执行器（Task 3/4 已交付），纯 Host 侧，Task 5 前端不直接 import 运行时（仅类型）。
- `tool` 包：8 个 `sandore_*` 工具（Task 4 已交付）。
- `workflow` 包：`peerDependencies` 含 `dsh-sandore-microflow`（`workspace:*`）、`dsh-session`/`dsh-llm`/`dsh-typert-protocol`/`dsh-agent`/`dsh-storage`/`dsh-storage-domain`/`dsh-subagent`/`dsh-subprocess`/`schemastery`（`0.1.0-rc.6`/`4.0.1`）。**无 `dsh` 字段**（Host 包正常声明，无 `dsh.client`）。
- **sandore 仓库当前无 `cordis.yml`**（`find . -name cordis.yml` 为空）。「挂载固化」的落点需新建（详见 §5）。

---

## 四、Task 5 权威规格要点（`docs/design/task-5-frontend/design.md`）

> 该文档自述从 `dsh-workflow.md`（§6/§7/§8）与 `dynamic-workflow-engine.md`（§12/§22/§23）提取重组的自包含设计。以下为 Task 5 落点摘要。

### 4.1 整体 UI 结构（§1，决策 D6）

```
sidebar（footArea，设置上方）
└── [工作流 按钮]（sidebar.footer.action，id: 'sandore-btn'）★
        └── 点击展开 WorkflowPanel（仿 workspace 风格，ui-primitives 自绘）
            ├── header：搜索图标 | 「编排」toggle + 「新增」按钮
            ├── 默认态（编排 off）：实例列表（按工作区分组）→ InstanceList
            ├── 编排态（编排 on）：定义列表 → 点定义进 DagEditor → DefinitionList
            └── 新增：默认态→新增实例；编排态→新增定义
```

- 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方，自包含 client 状态）；**不用** `conversation.view` tab 作为主入口。
- 讨论面板 `sandore-step` 节点在**宿主 Session 的 chat 视图**（`conversation.chat.node` keyed）渲染，与管理 UI 分离。
- 风格参考：完全仿 `ui-workspace` 的 WorkspaceBrowser（header 搜索 + 操作按钮 + 分组/平铺列表）；workspace 的 header/分组逻辑包内私有不可 import，工作流用 `ui-primitives` 自绘同款观感；`useSessions`/`useWorkspaces` 是框架全局 hook（实例 → 父 session → workspace 分组依据 = `workspace.sessionIds` 显式成员表）。

### 4.2 Slot 注册（§1.2）

```ts
export const inject = ['slots', 'locale', 'sessions']   // D8 需追加 'conversationEvents'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui: dict')
  // 1) 工作流入口按钮（sidebar.footer.action）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'sandore-btn', locale: NS,
    inject: () => ({ hooks: { open: createPanelStore() } }),
  }, WorkflowButton))
  // 2) 讨论面板 sandore-step 节点（conversation.chat.node keyed，§5.3）
}
```

### 4.3 前端技术栈（§2，决策 D7）

React（DSH client 统一）；组件基元 = `ui-primitives`（按钮/输入/列表/对话框/徽章）；样式 = DSH theme token（`ctx.theme` + `styles.insert`，CSS 变量）；i18n = `ctx.locale`；消息/讨论渲染复用 `ui-conversation` + `conversation.chat.node`；交互卡片复用 `ui-user-questions`（`PendingQuestion` 已导出）/权限卡片；工具调用展示复用 `ui-tool`（`tool.call.toolview`）；数据获取 = `host.call()` RPC + DSH 事件订阅（不用 axios/fetch）；**DAG 可视化先 `ui-primitives` 简化（节点列表 + 连线示意），React Flow 作后续增强**。

### 4.4 讨论面板（§5.3，决策 D8，复用 ui-workflow-run 三件套）

```
① ConversationNodeDefinition（kind='sandore-step', target='chat'）
   ├── match: sandore/step-start | step-completed | step-failed | ... 事件
   ├── start/update: 折叠 { stepId, childId, name, status, loopIteration }
   ├── buildViewNode: 返回 ChatConversationViewNode（data 含 childId）
   └── declare module 扩展 ChatNodeDataMap { 'sandore-step': DagStepChatData }
② conversation.chat.node keyed 渲染器（key='sandore-step'）
   ├── inject: (sessionId) => ({ getChildSession(id), openSession(id) })
   └── 渲染 DagStepNodeView
③ 内联消息：primitives 自绘（MarkdownText / MessageText，可 import）
```

- Step 节点渲染规则：running 无结果消息 / completed 内联最后 assistant 结果 / failed 红框 + errorDetail / paused 琥珀框 + 快照。
- 点击 Step 节点 → `ctx.sessions.open(childId)` 跳到子对话页（DSH 默认 UI，composer 自动提供暂停/继续/fork 重试生命周期控件）；continue/revert 重试按钮在 Step 节点补（映射 `sandore_retryStep`）。
- 问答复用 `PendingQuestion`（`ui-user-questions` 导出）+ `PendingWait<'question'>`；权限复用 `PendingWait<'approval'>`。

### 4.5 数据流与 RPC（§6）

端到端：`host.call('sandore.listInstances')` → `sandore.listDefinitions` → `sandore.startInstance` → RunView 轮询 `host.call('sandore.getState')` + 订阅 `sandore/*` 事件 → 终态后宿主 Session 自然降级为自由对话（D9）。

### 4.6 挂载固化（§7）

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

`workflow`（Provider）用 `static Config = z.object({...})`（schemastery）声明可配置项；`ui` 声明 `dsh.client`（`platform: 'web'`）+ `exports["./client"]`，bundle 由 `ctx.clientModules` 扫描组合进 `window.__DSH_BOOT__`。

### 4.7 验证标准（§8 / work.md）

列表 → 编排 → 执行 → 讨论 → 交互全链路；WorkflowList CRUD / DagEditor YAML 预览保存 / RunView 轨迹产物交互控件正常；`sandore-step` 节点正确渲染；插件随 `cordis.yml` 静态组合稳定加载；UI 视觉交互融入 DSH web。

---

## 五、DSH 源码关键 API 实证（源码 `D:\project-code\llm\deepseek-harness`）

### 5.1 `sidebar.footer.action` Slot（`ui-sidebar`）

- 声明：`packages/client/ui-sidebar/src/client/index.ts` 第 47–53 行，`'sidebar.footer.action': { kind: 'list', scope: 'root' }`（在 `sidebar` 的 `children` 里声明）。
- owner props：`packages/client/ui-sidebar/src/client/contract/slots.ts` 第 60–63 行，`SidebarFooterActionOwnerProps = { wide: boolean }`（`wide=false` = 56px rail / `true` = 展开）。
- 渲染位置：`SidebarRoot.tsx` 第 181–188 行，`{/* Footer actions stack above Settings in both sidebar widths. */}` → `footArea > footerActions(renderSlot('sidebar.footer.action', { wide }))` 在 `settingsArea` **之上**。

### 5.2 `ui-cordis`：footer 按钮 + 展开面板范式（`packages/extensions/ui-cordis/src/client/`）

- `index.ts`：`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name, id: 'cordis-panel', locale: NS, inject: (): CordisPanelFace => ({ hooks: {...}, onXxx: ... }) }, CordisPanel))`。
- `CordisPanel.tsx`：`CordisPanelProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>`；从 props 解构 `wide, useSessions, useInventory, ...`（**`useSessions` 由 `PropsRuntime<'sidebar.footer.action'>` 提供**）；`const [open, setOpen] = useState(false)` 面板开关；渲染 `<div className={wide ? css.layer : css.layer + css.rail}>{open && <section className={css.panel}>…</section>}<div className={css.footerButtons}><button className={css.badge} aria-expanded={open} onClick={toggle}>…</button></div></div>`。
- 结论：sandore `WorkflowButton` 已完全对齐此范式；`WorkflowPanel` 若要「实例 → 父 session → workspace」分组，可直接用 props 里的 `useSessions` + `useWorkspaces`（后者需在 slot 注入/或从 `PropsRuntime` 提供——见 5.4 的 workspace 注入面）。

### 5.3 `ui-workflow-run`：`conversation.chat.node` keyed 三件套（D8 照抄对象）

- `src/client/index.ts`：`export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']`；`apply` 内 `ctx.conversationEvents.register(workflowRunDefinition)` + `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'workflow-run', locale: NS, inject: (): WorkflowRunInjected => ({ openSession: (id) => ctx.sessions.open(id) }) }, WorkflowRunPanel))`。
- `src/client/workflow-definition.ts`：`ConversationNodeDefinition<WorkflowState>` 结构 = `{ kind, target: 'chat', match(event), start(context, match), update(context, match), buildViewNode(context) }`；keyed 数据经 `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData } }` 合并。
- `src/client/WorkflowRunPanel.tsx`：`WorkflowRunPanelProps = PropsRuntime<'conversation.chat.node', 'workflow-run'> & PropsLocale<'workflowRun'> & WorkflowRunInjected`；从 props 解构 `node, sessionId, useSessions, openSession, t`；`node.data` 为 keyed Chat 数据；`useSessions(selector, shallowEqual)` 判子会话可导航性；用 primitives `DisclosureRow`/`IconChevronRightOutline14`/`StateDot`。
- **D8 映射**：sandore 的 `workflow-definition` 需 `match` `sandore/step-start`/`step-completed`/`step-failed`/`step-paused`/`step-resumed` 事件（payload 见 §3.3），折叠为 `sandore-step` 节点 state（`{ stepId, childId, name, status, loopIteration? }`），`buildViewNode` 返回 `ChatConversationViewNode`（`data: { childId, ... }`）。

### 5.4 `ui-workspace`：workspace 风格 + 全局 hook（`packages/client/ui-workspace/src/client/`）

- `index.ts`：`export const inject = ['slots', 'sessions', 'workspaces', 'locale']`；注入 `WorkspaceBrowserInjected` 含 `startSession/open/searchSessions/renameSession/forkSession/renameWorkspace/deleteWorkspace/archiveSession/createWorkspace` 等回调（`ctx.workspaces.*`/`ctx.sessions.*`），以及 `hooks: { directoryFlow }`。
- `WorkspaceBrowser.tsx`：props 解构 `wide, expandSidebar, useSessions, useWorkspaces, useStore, actions, ...`；`useSessions(s => s)` 得 `SessionListState`（`{ ids, byId, current, phase }`）；`useWorkspaces(state => state.items)` 得 `WorkspaceView[]`（含 `sessionIds` 成员表）；分组依据 = `workspace.sessionIds`（非 cwd）；搜索 `ctx.sessions.search(query, signal)`（`searchResultLimit`）；header 用 `IconSearchOutline16`/`ViewOptionsMenu(Menu)`/`IconProjectAddOutline16`；列表用 `StateDot`/`DisclosureRow`/`Menu`/`Modal`/`Tooltip`。
- 结论：sandore `WorkflowPanel` 的 header（搜索 + 编排 toggle + 新增）与「实例按工作区分组」可直接照此自绘；`useSessions`/`useWorkspaces` 来自 slot props（`sidebar.footer.action` 的 `PropsRuntime` 提供 `useSessions`；`useWorkspaces` 需 `ui` 插件声明 `workspaces` 依赖——`ui-workspace` 的 `inject` 含 `workspaces`，而当前 sandore `ui/src/client/index.ts` 的 `inject` 仅 `['slots', 'locale']`，**需补 `sessions` 与 `workspaces`（若做工作区分组）**）。

### 5.5 `ui-primitives` 导出清单（`packages/client/ui-primitives/src/index.ts`）

可 import 的组件/工具（Task 5 自绘时复用）：

- 状态：`StateDot` / `StateDotState`（`'ongoing'|'done'|'error'|'warning'` 等，sandore 已用）。
- 布局/交互：`DisclosureRow`、`Button`（`variant: 'primary'|'outline'` 等，`size: 'sm'`）、`Pill`、`Input`、`Menu`（`MenuEntry/MenuItem/MenuSeparator/MenuLabel`）、`useAnchoredMaxHeight`、`HoverCard`、`Modal`、`Tooltip`（`TooltipSide`）、`Toast`、`RiskConfirmation`、`OnboardingSurface`、`ConnectionBanner`。
- Markdown/消息：`MarkdownText`（`MarkdownCodeLabels/MarkdownFileMentions`）、`MessageText`、`CodeBlock`、`JsonBlock`、`JsonTree`、`extractMarkdownPlainText`。
- 块渲染：`TerminalBlock`/`ReadBlock`/`DiffBlock`/`SearchBlock`/`WebBlock`。
- 图标（`icons/index.tsx` `export *`）：sandore 已用 `IconBranchOutline16`/`IconPlusOutline16`；ui-workflow-run 用 `IconChevronRightOutline14`；ui-cordis 用 `IconCordisPluginOutline14`/`IconCheckOutline16`/`IconCloseOutline16`/`IconPlayOutline16`/`IconStopFill16`/`IconTrashOutline16`；ui-workspace 用 `IconSearchOutline16`/`IconCloseFill14`/`IconPersonalizationOutline16`/`IconProjectAddOutline16`。
- 其他：`writeClipboard`、`FishLogo`、`BrandWordmark`。

### 5.6 `cordis.yml` 格式（DSH 实测）

参考 `examples/web-cordis/cordis.yml`：

```yaml
# PATCH OVERLAY（dsh web --patch 应用），非 tree
- id: webserver            # 覆盖已有行（替换整行 config）
  config: { host: 127.0.0.1, port: 3081 }
- insert:                  # 追加插件行
    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
```

- 挂载 4 包即照 design.md §7.1 的 `- insert:` 列表（`id` + `name` + 可选 `config`）。
- **sandore 仓库当前无 `cordis.yml`**，Task 5 需在仓库内新建一个参考/固化配置（或文档），并遵循「不改 DSH 源码」约束。

---

## 六、关键结论

1. **Task 5 是「新建 5 个前端组件 + 改造 2 个既有前端文件 + 新建 cordis.yml 挂载」**：`ui` 包现有 `WorkflowButton`/`WorkflowPanel` 仅为 Task 1 的 ping 占位；`InstanceList`/`DefinitionList`/`DagEditor`/`RunView`/`DagStepNodeView` 5 个组件全部缺失；`host.ts` 的 `HostCall` 桩需接入 `ctx.remote` 生成贡献（`host.call('sandore.*')`）。

2. **Host 侧已为前端备好全部数据源**：`SandoreRemote` 提供定义/Job/实例 CRUD + 交互/生命周期/产物/Provider RPC（唯一缺口是 design.md §6.2 里的 `getDiscussion`/`addChatMessage`——D8/D9 已用 Session 事件取代，非遗漏）；`sandore/step-completed` 事件 payload 已内联 `output: ContentBlock[]`（子代理最终结果），D8 讨论面板数据源就绪；`sandore/*` 13 事件全部已 emit 双发。

3. **D8 讨论面板机制照抄 `ui-workflow-run`**：`conversationEvents.register(ConversationNodeDefinition)` + `ctx.slots.inject('conversation.chat.node', { key: 'sandore-step', inject: () => ({ openSession }) })` + `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { ChatNodeDataMap }`；renderer props 含 `node`/`sessionId`/`useSessions`。

4. **`ui` 包的 `dsh.client.inject` / `inject` / `peerDependencies` 需补**：当前 `inject = ['slots', 'locale']`，需补 `sessions`（+ 若做工作区分组则 `workspaces`，+ D8 则 `conversationEvents`）；`package.json` 的 `dsh.client.inject` 需补 `dsh-client-ui-slots`/`dsh-client-ui-primitives`/`dsh-client-ui-conversation`（D8）/`dsh-client-sessions`（若独立包）等，`peerDependencies` 补 `dsh-client-ui-conversation`。

5. **挂载固化落点**：sandore 仓库**无 `cordis.yml`**，需新建；格式照 `examples/web-cordis/cordis.yml` 的 `- insert:`（4 包 `id` + `name` + `workflow` 的 `config`）。「移除动态插件原型」对应替换 `ui/src/client/index.ts` 里的本地 JSON `host` 桩为真实 RPC（当前即动态桩，无独立动态原型文件需删除）。

6. **一处需注意的差异**：design.md §5.2 提到的宿主会话标题「工作流实例 xxx（`sessionTitle.rename` 设置）」在当前引擎**未实现**（无 `session.rename`/`sessionTitle` 调用），Task 5 实现「打开讨论」按钮时需确认宿主会话在侧边栏的可辨识标题是否要补设。
