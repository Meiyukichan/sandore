# 记忆探索结果（memory）

## 一、需求理解（Phase 2）

- **What（要理解什么）**：`docs/design/task-4-lifecycle/work.md` 要求在 Task 3 完整 DAG 之上补齐工作流引擎的完整生命周期能力——交互（问答/权限/askUserQuestion）+ 暂停/恢复/中止 + 重试（continue/revert/fork）+ 崩溃恢复（断点续传）+ 宿主主代理（默认会话自然延续，D9）+ 消息聚合（多 session 讨论数据）。产出落在 `workflow` 与 `tool` 两包：`workflow` 新增 4 个文件（`interaction-manager.ts`/`lifecycle-manager.ts`/`recovery-manager.ts`/`host-agent.ts`），`tool` 包新增 8 个 `sandore_*` 模型工具。
- **Boundaries（范围）**：仅 Task 4 生命周期。**不含**前端 UI 的讨论面板 `sandore-step` 节点实现（D8 是验证标准，但 work.md 的产出清单只列 `workflow` + `tool` 两包；`ui` 包当前仍是 Task 1 的 ping 占位）。核心记忆来源是 `docs/design/task-4-lifecycle/design.md`（权威规格）、`docs/engine/dsh-workflow.md`（§5.1A 主代理编排器、§5.5 事件/SSE、§6.4 讨论面板、§10.2 D1–D9）、`docs/design/overall-design.md`（§4.2 事件词汇表、D5/D8/D9），以及 DSH 源码 `D:\project-code\llm\deepseek-harness`（`packages/interaction`、`ctx.subagents`/`ctx.agents`、`packages/client/ui-workflow-run`）。
- **Goal（目标）**：为 Task 4 的实现/设计提供事实依据——明确当前 Task 3 已落地的基线（哪些方法/字段/事件已就绪、哪些抛 `not implemented`）、Task 4 各生命周期能力的 DSH 等价原语真实签名，以及 DSH 源码中既有的交互 seam（`ctx.userQuestions`/`ctx.approval`）、可续接子代理（`interrupt`/`followup`/`listChildren`）、Agent 工厂（`create`/`resume` + `setup`）、Chat 节点（`ConversationNodeDefinition`）范式落点。
- **Project Context**：Task 1、Task 2、Task 3 已完成并归档（`furina/archive/2026-08-15-task-{1,2,3}-*/`）。当前 `furina/changes/task-4-lifecycle/` 为新 change（`artifacts` 为空）。Task 4 在 `workflow`（4 个管理器 + 宿主主代理）+ `tool`（8 工具）两包内产出；`microflow`（`subagents.ts` 接缝）可能需要小幅扩展（`listChildren`/`resume`/`setup`/`inbox` 等接缝字段）。

## 二、项目现状（当前状态事实）

| 位置 | 现状 |
|---|---|
| `packages/sandore/workflow/src/seam.ts` | `SandoreEngine` 抽象类已声明**全部 11 个实例级方法**（含 Task 4 的 `recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`）；**13 个 `sandore/*` 事件已全部双声明**（Cordis `Events` + Session `SessionEventMap`），含 `sandore/step-paused`/`step-resumed`/`step-retried`/`question`/`permission`/`aborted`。`SandoreEngineStub`（`static inject` = 7 服务）所有方法抛 `not implemented`。**Task 4 的事件面与 Service 面已声明齐全，无需新增事件声明**。 |
| `packages/sandore/workflow/src/workflow-engine.ts` | `SandoreEngineRuntime` 已实现 `startInstance`/`getState`/`abortInstance`；**8 个生命周期方法（recover/reply×2/pause×2/resume×2/retry）抛 `SandoreError('... not implemented', 'INVALID_OPERATION')`**。`ActiveInstance` = `{ controller, session, definition, state }`——`session` 是 `ctx.sessions.create(SessionId(instanceId), { meta: { cwd } })` 的**裸 Session，非 `ctx.agents.create` 的宿主主代理**。`runInstance` 在 `result.status === 'interacting'` 时置 `status: 'interacting'` 并 `return`（注释注明「Task 4 接续」）。事件双发 `emitContained` + `session.append` 已实现。无 interaction/lifecycle/recovery/host-agent 管理器。 |
| `packages/sandore/workflow/src/types.ts` | `PendingQuestion`（stepId/sessionId/requestId/questions: AskUserQuestionPayload）、`PendingPermission`（stepId/sessionId/requestId/permission/patterns/metadata/tool）、`DagRunStatus` 已含 `interacting`/`paused`、`StepStatus` 已含 `interacting`/`paused`、`ExecutedStepDefault` 已含 `pausedAt`/`resumedAt`/`resumePrompt`/`sessionMessages`/`pauseEntryId`/`retryHistory`/`parentSessionId`/`output`、`RetryRecord`（mode/timestamp/userMessage/revertMessageId/result）、`AskUserQuestionPayload` 已定义。 |
| `packages/sandore/workflow/src/schema.ts` | `WorkflowTaskStateSchema` 已含 `pausedStepIds: z.array(z.string())`（暂停登记表的持久化字段就位）、`pendingInteractions: z.array(z.unknown())`（**宽松未知类型**，interaction-manager 落地时需收紧）、`retryHistory`/`sessionMeta`/`finalizeMeta`/`stageContracts` 等。`RetryRecordSchema`/`AskUserQuestionPayloadSchema`/`StepSessionMetaSchema`（childId/synthetic/command）已就绪。`sandoreDomainSpec` 三表（definitions/jobs/state）。 |
| `packages/sandore/workflow/src/remote.ts` | `SandoreRemote`（Typert `@Remote`，wire namespace `sandore`）有定义/Job/实例 CRUD + `startInstance`/`abortInstance`/`deleteInstance`/`getInstanceState`/`getArtifacts`/`listProviders`/`listModels`。**无 pause/resume/retry/reply 的 RPC 端点**。 |
| `packages/sandore/workflow/src/persistence.ts` | `SandorePersistence`：`sandore` 域三表 + `saveWorkflowState`（`state.put(taskId, state)` 全量覆盖）。`recoverOrphanedInstances` 的启动扫描数据源（`state` 表）就位。 |
| `packages/sandore/workflow/src/errors.ts` | re-export 自 microflow。`SandoreErrorCode` 现含 `YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`CANCELLED`/`FINALIZE_FAILED`/`GATE_FAILED`/`SESSION_LOST`/`PERSISTENCE_FAILED`。 |
| `packages/sandore/microflow/src/subagents.ts` | 本地结构类型接缝。`SubagentRuntime` 含 `startContinuable`/`followup`/`interrupt`/`start`（**无 `listChildren`/`listDescendants`/`reportFrom`/`registerContinuableSetup`**）；`AgentRegistry` 含 `get`/`create`/`resume`（**无 `list`/`roots`/`isOwnedBy`**）；`Agent` 含 `id`/`options`/`session`/`status`/`whenIdle`（**无 `inbox`/`ctx`/`cancel`/`followup`/`steer`/`inject`/`send`**）；`CreateAgentOptions` 仅 `{sessionId, agentOptions?, signal?}`（**缺 `meta`/`seed`/`setup`**）；`ResumeAgentOptions` 仅 `{resumeSessionId, agentOptions?, signal?}`（**缺 `setup`**）。`SubagentInterruptAuthority`/`SubagentFollowupOptions`/`ContinuableStartSpec`/`finalAssistantOutput` 已就绪。 |
| `packages/sandore/microflow/src/step-runner.ts` | `StepRunnerConfig.hostAgent?: Agent` 已存在（子代理 parent 的来源）；`createHostAgentStub()` 最小 parent 桩；`runSubagent` 走 `startContinuable` → `ctx.agents.get(childId)` → `whenIdle()` → `finalAssistantOutput`。 |
| `packages/sandore/microflow/src/stage-executor.ts` | `finalizeOutcome.type === 'ask'` 时置 Step/Stage `interacting` 并中止 Stage（注释「Task 4 接交互等待循环」）。 |
| `packages/sandore/microflow/src/finalize-manager.ts` | `FinalizeAssessor` 产出 `AskUserQuestionPayload`（对齐 DSH `ask_user_question`）；`finalizeStep` 返回 `{type:'ask'}` 三态。 |
| `packages/sandore/tool/` | **空占位**（仅 `package.json` + `tsconfig.json`，description 为 "model tools (placeholder)"，无 `src/`）。8 个 `sandore_*` 工具未实现。 |
| `packages/sandore/ui/` | `WorkflowPanel.tsx` 为 ping 往返 + 三态占位列表；`client/host.ts` 仅 `HostCall`/`isPingResponse`。**无讨论面板 / `sandore-step` Chat 节点**。 |
| `packages/sandore/workflow/tests/mocks/` | 已备 `agents.ts`（`FakeAgent`/`FakeAgentRegistry` 支持 `get`/`create`/`resume`/`whenIdle`）、`subagents.ts`（`FakeSubagents` 记录 `startContinuable`/`followup`/`interrupt`/`start` 调用）、`sessions.ts`（`FakeSession` 仅 `append`，**无 `fork`**）、`llm.ts`、`shell.ts`、`storage-domain.ts`、`subprocess.ts`。 |

## 三、核心硬约束（不可违反）

1. **纯插件，不改任何 DSH 源码**；**零外部 Agent SDK**，全用 DSH `ctx.*` 服务（`ctx.subagents`/`ctx.agents`/`ctx.llm`/`ctx.sessions`/`ctx.storageDomain`/`ctx.userQuestions`/`ctx.approval`）。
2. **命名沿用**：`ctx.sandoreEngine` / `sandore/*`（13 事件）/ `sandore_*`（工具，下划线）/ `sandore.*`（RPC，点号）/ 4 包。
3. **D5**：事件/SSE 全用 DSH，零自建——无 `WorkflowEventBus`/`WorkflowSseManager`/`SdkSseManager`（当前代码本就无这三者，Task 1–3 已直接用 `ctx.emit` + `session.append` 双发 + apiproxy SSE）。
4. **D9**：主代理 = 工作流编排器，身份不切换；「默认挂载会话」= 宿主 Session 自然延续（**无 DefaultSessionManager**、无 `default-session-mounted` 事件）；暂停登记表由引擎自建（DSH `AgentStatus` 只有 `idle`/`running`，无 `paused`）。
5. **权限**：无 `permissionMode`——子代理继承宿主 Session 的 permission preset，approval 固定 `never`。

## 四、命名空间决策（D1，沿用 Task 1）

| 概念 | 命名 |
|---|---|
| Service key | `ctx.sandoreEngine`（`abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`） |
| 事件前缀 | `sandore/*`（Cordis `Events` + Session `SessionEventMap` 双声明，13 事件已在 seam.ts 全部声明） |
| 模型工具 | `sandore_*`（下划线，8 个，Task 4 在 `tool` 包产出） |
| RPC 方法 | `sandore.*`（`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`） |
| 存储域 | `sandore`（`sandoreDomainSpec`，definitions/jobs/state 三表） |

## 五、Task 4 产出与关键设计决策（work.md + design.md）

### 5.1 产出文件清单（work.md）

- `packages/sandore/workflow/`：`interaction-manager.ts`（pendingQuestions/pendingPermissions Map + add/reply + `sandore/question`/`sandore/permission` 事件）、`lifecycle-manager.ts`（pause/resume + 暂停登记表 `pausedChildIds`）、`recovery-manager.ts`（`recoverOrphanedInstances` 扫描 `state` 表 + 崩溃恢复）、`host-agent.ts`（`ctx.agents.create({ sessionId, meta: { cwd }, setup(agentCtx) })` + `sandore_*` 工具注册，D9）。
- `packages/sandore/tool/`：**8 个 `sandore_*` 模型工具**（per-instance 闭包捕获 `instanceId`，通过 `agents.create({ setup })` 注册，非 preset standing mount）：`sandore_getState` / `sandore_startInstance` / `sandore_abortInstance` / `sandore_pauseStep` / `sandore_resumeStep` / `sandore_pauseAllSteps` / `sandore_resumeAllPaused` / `sandore_retryStep`。

### 5.2 关键决策（Task 4 直接相关）

- **D5**：事件/SSE 全用 DSH——`sandore/*` 用 Cordis 事件（`ctx.emit`/`ctx.on`）+ apiproxy 双 SSE 流 + `ctx.sessionProjections`；问答/权限经 `question/requested`/`approval/requested` 帧。
- **D8**：讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制——每个 Step 折叠为一个 `sandore-step` 节点（`ConversationNodeDefinition` + `conversation.chat.node` keyed），内联最后结果消息。
- **D9**：主代理 = 工作流编排器，身份不切换——广播恢复改「自然语言 → 主代理显式调用 `sandore_*` 工具」；「默认挂载会话」= 宿主 Session 在 `completed` 后自然降级为自由对话；暂停登记表由引擎自建。
- **暂停/恢复**：`pause` = `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })`；`resume` = `ctx.subagents.followup(hostAgent, childId, ...)`。
- **重试 revert/fork**：DSH 无 revert 原语——用 `ctx.sessions.fork(childId, boundary)` + `ctx.agents.create({ seed })`（产生新 session id）；continue 用 `followup`。
- **崩溃恢复**：`ctx.agents.resume({ resumeSessionId: hostSessionId })` 冷恢复宿主主代理（`setup` 重跑 → 工具/instanceId 闭包重注册）+ `followup` 冷恢复子代理。
- **权限**：无 `permissionMode`——子代理继承宿主 Session 的 permission preset，approval 固定 `never`。

## 六、DSH 源码范式落点（已核实的参考实现）

以下范式来自 DSH 源码 `D:\project-code\llm\deepseek-harness`：

1. **`ctx.agents.create/resume`（已核实）**：`packages/core/agent/src/index.ts`。`create(options: CreateAgentOptions): Promise<AgentHandle>`，`resume(options: ResumeAgentOptions): Promise<AgentHandle>`；`CreateAgentOptions = { sessionId, meta?: { cwd?, parentSession?, seedLength?, origin?: 'subagent', delegationDepth?, agentPreset? }, seed?: SessionEvent[], agentOptions?, signal?, setup?: AgentSetup }`；`ResumeAgentOptions = { resumeSessionId, agentOptions?, signal?, setup? }`。`AgentSetup = (agentCtx: Context) => AgentSetupCommit | Promise<AgentSetupCommit|void> | void`——**setup 在 agent/session 发布前执行**，注册进 `agentCtx` 的工具/prompt 段/监听器在 `session/created`+`agent/created` 前就位；抛错/commit 失败整体回滚不发布 id。`resume` 同样支持 `setup`（冷恢复时 setup 重跑）。`AgentHandle = { agent, dispose() }`。

2. **`Agent` 结构（已核实）**：`packages/core/agent/src/runtime-types.ts`。`Agent = { id, options, session, inbox, status: 'idle'|'running', ctx, cancel(cause, options?), whenIdle(), runMaintenance(), send(message, target, wakeup), followup(message), steer(message), inject(message) }`。`AgentStatus` 只有 `idle`/`running`（**无 paused/interacting**——确认 D9 暂停登记表必要）。`Inbox`（`inbox.ts`）有 `nextTurn`/`nextStep`/`hasPending`。事件：`agent/created`/`agent/disposed`/`agent/status`/`agent/session-start`（source: `startup`|`resume`|`clear`|`compact`）等。

3. **`ctx.subagents.followup/interrupt/listChildren`（已核实）**：`packages/subagent/subagent/src/index.ts` + `continuation.ts`。`followup(parent, childId, content, options: SubagentFollowupOptions): Promise<MessageId>`——absent child 自动从持久化 Session 冷恢复；`SubagentFollowupOptions = { source: MessageSource, signal: AbortSignal }`。`interrupt(targetSessionId, authority: SubagentInterruptAuthority): void`——fire-and-return，内部 `Agent.cancel(cause, { keepInbox: true })`；authority = `{ kind:'user', parentSessionId }` 或 `{ kind:'ancestor', agent }`（ancestor 要求 exact live agent 且非 self 且在 lineage 内）；absent target 为 no-op。`listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>`——合并 live store + persistence，`SubagentListEntry = { kind:'child', id, activity:'running'|'inactive', hasChildren, mode:'one-shot'|'continuable', label? }` 或 `{ kind:'diagnostic', ... }`。

4. **`finalAssistantOutput`（已核实）**：`packages/subagent/subagent/src/assistant-output.ts`——选最后一条非空 assistant message，无则回退累计 `text-delta`；sandore 的 `microflow/src/subagents.ts` 已自带同规则实现。

5. **交互 seam（已核实）**：`packages/interaction/user-questions/src/index.ts` 的 `ctx.userQuestions`（`UserQuestionService.ask(request): Promise<AskUserQuestionAnswer>`，`AskUserQuestionItem = { id, question, detail?, header?, options?, multiSelect?, intent? }`；errors：`CALLER_NOT_LIVE`/`DELEGATED_CALLER`（owned child 不能问人类）/`NO_PROVIDER`/`EMPTY_QUESTIONS`/`ASK_ABORTED`）；`packages/interaction/user-approval/src/index.ts` 的 `ctx.approval`（`ApprovalService.request(req): Promise<ApprovalOutcome>`，`ApprovalPolicy = 'ask'|'never'`，`ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`；audit 事件 `approval/asked`/`approval/decided`/`approval/policy`，`effectiveApprovalPolicy(events)`）。

6. **PendingWait 载体（已核实）**：`packages/client/runtime/src/client/sessions/pending.ts` 的 `PendingWait<K extends 'approval'|'question'>`——`{ kind, key, sessionId, payload, respond(result): Promise<RpcReceipt> }`；`PendingPayloads = { approval: Omit<MuxFrame{'approval/requested'},...>, question: Omit<MuxFrame{'question/requested'},...> }`。wire 帧（`packages/host/apiproxy/src/api/events.schema.ts`）：`approval/requested {sessionId, approvalId, toolName, callId?, reason?}` / `approval/resolved {sessionId, approvalId, outcome}` / `question/requested {sessionId, questions[>=1]}` / `question/resolved {sessionId, questionRpcId, outcome:'answered'|'cancelled'}`。

7. **Chat 节点（已核实，D8 复用范式）**：`packages/client/ui-workflow-run/src/client/workflow-definition.ts` 的 `ConversationNodeDefinition<WorkflowState>`——`{ kind: 'workflow-run', target: 'chat', match(event), start(ctx, match), update(ctx, match), buildViewNode(ctx) }`，并 `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': ... } }`。D8 的 `sandore-step` 节点即复用此范式（`conversation.chat.node` keyed）。

## 七、Task 4 验证标准（完成门槛，来自 work.md）

1. **暂停/恢复/重试（continue/revert/fork 三模式）/崩溃恢复**全链路可用。
2. **交互（问答/权限/askUserQuestion）**全链路可用。
3. **宿主主代理**：`completed` 后自然降级为自由对话；`sandore_*` 工具仅挂宿主 Session（per-instance），不影响普通会话。
4. **讨论面板** `sandore-step` 节点正确渲染（复用 `ui-workflow-run`）。
