# Task 4 生命周期 — 规范材料探索结果

## 一、需求理解（Explore Content）

**What（是什么）**
Task 4 在 Task 3 完整 DAG 之上，补齐工作流引擎的完整生命周期能力：交互（问答/权限/askUserQuestion）+ 暂停/恢复/中止 + 重试（continue/revert/fork 三模式）+ 崩溃恢复（断点续传）+ 宿主主代理（默认会话自然延续，D9）+ 消息聚合（多 session 讨论数据）。产出落在 `workflow` + `tool` 两包。

**Boundaries（范围）**
- `packages/sandore/workflow/`：`interaction-manager.ts`、`lifecycle-manager.ts`、`recovery-manager.ts`、`host-agent.ts`。
- `packages/sandore/tool/`：8 个 `sandore_*` 模型工具（per-instance 闭包捕获 `instanceId`，经 `agents.create({ setup })` 注册）。
- 硬约束：纯插件不改 DSH 源码、零外部 Agent SDK、全用 DSH `ctx.*` 服务；命名沿用 `ctx.sandoreEngine` / `sandore/*`（13 事件）/ `sandore_*`（工具）/ `sandore.*`（RPC）。

**Goal（目标）**
摸清当前引擎（Task 2/3）已具备的 seam/类型/schema/持久化/RPC 现状，以及 DSH `ctx.agents`/`ctx.subagents`/`ctx.userQuestions`/`ctx.approval`/`ui-workflow-run` 的权威 API 形状，从而准确界定 Task 4 的落地缝隙与映射关系。

---

## 二、当前 sandore 工程现状（Task 2/3 已有产物）

### 2.1 包结构

`packages/sandore/` 下已有 4 包：`workflow`、`microflow`、`tool`、`ui`。

- `workflow`：seam.ts / types.ts / schema.ts / persistence.ts / remote.ts / workflow-engine.ts / dag-navigator.ts / errors.ts / yaml-parser.ts / shell.ts（已完成）。
- `microflow`：step-runner.ts / branch-evaluator.ts / loop-manager.ts / finalize-manager.ts / file-utils.ts / subagents.ts / stage-executor.ts / internal.ts（已完成）。
- `tool`：**占位包**——只有 `package.json` + `tsconfig.json`，**无 `src/`**（Task 4 需创建 8 个工具）。
- `ui`：client 侧占位（Task 5 范畴）。

### 2.2 seam（`workflow/src/seam.ts`）——Task 4 接口已声明、实现为空

`SandoreEngine` 抽象 Service 已声明全部 Task 4 实例级方法（抽象方法 + Stub 桩）：

- `recoverInstance(instanceId)`、`replyQuestion(instanceId, requestId, answers)`、`replyPermission(instanceId, requestId, reply)`、`pauseStep`、`resumeStep`、`pauseAllSteps`、`resumeAllSteps`、`retryStep(instanceId, stepId, mode, message)`、`getState`、`startInstance`、`abortInstance`。

13 个 `sandore/*` 事件已在 `seam.ts` 中**双声明**（Cordis `Events` + `SessionEventMap`，第 29–62 行），含 Task 4 需要的 `sandore/question`、`sandore/permission`、`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`、`sandore/aborted`。

`SandoreEngineStub.inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`（与 dsh-workflow.md §8.3 一致，**无 `agents`/`userQuestions`/`approval`/`sessionTitle`**——Task 4 宿主主代理与交互需要补充注入或 `ctx.get()` 软依赖）。

### 2.3 运行时（`workflow/src/workflow-engine.ts`）——8 个方法均为 stub

`SandoreEngineRuntime` 实现了 `startInstance` / `getState` / `abortInstance`，其余 8 个方法（`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`）全部抛 `SandoreError('not implemented', 'INVALID_OPERATION')`。

关键现状点：

1. **宿主 Session 是裸 Session，不是真 Agent**：`startInstance` 用 `this.ctx.sessions.create(SessionId(instanceId), { meta: { cwd } })`（第 163 行）创建宿主 Session，**未走 `ctx.agents.create`**。这是 D9 的最大缝隙——主代理编排器工具、`interrupt` authority、`followup` parent 都需要一个 live `hostAgent`。
2. **事件双发已就位（D5 范式）**：`emitContained`（`ctx.emit`）+ `safeAppend`（`session.append`）双发 `sandore/*`。
3. **`interacting` 已预留断点**：`runInstance` 中 `result.status === 'interacting'`（ask 判定）时置 `status='interacting'` 后 `return`（第 365–371 行），注释「Task 4 接续」。
4. `persistState` 走 `SandorePersistence.saveWorkflowState`；内存 `instances: Map<string, ActiveInstance>`（`controller` + `session` + `definition` + `state`）。
5. 无 lifecycle/interaction/recovery 三管理器、无 `pausedChildIds` 登记表、无崩溃恢复扫描。

### 2.4 类型与 schema（`types.ts` / `schema.ts`）

- `WorkflowTaskStateSchema` **已含** `pendingInteractions: z.array(z.unknown())` 与 `pausedStepIds: z.array(z.string())`（第 333、340 行）——正是 Task 4 交互 pending Map 与暂停登记表的持久化落点。
  - 注意：`pendingInteractions` 目前是宽松 `unknown[]`，Task 4 需定义并收紧 `PendingQuestion`/`PendingPermission` 的运行时 schema。
- `types.ts` 已有 browser-safe 的 `PendingQuestion` / `PendingPermission` / `DagRunStatus`（含 `'interacting'`/`'paused'`）/ `StepStatus`（含 `'interacting'`/`'paused'`）/ `DagInstanceState` / `ExecutedStepDefault`（已含 `pausedAt`/`resumedAt`/`resumePrompt`/`pauseEntryId`/`retryHistory`/`parentSessionId`/`sessionMessages` 等 Task 4 字段）。
- `AskUserQuestionPayloadSchema` 用 `multi_select`（snake_case，对齐 DSH `ask_user_question` **工具参数**；DSH TS 类型 `AskUserQuestionItem` 是 `multiSelect` camelCase）。

### 2.5 持久化（`persistence.ts`）与 RPC（`remote.ts`）

- `SandorePersistence` 暴露 `state: KvTable<string, WorkflowTaskState>`，`KvTable` 有 `entries()`/`get`/`put`/`delete`——`recoverOrphanedInstances` 用 `state.entries()`（或 `keys()`）扫描所有 instanceId 键，跳过终态。
- `SandoreRemote`（`sandore.*` RPC）当前仅有：`ping`、定义/Job CRUD、`listInstances`/`startInstance`/`deleteInstance`/`getInstanceState`/`abortInstance`、`getArtifacts`、`listProviders`/`listModels`。**缺少** dsh-workflow.md §7.2 所列的 Task 4 方法：`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`。

### 2.6 microflow 现状（Task 3 产物，Task 4 直接依赖）

- `subagents.ts`（本地结构类型 seam，非 DSH 包依赖）：
  - `SubagentRuntime`：`startContinuable` / `followup` / `interrupt` / `start`。
  - `AgentRegistry`：`get` / `create` / `resume`。
  - `CreateAgentOptions` 现仅 `{ sessionId, agentOptions?, signal? }`——**缺 `meta`/`setup`**；`ResumeAgentOptions` 现仅 `{ resumeSessionId, agentOptions?, signal? }`——**缺 `setup`**。Task 4 宿主主代理需要扩展这两个类型（含 `meta.cwd` 与 `setup(agentCtx)`）。
  - `Agent` 现为 `{ id, options, session, status, whenIdle }`——**缺 `inbox`/`ctx`/`cancel`/`send`/`followup`/`steer`**（辅助信号 `agent.status==='idle'` + `agent.inbox.hasPending` 依赖 `inbox`）。
  - `interrupt(targetSessionId, authority)` 的 `SubagentInterruptAuthority` 已对齐 DSH（`{ kind:'ancestor', agent } | { kind:'user', parentSessionId }`）；`SubagentFollowupOptions = { source, signal }` 亦对齐。
  - `finalAssistantOutput(events)` 已就位（读子代理最终输出用）。
- `step-runner.ts`：agent/skill/mcp 走 `startContinuable` → `agents.get(childId)` → `whenIdle()` → `finalAssistantOutput`；`StepRunnerConfig.hostAgent` 已存在（子代理 parent，缺省 `createHostAgentStub()` 桩）。
- `stage-executor.ts`：childId 合成规则——shell/prompt 用 `synthesizeChildId`（`step-{stepId}-{8hex}`），循环内用 `loopManager.getActualStepId`（`id-4hex` 后缀），agent/skill/mcp 用真实 `result.sessionMeta.childId`；`finalizeOutcome.type==='ask'` 时返回 `status:'interacting'`（第 346–350 行），注释「Task 4 接交互等待循环」。
- `finalize-manager.ts`：`FinalizeAssessor.assess` 已产出 `completionType:'ask'` + `askQuestion`（`AskUserQuestionPayload`）；`FinalizeManager.finalizeStep` 在 ask 时置 `executedStep.status='interacting'` 并 `persistFinalize(undefined)`。

---

## 三、DSH 权威 API（源码核实的映射依据）

> 源码位置：`D:\project-code\llm\deepseek-harness`

### 3.1 `ctx.agents`（`packages/core/agent/src/index.ts`、`runtime-types.ts`）

- `agents.create(options: CreateAgentOptions): Promise<AgentHandle>`：
  - `sessionId`、`meta?: { cwd?, parentSession?, seedLength?, origin?: 'subagent', delegationDepth?, agentPreset? }`、`seed?: SessionEvent[]`、`agentOptions?`、`signal?`、`setup?: AgentSetup`。
  - `AgentSetup = (agentCtx: Context) => AgentSetupCommit | Promise<...> | void`。setup 在 mint `agentCtx` 后、发布 session/agent 前 await，**注册 scoped tools/prompt sections 均存在后再发布**；rejection 整体回滚。
- `agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>`：
  - `resumeSessionId`、`agentOptions?`、`signal?`、`setup?: AgentSetup`。**resume 会重新执行 `setup`**（Task 4 崩溃恢复「工具/instanceId 闭包重注册」的依据）。
- `agents.get(id)`、`list()`、`roots()`、`isOwnedBy(id, owner)`。
- `Agent` 公开面：`id / options / session / inbox / status('idle'|'running') / ctx`；方法 `cancel(cause, opts?)`、`whenIdle()`、`runMaintenance(task)`、`send(message, target, wakeup)`、`followup(message)`、`steer(message)`、`inject(message)`。

### 3.2 `ctx.subagents`（`packages/subagent/subagent/src/index.ts`、`continuation.ts`、`list-children.ts`）

- `followup(parent: Agent, childId, content: ContentBlock[], options: { source, signal }): Promise<MessageId>` —— **absent child 自动从持久化 Session 冷恢复**（崩溃恢复子代理续接依据）。
- `interrupt(targetSessionId, authority): void` —— fire-and-return；absent target（含 one-shot/未知 id）为 no-op；`authority` 不拥有 target 时抛 `UNAUTHORIZED`。
- `listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>` —— 条目 `kind:'child'|'diagnostic'`、`activity:'running'|'inactive'`、`mode:'one-shot'|'continuable'`、`label`。
- `listDescendants(rootSessionId, signal?)`、`reportFrom(child, content, options)`、`registerContinuableSetup`、`drainContinuableDescendants`。
- `ContinuableStartSpec.request = Omit<SubagentStartRequest, 'label'|'signal'|'outputSchema'>`——**无权限字段**（子代理继承父级 preset，approval 固定 `never`）。

### 3.3 交互 seam（`packages/interaction`）

- 问答：`ctx.userQuestions.ask({ questions, agent?, signal? }): Promise<AskUserQuestionAnswer>`（`user-questions/src/index.ts`）。`AskUserQuestionItem = { id, question, detail?, header?, options?: {label, description?}[], multiSelect?, intent? }`；`AskUserQuestionAnswer.answers = [{ id, selected[], custom? }]`。
  - 模型工具 `ask_user_question`（`tool-ask-user/src/index.ts`）把工具参数 `multi_select`（snake）映射为 TS `multiSelect`（camel）。
  - apiproxy 把 ask 推为 `question/requested` 帧（`{ rpcId, sessionId, questions }`），前端回复经 `POST /api/respond` → `question/resolved`。
- 权限：`ctx.approval.request({ agent, toolName, callId?, reason?, signal? }): Promise<ApprovalOutcome>`（`user-approval/src/index.ts`）。`ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`；`ApprovalPolicy = 'ask'|'never'`。apiproxy 推 `approval/requested` 帧（含 `approvalId`/`toolName`/`callId`/`reason`），回复 `approval/resolved`。
- 前端载体：`PendingWait<'question'|'approval'>`（`client/runtime/src/client/sessions/pending.ts`，`respond()`/`markSettled()`）；`PendingQuestion` 领域类（`client/ui-user-questions/src/client/contract/slots.ts`，`key`/`questions`/`answer(answer)`/`cancel()`）。

### 3.4 讨论面板 D8 范本（`packages/client/ui-workflow-run/src/client/workflow-definition.ts`）

`ConversationNodeDefinition` 五件套：`kind` + `target:'chat'` + `match(event)` + `start/update` + `buildViewNode`，并经 `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { ... } }` 合并。sandore 的 `sandore-step` 节点照此模式实现（match `sandore/step-start|step-completed|step-failed|step-paused|step-resumed|step-retried`）。`ui-workflow-run` 的 Host 半是空 `apply(): void {}`（纯 browser 侧）。

---

## 四、关键决策与映射（来自 dsh-workflow.md / overall-design.md / task-4 design.md）

- **D5**：事件/SSE 全用 DSH，零自建——`WorkflowEventBus`/`WorkflowSseManager`/`SdkSseManager` 删除（当前代码已无这些文件，已符合）；`sandore/*` 是 **Session 事件**（`session.append` 写宿主 log，经 `SessionEventMap` 合并），`ctx.emit` 同名 Cordis 事件仅为进程内可选触发源。
- **D8**：讨论面板 = `sandore-step` Chat 节点（`ConversationNodeDefinition` + `conversation.chat.node` keyed），内联 `step-completed` payload 的 `output`（引擎在 append 前用 `ctx.sessions.get(childId)` + `finalAssistantOutput` 取好塞入），点击跳 `ctx.sessions.open(childId)`。
- **D9**：主代理 = 工作流编排器，身份不切换；广播恢复 = 自然语言 → 主代理显式调 `sandore_*`；「默认挂载会话」= 宿主 Session 在 `completed` 后自然降级为自由对话（无 DefaultSessionManager、无 `default-session-mounted` 事件）；`sandore_*` 工具 per-instance 挂宿主 Session（`agents.create({ setup })` 闭包捕获 instanceId），不影响普通会话。
- **暂停/恢复**：`pause` = `ctx.subagents.interrupt(childId, { kind:'ancestor', agent: hostAgent })` + 自建 `pausedChildIds` 登记表 + persist；`resume` = `ctx.subagents.followup(hostAgent, childId, content, { source, signal })`。登记表是「暂停集」唯一权威（DSH Agent 仅 `idle`/`running`，无 paused）。
- **重试**：continue = `followup`；revert = `ctx.sessions.fork(childId, turn边界)` + `ctx.agents.create({ seed })`（产生新 session id，回退粒度 turn 边界）；fork = `ctx.sessions.fork(childId, boundary?)`。
- **崩溃恢复**：`recoverOrphanedInstances` 扫描 storageDomain `state` 表 → 对非终态实例：`ctx.agents.resume({ resumeSessionId: hostSessionId })`（setup 重跑）冷恢复宿主主代理 + `followup` 冷恢复 running/interacting 子代理；paused 恢复登记表待手动 resume。
- **权限**：无 `permissionMode`——子代理继承宿主 Session 的 permission preset，approval 固定 `never`。

---

## 五、现状 → Task 4 需求 的缝隙清单（探索结论）

1. `packages/sandore/tool/` 无 `src/`，需创建 8 个 `sandore_*` 工具（`getState`/`startInstance`/`abortInstance`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllPaused`/`retryStep`），per-instance 闭包捕获 `instanceId`，经 `agents.create({ setup })` 注册（非 preset standing mount）。
2. `workflow-engine.ts` 的 8 个实例方法为 stub，需落地并接入 `interaction-manager`/`lifecycle-manager`/`recovery-manager`/`host-agent` 四模块。
3. 宿主 Session 需从裸 `ctx.sessions.create` 升级为 `ctx.agents.create({ sessionId, meta:{ cwd }, setup })` 的**真 Agent**（D9 主代理），并持有 live `hostAgent` 引用供 `interrupt`/`followup`/子代理 parent 使用；`StepRunnerConfig.hostAgent` 需接到该引用。
4. `subagents.ts` seam 的 `Agent`/`CreateAgentOptions`/`ResumeAgentOptions` 需扩展 `meta`/`setup`/`inbox`/`ctx` 等字段，才能支持宿主主代理创建与工具注册、以及 `inbox.hasPending` 辅助信号。
5. `WorkflowTaskState.pendingInteractions` 目前 `unknown[]`，需收紧为 `PendingQuestion`/`PendingPermission` 的运行时 schema（`pausedStepIds` 已有，作为 `pausedChildIds` 登记表的持久化字段）。
6. `remote.ts` 缺 Task 4 RPC：`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`（dsh-workflow.md §7.2 清单）。
7. `stage-executor`/`finalize-manager` 的 `ask` 路径目前只置 `interacting` 后返回，需在引擎侧接 `interaction-manager.addPendingQuestion` → `sandore/question` 事件 → 等 `replyQuestion` 后恢复执行的交互等待循环。
8. 无 `recoverOrphanedInstances` 启动扫描；需接 `SandorePersistence.state.entries()`（或 `keys()`）扫描非终态实例并冷恢复。

---

## 六、相关源文件索引（绝对路径）

**sandore 现状：**
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`（13 事件双声明 + SandoreEngine 抽象/Stub）
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts`（8 方法 stub + 裸宿主 Session）
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`（PendingQuestion/PendingPermission/DagRunStatus/ExecutedStepDefault）
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`（WorkflowTaskState：pendingInteractions/pausedStepIds）
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\persistence.ts`（state 表 KvTable）
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\remote.ts`（sandore.* RPC 现状）
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\subagents.ts`（ctx.subagents/ctx.agents 本地 seam）
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.ts` / `stage-executor.ts` / `finalize-manager.ts` / `loop-manager.ts`
- `D:\project-code\llm\sandore\packages\sandore\tool\package.json`（占位，无 src）

**DSH 权威参考：**
- `D:\project-code\llm\deepseek-harness\packages\core\agent\src\index.ts`、`runtime-types.ts`（ctx.agents.create/resume + Agent）
- `D:\project-code\llm\deepseek-harness\packages\subagent\subagent\src\index.ts`、`continuation.ts`、`list-children.ts`（followup/interrupt/listChildren）
- `D:\project-code\llm\deepseek-harness\packages\interaction\user-questions\src\index.ts`、`types.ts`（ctx.userQuestions）
- `D:\project-code\llm\deepseek-harness\packages\interaction\user-approval\src\index.ts`、`types.ts`（ctx.approval）
- `D:\project-code\llm\deepseek-harness\packages\interaction\tool-ask-user\src\index.ts`（ask_user_question 工具）
- `D:\project-code\llm\deepseek-harness\packages\client\ui-user-questions\src\client\contract\slots.ts`（PendingQuestion）
- `D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\sessions\pending.ts`（PendingWait）
- `D:\project-code\llm\deepseek-harness\packages\host\apiproxy\src\api-proxy.ts`（question/approval 帧）
- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\workflow-definition.ts`（ConversationNodeDefinition 范本）

**sandore 权威设计文档：**
- `D:\project-code\llm\sandore\docs\design\task-4-lifecycle\design.md`、`work.md`
- `D:\project-code\llm\sandore\docs\engine\dsh-workflow.md`（§5.1A/§5.5/§6.4/§10.2）
- `D:\project-code\llm\sandore\docs\design\overall-design.md`（§4.2/D5/D8/D9）
