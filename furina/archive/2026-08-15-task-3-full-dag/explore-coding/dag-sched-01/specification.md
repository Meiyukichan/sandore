# DAG 调度循环改造基线 — 现状核实

> 探索目标：精确核实 (1) dag-navigator、(2) stage-executor、(3) workflow-engine 三个改造基线的完整现状，(4) 前五个 feature 可复用模块的精确导出，(5) schema.ts 关键类型精确形状，(6) workflow-engine.spec.ts 测试范式与 harness() 构造。
> 本文仅记录现状事实，不含任何改造方案、提案或实现建议。

## 0. 文件清单（绝对路径）

| 编号 | 文件 | 路径 |
|---|---|---|
| (1) | DAG 导航器 | `D:\project-code\llm\sandore\packages\sandore\workflow\src\dag-navigator.ts` |
| (2) | Stage 执行器 | `D:\project-code\llm\sandore\packages\sandore\microflow\src\stage-executor.ts` |
| (3) | 引擎运行时 | `D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts` |
| (4) | step-runner | `D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.ts` |
| (4) | branch-evaluator | `D:\project-code\llm\sandore\packages\sandore\microflow\src\branch-evaluator.ts` |
| (4) | loop-manager | `D:\project-code\llm\sandore\packages\sandore\microflow\src\loop-manager.ts` |
| (4) | finalize-manager | `D:\project-code\llm\sandore\packages\sandore\microflow\src\finalize-manager.ts` |
| (4) | file-utils | `D:\project-code\llm\sandore\packages\sandore\microflow\src\file-utils.ts` |
| (5) | schema | `D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts` |
| (5) | types（StageContract/FinalizeOutcome 等） | `D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts` |
| (6) | 引擎测试 | `D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.spec.ts` |
| 辅助 | seam（SandoreEngine 抽象 + 13 事件声明） | `D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts` |
| 辅助 | internal（textSummary/resolvePassThroughVars 等） | `D:\project-code\llm\sandore\packages\sandore\microflow\src\internal.ts` |
| 辅助 | yaml-parser（解析 + next 引用校验） | `D:\project-code\llm\sandore\packages\sandore\workflow\src\yaml-parser.ts` |
| 辅助 | persistence（saveWorkflowState） | `D:\project-code\llm\sandore\packages\sandore\workflow\src\persistence.ts` |
| 辅助 | microflow 包入口 | `D:\project-code\llm\sandore\packages\sandore\microflow\src\index.ts` |
| 辅助 | workflow 包入口 | `D:\project-code\llm\sandore\packages\sandore\workflow\src\index.ts` |

关键事实补充：`dag-navigator.ts` 与 `stage-executor.ts` **当前均无专属 spec 文件**（glob 结果中仅有 `schema.spec.ts` / `persistence.spec.ts` / `remote.spec.ts` / `workflow-engine.spec.ts` / `yaml-parser.spec.ts`，以及 microflow 的 `file-utils.spec.ts` / `step-runner.spec.ts` / `branch-evaluator.spec.ts` / `loop-manager.spec.ts` / `finalize-manager.spec.ts` / `subagents.spec.ts`）。

---

## 1. dag-navigator.ts 完整现状（resolveNextNodes 改造基线）

文件头注释明确：**「Task 2 简化：仅 Stage 级线性推进」**，并注明「分支/循环调度留待后续 Task」。

### 1.1 DagNodeRef 结构（export interface）

```ts
export interface DagNodeRef {
  readonly kind: 'stage' | 'step';
  /** 所属 Stage（始终可用）。 */
  readonly stage: WorkflowStage;
  /** 仅 kind === 'step' 时存在。 */
  readonly step?: WorkflowStep | undefined;
  readonly id: string;
  readonly name: string;
  readonly next?: string | undefined;
  readonly condition?: CommandConfig | undefined;
  readonly branches?: DagBranch[] | undefined;
  readonly loop?: DagLoop | undefined;
}
```

要点：这是 Stage 与 Step 在 DAG 调度层的**统一节点视图**；`next` / `condition` / `branches` / `loop` 四字段在 Stage 与 Step 两类节点上都有定义。

### 1.2 WorkflowDagNavigator 类

字段（全部 `private`）：
- `nodeIndex = new Map<string, DagNodeRef>()` — nodeId → 统一节点视图。
- `stageContracts = new Map<string, StageContract>()` — 已完成 Stage 契约。
- `stageOrder: readonly string[]` — Stage 定义数组顺序。
- `currentStageId: string` — 当前 Stage 指针（**无 Step 级指针**）。

构造器：`constructor(private readonly definition: WorkflowDefinition)`，依次执行 `buildNodeIndex(definition)`、`stageOrder = definition.stages.map(stage => stage.id)`、`currentStageId = stageOrder[0] ?? ''`。

方法/访问器：
- `get currentNodeId(): string` — 返回 currentStageId。
- `getStageContracts(): ReadonlyMap<string, StageContract>` — 返回 `new Map(this.stageContracts)` 快照。
- `getStageContract(stageId): StageContract | undefined`。
- `getContractArtifacts(): Record<string, string[]>` — 遍历所有已完成契约，对每个 `contract.contractArtifacts` 的 `[name, files]` 执行 `merged[name] = [...(merged[name] ?? []), ...files]` 聚合。
- `setStageContract(stageId, contract): void`。
- `isStageAllDone(stageId): boolean` — `stageContracts.get(stageId)?.status === 'completed'`。

### 1.3 tryAdvanceStage()

```ts
tryAdvanceStage(): boolean {
  if (!this.isStageAllDone(this.currentStageId)) return false;
  const current = this.nodeIndex.get(this.currentStageId);
  if (current === undefined || current.kind !== 'stage') return false;
  let nextId: string | undefined = current.next;
  if (nextId === undefined) {
    const index = this.stageOrder.indexOf(current.id);
    nextId = index >= 0 ? this.stageOrder[index + 1] : undefined;
  }
  const next = nextId === undefined ? undefined : this.nodeIndex.get(nextId);
  if (next === undefined || next.kind !== 'stage') return false;
  this.currentStageId = next.id;
  return true;
}
```

语义：仅当前 Stage 已 completed 时推进；优先跟随 `current.next`，否则按定义数组顺序取下一 Stage；下一节点必须是 Stage（Step 会被拒绝推进）。

### 1.4 buildNodeIndex（private）

```ts
private buildNodeIndex(definition: WorkflowDefinition): void {
  for (const stage of definition.stages) {
    this.nodeIndex.set(stage.id, {
      kind: 'stage', stage,
      id: stage.id, name: stage.name,
      next: stage.next, condition: stage.condition,
      branches: stage.branches, loop: stage.loop,
    });
    for (const step of stage.steps) {
      this.nodeIndex.set(step.id, {
        kind: 'step', stage, step,
        id: step.id, name: step.name ?? step.id,
        next: step.next, condition: step.condition,
        branches: step.branches, loop: step.loop,
      });
    }
  }
}
```

要点：nodeIndex 的 key 直接使用 `stage.id` 与 `step.id`；Step 节点的 `name` 回退为 `step.id`。

### 1.5 关键结论（现状边界）

- **当前没有 `resolveNextNodes` 方法**，只有 Stage 级 `tryAdvanceStage`。
- 分支（`branches`）、循环（`loop`）、条件（`condition`）字段**已在 DagNodeRef 上承载，但导航器未消费**。
- nodeIndex 已建立 Stage+Step 统一视图，但 `tryAdvanceStage` 只用 Stage 级；没有 Step 级推进能力。
- `stageContracts` 仅由引擎在 Stage 完成后写入（见第 3 节）。

---

## 2. stage-executor.ts 完整现状（DAG 调度循环改造基线）

文件头注释明确：**「Task 2 简化：按 `steps` 数组顺序线性执行」**。

### 2.1 导出接口

```ts
export interface StageExecutionInput {
  readonly originalInput: string;
  readonly contractArtifacts: Record<string, string[]>;
  readonly passThroughVars: WorkflowTaskState['passThroughVars'];
}

export interface PassThroughVarValue {
  value: string;
  description: string;
  refresh?: boolean;
}

export interface StageSharedState {
  readonly cwd: string;
  readonly jobId: string;
  readonly taskId: string;
}

export interface StageStepHooks {
  readonly onStepStart: (step: WorkflowStep, childId: string) => void;
  readonly onStepCompleted: (step: WorkflowStep, childId: string, output: ContentBlock[]) => void;
  readonly onStepFailed: (step: WorkflowStep, childId: string, error: string) => void;
}

export interface StageExecutorOptions {
  readonly ctx: Context;
  readonly stageDef: WorkflowStage;
  readonly workflowDef: WorkflowDefinition;
  readonly input: StageExecutionInput;
  readonly sharedState: StageSharedState;
  readonly runnerConfig: StepRunnerConfig;
  readonly signal?: AbortSignal;
  readonly hooks?: StageStepHooks;
  /** 单个 Step 完成/失败后的持久化回调（由引擎注入，逐 Step 持久化状态快照）。 */
  readonly onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> | void;
}

export interface StageExecutionResult {
  readonly stageContract: StageContract;
  readonly executedSteps: ExecutedStepDefault[];
  readonly passThroughVars: Record<string, PassThroughVarValue>;
  readonly status: StepStatus;
  readonly errorDetail?: string;
}
```

### 2.2 顶层纯函数

- `synthesizeChildId(stepId)`：返回 `step-${stepId}-${execId 前 8 位}`，其中 `execId = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8)`。
- `collectPassThroughVars(stageDef)`：遍历 `stageDef.steps`，对每个 `step.passThroughVars ?? []` 执行 `result[passThroughVar.name] = toPassThroughValue(passThroughVar)`（**同名后写覆盖先写**）。
- `toPassThroughValue(passThroughVar)`：返回 `{ value, description, ...(refresh === undefined ? {} : { refresh }) }`。
- `toPreviousOutput(step: ExecutedStepDefault): PreviousStepOutput`：返回 `{ name: step.name, id: step.stepId ?? step.id, returnPrompt: textSummary(step.output), files: [] }`（`files` 恒为空数组）。
- `finalizeStageContract(stageDef, executedSteps, status, passThroughVars, errorDetail): StageContract`：
  - artifacts 遍历 executedSteps，对每个 `step.outputTo ?? []` push `{ stepId: step.stepId ?? step.id, outputToId: outputTo.id, files: [], ...(returnPrompt === '' ? {} : { returnPrompt }) }`（returnPrompt = `textSummary(step.output)`）。
  - 返回 `{ stageId, stageName, status, artifacts, passThroughVars, contractArtifacts: {}, completedAt: new Date().toISOString(), ...(errorDetail 有则带 errorDetail) }`。
  - 关键：**`contractArtifacts` 恒为 `{}`**。

### 2.3 StageExecutor 类

- 字段：`private readonly runner: StepRunner`，构造器内 `this.runner = new StepRunner(options.ctx, options.runnerConfig)`。
- `async execute(): Promise<StageExecutionResult>` 主体是一个**线性 for 循环**：

```ts
const { stageDef, input, sharedState, signal, hooks } = this.options;
const executedSteps: ExecutedStepDefault[] = [];
const previousOutputs: PreviousStepOutput[] = [];
let status: StepStatus = 'completed';
let errorDetail: string | undefined;

for (const step of stageDef.steps) {
  const childId = synthesizeChildId(step.id);
  const command = step.command;
  const executed: ExecutedStepDefault = {
    type: 'default', id: childId, stepId: step.id, stageId: stageDef.id,
    name: step.name ?? step.id, status: 'running',
    ...(command === undefined ? {} : { command }),
    ...(step.inputFrom === undefined ? {} : { inputFrom: step.inputFrom }),
    ...(step.outputTo === undefined ? {} : { outputTo: step.outputTo }),
    ...(step.passThroughVars === undefined ? {} : { passThroughVars: step.passThroughVars }),
    ...(command === undefined ? {} : { sessionMeta: { childId, synthetic: true, command: command.type } }),
    visitCount: 1,
  };

  hooks?.onStepStart(step, childId);

  if (command === undefined) {
    const message = `step '${step.id}' has no command`;
    executed.status = 'failed'; executed.error = message;
    executedSteps.push(executed);
    hooks?.onStepFailed(step, childId, message);
    await this.options.onPersist?.(executed);
    status = 'failed'; errorDetail = message;
    break;
  }

  try {
    const result = await this.runner.run({
      step,
      workdir: sharedState.cwd,
      originalInput: input.originalInput,
      previousOutputs,
      ...(signal === undefined ? {} : { signal }),
    });
    executed.status = 'completed';
    executed.output = result.output;
    executedSteps.push(executed);
    previousOutputs.push(toPreviousOutput(executed));
    hooks?.onStepCompleted(step, childId, result.output);
    await this.options.onPersist?.(executed);
  } catch (error) {
    const message = describeError(error);
    executed.status = 'failed'; executed.error = message;
    executedSteps.push(executed);
    hooks?.onStepFailed(step, childId, message);
    await this.options.onPersist?.(executed);
    status = 'failed'; errorDetail = message;
    break;
  }
}

const passThroughVars = collectPassThroughVars(stageDef);
const stageContract = finalizeStageContract(stageDef, executedSteps, status, passThroughVars, errorDetail);
return { stageContract, executedSteps, passThroughVars, status, ...(errorDetail === undefined ? {} : { errorDetail }) };
```

### 2.4 关键结论（现状边界，与改造直接相关）

- `execute()` 是**单 Stage 内线性 for 循环**，无 DAG 调度、无分支/循环、无 visitCount 管理（visitCount 恒 1）。
- **`input.contractArtifacts` 与 `input.passThroughVars` 两个字段当前未被 execute() 消费**（execute 只用 `input.originalInput`；passThroughVars 由 `collectPassThroughVars(stageDef)` 重新从定义收集）。
- **`StageExecutorOptions.workflowDef` 当前未被使用**。
- `StepRunner.run()` 的请求对象中**未传 `passThroughVars` / `loopTurn` / `loopMaxIterations`**（StepRunRequest 有这三个可选字段但 StageExecutor 未填）。
- **`StepRunResult.sessionMeta` 未被 StageExecutor 消费** —— 每个 executed 的 `sessionMeta` 恒为合成占位 `{ childId, synthetic: true, command: command.type }`；`runner.run` 返回的真实 `sessionMeta`（子代理真实 childId）被丢弃。
- 每个 Step 完成后（无论成功/失败/无命令）都会调 `await this.options.onPersist?.(executed)`。
- 失败即 `break`（中止后续 Step），整体 status 落 failed，errorDetail 记录首个失败原因。

---

## 3. workflow-engine.ts 完整现状（引擎接入改造基线）

文件头注释明确：**「Stage 级线性主循环」**。

### 3.1 模块级类型与常量

- `interface ActiveInstance { readonly controller: AbortController; readonly session: Session; readonly definition: WorkflowDefinition; state: WorkflowTaskState }`
- `TERMINAL_STATUSES: ReadonlySet<WorkflowTaskState['status']> = new Set(['completed', 'failed', 'aborted'])`
- 辅助函数：`renderError`、`now()`（ISO 时间）、`makeInstanceId()`（`YYYYMMDD-HHmmss-xxx`，xxx 为 randomUUID 去连字符前 3 位）、`makeInitialState(...)`、`toDagInstanceState(...)`。

`makeInitialState` 初始化的 `WorkflowTaskState`（关键字段初值）：
```
taskId, jobId, workflowId, cwd,
status: 'pending',
originalInput,
currentStageId: definition.stages[0]?.id ?? '',
executedSteps: [],
stageInfos: definition.stages.map(stage => ({ id, name, status: 'blocked' })),
pendingInteractions: [], pendingQueue: [],
visitCounts: {}, passThroughVars: {},
activeLoopIterationStack: [], activeLoopNodeId: null, activeLoopStack: [],
pausedStepIds: [], stageContracts: {},
createdAt, updatedAt
```

`toDagInstanceState`：将 WorkflowTaskState 投影为 DagInstanceState（`executedSteps` 用 `as unknown as` 强转以容纳 ContentBlock[] output 形状差异）。

### 3.2 SandoreEngineRuntime 类

- `static Config: z<SandoreConfig>`（schemastery）：`{ defaultTimeoutMs: natural default 7200000, maxConcurrentSteps: natural default 0, defaultProvider: string, defaultModel: string }`。
- `static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`。
- `private readonly instances = new Map<string, ActiveInstance>()`。
- 构造器：`constructor(ctx: Context, private readonly config: SandoreConfig)`，`super(ctx)`。

### 3.3 生命周期入口

- `startInstance(request): DagRun`：persistence 取不到抛 `INVALID_OPERATION`；definition 记录取不到抛 `NODE_NOT_FOUND`；`parseWorkflowYaml(record.yaml)`；`makeInstanceId()`；`cwd = request.cwd ?? '/tmp'`；`makeInitialState`；`new AbortController()`；`session = this.ctx.sessions.create(SessionId(instanceId), { meta: { cwd } })`；登记 instances；`void this.persistState(active)`；`void this.execute(instanceId)`；返回 `{ instanceId, status: 'running' }`。
- `getState(instanceId)`：内存优先，其次 `persistence.state.get`，都无抛 `NODE_NOT_FOUND`。
- `abortInstance(instanceId)`：无实例抛 `NODE_NOT_FOUND`；终态实例抛 `INVALID_OPERATION`；否则 `active.controller.abort()`。
- 其余 8 个实例方法（recoverInstance/replyQuestion/replyPermission/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps/retryStep）均 `throw new SandoreError('... is not implemented', 'INVALID_OPERATION')`。

### 3.4 执行主体

`execute(instanceId)`：取 active，`await this.runInstance(active)`；catch 时置 `status: 'failed'` + `persistState` + `emitEnd(..., { status: 'failed', error: renderError(error) })`。

`runInstance(active)` 核心（Stage 主循环）：

```ts
const { controller, session, definition } = active;
const signal = controller.signal;
const info: DagRunInfo = { taskId, workflowId, jobId };

active.state = { ...active.state, status: 'running', updatedAt: now() };
await this.persistState(active);
this.emitStart(session, info);

const navigator = new WorkflowDagNavigator(definition);
let stageId = navigator.currentNodeId;

while (stageId !== '') {
  const stage = definition.stages.find(item => item.id === stageId);
  if (stage === undefined) break;

  this.markStageStatus(active, stageId, 'running');
  await this.persistState(active);
  this.emitStageStart(session, info, stageId);

  const hooks: StageStepHooks = {
    onStepStart: (step, childId) => this.emitStepStart(session, info, step.id, childId),
    onStepCompleted: (step, childId, output) => this.emitStepCompleted(session, info, step.id, childId, output),
    onStepFailed: (step, childId, error) => this.emitStepFailed(session, info, step.id, childId, error),
  };

  const executor = new StageExecutor({
    ctx: this.ctx,
    stageDef: stage,
    workflowDef: definition,
    input: {
      originalInput: active.state.originalInput,
      contractArtifacts: navigator.getContractArtifacts(),
      passThroughVars: active.state.passThroughVars,
    },
    sharedState: { cwd: active.state.cwd, jobId: active.state.jobId, taskId: active.state.taskId },
    runnerConfig: this.runnerConfig(),
    signal,
    hooks,
    onPersist: async (executed) => {
      active.state = {
        ...active.state,
        executedSteps: [ ...active.state.executedSteps, executed as unknown as WorkflowTaskState['executedSteps'][number] ],
        updatedAt: now(),
      };
      await this.persistState(active);
    },
  });

  const result = await executor.execute();

  active.state = {
    ...active.state,
    passThroughVars: { ...active.state.passThroughVars, ...result.passThroughVars },
    updatedAt: now(),
  };

  if (result.status === 'failed') {
    this.markStageStatus(active, stageId, 'failed');
    if (signal.aborted) {
      active.state = { ...active.state, status: 'aborted', updatedAt: now() };
      await this.persistState(active);
      this.emitAborted(session, info);
    } else {
      active.state = { ...active.state, status: 'failed',
        stageContracts: { ...active.state.stageContracts, [stageId]: result.stageContract }, updatedAt: now() };
      await this.persistState(active);
      this.emitEnd(session, info, { taskId, jobId, status: 'failed', ...(result.errorDetail 有则带 error) });
    }
    return;
  }

  this.markStageStatus(active, stageId, 'completed');
  navigator.setStageContract(stageId, result.stageContract);
  active.state = { ...active.state, currentStageId: stageId,
    stageContracts: { ...active.state.stageContracts, [stageId]: result.stageContract }, updatedAt: now() };
  await this.persistState(active);
  this.emitStageCompleted(session, info, stageId, result.stageContract);

  if (!navigator.tryAdvanceStage()) stageId = '';
  else stageId = navigator.currentNodeId;
}

active.state = { ...active.state, status: 'completed', updatedAt: now() };
await this.persistState(active);
this.emitEnd(session, info, { taskId, jobId, status: 'completed' });
```

### 3.5 状态辅助

- `markStageStatus(active, stageId, status)`：map `stageInfos` 中同 id 项的状态。
- `runnerConfig(): StepRunnerConfig`：返回 `{ defaultTimeoutMs: config.defaultTimeoutMs ?? 7200000, ...(defaultProvider), ...(defaultModel) }` —— **不含 skills/mcps/agents/hostAgent**。
- `persistence()`：`this.ctx.get('sandorePersistence')`。
- `persistState(active)`：`persistence.saveWorkflowState(active.state)`，catch 时 `ctx.logger.warn`。

### 3.6 事件双发

- `emitContained(name, args)`：`this.ctx.events.dispatch('emit', [name, ...args])` 遍历回调逐个调用（同步 + `Promise.resolve(...).catch` 兜底，异常仅 warn 不中断）。
- `safeAppend(fn)`：try/catch 包裹 `session.append`，异常 warn。
- 每个 `emitXxx` = `emitContained(...)` + `safeAppend(() => session.append(...))`，共 8 个：`emitStart` / `emitStageStart` / `emitStageCompleted` / `emitStepStart` / `emitStepCompleted` / `emitStepFailed` / `emitEnd` / `emitAborted`。
- 事件名（13 个双声明在 `seam.ts` 中，实际发射其中 8 个）：`sandore/start`、`sandore/stage-start`、`sandore/stage-completed`、`sandore/step-start`、`sandore/step-completed`、`sandore/step-failed`、`sandore/end`、`sandore/aborted`；**未发射** `sandore/step-paused` / `sandore/step-resumed` / `sandore/step-retried` / `sandore/question` / `sandore/permission`。

### 3.7 关键结论（现状边界，与改造直接相关）

- 引擎主循环是 **Stage 级线性 while 循环**，逐 Stage 构造 StageExecutor 并执行整个 Stage。
- 每个 Step 完成后经 `onPersist` 立即追加到 `state.executedSteps` 并落盘（Stage 结束前即可读到已完成 Step 快照）。
- `state.visitCounts` / `activeLoopStack` / `activeLoopIterationStack` / `activeLoopNodeId` / `pausedStepIds` **当前仅初始化，未被消费**。
- `StageExecutor` 构造只传 `runnerConfig`（timeout/provider/model），未传 skills/mcps/agents/hostAgent；未构造 LoopManager / BranchEvaluator / FinalizeManager。
- Step 执行入口集中在 StageExecutor 内部，引擎不直接逐 Step 调度。

---

## 4. 前五个 feature 可复用模块的精确导出

> microflow 包入口 `index.ts` re-export：`errors`、`file-utils`、`branch-evaluator`、`finalize-manager`、`loop-manager`、`step-runner`、`stage-executor`、`subagents`。`internal.ts` **不 re-export**（`describeError` / `textSummary` / `splitCommand` / `resolvePassThroughVars` / `buildShellEnv` / `resolveProviderModel` 仅包内使用）。

### 4.1 step-runner.ts

- `export interface StepRunResult { readonly output: ContentBlock[]; readonly sessionMeta?: StepRunSessionMeta }`
- `export interface StepRunSessionMeta { readonly childId?: string; readonly synthetic: boolean; readonly command: CommandConfig['type'] }`
- `export interface StepRunnerConfig { defaultTimeoutMs: number; defaultProvider?; defaultModel?; skills?: readonly string[]; mcps?: readonly string[]; agents?: readonly string[]; hostAgent?: Agent }`
- `export interface StepRunRequest { step; workdir; originalInput; previousOutputs; signal?; passThroughVars?: Readonly<Record<string,string>>; loopTurn?: number; loopMaxIterations?: number }`
- `export interface PreviousStepOutput { name; id; returnPrompt; files: string[] }`
- `export class StepRunner { constructor(ctx, config); run(request): Promise<StepRunResult> }`

要点：`StepRunResult.sessionMeta` 是**唯一**从执行结果带回真实 childId（子代理）的通道；shell/prompt 路径不返回 sessionMeta。

### 4.2 branch-evaluator.ts

- `export class BranchEvaluator { constructor(ctx, config: BranchEvaluatorConfig); start(condition, contextMessage, options?): Promise<BranchEvalPartial>; collect(partial): Promise<BranchEvalResult>; evaluate(condition, contextMessage, options?): Promise<BranchEvalResult> }`
- `export function extractExpectation(raw: string): string` — 三级解析：JSON `branchExpectation` → regex → `raw.trim()`。
- `export function extractBreakResult(raw: string): string` — 三级解析：JSON `shouldBreak`（布尔/字符串）→ regex → `raw.trim()`。
- `export function matchesExpectation(result: string, expectation: string): boolean` — expectation 含 regex 元字符时正则匹配（非法正则返回 false），否则字符串相等。
- 其余导出：`BranchEvaluatorConfig { defaultTimeoutMs; defaultProvider?; defaultModel? }`、`BranchEvalOptions`、`BranchEvalResult { output; sessionHandle }`、`BranchEvalPartial { sessionHandle; outputPromise }`、`TempSessionHandle = string`。

### 4.3 loop-manager.ts

- `export class LoopManager`：
  - 公开字段：`readonly stepIdSuffixMap = new Map<string, string>()`（原始 id → 4 位 hex 后缀，同迭代同原始 id 复用）。
  - 私有字段：`loopMaxIterationsStack: number[]`（进程内，不持久化）、`evaluator: BranchEvaluator`（内部自建）。
  - 构造器：`(ctx: Context, config: LoopManagerConfig, private readonly state: LoopState)`。
  - `get activeLoopNodeId(): string | null` — `activeLoopStack` 栈顶或 null。
  - `static loopIdSuffix(): string` — randomUUID 去连字符前 4 位。
  - `getActualStepId(originalStepId): string` — 返回 `原始id-4位hex`，复用映射。
  - `stripIdSuffix(id): string` — 按 stepIdSuffixMap 还原原始 id。
  - `buildLoopIterationPath(): number[]` — 返回 `[...activeLoopIterationStack]` 拷贝。
  - `incrementLoopIteration(): void` — 最内层计数 +1 并 `stepIdSuffixMap.clear()`。
  - `pushActiveLoop(nodeId, maxIterations): void` — 压循环栈 + 迭代栈（1）+ maxIterations 栈，清后缀映射。
  - `popActiveLoop(): void` — 依次弹迭代栈、循环栈、maxIterations 栈。
  - `getLoopIterationContext(): { loopTurn: number; loopMaxIterations: number }` — 取栈顶，非循环时均为 0。
  - `async checkLoopBreak(node: LoopNode, visitCount: number, context?: LoopBreakContext): Promise<LoopBreakOutcome>` — ① `visitCount >= loop.maxIterations` 立即 true；② 有 breakCondition 时经 evaluator.evaluate 两阶段评估，写 `loopMeta`（`{ status: 'completed', result, sessionId?, expectation? }`），agent/prompt/skill/mcp 用 `extractBreakResult === 'true'`，shell 用 `matchesExpectation(output.trim(), breakExpectation)`（breakExpectation 缺失时返回 false）。
- 其余导出：`LoopManagerConfig = BranchEvaluatorConfig`、`LoopState { activeLoopStack: string[]; activeLoopIterationStack: number[] }`、`LoopNode { id; loop?: DagLoop }`、`LoopBreakContext { input; output; artifacts?; passThroughVars? }`、`LoopBreakOutcome { shouldBreak; loopMeta?: BranchMeta }`。

### 4.4 finalize-manager.ts

- `export class FinalizeManager { constructor(ctx, config: FinalizeManagerConfig); async finalizeStep(request: FinalizeStepRequest): Promise<FinalizeOutcome> }`
  - 编排顺序：跳过检查（`hasUnresolvedPassThroughVars(step)` 为 false 且 `hasEnabledGates(gates)` 为 false → 直接 `{ type: 'done', completionType: 'completed' }`）→ `assessor.assess` → 若 `completionType === 'ask'`：`executedStep.status = 'interacting'` + persistFinalize + `{ type: 'ask', assessResult }` → 有门禁则 `gateEvaluator.evaluate` → gate 未过 → `{ type: 'error', errorDetail, assessResult, gateResult }` → 否则 `{ type: 'done', completionType: 'completed', assessResult, gateResult? }`。
  - persistFinalize：`executedStep.finalizeMeta = buildFinalizeMeta(...)`；`writeBackPassThroughVars(...)` 回写 `request.passThroughVars`（就地，保留 description/refresh）；`await request.onPersist?.(executedStep)`。
- `export class FinalizeAssessor { assess(input: FinalizeAssessInput): Promise<FinalizeAssessResult> }`
- `export class GateEvaluator { evaluate(input: FinalizeGateInput): Promise<GateEvalResult> }`
- `export function parseAssessResult(raw)` / `parsePrimaryGate(raw)` / `parseSecondaryGate(raw)`。
- 其余导出：`FinalizeManagerConfig`、`FinalizeStepContext { input; output; artifacts? }`、`FinalizeAssessInput`、`FinalizeGateInput`、`FinalizeStepRequest`（含 `step`、`executedStep`、`stepSessionId?`、`context`、`gates?`、`workdir`、`passThroughVars?: Record<string, PassThroughVarValue>`、`signal?`、`onPersist?`）。
- `FinalizeOutcome` 定义在 `workflow/src/types.ts`（三态联合：`{ type: 'done'; completionType: 'completed'; assessResult?; gateResult? } | { type: 'ask'; assessResult } | { type: 'error'; errorDetail; assessResult?; gateResult? }`）。

### 4.5 file-utils.ts

- `export function resolveFromInputFrom(executedSteps: readonly ExecutedStepDefault[], currentIndex: number, inputFromItems: readonly InputFromItem[]): ExecutedStepDefault[]`
  - inputFromItems 为空：回退 `executedSteps[currentIndex - 1]`。
  - 每项 `path` 走 `resolvePathSegments`，`regex` 遍历全部 Step 输出文本（`textSummary`）正则匹配（倒序最近优先）。
- `export function replacePassThroughVars(str: string, vars: Readonly<Record<string,string>>): string` — 替换 `${xxx}`，未定义保留原文。
- 其他导出：`resolvePathSegments`、`idMatches(actualId, targetId)`（相等或 `targetId-` 前缀）、`globToRegex`、`escapeRegexChar`、`isGlobPattern`、`walkDir`、`findFilesByGlob`、`findFilesByRegex`、`writeOutputJson`、`readOutputJson`、`outputJsonFileName`、`FileSystem`、`FsTarget`、`FsDirEntry`、`FsWriteOutcome`、`OutputArtifact`、`StepOutputFile`。

### 4.6 internal.ts（不公开，但被 stage-executor/step-runner 复用）

- `describeError(error)`、`textSummary(output: readonly ContentBlock[] | undefined): string`（仅 text 块拼接）、`splitCommand`、`resolvePassThroughVars(passThroughVars, loopTurn, loopMaxIterations)`（注入 `in-loop-turn`/`all-loop-turn`）、`buildShellEnv`、`resolveProviderModel`。

---

## 5. schema.ts 关键类型精确形状

### 5.1 WorkflowTaskState（`WorkflowTaskStateSchema` → `z.infer`）

```ts
{
  taskId: string;
  jobId: string;
  workflowId: string;
  cwd: string;
  status: DagRunStatus;            // 'pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused'
  originalInput: string;
  currentStageId: string;
  executedSteps: ExecutedStepDefault[];
  stageInfos: StageInfo[];         // { id; name; status: StepStatus }
  pendingInteractions: unknown[];
  pendingQueue: string[];
  visitCounts: Record<string, number>;
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>;
  activeLoopIterationStack: number[];
  activeLoopNodeId: string | null;
  activeLoopStack: string[];
  pausedStepIds: string[];
  stageContracts: Record<string, StageContract>;
  createdAt: string;
  updatedAt: string;
}
```

`StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`。

### 5.2 DagNodeRef（定义在 dag-navigator.ts，见 1.1；不在 schema.ts）

### 5.3 WorkflowStep（`WorkflowStepSchema`）

```ts
{
  id: string;
  name?: string;
  command?: CommandConfig;
  inputFrom?: { id: string; path?: string; regex?: string }[];
  outputTo?: { id: string; path?: string; regex?: string }[];
  passThroughVars?: { name: string; value: string; description: string; refresh?: boolean }[];
  timeout?: number;
  next?: string;
  defaultExpectation?: string;
  condition?: CommandConfig;
  branches?: DagBranch[];
  loop?: DagLoop;
  rules?: string[];
  gates?: Gates;
}
```

### 5.4 WorkflowStage（`WorkflowStageSchema`）

```ts
{
  id: string;
  name: string;
  rules?: string[];
  gates?: Gates;
  steps: WorkflowStep[];
  next?: string;
  defaultExpectation?: string;
  condition?: CommandConfig;
  branches?: DagBranch[];
  loop?: DagLoop;
}
```

### 5.5 相关子 schema 精确形状

- `CommandConfigSchema`（discriminatedUnion，判别字段顶层 `type`，变体嵌套 `value`）：`agent`(promptText + agentParamsTemplate?/providerId?/modelId?)、`prompt`(promptText + providerId?/modelId?)、`shell`(command)、`skill`(promptText + providerId?)、`mcp`(promptText)。
- `DagBranchSchema = { expectation?: string; next: string; label?: string }`（省略 expectation 表示并行分支）。
- `DagLoopSchema = { breakCondition?: CommandConfig; breakExpectation?: string; next?: string; maxIterations: number; exitTo?: string }`。
- `GatesSchema = { maxRetries?; maxTokens?; primary?: { enabled: boolean }; secondary?: { enabled: boolean; prompt?: string }; need_confirm?: boolean }`。
- `StepSessionMetaSchema = { childId: string; synthetic: boolean; command: 'shell'|'prompt'|'agent'|'skill'|'mcp' }`。
- `ExecutedStepDefaultSchema`（存储 shape，见 types.ts 第 87-113 行的 `ExecutedStepDefault` interface，二者一致）：含 `type: 'default'`、`id`、`stepId?`、`stageId`、`name`、`status`、`command?`、`inputFrom?`、`outputTo?`、`passThroughVars?`、`sessionMeta?`、`finalizeMeta?`、`visitCount`、`branchMeta?`、`error?`、`pausedAt?`、`resumedAt?`、`resumePrompt?`、`sessionMessages?`、`pauseEntryId?`、`loopIteration?: number[]`、`loopMeta?`、`retryHistory?`、`parentSessionId?`、`output?: ContentBlock[]`。
- `StageContractSchema`（见 types.ts `StageContract` interface，一致）：`{ stageId; stageName; status; artifacts: { stepId; outputToId; files: string[]; returnPrompt? }[]; passThroughVars: Record<string, {value; description; refresh?}>; contractArtifacts: Record<string, string[]>; completedAt: string; errorDetail? }`。
- `WorkflowDefinitionSchema`：`{ id; name; version; description?; engine?; skills: string[] (default []); mcps: string[] (default []); agents: string[] (default []); settings: { defaultTimeout: number(default 120); maxConcurrentAgents: number(default 4) }; rules?: Record<string,string>; gates?; stages: WorkflowStage[]; steps?: WorkflowStep[] }`。

### 5.6 yaml-parser 对 DAG 流控字段的校验（与调度相关）

`validateReferences` 会校验：`next`、`branches[].next`、`loop.next`、`loop.exitTo` 引用的节点 ID 均存在；**`stage.next` 必须指向 Stage 节点**（指向 Step 抛 `DEFINITION_INVALID`）；`inputFrom[].path` 前两段（Stage/Step 节点）存在。Step 级 `next` 可指向任意节点（Stage/Step 皆在 nodeIds 集合中）。

---

## 6. workflow-engine.spec.ts 测试范式与 harness() 构造

### 6.1 harness() 构造（所有 mock 注入）

```ts
async function harness(config: SandoreConfig = {}): Promise<{
  ctx: Context; engine: SandoreEngine; persistence: SandorePersistence;
  llm: FakeLlm; shell: FakeShell; sessions: FakeSessionStore;
}> {
  const ctx = new Context();
  const storageDomain = new MemoryStorageDomain();
  ctx.provide('storageDomain', storageDomain as unknown as DomainFacility);
  await ctx.plugin(SandorePersistence);
  const persistence = ctx.sandorePersistence;

  const llm = new FakeLlm();
  const shell = new FakeShell();
  const sessions = new FakeSessionStore();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell as unknown as ShellExecutor);
  ctx.provide('sessions', sessions as unknown as SessionStore);
  ctx.provide('sessionPersistence', {});
  ctx.provide('subagents', {});
  ctx.provide('fs', {});

  await ctx.plugin(SandoreEngineRuntime, config);
  const engine = ctx.sandoreEngine;
  return { ctx, engine, persistence, llm, shell, sessions };
}
```

注入的上下文键：`storageDomain`（MemoryStorageDomain）、`llm`（FakeLlm）、`shell`（FakeShell）、`sessions`（FakeSessionStore）、`sessionPersistence`（`{}` 空对象）、`subagents`（`{}` 空对象）、`fs`（`{}` 空对象）。即 **agent/skill/mcp 子代理路径与 fs 文件系统操作在此 harness 中不可用**（未提供真实服务）。

### 6.2 mock 类能力（`workflow/tests/mocks/`）

- `FakeLlm`：`providers: LlmProviderInfo[]`、`models: Map<string, LlmModelInfo[]>`、`calls: GenerateOptions[]`、`streamHandler`（默认 `() => textChunks('')`）；`listProviders()`、`listModels(provider)`、`stream(options)`（记录并委托 streamHandler）。
- `textChunks(text, reason = { kind: 'stop' })`：生成 `block-start` → `text-delta` → `block-end` → `finish` 流。
- `FakeSessionStore`：`create(id?)` 返回 `FakeSession`（记录 `append` 的 `events: { type, data }[]`）、`get(id)`、`list()`。
- `FakeShell`：`requests`/`specs` 数组、`resolveHandler`、`runHandler`（默认 `successResult`）、`resolve(request)`、`run(spec)`；`successResult(spec, stdout='')` 生成 exitCode 0 结果。
- `MemoryStorageDomain`：实现 `open(spec)`/`get(name)`；`MemoryDomain`/`MemoryKvTable` 提供 `get/put/delete/update/entries/keys/size`。

### 6.3 测试工具函数

- `putDefinition(persistence, id, yaml)`：parse + `persistence.definitions.put(id, { yaml, name, version, createdAt, updatedAt })`。
- `completedSnapshot(instanceId)`：组装完整 WorkflowTaskState 快照（供 getState 兜底读回测试）。
- `recordSandoreEvents(ctx)`：注册全部 `sandore/*` 监听，返回 `Array<{ name; args }>`。
- `waitForEnd(ctx)` / `waitForAborted(ctx)` / `waitForStepStart(ctx)`：基于 `ctx.once`。

### 6.4 YAML fixture 定义（现有测试三套）

1. `linearYaml`：两 Stage（`stg-1` shell `echo hello`，`next: stg-2` → `stg-2` prompt `summarize`）。
2. `multiStepYaml`：单 Stage 两 Step（step-a shell + `outputTo: [{id: opt-a, path: out.txt}]`；step-b prompt + `inputFrom: [{id: in-a, path: "stg-1.step-a.opt-a"}]`）。
3. `twoShellYaml`：单 Stage 两 shell Step（step-a `echo ok`、step-b `false`，用于第二步失败断言）。

### 6.5 断言范式

- 事件序：`records.map(r => r.name)` 精确等于期望数组（start → stage-start → step-start → step-completed → stage-completed → ... → end）。
- 事件双发：`sessions.get(run.instanceId)?.events.map(e => e.type)` 与 ctx 事件同序。
- childId/sessionMeta：`state.executedSteps[0].sessionMeta.childId` 匹配 `/^step-step-abc-[0-9a-f]{8}$/`、`synthetic === true`、`command === 'shell'/'prompt'`。
- 状态快照：`persistence.state.get(run.instanceId)` 断言 status/executedSteps/output/stageInfos/stageContracts。
- 失败：shell 非零退出 `step-failed` + `executedSteps[n].error`；prompt finish error `failure.message`。
- 中止：`shell.runHandler` 挂 abort 监听 + `engine.abortInstance` + `sandore/aborted` + status aborted。

### 6.6 现有 describe 块结构

- `SandoreEngineRuntime interface`：默认导出身份（`SandoreEngineRuntime` + `SandoreEngineStub` named export）、8 个未实现方法抛 INVALID_OPERATION。
- `SandoreEngineRuntime startInstance`：workflowId 不存在抛错且 state 表空、getState 可读、state 表兜底读回、NODE_NOT_FOUND。
- `SandoreEngineRuntime linear execution`：完整事件序 + 双发、多 Step 契约、listener 抛错不中断、childId/sessionMeta。
- `SandoreEngineRuntime failure`：shell 非零、第二步失败保留第一步、prompt finish error。
- `SandoreEngineRuntime abort`：中止悬挂 shell、终态 abortInstance 拒绝。

---

## 7. 汇总：与「DAG 调度循环」改造直接相关的现状要点（仅事实）

1. 调度层（dag-navigator）当前只有 Stage 级线性推进 `tryAdvanceStage`，无 `resolveNextNodes`、无 Step 级指针；但 `nodeIndex` 已按 stage.id/step.id 建立 Stage+Step 统一视图，且 `next`/`condition`/`branches`/`loop` 已在 `DagNodeRef` 上承载。
2. 执行层（stage-executor）当前是「单 Stage 内 steps 数组线性 for 循环」，失败即 break；`input.contractArtifacts`、`input.passThroughVars`、`options.workflowDef` 均未被 execute() 使用；`StepRunResult.sessionMeta` 未消费（executed 的 sessionMeta 恒为合成占位）；StepRunner.run 未传 passThroughVars/loopTurn/loopMaxIterations。
3. 引擎层（workflow-engine）当前是「Stage 级线性 while 循环」，逐 Stage 整体执行；每 Step 经 onPersist 追加 executedSteps 并落盘；`visitCounts`/`activeLoopStack`/`activeLoopIterationStack`/`activeLoopNodeId`/`pausedStepIds` 仅初始化未消费；未构造 LoopManager/BranchEvaluator/FinalizeManager；事件双发为 `emitContained`（dispatch('emit')）+ `session.append`。
4. 可复用模块已齐备且导出完整：step-runner（`StepRunResult.sessionMeta`）、branch-evaluator（`BranchEvaluator`/`extractExpectation`/`matchesExpectation`/`extractBreakResult`）、loop-manager（`LoopManager`/`checkLoopBreak`/`getActualStepId`/`buildLoopIterationPath`/`getLoopIterationContext` 等）、finalize-manager（`FinalizeManager`/`finalizeStep`/`FinalizeOutcome`）、file-utils（`resolveFromInputFrom`/`replacePassThroughVars`）。
5. schema/types 已完整定义 `WorkflowTaskState`（含 `visitCounts`/`passThroughVars`/`activeLoopStack`/`activeLoopIterationStack`/`activeLoopNodeId`/`stageContracts` 等）、`DagNodeRef`、`WorkflowStep`/`WorkflowStage`（均含 `next`/`condition`/`branches`/`loop` 流控字段）与 `DagBranch`/`DagLoop`/`Gates` 等子结构。
6. 测试 harness 已完整提供内存 mock 注入（storageDomain/llm/shell/sessions/sessionPersistence/subagents/fs），但 subagents 与 fs 为空对象 `{}`，agent/skill/mcp 与文件系统操作在现 harness 中不可用。
