## Exploration Result

Phase 3（furina-codebase 遍历 `codebases` 列表）：`codebases` 配置仅一项 `{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}`。经核实 `D:\project-code\llm\sandore\docs\codebase` 为**空目录**（无任何文件），故本轮 codebases 遍历无返回结果，全部发现来自 Phase 4 补充探索。

## Supplementary Exploration Result

> 说明：`project.sourcecode = src/`，但当前仓库实际源码位于 `packages/sandore/{microflow,workflow}`（`src/` 目录不存在）。下文所有路径为绝对路径。

### 1. `microflow/src/subagents.ts` 现有结构类型面

路径：`D:\project-code\llm\sandore\packages\sandore\microflow\src\subagents.ts`

该文件是**本地结构类型声明**（非运行时依赖 `@deepseek-ai/dsh-subagent`/`@deepseek-ai/dsh-agent`），按 DSH 公开 API 复刻 agent/skill/mcp Step 执行所需最小面，并用 `declare module '@deepseek-ai/cordis'` 声明两个上下文键。

现有类型/接口清单（与 seam-01 直接相关）：

- `SessionId = string`；`MessageId = string`
- `AgentOptions { provider?, model?, maxTokens? }`
- `AgentStatus = 'idle' | 'running'`
- `Session { readonly events: readonly SessionEvent[] }`
- `Agent { readonly id: SessionId; readonly options: AgentOptions; readonly session: Session; readonly status: AgentStatus; whenIdle(): Promise<void> }`
- `AgentHandle { agent: Agent; dispose(): Promise<void> }`
- `CreateAgentOptions { readonly sessionId: SessionId; readonly agentOptions?: AgentOptions; readonly signal?: AbortSignal }`
- `ResumeAgentOptions { readonly resumeSessionId: SessionId; readonly agentOptions?: AgentOptions; readonly signal?: AbortSignal }`
- `AgentRegistry { get(id): Agent | undefined; create(options): Promise<AgentHandle>; resume(options): Promise<AgentHandle> }`（**接口**，仅 3 方法）
- `ToolRestriction { allow?, deny? }`
- `ContinuableStartRequest { prompt; parent: Agent; agentOptions?; maxDepth?; toolFilter?; persona? }`（扣除 label/signal/outputSchema 后）
- `ContinuableStartSpec { provider; label; request; signal }`；`ContinuableStart { childId; messageId }`
- `SubagentFollowupOptions { source: MessageSource; signal: AbortSignal }`
- `SubagentInterruptAuthority = { kind:'user'; parentSessionId } | { kind:'ancestor'; agent }`
- `SubagentStartRequest { label?; prompt; parent; signal; agentOptions?; maxDepth?; toolFilter?; persona? }`
- `SubagentRun { id; localAgent?; result; dispose() }`；`SubagentResult { output; structured?; stopReason }`；`SubagentStopReason`
- `SubagentRuntime { startContinuable(spec); followup(parent, childId, content, options); interrupt(targetSessionId, authority); start(name, request) }`（**接口**，4 方法，**无 `listChildren`/`listDescendants`**）
- `SessionEvent`（`assistant/message` | `assistant/chunk` 二变体）、`AssistantMessageData`、`AssistantChunkData`
- `finalAssistantOutput(events)` 函数（内联实现 DSH 输出选取规则）
- `declare module '@deepseek-ai/cordis' { interface Context { subagents: SubagentRuntime; agents: AgentRegistry } }`

### 2. `workflow/src/seam.ts` 的 static inject 与 SandoreEngine 抽象面

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`

- **13 个 `sandore/*` 事件双声明**：`@deepseek-ai/cordis` 的 `Events` + `@deepseek-ai/dsh-session/types` 的 `SessionEventMap`（start / stage-start / stage-completed / step-start / step-completed / step-failed / step-paused / step-resumed / step-retried / question / permission / end / aborted）。
- **抽象类 `SandoreEngine extends Service`**（`super(ctx, 'sandoreEngine')`），11 个抽象实例级方法：
  - `startInstance(request): DagRun`、`recoverInstance(instanceId): Promise<DagRun>`、`abortInstance(instanceId): Promise<void>`
  - `replyQuestion(instanceId, requestId, answers)`、`replyPermission(instanceId, requestId, reply: 'once'|'always'|'reject')`
  - `pauseStep(instanceId, stepId)`、`resumeStep(instanceId, stepId, resumePrompt?)`、`pauseAllSteps(instanceId)`、`resumeAllSteps(instanceId, resumePrompt?)`、`retryStep(instanceId, stepId, mode: 'continue'|'revert'|'fork', message)`
  - `getState(instanceId): DagInstanceState`
- `SandoreConfig { defaultTimeoutMs?, maxConcurrentSteps?, defaultProvider?, defaultModel? }`
- **`SandoreEngineStub`**：`static Config: z<SandoreConfig>` + **`static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`**（7 项，**不含 `agents`、`userQuestions`**——proposal 提出 seam-01 需补 `agents`/`userQuestions`）。11 个方法全部抛 `not implemented`。
- `declare module '@deepseek-ai/cordis' { interface Context { sandoreEngine: SandoreEngine } }`

### 3. `workflow/src/schema.ts` 的 WorkflowTaskStateSchema / StepSessionMetaSchema

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`（记录 schema 用真实 `zod`）

- **`StepSessionMetaSchema`（第 185–189 行）**：
  ```ts
  z.object({
    childId: z.string(),
    synthetic: z.boolean(),
    command: z.enum(['shell', 'prompt', 'agent', 'skill', 'mcp']),
  })
  ```
- **`WorkflowTaskStateSchema`（第 323–344 行）**，字段全集：
  - `taskId / jobId / workflowId / cwd / status(DagRunStatusSchema 7 态) / originalInput / currentStageId`
  - `executedSteps: z.array(ExecutedStepDefaultSchema)`
  - `stageInfos: z.array(StageInfoSchema)`
  - `pendingInteractions: z.array(z.unknown())` ← **当前为 unknown[] 占位**
  - `pendingQueue: z.array(z.string())`、`visitCounts: z.record(z.string(), z.number())`
  - `passThroughVars: z.record(z.string(), PassThroughVarValueSchema)`
  - `activeLoopIterationStack: z.array(z.number())`、`activeLoopNodeId: z.string().nullable()`、`activeLoopStack: z.array(z.string())`
  - **`pausedStepIds: z.array(z.string())`（第 340 行）**
  - `stageContracts: z.record(z.string(), StageContractSchema)`、`createdAt / updatedAt: z.string()`
- `ExecutedStepDefaultSchema`（第 270–296 行）已含生命周期预留字段：`sessionMeta?: StepSessionMetaSchema`、`pausedAt?`、`resumedAt?`、`resumePrompt?`、`pauseEntryId?`、`error?`、`output?: z.array(ContentBlockSchema)`。
- 存储层 `sandoreDomainSpec`：三表 `definitions`/`jobs`/`state`（state 表 value 即 `WorkflowTaskState`）。

### 4. `workflow/src/types.ts` 的 PendingQuestion / PendingPermission

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`

- **`PendingQuestion`（第 147–152 行）**：
  ```ts
  interface PendingQuestion { stepId: string; sessionId: string; requestId: string; questions: AskUserQuestionPayload }
  ```
- **`PendingPermission`（第 161–169 行）**：
  ```ts
  interface PendingPermission {
    stepId: string; sessionId: string; requestId: string;
    permission: string; patterns?: string[]; metadata?: Record<string, unknown>; tool?: string
  }
  ```
- 关联：`AskUserQuestionPayload`（从 schema.ts re-export）、`DagInstanceState`（browser-safe 投影，不含 `pendingInteractions`/`pausedStepIds`，仅含 `taskId/jobId/workflowId/status/originalInput/currentStageId/executedSteps/stageInfos/pendingQueue/createdAt/updatedAt`）。
- 注意：`PendingQuestion`/`PendingPermission` 当前**无** `id`/`status`/`answer`/`stageId` 字段。

### 5. `workflow-engine.ts` 的 makeInitialState

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts`

- **`makeInitialState`（第 74–104 行）**：返回完整 `WorkflowTaskState`，初始值关键项：`status:'pending'`、`currentStageId: definition.stages[0]?.id ?? ''`、`executedSteps:[]`、`stageInfos`（每 Stage `status:'blocked'`）、**`pendingInteractions:[]`**、`pendingQueue:[]`、`visitCounts:{}`、`passThroughVars:{}`、`activeLoopIterationStack:[]`、`activeLoopNodeId:null`、`activeLoopStack:[]`、**`pausedStepIds:[]`**、`stageContracts:{}`、`createdAt/updatedAt`。
- **`SandoreEngineRuntime`（默认导出）**：`static Config` 同 stub；**`static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`**（与 stub 一致）。
- 已实现：`startInstance`（读定义→parse→makeInstanceId→makeInitialState→`ctx.sessions.create`→persistState→`void execute()`）、`getState`（内存优先、state 表兜底）、`abortInstance`（终态拒绝、`controller.abort()`）。
- 未实现（抛 `SandoreError('INVALID_OPERATION')`）：`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`（第 197–227 行）。
- `runInstance` 主循环：Stage 级线性 while；`StageStepHooks` 仅 onStepStart/onStepCompleted/onStepFailed（**无 onStepPaused/onStepResumed 钩子**）；`result.status==='interacting'` 时置 `interacting` 并 return（注释「Task 4 接续」）。

### 6. `workflow/tests/mocks/{agents,subagents,sessions}.ts` 现有桩

- **`agents.ts`**（`D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\agents.ts`）：`FakeSession`（记录 `SessionEvent[]`）、`assistantMessageEvent`/`assistantChunkEvent` 构造器、`FakeAgent implements Agent`（`whenIdle` 立即 resolve）、`FakeAgentRegistry implements AgentRegistry`（`get`/`create`/`resume` + `register`）。
- **`subagents.ts`**（`D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\subagents.ts`）：`FakeFollowup` 记录；`FakeSubagents implements SubagentRuntime`（`startContinuable`/`followup`/`interrupt`/`start` 均记录调用，`startContinuable` 返回 `child-N`/`msg-N`，`followup` 返回 `msg-N`，`start` 返回空 output + `stopReason:'completed'`）。**无 `listChildren` 桩**。
- **`sessions.ts`**（`D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\sessions.ts`）：`FakeSession`（`append(type,data)` 记录）、`FakeSessionStore`（`create`/`get`/`list`）。

### 7. 存量 `pausedStepIds` 引用位置

**源码引用**（需随 schema 改名同步）：
- `packages\sandore\workflow\src\schema.ts:340`（定义 `pausedStepIds: z.array(z.string())`）
- `packages\sandore\workflow\src\workflow-engine.ts:99`（`makeInitialState` 初值）
- 单测：`schema.spec.ts:129`、`persistence.spec.ts:35`、`remote.spec.ts:59,134`、`workflow-engine.spec.ts:297`（快照对象字面量中 `pausedStepIds: []`）

**spec 引用**：
- `furina\changes\task-4-lifecycle\specs\lifecycle-pause-resume\spec.md:49`（THEN：字段名为 `pausedChildIds`，不再存在 `pausedStepIds`）——即 **Task 4 的改名依据**。

**其他文档引用**：
- `furina\changes\task-4-lifecycle\design.md:63,65,132,149`；`proposal.md:16,31`；`plan.json`（多处）
- `docs\design\task-4-lifecycle\design.md:289,298,301,331,362,372,438,620,663`；`docs\design\overall-design.md:298`；`docs\engine\dsh-workflow.md:425,448`
- 归档 spec/文档：`furina\archive\2026-08-15-task-2-minimal-engine\...`、`furina\archive\2026-08-15-task-3-full-dag\...`（历史字段说明，非本次变更范围）

### 8. DSH 参考源码真实形状核实

路径根：`D:\project-code\llm\deepseek-harness`

#### 8.1 `packages/core/agent/src/runtime-types.ts`

- **`AgentOptions`**（真实）：`{ provider?: string; model?: string; maxTokens?: number }` —— 与 sandore 本地复刻**一致**。
- **`AgentStatus = 'idle' | 'running'`** —— 一致（无 `paused`/`interacting` 态）。
- **`Agent`（真实，第 64–144 行）**：
  - 字段：`readonly id: SessionId`、`readonly options: AgentOptions`、`readonly session: Session`、**`readonly inbox: Inbox`**、`readonly status: AgentStatus`、**`readonly ctx: Context`**
  - 方法：`cancel(cause, options?)`、`whenIdle(): Promise<void>`、`runMaintenance<T>(task)`、`send(message, target, wakeup)`、`followup(message)`、`steer(message)`、`inject(message)`
  - 差异：sandore 本地 `Agent` 仅保留 `id/options/session/status/whenIdle`，**未建模 `inbox`/`ctx`/`cancel`/`runMaintenance`/`send`/`followup`/`steer`/`inject`**。

#### 8.2 `packages/core/agent/src/index.ts`（CreateAgentOptions / ResumeAgentOptions / AgentHandle / AgentRegistry）

- **`CreateAgentOptions`（真实，第 80–133 行）**：
  ```ts
  interface CreateAgentOptions {
    readonly sessionId: SessionId
    readonly meta?: { cwd?; parentSession?: SessionId; seedLength?; origin?: 'subagent'; delegationDepth?; agentPreset? }
    readonly seed?: readonly SessionEvent[]
    readonly agentOptions?: AgentOptions
    readonly signal?: AbortSignal
    readonly setup?: AgentSetup   // (agentCtx) => AgentSetupCommit | ... 
  }
  ```
  差异：sandore 本地复刻**缺 `meta`/`seed`/`setup`**（proposal 提出补 `meta/seed/setup`）。
- **`ResumeAgentOptions`（真实，第 139–156 行）**：`{ resumeSessionId; agentOptions?; signal?; setup? }` —— sandore 本地**缺 `setup`**。
- **`AgentHandle`（真实，第 172–175 行）**：`{ agent: Agent; dispose(): Promise<void> }` —— 一致。
- **`AgentRegistry`（真实，`class AgentRegistry extends Service`，Service 名 `'agents'`，`ctx.agents` 注入）**：
  - `get(id: SessionId): Agent | undefined`（第 583 行）
  - `create(options: CreateAgentOptions): Promise<AgentHandle>`（第 405 行）
  - `resume(options: ResumeAgentOptions): Promise<AgentHandle>`（第 424 行）
  - 另有 `list(): Agent[]`、`register(agent)`、`isOwnedBy(id, owner)`、`currentInitiator()` 等
  差异：sandore 本地 `AgentRegistry` 是**接口**且仅 `get/create/resume`；DSH 是 Service 类。

#### 8.3 `packages/subagent/subagent/src`（SubagentRuntime / listChildren）

- **`SubagentRuntime`（真实，`class SubagentRuntime extends Service`，Service 名 `'subagents'`，`ctx.subagents` 注入）**：
  - `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`（index.ts 第 212 行）
  - `followup(parent, childId, content, options): Promise<MessageId>`（第 231 行）
  - `interrupt(targetSessionId, authority): void`（第 255 行）
  - `start(name, request: SubagentStartRequest): Promise<SubagentRun>`（第 414 行）
  - **`listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>`（第 339 行）**
  - `listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>`（第 358 行）
  - 另有 `registerProvider`/`getProvider`/`list`/`report`/`drainContinuableDescendants` 等
  差异：sandore 本地 `SubagentRuntime` 接口**无 `listChildren`/`listDescendants`**。

- **`listChildren` 底层函数**（`list-children.ts` 第 134–146 行）：`listChildren(ctx: Context, parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>`；服务方法委托它。
- **`SubagentListEntry`（真实形状，list-children.ts 第 44–87 行）**：
  ```ts
  type SubagentListEntry =
    | { kind: 'child'; id: SessionId; activity: 'running' | 'inactive'; hasChildren: boolean }
        & ({ mode: 'one-shot'; label?: string } | { mode: 'continuable'; label: string })
    | { kind: 'diagnostic'; id: SessionId; reason: 'corrupt' | 'unsupported' | 'unavailable' }
  ```
- **`SubagentDescendantListEntry`** = `SubagentListEntry & { parentId: SessionId; depth: number }`。
- **`ContinuableStartSpec`（continuation.ts 第 112–124 行）**：`{ provider: string; label: string; request: Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>; signal: AbortSignal }` —— 与 sandore 本地一致（sandore 的 `ContinuableStartRequest` 即该 `Omit` 展开）。
- **`ContinuableStart`（第 127–132 行）**：`{ childId: SessionId; messageId: MessageId }` —— 一致。
- **`SubagentInterruptAuthority`（第 139–141 行）**：`{ kind:'user'; parentSessionId } | { kind:'ancestor'; agent }` —— 一致。
- **`SubagentFollowupOptions`（第 144–149 行）**：`{ source: MessageSource; signal: AbortSignal }` —— 一致。
- **`SubagentStartRequest`（真实，types.ts 第 100–149 行）**：`{ label?; prompt: ContentBlock[]; parent: Agent; signal: AbortSignal; agentOptions?; outputSchema?: ObjectJsonSchema; maxDepth?; toolFilter?: ToolRestriction; persona? }` —— sandore 本地**缺 `outputSchema`**（其余一致）。
