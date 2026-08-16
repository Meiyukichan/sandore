# Task 4 生命周期 — 仓库材料探索报告

> 探索类型：repository
> 目标仓库：`D:\project-code\llm\sandore`（sandore DSH 插件仓库）+ `D:\project-code\llm\deepseek-harness`（DSH 参考源码）
> 任务来源：`docs/design/task-4-lifecycle/work.md`
> 输出文件：`furina/changes/task-4-lifecycle/explore-design/repository.md`

---

## 一、需求理解（Phase 2）

### 1. What（要理解什么）

Task 4 在 Task 3 完整 DAG（agent/skill/mcp 可续接子代理 + 分支/循环 + Finalize 拆分）之上，补齐工作流引擎的**完整生命周期能力**：

1. **交互**：问答（SDK 原生 question + FinalizeAssessor 的 askUserQuestion）、权限（permission preset 继承）——`pendingQuestions`/`pendingPermissions` 登记 + `replyQuestion`/`replyPermission` 回复路径。
2. **暂停/恢复/中止**：`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps` + 引擎自建**暂停登记表**（`pausedChildIds`，DSH 无 paused 状态）。
3. **重试**：`retryStep` 三种模式 continue（`followup`）/ revert（`sessions.fork` + `agents.create({ seed })`）/ fork（`sessions.fork` + 新 agent）。
4. **崩溃恢复**：`recoverOrphanedInstances`（启动扫描 storageDomain `state` 表）+ `ctx.agents.resume({ resumeSessionId: hostSessionId })` 冷恢复宿主主代理 + `followup` 冷恢复子代理。
5. **宿主主代理（D9）**：宿主 Session 经 `ctx.agents.create({ sessionId, meta: { cwd }, setup(agentCtx) })` 创建，`completed` 后自然降级为自由对话（无 DefaultSessionManager）。
6. **消息聚合**：讨论面板 `sandore-step` Chat 节点（D8，复用 `ui-workflow-run`）。

产出落在两个包：

- `packages/sandore/workflow/`：`interaction-manager.ts`、`lifecycle-manager.ts`、`recovery-manager.ts`、`host-agent.ts`。
- `packages/sandore/tool/`：**8 个 `sandore_*` 模型工具**（per-instance 闭包捕获 `instanceId`，经 `agents.create({ setup })` 注册）：`sandore_getState` / `sandore_startInstance` / `sandore_abortInstance` / `sandore_pauseStep` / `sandore_resumeStep` / `sandore_pauseAllSteps` / `sandore_resumeAllPaused` / `sandore_retryStep`。

### 2. Boundaries（探索范围）

- 范围：sandore 仓库当前代码状态（Task 3 已落地文件）+ `./furina/` 归档（Task 1/2/3 历史参考）+ Task 4 权威规格（`docs/design/task-4-lifecycle/design.md`）+ `docs/engine/dsh-workflow.md` §5.1A/§5.3/§5.3A/§5.5/§6.4/§10.2 + `docs/design/overall-design.md` §4.2/§6.9/D5/D8/D9 + DSH 源码中 Task 4 所需 `ctx.*` 服务（`ctx.agents.create/resume`、`ctx.subagents.interrupt/followup/listChildren`、`packages/interaction`）。
- 不在范围：前端 UI（Task 5）、YAML 定义/Job CRUD（Task 2 已交付）。

### 3. Goal（探索目的）

准确掌握 Task 4 的落点与 DSH API 真实面，回答：

- Task 3 已落地代码的确切状态（哪些文件/字段已就绪，哪些是 Task 4 的新增/改造点，特别是 8 个 `not implemented` 引擎方法）。
- 宿主主代理的精确 DSH API（`ctx.agents.create({ sessionId, meta, setup })` / `resume({ resumeSessionId, setup })` / `Agent.inbox/status/whenIdle`）。
- 暂停/恢复/重试/崩溃恢复的 DSH 原语（`interrupt`/`followup`/`listChildren`/`sessions.fork`）。
- 交互 seam（`packages/interaction` 的问答/审批载体）。
- 当前接缝（`subagents.ts`）与 DSH 真实 API 的缺口（Task 4 需扩展的点）。

---

## 二、仓库材料配置与历史参考（Phase 3）

### 2.1 仓库材料配置

`furina config show exploration.repository` 返回单元素：

```json
[{ "path": "./furina/", "type": "directory", "description": "The location of Furina Artifacts ... archived changes and ongoing changes ..." }]
```

探索 `./furina/` 结果：

- `furina/changes.json`：当前 active change = `task-4-lifecycle`（`features: 0`、`todo: 0`、`artifacts: []`，`createdAt: 2026-08-16T04:50:42Z`）；archive = `task-1-skeleton`、`task-2-minimal-engine`、`task-3-full-dag`（均已 closed）。
- `furina/changes/task-4-lifecycle/` 目录当前为空（本探索产出目录 `explore-design/` 为新建）。
- 三个归档含完整 artifacts（proposal/design/specs/plan/api/explore-design/explore-coding）。

### 2.2 历史归档要点（Task 4 沿用）

> 由 `furina/archive/2026-08-15-task-{1,2,3}-*/design.md` + `explore-design/repository.md` 汇总。

- **命名空间（Task 1 确立，贯穿所有 Task）**：`ctx.sandoreEngine`（Service）/ `sandore/*`（13 事件，**Session 事件**，`session.append` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`）/ `sandore.*`（RPC，点号）/ `sandore_*`（工具，下划线，Task 4）/ 4 包。
- **Task 2 已交付**：类型体系（Zod schema 三层）+ YAML V1/V2 解析 + 定义/Job/实例 CRUD + `sandore` 存储域三表持久化 + shell/prompt Step 线性执行。
- **Task 3 已交付**：五类 Command（agent/skill/mcp 可续接子代理 + shell/prompt）、`resolveNextNodes` DAG 调度（Loop > Branches > Next > tryAdvanceStage）、LoopManager 扁平化循环、FinalizeManager（Assessor fork 会话 + GateEvaluator 双门）、`AskUserQuestionPayload`/`PendingQuestion`/`PendingPermission` 类型。
- **Task 3 明确留白给 Task 4**：交互回复路径（`replyQuestion`/`replyPermission` 真实等待循环，`finalizeOutcome.type === 'ask'` 仅标记 `interacting` 并中止 Stage）、暂停/恢复/重试、崩溃恢复、宿主主代理（`hostAgent`）、`tool`/`ui` 包。
- **关键决策**：D5（事件/SSE 全用 DSH，零自建）；D8（讨论面板复用 `ui-workflow-run` Chat 节点机制）；D9（主代理 = 工作流编排器，身份不切换，宿主 Session 自然延续为默认会话）；D3（Step 用可续接子代理）；D4（work.json → storageDomain `state` 表，chat.json → Session 事件日志）。

---

## 三、sandore 仓库现状（Task 3 已落地代码，Task 4 承接面）

`packages/sandore/` 4 个包，其中 `workflow`/`microflow` 已有实质实现，`tool`/`ui` 为占位：

```
packages/sandore/
├── workflow/src/
│   ├── index.ts          # 默认导出 SandoreEngineRuntime；re-export types/errors/schema/yaml/shell/seam/dag-navigator
│   ├── types.ts          # 13 基础类型 + PendingQuestion/PendingPermission/AskUserQuestionPayload（结构见下）
│   ├── schema.ts         # 三层 Zod Schema（定义/运行时/存储）
│   ├── yaml-parser.ts    # parseWorkflowYaml / serializeWorkflowYaml
│   ├── persistence.ts    # SandorePersistence：sandore 域三表（definitions/jobs/state）
│   ├── remote.ts         # SandoreRemote：定义/Job/实例 CRUD + 产物 + Provider 转发
│   ├── workflow-engine.ts# SandoreEngineRuntime：Stage 级线性主循环
│   ├── dag-navigator.ts  # WorkflowDagNavigator：resolveNextNodes + tryAdvanceStage
│   ├── seam.ts           # SandoreEngine 抽象类 + 13 事件双声明 + SandoreEngineStub
│   ├── shell.ts          # ctx.shell/ctx.subprocess 本地结构类型接缝
│   └── errors.ts         # re-export microflow 的 SandoreError
├── microflow/src/
│   ├── index.ts          # export errors/file-utils/branch-evaluator/finalize-manager/loop-manager/step-runner/stage-executor/subagents
│   ├── stage-executor.ts # StageExecutor：resolveNextNodes 驱动 DAG 调度循环
│   ├── step-runner.ts    # StepRunner：五类 Command（agent/skill/mcp 走可续接子代理）
│   ├── branch-evaluator.ts / loop-manager.ts / finalize-manager.ts / file-utils.ts / internal.ts / errors.ts
│   └── subagents.ts      # ctx.subagents/ctx.agents 结构接缝（Task 4 需扩展，见 §3.3）
├── workflow/tests/mocks/ # FakeLlm/FakeShell/FakeSession(Store)/MemoryStorageDomain/FakeAgentRegistry/FakeSubagents
├── tool/                 # 空占位（package.json + tsconfig.json，无 src/）
└── ui/                   # Client 占位（WorkflowPanel ping + WorkflowButton）
```

### 3.1 `seam.ts`：Service 面已完整声明，8 个方法为 `not implemented`

`SandoreEngine` 抽象类已声明 12 个实例级方法，`SandoreEngineStub` 全部抛 `not implemented`：

| 方法 | 现状 |
|---|---|
| `startInstance(request): DagRun` | **已实现**（workflow-engine.ts） |
| `getState(instanceId): DagInstanceState` | **已实现**（内存优先，state 表兜底） |
| `abortInstance(instanceId): Promise<void>` | **已实现**（AbortController.abort，终态拒绝） |
| `recoverInstance(instanceId)` | **not implemented**（`INVALID_OPERATION`）——Task 4 |
| `replyQuestion(instanceId, requestId, answers)` | **not implemented**——Task 4 |
| `replyPermission(instanceId, requestId, reply)` | **not implemented**——Task 4 |
| `pauseStep(instanceId, stepId)` | **not implemented**——Task 4 |
| `resumeStep(instanceId, stepId, resumePrompt?)` | **not implemented**——Task 4 |
| `pauseAllSteps(instanceId)` | **not implemented**——Task 4 |
| `resumeAllSteps(instanceId, resumePrompt?)` | **not implemented**——Task 4 |
| `retryStep(instanceId, stepId, mode, message)` | **not implemented**——Task 4 |

> 方法签名已定：`retryStep(instanceId, stepId, mode: 'continue'|'revert'|'fork', message)`；`replyPermission(... reply: 'once'|'always'|'reject')`。Task 4 是**实现**这些方法 + 新增 4 个 manager 文件，无需改 Service 面（但 `recoverInstance` 语义对应 work.md 的 `recoverOrphanedInstances` 启动扫描，需在 `recovery-manager.ts` 补充扫描入口）。

**13 事件双声明已全部就位**（`seam.ts` 中 Cordis `Events` + Session `SessionEventMap` 双声明），但 Task 4 专属事件**尚未有 emit 辅助函数**：

| 事件 | 声明 | 现状 |
|---|---|---|
| `sandore/start` / `stage-start` / `stage-completed` / `step-start` / `step-completed` / `step-failed` / `end` | 已声明 | **已 emit**（workflow-engine.ts 的 `emitXxx` 私有方法 + `emitContained` + `safeAppend`） |
| `sandore/aborted` | 已声明 | **已 emit**（abort 路径） |
| `sandore/question` / `sandore/permission` | 已声明 | **未 emit**（Task 4 interaction-manager） |
| `sandore/step-paused` / `step-resumed` / `step-retried` | 已声明 | **未 emit**（Task 4 lifecycle-manager） |

### 3.2 `workflow-engine.ts`：主循环无 hostAgent、无暂停点、无交互等待

关键现状（与 Task 4 直接相关）：

1. **宿主 Session 用 `sessions.create`，非 `agents.create`**（第 163 行）：
   ```ts
   const session = this.ctx.sessions.create(SessionId(instanceId), { meta: { cwd } });
   ```
   → D9 的「宿主主代理」完全缺失：无 `ctx.agents.create({ sessionId, meta: { cwd }, setup })`，无 `hostAgent` 引用，无 `sandore_*` 工具注册，无 `systemPrompt.section`。

2. **`ActiveInstance` 结构**（第 42-48 行）仅 `{ controller, session, definition, state }`——无 `hostAgent`/`hostHandle`/`pausedChildIds`/`pendingQuestions`/`pendingPermissions` 内存态。

3. **`runInstance`（第 256-394 行）是单一线程的 Stage while 循环**：
   - `StageExecutor.execute()` 内部同步执行完整个 Stage（`await` 每个 Step 直到 `child.whenIdle()`），引擎无法在 Step 执行中途注入 interrupt/followup。
   - `finalizeOutcome.type === 'ask'` 时（StageExecutor 返回 `status: 'interacting'`），引擎标记 `interacting` 后 **直接 `return`**（第 365-371 行），**无等待循环、无 `PendingQuestion` 注入、无回复续跑**——这是 Task 4 交互等待的接缝点。
   - `result.status === 'failed'` 直接落 `failed`/`aborted` 终态，无 retry 分支。

4. **事件双发已实现**：`emitContained(name, args)` 走 `ctx.events.dispatch('emit', ...)`；`safeAppend(fn)` 走 `session.append(...)`。Task 4 只需按同一范式补 4 个 emit 辅助函数。

5. **`persistState`**：全量覆盖写 `persistence.saveWorkflowState(active.state)`（`state.put(taskId, state)`），崩溃恢复的快照来源已就位。

### 3.3 `subagents.ts` 接缝：与 DSH 真实 API 的缺口（Task 4 需扩展）

当前接缝（本地结构类型，无 DSH 运行时依赖）已声明：

- `Agent`：仅 `{ id, options, session, status, whenIdle }`。
- `AgentRegistry`：`{ get, create, resume }`；`CreateAgentOptions` 仅 `{ sessionId, agentOptions?, signal? }`；`ResumeAgentOptions` 仅 `{ resumeSessionId, agentOptions?, signal? }`。
- `SubagentRuntime`：`{ startContinuable, followup, interrupt, start }`；`interrupt` authority 已对齐 `{ kind:'user', parentSessionId } | { kind:'ancestor', agent }`。

**Task 4 需扩展的缺口**（经 DSH 源码 `packages/core/agent/src/index.ts` / `runtime-types.ts` 实证）：

| 接缝项 | 现状 | DSH 真实 API（需补） |
|---|---|---|
| `CreateAgentOptions` | 无 `meta`/`setup`/`seed` | `meta?: { cwd?, parentSession?, seedLength?, origin?: 'subagent', delegationDepth?, agentPreset? }` + `seed?: readonly SessionEvent[]` + `setup?: AgentSetup`（`(agentCtx: Context) => ...`） |
| `ResumeAgentOptions` | 无 `setup` | `setup?: AgentSetup` |
| `Agent` | 无 `inbox`/`ctx`/`cancel`/`send`/`followup`/`steer`/`inject` | 完整 live-agent（`status: 'idle'|'running'`、`inbox: Inbox`、`ctx`、`cancel(cause, opts)`、`whenIdle()` 等） |
| `SubagentRuntime` | 无 `listChildren` | `listChildren(parentId)`（`list-children.spec.ts` 已实证） |

> 注意：`startContinuable` 的 `ContinuableStartSpec` **无权限字段**（与 design.md §1.4 一致，子代理继承宿主 Session preset，approval 固定 `never`）。

### 3.4 schema/types：交互/暂停字段的现状与缺口

**已就绪**：

- `WorkflowTaskStateSchema`（schema.ts 第 322-344 行）已含：`status`（7 态 DagRunStatus，含 `interacting`/`paused`）、`pendingInteractions: z.array(z.unknown())`、`pausedStepIds: z.array(z.string())`、`stageContracts`、`activeLoopStack/activeLoopIterationStack` 等。
- `ExecutedStepDefaultSchema` 已含：`status`（7 态 StepStatus 含 `interacting`/`paused`）、`sessionMeta`（`{ childId, synthetic, command }`）、`finalizeMeta`、`retryHistory?: RetryRecord[]`（含 `mode: continue|revert|fork`/`timestamp`/`userMessage`/`revertMessageId?`/`result`）、`parentSessionId?`、`pausedAt?`/`resumedAt?`/`resumePrompt?`/`sessionMessages?`/`pauseEntryId?`。
- `RetryRecordSchema` 三模式已定义（Task 3 预留）。
- `types.ts` 已含 `PendingQuestion { stepId, sessionId, requestId, questions: AskUserQuestionPayload }`、`PendingPermission { stepId, sessionId, requestId, permission, patterns?, metadata?, tool? }`、`AskUserQuestionPayload`（对齐 DSH `ask_user_question` schema）。

**Task 4 需补/改**：

- **暂停登记表字段**：overall-design §4.3.1 明确迁移后 `pausedStepIds` 改名/升级为 `pausedChildIds`（引擎自建权威记录，DSH 无 paused 状态）。当前 schema 仅有 `pausedStepIds`，无 `pausedChildIds`（需决定复用或改名）。
- **交互登记结构**：`pendingInteractions` 当前为 `z.array(z.unknown())` 占位，Task 4 的 interaction-manager 需落为 `pendingQuestions`/`pendingPermissions` 结构化条目（design.md §1.1/§1.2 的 Map + `status: 'pending'|'replied'|'rejected'`/`answer` 字段）。
- `PendingQuestion`/`PendingPermission` 类型较 design.md §1.2 精简（缺 `id`/`stageId`/`status`/`answer`），Task 4 需按 interaction-manager 的实际登记需要扩展。

### 3.5 `tool` / `ui` 包现状

- `tool/package.json`：仅 `name: @deepseek-ai/dsh-sandore-tool` + `description: "sandore workflow engine model tools (placeholder)"`，**无 `src/` 目录**。Task 4 在此落地 8 个 `sandore_*` 工具（需同时确认 `defineTool` 来源，DSH `@deepseek-ai/dsh-tools` / `packages/core/tools`）。
- `ui/`：`WorkflowPanel.tsx` 为占位（ping 往返 + 三态列表），`host.ts` 仅 `HostCall`/`isPingResponse`。讨论面板 `sandore-step` 节点（D8）属 Task 5，本 Task 不涉及。

### 3.6 错误体系现状

`SandoreErrorCode`（microflow/src/errors.ts）现有 12 个码：`YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`CANCELLED`/`FINALIZE_FAILED`/`GATE_FAILED`/`SESSION_LOST`/`PERSISTENCE_FAILED`。Task 4 的暂停/重试/恢复若需新错误码（如 `RECOVERY_FAILED`），需在此扩展（`SESSION_LOST` 已预留，可复用）。

---

## 四、Task 4 权威规格要点（`docs/design/task-4-lifecycle/design.md` + work.md）

### 4.1 产出清单（work.md）

| 包 | 文件 | 内容 |
|---|---|---|
| workflow | `interaction-manager.ts` | `pendingQuestions`/`pendingPermissions` Map + `addPendingQuestion/Permission` → `sandore/question`/`sandore/permission` 事件 + `replyQuestion`/`replyPermission` |
| workflow | `lifecycle-manager.ts` | `pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps` + **暂停登记表**（`pausedChildIds`，DSH 无 paused 状态，引擎自建并持久化） |
| workflow | `recovery-manager.ts` | `recoverOrphanedInstances`（启动扫描 storageDomain `state` 表）+ 崩溃恢复 |
| workflow | `host-agent.ts` | 宿主主代理——`ctx.agents.create({ sessionId, meta: { cwd }, setup(agentCtx) })` + `sandore_*` 工具注册（D9） |
| tool | 8 个 `sandore_*` 工具 | per-instance 闭包捕获 `instanceId`，经 `agents.create({ setup })` 注册（非 preset standing mount） |

### 4.2 关键决策（D5/D8/D9）

- **D5**：事件/SSE 全用 DSH，零自建——删除 `WorkflowEventBus`/`WorkflowSseManager`/`SdkSseManager`（Task 3 已无此三套，只需保持 `emitContained` + `session.append` 双发范式），改用 `sandore/*` Session 事件 + apiproxy 双 SSE 流 + `ctx.sessionProjections`。
- **D8**：讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制（`ConversationNodeDefinition` + `conversation.chat.node` keyed，`sandore-step` 节点）。引擎侧只需保证 `step-completed` 事件 payload 内联子代理最终结果（Task 3 已就位）。
- **D9**：主代理 = 工作流编排器，身份不切换——广播恢复改为「自然语言 → 主代理显式调用 `sandore_*` 工具」；「默认挂载会话」= 宿主 Session 在 `completed` 后自然降级为自由对话（**无 DefaultSessionManager**、无 `default-session-mounted` 事件）；暂停登记表由引擎自建。

### 4.3 核心映射（design.md）

| sandore 能力 | DSH 等价组件 |
|---|---|
| `pause` | `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })` |
| `resume` | `ctx.subagents.followup(hostAgent, childId, ...)` |
| 重试 `continue` | `ctx.subagents.followup(hostAgent, childId, [{type:'text',text:message}], {source,signal})` |
| 重试 `revert` | **DSH 无 revert 原语**：`ctx.sessions.fork(childId, turn边界)` + `ctx.agents.create({ seed })`（产生新 session id，回退粒度 turn 边界） |
| 重试 `fork` | `ctx.sessions.fork(childId, boundary?)` → 新 agent 续跑 |
| 崩溃恢复（宿主） | `ctx.agents.resume({ resumeSessionId: hostSessionId })` 冷恢复（`setup` 重跑 → 工具/instanceId 闭包重注册） |
| 崩溃恢复（子代理） | `ctx.subagents.followup(hostAgent, childId, ...)`（对 absent child 自动从持久化 Session 恢复）；或 `listChildren(hostSessionId)` |
| Step 完成等待 | `ctx.agents.get(childId).whenIdle()` + `finalAssistantOutput(child.session.events)` |
| 交互 | DSH 交互 seam（`PendingWait<'question'/'approval'>` 载体；`PendingQuestion.answer()` 已导出；审批卡片自写） |
| 权限 | **无 `permissionMode`**——子代理继承宿主 Session permission preset，approval 固定 `never` |
| `work.json` | `ctx.storageDomain` 的 `state` 表（`saveWorkflowState` 已实现） |
| `chat.json` | DSH Session 事件日志（`sandore/*` append） |

### 4.4 验证标准（Task 4 完成门槛）

- 暂停/恢复/重试（continue/revert/fork 三模式）/崩溃恢复全链路可用。
- 交互（问答/权限/askUserQuestion）全链路可用。
- 宿主主代理：`completed` 后自然降级为自由对话；`sandore_*` 工具仅挂宿主 Session（per-instance），不影响普通会话。
- 讨论面板 `sandore-step` 节点正确渲染（复用 `ui-workflow-run`）。

---

## 五、DSH 源码关键 API 实证（Task 4 依赖，源码 `D:\project-code\llm\deepseek-harness`）

### 5.1 `ctx.agents.create` / `resume`（`packages/core/agent/src/index.ts`）

```ts
interface CreateAgentOptions {
  readonly sessionId: SessionId
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string     // ★ 宿主会话 preset 标记
  }
  readonly seed?: readonly SessionEvent[]   // ★ revert 重试：fork 前缀 seed
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup                // ★ (agentCtx: Context) => AgentSetupCommit | Promise<...> | void
}

interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup                // ★ 冷恢复时 setup 重跑
}
```

- `meta.cwd` **必填**（dsh-workflow.md §5.1A 探索确认：`session.list` 对持久化会话过滤 `meta.cwd !== undefined`，无 cwd 的宿主会话重启后不可导航）。
- `setup` 语义：factory 在 mint `agentCtx` 后、发布 session/agent **之前** await setup——setup 内注册的一切（scoped tools、`systemPrompt.section`、listeners）在 `session/created`/`agent/created`/首轮 prompt 组装前就绪；`resume` 会**重新执行 setup**（D9 崩溃恢复的关键）。

### 5.2 `Agent` live 句柄（`packages/core/agent/src/runtime-types.ts`）

```ts
interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: Inbox          // ★ 辅助信号：hasPending
  readonly status: 'idle' | 'running'   // ★ 仅两态，无 paused/interacting（§6.9 登记表依据）
  readonly ctx: Context
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}
```

> **确认**：`AgentStatus` 仅 `'idle' | 'running'`（无 paused），与 overall-design §6.9「暂停登记表引擎自建」结论一致。

### 5.3 `ctx.subagents.interrupt` / `followup` / `listChildren`

- `interrupt(targetSessionId, authority)`：authority `{ kind:'user', parentSessionId } | { kind:'ancestor', agent: Agent }`（与 sandore 接缝一致）。
- `followup(parent, childId, content, options)`：`options = { source: MessageSource, signal: AbortSignal }`；对 absent child 自动从持久化 Session 冷恢复。
- `listChildren(parentId)` 已存在（`packages/subagent/subagent/tests/list-children.spec.ts` 实证，返回 `{ childId, activity: 'running'|'inactive', ... }` 条目）——崩溃恢复枚举 durable 子代理用。

### 5.4 `ctx.sessions.fork`（`packages/core/session/src/index.ts`，Task 3 已实证）

`fork(source: Session | SessionId, boundary?: number, childSessionId?: SessionId): Session`——boundary 为 inclusive source seq，省略取源最后一条事件，不能落未闭合 turn（否则 OPEN_TURN）。Task 4 的 revert/fork 重试 + finalize fork 均复用。

### 5.5 交互 seam（`packages/interaction/`）

- `user-questions`（`packages/interaction/user-questions/src/index.ts`）：`AskUserQuestionRequest`/`AskUserQuestionOption`/`AskUserQuestionItem`/`AskUserQuestionAnswer` + `UserQuestionService`（`@deepseek-ai/dsh-user-questions`）。`AskUserQuestionPayload` 的 schema 已对齐（sandore `schema.ts` 第 192-203 行）。
- `user-approval`（`packages/interaction/user-approval/src/index.ts`）：`ApprovalPolicy = 'ask' | 'never'`、`ApprovalRequest`、`ApprovalService`。
- design.md §1.6 确认：`PendingQuestion`（`ui-user-questions` 已导出）驱动自写问答卡片；`PendingWait<'approval'>` 驱动自写审批卡片；审批卡片/问答卡片为 Task 5 UI。

---

## 六、关键结论

1. **Task 4 是「实现 + 扩展」而非「新建 schema」**：`SandoreEngine` 的 8 个生命周期方法签名已定（均 `not implemented`），13 事件已双声明（4 个未 emit），`RetryRecord`/`pendingInteractions`/`pausedStepIds`/`PendingQuestion`/`PendingPermission`/`AskUserQuestionPayload` 字段已预留。主要工作在**运行逻辑与接线**。

2. **Task 4 需新建 4 个文件（workflow）+ 1 个新包内容（tool）**：
   - `workflow/src/interaction-manager.ts`、`lifecycle-manager.ts`、`recovery-manager.ts`、`host-agent.ts`（附录 B 文件对照已预置落点）。
   - `tool/src/`（8 个 `sandore_*` 工具 + index）。

3. **需改造的既有文件**：
   - `workflow-engine.ts`：`startInstance` 从 `sessions.create` 改为 `agents.create({ sessionId, meta: { cwd }, setup })`；`ActiveInstance` 增补 `hostAgent`/`hostHandle`/暂停登记表/交互登记表；实现 8 个方法；补 4 个 emit 辅助函数；`runInstance` 的 `interacting`/`failed` 分支接入交互等待与重试。
   - `subagents.ts` 接缝：`CreateAgentOptions`/`ResumeAgentOptions` 补 `meta`/`seed`/`setup`；`Agent` 补 `inbox`/`ctx`/`cancel`/`send`/`followup`/`steer`/`inject`；`SubagentRuntime` 补 `listChildren`。
   - `schema.ts`（可选）：`pendingInteractions` 占位 → 结构化交互条目；`pausedStepIds` → 升级/新增 `pausedChildIds` 登记表；`PendingQuestion`/`PendingPermission` 视需扩展 `status`/`answer`/`id`/`stageId`。
   - `tests/mocks/agents.ts`/`subagents.ts`：同步扩展 `setup`/`meta`/`listChildren`/`inbox` 桩。

4. **DSH 原语已逐一确认**：
   - `agents.create({ sessionId, meta: { cwd, agentPreset? }, setup })` / `agents.resume({ resumeSessionId, setup })`（setup 重跑是 D9 崩溃恢复关键）。
   - `interrupt(childId, { kind:'ancestor', agent: hostAgent })` 暂停；`followup(hostAgent, childId, ...)` 恢复/continue；`sessions.fork(childId, boundary?)` revert/fork；`agents.create({ seed })` revert 续跑。
   - `whenIdle()` + `finalAssistantOutput(child.session.events)` 等待与读输出（Task 3 已实现，可复用）。
   - `Agent.status` 仅 `idle`/`running` → 暂停登记表必须引擎自建并持久化。
   - 交互/权限由 DSH `packages/interaction` + permission presets 承担，引擎不建 pending UI。

5. **验证标准落点**：暂停/恢复/重试三模式/崩溃恢复 → §4.3 映射 + design.md §9.2–9.4；交互 → §4.1/§4.3 + design.md §9.1；宿主主代理自然降级 + per-instance 工具隔离 → §4.2 D9 + design.md §9.5；讨论面板 → §4.2 D8（Task 5 UI，本 Task 保证事件 payload 内联结果）。
