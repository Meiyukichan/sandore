# Task 4 seam-01 探索：参考实现与落点

## 一、需求理解

**What**：探索 Task 4（工作流生命周期：暂停/恢复/中止/重试/交互）在 seam-01 阶段的参考实现与落地位置，即：sandore 引擎现有的 capability seam（`ctx.subagents`/`ctx.agents` 结构类型面）、`SandoreEngine` 抽象面与 DI 注入清单、运行时/存储 schema（`WorkflowTaskStateSchema`/`StepSessionMetaSchema`）、交互类型（`PendingQuestion`/`PendingPermission`）、初始状态构造（`makeInitialState`）、测试桩（`workflow/tests/mocks/*`），以及 DSH 上游真实 API（`Agent`/`CreateAgentOptions`/`ResumeAgentOptions`/`listChildren`）的形状。

**Boundaries**：`packages/sandore/microflow/src/subagents.ts`、`packages/sandore/workflow/src/{seam,schema,types,workflow-engine}.ts`、`packages/sandore/workflow/tests/mocks/{agents,subagents,sessions}.ts`、存量 spec 中 `pausedStepIds` 引用位置，以及 `D:\project-code\llm\deepseek-harness\packages\core\agent\src\{runtime-types,index}.ts`、`packages\subagent\subagent\src\{index,types,continuation,list-children}.ts`。

**Goal**：为 seam-01 的「接缝与 schema 扩展」提供真实代码依据（现状类型面 + DSH 上游形状 + 字段改名/引用位置），不做实现、不评估可行性。

---

## 二、microflow/src/subagents.ts 现有结构类型面

路径：`D:\project-code\llm\sandore\packages\sandore\microflow\src\subagents.ts`（210 行）。

该文件是 sandore 引擎使用的 `ctx.subagents` / `ctx.agents` 能力接缝，**本地结构类型声明**，`@deepseek-ai/dsh-subagent` 与 `@deepseek-ai/dsh-agent` 未作为运行时依赖安装（文件头注释明确说明）。末尾通过 `declare module '@deepseek-ai/cordis'` 在 `Context` 上声明 `subagents: SubagentRuntime` 与 `agents: AgentRegistry` 两个键。

现有导出的类型面（按文件顺序）：

| 类型 | 形状（关键字段） |
|---|---|
| `SessionId` / `MessageId` | `string`（与 DSH 品牌字符串结构兼容） |
| `AgentOptions` | `{ provider?, model?, maxTokens? }` |
| `AgentStatus` | `'idle' \| 'running'` |
| `Session` | `{ readonly events: readonly SessionEvent[] }` |
| `Agent` | `{ readonly id: SessionId; readonly options: AgentOptions; readonly session: Session; readonly status: AgentStatus; whenIdle(): Promise<void> }` |
| `AgentHandle` | `{ agent: Agent; dispose(): Promise<void> }` |
| `CreateAgentOptions` | `{ readonly sessionId: SessionId; readonly agentOptions?: AgentOptions; readonly signal?: AbortSignal }` |
| `ResumeAgentOptions` | `{ readonly resumeSessionId: SessionId; readonly agentOptions?: AgentOptions; readonly signal?: AbortSignal }` |
| `AgentRegistry` | `{ get(id): Agent \| undefined; create(options): Promise<AgentHandle>; resume(options): Promise<AgentHandle> }` |
| `ToolRestriction` | `{ readonly allow?: readonly string[]; readonly deny?: readonly string[] }` |
| `ContinuableStartRequest` | 委派请求（`prompt`/`parent`/`agentOptions?`/`maxDepth?`/`toolFilter?`/`persona?`） |
| `ContinuableStartSpec` | `{ provider; label; request: ContinuableStartRequest; signal }` |
| `ContinuableStart` | `{ childId: SessionId; messageId: MessageId }` |
| `SubagentFollowupOptions` | `{ source: MessageSource; signal: AbortSignal }` |
| `SubagentInterruptAuthority` | `{ kind:'user'; parentSessionId } \| { kind:'ancestor'; agent: Agent }` |
| `SubagentStartRequest` | `{ label?; prompt; parent; signal; agentOptions?; maxDepth?; toolFilter?; persona? }` |
| `SubagentRun` | `{ id; localAgent: Agent \| undefined; result: Promise<SubagentResult>; dispose() }` |
| `SubagentResult` | `{ output: ContentBlock[]; structured?: unknown; stopReason: SubagentStopReason }` |
| `SubagentStopReason` | `'completed' \| 'aborted' \| 'error' \| 'max-tokens' \| 'refusal'` |
| `SubagentRuntime` | `{ startContinuable(spec): Promise<ContinuableStart>; followup(parent, childId, content, options): Promise<MessageId>; interrupt(targetSessionId, authority): void; start(name, request): Promise<SubagentRun> }` |
| `SessionEvent` | `assistant/message` 与 `assistant/chunk` 两类事件的联合（含 `seq`/`time` 包络） |
| `finalAssistantOutput(events)` | 选取最后一条非空 assistant message → 回退 text-delta 累积 → undefined |

**与 DSH 真实形状的缺口（seam-01 相关）**：

- 当前 `Agent` 仅 5 成员；DSH 真实 `Agent` 还含 `inbox`、`ctx`、`cancel`、`runMaintenance`、`send`、`followup`、`steer`、`inject`（见下文 DSH 部分）。
- 当前 `CreateAgentOptions` 缺 `meta` / `seed` / `setup` 三字段。
- 当前 `ResumeAgentOptions` 缺 `setup` 字段。
- 当前 `AgentRegistry` 与 `SubagentRuntime` 均无 `listChildren` / `listDescendants` 方法。

以上缺口与 `furina/changes/task-4-lifecycle/proposal.md:16` 的「补 `CreateAgentOptions.meta/seed/setup`、`ResumeAgentOptions.setup`、`Agent.inbox/ctx`、`SubagentRuntime.listChildren`」一致。

---

## 三、workflow/src/seam.ts：static inject 与 SandoreEngine 抽象面

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`（174 行）。

### 3.1 `SandoreEngine` 抽象类（第 70–100 行）

`export abstract class SandoreEngine extends Service`，构造器 `super(ctx, 'sandoreEngine')`。共 **11 个抽象实例方法**（Service 层只暴露实例级操作，定义/Job CRUD 在 Host RPC 层）：

| 方法 | 签名 |
|---|---|
| `startInstance` | `(request: DagStartRequest): DagRun`（同步） |
| `recoverInstance` | `(instanceId: string): Promise<DagRun>` |
| `abortInstance` | `(instanceId: string): Promise<void>` |
| `replyQuestion` | `(instanceId, requestId, answers: unknown): Promise<void>` |
| `replyPermission` | `(instanceId, requestId, reply: 'once' \| 'always' \| 'reject'): Promise<void>` |
| `pauseStep` | `(instanceId, stepId): Promise<void>` |
| `resumeStep` | `(instanceId, stepId, resumePrompt?): Promise<void>` |
| `pauseAllSteps` | `(instanceId): Promise<void>` |
| `resumeAllSteps` | `(instanceId, resumePrompt?): Promise<void>` |
| `retryStep` | `(instanceId, stepId, mode: 'continue' \| 'revert' \| 'fork', message: string): Promise<void>` |
| `getState` | `(instanceId): DagInstanceState`（同步） |

### 3.2 13 个 `sandore/*` 事件双声明

Cordis `Events`（第 29–43 行）与 Session `SessionEventMap`（第 46–62 行）各 13 条：`start` / `stage-start` / `stage-completed` / `step-start` / `step-completed` / `step-failed` / `step-paused` / `step-resumed` / `step-retried` / `question` / `permission` / `end` / `aborted`。其中 `step-paused` 载荷为 `{ stepId, childId }`（Session 侧）与 `(info, stepId, childId)`（Cordis 侧）。

### 3.3 `SandoreConfig` 与 Provider 桩（第 102–173 行）

- `SandoreConfig`：`{ defaultTimeoutMs?, maxConcurrentSteps?, defaultProvider?, defaultModel? }`。
- `SandoreEngineStub extends SandoreEngine`：
  - `static Config`（schemastery）：`defaultTimeoutMs` 默认 7200000、`maxConcurrentSteps` 默认 0、`defaultProvider`/`defaultModel` 为字符串。
  - **`static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`**（7 项，第 128 行）——**当前不含 `agents` / `userQuestions`**。
  - 11 个方法均抛 `not implemented`。

注意：`workflow-engine.ts` 的 `SandoreEngineRuntime`（第 131–139 行）重复声明了**完全相同**的 `Config` 与 `inject`（7 项，不含 `agents`）。seam-01 若补 inject，两处需同步。

---

## 四、workflow/src/schema.ts：WorkflowTaskStateSchema / StepSessionMetaSchema

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`（402 行）。记录 schema 用真实 `zod`（`z.infer` 派生类型），插件 Config 才用 schemastery。

### 4.1 `StepSessionMetaSchema`（第 185–189 行）

```ts
export const StepSessionMetaSchema = z.object({
  childId: z.string(),
  synthetic: z.boolean(),
  command: z.enum(['shell', 'prompt', 'agent', 'skill', 'mcp']),
})
```
替代 SDK 时代 `{sessionId,inputJson,outputJson,partsJson}` 的合成占位元数据。

### 4.2 `WorkflowTaskStateSchema`（第 323–344 行）

存储域 `state` 表 value（`sandoreDomainSpec` 三表之一，第 368–376 行）。字段：

```
taskId, jobId, workflowId, cwd,
status: DagRunStatusSchema（7 态：pending/running/interacting/completed/failed/aborted/paused）,
originalInput, currentStageId,
executedSteps: z.array(ExecutedStepDefaultSchema),
stageInfos: z.array(StageInfoSchema),
pendingInteractions: z.array(z.unknown()),          // ← 占位，未结构化
pendingQueue: z.array(z.string()),
visitCounts: z.record(z.string(), z.number()),
passThroughVars: z.record(z.string(), PassThroughVarValueSchema),
activeLoopIterationStack: z.array(z.number()),
activeLoopNodeId: z.string().nullable(),
activeLoopStack: z.array(z.string()),
pausedStepIds: z.array(z.string()),                // ← 第 340 行，seam-01 改名目标
stageContracts: z.record(z.string(), StageContractSchema),
createdAt, updatedAt
```

### 4.3 相关 schema（Task 4 直接关联）

- `StepStatusSchema`（第 15 行）：`['blocked','ready','interacting','running','completed','failed','paused']`（含 `paused`）。
- `DagRunStatusSchema`（第 18 行）：7 态（含 `interacting`/`paused`）。
- `ExecutedStepDefaultSchema`（第 270–296 行）：含 `sessionMeta?`、`pausedAt?`、`resumedAt?`、`resumePrompt?`、`pauseEntryId?`、`retryHistory?`、`parentSessionId?`、`output?` 等（pause/resume 语义字段已预留）。
- `AskUserQuestionPayloadSchema`（第 192–203 行）、`FinalizeMetaSchema`/`FinalizeAssessResultSchema`/`GateEvalResultSchema`（第 206–240 行）、`BranchMetaSchema`（第 243–249 行）、`RetryRecordSchema`（第 261–267 行）。

---

## 五、workflow/src/types.ts：PendingQuestion / PendingPermission

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`（178 行）。browser-safe 纯类型文件，从 `schema.ts` 收紧深层依赖类型并 re-export。

### 5.1 `PendingQuestion`（第 147–152 行）

```ts
export interface PendingQuestion {
  stepId: string
  sessionId: string
  requestId: string
  questions: AskUserQuestionPayload
}
```

### 5.2 `PendingPermission`（第 161–169 行）

```ts
export interface PendingPermission {
  stepId: string
  sessionId: string
  requestId: string
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  tool?: string
}
```

### 5.3 相邻类型

- `DagRunStatus`（第 69 行）：7 态同 schema。
- `DagInstanceState`（第 72–84 行）：`WorkflowTaskState` 的投影，**不含** `pendingInteractions`/`pausedStepIds`（仅 taskId/jobId/workflowId/status/originalInput/currentStageId/executedSteps/stageInfos/pendingQueue/createdAt/updatedAt）。
- `ExecutedStepDefault`（第 87–113 行）：与 schema 的 `ExecutedStepDefaultSchema` 对应（`output?: ContentBlock[]` 类型更窄）。
- `FinalizeOutcome`（第 155–158 行）：done/ask/error 三态联合。
- `StepStatus`（第 123 行）：7 态含 `paused`。

---

## 六、workflow-engine.ts：makeInitialState 与运行时现状

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts`（495 行）。

### 6.1 `makeInitialState`（第 73–104 行）

签名：`(options: { instanceId; request: DagStartRequest; definition: WorkflowDefinition; createdAt; cwd }) => WorkflowTaskState`。返回完整快照，各字段初值：

```
taskId=instanceId, jobId=request.jobId, workflowId=request.workflowId, cwd,
status: 'pending', originalInput=request.originalInput,
currentStageId = definition.stages[0]?.id ?? '',
executedSteps: [], stageInfos: 每 Stage {status:'blocked'},
pendingInteractions: [], pendingQueue: [], visitCounts: {}, passThroughVars: {},
activeLoopIterationStack: [], activeLoopNodeId: null, activeLoopStack: [],
pausedStepIds: [],            // ← 第 99 行
stageContracts: {}, createdAt, updatedAt=createdAt
```

### 6.2 `SandoreEngineRuntime`（第 131 行起）

- `static Config` / `static inject` 与 seam 的 Stub **完全相同**（7 项 inject，不含 `agents`）。
- `ActiveInstance`（第 43–48 行）：`{ controller: AbortController; session: Session; definition: WorkflowDefinition; state: WorkflowTaskState }`——**目前无 `hostAgent`**。
- `startInstance`（第 148–169 行）：当前用 **`ctx.sessions.create(SessionId(instanceId), { meta: { cwd } })`** 建宿主 Session（裸 Session，非 `ctx.agents.create` 主代理），随后 fire-and-forget `execute`。
- `getState`（第 172–183 行）：内存优先，state 表兜底。
- `abortInstance`（第 186–195 行）：仅 `controller.abort()`，未做登记表 interrupt 与 ActiveInstance 清理。
- 8 个方法 `recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep` 均抛 `SandoreError('...is not implemented', 'INVALID_OPERATION')`（第 197–227 行）。
- `runInstance`（第 256–394 行）Stage 级线性主循环；`result.status === 'interacting'` 分支（第 365–371 行）仅置 `interacting` 后 `return`，注释标注「Task 4 接续」。

---

## 七、workflow/tests/mocks 现有桩

### 7.1 agents.ts（`D:\...\workflow\tests\mocks\agents.ts`，114 行）

- 从 `microflow/src/subagents.ts` 导入类型（`Agent`/`AgentHandle`/`AgentOptions`/`AgentRegistry`/`CreateAgentOptions`/`ResumeAgentOptions`/`Session`/`SessionEvent`/`SessionId` 等）。
- `FakeSession implements Session`：`events: SessionEvent[]` + `append(event)`。
- 助手：`assistantMessageEvent(content, seq?, time?)`、`assistantChunkEvent(text, seq?, time?)`（供 `finalAssistantOutput` 测试）。
- `FakeAgent implements Agent`：`id/options/session/status: 'idle'`、`whenIdle()` 立即 resolve。
- `FakeAgentRegistry implements AgentRegistry`：内部 `Map<SessionId, FakeAgent>`；`get/create/resume`（`create` 用 `options.sessionId`、`resume` 用 `options.resumeSessionId`，均返回 `{ agent, dispose }`）+ `register`。

### 7.2 subagents.ts（`D:\...\workflow\tests\mocks\subagents.ts`，66 行）

- `FakeFollowup`：`{ parent; childId; content; options }` 记录。
- `FakeSubagents implements SubagentRuntime`：四个记录数组 `continuableStarts`/`followups`/`interrupts`/`startCalls`。
  - `startContinuable` → `{ childId: 'child-<n>', messageId: 'msg-<n>' }`。
  - `followup` → `'msg-<n>'`。
  - `interrupt` → 记录 `{ targetSessionId, authority }`。
  - `start` → `{ id: 'run-<n>', localAgent: undefined, result: { output: [], stopReason: 'completed' }, dispose }`。

### 7.3 sessions.ts（`D:\...\workflow\tests\mocks\sessions.ts`，39 行）

- `FakeSession`：`events: Array<{ type; data }>`；`append(type, data)` 返回 `{ type, seq, time, data }`。
- `FakeSessionStore`：`Map<string, FakeSession>`；`create(id?)`/`get(id)`/`list()`。

**落点提示**：三个 mock 的类型均 import 自 `microflow/src/subagents.ts`；seam-01 若扩展接缝类型（如 `Agent.inbox/ctx`、`listChildren`、`CreateAgentOptions.meta/seed/setup`），这些 mock 需同步补齐实现。

---

## 八、存量 spec 中 `pausedStepIds` 的引用位置

### 8.1 源码与测试 fixture（非 spec 文档）

| 位置 | 行 | 内容 |
|---|---|---|
| `packages/sandore/workflow/src/schema.ts` | 340 | `pausedStepIds: z.array(z.string())`（字段定义） |
| `packages/sandore/workflow/src/workflow-engine.ts` | 99 | `makeInitialState` 初值 `pausedStepIds: []` |
| `packages/sandore/workflow/src/schema.spec.ts` | 129 | 测试 fixture |
| `packages/sandore/workflow/src/persistence.spec.ts` | 35 | 测试 fixture |
| `packages/sandore/workflow/src/workflow-engine.spec.ts` | 297 | 测试 fixture |
| `packages/sandore/workflow/src/remote.spec.ts` | 59、134 | 测试 fixture |

### 8.2 Task 4 规划文档（`furina/changes/task-4-lifecycle/`）

- `proposal.md:16`：**BREAKING**（schema）`WorkflowTaskStateSchema.pausedStepIds` → `pausedChildIds`（值=childId，开发期改名零迁移成本）；`pendingInteractions` 从 `unknown[]` 收紧为结构化 pending 条目；`seam.ts` inject 补 `agents`/`userQuestions`。
- `proposal.md:31`：改名属本变更内部字段演进，开发期无生产数据，非 spec 级行为变更。
- `design.md:63/65`：D-3 暂停登记表 `pausedChildIds`（改名自 `pausedStepIds`，值=childId）+ 内存 `Set` 与持久化同步；改名理由=值语义是子代理 SessionId，`pausedStepIds` 名实不符。
- `design.md:132`：`WorkflowTaskStateSchema` 的 `pausedStepIds` → `pausedChildIds: z.array(z.string())`；`pendingInteractions` → `z.array(z.union([PendingQuestionEntrySchema, PendingPermissionEntrySchema]))`。
- `design.md:149`：开发期直接改字段名，无迁移代码；存量 Task 2/3 单测引用旧字段的用例同步更新。
- `plan.json:9`：`WorkflowTaskStateSchema` 不再含 `pausedStepIds`，含 `pausedChildIds: z.array(z.string())`；含旧 `pausedStepIds` 的对象 parse 失败。
- `plan.json:14`：存量测试 `pausedStepIds` 全部替换为 `pausedChildIds`，vitest 通过。
- `plan.json:23`：任务 1.7 更新存量测试 `pausedStepIds` 引用。
- `specs/lifecycle-pause-resume/spec.md:49`：**THEN 暂停登记表字段名为 `pausedChildIds`（不再存在 `pausedStepIds` 字段）**。
- `specs/lifecycle-pause-resume/spec.md`（第 4/8/19/23/30/37/41/45/55/59/63 行）：pause/resume 语义全部用 `pausedChildIds` 表达（登记表值=childId，经 `executedSteps[].sessionMeta.childId` 反查）。

### 8.3 历史/设计文档（`docs/` 与 `furina/archive/`）

- `docs/design/task-4-lifecycle/design.md:289/298/301/331/362/372`：旧版设计（v2.6 SDK 语义）用 `pausedStepIds`；`:438` 说明 DSH 迁移后升级为 `pausedChildIds: Set<string>`（对应原 `pausedStepIds[]`）；`:663` A 阶段改名。
- `docs/design/overall-design.md:298`：迁移后改名 `pausedChildIds`（原 `pausedStepIds[]`）。
- `docs/engine/dsh-workflow.md:425/448`：`pausedStepIds[]` 迁移为 DSH 的 `pausedChildIds`（唯一权威）。
- `furina/archive/` 下 Task 2/3 的 explore/design/coding 文档多处历史引用（归档态，非活跃 spec）。

---

## 九、DSH 参考源码真实形状

### 9.1 `packages/core/agent/src/runtime-types.ts`

- **`AgentOptions`**（第 24–31 行）：`{ provider?: string; model?: string; maxTokens?: number }`（merge-extensible）。
- **`AgentStatus`**（第 50 行）：`'idle' | 'running'`。
- **`Agent`**（第 64–144 行）——真实完整面：

```
readonly id: SessionId
readonly options: AgentOptions
readonly session: Session
readonly inbox: Inbox
readonly status: AgentStatus
readonly ctx: Context
cancel(cause: AgentCancelCause, options?: CancelOptions): void
whenIdle(): Promise<void>
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
followup(message: UserMessage): void
steer(message: UserMessage): void
inject(message: UserMessage): void
```

### 9.2 `packages/core/agent/src/index.ts`

- **`AgentSetup`**（第 69–71 行）：`(agentCtx: Context) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void`。
- **`CreateAgentOptions`**（第 80–133 行）——真实完整面：

```
readonly sessionId: SessionId
readonly meta?: {
  cwd?: string
  parentSession?: SessionId
  seedLength?: number
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}
readonly seed?: readonly SessionEvent[]
readonly agentOptions?: AgentOptions
readonly signal?: AbortSignal
readonly setup?: AgentSetup
```

- **`ResumeAgentOptions`**（第 139–156 行）：

```
readonly resumeSessionId: SessionId
readonly agentOptions?: AgentOptions
readonly signal?: AbortSignal
readonly setup?: AgentSetup
```

- **`AgentHandle`**（第 172–175 行）：`{ agent: Agent; dispose(): Promise<void> }`（dispose 是能力：仅持有者可拆除）。
- **`AgentFactory`**（第 183–214 行）：`createAgent(ownerCtx, options): Promise<AgentHandle>`、`resume(ownerCtx, options): Promise<AgentHandle>`。
- **`AgentRegistry extends Service`**（第 256 行起）：`create(options): Promise<AgentHandle>`（第 405 行）、`resume(options): Promise<AgentHandle>`（第 424 行）、**`get(id: SessionId): Agent | undefined`**（第 583–584 行）、`register(agent)`、`enter(agent, owner)`、`currentInitiator()`、`withInitiator()` 等。

### 9.3 `packages/subagent/subagent/src/index.ts`（`SubagentRuntime`）

`SubagentRuntime extends Service`（构造器 `super(ctx, 'subagents')`），实例方法：

- `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`（第 212 行）
- `followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>`（第 231 行）
- `interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void`（第 255 行）
- `reportFrom(child, content, options)`、`registerContinuableSetup(contribution)`、`drainContinuableDescendants(parents)`
- **`listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>`**（第 339–341 行，委托 `list-children.ts` 的 `listChildren(this.ctx, parentSessionId, signal)`）
- **`listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>`**（第 358–360 行）
- `registerProvider(provider)` 等

### 9.4 `packages/subagent/subagent/src/list-children.ts`

- **`SubagentListEntry`**（第 44–87 行）：

```
{ kind:'child'; id: SessionId; activity:'running'|'inactive'; hasChildren: boolean }
  & ({ mode:'one-shot'; label?: string } | { mode:'continuable'; label: string })
| { kind:'diagnostic'; id: SessionId; reason:'corrupt'|'unsupported'|'unavailable' }
```

- **`SubagentDescendantListEntry`**（第 94–99 行）：`SubagentListEntry & { parentId: SessionId; depth: number }`。
- `listChildren` 依赖的服务：`ctx.get('sessionProjections')`（缺失抛 `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE`）、`ctx.get('sessions')`（缺失抛 `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE`）、可选 `ctx.get('sessionPersistence')`（`persistence.list(signal)`）与可选 `ctx.get('sessionProjectionCache')`。live-preferred merge：持久化 header 先入 corpus，live `sessions.list()` 后写覆盖。

### 9.5 `packages/subagent/subagent/src/continuation.ts`（seam 类型真源）

- **`ContinuableStartSpec`**（第 112–124 行）：`{ provider: string; label: string; request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>; signal: AbortSignal }`。
- **`ContinuableStart`**（第 127–132 行）：`{ childId: SessionId; messageId: MessageId }`。
- **`SubagentInterruptAuthority`**（第 139–141 行）：`{ kind:'user'; parentSessionId: SessionId } | { kind:'ancestor'; agent: Agent }`。
- **`SubagentFollowupOptions`**（第 144–149 行）：`{ source: MessageSource; signal: AbortSignal }`。

---

## 十、seam-01 相关结论性观察（仅现状，非方案）

1. **接缝缺口**：`microflow/src/subagents.ts` 的 `Agent`/`CreateAgentOptions`/`ResumeAgentOptions`/`AgentRegistry`/`SubagentRuntime` 相对 DSH 真实形状存在明确缺口（缺 `Agent.inbox/ctx`、`CreateAgentOptions.meta/seed/setup`、`ResumeAgentOptions.setup`、`SubagentRuntime.listChildren`/`listDescendants`），与 `proposal.md:16` 列举的补齐项一一对应。
2. **inject 落点**：`seam.ts` 与 `workflow-engine.ts` 两处 `static inject` 均为 7 项（`sessions/sessionPersistence/subagents/llm/shell/fs/storageDomain`），**均不含 `agents`**；proposal 要求补 `agents`/`userQuestions`，两处需同步改。
3. **schema 改名落点**：`pausedStepIds` 现定义于 `schema.ts:340`、初值于 `workflow-engine.ts:99`，测试 fixture 于 4 个 spec 文件；spec 已明确要求改名 `pausedChildIds`（`specs/lifecycle-pause-resume/spec.md:49`）。
4. **暂停语义接缝**：DSH 的 `interrupt(targetSessionId, { kind:'ancestor', agent })` 与 `followup(parent, childId, content, { source, signal })` 签名，正是 lifecycle spec 中 `pauseStep`/`resumeStep` 直接调用的形状；sandore 本地 `SubagentRuntime` 已复刻这两个签名（形状一致）。
5. **宿主主代理**：`host-agent/spec.md` 要求 `startInstance` 从 `ctx.sessions.create` 改为 `ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup })`，并在 `ActiveInstance` 增 `hostAgent`、`StepRunnerConfig` 增 `hostAgent`——当前 `ActiveInstance`（`workflow-engine.ts:43-48`）尚无此字段，`startInstance` 仍是裸 Session 创建。
