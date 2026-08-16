# Task 4 recovery-01 参考实现与落点探索

> 探索类型：specification（只研究现状，不含方案/建议/实现步骤）

## 需求理解（What / Boundaries / Goal）

- **What**：梳理「重试/恢复」能力（`retryStep` 的 `continue|revert|fork` 三种模式与 `recoverInstance` 崩溃恢复）在 sandore 工作流引擎中的现状与落点：当前 stub 位置、可复用的断点续跑机制、接缝签名（agents.create/resume、subagents.followup、sessions.fork）、schema 中已预置的重试字段、DSH 参考源码的真实语义，以及测试中尚存的「未实现方法」断言。
- **Boundaries**：`packages/sandore/workflow`（workflow-engine.ts / seam.ts / schema.ts / lifecycle-manager.ts / persistence.ts / types.ts / workflow-engine.spec.ts）、`packages/sandore/microflow`（subagents.ts / step-runner.ts / stage-executor.ts / finalize-manager.ts）、`workflow/tests/mocks/*`，以及 DSH 参考源码 `packages/core/session/src`、`packages/core/agent/src`、`packages/subagent/subagent/src`。
- **Goal**：为 recovery-01 提供精确的「当前实现状态 + 可复用点 + 参考语义」事实基础。

---

## ① workflow-engine.ts：retryStep/recoverInstance stub、主循环、persistState、runnerConfig、续跑机制

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts`

### 1.1 两个 stub 的当前位置

- `recoverInstance(instanceId): Promise<DagRun>`（L311-313）：
  ```ts
  async recoverInstance(instanceId: string): Promise<DagRun> {
    throw new SandoreError('SandoreEngineRuntime.recoverInstance is not implemented', 'INVALID_OPERATION');
  }
  ```
- `retryStep(instanceId, stepId, mode: 'continue' | 'revert' | 'fork', message): Promise<void>`（L357-359）：
  ```ts
  async retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.retryStep is not implemented', 'INVALID_OPERATION');
  }
  ```

其余实例级方法（`startInstance`/`getState`/`abortInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`）均已实现。

### 1.2 实例内存登记表与活跃实例结构

- `private readonly instances = new Map<string, ActiveInstance>()`（L170）。
- `ActiveInstance`（L52-64）持有：`controller: AbortController`、`session: Session`（宿主会话）、`hostAgent: Agent`、`definition: WorkflowDefinition`、`interactions: InteractionManager`、`lifecycle: LifecycleManager`、`state: WorkflowTaskState`（可变）、`resumeRequested: boolean`、`resumeWaiters: Array<() => void>`。

### 1.3 `startInstance` 的初始化流水线（L177-256，恢复实例需对齐）

1. `persistence()` 未就绪抛 `INVALID_OPERATION`；`persistence.definitions.get(workflowId)` 未命中抛 `NODE_NOT_FOUND`。
2. `parseWorkflowYaml(record.yaml)` → `makeInstanceId()`（`YYYYMMDD-HHmmss-xxx`）→ `makeInitialState(...)`（status `pending`）。
3. `this.ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup: createHostAgentSetup({ instanceId, engine: this }) })` 创建宿主主代理（setup 抛错则 create 回滚）。
4. `this.ctx.sessions.get(SessionId(instanceId))` 读回 live 会话（未发布抛 `INVALID_OPERATION`）。
5. 构造 `InteractionManager`、`LifecycleManager`（`initialPausedChildIds: state.pausedChildIds`）。
6. `this.instances.set(instanceId, active)` → `void this.persistState(active)` → `void this.execute(instanceId)`（fire-and-forget）→ 返回 `{ instanceId, status: 'running' }`。

关键点：`recoverInstance` 需要重建上述 `ActiveInstance`（含重新 `agents.create`/读回宿主会话、按快照重建 `LifecycleManager` 的暂停登记表），并复用 `execute` 续跑。

### 1.4 `runInstance` 主循环（L388-574）

- 入口先落 `status: 'running'` + `persistState` + `emitStart`。
- `runnerConfig(definition, hostAgent, active)` 构造引擎级配置 → `new WorkflowDagNavigator(...)`（携带 `activeLoopStack`/`activeLoopIterationStack` 供循环续跑）→ `new FinalizeManager(this.ctx, runnerConfig)`。
- 逐 Stage 线性循环 `while (stageId !== '')`：
  - `markStageStatus(running)` → `persistState` → `emitStageStart`。
  - `new StageExecutor({...})`，其中 `onPersist` 逐 Step 把 `executed` upsert 进 `active.state.executedSteps` 并 `persistState`（按 `item.id` 定位；`findIndex` 存在则替换，否则追加）。
  - `let result = await executor.execute()`。
  - **交互/暂停等待循环（可复用核心）**：`while (result.status === 'interacting' || result.status === 'paused')`：
    - `interacting`：`markStageStatus(interacting)` + 实例 `status: 'interacting'` + `persistState` → `findAskStep(active.state.executedSteps)` 反查 ask 载荷（找不到则 `return`）→ 组装 `PendingQuestionEntry` → `active.interactions.ask(...)`。
    - `paused`：`await this.waitForResume(active)`。
    - `signal.aborted` 则 break；否则 `result = await executor.execute()`（从断点续跑）。
  - aborted 分支 / failed 分支 / completed 分支分别落终态并 `emitEnd`/`emitAborted`。

`execute`（L363-386）只做 `runInstance` 的异常兜底（意外错误落 `failed` + `emitEnd`）。**注意**：`runInstance` 是从 `stageId = navigator.currentNodeId` 重新计算开始的全量执行；`StageExecutor` 内部才持有 ask/paused 断点（见 ④）。

### 1.5 `persistState`（L679-689）

```ts
private async persistState(active: ActiveInstance): Promise<void> {
  const persistence = this.persistence();
  if (persistence === undefined) return;
  try { await persistence.saveWorkflowState(active.state); }
  catch (error) { this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`); }
}
```

- `persistence()` = `this.ctx.get('sandorePersistence')`（L626-628）。
- `SandorePersistence.saveWorkflowState(state)` = `state.put(state.taskId, state)` 全量覆盖（`persistence.ts` L65-67），`state` 表 key = `taskId`（= instanceId）。

### 1.6 `runnerConfig`（L585-624）

`StepRunnerConfig`（`step-runner.ts`）由引擎注入，含：
- `defaultTimeoutMs`（回退 `this.config.defaultTimeoutMs ?? 7200000`）、可选 `defaultProvider`/`defaultModel`；
- `skills/mcps/agents`（工作流级名称数组）、`hostAgent`；
- `onChildStarted(stepId, childId)`：把 running Step 的合成 `sessionMeta` 切换为真实子代理 SessionId（`synthetic: false`）并 `persistState`；
- `isPausedChild(childId)` = `active.lifecycle.hasPaused(childId)`；
- `onDelegatedAsk(...)` = `active.interactions.delegateSubagentAsk(...)`（返回 `result.delegated`）。

### 1.7 续跑/等待机制（lifecycle-01 已实现，可复用）

- `waitForResume(active)`（L648-665）：`resumeRequested` 标志优先消费；否则注册 waiter 并监听 `controller.signal` 的 `abort`（与 `signal.aborted` 竞争），避免 paused 期中止导致主循环永久悬挂。
- `notifyResume(active)`（L668-677）：`resumeStep`/`resumeAllSteps` 成功后唤醒 waiter；无 waiter 时置 `resumeRequested = true`。
- `resumeStep`/`resumeAllSteps`（L338-355）委托 `LifecycleManager`，之后调用 `notifyResume(active)`。
- `abortInstance`（L277-309）：`controller.abort()` → 对 `active.lifecycle.pausedIds` 逐个 `subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })` → 落 `aborted` + `persistState` + `emitAborted` → `this.instances.delete(instanceId)`（保留持久化快照，`getState` 退回 state 表）。
- `getState`（L259-270）：内存 `instances` 优先；未命中回退 `persistence()?.state.get(instanceId)`；仍无抛 `NODE_NOT_FOUND`。

---

## ② microflow/src/subagents.ts：AgentRegistry.create/resume、SubagentRuntime、Agent.session.events

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\subagents.ts`

### 2.1 `AgentRegistry`（L103-107）

```ts
export interface AgentRegistry {
  get(id: SessionId): Agent | undefined;
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
}
```

### 2.2 `CreateAgentOptions`（L78-92，含 seed/setup）

```ts
export interface CreateAgentOptions {
  readonly sessionId: SessionId;
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly seedLength?: number;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
  readonly seed?: readonly SessionEvent[];
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
  readonly setup?: AgentSetup;
}
```

### 2.3 `ResumeAgentOptions`（L95-100）

```ts
export interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId;
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
  readonly setup?: AgentSetup;
}
```

（注意：`resume` 无 `seed`/`meta` —— 持久会话事件由持久化加载；`create` 才带 `seed`/`meta`。）

### 2.4 `Agent`（L37-46）与 `AgentHandle`（L49-52）

- `Agent.id`、`Agent.options`、`Agent.session`、`Agent.inbox: { hasPending }`、`Agent.status: 'idle' | 'running'`、`Agent.ctx`、`Agent.whenIdle(): Promise<void>`。
- `AgentHandle` = `{ agent: Agent; dispose(): Promise<void> }`。

### 2.5 `Session` / `SessionEvent`（L32-34、L216-218）

- `Session` = `{ readonly events: readonly SessionEvent[] }`（不可变追加日志快照）。
- `SessionEvent` 只精确建模两类：
  ```ts
  export type SessionEvent =
    | { readonly type: 'assistant/message'; readonly seq: number; readonly time: number; readonly data: AssistantMessageData }
    | { readonly type: 'assistant/chunk';  readonly seq: number; readonly time: number; readonly data: AssistantChunkData }
  ```
- `finalAssistantOutput(events)`（L230-245）：取最后一条非空 `assistant/message` 的 `content`；否则累积 `assistant/chunk` text-delta；都无则 `undefined`。
- `AssistantMessageData`（L196-201）= `{ turn, step, message, usage? }`；`AssistantChunkData`（L204-208）= `{ turn, step, chunk }`。

### 2.6 `SubagentRuntime`（L187-193）

```ts
export interface SubagentRuntime {
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
  followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>;
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}
```

- `SubagentFollowupOptions` = `{ source: MessageSource; signal: AbortSignal }`（L140-143）。
- `SubagentInterruptAuthority`（L146-148）= `{ kind: 'user'; parentSessionId } | { kind: 'ancestor'; agent: Agent }`。
- `SubagentListEntry`（L181-184）：`child`（`mode: 'one-shot'|'continuable'`、`activity: 'running'|'inactive'`、`hasChildren`、`label?`）或 `diagnostic`（`reason: 'corrupt'|'unsupported'|'unavailable'`）。

---

## ③ microflow/src/step-runner.ts：runSubagent/collectSubagentOutput/resumeSubagent + StepRunnerConfig

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.ts`

### 3.1 `StepRunnerConfig`（L60-90）

```ts
export interface StepRunnerConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly skills?: readonly string[];
  readonly mcps?: readonly string[];
  readonly agents?: readonly string[];
  readonly hostAgent?: Agent;
  readonly onChildStarted?: (stepId: string, childId: string) => void;
  readonly onDelegatedAsk?: (input: DelegatedAskContext) => Promise<boolean> | boolean;
  readonly isPausedChild?: (childId: string) => boolean;
}
```

### 3.2 `runSubagent`（L489-515，私有）

- agent 类型有 `agentParamsTemplate` 时先 `fillParams` 临时会话填充参数；
- `resolveProviderModel` → `buildTaskText` → `buildPromptText` → `ctx.subagents.startContinuable({ provider, label: 'step {id}', request: { prompt, parent, agentOptions }, signal })`；
- `this.config.onChildStarted?.(request.step.id, started.childId)` 上抛真实 childId；
- 返回 `this.collectSubagentOutput(command.type, started.childId, request.step.id, request.stageId)`。

### 3.3 `collectSubagentOutput`（L534-576，私有，首跑与续跑共用）

1. `this.ctx.agents.get(childId)` 未命中抛 `STEP_EXECUTION`；
2. `await child.whenIdle()`；
3. `finalAssistantOutput(child.session.events)`，undefined 抛 `STEP_EXECUTION`；
4. 若 `config.onDelegatedAsk` 存在且 output 含 `[[SANDORE_ASK]]` 标记：循环（最多 `MAX_DELEGATED_ASK_ROUNDS=3`）回调 `onDelegatedAsk` → 若 `delegated` 为 true 则 `await child.whenIdle()` 重新取 output，`sameOutput` 无进展即 break；
5. 返回 `{ output, sessionMeta: { childId, synthetic: false, command: commandType } }`。

### 3.4 `resumeSubagent`（L524-531，公开）

```ts
async resumeSubagent(commandType: 'agent' | 'skill' | 'mcp', childId: string, stepId: string, stageId: string): Promise<StepRunResult> {
  return this.collectSubagentOutput(commandType, childId, stepId, stageId);
}
```

（lifecycle-01 已抽取；暂停续跑在 `followup` 后重新 `whenIdle` + `finalAssistantOutput`。）

---

## ④ microflow/src/stage-executor.ts：pendingPaused/pendingAsk 断点续跑状态机

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\stage-executor.ts`

### 4.1 `StageRunState`（L189-213）

```ts
interface StageRunState {
  readonly stepIndex: Map<string, WorkflowStep>;
  readonly executedSteps: ExecutedStepDefault[];
  readonly previousOutputs: PreviousStepOutput[];
  readonly passThroughVars: Record<string, PassThroughVarValue>;
  batch: string[];
  batchIndex: number;
  nextBatch: string[];
  status: StepStatus;
  errorDetail: string | undefined;
  pendingAsk: { nodeId; step; executed; assessResult: FinalizeAssessResult } | undefined;
  pendingPaused: { nodeId; step; executed; childId } | undefined;
}
```

### 4.2 `execute()` 断点续跑入口（L246-267）

- 首次调用 `initState()` 初始化 `runState`；
- `pendingPaused !== undefined` → `resumePendingPaused(state)`（返回非 `ok` 则 `buildResult` 返回）；
- `pendingAsk !== undefined` → `resumePendingAsk(state)`（返回 `failed` 则 `buildResult`）；
- 最后 `runLoop(state)` → `buildResult(state)`。

即：**引擎在 `while(interacting||paused)` 循环中反复调用同一个 `StageExecutor.execute()`，StageExecutor 靠 `runState.pendingAsk/pendingPaused` 保存断点，重跑门禁 + 推进剩余 Step**。StageExecutor 实例是每个 Stage 每次循环新建的（`runInstance` 里 `new StageExecutor(...)`），但同一个 Stage 的 ask/paused 续跑发生在同一次 `executor` 生命周期内（主循环持有同一 `executor` 变量直到该 Stage 结束）。

### 4.3 pendingPaused 设置（`processCommandNode` catch，L437-442）

- `isCancellationError(error) && isPausedStep(step.id)` 命中暂停登记表时：`executed.status = 'paused'`、`state.status = 'paused'`、`state.pendingPaused = { nodeId, step, executed, childId: realChildIds.get(step.id) ?? childId }`，返回 `'paused'`。

### 4.4 `resumePendingPaused`（L530-547）

- 取 `pending.pendingPaused` 并清空；命令非 agent/skill/mcp 抛 `failed`（理论不可达）；
- `this.runner.resumeSubagent(command.type, childId, step.id, stageDef.id)` 重新收集输出；
- `finishCommandNode(nodeId, step, childId, executed, result, state, true)`（`resumed=true` 不再重复 push executedSteps）。

### 4.5 pendingAsk 设置（`finishCommandNode`，L498-504）

- `finalizeOutcome.type === 'ask'` 时：`state.pendingAsk = { nodeId, step, executed, assessResult }`、`state.status = 'interacting'`、返回 `'ask'`。

### 4.6 `resumePendingAsk`（L559-600）

- 取 `pendingAsk` 并清空 → `finalizeManager.finalizeStepAfterAsk(..., assessResult)`；
- `error` → failed；否则 `state.status = 'completed'` → `resolveNextNodes` 推进下一批 → `nextBatch.push(...)`。

---

## ⑤ workflow/src/schema.ts：RetryRecordSchema/retryHistory/parentSessionId/sessionMeta

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`

### 5.1 `RetryRecordSchema`（L301-307）

```ts
export const RetryRecordSchema = z.object({
  mode: z.enum(['continue', 'revert', 'fork']),
  timestamp: z.string(),
  userMessage: z.string(),
  revertMessageId: z.string().optional(),
  result: z.enum(['running', 'completed', 'failed']),
})
```

### 5.2 `ExecutedStepDefaultSchema`（L310-336）中的重试相关字段

- `retryHistory: z.array(RetryRecordSchema).optional()`（L333）
- `parentSessionId: z.string().optional()`（L334）
- 其他与暂停/恢复相关的字段：`sessionMeta`（`StepSessionMetaSchema`，见下）、`pausedAt`/`resumedAt`/`resumePrompt`（L326-328）、`sessionMessages`（L329）、`pauseEntryId`（L330）、`loopIteration`/`loopMeta`（L331-332）、`finalizeMeta`（L322）、`output`（L335）。

### 5.3 `StepSessionMetaSchema`（L185-190）

```ts
export const StepSessionMetaSchema = z.object({
  childId: z.string(),
  synthetic: z.boolean(),
  command: z.enum(['shell', 'prompt', 'agent', 'skill', 'mcp']),
  hostSessionId: z.string().optional(),
})
```

### 5.4 `FinalizeAssessResultSchema`（L246-253）

含 `forkSessionId: z.string()`（收尾评估 fork 会话 id，评估类重放身份戳记）、`assessmentRaw: z.string()`、`completionType`、`passThroughVars`、`askQuestion?`、`errorDetail?`。

### 5.5 `SessionMessageSchema`（L292-298）

```ts
export const SessionMessageSchema = z.object({
  type: z.enum(['text', 'tool', 'reasoning']),
  text: z.string().optional(),
  tool: z.string().optional(),
  args: z.unknown().optional(),
  output: z.unknown().optional(),
})
```

### 5.6 运行时快照 `WorkflowTaskStateSchema`（L363-384）

含 `status: DagRunStatusSchema`、`executedSteps`、`stageInfos`、`pendingInteractions`、`pendingQueue`、`visitCounts`、`passThroughVars`、`activeLoopIterationStack`、`activeLoopNodeId`、`activeLoopStack`、`pausedChildIds`、`stageContracts`、`createdAt`/`updatedAt`。

存储层（L408-416）：`sandoreDomainSpec` 三表 `definitions`/`jobs`/`state`，`state: domainTable<string, WorkflowTaskState>`。

---

## ⑥ DSH 参考源码真实语义

根目录：`D:\project-code\llm\deepseek-harness`

### 6.1 `sessions.fork(source, boundary?, childSessionId?)` — `packages/core/session/src/index.ts`

公开签名与文档（L1067-1095）：

```ts
fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session
```

- `source`：`Session | SessionId`（`SessionForkSource`，L761）；`_resolveForkSource`（L1140-1153）：
  - 字符串 id：`this.get(id)` 未命中抛 `SESSION_NOT_FOUND`；
  - Session 对象：`this.get(source.id)` 未命中抛 `SESSION_NOT_FOUND`；`live !== source` 抛 `SESSION_NOT_LIVE`。
- `childSessionId` 已存在 → `SESSION_ALREADY_EXISTS`（L1082-1084）。
- `boundary` 语义（`_forkSeed`，L1097-1138）：
  - `boundary` 为**含端点**的源 `seq`（inclusive）；省略 = 源最后一条事件；空源省略时返回空 child（`[]`）。
  - 非安全整数或 `< 0` → `INVALID_BOUNDARY`；`boundary >= events.length` → `INVALID_BOUNDARY`；`events[boundary].seq !== boundary`（非连续 seq）→ `INVALID_BOUNDARY`。
  - **OPEN_TURN 规则**：`events.slice(0, boundary + 1).findLast(e => e.type === 'turn/start' || e.type === 'turn/end')` 若为 `turn/start` → 抛 `OPEN_TURN`（「所选前缀不得落未闭合 turn」）。
  - 通过后返回 `events.slice(0, boundary + 1)`。
- `SessionForkErrorCode`（L771-776）= `SESSION_NOT_FOUND | SESSION_NOT_LIVE | SESSION_ALREADY_EXISTS | INVALID_BOUNDARY | OPEN_TURN`（`SessionForkError` 携带 `code`）。
- `fork` 最终 `this.create(childSessionId, { seed, meta: { ...(cwd), parentSession: source.id, seedLength: boundary+1 ... } })`（L1087-1094）。

`create(id?, options?: CreateSessionOptions)`（L830-841）→ `prepare(id, options)`（L863-889）：`seed` 经 `Session.create` 校验（`seq` 从 0 连续、JSON 可序列化）；`meta` 字段 `cwd/parentSession/seedLength/origin/delegationDepth/agentPreset` 落到 `SessionHeader`（`seedLength` 是 fork-lineage 的持久边界）。

### 6.2 `agents.resume` / `agents.create({seed})` — `packages/core/agent/src/index.ts`

- `CreateAgentOptions`（L80-133）：`sessionId`、`meta?`（`cwd/parentSession/seedLength/origin('subagent')/delegationDepth/agentPreset`）、`seed?: readonly SessionEvent[]`（「Initial replay/fork history… contiguous from seq 0, lossless-JSON, no open turn/step or dangling tool call」）、`agentOptions?`、`signal?`、`setup?`（`AgentSetup`，可返回 `AgentSetupCommit`；setup 抛错/commit 抛错/owner 卸载 → 回滚且不发布任何 id）。
- `ResumeAgentOptions`（L139-156）：`resumeSessionId`、`agentOptions?`、`signal?`、`setup?`（**无 seed/meta** —— 持久化先加载）。
- `AgentRegistry.create(options)`（L405-415）/ `resume(options)`（L424-430）：`requireFactory()` 后 `Reflect.apply(target.createAgent / target.resume, receiver, [ownerCtx, options])`；无 factory 抛 `no agent factory registered`。
- 工厂契约 `AgentFactory.createAgent/resume`（L183-214）：`resume` 必须先 `ctx.sessionPersistence.prepare`；两者都「setup 未发布完成 → 插入 session+agent → 按序发 `session/created`/`agent/created` → 发 `agent/session-start` → 起 loop」。
- `AgentHandle` = `{ agent: Agent; dispose(): Promise<void> }`（L172-175）；`dispose()` 停 loop → await 退出 → unregister → 从 store 移除 session → 展开 scoped world。
- `enter(agent, owner)`（L474-509）：`agent.id !== agent.session.id` 抛错；`this.store.has(id)` 抛 `already registered`（权威冲突边界）。

### 6.3 `followup` 冷恢复 — `packages/subagent/subagent/src/continuation.ts`

- `followup(parent, childId, content, options)`（L476-505）：`assertAdmitting(parent)`；`locks.run(childId, ...)` 内：
  - `activations.get(childId) === undefined` → `this.coldResume(parent, childId, content, options)`（**冷恢复**）；
  - 已有 Activation 但 `disposal !== undefined` → 等 `disposal` 结束后重试（冷恢复兜底）；
  - 否则 `submitAdmitted(...)`。
  - `live === undefined`（丢了终局竞态）→ 重试循环。
- `coldResume(parent, childId, content, options)`（L883-932）：
  1. `requirePersistence()` → `persistence.inspect(childId, signal)`（失败且非 abort → `NOT_RESUMABLE`）；
  2. `authorizeLineage(parent, childId, loaded.meta.parentSession)`（只有持久子会话的精确 live 直接父代理可续跑）；
  3. `foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))`（只折叠 child 自身 suffix，父代理 fork 前缀可能含祖先 descriptor）；`descriptor === undefined || mode !== 'continuable'` → `NOT_RESUMABLE`；
  4. `materialize({ childId, provider, parent, agentOptions, composition, signal })`；
  5. `submitMaterialized(...)`。
- `materializeTracked`（L986-1031）：`create === undefined ? agents.resume({ resumeSessionId: childId, agentOptions, signal, setup }) : agents.create({ sessionId: childId, meta, seed, agentOptions, signal, setup })`（冷恢复走 `resume`，全新创建走 `create`）。
- `interrupt(targetSessionId, authority)`（L528-…）：`ancestor` authority 需精确 live ancestor；自中断拒绝；absent 目标是已接受 no-op。
- `listChildren(parentSessionId, signal?)`（`index.ts` L339 转发 → `list-children.ts`）：持久化未配置时 live-only（冷 child 不可 resume，故其缺席 = 能力缺席）。

---

## ⑦ workflow/tests/mocks：sessions.fork、agents.resume/create seed、storage-domain state entries

### 7.1 `tests/mocks/sessions.ts`（seam-01 已加 fork）

- `FakeSession.events: Array<{ type; data }>`；`append(type, data)` 返回 `{ type, seq, time, data }`。
- `FakeSessionStore.fork(source: string, boundary?: number, childSessionId?: string): FakeSession`（L40-50）：
  ```ts
  const end = boundary === undefined ? sourceSession.events.length - 1 : boundary;
  forked.events.push(...sourceSession.events.slice(0, end + 1));  // 含端点
  const key = childSessionId ?? `session-${++this.counter}`;
  ```
  （**注意**：mock 无 OPEN_TURN/INVALID_BOUNDARY 校验，只做 `slice(0, end+1)` 复制 + 登记；空源 `end = -1` → `slice(0,0)` 空 child。）

### 7.2 `tests/mocks/agents.ts`

- `FakeAgentRegistry.create(options)`（L110-126）：`createCwds.push(options.meta?.cwd)` → `runSetup(options.setup)` → `new FakeAgent(options.sessionId, options.agentOptions)` → 登记 → 若注入 sessions 则 `sessions.create(options.sessionId)` 发布宿主 Session。**未实现 seed 回放**（`options.seed` 未写入 `FakeSession.events`）。
- `FakeAgentRegistry.resume(options)`（L128-139）：`runSetup(options.setup)` → 已有则复用，否则 `new FakeAgent(options.resumeSessionId, options.agentOptions)` → 登记。
- `runSetup(setup?)`（L145-153）：`setupError` 抛错；否则 `setup(makeSetupContext())` → `commit?.commit()`；`setupCount` 计数。
- 事件构造助手：`assistantMessageEvent(content, seq, time)`、`assistantChunkEvent(text, seq, time)`（供 `finalAssistantOutput` 测试）。

### 7.3 `tests/mocks/storage-domain.ts` — state 表 entries 扫描

- `MemoryKvTable<K,V>`（L13-49）实现 `KvTable`：`get`/`entries(): IterableIterator<[K,V]>`（L20-22）/`keys()`/`size`/`put`/`delete`/`update`（缺 key 抛 `DomainError('missing-key')`）。
- `MemoryDomain`（L52-80）按 spec 表名建空表；`table(name)` 返回对应 `KvTable`。
- `MemoryStorageDomain.open(spec)`（L86-96）：重复打开抛 `already-open`。
- 落点：`recoverInstance` 要枚举持久化实例时，可用 `persistence.state.entries()` 扫描全部 `WorkflowTaskState`（当前 `workflow-engine.ts` 的 `getState` 只用 `state.get(instanceId)` 单点读，尚无 entries 扫描路径）。

### 7.4 补充：`tests/mocks/subagents.ts`（与 retry/fork 的 followup 落点相关）

- `FakeSubagents`：`startContinuable` 记录并返回 `child-{n}`；`followup` 记录并置 `childStates.set(childId, 'running')`；`interrupt` 记录并置 `interrupted` + 触发 `whenIdleCancels`；`listChildren(parentSessionId, signal?)` 记录调用并按 `childParent` 过滤返回 `continuable` 子条目。
- **mock 无冷恢复**：`followup` 不查持久化、不调用 `agents.resume`，只做状态登记。

---

## ⑧ workflow-engine.spec.ts 现存「未实现方法」断言

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.spec.ts`

- L394-400：
  ```ts
  it('throws INVALID_OPERATION with not implemented for the 2 remaining unimplemented methods', async () => {
    const { engine } = await harness();
    await expect(engine.recoverInstance('x')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.recoverInstance('x')).rejects.toThrow(/not implemented/);
    await expect(engine.retryStep('x', 's', 'continue', 'm')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.retryStep('x', 's', 'continue', 'm')).rejects.toThrow(/not implemented/);
  });
  ```
- 结论：lifecycle-01 之后**剩余 2 个未实现方法**：`recoverInstance` 与 `retryStep`（`continue|revert|fork` 三模式均未实现）。这两个断言是 recovery-01 实现后需替换/删除的目标断言。

---

## 附：seam 层接口与事件（retry 落点上下文）

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`

- `SandoreEngine` 抽象方法（L75-105）：`startInstance`、`recoverInstance`、`abortInstance`、`replyQuestion`、`replyPermission`、`pauseStep`、`resumeStep`、`pauseAllSteps`、`resumeAllSteps`、`retryStep`、`getState`。
- 已预声明但尚未发射的事件：`'sandore/step-retried'(info, stepId, mode)`（Cordis L43 + Session L61 `{ stepId, mode }`）。
- `SandoreEngineStub` 11 个方法全部 `throw not implemented`（仅类型桩，非运行时实现）。

## 附：finalize-manager.ts 已使用 `ctx.sessions.fork`（retry fork 模式参考）

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\finalize-manager.ts`

- `FinalizeAssessor.assess`（L443-474）：session 类型 Step 且 `stepSessionId` 存在时 `this.ctx.sessions.fork(SessionId(input.stepSessionId))`（boundary 省略=取源最后一条事件）创建 fork 会话作为评估身份戳记；fork 抛错时降级为 `newSessionHandle()` 临时会话并记 `errorDetail`；返回的 `forkSessionId` 写入 `FinalizeAssessResult`。这是引擎内唯一已落地的 `sessions.fork` 调用点，可作为 retry `fork` 模式的既有参考。
