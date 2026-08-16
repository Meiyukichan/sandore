# Task 4 生命周期 — 代码库探索结果

## Exploration Result（Phase 3 — furina-codebase explore）

无结果。`docs/codebase`（`furina config show project.sourcecode codebases` 返回的 codebase 目录）为空目录，尚未生成 code-document tree，因此 `furina-codebase` 的 `explore` 指令（层级导航 toc.md → spec）无可命中项，直接进入补充探索。

## Supplementary Exploration Result（Phase 4 — 手工补充探索）

### 一、需求理解（Phase 2）

1. **What**：Task 4 在 Task 3「完整 DAG（agent/skill/mcp Step + 分支 + 循环 + Finalize）」基础上补齐工作流引擎的完整生命周期能力：① 交互（问答/权限/askUserQuestion）；② 暂停/恢复/中止；③ 重试（continue/revert/fork）；④ 崩溃恢复（断点续传）；⑤ 宿主主代理（默认会话自然延续，D9）；⑥ 消息聚合（多 session 讨论数据）。产出集中在 `workflow` + `tool` 两包。

2. **Boundaries**：探索范围限定在 `packages/sandore/`（当前工程）的 `workflow`（编排/生命周期）与 `microflow`（Stage 内部执行）两个包，`tool`/`ui` 两包现状核实，以及 `docs/` 设计文档；DSH 参考源码 `D:\project-code\llm\deepseek-harness`（`packages/core/agent`、`packages/subagent/subagent`、`packages/interaction`、`packages/client/ui-workflow-run`）仅作为 API 落点核实。**不含**前端 UI 代码产出（讨论面板 `sandore-step` 节点是验证标准，work.md 产出仅 workflow + tool 两包）。

3. **Goal**：摸清 Task 3 已实现的基线（尤其是引擎 8 个未实现实例级方法的现状、交互/暂停字段的既有 schema 预留、DSH 能力接缝 `subagents.ts` 的缺口），定位 Task 4 需新建/改造的文件，并核实 DSH `ctx.*` 关键原语（`agents.create/resume/get/whenIdle`、`subagents.interrupt/followup/listChildren`、`sessions.fork`、`userQuestions.ask`、`approval.request`）的真实签名，作为实现依据。

4. **Project Context**：sandore 是 DSH 的持久化 Cordis 插件（4 包：`workflow`/`microflow`/`tool`/`ui`）。命名约定：`ctx.sandoreEngine`（Service）、`sandore/*`（13 个 Session/Cordis 事件）、`sandore_*`（模型工具，下划线）、`sandore.*`（RPC，点号）。硬约束：**纯插件不改 DSH 源码**、**零外部 Agent SDK**，全用 DSH `ctx.*` 服务；权限无 `permissionMode`，Step 子代理继承宿主 Session 的 permission preset（approval 固定 `never`）。依赖方向单向 `workflow → microflow`（microflow 对 workflow 仅 `import type`）。持久化：`work.json` → 存储域 `state` 表，`chat.json` → 宿主 Session 事件日志。关键决策 D5（事件/SSE 全用 DSH 零自建）、D8（讨论面板复用 `ui-workflow-run` Chat 节点）、D9（主代理 = 工作流编排器，身份不切换，宿主 Session 完成后自然降级为自由对话）。

---

### 二、当前实现状态（Task 3 基线）

#### 2.1 workflow 包（Stage 编排 + RPC + 持久化）

| 文件 | 现状 | 与 Task 4 的相关性 |
|---|---|---|
| `src/workflow-engine.ts` | `SandoreEngineRuntime` 已实现 `startInstance`/`getState`/`abortInstance` 三个方法；**其余 8 个实例级方法全部抛 `SandoreError('... is not implemented', 'INVALID_OPERATION')`**：`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`（L197-227）。`ActiveInstance = { controller: AbortController, session: Session, definition, state }`，`instances = Map<string, ActiveInstance>`。`startInstance` 用 `this.ctx.sessions.create(SessionId(instanceId), { meta: { cwd } })` 创建宿主 Session（**只是 `sessions.create`，非 `agents.create`**——无 `setup`、无 `sandore_*` 工具注册，即宿主 Session 尚未成为「主代理」）。`runnerConfig()`（L405-414）**未传 `hostAgent`**（`StepRunnerConfig.hostAgent` 未赋值，Step 子代理 parent 实际走 stub）。`runInstance` 主循环中 `result.status === 'interacting'` 分支（L365-371）置 `status:'interacting'` 后直接 `return`——**这是 Task 4 交互等待循环的接入点**。事件双发已实现 start/stage-start/stage-completed/step-start/step-completed/step-failed/end/aborted 共 8 个（`emitContained` ctx.emit + `safeAppend` session.append）；**尚未发射** step-paused/step-resumed/step-retried/question/permission 5 个事件（无对应 emit 方法） | **Task 4 核心改造点**：实现 8 个方法 + 建宿主主代理 + 交互等待 + 暂停登记表 + 崩溃恢复 |
| `src/seam.ts` | `SandoreEngine` 抽象类 **11 个实例级方法已声明齐全**（startInstance/recoverInstance/abortInstance/replyQuestion/replyPermission/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps/retryStep/getState）；13 个 `sandore/*` 事件在 Cordis `Events` 与 `SessionEventMap` **双声明齐全**（含 step-paused/step-resumed/step-retried/question/permission）。`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`——**无 `agents`、无 `userQuestions`/`approval`、无 `sessionTitle`**（Task 4 需要时须补）。`SandoreConfig = { defaultTimeoutMs?, maxConcurrentSteps?, defaultProvider?, defaultModel? }` | 事件面已齐；inject 与 config 需按 Task 4 需求扩展（如加 `agents`） |
| `src/types.ts` | `DagRunStatus = 'pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused'`（**已含 `paused`**）。`PendingQuestion = { stepId, sessionId, requestId, questions: AskUserQuestionPayload }`（**精简版**，无 design.md §1.2 的 `id/stageId/status/answer` 字段）；`PendingPermission = { stepId, sessionId, requestId, permission, patterns?, metadata?, tool?: string }`（无 `status/answer`）。`ExecutedStepDefault` 已含 `pausedAt/resumedAt/resumePrompt/sessionMessages/pauseEntryId/retryHistory/parentSessionId/output` 字段 | 暂停/重试字段已预埋；`PendingQuestion/PendingPermission` 需按 interaction-manager 需求扩字段（id/status/answer） |
| `src/schema.ts` | `WorkflowTaskStateSchema` 已含 **`pausedStepIds: z.array(z.string())`**（暂停登记表持久化字段已存在）与 `pendingInteractions: z.array(z.unknown())`（未使用）。`ExecutedStepDefaultSchema` 已含 `pausedAt/resumedAt/resumePrompt/sessionMessages/pauseEntryId/retryHistory/parentSessionId`。`RetryRecordSchema = { mode: 'continue'|'revert'|'fork', timestamp, userMessage, revertMessageId?, result }`。`StepSessionMetaSchema = { childId, synthetic, command }`（**无 `hostSessionId`**）。`sandoreDomainSpec` 三表 definitions/jobs/state（state 表 key=instanceId，Zod 校验） | 暂停登记表/重试历史 schema 已就位；可能需补 `hostSessionId`/交互 pending 结构；`pausedChildIds` 需从 `pausedStepIds` 语义上确定（见 §四） |
| `src/persistence.ts` | `SandorePersistence`（`ctx.sandorePersistence`）打开 sandore 域三表，暴露 `.definitions/.jobs/.state` KvTable + `saveWorkflowState(state)`（`state.put(taskId, state)` 全量覆盖）。`state.entries()`/`state.get`/`state.delete` 可用 | 崩溃恢复的孤儿实例扫描可直接 `state.entries()` 遍历 key（=instanceId），`saveWorkflowState` 覆盖写快照 |
| `src/remote.ts` | `SandoreRemote`（Typert `sandore.*`）已实现 definitions/jobs CRUD、listInstances/startInstance/deleteInstance/getInstanceState/abortInstance、getArtifacts、listProviders/listModels、ping。**缺** `getDiscussion`/`addChatMessage`（讨论）、`replyQuestion`/`replyPermission`（交互回复）、`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`（暂停/恢复/重试）RPC | Task 4 交互/暂停/恢复/重试 RPC 待补（work.md 产出未列 remote，但 dsh-workflow §7.2 列全；按需判断） |
| `src/dag-navigator.ts` | Step 级 DAG 调度已就绪（`resolveNextNodes` 优先级 Loop > Branches > Next > tryAdvanceStage，跨阶段隔离）；`LoopManager`/`BranchEvaluator` 内建 | Task 4 暂停/恢复/重试在 Step 完成等待点与交互点接入，DAG 导航本身无需大改 |
| `src/errors.ts` | re-export microflow 的 `SandoreError`；错误码已含 `INVALID_OPERATION`/`CANCELLED`/`SESSION_LOST`/`PERSISTENCE_FAILED`/`STEP_EXECUTION` 等 | 交互/暂停/重试错误码基本可复用，无需大改 |
| `src/yaml-parser.ts` / `src/shell.ts` | 定义解析/校验、shell+subprocess 接缝（已就绪） | 与 Task 4 关联弱 |

#### 2.2 microflow 包（Stage 内部执行）

| 文件 | 现状 | 与 Task 4 的相关性 |
|---|---|---|
| `src/subagents.ts` | `ctx.subagents`/`ctx.agents` 本地结构类型接缝。`SubagentRuntime = { startContinuable, followup, interrupt, start }`（**缺 `listChildren`/`listDescendants`**）；`AgentRegistry = { get, create, resume }`，其中 `CreateAgentOptions = { sessionId, agentOptions?, signal? }`（**缺 `meta`/`seed`/`setup`**）、`ResumeAgentOptions = { resumeSessionId, agentOptions?, signal? }`（**缺 `setup`**）；`Agent = { id, options, session, status, whenIdle }`（**缺 `ctx`/`inbox`/`cancel`/`send`/`followup`/`steer`/`inject`**）。`followup(parent, childId, content, options)`/`interrupt(targetSessionId, authority)` 签名与 DSH 一致。`finalAssistantOutput` 已按 DSH 规则自带 | **Task 4 需扩展此接缝**：host-agent 要 `agents.create({ sessionId, meta:{cwd}, setup })`、`resume({ resumeSessionId, setup })`、`listChildren`，当前接缝缺这些字段 |
| `src/step-runner.ts` | `StepRunnerConfig` **已含 `hostAgent?: Agent` 字段**；`runSubagent` 已走 `startContinuable` → `ctx.agents.get(childId)` → `child.whenIdle()` → `finalAssistantOutput`；`resolveParent()` = `config.hostAgent ?? createHostAgentStub()`（当前引擎未传 hostAgent，实际走 stub） | Task 4 需让引擎把真实宿主主代理注入 `StepRunnerConfig.hostAgent`，子代理 parent 即宿主主代理 |
| `src/stage-executor.ts` | 批量队列 DAG 调度；`finalizeOutcome.type === 'ask'` 时返回 `status:'interacting'` 并中止 Stage（注释「Task 4 接交互等待循环；Task 3 仅置 interacting 标记」）。`StageStepHooks` 只有 onStepStart/onStepCompleted/onStepFailed（**无 onStepPaused/onStepResumed/onStepRetried**） | `interacting` 是交互接入点；Step 暂停/恢复/重试事件钩子需补 |
| `src/finalize-manager.ts` | `FinalizeManager.finalizeStep` 返回 `FinalizeOutcome`（done/ask/error）；`completionType='ask'` 时 `executedStep.status='interacting'` + `persistFinalize`，返回 `{ type:'ask', assessResult }`（askQuestion 载荷在 `assessResult.askQuestion`）。**ask 尚未进入任何 pending Map**（interaction-manager 不存在） | Task 4 需在此把 ask 注入 `WorkflowInteractionManager` 并等待回复 |
| `src/branch-evaluator.ts` / `loop-manager.ts` / `file-utils.ts` / `errors.ts` / `internal.ts` / `index.ts` | Task 3 已就绪；`index.ts` 已导出全部模块 | 与 Task 4 关联弱 |

#### 2.3 tool 包（模型工具，Task 4 产出之一）

- **空壳**：仅有 `package.json`（name `@deepseek-ai/dsh-sandore-tool`，description "sandore workflow engine model tools (placeholder)"）+ `tsconfig.json`（rootDir src、include src）。**无 `src/` 目录、无任何工具实现**。
- 8 个 `sandore_*` 工具（getState/startInstance/abortInstance/pauseStep/resumeStep/pauseAllSteps/resumeAllPaused/retryStep）全部待建；work.md 要求 per-instance 闭包捕获 `instanceId`，通过 `agents.create({ setup })` 注册，非 preset standing mount。

#### 2.4 ui 包（前端，Task 4 非产出但验证相关）

- `src/index.ts`（Host 空 apply）、`src/client/index.ts`（`sidebar.footer.action` 注册 WorkflowButton + ping 桩）、`src/client/host.ts`（HostCall 桥 + PingResponse）、`src/client/locales.ts`、`src/client/WorkflowButton.tsx`。
- **无 `conversation.chat.node` 的 `sandore-step` 渲染器、无 RunView/讨论面板**。注：work.md 产出仅 `workflow + tool` 两包，讨论面板 `sandore-step` 节点（复用 `ui-workflow-run` 的 `ConversationNodeDefinition` 机制）是验证标准（D8），前端渲染器属后续 Task。

#### 2.5 测试基础设施

- `workflow/tests/mocks/`：`agents.ts`（`FakeAgent`/`FakeAgentRegistry`——`create`/`resume` 忽略 `meta`/`setup`，`FakeAgent` 无 `ctx`/`cancel`/`send`）、`subagents.ts`（`FakeSubagents` 实现 startContinuable/followup/interrupt/start，**无 listChildren**）、`llm.ts`、`sessions.ts`、`shell.ts`、`storage-domain.ts`、`subprocess.ts`。
- 现有 spec：`microflow/src/{step-runner,subagents,finalize-manager,loop-manager,branch-evaluator,file-utils}.spec.ts`、`workflow/src/{persistence,remote,schema,workflow-engine,yaml-parser}.spec.ts`。
- **缺口**：无 `hostAgent`/`setup`/`listChildren`/`interrupt`→`followup` 生命周期链的测试桩；Task 4 单测需扩展 `FakeAgentRegistry`（支持 `setup` 回放、`meta.cwd` 记录）与 `FakeSubagents`（支持 `listChildren`、`interrupt`/`followup` 状态机）。

---

### 三、DSH 参考 API 落点（已核实 deepseek-harness 源码）

> 硬约束「纯插件、零外部 Agent SDK」要求全用 `ctx.*` 服务。以下签名从 `D:\project-code\llm\deepseek-harness` 实际源码核实。

| DSH 原语 | 实际签名/出处 | Task 4 用途 |
|---|---|---|
| `ctx.agents.create` | `create(options: CreateAgentOptions): Promise<AgentHandle>`（`packages/core/agent/src/index.ts:405`）。`CreateAgentOptions = { sessionId, meta?: { cwd?, parentSession?, seedLength?, origin?: 'subagent', delegationDepth?, agentPreset? }, seed?, agentOptions?, signal?, setup? }`；`setup?: AgentSetup = (agentCtx: Context) => AgentSetupCommit \| Promise<...> \| void` | 创建宿主主代理：`create({ sessionId, meta:{cwd, agentPreset?}, setup(agentCtx){ agentCtx.tools.register(...); agentCtx.systemPrompt.section(...) } })`，闭包捕获 instanceId |
| `ctx.agents.resume` | `resume(options: ResumeAgentOptions): Promise<AgentHandle>`；`ResumeAgentOptions = { resumeSessionId, agentOptions?, signal?, setup? }` | 崩溃恢复冷恢复宿主主代理；**`setup` 重跑** → 工具/instanceId 闭包 + system prompt 自动重注册 |
| `ctx.agents.get` | `get(id: SessionId): Agent \| undefined` | hold live child 引用、取 hostAgent authority |
| `Agent.whenIdle` | `whenIdle(): Promise<void>`（`runtime-types.ts:93`） | 等待子代理当前轮完成 |
| `Agent` 其余 | `Agent = { id, options, session, status, inbox, ctx, cancel(), whenIdle(), runMaintenance(), send(), followup(), steer(), inject() }`；`AgentStatus = 'idle'|'running'`（**无 paused/interacting 态**） | 佐证「暂停登记表必须引擎自建」 |
| `ctx.subagents.startContinuable` | `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`；`ContinuableStartSpec = { provider, label, request: Omit<SubagentStartRequest,'label'\|'signal'\|'outputSchema'>, signal }`（`continuation.ts:112`） | Step 子代理创建（Task 3 已用） |
| `ctx.subagents.followup` | `followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>`；`SubagentFollowupOptions = { source: MessageSource, signal: AbortSignal }`（`continuation.ts:144`）；**absent child 自动 coldResume** | resume/retry continue/崩溃恢复子代理冷恢复 |
| `ctx.subagents.interrupt` | `interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void`；`SubagentInterruptAuthority = { kind:'user', parentSessionId } \| { kind:'ancestor', agent: Agent }`（`continuation.ts:139`）；同步 fire-and-return，absent target = no-op，`keepInbox:true` | pause：`interrupt(childId, { kind:'ancestor', agent: hostAgent })` |
| `ctx.subagents.listChildren` | `listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>`（`index.ts:339`）；`SubagentListEntry = { kind:'child', id, activity:'running'\|'inactive', hasChildren, mode:'one-shot'\|'continuable', label } \| { kind:'diagnostic', ... }` | 崩溃恢复枚举 durable 子代理（备选） |
| `ctx.subagents.listDescendants` | `listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>` | 孤儿扫描子树枚举（备选） |
| `ctx.sessions.fork` | `fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session`（`packages/core/session/src/index.ts:1081`）；boundary 为含端点 seq，省略=最后事件，**不得落在未闭合 turn 内** | retry revert/fork：`fork(childId, boundary)` + `agents.create({ seed })` 续跑（产生新 session id） |
| `ctx.userQuestions.ask` | `ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>`；`AskUserQuestionRequest = { questions: AskUserQuestionItem[], agent?, signal? }`（`packages/interaction/user-questions/src/index.ts`）。**约束**：`agent` 必须是 live runtime root，否则抛 `DELEGATED_CALLER`（子代理不可直接问人） | 交互问答：askUserQuestion 语义，载体复用 |
| `AskUserQuestionItem` | `{ id, question, detail?, header?, options?: {label,description?}[], multiSelect?, intent? }`（`types.ts`，**注意 camelCase `multiSelect`**，与 sandore schema 的 `multi_select` 蛇形不一致） | askUserQuestion 载荷对齐（注意字段命名映射） |
| `ctx.approval.request` | `request(req: ApprovalRequest): Promise<ApprovalOutcome>`；`ApprovalRequest = { agent, toolName, callId?, reason?, signal? }`；`ApprovalOutcome = 'allowed-once'\|'rejected'\|'cancelled'\|'unavailable'`；`approval/request` waterfall 事件；Session 事件 `approval/asked`/`approval/decided`/`approval/policy`（`packages/interaction/user-approval/src/index.ts`）。`ApprovalPolicy = 'ask'\|'never'` | 权限 seam；子代理 approval 固定 `never`（`captureDelegatedPolicyOverrides` 在委派边界钉住） |
| `ui-workflow-run` Chat 节点 | `ConversationNodeDefinition<State> = { kind, target:'chat', match(event), start(ctx,match), update(ctx,match), buildViewNode(ctx) }` + `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { ... } }`（`packages/client/ui-workflow-run/src/client/workflow-definition.ts`） | D8：讨论面板 `sandore-step` 节点照抄此范式 |

**关键坑位（design.md / dsh-workflow.md 已明确，实现须遵守）**：① 等待轮完成 = 先 `followup` 再 `await child.whenIdle()`，再读 `finalAssistantOutput(child.session.events)`；② hold 住 child 引用（叶子子代理 settle 后被 dispose）；③ `Agent.status` 只有 `idle`/`running`，无 `paused`——**暂停登记表（`pausedChildIds`）必须引擎自建并持久化**（`WorkflowTaskState.pausedStepIds` 已存在）；④ `subagent/end` 是 settle（销毁）时发而非每轮；⑤ settlement notice 会 `parent.followup` 唤醒主代理（消耗 token，需处理副作用）；⑥ `agents.create` 的 `meta.cwd` 必填（否则冷会话被 `session.list` 过滤、重启后侧边栏不可见）；⑦ 宿主 Session 标题靠 `ctx.sessionTitle.rename` 设（`meta` 无 title 字段）；⑧ 冷会话点击只读回放，不自动 resume——崩溃恢复需引擎显式 `ctx.agents.resume`。

---

### 四、Task 4 差距清单（基线 → 目标）

**workflow 包需新建 4 个文件 + 改造 2 个：**

1. `interaction-manager.ts`（新建）：`pendingQuestions`/`pendingPermissions` Map + `addPendingQuestion/Permission`（→ 发射 `sandore/question`/`sandore/permission` 事件）+ `replyQuestion`/`replyPermission`。接入点：`finalize-manager.ts` 的 `completionType='ask'` 返回 `{ type:'ask', assessResult }` 处（`stage-executor.ts` L346-350 → `workflow-engine.ts` L365-371 的 `interacting` 分支），把 `assessResult.askQuestion` 注入 pending Map 并等待 `replyQuestion` 后恢复 Step。当前 `PendingQuestion`（types.ts）缺 `id/stageId/status/answer` 字段，需扩展或重定义。注意 DSH 问答走 `ctx.userQuestions.ask`（仅 live root 可问）、权限走 `ctx.approval.request`，前端卡片复用 DSH `PendingQuestion` 载体（`ui-user-questions` 导出）+ 自写薄卡片。

2. `lifecycle-manager.ts`（新建）：`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps` + **暂停登记表**（`pausedChildIds`，对应 schema 已存在的 `pausedStepIds`，持久化到 state 表）。`pause = ctx.subagents.interrupt(childId, { kind:'ancestor', agent: hostAgent })` + 登记 + persist；`resume = ctx.subagents.followup(hostAgent, childId, content, { source, signal })` + 删登记 + persist。需补 `step-paused`/`step-resumed`/`step-retried` 事件发射（seam 已声明，engine 未发）。

3. `recovery-manager.ts`（新建）：`recoverOrphanedInstances`（启动扫描 `storageDomain` state 表 `entries()`，跳过终态，对非终态重建引擎 + `ctx.agents.resume({ resumeSessionId: hostSessionId })` 冷恢复宿主主代理 + `followup` 冷恢复 running/interacting 子代理 / paused 恢复登记表）；`recover` 编排 A–H 语义按 DSH 映射简化（无自建 SSE、无 permissionMode）。

4. `host-agent.ts`（新建）：宿主主代理——`ctx.agents.create({ sessionId, meta: { cwd }, setup(agentCtx) })` 注册 8 个 `sandore_*` 工具（per-instance 闭包捕获 `instanceId`）+ system prompt；`completed` 后自然降级为自由对话（**无 DefaultSessionManager、无 default-session-mounted 事件**）。需扩展 `microflow/src/subagents.ts` 接缝：`CreateAgentOptions` 补 `meta`/`setup`，`ResumeAgentOptions` 补 `setup`，`SubagentRuntime` 补 `listChildren`，`Agent` 视需要补 `ctx`/`cancel` 等（当前接缝缺这些字段）。

5. `workflow-engine.ts`（改造）：把 8 个 `not implemented` 方法接到 interaction/lifecycle/recovery/host-agent 四管理器；`startInstance` 从 `sessions.create` 升级为 `hostAgent` 的 `agents.create({ setup })`（或新建宿主主代理后传入 `StepRunnerConfig.hostAgent`）；`runInstance` 的 `interacting` 分支接交互等待；补 step-paused/resumed/retried/question/permission 事件发射；`static inject` 视需要补 `agents`（当前 seam 只有 sessions/sessionPersistence/subagents/llm/shell/fs/storageDomain）。

6. `remote.ts`（改造，可选按 dsh-workflow §7.2）：补 `replyQuestion`/`replyPermission`、`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`、`getDiscussion`/`addChatMessage` RPC（当前仅有定义/Job/实例 CRUD + abort + 产物/Provider）。

**tool 包需新建：**

7. `tool/src/index.ts`（新建）：8 个 `sandore_*` 模型工具（`sandore_getState`/`sandore_startInstance`/`sandore_abortInstance`/`sandore_pauseStep`/`sandore_resumeStep`/`sandore_pauseAllSteps`/`sandore_resumeAllPaused`/`sandore_retryStep`），通过 `agents.create({ setup })` 的 `agentCtx.tools.register(defineTool({...}))` 注册，闭包捕获 instanceId；`resume`/`retry` 对 completed 实例返回无害 no-op，仅 `getState` 只读。当前 tool 包无 src，全新建。

**schema/types 需小幅扩展（按需）：**

8. `types.ts`：`PendingQuestion`/`PendingPermission` 补 `id`/`status`/`answer` 字段（或 interaction-manager 自建内部结构）；`DagInstanceState`/`WorkflowTaskState` 视需要补 `hostSessionId`（崩溃恢复需从快照找回宿主 Session）。`schema.ts` 的 `pausedStepIds` 已存在，直接复用为暂停登记表持久化载体。

9. `subagents.ts`（microflow 接缝）：补 `CreateAgentOptions.meta/seed/setup`、`ResumeAgentOptions.setup`、`SubagentRuntime.listChildren`（见 #4）。

**验证标准（work.md）逐条对应**：暂停/恢复/重试（continue/revert/fork 三模式）/崩溃恢复全链路；交互（问答/权限/askUserQuestion）全链路；宿主主代理 `completed` 后自然降级为自由对话、`sandore_*` 工具仅挂宿主 Session（per-instance）；讨论面板 `sandore-step` 节点正确渲染（复用 `ui-workflow-run`，D8）。
