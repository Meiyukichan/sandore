## Exploration Result

### 需求理解（Phase 2）

- **What**：Task 4 `seam-01` 任务需要在 sandore 的 `microflow`/`workflow` 两包内建立「生命周期接缝与持久化 schema 基座」——即扩展 `microflow/src/subagents.ts` 的结构类型面（对齐 DSH `dsh-agent`/`dsh-subagent` 真实 API）、收紧 `workflow/src/schema.ts` 的 `WorkflowTaskStateSchema`、扩展 `workflow/src/types.ts` 的 `PendingQuestion`/`PendingPermission`、同步 `workflow-engine.ts` 的 `makeInitialState`，并扩展三个测试桩。
- **Boundaries**：探索范围限定为 sandore 仓内的上述 8 个文件（含 4 个 `*.spec.ts` 存量测试对 `pausedStepIds` 的引用），以及 DSH 参考源码 `deepseek-harness/packages/core/agent/src/{runtime-types.ts,index.ts}` 与 `deepseek-harness/packages/subagent/subagent/src/{index.ts,continuation.ts,types.ts,list-children.ts}`。
- **Goal**：查明各落点文件的「现有结构类型面 / 现有 schema 字段 / 现有 stub 行为」与 DSH 参考 API 的「真实形状」之间的差异，为 seam-01 的接缝扩展提供事实依据（仅探索，不做实现）。

### 一、`microflow/src/subagents.ts` 现有结构类型面

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.ts`（共 209 行）。本文件是**本地结构类型声明**（`@deepseek-ai/dsh-subagent`/`@deepseek-ai/dsh-agent` 未作为 sandore 运行时依赖），复刻 DSH 公开 API 的最小面，仅 `import type` 自 `@deepseek-ai/dsh-llm`。

现有导出（与 seam-01 相关项逐一标注当前形状）：

- `SessionId = string`、`MessageId = string`（与 DSH 品牌字符串结构兼容）。
- `AgentOptions { provider?; model?; maxTokens? }`（与 DSH `AgentOptions` 完全一致）。
- `AgentStatus = 'idle' | 'running'`。
- `Session { readonly events: readonly SessionEvent[] }`（最小快照）。
- `Agent`（第 37-44 行）：`{ id; options; session; status; whenIdle() }` —— **当前仅有 5 个成员**，无 DSH 的 `inbox`/`ctx`/`cancel`/`send`/`followup`/`steer`/`inject`/`runMaintenance`。
- `AgentHandle { agent; dispose() }`（第 47-50 行）。
- `CreateAgentOptions`（第 53-57 行）：`{ sessionId; agentOptions?; signal? }` —— **当前无 DSH 的 `meta`/`seed`/`setup`**。
- `ResumeAgentOptions`（第 60-64 行）：`{ resumeSessionId; agentOptions?; signal? }` —— **当前无 DSH 的 `setup`**。
- `AgentRegistry`（第 67-71 行）：`{ get(id): Agent | undefined; create(options): Promise<AgentHandle>; resume(options): Promise<AgentHandle> }` —— **当前无 `listChildren`**。
- `ToolRestriction { allow?; deny? }`。
- `ContinuableStartRequest`（第 80-87 行）：`{ prompt; parent; agentOptions?; maxDepth?; toolFilter?; persona? }`。
- `ContinuableStartSpec`（第 90-95 行）：`{ provider; label; request: ContinuableStartRequest; signal }`。
- `ContinuableStart`（第 98-101 行）：`{ childId; messageId }`。
- `SubagentFollowupOptions`（第 104-107 行）：`{ source: MessageSource; signal }`。
- `SubagentInterruptAuthority`（第 110-112 行）：`{ kind:'user'; parentSessionId } | { kind:'ancestor'; agent }`。
- `SubagentStartRequest`（第 115-124 行）：`{ label?; prompt; parent; signal; agentOptions?; maxDepth?; toolFilter?; persona? }` —— **无 DSH 的 `outputSchema`**。
- `SubagentRun`（第 127-132 行）：`{ id; localAgent; result: Promise<SubagentResult>; dispose() }`。
- `SubagentResult`（第 135-139 行）：`{ output; structured?; stopReason }`。
- `SubagentStopReason`（第 142 行）：`'completed'|'aborted'|'error'|'max-tokens'|'refusal'`。
- `SubagentRuntime`（第 145-150 行）：`{ startContinuable(spec); followup(parent, childId, content, options); interrupt(targetSessionId, authority); start(name, request) }` —— **无 DSH 的 `listChildren`/`listDescendants`/`reportFrom`/`drainContinuableDescendants`/`registerContinuableSetup`/`getProvider`/`list`**。
- `SessionEvent`（第 173-175 行）：仅 `assistant/message` 与 `assistant/chunk` 两类（含 `seq`/`time` 包络）。
- `finalAssistantOutput(events)`（第 187-202 行）：选取最后一条非空 `assistant/message` → 回退累积 `text-delta` → `undefined`。
- Cordis 上下文键声明（第 204-209 行）：`Context.subagents: SubagentRuntime`、`Context.agents: AgentRegistry`。

### 二、`workflow/src/seam.ts`：`static inject` 与 `SandoreEngine` 抽象面

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`（共 173 行）。

- **`SandoreEngineStub.static inject`（第 128 行）**：
  `['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`（7 项）。
- `SandoreEngine` 抽象类（第 70-100 行）继承 `Service`，构造 `super(ctx, 'sandoreEngine')`，13 个抽象方法：
  `startInstance` / `recoverInstance` / `abortInstance` / `replyQuestion` / `replyPermission` / `pauseStep` / `resumeStep` / `pauseAllSteps` / `resumeAllSteps` / `retryStep` / `getState`。
  方法签名详见第 76-99 行（`replyPermission` 的 `reply` 为 `'once'|'always'|'reject'`；`retryStep` 的 `mode` 为 `'continue'|'revert'|'fork'`）。
- 13 个 `sandore/*` 事件双声明（Cordis `Events` 第 29-43 行 + Session `SessionEventMap` 第 46-62 行）：`sandore/start`、`stage-start`、`stage-completed`、`step-start`、`step-completed`、`step-failed`、`step-paused`、`step-resumed`、`step-retried`、`question`、`permission`、`end`、`aborted`。
- `SandoreConfig`（第 103-112 行）：`defaultTimeoutMs?`/`maxConcurrentSteps?`/`defaultProvider?`/`defaultModel?`。
- `SandoreEngineStub`（第 120-173 行）实现 `Config` schema 与全部 11 个方法均 `throw new Error('... is not implemented')`。

### 三、`workflow/src/schema.ts`：`WorkflowTaskStateSchema` / `StepSessionMetaSchema`

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`（共 401 行）。

- **`StepSessionMetaSchema`（第 185-189 行）**：
  `{ childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']) }` —— **当前无 `hostSessionId` 字段**。
- **`WorkflowTaskStateSchema`（第 323-344 行）** 字段（当前完整）：
  `taskId`、`jobId`、`workflowId`、`cwd`、`status`（7 态 `DagRunStatusSchema`：`pending|running|interacting|completed|failed|aborted|paused`）、`originalInput`、`currentStageId`、`executedSteps: z.array(ExecutedStepDefaultSchema)`、`stageInfos: z.array(StageInfoSchema)`、**`pendingInteractions: z.array(z.unknown())`（第 333 行，当前未结构化）**、`pendingQueue: z.array(z.string())`、`visitCounts`、`passThroughVars`、`activeLoopIterationStack`、`activeLoopNodeId`、`activeLoopStack`、**`pausedStepIds: z.array(z.string())`（第 340 行，当前字段名）**、`stageContracts`、`createdAt`、`updatedAt`。
- 相关派生类型导出（第 391 行 `StepSessionMeta`、第 399 行 `WorkflowTaskState`）。
- 存储层 `sandoreDomainSpec`（第 368-376 行）：三表 `definitions`/`jobs`/`state`，`state` 表 value 即 `WorkflowTaskState`。

### 四、`workflow/src/types.ts`：`PendingQuestion` / `PendingPermission`

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`（共 177 行）。

- `PendingQuestion`（第 147-152 行）：`{ stepId; sessionId; requestId; questions: AskUserQuestionPayload }` —— **无 `id`/`stageId`/`status`/`answer`**。
- `PendingPermission`（第 161-169 行）：`{ stepId; sessionId; requestId; permission; patterns?; metadata?; tool? }` —— **无 `id`/`stageId`/`status`/`answer`**。
- 关联的 `DagInstanceState`（第 72-84 行，`getState` 返回投影）当前字段：`taskId/jobId/workflowId/status/originalInput/currentStageId/executedSteps/stageInfos/pendingQueue/createdAt/updatedAt`（不含 `pendingInteractions`/`pausedChildIds`）。
- `ExecutedStepDefault`（第 87-113 行）已含暂停/恢复相关可选字段：`pausedAt?`/`resumedAt?`/`resumePrompt?`/`pauseEntryId?`，以及 `sessionMeta?: StepSessionMeta`。

### 五、`workflow-engine.ts` 的 `makeInitialState`

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`。

- `makeInitialState`（第 73-104 行）返回完整 `WorkflowTaskState`，其中与 seam-01 相关的初值：
  `currentStageId: definition.stages[0]?.id ?? ''`、`executedSteps: []`、`stageInfos`（每 Stage `status:'blocked'`）、`pendingInteractions: []`、`pendingQueue: []`、`visitCounts: {}`、`passThroughVars: {}`、`activeLoopIterationStack: []`、`activeLoopNodeId: null`、`activeLoopStack: []`、**`pausedStepIds: []`（第 99 行）**、`stageContracts: {}`。
- `SandoreEngineRuntime.static inject`（第 139 行）与 `SandoreEngineStub` 完全一致（7 项）。
- 当前 `SandoreEngineRuntime` 已实现 `startInstance`/`getState`/`abortInstance`，其余 8 个生命周期方法（`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`）抛 `SandoreError('INVALID_OPERATION')`（第 197-227 行）。
- 注意：`microflow/src/step-runner.ts` 中 `StepRunnerConfig.hostAgent?: Agent`（第 62 行）已存在；缺省回退 `createHostAgentStub()`（第 117-124 行，`id:'sandore-host'`，`session:{events:[]}`，`status:'idle'`）；`resolveParent()`（第 508-510 行）优先 `config.hostAgent`。续接子代理执行处 `this.ctx.agents.get(started.childId)`（第 453 行）后 `whenIdle()` → `finalAssistantOutput`。

### 六、`workflow/tests/mocks/{agents,subagents,sessions}.ts` 现有桩

- `tests/mocks/agents.ts`（113 行）：
  - `FakeSession implements Session`：`events: SessionEvent[]`，`append(event)`。
  - `assistantMessageEvent(content, seq=0, time=0)`、`assistantChunkEvent(text, seq=0, time=0)` 事件构造助手。
  - `FakeAgent implements Agent`：`id/options/session/status='idle'`，`whenIdle()` 立即 resolve。
  - `FakeAgentRegistry implements AgentRegistry`：内部 `Map<SessionId, FakeAgent>`；`get`；`create(options)` 构造 `new FakeAgent(options.sessionId, options.agentOptions)` 返回 `{ agent, dispose }`（**不执行 setup、不记录 meta**）；`resume(options)` 查找 `resumeSessionId`（命中复用、未命中新建）返回 `{ agent, dispose }`；额外 `register(agent)`。
- `tests/mocks/subagents.ts`（65 行）：
  - `FakeFollowup` 记录 `{ parent; childId; content; options }`。
  - `FakeSubagents implements SubagentRuntime`：`continuableStarts[]`/`followups[]`/`interrupts[]`/`startCalls[]` 记录数组；`startContinuable` 返回 `{ childId: 'child-N', messageId: 'msg-N' }`；`followup` 记录并返回 `msg-N`；`interrupt` 记录；`start` 返回 `{ id:'run-N', localAgent:undefined, result: { output:[], stopReason:'completed' }, dispose }` —— **无 `listChildren`，`interrupt` 后无状态机迁移**。
- `tests/mocks/sessions.ts`（38 行）：
  - `FakeSession`：`events: Array<{type;data}>`，`append(type, data)` 返回 `{ type, seq, time, data }`。
  - `FakeSessionStore`：`Map<string, FakeSession>` + `counter`；`create(id?)`、`get(id)`、`list()` —— **无 `fork`**。

### 七、存量 spec 中 `pausedStepIds` 的引用位置

seam-01 需把 `pausedStepIds` 改名 `pausedChildIds`，存量引用（含定义）如下：

**源码定义（2 处）**
- `packages/sandore/workflow/src/schema.ts:340` —— `pausedStepIds: z.array(z.string())`（`WorkflowTaskStateSchema` 内）。
- `packages/sandore/workflow/src/workflow-engine.ts:99` —— `pausedStepIds: []`（`makeInitialState`）。

**存量测试 spec（4 文件 5 处，plan.json 1.7 要求全部替换）**
- `packages/sandore/workflow/src/schema.spec.ts:129` —— `fullState` fixture。
- `packages/sandore/workflow/src/persistence.spec.ts:35` —— `makeState` fixture。
- `packages/sandore/workflow/src/remote.spec.ts:59` —— `makeState` fixture；`remote.spec.ts:134` —— `startInstance` 内联 state。
- `packages/sandore/workflow/src/workflow-engine.spec.ts:297` —— `makeState` fixture。

**设计文档（非 spec，仅语义参考）**
- `docs/design/task-4-lifecycle/design.md:289,298,301,331,362,372,438,620,663`
- `docs/design/task-2-minimal-engine/design.md:200`
- `docs/design/overall-design.md:298`
- `docs/engine/dsh-workflow.md:425,448`

**Task 4 自身 spec/plan（明确「改名」的目标陈述）**
- `furina/changes/task-4-lifecycle/specs/lifecycle-pause-resume/spec.md:49`（`pausedChildIds`，不再存在 `pausedStepIds`）。
- `furina/changes/task-4-lifecycle/proposal.md:16,31`、`design.md:63,65,132,149`、`plan.json:9,14,23`。

### 八、DSH 参考源码：Agent / CreateAgentOptions / ResumeAgentOptions / listChildren 真实形状

参考仓库：`D:/project-code/llm/deepseek-harness`。

#### 8.1 `Agent`（`packages/core/agent/src/runtime-types.ts:64-144`）

真实 `Agent` 接口成员（sandore 当前只镜像了 `id/options/session/status/whenIdle`）：
- `readonly id: SessionId`
- `readonly options: AgentOptions`
- `readonly session: Session`
- `readonly inbox: Inbox`（来自 `./inbox.ts`）
- `readonly status: AgentStatus`（`'idle' | 'running'`）
- `readonly ctx: Context`
- `cancel(cause: AgentCancelCause, options?: CancelOptions): void`
- `whenIdle(): Promise<void>`
- `runMaintenance<T>(task): Promise<T>`
- `send(message: UserMessage, target: InboxTarget, wakeup: boolean): void`
- `followup(message: UserMessage): void`
- `steer(message: UserMessage): void`
- `inject(message: UserMessage): void`

`AgentOptions`（第 24-31 行）：`{ provider?; model?; maxTokens? }`（与 sandore 一致）。
`AgentStatus`（第 50 行）：`'idle' | 'running'`。

#### 8.2 `CreateAgentOptions`（`packages/core/agent/src/index.ts:80-133`）

真实字段：
- `readonly sessionId: SessionId`
- `readonly meta?: { cwd?; parentSession?; seedLength?; origin?: 'subagent'; delegationDepth?; agentPreset? }`
- `readonly seed?: readonly SessionEvent[]`
- `readonly agentOptions?: AgentOptions`
- `readonly signal?: AbortSignal`
- `readonly setup?: AgentSetup`（`AgentSetup = (agentCtx: Context) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void`，第 69 行）

#### 8.3 `ResumeAgentOptions`（`packages/core/agent/src/index.ts:139-156`）

真实字段：
- `readonly resumeSessionId: SessionId`
- `readonly agentOptions?: AgentOptions`
- `readonly signal?: AbortSignal`
- `readonly setup?: AgentSetup`

#### 8.4 `AgentRegistry` / `AgentHandle`（`packages/core/agent/src/index.ts`）

- `AgentHandle`（第 172-175 行）：`{ agent: Agent; dispose(): Promise<void> }`。
- `AgentRegistry extends Service`（第 256 行起）：`ctx.agents` 服务。`create(options: CreateAgentOptions): Promise<AgentHandle>`（第 405 行，转调工厂 `createAgent(ownerCtx, options)`）；`resume(options: ResumeAgentOptions): Promise<AgentHandle>`（第 424 行）；另有 `register(agent)`、`get(id)`、`setFactory`、`enter/announce` 等。
- 关键语义：`create`/`resume` 经注册的 `AgentFactory` 执行；`setup` 在 mint `agentCtx` 后、发布 session/agent 之前 await；setup 抛错/commit 抛错/owner 释放时整体回滚、不发布任一 id。

#### 8.5 `SubagentRuntime.listChildren`（`packages/subagent/subagent/src/index.ts:339-341` + `list-children.ts`）

- 方法签名：`listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>`。
- 另有 `listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>`（第 358 行）。
- `SubagentListEntry`（`list-children.ts:44-87`）为判别联合：
  - `{ kind:'child'; id: SessionId; activity:'running'|'inactive'; hasChildren: boolean }` 与（`mode:'one-shot'; label?` 或 `mode:'continuable'; label: string`）的交叉；
  - `{ kind:'diagnostic'; id: SessionId; reason:'corrupt'|'unsupported'|'unavailable' }`。
- `SubagentDescendantListEntry = SubagentListEntry & { parentId: SessionId; depth: number }`（第 94-99 行）。
- `listChildren` 实现（第 134-146 行）：live-preferred 合并 `ctx.sessions`（`sessions.list()`）与可选 `ctx.sessionPersistence`（`persistence.list(signal)`），按 `header.parentSession === parentSessionId && header.origin === 'subagent'` 过滤，经 `sessionProjections` 的 `subagent` 投影单元解析 mode/label；缺 `sessionProjections` 抛 `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE`，缺 `sessions` 抛 `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE`，取消抛 `CANCELLED`。

#### 8.6 子代理接缝类型真实形状（`packages/subagent/subagent/src/continuation.ts`、`types.ts`）

- `ContinuableStartSpec`（continuation.ts:112-124）：`{ provider; label; request: Omit<SubagentStartRequest, 'label'|'signal'|'outputSchema'>; signal }`。
- `ContinuableStart`（第 127-132 行）：`{ childId: SessionId; messageId: MessageId }`。
- `SubagentFollowupOptions`（第 144-149 行）：`{ source: MessageSource; signal }`。
- `SubagentInterruptAuthority`（第 139-141 行）：`{ kind:'user'; parentSessionId } | { kind:'ancestor'; agent }`。
- `SubagentStartRequest`（types.ts:100-149）：`{ label?; prompt; parent; signal; agentOptions?; outputSchema?; maxDepth?; toolFilter?; persona? }`。
- `SubagentRun`（types.ts:249-275）：`{ id; localAgent: Agent|undefined; result: Promise<SubagentResult>; dispose() }`。
- `SubagentResult`（types.ts:219-238）：`{ output: ContentBlock[]; structured?: unknown; stopReason }`。
- `SubagentStopReason`（types.ts:200-214）：`'completed'|'aborted'|'error'|'max-tokens'|'refusal'`。
- `ToolRestriction` 来自 `@deepseek-ai/dsh-tools`（types.ts:16）。

#### 8.7 与 sandore 现有接缝的差异小结（仅事实对照，不含实现建议）

| 项 | sandore 现有 | DSH 真实 |
|---|---|---|
| `Agent` 成员 | `id/options/session/status/whenIdle`（5 个） | 另含 `inbox/ctx/cancel/runMaintenance/send/followup/steer/inject` |
| `CreateAgentOptions` | `sessionId/agentOptions?/signal?` | 另含 `meta?/seed?/setup?` |
| `ResumeAgentOptions` | `resumeSessionId/agentOptions?/signal?` | 另含 `setup?` |
| `SubagentRuntime` | `startContinuable/followup/interrupt/start` | 另含 `listChildren/listDescendants/reportFrom/...` |
| `SubagentStartRequest` | 无 `outputSchema` | 含 `outputSchema?` |
| `AgentRegistry` | `get/create/resume` | `get/create/resume/register/setFactory/...` |

## Supplementary Exploration Result

无需补充探索。`furina config show experimental.websearch experimental.context7` 返回 `websearch=true`、`context7=true`，但本探索所需的全部事实均已在 sandore 仓库源码与本地 DSH 参考源码中直接查到（`Phase 3` 结果非空且信息充分），不触发 websearch / context7 补充查询。
