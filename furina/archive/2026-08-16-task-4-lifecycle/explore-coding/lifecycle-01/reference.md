## Exploration Result

> 说明：`furina config show exploration.reference` 返回空数组 `[]`，因此本次探索直接以 `exploreContent` 列举的 8 项本地源码/测试文件为参考材料。以下按 exploreContent 的 8 个条目逐项记录实测结果。所有行号均指向探索时点的真实文件内容。

---

### ① workflow-engine.ts（引擎运行时主循环与 abort 现状）

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts`

**ActiveInstance 结构**（第 50-58 行）：

```ts
interface ActiveInstance {
  readonly controller: AbortController;
  readonly session: Session;
  readonly hostAgent: Agent;
  readonly definition: WorkflowDefinition;
  readonly interactions: InteractionManager;
  state: WorkflowTaskState;   // 唯一可变字段，每次状态变化整体替换（不可变更新）
}
```

- `controller` 是引擎级取消信号源，`startInstance` 中 `new AbortController()` 创建，传入 `InteractionManager` 的 `followup`/`delegateSubagentAsk`（作为 `signal`）。
- `state` 为可变字段，其余 `readonly`。

**instances Map**（第 164 行）：

```ts
private readonly instances = new Map<string, ActiveInstance>();
```

- 键为 `instanceId`，`startInstance` 组装 `active` 后 `this.instances.set(instanceId, active)`；`getState`/`abortInstance`/`replyQuestion`/`replyPermission` 均先 `this.instances.get(instanceId)`，未命中按 `NODE_NOT_FOUND` 抛错（getState 额外回退持久化 state 表）。

**终态集合**（第 61 行）：

```ts
const TERMINAL_STATUSES: ReadonlySet<WorkflowTaskState['status']> = new Set(['completed', 'failed', 'aborted']);
```

**persistState**（第 519-529 行）：

```ts
private async persistState(active: ActiveInstance): Promise<void> {
  const persistence = this.persistence();            // this.ctx.get('sandorePersistence')
  if (persistence === undefined) return;
  try {
    await persistence.saveWorkflowState(active.state);
  } catch (error) {
    this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`);
  }
}
```

- 每次状态变化后调用，失败仅 warn 不抛出。

**emitContained / safeAppend 双发范式**（第 533-552 行）：

```ts
private emitContained(name: string, args: unknown[]): void {
  for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
    try {
      const returned: unknown = callback(...args);
      void Promise.resolve(returned).catch(...warn...);
    } catch (error) { ...warn... }
  }
}
private safeAppend(fn: () => void): void {
  try { fn(); } catch (error) { ...warn... }
}
```

- 每个 `sandore/*` 事件都双发：`emitContained('sandore/xxx', [args])`（经 `ctx.events.dispatch('emit', ...)` 分发给监听器，监听器异常被吞掉）+ `safeAppend(() => session.append('sandore/xxx', payload))`（写宿主 Session 日志，异常吞掉）。
- 现有事件名：`sandore/start`、`sandore/stage-start`、`sandore/stage-completed`、`sandore/step-start`、`sandore/step-completed`、`sandore/step-failed`、`sandore/end`、`sandore/aborted`、`sandore/question`、`sandore/permission`（`emitStart` 等第 554-612 行）。

**runnerConfig**（第 490-513 行）：

```ts
private runnerConfig(definition, hostAgent, active): StepRunnerConfig {
  return {
    defaultTimeoutMs: this.config.defaultTimeoutMs ?? 7200000,
    ...(defaultProvider/defaultModel 存在时展开),
    skills: definition.skills,
    mcps: definition.mcps,
    agents: definition.agents,
    hostAgent,
    onDelegatedAsk: async ({ childId, output, stepId, stageId }) => {
      const result = await active.interactions.delegateSubagentAsk({...});
      return result.delegated;
    },
  };
}
```

**runInstance 主循环**（第 315-479 行）：

- `signal = controller.signal`（第 317 行）；置 `status='running'` + `emitStart`；构造 `runnerConfig` + `WorkflowDagNavigator` + `FinalizeManager`。
- `while (stageId !== '')` 逐 Stage：`markStageStatus(stageId,'running')` → `emitStageStart` → 组装 `StageStepHooks`（onStepStart/onStepCompleted/onStepFailed 三个事件钩子）→ `new StageExecutor({...})`，其中注入 `onPersist` 回调：每个 Step 完成后按唯一执行 `id` upsert 到 `active.state.executedSteps` 并 `persistState`（第 376-391 行）。
- `let result = await executor.execute()`；随后是交互循环 `while (result.status === 'interacting')`（ask 回复续跑：`markStageStatus(stageId,'interacting')` + `status='interacting'` + `interactions.ask` + 再次 `executor.execute()`）。
- Step 失败路径（第 432-453 行）：`result.status === 'failed'` 时先 `markStageStatus(stageId,'failed')`，然后 **`if (signal.aborted)` → `status='aborted'` + `emitAborted`**；否则 `status='failed'` + 写 `stageContracts[stageId]` + `emitEnd(...failed)`。随后 `return`。

**Step 完成等待点（whenIdle 与 interrupt 取消的交互点）**：

- 引擎主循环本身**没有** `interrupt` 调用；当前唯一取消通道是 `controller.abort()` → `signal` 透传到 shell/prompt/llm/subprocess/`startContinuable`。
- `whenIdle` 的等待点在 **step-runner.ts**（见 ③ 与 ⑥）：`runSubagent` 中 `await child.whenIdle()`（第 506、529 行）。`interrupt` 取消子代理当前 turn 的语义在 DSH 参考源码中（见 ⑥），sandore 生产代码当前**未接线** `ctx.subagents.interrupt`（grep 确认 `.interrupt(` 仅出现在 `mocks/subagents.ts` 与 `microflow/src/subagents.spec.ts` 的测试中，workflow-engine.ts 与 step-runner.ts 均无调用）。
- 因此当前 abort 的「交互点」是：abort → `signal` → 正在运行的 Step（shell/prompt/subprocess/llm/subagent start）观察到 abort → StepRunner 抛错或返回 aborted → `processCommandNode` 落到 `failed` → 引擎主循环检测 `signal.aborted` → 落 `aborted` 终态。

**abortInstance 当前实现**（第 236-246 行）：

```ts
async abortInstance(instanceId: string): Promise<void> {
  const active = this.instances.get(instanceId);
  if (active === undefined) {
    throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
  }
  if (TERMINAL_STATUSES.has(active.state.status)) {
    throw new SandoreError(`instance '${instanceId}' is already in terminal state '${active.state.status}'`, 'INVALID_OPERATION');
  }
  active.controller.abort();
}
```

- 仅做 `controller.abort()`；不直接写状态、不直接发 `sandore/aborted`（`aborted` 终态由主循环在 Step 失败时检测 `signal.aborted` 后写入并发出）。
- 未实现（抛 `INVALID_OPERATION` `not implemented`）的方法（第 248-286 行）：`recoverInstance`、`pauseStep`、`resumeStep`、`pauseAllSteps`、`resumeAllSteps`、`retryStep`。

---

### ② microflow/src/subagents.ts（接缝类型）

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\subagents.ts`

**SubagentRuntime.interrupt / followup 签名**（第 187-193 行）：

```ts
export interface SubagentRuntime {
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
  followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>;
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}
```

**Agent 的 status / inbox 字段**（第 37-46 行）：

```ts
export interface Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: { readonly hasPending: boolean };
  readonly status: AgentStatus;   // 'idle' | 'running'
  readonly ctx: unknown;
  whenIdle(): Promise<void>;
}
```

- `AgentStatus = 'idle' | 'running'`（第 29 行）。

**SubagentInterruptAuthority 类型**（第 146-148 行）：

```ts
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent };
```

**SubagentFollowupOptions**（第 140-143 行）：

```ts
export interface SubagentFollowupOptions {
  readonly source: MessageSource;
  readonly signal: AbortSignal;
}
```

---

### ③ microflow/src/stage-executor.ts / step-runner.ts（executedSteps 的 sessionMeta.childId 结构与 Step 状态枚举）

**step-runner.ts**：`D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.ts`

- `StepRunSessionMeta`（第 107-111 行）：`{ childId?: string; synthetic: boolean; command: CommandConfig['type'] }`。
- `runSubagent`（第 478-538 行）流程：`startContinuable` → `ctx.agents.get(started.childId)` → **`await child.whenIdle()`（第 506 行）** → `finalAssistantOutput` → `onDelegatedAsk` 循环（第 512-536 行，其中再次 `await child.whenIdle()` 第 529 行）→ 返回 `{ output, sessionMeta: { childId: started.childId, synthetic: false, command: command.type } }`（第 537 行）。
- shell/prompt Step 不返回 `sessionMeta`（synthetic 占位在 stage-executor 侧合成）。

**stage-executor.ts**：`D:\project-code\llm\sandore\packages\sandore\microflow\src\stage-executor.ts`

- `synthesizeChildId(stepId)`（第 90-93 行）：`step-{stepId}-{execId 前 8 位}`（`execId = randomUUID().replace(/-/g,'').slice(0,8)`）。
- `processCommandNode`（第 348-463 行）构造 `ExecutedStepDefault`：
  - `id = childId`（循环内 `loopManager.getActualStepId(step.id)`，否则 `synthesizeChildId`）；
  - 初始 `sessionMeta: { childId, synthetic: true, command: command.type }`（第 364-366 行）；
  - `runner.run()` 返回后若带 `result.sessionMeta`，覆盖为 `{ childId: result.sessionMeta.childId ?? childId, synthetic: result.sessionMeta.synthetic, command: ... }`（第 401-407 行）——agent/skill/mcp 为真实 childId + `synthetic:false`，shell/prompt 保持 `synthetic:true`。
  - 完成后 `state.executedSteps.push(executed)` + `onPersist(executed)`。
- `SessionEvent` 状态枚举与 `StepStatus` 关系：Step 状态由 `ExecutedStepDefault.status` 表达（见 ⑤），`StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`。**当前 stage-executor 只实际写入 `running`/`completed`/`failed`/`interacting`（通过 `state.status`）四种，`paused` 未使用。**
- `StageRunState`（第 189-206 行）承载断点续跑：`pendingAsk`（ask 中断）、`batch`/`batchIndex`/`nextBatch`、`status`、`errorDetail`。
- `execute()`（第 222-236 行）：首次 `initState`；若 `pendingAsk` 存在先 `resumePendingAsk`；再 `runLoop`。
- `runLoop`（第 279-303 行）：逐批 `processCommandNode`，返回 `'ask' | 'failed'` 即 `return`（中断，状态保留在 runState）。

---

### ④ workflow/src/schema.ts（pausedChildIds 与 ExecutedStepDefaultSchema 的 pause 字段）

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`

**StepStatusSchema**（第 15 行）：

```ts
const StepStatusSchema = z.enum(['blocked', 'ready', 'interacting', 'running', 'completed', 'failed', 'paused'])
```

**DagRunStatusSchema**（第 18 行）：

```ts
const DagRunStatusSchema = z.enum(['pending', 'running', 'interacting', 'completed', 'failed', 'aborted', 'paused'])
```

**StepSessionMetaSchema**（第 185-190 行）：

```ts
export const StepSessionMetaSchema = z.object({
  childId: z.string(),
  synthetic: z.boolean(),
  command: z.enum(['shell', 'prompt', 'agent', 'skill', 'mcp']),
  hostSessionId: z.string().optional(),
});
```

**ExecutedStepDefaultSchema 的 pause 字段**（第 310-336 行，重点第 326-328 行）：

```ts
export const ExecutedStepDefaultSchema = z.object({
  type: z.literal('default'),
  id: z.string(),
  stepId: z.string().optional(),
  stageId: z.string(),
  name: z.string(),
  status: StepStatusSchema,
  command: CommandConfigSchema.optional(),
  inputFrom: z.array(InputFromItemSchema).optional(),
  outputTo: z.array(OutputToItemSchema).optional(),
  passThroughVars: z.array(PassThroughVarSchema).optional(),
  sessionMeta: StepSessionMetaSchema.optional(),
  finalizeMeta: FinalizeMetaSchema.optional(),
  visitCount: z.number(),
  branchMeta: BranchMetaSchema.optional(),
  error: z.string().optional(),
  pausedAt: z.string().optional(),
  resumedAt: z.string().optional(),
  resumePrompt: z.string().optional(),
  sessionMessages: z.array(SessionMessageSchema).optional(),
  pauseEntryId: z.string().optional(),
  loopIteration: z.array(z.number()).optional(),
  loopMeta: BranchMetaSchema.optional(),
  retryHistory: z.array(RetryRecordSchema).optional(),
  parentSessionId: z.string().optional(),
  output: z.array(ContentBlockSchema).optional(),
})
```

**WorkflowTaskStateSchema.pausedChildIds**（第 363-384 行，重点第 380 行）：

```ts
export const WorkflowTaskStateSchema = z.object({
  taskId: z.string(),
  jobId: z.string(),
  workflowId: z.string(),
  cwd: z.string(),
  status: DagRunStatusSchema,
  originalInput: z.string(),
  currentStageId: z.string(),
  executedSteps: z.array(ExecutedStepDefaultSchema),
  stageInfos: z.array(StageInfoSchema),
  pendingInteractions: z.array(z.union([PendingQuestionEntrySchema, PendingPermissionEntrySchema])),
  pendingQueue: z.array(z.string()),
  visitCounts: z.record(z.string(), z.number()),
  passThroughVars: z.record(z.string(), PassThroughVarValueSchema),
  activeLoopIterationStack: z.array(z.number()),
  activeLoopNodeId: z.string().nullable(),
  activeLoopStack: z.array(z.string()),
  pausedChildIds: z.array(z.string()),          // ← 第 380 行
  stageContracts: z.record(z.string(), StageContractSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})
```

**seam-01 改名佐证**（`schema.spec.ts` 第 155-166 行）：
- `renames the pause registry to pausedChildIds and drops pausedStepIds`：断言 `shape` 含 `pausedChildIds`、不含 `pausedStepIds`。
- `rejects a legacy state that only carries pausedStepIds`：仅带 `pausedStepIds` 的旧状态 `parse` 抛 `z.ZodError`。
- 即：字段原名 `pausedStepIds`，seam-01 更名为 `pausedChildIds`（迁移自 DSH 文档 `docs/engine/dsh-workflow.md` 中「原 v2.6 的 pausedStepIds[]」语义，升为「唯一权威」）。
- 引擎 `makeInitialState`（workflow-engine.ts 第 122 行）初始化 `pausedChildIds: []`。

---

### ⑤ workflow/src/types.ts（ExecutedStepDefault / StepStatus / DagRunStatus）

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`

**DagRunStatus**（第 111 行）：

```ts
export type DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'
```

**ExecutedStepDefault**（第 129-155 行）：字段与 schema 的 `ExecutedStepDefaultSchema` 一一对应（`type:'default'`、`id`、`stepId?`、`stageId`、`name`、`status`、`command?`、`inputFrom?`、`outputTo?`、`passThroughVars?`、`sessionMeta?`、`finalizeMeta?`、`visitCount`、`branchMeta?`、`error?`、`pausedAt?`、`resumedAt?`、`resumePrompt?`、`sessionMessages?`、`pauseEntryId?`、`loopIteration?`、`loopMeta?`、`retryHistory?`、`parentSessionId?`、`output?`）。

**StepStatus**（第 165 行）：

```ts
export type StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'
```

- `DagInstanceState`（第 114-126 行）投影了 `status`/`executedSteps`/`stageInfos` 等，但**不含** `pausedChildIds`（`toDagInstanceState` 在 workflow-engine.ts 第 130-146 行未投影该字段）。

---

### ⑥ DSH 参考源码：interrupt / followup 真实语义

目录：`D:\project-code\llm\deepseek-harness\packages\subagent\subagent\src`

**公开层 index.ts**（第 231-257 行）：
- `followup(parent, childId, content, options): Promise<MessageId>` → `requireContinuations().followup(...)`。
- `interrupt(targetSessionId, authority): void` → `this.continuations?.interrupt(targetSessionId, authority)`（注意公开层用 `?.`，无 manager 时静默 no-op）。

**核心实现 continuation.ts**：

- `SubagentInterruptAuthority`（第 139-141 行）与 sandore 接缝一致：

```ts
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }
```

- `SubagentFollowupOptions`（第 144-149 行）：`{ source: MessageSource; signal: AbortSignal }`（注释强调 `source` 仅作消息归属，不授予任何 authority）。

**interrupt 实现**（第 528-568 行），真实语义：

1. **authority 校验**：
   - `ancestor` 分支：先校验「精确 live ancestor」——`this.ctx.agents.get(caller.id) !== caller` 即抛 `SubagentError('interrupting "..." requires the exact live ancestor agent', 'UNAUTHORIZED')`（第 533-538 行）；`caller.id === targetSessionId` 抛 `UNAUTHORIZED`（agent 不能中断自己，第 539-544 行）。
   - 目标存在时再校验归属：`kind === 'user'` 要求 `activation.handle.agent.session.header.parentSession === authority.parentSessionId`（否则 `subagent "..." belongs to another parent session` `UNAUTHORIZED`）；`kind === 'ancestor'` 要求 `activation.ancestry.has(authority.agent)`（否则 `not a live descendant` `UNAUTHORIZED`）。
2. **absent target no-op**：`const activation = this.activations.get(targetSessionId); if (activation === undefined) return;`（第 546-547 行）——目标不在 live Activation 表中即为「接受的 no-op」，统一覆盖自然完成竞态、重复请求、one-shot id、未知 id。**但** ancestor caller 的「stale/self」校验在 target 查找**之前**执行，即使 target absent 也拒绝 stale caller。
3. **disposal 中的 target**：`if (activation.disposal !== undefined) return;`（第 563 行）——已在拆除的 Activation 在授权后也是 accepted no-op。
4. **fire-and-return**：`activation.handle.agent.cancel(authority.kind === 'user' ? { kind: 'user' } : { kind: 'parent' }, { keepInbox: true })`（第 564-567 行）——同步发 `cancel`（`keepInbox: true` 保留未领取的 inbox 工作），**不等待**目标观察信号或达到静止；已领取（claimed）的工作不重新入队；被中断 driver idle 后，一个 waking send 会恢复被停的 FIFO 队列。

**followup 实现**（第 476-505 行），真实语义：

1. `assertAdmitting(parent)` → 循环内经 `ChildLock.run(childId, ...)` 串行化每个 child 的操作。
2. **冷恢复**：`activation === undefined` 时走 `coldResume(parent, childId, content, options)`（第 486 行）——即 absent target 会从持久化 Session 冷恢复一个**新 Activation**（`coldResume` 第 883-932 行：`persistence.inspect(childId)` → `authorizeLineage` 校验持久化 header 的 parentSession → `foldSubagentDescriptor` 校验 `mode==='continuable'` → `materialize` 经 `ctx.agents.resume` → `submitMaterialized`）。
3. resident 时 `submitAdmitted(activation, content, options.source, parent, options.signal)`；若 disposal 事务已开（`activation.disposal !== undefined`），等待 release 后重试冷恢复。
4. 与 `interrupt` 的关键差异：**followup 对 absent target 是「冷恢复并投递」，interrupt 对 absent target 是「no-op」**。

**Agent 真实类型**（`D:\project-code\llm\deepseek-harness\packages\core\agent\src\runtime-types.ts` 第 50-144 行）：
- `AgentStatus = 'idle' | 'running'`（第 50 行）；`Agent.status`（第 74 行）与 `agent/status` 事件镜像。
- `Agent.inbox: Inbox`（第 72 行）；`Inbox.hasPending` 为 getter（`inbox.ts` 第 53-55 行，`nextTurn.length > 0 || nextStep.length > 0`）。
- `Agent.whenIdle(): Promise<void>`（第 93 行）：「当前整代理活动达到静止后 resolve」，跟随被替换的 work，但不标识某条特定消息的 settlement。
- `Agent.cancel(cause, options?)`（第 85 行）：`keepInbox` 保留 pending work；无活动时 no-op 且不 arm 后续 work。
- `Agent.followup(message)` / `steer(message)` / `inject(message)`（第 124/133/143 行）。

---

### ⑦ workflow/tests/mocks（FakeSubagents 与 FakeAgent）

**subagents.ts**：`D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\subagents.ts`

- `FakeChildStatus = 'running' | 'interrupted'`（第 35 行）。
- `FakeSubagents implements SubagentRuntime`（第 38-99 行），记录数组：`continuableStarts`、`followups`、`interrupts`（`{ targetSessionId, authority }`）、`startCalls`、`listChildrenCalls`。
- **seam-01 已扩展的 `childParent`/`childStates`**（第 44-45 行）：
  - `private readonly childParent = new Map<SessionId, SessionId>();`
  - `private readonly childStates = new Map<SessionId, FakeChildStatus>();`
- 状态机语义：
  - `startContinuable(spec)`（第 47-54 行）：push spec；`childId = child-{index}`；`childParent.set(childId, spec.request.parent.id)`；`childStates.set(childId, 'running')`；返回 `{ childId, messageId }`。
  - `followup(parent, childId, content, options)`（第 56-60 行）：push `{ parent, childId, content, options }`；`childStates.set(childId, 'running')`（followup 后回到 running）。
  - `interrupt(targetSessionId, authority)`（第 62-65 行）：push `{ targetSessionId, authority }`；`childStates.set(targetSessionId, 'interrupted')`。
  - `listChildren(parentSessionId, signal?)`（第 67-82 行）：push call；遍历 `childStates`，仅返回 `childParent.get(id) === parentSessionId` 的条目，`activity = state === 'running' ? 'running' : 'inactive'`。
  - `childStatus(childId)`（第 85-87 行）：读回当前状态（`startContinuable` 后 running，`interrupt` 后 interrupted）。
- 注意：FakeSubagents 的 `interrupt` 是**纯状态记录 + 标记**，不做 authority 校验、不做 absent no-op 判定、不触达真实 `Agent.cancel`（与 DSH 真实语义不同，仅作为测试替身）。

**agents.ts**：`D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\agents.ts`

- `FakeSession implements Session`（第 28-34 行）：`events: SessionEvent[]` + `append(event)`。
- `FakeAgent implements Agent`（第 65-84 行）：
  - `readonly id`、`options`、`session: FakeSession`、`inbox: { hasPending: false }`、`ctx: undefined`、`status: AgentStatus = 'idle'`（可变字段）。
  - `whenIdle()`（第 81-83 行）默认立即 resolve；测试中可覆盖（如 workflow-engine.spec.ts 第 1073 行覆写以在第 2 次 idle 时追加最终输出）。
- `FakeAgentRegistry implements AgentRegistry`（第 95-154 行）：`get`/`create`/`resume`/`register`；`create` 记录 `meta.cwd`、执行 setup（`setupError` 时抛错回滚）、`sessions.create(sessionId)` 把宿主 Session 发布进 session store。
- 事件构造助手：`assistantMessageEvent(content, seq, time)`、`assistantChunkEvent(text, seq, time)`（第 37-62 行）。

---

### ⑧ workflow-engine.spec.ts 对 abortInstance 的既有断言

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.spec.ts`

**`describe('SandoreEngineRuntime abort')`**（第 678-728 行）两个用例：

1. `aborts a hanging shell step to the aborted terminal state`（第 679-712 行）：
   - `shell.runHandler` 挂起：返回 Promise，注册 `spec.signal.addEventListener('abort', finish, { once: true })`（signal 已 aborted 时直接 finish）；finish 时 resolve `{ exitCode:null, signal:'SIGTERM', aborted:true, ... }`。
   - 流程：`startInstance` → `await stepStarted`（等 `sandore/step-start`）→ `await engine.abortInstance(run.instanceId)` → `await aborted`（等 `sandore/aborted`）。
   - 断言：`records.some(r => r.name === 'sandore/aborted')` 为 true；`persistence.state.get(run.instanceId)?.status === 'aborted'`。
   - 结论：**既有测试只覆盖「abort 一个挂起的 shell Step → aborted 终态 + sandore/aborted 事件」**，不涉及 `subagents.interrupt`、不涉及 `pausedChildIds`、不涉及 pause/resume。

2. `rejects abortInstance for a completed instance`（第 714-727 行）：
   - 正常跑完（等 `sandore/end`）后 `expect(engine.abortInstance(...)).rejects.toMatchObject({ code: 'INVALID_OPERATION' })`。

其他相关既有断言（上下文参考）：
- `describe('SandoreEngineRuntime interface')` 第 394-403 行：断言 `recoverInstance`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep` 六个未实现方法抛 `INVALID_OPERATION` + `/not implemented/`。
- 事件序断言（第 499-510 行）与宿主 Session 双发同序断言（第 514-525 行）确认 `sandore/start → stage-start → step-start → step-completed → stage-completed → … → end` 序列，其中 **无 `sandore/paused`/`sandore/resumed` 之类事件**。
- `waitForAborted`（第 367-371 行）以 `sandore/aborted` 为信号；`waitForStepStart`（第 374-378 行）以 `sandore/step-start` 为信号。

---

## Supplementary Exploration Result

`furina config show experimental.websearch experimental.context7` 返回 `experimental.websearch=true`、`experimental.context7=true`。但本次 Phase 3 探索结果已充分覆盖 `exploreContent` 全部 8 项（本地源码与 DSH 参考源码均已定位并精读，信息完整、无缺口），因此未触发 websearch/context7 补充探索。
