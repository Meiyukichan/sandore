## Exploration Result

> 探索类型：reference（参考材料核实）
> 项目路径：D:/project-code/llm/sandore
> 说明：`furina config show exploration.reference` 返回 `[]`（无配置元素）。因此本探索直接核实 `exploreContent` 中明确指名的源码文件（作为本次改造基线的参考材料）。`experimental.websearch=true`、`experimental.context7=true`，但本次为本地源码现状核实，无需补充在线检索。

### 需求理解（Phase 2）

- **What**：核实 sandore 工作流引擎当前「Stage 级线性执行」的完整现状，包括 DAG 导航器（`dag-navigator.ts`）、Stage 内执行器（`stage-executor.ts`）、引擎主循环（`workflow-engine.ts`）、前五个 feature 产出的五个可复用模块（step-runner / branch-evaluator / loop-manager / finalize-manager / file-utils）、状态 schema（`schema.ts`）与现有端到端测试范式（`workflow-engine.spec.ts`），作为「全量 DAG 调度」改造（`resolveNextNodes`、DAG 调度循环、引擎接入）的精确基线。
- **Boundaries**：`packages/sandore/workflow/src/` 与 `packages/sandore/microflow/src/` 下与调度、执行、状态、测试直接相关的文件；不涉及 YAML 解析、persistence 内部实现、seam 事件声明细节（除非被指名文件直接引用）。
- **Goal**：逐项精确核实现状形状（接口/类型/导出/钩子/传参/测试注入），输出可直接作为后续改造对照的基线事实；不产生任何方案或实现。

---

### (1) `workflow/src/dag-navigator.ts` — DAG 导航器现状

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/dag-navigator.ts`（共 136 行）

**`DagNodeRef` 接口（L13-25）** — Stage/Step 在 DAG 调度层的统一节点视图：

```ts
export interface DagNodeRef {
  readonly kind: 'stage' | 'step';
  readonly stage: WorkflowStage;      // 所属 Stage（始终可用）
  readonly step?: WorkflowStep;        // 仅 kind === 'step' 时存在
  readonly id: string;
  readonly name: string;
  readonly next?: string;              // Stage/Step 级 next 指针
  readonly condition?: CommandConfig;
  readonly branches?: DagBranch[];
  readonly loop?: DagLoop;
}
```

**`WorkflowDagNavigator` 类（L33-136）**：

- 私有状态：
  - `nodeIndex = new Map<string, DagNodeRef>()`（L34）— nodeId → 统一节点视图
  - `stageContracts = new Map<string, StageContract>()`（L35）
  - `stageOrder: readonly string[]`（L36）
  - `currentStageId: string`（L37）
- 构造（L39-43）：`buildNodeIndex(definition)` → `stageOrder = definition.stages.map(s => s.id)` → `currentStageId = stageOrder[0] ?? ''`
- 公开方法：
  - `get currentNodeId(): string`（L46-48）
  - `getStageContracts(): ReadonlyMap<string, StageContract>`（L51-53，返回副本）
  - `getStageContract(stageId): StageContract | undefined`（L56-58）
  - `getContractArtifacts(): Record<string, string[]>`（L61-69，聚合所有已存 contract 的 `contractArtifacts`，同名文件数组合并）
  - `setStageContract(stageId, contract)`（L72-74）
  - `isStageAllDone(stageId): boolean`（L77-79）= `stageContracts.get(stageId)?.status === 'completed'`
  - `tryAdvanceStage(): boolean`（L88-107）
  - `buildNodeIndex(definition)`（private，L109-135）

**`buildNodeIndex` 建立方式（L109-135）**：两层遍历：
- 对每个 Stage：`nodeIndex.set(stage.id, { kind:'stage', stage, id, name, next: stage.next, condition, branches, loop })`
- 对 Stage 内每个 Step：`nodeIndex.set(step.id, { kind:'step', stage, step, id, name: step.name ?? step.id, next: step.next, condition, branches, loop })`

即 nodeIndex 用「同一 Map」同时收纳 stage 节点与 step 节点，key 均为其 `id`。

**`tryAdvanceStage` 现状（L88-107，线性推进）**：
1. 前置条件：`isStageAllDone(currentStageId)` 为 true，否则返回 false；
2. `current = nodeIndex.get(currentStageId)`，要求存在且 `kind === 'stage'`，否则 false；
3. `nextId = current.next`；若 undefined 则回退 `stageOrder[index + 1]`（按定义数组顺序）；
4. `next = nodeIndex.get(nextId)`，要求存在且 `kind === 'stage'`，否则 false；
5. 赋值 `currentStageId = next.id`，返回 true。

**基线要点**：当前无 `resolveNextNodes` 方法（已 grep 全包确认不存在）；无分支/循环调度，`branches`/`loop`/`condition` 字段虽写入 DagNodeRef 但未被任何调度逻辑消费；`visitCounts` 未在导航器中读写。

---

### (2) `microflow/src/stage-executor.ts` — Stage 内执行器现状

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`（共 231 行）

**接口/类型（全部从本文件导出）**：

- `StageExecutionInput`（L27-31）：`{ originalInput: string; contractArtifacts: Record<string, string[]>; passThroughVars: WorkflowTaskState['passThroughVars'] }`
- `PassThroughVarValue`（L34-38）：`{ value: string; description: string; refresh?: boolean }`
- `StageSharedState`（L41-45）：`{ cwd: string; jobId: string; taskId: string }`
- `StageStepHooks`（L48-52）：
  ```ts
  { onStepStart(step, childId); onStepCompleted(step, childId, output: ContentBlock[]); onStepFailed(step, childId, error) }
  ```
- `StageExecutorOptions`（L55-66）：
  ```ts
  { ctx: Context; stageDef: WorkflowStage; workflowDef: WorkflowDefinition;
    input: StageExecutionInput; sharedState: StageSharedState; runnerConfig: StepRunnerConfig;
    signal?: AbortSignal; hooks?: StageStepHooks;
    onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> | void }
  ```
  （注意：`workflowDef` 被构造接收但 `execute()` 内未使用。）
- `StageExecutionResult`（L69-75）：`{ stageContract: StageContract; executedSteps: ExecutedStepDefault[]; passThroughVars: Record<string, PassThroughVarValue>; status: StepStatus; errorDetail?: string }`

**内部函数**：

- `synthesizeChildId(stepId)`（L78-81）：返回 `step-{stepId}-{8 位 hex}`，hex = `crypto.randomUUID().replace(/-/g,'').slice(0,8)`
- `collectPassThroughVars(stageDef)`（L84-92）：遍历 `stageDef.steps[].passThroughVars`，按 `name` 收集为 `Record<string, PassThroughVarValue>`（后写覆盖先写）
- `toPassThroughValue(passThroughVar)`（L95-101）：`{ value, description, ...(refresh !== undefined ? { refresh } : {}) }`
- `toPreviousOutput(step)`（L104-111）：`{ name: step.name, id: step.stepId ?? step.id, returnPrompt: textSummary(step.output), files: [] }`
- `finalizeStageContract(stageDef, executedSteps, status, passThroughVars, errorDetail)`（L114-143）：遍历 executedSteps 的 `outputTo` 组装 `artifacts`（`stepId = step.stepId ?? step.id`、`outputToId`、`files: []`、非空时附 `returnPrompt: textSummary(step.output)`）；返回 `{ stageId, stageName, status, artifacts, passThroughVars, contractArtifacts: {}, completedAt: ISO, ...(errorDetail?{errorDetail}) }`。**`contractArtifacts` 恒为空对象 `{}`**。

**`StageExecutor` 类（L151-231）**：

- 构造：`this.runner = new StepRunner(options.ctx, options.runnerConfig)`
- `async execute(): Promise<StageExecutionResult>`（L159-230），**线性 `for (const step of stageDef.steps)` 循环**（L166）：
  1. `childId = synthesizeChildId(step.id)`
  2. 构造 `ExecutedStepDefault`（L169-184）：`type:'default'`, `id: childId`, `stepId: step.id`, `stageId`, `name: step.name ?? step.id`, `status:'running'`；条件附 `command/inputFrom/outputTo/passThroughVars`；当 `command !== undefined` 附 `sessionMeta: { childId, synthetic: true, command: command.type }`；`visitCount: 1`（恒为 1）
  3. `hooks?.onStepStart(step, childId)`
  4. `command === undefined` 分支：置 failed + `error`，push，`onStepFailed`，`onPersist`，`status='failed'`、`errorDetail`，`break`
  5. `try`：`result = await this.runner.run({ step, workdir: sharedState.cwd, originalInput, previousOutputs, ...(signal?{signal}) })`；成功后 `executed.status='completed'`、`executed.output = result.output`，push，`previousOutputs.push(toPreviousOutput(executed))`，`onStepCompleted`，`onPersist`
  6. `catch`：`describeError`，置 failed + error，push，`onStepFailed`，`onPersist`，`status='failed'`、`errorDetail`，`break`
  7. 循环后：`passThroughVars = collectPassThroughVars(stageDef)`，`stageContract = finalizeStageContract(...)`，返回结果

**关键基线事实**：
- `execute()` 无分支/循环/并发；`visitCount` 硬编码 1；`sessionMeta.synthetic` 恒为 true（见下条）。
- **`StepRunner.run()` 返回的 `StepRunResult.sessionMeta`（真实 childId、`synthetic:false`）在 `StageExecutor.execute()` 中被忽略** —— 仅消费 `result.output`（L208-209），`ExecutedStepDefault.sessionMeta` 由执行器自造（synthetic:true + 合成 childId）。这是「agent/skill/mcp 真实会话 id 未透传」的现状。
- `onPersist` 钩子在每个 Step 完成/失败后调用一次（含 `command === undefined` 分支），未在 Stage 级再调用。

---

### (3) `workflow/src/workflow-engine.ts` — 引擎运行时现状

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`（共 470 行）

**结构**：
- `interface ActiveInstance`（L42-47）：`{ controller: AbortController; session: Session; definition: WorkflowDefinition; state: WorkflowTaskState }`
- `TERMINAL_STATUSES`（L50）
- 工具函数：`renderError`、`now`、`makeInstanceId`、`makeInitialState`、`toDagInstanceState`
- `export default class SandoreEngineRuntime extends SandoreEngine`（L130）

**`makeInitialState`（L73-103）** 产出完整 `WorkflowTaskState`，关键字段初值：
- `currentStageId = definition.stages[0]?.id ?? ''`
- `executedSteps: []`、`stageInfos = stages.map(s => ({id,name,status:'blocked'}))`
- `visitCounts: {}`、`passThroughVars: {}`、`activeLoopIterationStack: []`、`activeLoopNodeId: null`、`activeLoopStack: []`、`pausedStepIds: []`、`stageContracts: {}`
- `pendingInteractions: []`、`pendingQueue: []`

**`runInstance(active)` — Stage 主循环（L255-373）**：
1. `active.state.status='running'` → `persistState` → `emitStart`
2. `const navigator = new WorkflowDagNavigator(definition)`；`let stageId = navigator.currentNodeId`
3. `while (stageId !== '')`：
   - `stage = definition.stages.find(s => s.id === stageId)`（找不到 break）
   - `markStageStatus(active, stageId, 'running')` → `persistState` → `emitStageStart`
   - 构造 `hooks: StageStepHooks`（L281-285）：三回调分别转调 `emitStepStart/emitStepCompleted/emitStepFailed`
   - 构造 `new StageExecutor({...})`（L287-317），传参：
     - `ctx: this.ctx`、`stageDef: stage`、`workflowDef: definition`
     - `input: { originalInput: active.state.originalInput, contractArtifacts: navigator.getContractArtifacts(), passThroughVars: active.state.passThroughVars }`
     - `sharedState: { cwd: active.state.cwd, jobId, taskId }`
     - `runnerConfig: this.runnerConfig()`、`signal`、`hooks`
     - `onPersist`（L304-316）：把 `executed` 追加到 `active.state.executedSteps`（`as unknown as ...` 强转）并 `persistState`
   - `const result = await executor.execute()`
   - 合并透传变量（L322-326）：`passThroughVars: { ...state.passThroughVars, ...result.passThroughVars }`
   - 失败路径（L328-350）：`markStageStatus failed`；若 `signal.aborted` → aborted 终态 + `emitAborted`；否则 failed 终态 + 写 `stageContracts[stageId]` + `emitEnd(failed, error?)`；`return`
   - 成功路径（L352-361）：`markStageStatus completed`、`navigator.setStageContract(stageId, result.stageContract)`、`currentStageId = stageId`、合并 `stageContracts[stageId]`、`persistState`、`emitStageCompleted`
   - 推进（L363-367）：`if (!navigator.tryAdvanceStage()) stageId=''; else stageId = navigator.currentNodeId`
4. 循环退出后：`status='completed'` → `persistState` → `emitEnd(completed)`

**辅助方法**：
- `markStageStatus(active, stageId, status)`（L377-382）：map 更新 `stageInfos` 对应项 status
- `runnerConfig(): StepRunnerConfig`（L384-390）：`{ defaultTimeoutMs: config.defaultTimeoutMs ?? 7200000, ...(defaultProvider?{defaultProvider}), ...(defaultModel?{defaultModel}) }`
- `persistence()`（L392-394）：`this.ctx.get('sandorePersistence')`
- `persistState(active)`（L396-406）：`persistence.saveWorkflowState(active.state)`，catch 记 warn

**事件双发（L410-469）**：每个事件两条通道：
- `emitContained(name, args)`（L410-421）：`this.ctx.events.dispatch('emit', [name, ...args])`，逐 listener try/catch（`ctx.emit` 通道）
- `safeAppend(fn)`（L423-429）：`session.append(name, data)`（宿主 Session 通道，try/catch）
- 具体事件：`emitStart`（`sandore/start`）、`emitStageStart`（`sandore/stage-start`）、`emitStageCompleted`（`sandore/stage-completed`）、`emitStepStart`（`sandore/step-start`）、`emitStepCompleted`（`sandore/step-completed`）、`emitStepFailed`（`sandore/step-failed`）、`emitEnd`（`sandore/end`）、`emitAborted`（`sandore/aborted`）

**StepRunResult 消费位置**：`StepRunner.run()` 返回的 `StepRunResult` 仅在 `stage-executor.ts` 内被消费（`result.output`）；引擎 `runInstance` 不直接接触 `StepRunResult`，只消费 `StageExecutor.execute()` 返回的 `StageExecutionResult`（`result.status`、`result.stageContract`、`result.passThroughVars`、`result.errorDetail`）。

**8 个未实现方法**（L196-226）：`recoverInstance/replyQuestion/replyPermission/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps/retryStep` 均抛 `SandoreError('... is not implemented', 'INVALID_OPERATION')`。

**基线要点**：主循环为「单 Stage 串行」；无分支/循环/并发调度；`visitCounts`、`activeLoopStack`、`activeLoopIterationStack`、`activeLoopNodeId` 仅在 `makeInitialState` 中初始化为空，未参与任何调度逻辑。

---

### (4) 前五个 feature 产出的可复用模块精确导出

#### 4.1 `microflow/src/step-runner.ts` — StepRunner / StepRunResult / StepRunSessionMeta

- `StepRunResult`（L96-99）：`{ output: ContentBlock[]; sessionMeta?: StepRunSessionMeta }`
- `StepRunSessionMeta`（L89-93）：`{ childId?: string; synthetic: boolean; command: CommandConfig['type'] }`
- **现状**：`runShell`（L311-387）与 `runPrompt`（L394-427）成功时只返回 `{ output }`（无 sessionMeta）；`runSubagent`（L429-463）返回 `{ output, sessionMeta: { childId: started.childId, synthetic: false, command: command.type } }`。即真实 childId 仅在 agent/skill/mcp 路径产生，且（见第 2 节）StageExecutor 当前丢弃它。
- 其他导出：`StepRunnerConfig`（L51-63，含 defaultTimeoutMs/defaultProvider?/defaultModel?/skills?/mcps?/agents?/hostAgent?）、`PreviousStepOutput`（L66-71）、`StepRunRequest`（L74-86，含 passThroughVars?/loopTurn?/loopMaxIterations?）、`StepRunner` 类（`run(request)`）。

#### 4.2 `microflow/src/branch-evaluator.ts` — BranchEvaluator / extractExpectation / matchesExpectation

- `BranchEvaluator` 类（L221-395）：构造 `(ctx, config: BranchEvaluatorConfig)`；方法：
  - `start(condition: CommandConfig, contextMessage, options?: BranchEvalOptions): Promise<BranchEvalPartial>`（L228-244）
  - `collect(partial): Promise<BranchEvalResult>`（L247-250）
  - `evaluate(condition, contextMessage, options?): Promise<BranchEvalResult>`（L253-256，一步完成）
- `extractExpectation(raw: string): string`（L151-165）：三级解析 ① JSON `branchExpectation` ② regex `/"branchExpectation"\s*:\s*"([^"]+)"/` ③ `raw.trim()`
- `matchesExpectation(result: string, expectation: string): boolean`（L201-212）：expectation 含 regex 元字符则正则匹配（非法 regex 返回 false），否则字符串相等
- 另有 public `extractBreakResult(raw: string): string`（L173-190，供 LoopManager 复用）
- 相关类型：`BranchEvaluatorConfig`（L49-53）、`BranchEvalOptions`（L56-71，含 branches?/passThroughVars?/loopTurn?/loopMaxIterations?/workdir?/stdin?/signal?）、`BranchEvalResult`（L74-79）、`BranchEvalPartial`（L82-87）

#### 4.3 `microflow/src/loop-manager.ts` — LoopManager / checkLoopBreak / getActualStepId / buildLoopIterationPath / getLoopIterationContext

- `LoopManager` 类（L89-229）：构造 `(ctx, config: LoopManagerConfig, state: LoopState)`；内部自建 `BranchEvaluator`。
  - `get activeLoopNodeId(): string | null`（L105-107，栈顶活跃循环节点 id）
  - `static loopIdSuffix(): string`（L110-112，4 位 hex）
  - `getActualStepId(originalStepId): string`（L115-123，返回 `原始id-4位hex`，同迭代同原始 id 复用后缀，写入 `stepIdSuffixMap`）
  - `stripIdSuffix(id): string`（L126-133）
  - `buildLoopIterationPath(): number[]`（L136-138，返回 `activeLoopIterationStack` 副本）
  - `incrementLoopIteration()`（L141-147）、`pushActiveLoop(nodeId, maxIterations)`（L150-155）、`popActiveLoop()`（L158-162）
  - `getLoopIterationContext(): { loopTurn: number; loopMaxIterations: number }`（L165-169，非循环时 0/0）
  - `checkLoopBreak(node: LoopNode, visitCount: number, context?: LoopBreakContext): Promise<LoopBreakOutcome>`（L179-207）：`visitCount >= loop.maxIterations` 硬上限直接 true；否则 `breakCondition` 两阶段评估（agent/prompt/skill/mcp 走 `extractBreakResult === 'true'`；shell 走 `matchesExpectation(breakResult, breakExpectation)`），写入 `loopMeta`
  - `readonly stepIdSuffixMap = new Map<string, string>()`（L91）
- 相关类型：`LoopManagerConfig = BranchEvaluatorConfig`（L21）、`LoopState`（L24-27，`{ activeLoopStack: string[]; activeLoopIterationStack: number[] }`）、`LoopNode`（L30-33）、`LoopBreakContext`（L36-41）、`LoopBreakOutcome`（L44-48）

#### 4.4 `microflow/src/finalize-manager.ts` — FinalizeManager / finalizeStep / FinalizeOutcome

- `FinalizeManager` 类（L595-665）：构造 `(ctx, config: FinalizeManagerConfig)`；方法 `finalizeStep(request: FinalizeStepRequest): Promise<FinalizeOutcome>`（L608-664）
- `FinalizeOutcome`（定义在 `workflow/src/types.ts` L155-158，**非 finalize-manager 导出**）三态联合：
  ```ts
  type FinalizeOutcome =
    | { type: 'done'; completionType: 'completed'; assessResult?; gateResult? }
    | { type: 'ask'; assessResult: FinalizeAssessResult }
    | { type: 'error'; errorDetail: string; assessResult?; gateResult? }
  ```
- 相关导出：`FinalizeManagerConfig`（L39-43，`{ defaultTimeoutMs; defaultProvider?; defaultModel? }`）、`FinalizeStepContext`（L46-50）、`FinalizeAssessInput`（L53-59）、`FinalizeGateInput`（L62-69）、`FinalizeStepRequest`（L72-85，含 step/executedStep/stepSessionId?/context/gates?/workdir/passThroughVars?/signal?/onPersist?）、`FinalizeAssessor`（L436-475）、`GateEvaluator`（L486-586）、`parseAssessResult`（L292-305）、`parsePrimaryGate`（L308-316）、`parseSecondaryGate`（L319-327）

#### 4.5 `microflow/src/file-utils.ts` — resolveFromInputFrom / replacePassThroughVars

- `resolveFromInputFrom(executedSteps: readonly ExecutedStepDefault[], currentIndex: number, inputFromItems: readonly InputFromItem[]): ExecutedStepDefault[]`（L306-331）：
  - `inputFromItems` 为空 → 回退前一条（`executedSteps[currentIndex - 1]`）
  - 每项 `path` 走 `resolvePathSegments`（支持 `stg-xxx` / `stg-xxx.step-xxx` / `stg-xxx.step-xxx.opt-xxx` 三级，倒序最近优先，`idMatches` 支持循环后缀 id）；`regex` 遍历全部 step 输出文本（`textSummary`）正则匹配（倒序最近优先）
- `replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string`（L62-67）：`/\$\{([^}]+)\}/g` 替换，已定义替换为值，未定义保留原文
- 相关导出：`idMatches(actualId, targetId)`（L245-247，`===` 或 `startsWith('${targetId}-')`）、`resolvePathSegments`（L265-297）、`globToRegex`/`escapeRegexChar`/`isGlobPattern`/`walkDir`/`findFilesByGlob`/`findFilesByRegex`/`writeOutputJson`/`readOutputJson`、`FileSystem` 结构接缝（L45-51）

---

### (5) `workflow/src/schema.ts` — 精确形状

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

**`WorkflowTaskStateSchema`（L323-344）/ `WorkflowTaskState`** 精确字段：

| 字段 | 类型 |
|---|---|
| `taskId` | `string` |
| `jobId` | `string` |
| `workflowId` | `string` |
| `cwd` | `string` |
| `status` | `DagRunStatus`（`'pending'\|'running'\|'interacting'\|'completed'\|'failed'\|'aborted'\|'paused'`）|
| `originalInput` | `string` |
| `currentStageId` | `string` |
| `executedSteps` | `ExecutedStepDefault[]` |
| `stageInfos` | `StageInfo[]`（`{ id; name; status: StepStatus }`）|
| `pendingInteractions` | `unknown[]` |
| `pendingQueue` | `string[]` |
| **`visitCounts`** | `Record<string, number>`（z.record）|
| `passThroughVars` | `Record<string, PassThroughVarValue>`（`{ value; description; refresh? }`）|
| **`activeLoopIterationStack`** | `number[]` |
| `activeLoopNodeId` | `string \| null` |
| **`activeLoopStack`** | `string[]` |
| `pausedStepIds` | `string[]` |
| `stageContracts` | `Record<string, StageContract>` |
| `createdAt` / `updatedAt` | `string` |

**`WorkflowStepSchema`（L134-149）/ `WorkflowStep`** 字段：`id`(必填), `name?`, `command?: CommandConfig`, `inputFrom?: InputFromItem[]`, `outputTo?: OutputToItem[]`, `passThroughVars?: PassThroughVar[]`(`{name,value,description,refresh?}`), `timeout?: number`, `next?: string`, `defaultExpectation?: string`, `condition?: CommandConfig`, `branches?: DagBranch[]`, `loop?: DagLoop`, `rules?: string[]`, `gates?: Gates`

**`WorkflowStageSchema`（L152-163）/ `WorkflowStage`** 字段：`id`(必填), `name`(必填), `rules?`, `gates?`, `steps: WorkflowStep[]`(必填), `next?: string`, `defaultExpectation?: string`, `condition?: CommandConfig`, `branches?: DagBranch[]`, `loop?: DagLoop`

**`DagBranchSchema`（L97-101）**：`{ expectation?: string; next: string; label?: string }`（省略 `expectation` 表示并行分支）
**`DagLoopSchema`（L104-110）**：`{ breakCondition?: CommandConfig; breakExpectation?: string; next?: string; maxIterations: number; exitTo?: string }`
**`CommandConfigSchema`（L32-65）**：5 类型 discriminated union（`agent`/`prompt`/`shell`/`skill`/`mcp`），判别字段 `type`，变体字段嵌套于 `value`
**`ExecutedStepDefaultSchema`（L270-296）**：`type:'default'`, `id`, `stepId?`, `stageId`, `name`, `status: StepStatus`, `command?`, `inputFrom?`, `outputTo?`, `passThroughVars?`, `sessionMeta?: StepSessionMeta`(`{childId,synthetic,command}`), `finalizeMeta?`, `visitCount: number`, `branchMeta?`, `error?`, `pausedAt?`, `resumedAt?`, `resumePrompt?`, `sessionMessages?`, `pauseEntryId?`, `loopIteration?: number[]`, `loopMeta?`, `retryHistory?`, `parentSessionId?`, `output?: ContentBlock[]`

> 说明：`DagNodeRef` 的精确形状见第 (1) 节（定义于 `dag-navigator.ts`，不在 `schema.ts`）。

---

### (6) `workflow/src/workflow-engine.spec.ts` — 测试范式与 harness() 构造

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`（共 523 行）

**导入与 mock 来源**：
- `../tests/mocks/llm.ts` → `FakeLlm`, `textChunks`
- `../tests/mocks/sessions.ts` → `FakeSessionStore`
- `../tests/mocks/shell.ts` → `FakeShell`, `successResult`
- `../tests/mocks/storage-domain.ts` → `MemoryStorageDomain`
- 引擎入口：`import SandoreEngineRuntime, { SandoreEngineStub } from './index.ts'`；`SandorePersistence` 来自 `./persistence.ts`；`parseWorkflowYaml` 来自 `./yaml-parser.ts`

**`harness()` 构造（L143-170）** — 全部 mock 注入：
```ts
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
```
注入清单：`storageDomain`、`llm`、`shell`、`sessions`、`sessionPersistence`(`{}`)、`subagents`(`{}`)、`fs`(`{}`)；插件顺序 `SandorePersistence` → `SandoreEngineRuntime(config)`。

**Mock 行为要点**：
- `FakeLlm`（llm.ts）：`providers: LlmProviderInfo[]`、`models: Map<string, LlmModelInfo[]>`、`streamHandler: (options) => AsyncIterable<StreamChunk>`；`textChunks(text, reason?)` 生成单 text block 固定 chunk 流（含 block-start/text-delta/block-end/finish）。测试中先 `llm.providers.push({id:'p',name:'Provider'})`、`llm.models.set('p',[{provider:'p',id:'m',name:'Model'}])`、`llm.streamHandler = () => textChunks('summary')`
- `FakeShell`（shell.ts）：`runHandler`/`resolveHandler` 可注入；`successResult(spec, stdout)` 返回 exitCode 0；`FakeShell.start` 未实现抛错
- `FakeSessionStore`（sessions.ts）：`create/get/list`；`FakeSession.events` 记录 `append(type, data)`

**测试辅助函数**：
- `putDefinition(persistence, id, yaml)`（L94-104）：parse 后 `persistence.definitions.put`
- `completedSnapshot(instanceId)`（L107-140）：组装完整 `WorkflowTaskState` 快照（含全部字段初值，供 getState 兜底读回）
- `recordSandoreEvents(ctx)`（L173-184）：注册全部 8 个 `sandore/*` listener 记录 `{name, args}`
- `waitForEnd`/`waitForAborted`/`waitForStepStart`（L187-205）：以 `ctx.once('sandore/end' | 'sandore/aborted' | 'sandore/step-start')` 为信号

**YAML 夹具（内联字符串）**：
- `linearYaml`（L24-45）：两 Stage（shell → prompt，`next: stg-2`）
- `multiStepYaml`（L48-71）：单 Stage 多 Step（A outputTo、B inputFrom 引用 `stg-1.step-a.opt-a`）
- `twoShellYaml`（L74-91）：单 Stage 两 shell Step（用于第二步失败断言）

**测试范式要点**：
- 事件序断言用 `records.map(r => r.name)` 与期望数组严格相等（如 L294-305）；Session 双发断言用 `session.events.map(e => e.type)` 与同一数组相等（L309-320）
- childId/sessionMeta 断言：`executedSteps[0].sessionMeta.childId` 匹配 `/^step-step-abc-[0-9a-f]{8}$/`、`synthetic === true`、`command === 'shell'/'prompt'`（L395-399）
- 失败/中止断言：`persistence.state.get(instanceId)` 读回终态快照；abort 用「挂起 runHandler + signal.addEventListener('abort')」模拟
- 当前测试**仅覆盖线性执行**，无 DAG 分支/循环/并发端到端用例。

---

## Supplementary Exploration Result

无。本次为本地源码现状核实，`exploration.reference` 配置为空、内容均已由上述本地文件覆盖，无需 websearch/context7 补充检索。
