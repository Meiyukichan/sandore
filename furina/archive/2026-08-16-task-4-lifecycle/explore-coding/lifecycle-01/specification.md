# lifecycle-01 探索材料

> 探索目标：Task 4 lifecycle-01 的参考实现与落点 —— 新建 `packages/sandore/workflow/src/lifecycle-manager.ts` 实现单步/全局暂停与恢复。
>
> 说明：本文件仅为「现状探索」记录，不产生任何实现方案或建议。所有结论均基于实际源码。

---

## 一、workflow-engine.ts（SandoreEngineRuntime 运行时）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`

### 1.1 ActiveInstance 结构（第 50-58 行）

```ts
interface ActiveInstance {
  readonly controller: AbortController;
  readonly session: Session;
  readonly hostAgent: Agent;
  readonly definition: WorkflowDefinition;
  readonly interactions: InteractionManager;
  state: WorkflowTaskState;   // 唯一可变字段
}
```

- 五个 readonly 字段：`controller`（AbortController，取消传播的唯一源头）、`session`（宿主 Session，用于事件双发）、`hostAgent`（宿主主代理，也是子代理的 parent）、`definition`（工作流定义）、`interactions`（交互管理器）。
- `state` 可变，为 `WorkflowTaskState` 完整快照。

### 1.2 instances Map（第 164 行）

```ts
private readonly instances = new Map<string, ActiveInstance>();
```

- 以 `instanceId` 为 key；`startInstance` 在创建完成时 `this.instances.set(instanceId, active)`（第 216 行）。
- 内存未命中时 `getState` 回退到持久化 state 表（第 222-234 行）。

### 1.3 persistState（第 519-529 行）

```ts
private async persistState(active: ActiveInstance): Promise<void> {
  const persistence = this.persistence();
  if (persistence === undefined) return;
  try {
    await persistence.saveWorkflowState(active.state);
  } catch (error) {
    this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`);
  }
}
```

- `persistence()` 读 `ctx.get('sandorePersistence')`（第 515-517 行）。
- 持久化失败仅 `logger.warn`，不抛错、不阻断执行。

### 1.4 emitContained / safeAppend 双发范式（第 531-592 行）

- `emitContained(name, args)`（第 533-544 行）：遍历 `this.ctx.events.dispatch('emit', [name, ...args])`，每个监听器独立 try/catch 包含，返回 Promise 时 `void Promise.resolve(...).catch(warn)`，同步抛错也 warn，不中断、不向上传播。
- `safeAppend(fn)`（第 546-552 行）：try/catch 包裹 `fn()`，失败 warn。
- 每个 `emitXxx(session, ...)` 方法都做「双发」：
  - Cordis 事件：`this.emitContained('sandore/xxx', [args])`
  - 宿主 Session 事件：`this.safeAppend(() => session.append('sandore/xxx', payload))`

现有事件发射方法：`emitStart` / `emitStageStart` / `emitStageCompleted` / `emitStepStart` / `emitStepCompleted` / `emitStepFailed` / `emitEnd` / `emitAborted` / `emitQuestion` / `emitPermission`（第 554-612 行）。**注意**：`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried` 在 `seam.ts` 中已声明（见第六节），但 workflow-engine.ts **尚未实现**对应的发射方法。

### 1.5 runnerConfig（第 490-513 行）

返回 `StepRunnerConfig`，字段：`defaultTimeoutMs`（缺省 7200000）、可选 `defaultProvider`/`defaultModel`、`skills`/`mcps`/`agents`（工作流级名称数组）、`hostAgent`、`onDelegatedAsk` 回调（子代理 `[[SANDORE_ASK]]` 标记块转接引擎级 ask）。

### 1.6 runInstance 主循环（第 315-479 行）

关键结构：

```ts
const signal = controller.signal;                       // 取消信号
active.state = { ...active.state, status: 'running' ... };
await this.persistState(active);
this.emitStart(session, info);

const runnerConfig = this.runnerConfig(definition, hostAgent, active);
const navigator = new WorkflowDagNavigator(definition, this.ctx, runnerConfig, {...});
const loopManager = navigator.loopManagerInstance;
const finalizeManager = new FinalizeManager(this.ctx, runnerConfig);
let stageId = navigator.currentNodeId;

while (stageId !== '') {
  // markStageStatus running + persist + emitStageStart
  const executor = new StageExecutor({ ..., signal, hooks, loopManager, finalizeManager, onPersist, ... });
  let result = await executor.execute();               // ← Step 完成等待点

  while (result.status === 'interacting') { ... await active.interactions.ask(...); result = await executor.execute(); }

  // 合并 passThroughVars
  if (result.status === 'failed') {
    this.markStageStatus(active, stageId, 'failed');
    if (signal.aborted) { ... status='aborted'; emitAborted; }   // ← abort 落点
    else { ... status='failed'; stageContracts; emitEnd; }
    return;
  }
  // stage completed + setStageContract + emitStageCompleted + tryAdvanceStage
}
// completed + emitEnd
```

**Step 完成等待点（whenIdle 与 interrupt 取消的交互点）**：

- 真正的 `whenIdle()` 等待发生在 `microflow/src/step-runner.ts`（见第三节），而非 workflow-engine.ts 本身；`runInstance` 通过 `await executor.execute()` 间接触发该等待。
- `signal`（= `controller.signal`）被透传进 `StageExecutor`（`signal` 字段）→ `buildContext` 注入 `resolveNextNodes`，并透传进 `StepRunner.run(request.signal)`。
- 取消/中断的结果形态：`signal.aborted` 为 true 时，`runInstance` 在 `result.status === 'failed'` 分支（第 432-453 行）判定为 `aborted`（emitAborted）；否则落 `failed`（emitEnd）。
- **现状关键点**：`StageExecutor.processCommandNode` 的 `runner.run` catch（stage-executor.ts 第 452-462 行）**无条件**把失败标为 `failed` 并回调 `onStepFailed`；当前**没有**「先查暂停登记表再判失败」的逻辑（该逻辑是 lifecycle 待补的能力，不是现状）。

### 1.7 abortInstance 当前实现（第 237-246 行）

```ts
async abortInstance(instanceId: string): Promise<void> {
  const active = this.instances.get(instanceId);
  if (active === undefined) throw new SandoreError(`instance '${instanceId}' not found`, 'NODE_NOT_FOUND');
  if (TERMINAL_STATUSES.has(active.state.status)) {
    throw new SandoreError(`instance '${instanceId}' is already in terminal state '${active.state.status}'`, 'INVALID_OPERATION');
  }
  active.controller.abort();
}
```

- 仅调用 `controller.abort()`；状态置 `aborted` 由主循环 `runInstance` 的 `signal.aborted` 分支完成（第 434-437 行）。
- `TERMINAL_STATUSES`（第 61 行）= `new Set(['completed', 'failed', 'aborted'])`。**注意 `paused` 不在其中**，即对 paused 实例调用 abortInstance 目前不会抛 INVALID_OPERATION，会直接 `controller.abort()`。

### 1.8 未实现方法（第 248-286 行）

`recoverInstance` / `pauseStep` / `resumeStep` / `pauseAllSteps` / `resumeAllSteps` / `retryStep` 全部抛 `SandoreError(..., 'INVALID_OPERATION')` 且消息为 `not implemented`。

---

## 二、microflow/src/subagents.ts（能力接缝）

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.ts`

### 2.1 Agent 接口（第 37-46 行）

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

- `AgentStatus = 'idle' | 'running'`（第 29 行）。**没有 `paused` 态**——这是「引擎需自建 pausedChildIds 登记表」的根本原因。
- `inbox` 仅暴露 `{ hasPending: boolean }`（只读，无入队/claim 能力）。

### 2.2 SubagentRuntime.interrupt / followup 签名（第 140-193 行）

```ts
export interface SubagentFollowupOptions {
  readonly source: MessageSource;
  readonly signal: AbortSignal;
}

export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent };

export interface SubagentRuntime {
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
  followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>;
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}
```

- `interrupt` 是同步返回 void（fire-and-return）。
- `followup` 返回 `Promise<MessageId>`（inbox 接受后的消息 id）。
- `MessageSource` 来自 `@deepseek-ai/dsh-llm`（`createUserMessage({ source, content })` 使用）。

---

## 三、microflow stage-executor.ts / step-runner.ts

### 3.1 executedSteps 的 sessionMeta.childId 结构

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`

- 命令节点构造 `executed` 时（第 352-369 行），初始 `sessionMeta = { childId, synthetic: true, command: command.type }`，其中 `childId` 由 `synthesizeChildId(stepId)`（`step-{stepId}-{execId 前 8 位}`，第 90-93 行）或循环中 `loopManager.getActualStepId(step.id)` 合成。
- `StepRunner.run` 返回后（第 399-407 行），对 agent/skill/mcp 用真实 childId 覆盖：

```ts
if (result.sessionMeta !== undefined) {
  executed.sessionMeta = {
    childId: result.sessionMeta.childId ?? childId,
    synthetic: result.sessionMeta.synthetic,
    command: result.sessionMeta.command,
  };
}
```

- `StepSessionMetaSchema`（schema.ts 第 185-190 行）= `{ childId: string, synthetic: boolean, command: 'shell'|'prompt'|'agent'|'skill'|'mcp', hostSessionId?: string }`。
- **落点含义**：暂停/恢复需要经 `executedSteps[].sessionMeta.childId` 反查子代理 SessionId；注意 shell/prompt 的 childId 是合成占位（synthetic:true），仅 agent/skill/mcp 为真实可续接子代理。

### 3.2 Step 状态枚举（StepStatus 含 paused）

- 运行时状态值（types.ts 第 165 行 / schema.ts 第 15 行）：

```ts
type StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused';
```

- `paused` 已在枚举与 Zod schema 中，但引擎当前未产出该状态值。

### 3.3 whenIdle 等待点（step-runner.ts）

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/step-runner.ts`

- `runSubagent`（第 478-538 行）：
  - `startContinuable` → `ctx.agents.get(started.childId)` → `await child.whenIdle()`（第 506 行）。
  - 子代理 ask 转接循环中再次 `await child.whenIdle()`（第 529 行）。
- `interrupt` 对子代理调用 `agent.cancel(..., { keepInbox: true })` 时，会取消当前 turn，使 `whenIdle()`/运行 Promise 以「取消类」结束；该结束如何映射到 Step 状态由 `processCommandNode` 的 catch（第 452-462 行）与 `runInstance` 的 `signal.aborted` 判定决定（现状均直接落 `failed`/`aborted`，无暂停登记表查询）。

---

## 四、workflow/src/schema.ts

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

### 4.1 WorkflowTaskStateSchema.pausedChildIds（第 380 行）

```ts
pausedChildIds: z.array(z.string()),
```

- 位于 `WorkflowTaskStateSchema` 内（第 363-384 行），是「暂停登记表」的持久化字段（值 = 子代理 SessionId）。
- **seam-01 已改名**：字段名为 `pausedChildIds`（不再有 `pausedStepIds`）。佐证测试见 `schema.spec.ts` 第 155-166 行：
  - `renames the pause registry to pausedChildIds and drops pausedStepIds`：断言 shape 含 `pausedChildIds`、不含 `pausedStepIds`。
  - `rejects a legacy state that only carries pausedStepIds`：仅带 `pausedStepIds` 的旧快照 parse 抛 `ZodError`。

### 4.2 ExecutedStepDefaultSchema 暂停字段（第 326-330 行）

```ts
pausedAt: z.string().optional(),
resumedAt: z.string().optional(),
resumePrompt: z.string().optional(),
sessionMessages: z.array(SessionMessageSchema).optional(),
pauseEntryId: z.string().optional(),
```

- `ExecutedStepDefaultSchema` 整体见第 310-336 行（含 `status: StepStatusSchema`、`sessionMeta`、`finalizeMeta`、`error`、`output` 等）。

---

## 五、workflow/src/types.ts

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`

### 5.1 ExecutedStepDefault（第 129-155 行）

关键字段（均为可选）：`pausedAt?: string`、`resumedAt?: string`、`resumePrompt?: string`、`pauseEntryId?: string`、`sessionMeta?: StepSessionMeta`、`status: StepStatus`、`output?: ContentBlock[]`、`parentSessionId?: string` 等。

### 5.2 StepStatus（第 165 行）

```ts
export type StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused';
```

### 5.3 DagRunStatus（第 111 行）

```ts
export type DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused';
```

- 实例状态已含 `paused`（Zod 枚举 schema.ts 第 18 行同）。

---

## 六、DSH 参考源码（interrupt/followup 真实语义）

目录：`D:/project-code/llm/deepseek-harness/packages/subagent/subagent/src`

权威实现集中在 `continuation.ts`（`SubagentContinuationManager`），服务边界见 `index.ts`（`SubagentRuntime`）。

### 6.1 SubagentInterruptAuthority（continuation.ts 第 134-141 行）

```ts
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent };
```

与 sandore seam 的类型定义一致（microflow/subagents.ts 第 146-148 行）。

### 6.2 interrupt 真实语义（continuation.ts 第 528-568 行）

顺序如下：

1. **ancestor authority 前置校验**（即使 target 不存在也先做）：
   - `this.ctx.agents.get(caller.id) !== caller` → 抛 `SubagentError` `UNAUTHORIZED`（"requires the exact live ancestor agent"）。
   - `caller.id === targetSessionId` → 抛 `UNAUTHORIZED`（"cannot interrupt itself"）。
2. `const activation = this.activations.get(targetSessionId); if (activation === undefined) return;` —— **absent target 是接受的 no-op**（统一覆盖自然完成竞态、重复请求、one-shot id、未知 id）。
3. authority 校验（对 live target）：
   - `user`：`activation.handle.agent.session.header.parentSession !== authority.parentSessionId` → 抛 `UNAUTHORIZED`（"belongs to another parent session"）。
   - `ancestor`（else 分支）：`!activation.ancestry.has(authority.agent)` → 抛 `UNAUTHORIZED`（"is not a live descendant of agent …"）。
4. `if (activation.disposal !== undefined) return;` —— 目标已进入销毁事务 = 接受的 no-op。
5. `activation.handle.agent.cancel(authority.kind === 'user' ? { kind: 'user' } : { kind: 'parent' }, { keepInbox: true });` —— fire-and-return；`keepInbox: true` 保留未认领的 inbox 工作（已认领到当前 turn 的工作不 requeue）。

服务边界 `index.ts` 第 255-257 行：

```ts
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
  this.continuations?.interrupt(targetSessionId, authority)
}
```

即无 continuation manager（manager-less composition）时同样静默 no-op。

### 6.3 followup 真实语义（continuation.ts 第 476-505 行）

```ts
async followup(parent, childId, content, options): Promise<MessageId> {
  this.assertAdmitting(parent)   // DRAINING 校验
  while (true) {
    const live = await this.locks.run(childId, async () => {
      const activation = this.activations.get(childId)
      if (activation === undefined) return this.coldResume(parent, childId, content, options)
      if (activation.disposal !== undefined) return activation.disposal.then(() => undefined, () => undefined)  // 等释放后重试
      return this.submitAdmitted(activation, content, options.source, parent, options.signal)
    })
    if (live !== undefined) return live
    this.assertAdmitting(parent)
    options.signal.throwIfAborted()
  }
}
```

- resident Activation → `submitAdmitted`（signal.throwIfAborted → assertAdmitting → disposal 检查 → `authorizeLineage` → `submit`）。
- **冷恢复（cold resume）**（第 883-932 行）：`persistence.inspect(childId, signal)` → `throwIfAborted` → `assertAdmitting(parent)` → `authorizeLineage(parent, childId, loaded.meta.parentSession)`（校验持久 header 的 parentSession 与调用 parent.id 一致，否则 `UNAUTHORIZED`）→ `foldSubagentDescriptor`（无合法 continuation state 抛 `NOT_RESUMABLE`）→ `materialize`（`ctx.agents.resume`）→ `submitMaterialized`。
- 服务边界 `index.ts` 第 231-238 行：`followup` 经 `requireContinuations()` 委托给 manager。

### 6.4 与 sandore seam 的关系

- sandore 的 `microflow/src/subagents.ts` 是按 DSH 公开 API 复刻的「最小结构类型」，运行时由宿主注入真实 `ctx.subagents`/`ctx.agents`。`interrupt` 的 `{ kind: 'ancestor', agent: hostAgent }` 与 `followup(parent=hostAgent, childId, content, { source, signal })` 正是 DSH 支持的调用形态。
- 权威授权语义要点（对 lifecycle-manager 有意义）：`interrupt` 使用 `ancestor` authority 要求传入「精确活 ancestor Agent」（sandore 即 hostAgent），且 target 必须在该 Agent 的 live lineage 中；`followup` 的 `source` 仅作持久化归属、不授予权限。

---

## 七、workflow/tests/mocks（FakeSubagents / FakeAgent）

### 7.1 FakeSubagents（`workflow/tests/mocks/subagents.ts`）

- 私有状态（seam-01 已扩展）：
  - `private readonly childParent = new Map<SessionId, SessionId>();` —— childId → parent SessionId。
  - `private readonly childStates = new Map<SessionId, FakeChildStatus>();` —— `FakeChildStatus = 'running' | 'interrupted'`。
- 行为：
  - `startContinuable(spec)`（第 47-54 行）：记录 spec，`childId = child-{index}`，写 `childParent`（`spec.request.parent.id`）与 `childStates`（running），返回 `{ childId, messageId: msg-{index} }`。
  - `followup(parent, childId, content, options)`（第 56-60 行）：记录调用，`childStates.set(childId, 'running')`，返回递增 `msg-{n}`。
  - `interrupt(targetSessionId, authority)`（第 62-65 行）：记录 `{ targetSessionId, authority }`，`childStates.set(targetSessionId, 'interrupted')`。
  - `listChildren(parentSessionId, signal?)`（第 67-82 行）：遍历 childStates，仅返回 `childParent.get(id) === parentSessionId` 的条目，activity 映射 running→'running' / interrupted→'inactive'。
  - `childStatus(childId)`（第 85-87 行）：查询当前状态机值。
- 状态机测试佐证：`microflow/src/subagents.spec.ts` 第 141-161 行验证 `startContinuable → interrupt → followup` 状态流转（running → interrupted → running）。

### 7.2 FakeAgent（`workflow/tests/mocks/agents.ts`）

- `FakeAgent`（第 65-84 行）：`status: AgentStatus = 'idle'`（可写）、`inbox = { hasPending: false }`（可写对象）、`session: FakeSession`（`events` 数组 + `append`）、`whenIdle()` 立即 resolve（mock 无驱动活动，第 81-83 行）。
- `FakeAgentRegistry`（第 95-154 行）：`get`/`create`/`resume`/`register`；`create` 记录 `meta.cwd`，可注入 `setupError` 模拟 setup 抛错回滚；`register(agent)` 手动注册活 Agent（供子代理测试注入真实 childId）。

---

## 八、workflow-engine.spec.ts 对 abortInstance 的既有断言

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`

`describe('SandoreEngineRuntime abort')`（第 678-728 行）：

1. **`aborts a hanging shell step to the aborted terminal state`**（第 679-712 行）：
   - 挂起 shell step（`runHandler` 等待 `spec.signal` abort 后 resolve `{ aborted: true, signal: 'SIGTERM' }`）。
   - 流程：`waitForStepStart` → `engine.abortInstance(run.instanceId)` → `waitForAborted`。
   - 断言：发出过 `sandore/aborted` 事件；`persistence.state.get(...).status === 'aborted'`。
2. **`rejects abortInstance for a completed instance`**（第 714-727 行）：
   - 完成后调用 `abortInstance` 断言 reject `{ code: 'INVALID_OPERATION' }`。

另在接口测试（第 394-403 行）`throws INVALID_OPERATION with not implemented for the 6 unimplemented methods`：断言 `pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`/`recoverInstance` 均 reject `{ code: 'INVALID_OPERATION' }` 且消息含 `not implemented`。

---

## 附：seam.ts 中已声明但未实现的暂停/恢复事件

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`

- Cordis `Events`（第 41-43 行）已声明：`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`。
- `SessionEventMap`（第 59-61 行）已声明同名 Session 事件（`step-paused: { stepId, childId }`、`step-resumed: { stepId, childId, resumePrompt? }`、`step-retried: { stepId, mode }`）。
- 抽象方法（第 92-101 行）：`pauseStep` / `resumeStep(instanceId, stepId, resumePrompt?)` / `pauseAllSteps` / `resumeAllSteps(instanceId, resumePrompt?)` / `retryStep(instanceId, stepId, mode: 'continue'|'revert'|'fork', message)`，与 `abortInstance`、`getState` 同属 `SandoreEngine` Service surface。

> 以上即 lifecycle-01（暂停/恢复）落点所需的关键现状面：`pausedChildIds` 字段、`pausedAt/resumedAt/resumePrompt` Step 字段、`StepStatus`/`DagRunStatus` 的 `paused` 值、`subagents.interrupt/followup` 接缝与真实 DSH 语义、`emitContained/safeAppend` 双发范式、`ActiveInstance`/`instances`/`persistState`/`runnerConfig`/`runInstance` 等待点、`abortInstance` 现状，以及测试侧 `FakeSubagents`/`FakeAgent` 与既有 abort 断言。
