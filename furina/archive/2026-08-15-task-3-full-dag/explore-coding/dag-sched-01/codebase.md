# dag-sched-01 探索结果

> 探索类型：codebase（现状核实，非实现提案）
> 项目路径：D:/project-code/llm/sandore
> `project.sourcecode` = `src/`（实际源码位于 `packages/sandore/` 下）
> 语言：中文

## Exploration Result（Phase 3：furina-codebase）

`codebases` 列表仅含一个元素：`docs/codebase`（描述为 "codebase dir of current project, you MUST explore it when using optix-explore skill"）。该目录实际为空（`docs/codebase` 下无任何文件），故 Phase 3 无可探索内容，全部结论来自 Phase 4 手工补充探索。

## Supplementary Exploration Result（Phase 4：手工补充探索）

### 0. 需求理解（What / Boundaries / Goal / Project Context）

- **What**：核实 sandore 工作流引擎「DAG 调度改造」的三个改造基线文件（`dag-navigator.ts` / `stage-executor.ts` / `workflow-engine.ts`）的完整现状、前五个 feature 已产出的五个可复用模块的精确导出签名、`schema.ts` 中 `WorkflowTaskState` 与 `DagNodeRef`/`WorkflowStep`/`WorkflowStage` 的精确形状，以及 `workflow-engine.spec.ts` 的测试范式与 `harness()` 构造。
- **Boundaries**：仅限 `packages/sandore/workflow/src` 与 `packages/sandore/microflow/src` 两个包内的指定文件及其直接类型依赖（`types.ts`/`seam.ts`/`internal.ts`/`index.ts`）与测试 mock（`tests/mocks/*`）。
- **Goal**：为 `resolveNextNodes` 改造、DAG 调度循环改造、引擎接入改造、端到端 DAG 测试编写提供精确的现状基线（结构与签名，不含实现建议）。
- **Project Context**：sandore 是两级（Stage → Step）工作流引擎。依赖方向为 `workflow → microflow`（microflow 对 workflow 仅 `import type` 结构类型）。`workflow-engine.ts` 默认导出 `SandoreEngineRuntime`（继承 `seam.ts` 的 `SandoreEngine`），`StageExecutor`（microflow）负责 Stage 内 Step 线性执行，`WorkflowDagNavigator`（workflow）负责 Stage 级线性推进。当前为「Task 2 线性最小可用」阶段，分支/循环/收尾模块（branch-evaluator/loop-manager/finalize-manager/file-utils/step-runner）已产出但尚未接入主循环。

---

### 1. `workflow/src/dag-navigator.ts`（resolveNextNodes 改造基线）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/dag-navigator.ts`

**`DagNodeRef` 统一节点视图**（`export interface DagNodeRef`，第 13–25 行）：

```ts
export interface DagNodeRef {
  readonly kind: 'stage' | 'step';
  readonly stage: WorkflowStage;              // 所属 Stage（始终可用）
  readonly step?: WorkflowStep | undefined;   // 仅 kind === 'step' 时存在
  readonly id: string;
  readonly name: string;
  readonly next?: string | undefined;
  readonly condition?: CommandConfig | undefined;
  readonly branches?: DagBranch[] | undefined;
  readonly loop?: DagLoop | undefined;
}
```

**`WorkflowDagNavigator` 类结构**（`export class WorkflowDagNavigator`，第 33–136 行）：

私有字段：
- `private readonly nodeIndex = new Map<string, DagNodeRef>()`（nodeId → 统一节点视图）
- `private readonly stageContracts = new Map<string, StageContract>()`
- `private readonly stageOrder: readonly string[]`（`definition.stages.map(s => s.id)` 的定义数组顺序）
- `private currentStageId: string`（初始化为 `stageOrder[0] ?? ''`）

构造：`constructor(private readonly definition: WorkflowDefinition)`，构造内调用 `this.buildNodeIndex(definition)` 并初始化 `stageOrder`/`currentStageId`。

公开方法/访问器（改造基线需注意的精确签名）：
- `get currentNodeId(): string`（第 46 行）
- `getStageContracts(): ReadonlyMap<string, StageContract>`（第 51 行，返回 `new Map(this.stageContracts)` 快照）
- `getStageContract(stageId: string): StageContract | undefined`（第 56 行）
- `getContractArtifacts(): Record<string, string[]>`（第 61 行，聚合所有 `stageContracts` 的 `contractArtifacts`，同名文件数组合并）
- `setStageContract(stageId: string, contract: StageContract): void`（第 72 行）
- `isStageAllDone(stageId: string): boolean`（第 77 行，实现为 `stageContracts.get(stageId)?.status === 'completed'`）
- `tryAdvanceStage(): boolean`（第 88–107 行）
- `private buildNodeIndex(definition: WorkflowDefinition): void`（第 109–135 行）

**`buildNodeIndex` 建立方式**（第 109–135 行）：遍历 `definition.stages`，为每个 Stage 写入一条 `kind: 'stage'` 的 `DagNodeRef`（`next`/`condition`/`branches`/`loop` 直接取自 `stage` 同名字段，`name: stage.name`），再遍历该 Stage 内每个 `step` 写入一条 `kind: 'step'` 的 `DagNodeRef`（`name: step.name ?? step.id`，`stage` 字段指回所属 Stage）。**索引键为 `stage.id` 与 `step.id`（原始 id，非循环后缀 id）**。

**`tryAdvanceStage` 现状逻辑**（第 88–107 行，注意是「Stage 级线性推进」，无分支/循环处理）：
1. `isStageAllDone(currentStageId)` 为 false → 直接返回 false。
2. `nodeIndex.get(currentStageId)` 不存在或 `kind !== 'stage'` → 返回 false。
3. `nextId = current.next`；若 `next === undefined`，则 `nextId = stageOrder[indexOf(current.id) + 1]`（按定义数组顺序推断）。
4. `nodeIndex.get(nextId)` 不存在或 `kind !== 'stage'` → 返回 false。
5. 否则 `currentStageId = next.id`，返回 true。

即：目前 `next`/`condition`/`branches`/`loop` 字段虽已存入 `nodeIndex`，但 `tryAdvanceStage` 只消费 `next`（Stage 级），Step 级节点与分支/循环字段均未参与推进。

---

### 2. `microflow/src/stage-executor.ts`（DAG 调度循环改造基线）

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`

**导出接口**：

```ts
export interface StageExecutionInput {            // 第 27–31 行
  readonly originalInput: string;
  readonly contractArtifacts: Record<string, string[]>;
  readonly passThroughVars: WorkflowTaskState['passThroughVars'];
}

export interface PassThroughVarValue {            // 第 34–38 行
  value: string;
  description: string;
  refresh?: boolean;
}

export interface StageSharedState {               // 第 41–45 行
  readonly cwd: string;
  readonly jobId: string;
  readonly taskId: string;
}

export interface StageStepHooks {                 // 第 48–52 行
  readonly onStepStart: (step: WorkflowStep, childId: string) => void;
  readonly onStepCompleted: (step: WorkflowStep, childId: string, output: ContentBlock[]) => void;
  readonly onStepFailed: (step: WorkflowStep, childId: string, error: string) => void;
}

export interface StageExecutorOptions {           // 第 55–66 行
  readonly ctx: Context;
  readonly stageDef: WorkflowStage;
  readonly workflowDef: WorkflowDefinition;
  readonly input: StageExecutionInput;
  readonly sharedState: StageSharedState;
  readonly runnerConfig: StepRunnerConfig;
  readonly signal?: AbortSignal;
  readonly hooks?: StageStepHooks;
  readonly onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> | void;
}

export interface StageExecutionResult {           // 第 69–75 行
  readonly stageContract: StageContract;
  readonly executedSteps: ExecutedStepDefault[];
  readonly passThroughVars: Record<string, PassThroughVarValue>;
  readonly status: StepStatus;
  readonly errorDetail?: string;
}
```

**模块内私有辅助函数**（非导出，但改造基线需知其行为）：
- `synthesizeChildId(stepId: string): string`（第 78–81 行）：`step-{stepId}-{execId 前 8 位}`，`execId = globalThis.crypto.randomUUID().replace(/-/g,'').slice(0,8)`。
- `collectPassThroughVars(stageDef: WorkflowStage): Record<string, PassThroughVarValue>`（第 84–92 行）：遍历 `stageDef.steps` 中每个 step 的 `step.passThroughVars ?? []`，以 `passThroughVar.name` 为键写入 `toPassThroughValue(...)`（后写覆盖先写）。
- `toPassThroughValue(passThroughVar: PassThroughVar): PassThroughVarValue`（第 95–101 行）：`{ value, description, ...(refresh===undefined ? {} : { refresh }) }`。
- `toPreviousOutput(step: ExecutedStepDefault): PreviousStepOutput`（第 104–111 行）：`{ name: step.name, id: step.stepId ?? step.id, returnPrompt: textSummary(step.output), files: [] }`。
- `finalizeStageContract(stageDef, executedSteps, status, passThroughVars, errorDetail): StageContract`（第 114–143 行）：遍历 `executedSteps` 中每个 `step.outputTo ?? []`，为每个 `outputTo` push 一条 `{ stepId: step.stepId ?? step.id, outputToId: outputTo.id, files: [], ...(returnPrompt==='' ? {} : { returnPrompt }) }`；返回 `{ stageId, stageName, status, artifacts, passThroughVars, contractArtifacts: {}, completedAt: new Date().toISOString(), ...(errorDetail!==undefined ? {errorDetail} : {}) }`。**注意 `contractArtifacts` 恒为空对象 `{}`，`files` 恒为 `[]`**（Task 2 简化）。

**`StageExecutor` 类**（第 151–231 行）：
- 构造 `constructor(private readonly options: StageExecutorOptions)`，内部 `this.runner = new StepRunner(options.ctx, options.runnerConfig)`。
- `async execute(): Promise<StageExecutionResult>`（第 159–230 行）：
  - 解构 `{ stageDef, input, sharedState, signal, hooks } = this.options`。
  - 局部状态：`executedSteps: ExecutedStepDefault[]`、`previousOutputs: PreviousStepOutput[]`、`status: StepStatus = 'completed'`、`errorDetail: string | undefined`。
  - **线性 `for (const step of stageDef.steps)` 循环**（第 166 行）：
    1. `childId = synthesizeChildId(step.id)`。
    2. 组装 `executed: ExecutedStepDefault`（`type:'default'`、`id: childId`、`stepId: step.id`、`stageId: stageDef.id`、`name: step.name ?? step.id`、`status:'running'`、按需携带 `command`/`inputFrom`/`outputTo`/`passThroughVars`、`visitCount: 1`；当 `command !== undefined` 时携带 `sessionMeta: { childId, synthetic: true, command: command.type }`）。
    3. `hooks?.onStepStart(step, childId)`。
    4. `command === undefined` → 标记 `executed.status='failed'` + `executed.error = "step '{id}' has no command"`，push 后 `hooks?.onStepFailed(...)` + `await onPersist?.(executed)`，`status='failed'`、`errorDetail=message`、`break`。
    5. 否则 `try { result = await this.runner.run({ step, workdir: sharedState.cwd, originalInput: input.originalInput, previousOutputs, ...(signal?{signal}) }) }`，成功后 `executed.status='completed'`、`executed.output=result.output`、push、`previousOutputs.push(toPreviousOutput(executed))`、`hooks?.onStepCompleted(...)`、`await onPersist?.(executed)`；`catch` 后标记 failed、`describeError(error)` 写入 `executed.error`、`hooks?.onStepFailed(...)`、`await onPersist?.(executed)`、`status='failed'`、`errorDetail=message`、`break`。
  - 循环后：`passThroughVars = collectPassThroughVars(stageDef)`；`stageContract = finalizeStageContract(...)`；返回 `{ stageContract, executedSteps, passThroughVars, status, ...(errorDetail?{errorDetail}) }`。

**改造基线要点**：`execute()` 只做「Stage 内 `steps` 数组顺序线性执行」，没有 Step 级 `next`/`condition`/`branches`/`loop` 的调度，`finalize-manager`/`loop-manager`/`branch-evaluator`/`file-utils` 均未在此接入；`StepRunner.run` 的调用请求里**未传** `passThroughVars`/`loopTurn`/`loopMaxIterations`（StepRunner 已支持这些可选字段，但 StageExecutor 尚未使用）。

---

### 3. `workflow/src/workflow-engine.ts`（引擎接入改造基线）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`

**类与配置**：
- `export default class SandoreEngineRuntime extends SandoreEngine`（第 130 行）。
- `static Config: z<SandoreConfig>`（第 131–136 行）：`defaultTimeoutMs` 默认 7200000、`maxConcurrentSteps` 默认 0、`defaultProvider`、`defaultModel`。
- `static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`（第 138 行）。
- `private readonly instances = new Map<string, ActiveInstance>()`（第 140 行）。

**`ActiveInstance` 接口**（第 42–47 行）：
```ts
interface ActiveInstance {
  readonly controller: AbortController;
  readonly session: Session;
  readonly definition: WorkflowDefinition;
  state: WorkflowTaskState;
}
```

**`makeInitialState`**（第 73–103 行）返回完整 `WorkflowTaskState`，其中与 DAG 调度相关的初值：`currentStageId: definition.stages[0]?.id ?? ''`、`executedSteps: []`、`stageInfos`（每 Stage `status: 'blocked'`）、`pendingInteractions: []`、`pendingQueue: []`、`visitCounts: {}`、`passThroughVars: {}`、`activeLoopIterationStack: []`、`activeLoopNodeId: null`、`activeLoopStack: []`、`pausedStepIds: []`、`stageContracts: {}`。

**`startInstance`**（第 147–168 行）：`persistence()` 缺失抛 `SandoreError('INVALID_OPERATION')`；`persistence.definitions.get(workflowId)` 缺失抛 `NODE_NOT_FOUND`；`parseWorkflowYaml(record.yaml)` → `makeInstanceId()` → `ctx.sessions.create(SessionId(instanceId), { meta: { cwd } })` → 存 `instances` → `void this.persistState(active)` → `void this.execute(instanceId)`（fire-and-forget）→ 返回 `{ instanceId, status: 'running' }`。

**`execute` → `runInstance`（Stage 主循环）**（第 230–373 行）：
- `execute(instanceId)`：取 `active`，`try { await this.runInstance(active) } catch { ... 置 failed 终态 + persist + emitEnd }`。
- `runInstance(active)`：
  1. `info: DagRunInfo = { taskId, workflowId, jobId }`。
  2. 置 `status:'running'` + persist + `emitStart`。
  3. `const navigator = new WorkflowDagNavigator(definition); let stageId = navigator.currentNodeId;`
  4. **`while (stageId !== '')`** 循环：
     - `stage = definition.stages.find(item => item.id === stageId)`；找不到 `break`。
     - `markStageStatus(active, stageId, 'running')` + persist + `emitStageStart`。
     - 组装 `hooks: StageStepHooks`（`onStepStart/onStepCompleted/onStepFailed` 分别映射到 `emitStepStart/emitStepCompleted/emitStepFailed`）。
     - **构造 `StageExecutor`**（第 287–317 行），传参：`ctx: this.ctx`、`stageDef: stage`、`workflowDef: definition`、`input: { originalInput: active.state.originalInput, contractArtifacts: navigator.getContractArtifacts(), passThroughVars: active.state.passThroughVars }`、`sharedState: { cwd: active.state.cwd, jobId: active.state.jobId, taskId: active.state.taskId }`、`runnerConfig: this.runnerConfig()`、`signal`、`hooks`、`onPersist: async (executed) => { active.state = { ...active.state, executedSteps: [...active.state.executedSteps, executed as unknown as WorkflowTaskState['executedSteps'][number]], updatedAt: now() }; await this.persistState(active); }`。
     - `const result = await executor.execute();`。
     - 合并透传变量：`active.state = { ...active.state, passThroughVars: { ...active.state.passThroughVars, ...result.passThroughVars }, updatedAt: now() }`（**注意此处未 persist**，仅内存合并）。
     - `result.status === 'failed'`：`markStageStatus(..., 'failed')`；若 `signal.aborted` → 置 `status:'aborted'` + persist + `emitAborted`；否则置 `status:'failed'` + `stageContracts` 合并 `result.stageContract` + persist + `emitEnd`；`return`。
     - 成功：`markStageStatus(..., 'completed')`；`navigator.setStageContract(stageId, result.stageContract)`；`active.state` 更新 `currentStageId: stageId` + `stageContracts` 合并 + persist + `emitStageCompleted`。
     - `if (!navigator.tryAdvanceStage()) { stageId = '' } else { stageId = navigator.currentNodeId }`。
  5. 循环结束后：置 `status:'completed'` + persist + `emitEnd`。

**`runnerConfig()`**（第 384–390 行）：返回 `StepRunnerConfig`，仅带 `defaultTimeoutMs` 与可选的 `defaultProvider`/`defaultModel`（未传 `skills`/`mcps`/`agents`/`hostAgent`）。

**事件双发机制**（第 408–470 行）：
- `emitContained(name, args)`：`for (const callback of this.ctx.events.dispatch('emit', [name, ...args]))` 逐个调用，捕获 listener 抛错/拒绝并 `logger.warn`。
- `safeAppend(fn)`：`session.append(...)` 包裹 try/catch。
- 每个事件两个出口：`emitContained('sandore/xxx', args)`（Cordis `ctx.emit`）+ `safeAppend(() => session.append('sandore/xxx', payload))`（宿主 Session）。
- 事件及 payload（注意 **Session 侧 payload 与 Cordis 侧参数形状不同**）：
  - `emitStart`：Cordis `sandore/start` args `[info]`；Session `{ taskId, workflowId, jobId }`。
  - `emitStageStart`：Cordis `[info, stageId]`；Session `{ taskId, stageId }`。
  - `emitStageCompleted`：Cordis `[info, stageId, stageContract]`；Session `{ taskId, stageId, stageContract }`。
  - `emitStepStart`：Cordis `[info, stepId, childId]`；Session `{ stepId, childId }`。
  - `emitStepCompleted`：Cordis `[info, stepId, childId, output]`；Session `{ stepId, childId, output }`。
  - `emitStepFailed`：Cordis `[info, stepId, childId, error]`；Session `{ stepId, childId, error }`。
  - `emitEnd`：Cordis `[info, result]`；Session `{ taskId, jobId, result }`。
  - `emitAborted`：Cordis `[info]`；Session `{ taskId }`。

**`StepRunResult` 消费**：当前 `runInstance` 并不直接消费 `StepRunner` 的 `StepRunResult`；`StepRunner.run` 的结果在 `StageExecutor.execute()` 内部被消费（`result.output` → `executed.output`），`sessionMeta`（StepRunner 对 agent/skill/mcp 返回真实 `childId`）在 StageExecutor 组装 `ExecutedStepDefault` 时被**忽略**（StageExecutor 合成的是 `sessionMeta: { childId, synthetic: true, command }`，未用 StepRunner 返回的 `sessionMeta.childId`）。

**其余方法**：`getState`（内存优先，state 表兜底，`toDagInstanceState` 投影）、`abortInstance`（终态拒绝 + `controller.abort()`）、8 个未实现方法（`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`）均抛 `SandoreError('INVALID_OPERATION', 'not implemented')`。

---

### 4. 前五个 feature 已产出模块的精确导出

均位于 `D:/project-code/llm/sandore/packages/sandore/microflow/src/`，并从 `microflow/src/index.ts` `export *` 公开。

#### 4.1 step-runner（`step-runner.ts`）

- `export interface StepRunnerConfig`（第 51–63 行）：`defaultTimeoutMs: number`、`defaultProvider?/defaultModel?/skills?: readonly string[]/mcps?/agents?/hostAgent?: Agent`。
- `export interface PreviousStepOutput`（第 66–71 行）：`{ name: string; id: string; returnPrompt: string; files: string[] }`。
- `export interface StepRunRequest`（第 74–86 行）：`{ step: WorkflowStep; workdir: string; originalInput: string; previousOutputs: readonly PreviousStepOutput[]; signal?; passThroughVars?: Readonly<Record<string,string>>; loopTurn?: number; loopMaxIterations?: number }`。
- `export interface StepRunSessionMeta`（第 89–93 行）：`{ childId?: string; synthetic: boolean; command: CommandConfig['type'] }`。
- **`export interface StepRunResult`**（第 96–99 行）：`{ readonly output: ContentBlock[]; readonly sessionMeta?: StepRunSessionMeta }`。**`sessionMeta` 为可选字段**；`runPrompt`/`runShell` 返回 `{ output }`（无 sessionMeta），`runSubagent`（agent/skill/mcp）返回 `{ output, sessionMeta: { childId: started.childId, synthetic: false, command: command.type } }`。
- `export class StepRunner`（第 281 行）：`constructor(ctx: Context, config: StepRunnerConfig)`；`async run(request: StepRunRequest): Promise<StepRunResult>` 按 `command.type` 分发 shell/prompt/agent/skill/mcp 五路径，失败抛 `SandoreError('STEP_TIMEOUT' | 'STEP_EXECUTION')`。

#### 4.2 branch-evaluator（`branch-evaluator.ts`）

- `export type TempSessionHandle = string`（第 46 行）。
- `export interface BranchEvaluatorConfig`（第 49–53 行）：`{ defaultTimeoutMs; defaultProvider?; defaultModel? }`。
- `export interface BranchEvalOptions`（第 56–71 行）：`{ branches?: readonly DagBranch[]; passThroughVars?: Readonly<Record<string,string>>; loopTurn?; loopMaxIterations?; workdir?; stdin?; signal? }`。
- `export interface BranchEvalResult`（第 74–79 行）：`{ output: string; sessionHandle: TempSessionHandle | null }`。
- `export interface BranchEvalPartial`（第 82–87 行）：`{ sessionHandle: TempSessionHandle | null; outputPromise: Promise<string> }`。
- **`export function extractExpectation(raw: string): string`**（第 151–165 行）：三级解析（JSON `branchExpectation` → regex 回退 → `raw.trim()`）。
- **`export function extractBreakResult(raw: string): string`**（第 173–190 行，public，供 LoopManager 复用）：三级解析 `shouldBreak`（布尔转字符串/字符串 `"true"`/`"false"` 转小写 → regex → `raw.trim()`）。
- **`export function matchesExpectation(result: string, expectation: string): boolean`**（第 201–212 行）：expectation 含 regex 元字符时正则匹配（非法正则返回 false），否则字符串相等。
- **`export class BranchEvaluator`**（第 221 行）：`constructor(ctx, config: BranchEvaluatorConfig)`；`async start(condition, contextMessage, options?)` / `async collect(partial)` / `async evaluate(condition, contextMessage, options?)`。

#### 4.3 loop-manager（`loop-manager.ts`）

- `export type LoopManagerConfig = BranchEvaluatorConfig`（第 21 行）。
- `export interface LoopState`（第 24–27 行）：`{ activeLoopStack: string[]; activeLoopIterationStack: number[] }`（WorkflowTaskState 字段子集）。
- `export interface LoopNode`（第 30–33 行）：`{ id: string; loop?: DagLoop | undefined }`。
- `export interface LoopBreakContext`（第 36–41 行）：`{ input: string; output: string; artifacts?: readonly string[]; passThroughVars?: Readonly<Record<string,string>> }`。
- `export interface LoopBreakOutcome`（第 44–48 行）：`{ shouldBreak: boolean; loopMeta?: BranchMeta }`。
- **`export class LoopManager`**（第 89 行）：
  - `readonly stepIdSuffixMap = new Map<string, string>()`（原始 id → 4 位 hex 后缀）。
  - `constructor(ctx: Context, config: LoopManagerConfig, private readonly state: LoopState)`，内部自建 `BranchEvaluator`。
  - `get activeLoopNodeId(): string | null`（栈顶活跃循环节点 id）。
  - `static loopIdSuffix(): string`（4 位 hex）。
  - **`getActualStepId(originalStepId: string): string`**（返回 `原始id-4位hex`，同迭代同原始 id 复用同后缀）。
  - `stripIdSuffix(id: string): string`。
  - **`buildLoopIterationPath(): number[]`**（返回 `activeLoopIterationStack` 拷贝）。
  - `incrementLoopIteration(): void`（最内层 +1，清后缀映射）。
  - `pushActiveLoop(nodeId, maxIterations)` / `popActiveLoop()`。
  - **`getLoopIterationContext(): { loopTurn: number; loopMaxIterations: number }`**（非循环时均 0）。
  - **`async checkLoopBreak(node: LoopNode, visitCount: number, context?: LoopBreakContext): Promise<LoopBreakOutcome>`**（`visitCount >= maxIterations` 硬上限 → true；`breakCondition` 两阶段评估，shell 走 `matchesExpectation(output.trim(), breakExpectation)`，其余走 `extractBreakResult === 'true'`，写入 `loopMeta`）。

#### 4.4 finalize-manager（`finalize-manager.ts`）

- `export interface FinalizeManagerConfig`（第 39–43 行）：`{ defaultTimeoutMs; defaultProvider?; defaultModel? }`。
- `export interface FinalizeStepContext`（第 46–50 行）：`{ input; output; artifacts?: readonly string[] }`。
- `export interface FinalizeAssessInput`（第 53–59 行）、`export interface FinalizeGateInput`（第 62–69 行）。
- `export interface FinalizeStepRequest`（第 72–85 行）：`{ step; executedStep; stepSessionId?; context; gates?; workdir; passThroughVars?; signal?; onPersist? }`。
- 解析函数：`export function parseAssessResult(raw): AssessParsed`、`export function parsePrimaryGate(raw): PrimaryGateParsed`、`export function parseSecondaryGate(raw): SecondaryGateParsed`。
- `export class FinalizeAssessor`（第 436 行）：`constructor(ctx, config)`；`async assess(input: FinalizeAssessInput): Promise<FinalizeAssessResult>`。
- `export class GateEvaluator`（第 486 行）：`constructor(ctx, config)`；`async evaluate(input: FinalizeGateInput): Promise<GateEvalResult>`。
- **`export class FinalizeManager`**（第 595 行）：`constructor(ctx, config)`；**`async finalizeStep(request: FinalizeStepRequest): Promise<FinalizeOutcome>`**。流程：跳过检查（无未解析透传变量 + 无门禁 → 直接 `{ type:'done', completionType:'completed' }`）→ assess → `completionType==='ask'` 时置 `executedStep.status='interacting'`、persist、返回 `{ type:'ask', assessResult }` → gate 审查 → 未过门禁返回 `{ type:'error', errorDetail, assessResult, gateResult }` → 通过返回 `{ type:'done', completionType:'completed', assessResult, gateResult? }`。persist 通过 `writeBackPassThroughVars` 就地回写 `passThroughVars` + `executedStep.finalizeMeta = buildFinalizeMeta(...)` + `await request.onPersist?.(executedStep)`。
- **`FinalizeOutcome`** 定义在 `workflow/src/types.ts`（第 154–158 行），三态联合：`{ type:'done'; completionType:'completed'; assessResult?; gateResult? } | { type:'ask'; assessResult: FinalizeAssessResult } | { type:'error'; errorDetail: string; assessResult?; gateResult? }`。

#### 4.5 file-utils（`file-utils.ts`）

- 文件系统接缝：`export interface FsTarget`、`FsDirEntry`、`FsWriteOutcome`、`FileSystem`（第 24–51 行），并 `declare module '@deepseek-ai/cordis' { interface Context { fs: FileSystem } }`。
- 透传变量替换：**`export function replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string`**（第 62–67 行，`${xxx}` 已定义替换、未定义保留原文）。
- glob/regex：`export function escapeRegexChar`、`globToRegex`、`isGlobPattern`（第 72–103 行）。
- 文件搜索：`export async function walkDir`、`findFilesByGlob`、`findFilesByRegex`（第 128–155 行）。
- 产物读写：`export interface OutputArtifact`、`StepOutputFile`、`outputJsonFileName`、`writeOutputJson`、`readOutputJson`（第 160–240 行）。
- InputFrom 就近匹配：`export function idMatches(actualId, targetId)`（第 245–247 行，`===` 或 `startsWith(targetId + '-')`，支持循环后缀 id）、`resolvePathSegments(executedSteps, currentIndex, path)`（第 265–297 行，支持 `stg-xxx` / `stg-xxx.step-xxx` / `stg-xxx.step-xxx.opt-xxx` 三级）、**`export function resolveFromInputFrom(executedSteps, currentIndex, inputFromItems: readonly InputFromItem[]): ExecutedStepDefault[]`**（第 306–331 行，`inputFromItems` 为空回退前一条 `executedSteps[currentIndex - 1]`）。

---

### 5. `schema.ts` 关键类型精确形状

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`（派生类型在文件末尾第 380–401 行 `export type ... = z.infer<...>`）。browser-safe 接口版本在 `workflow/src/types.ts`。

**`WorkflowTaskState`**（`WorkflowTaskStateSchema`，第 323–344 行；对应 `types.ts` 未定义接口，直接 `z.infer`）：

```ts
{
  taskId: string; jobId: string; workflowId: string; cwd: string;
  status: 'pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused';  // DagRunStatusSchema
  originalInput: string;
  currentStageId: string;
  executedSteps: ExecutedStepDefault[];          // ExecutedStepDefaultSchema[]
  stageInfos: { id; name; status: StepStatus }[];
  pendingInteractions: unknown[];
  pendingQueue: string[];
  visitCounts: Record<string, number>;           // nodeId → 访问次数
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>;
  activeLoopIterationStack: number[];            // 嵌套迭代路径栈
  activeLoopNodeId: string | null;               // 当前活跃循环节点 id
  activeLoopStack: string[];                     // 活跃循环节点栈
  pausedStepIds: string[];
  stageContracts: Record<string, StageContract>;
  createdAt: string; updatedAt: string;
}
```

（DAG 调度改造相关的四个字段：`activeLoopStack` / `activeLoopIterationStack` / `visitCounts` / `passThroughVars` 均为上述形状。）

**`WorkflowStep`**（`WorkflowStepSchema`，第 134–149 行）：
```ts
{
  id: string; name?: string;
  command?: CommandConfig;                       // 五类型 discriminated union
  inputFrom?: { id: string; path?: string; regex?: string }[];
  outputTo?: { id: string; path?: string; regex?: string }[];
  passThroughVars?: { name; value; description; refresh? }[];
  timeout?: number;                              // 分钟
  next?: string;
  defaultExpectation?: string;
  condition?: CommandConfig;
  branches?: { expectation?; next: string; label? }[];   // DagBranch
  loop?: { breakCondition?; breakExpectation?; next?; maxIterations: number; exitTo? };  // DagLoop
  rules?: string[];
  gates?: Gates;
}
```

**`WorkflowStage`**（`WorkflowStageSchema`，第 152–163 行）：
```ts
{
  id: string; name: string;
  rules?: string[];
  gates?: Gates;
  steps: WorkflowStep[];                         // Stage 内 Step（注释说明 V2 中 stages[].steps 仅含 id + 流控字段，但 schema 实际为完整 WorkflowStep）
  next?: string;
  defaultExpectation?: string;
  condition?: CommandConfig;
  branches?: DagBranch[];
  loop?: DagLoop;
}
```

**`DagLoop`**（`DagLoopSchema`，第 104–110 行）：`{ breakCondition?: CommandConfig; breakExpectation?: string; next?: string; maxIterations: number; exitTo?: string }`。
**`DagBranch`**（`DagBranchSchema`，第 97–101 行）：`{ expectation?: string; next: string; label?: string }`。
**`CommandConfig`**（`CommandConfigSchema`，第 32–65 行）：五变体 discriminated union（agent/prompt/shell/skill/mcp），判别字段 `type`，变体值嵌套在 `value`。
**`ExecutedStepDefault`**（`ExecutedStepDefaultSchema`，第 270–296 行；`types.ts` 第 87–113 行同构接口）：`{ type:'default'; id; stepId?; stageId; name; status: StepStatus; command?; inputFrom?; outputTo?; passThroughVars?; sessionMeta?; finalizeMeta?; visitCount: number; branchMeta?; error?; pausedAt?; resumedAt?; resumePrompt?; sessionMessages?; pauseEntryId?; loopIteration?: number[]; loopMeta?; retryHistory?; parentSessionId?; output?: ContentBlock[] }`。
**`StageContract`**（`StageContractSchema`，第 306–320 行；`types.ts` 第 126–144 行）：`{ stageId; stageName; status: StepStatus; artifacts: { stepId; outputToId; files: string[]; returnPrompt? }[]; passThroughVars: Record<string, {value;description;refresh?}>; contractArtifacts: Record<string,string[]>; completedAt: string; errorDetail? }`。
**`StageInfo`**：`{ id; name; status: StepStatus }`。
**`StepStatus`**（`types.ts` 第 123 行）：`'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'`。
**`DagRunStatus`**（`types.ts` 第 69 行）：`'pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused'`。

---

### 6. `workflow-engine.spec.ts` 测试范式与 `harness()` 构造

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`

**依赖注入（imports）**：`Context`（cordis）、类型 `LlmRuntime`/`SessionStore`/`DomainFacility`、`vitest` 的 `describe/expect/it`；mock 来自 `../tests/mocks/llm.ts`（`FakeLlm`, `textChunks`）、`sessions.ts`（`FakeSessionStore`）、`shell.ts`（`FakeShell`, `successResult`）、`storage-domain.ts`（`MemoryStorageDomain`）；引擎导入 `SandoreEngineRuntime, { SandoreEngineStub }` from `./index.ts`，类型 `SandoreConfig, SandoreEngine, WorkflowTaskState`，`SandorePersistence` from `./persistence.ts`，`ShellExecutor` from `./shell.ts`，`parseWorkflowYaml` from `./yaml-parser.ts`，`SandoreError` from `./errors.ts`。

**`harness()` 构造**（第 143–170 行）——**所有 mock 注入点**：
```ts
async function harness(config: SandoreConfig = {}): Promise<{ ctx; engine; persistence; llm; shell; sessions }> {
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

**mock 形状要点**（`tests/mocks/`）：
- `FakeLlm`：`providers: LlmProviderInfo[]`、`models: Map<string, LlmModelInfo[]>`、`calls: GenerateOptions[]`、`streamHandler`（默认 `textChunks('')`）；`listProviders()`/`listModels(provider)`/`stream(options)`。测试中通过 `llm.providers.push({ id, name })` + `llm.models.set('p', [{ provider, id, name }])` + `llm.streamHandler = () => textChunks('summary')` 注入 provider/model/流；失败用 `textChunks('', { kind:'error', failure:{ message, code } })`。
- `FakeShell`：`requests`/`specs` 数组、`resolveHandler`（默认 `defaultResolve` 补全 workdir/timeoutMs/stdoutMaxBytes）、`runHandler`（默认 `successResult`）；`resolve(request)`/`run(spec)`；`start` 抛 not implemented。`successResult(spec, stdout='')` 返回 `exitCode:0` 结果；失败用 `{ exitCode, signal, timedOut, aborted, timeoutMs: spec.timeoutMs, stdout:{text,truncated}, stderr:{text,truncated} }`。
- `FakeSessionStore`：`create(id?)`（返回 `FakeSession`，按 id 或自增 key 登记）、`get(id)`、`list()`；`FakeSession` 有 `events: Array<{ type; data }>` 与 `append(type, data)`。测试断言双发用 `sessions.get(run.instanceId)?.events.map(e => e.type)`。
- `MemoryStorageDomain`：`open(spec)`/`get(name)`；内部 `MemoryKvTable` 提供 `get/put/delete/update/entries/keys/size`。`SandorePersistence` 插件产出 `ctx.sandorePersistence`，其 `definitions`/`jobs`/`state` 为 KvTable（测试用 `persistence.definitions.put(...)`、`persistence.state.get(...)`、`persistence.state.size`）。

**测试组织范式**：
- 顶层常量 YAML 定义：`linearYaml`（两 Stage shell→prompt）、`multiStepYaml`（单 Stage 多 Step + outputTo/inputFrom）、`twoShellYaml`（第二 Step `false` 失败）。
- `putDefinition(persistence, id, yaml)`：`parseWorkflowYaml(yaml)` 后 `persistence.definitions.put(id, { yaml, name, version, createdAt, updatedAt })`。
- `completedSnapshot(instanceId)`：手工组装完整 `WorkflowTaskState` 快照（供 getState 兜底读回断言）。
- `recordSandoreEvents(ctx)`：注册 8 个 `ctx.on('sandore/*', ...)` 监听器记录 `{ name, args }`。
- `waitForEnd(ctx)`/`waitForAborted(ctx)`/`waitForStepStart(ctx)`：用 `ctx.once('sandore/end'|'sandore/aborted'|'sandore/step-start')` 返回 Promise，作为异步终态信号。
- `describe` 分组：`SandoreEngineRuntime interface`（默认导出 + 8 个未实现方法抛 INVALID_OPERATION）、`SandoreEngineRuntime startInstance`（不存在定义抛错、getState 可读、state 表兜底、NODE_NOT_FOUND）、`SandoreEngineRuntime linear execution`（事件精确顺序断言、多 Step 契约、listener 抛错仍 completed、childId/sessionMeta 合成）、`SandoreEngineRuntime failure`（shell 非零退出、第二步失败保留第一步、prompt error）、`SandoreEngineRuntime abort`（挂起 shell 中止、终态拒绝 abort）。
- 事件顺序断言范式（第 294–320 行）：`expect(records.map(r => r.name)).toEqual([...])` 精确比对全事件序列；双发用 Session `events.map(e => e.type)` 同序比对。
- 状态断言范式：`persistence.state.get(run.instanceId)` 读回快照断言 `status`/`executedSteps`（`stepId`/`status`/`error`/`output`/`sessionMeta`）/`stageInfos`/`stageContracts`。

---

### 附：相关文件绝对路径清单

- `D:/project-code/llm/sandore/packages/sandore/workflow/src/dag-navigator.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/step-runner.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/branch-evaluator.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/loop-manager.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/finalize-manager.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/file-utils.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/internal.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/index.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/index.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/llm.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/sessions.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/shell.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/storage-domain.ts`
