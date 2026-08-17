# 探索结果

> 需求背景（仅供定位技术上下文，不做方案/可行性分析）：为 sandore 的 6 个 `step-*` Session 事件 payload 补 `name`/`loopIteration`。
> 探索范围：`packages/sandore/workflow/src/workflow-engine.ts`、`seam.ts`、`types.ts`、`schema.ts`、`workflow-engine.spec.ts`，以及 `packages/sandore/microflow/src/stage-executor.ts`、`loop-manager.ts`、`dag-navigator.ts`、`step-runner.ts`，`packages/sandore/workflow/src/lifecycle-manager.ts`、`recovery-manager.ts` 及其 spec。

## 1. workflow-engine.ts 六个 emit 函数签名 + safeAppend payload + 调用点闭包可用信息

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`

### 六个 emit 函数当前签名与 payload 形状

| 函数 | 签名 | emitContained 参数 | safeAppend payload |
|---|---|---|---|
| `emitStepStart` | `(session, info, stepId, childId)` | `[info, stepId, childId]` | `{ stepId, childId }` |
| `emitStepCompleted` | `(session, info, stepId, childId, output)` | `[info, stepId, childId, output]` | `{ stepId, childId, output }` |
| `emitStepFailed` | `(session, info, stepId, childId, error)` | `[info, stepId, childId, error]` | `{ stepId, childId, error }` |
| `emitStepPaused` | `(session, active, stepId, childId)` | `[info, stepId, childId]` | `{ stepId, childId }` |
| `emitStepResumed` | `(session, active, stepId, childId, resumePrompt?)` | `[info, stepId, childId, resumePrompt]` | `{ stepId, childId, resumePrompt? }` |
| `emitStepRetried` | `(session, active, stepId, mode)` | `[info, stepId, mode]` | `{ stepId, mode }` |

关键差异：
- `emitStepStart`/`emitStepCompleted`/`emitStepFailed` 的第二个参数是 `DagRunInfo info`（在 `runInstance` 顶部一次性构造）。
- `emitStepPaused`/`emitStepResumed`/`emitStepRetried` 的第二个参数是 `ActiveInstance active`，函数内部从 `active.state` 现构造 `info`（`taskId`/`workflowId`/`jobId`）。这意味着这三个 emit 函数体内**已经能访问 `active.state`**（含 `executedSteps`、`activeLoopIterationStack`）与 `active.definition`（含 Step 定义）。

位置：`emitStepStart` L929-932、`emitStepCompleted` L934-937、`emitStepFailed` L939-942、`emitStepPaused` L944-952、`emitStepResumed` L954-962、`emitStepRetried` L964-972。`safeAppend` 定义在 L906-912（包裹 `session.append` 并捕获异常）。

### 调用点闭包内是否有 step 定义 name 与 loop 迭代路径

**A. `onStepStart`/`onStepCompleted`/`onStepFailed`（StageExecutor hooks，`runInstance` L497-501）**
```ts
const hooks: StageStepHooks = {
  onStepStart: (step, childId) => this.emitStepStart(session, info, step.id, childId),
  onStepCompleted: (step, childId, output) => this.emitStepCompleted(session, info, step.id, childId, output),
  onStepFailed: (step, childId, error) => this.emitStepFailed(session, info, step.id, childId, error),
};
```
- `step` 的类型是 `WorkflowStep`（`StageStepHooks` 定义于 `stage-executor.ts` L52-56），含 `id: string` 与 `name?: string`（schema 中 `name: z.string().optional()`）。**`step.name` 在闭包内可用**，当前仅传了 `step.id`。
- loop 迭代路径：`runInstance(active, ...)` 的闭包作用域内有 `active`（函数参数）与 `loopManager`（L483 `const loopManager = navigator.loopManagerInstance;`，定义在 hooks 之前）。二者都能取到当前迭代路径：
  - `loopManager.buildLoopIterationPath()`（返回 `[...activeLoopIterationStack]` 拷贝，`loop-manager.ts` L136-138）
  - `active.state.activeLoopIterationStack`（`WorkflowTaskState` 持久化字段，schema L377）
  故 **loop 迭代路径在闭包内可用**，当前未传入。

**B. `emitStepPaused`/`emitStepResumed`（LifecycleManager 注入回调，`buildActiveInstance` L746-747）**
```ts
emitStepPaused: (stepId, childId) => this.emitStepPaused(session, active, stepId, childId),
emitStepResumed: (stepId, childId, resumePrompt) => this.emitStepResumed(session, active, stepId, childId, resumePrompt),
```
- 注入回调签名仅含 `stepId`/`childId`(/`resumePrompt`)，**不含 name/loopIteration**。
- 调用方（`lifecycle-manager.ts`）`pauseStep` L121 与 `resumeStep` L141 处的局部变量 `step` 是 `ExecutedStep`（`executedSteps` 元素），其上 `name`、`loopIteration` 均可用，但仅把 `stepIdOf(step)`/`childId` 传给回调。
- 引擎侧 `emitStepPaused`/`emitStepResumed` 函数体有 `active`，可经 `active.state.executedSteps`（该 Step 已含 `name`/`loopIteration`）、`active.state.activeLoopIterationStack` 或 `active.definition.stages[].steps[]` 反查。

**C. `emitStepRetried`（RecoveryManager 注入回调，`buildActiveInstance` L771）**
```ts
emitStepRetried: (stepId, mode) => this.emitStepRetried(session, active, stepId, mode),
```
- 注入回调签名仅含 `stepId`/`mode`，**不含 name/loopIteration**。
- 调用方（`recovery-manager.ts`）`retryStep` L165 处局部 `step` 是 `ExecutedStep`（含 `name`/`loopIteration`），仅把 `stepIdOf(step)`/`mode` 传给回调。
- 引擎侧 `emitStepRetried` 函数体有 `active`，同样可经 `active.state.executedSteps` 反查该 Step 的 `name`/`loopIteration`。

## 2. seam.ts 的 Cordis Events 与 SessionEventMap 双声明当前 payload 类型

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`

Cordis `Events`（`declare module '@deepseek-ai/cordis'`，L38-43）：
```ts
'sandore/step-start'(info: DagRunInfo, stepId: string, childId: string): void;
'sandore/step-completed'(info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[]): void;
'sandore/step-failed'(info: DagRunInfo, stepId: string, childId: string, error: string): void;
'sandore/step-paused'(info: DagRunInfo, stepId: string, childId: string): void;
'sandore/step-resumed'(info: DagRunInfo, stepId: string, childId: string, resumePrompt?: string): void;
'sandore/step-retried'(info: DagRunInfo, stepId: string, mode: string): void;
```

Session `SessionEventMap`（`declare module '@deepseek-ai/dsh-session/types'`，L56-61）：
```ts
'sandore/step-start': { stepId: string; childId: string };
'sandore/step-completed': { stepId: string; childId: string; output: ContentBlock[] };
'sandore/step-failed': { stepId: string; childId: string; error: string };
'sandore/step-paused': { stepId: string; childId: string };
'sandore/step-resumed': { stepId: string; childId: string; resumePrompt?: string };
'sandore/step-retried': { stepId: string; mode: string };
```
现状：两处 payload 均**无 `name`/`loopIteration` 字段**。注意 `step-retried` 的 `mode` 在两处都声明为 `string`（而 `emitStepRetried` 实参类型是 `RetryMode` = `'continue' | 'revert' | 'fork'`）。

## 3. loop 迭代路径在引擎里的来源

- 持久化字段：`WorkflowTaskState` 含 `activeLoopIterationStack: z.array(z.number())`、`activeLoopNodeId: z.string().nullable()`、`activeLoopStack: z.array(z.string())`（schema.ts L377-379），初始为空（`makeInitialState`，workflow-engine.ts L129-131）。
- `LoopManager`（`microflow/src/loop-manager.ts`）：
  - 持有 `LoopState { activeLoopStack: string[]; activeLoopIterationStack: number[] }`（L24-27）。
  - `buildLoopIterationPath(): number[]` 返回 `[...this.state.activeLoopIterationStack]`（L136-138）。
  - `getActualStepId(originalStepId)` 生成 `原始id-4位hex` 后缀 id（L115-123）。
  - `pushActiveLoop`/`popActiveLoop`/`incrementLoopIteration` 维护栈（L150-162）；`getLoopIterationContext()` 返回 `loopTurn`/`loopMaxIterations`（L165-169）。
- 引擎接线（workflow-engine.ts `runInstance` L476-483）：
  ```ts
  const navigator = new WorkflowDagNavigator(
    definition, this.ctx, runnerConfig,
    { activeLoopStack: active.state.activeLoopStack, activeLoopIterationStack: active.state.activeLoopIterationStack },
    { currentStageId: this.resumeStageId(active), stageContracts: active.state.stageContracts },
  );
  const loopManager = navigator.loopManagerInstance;
  ```
  `WorkflowDagNavigator` 构造器内 `this.loopManager = new LoopManager(ctx, config, loopState)`（dag-navigator.ts L94），`loopState` 的两个数组与 `active.state` 是同一引用；`loopManagerInstance` getter（L108-110）暴露给引擎。
- 循环迭代写入 Step 的位置（stage-executor.ts `processCommandNode` L440-463）：
  ```ts
  const inLoop = loopManager.buildLoopIterationPath().length > 0;
  const childId = inLoop ? loopManager.getActualStepId(step.id) : synthesizeChildId(step.id);
  const executed: ExecutedStepDefault = { ... name: step.name ?? step.id, ...,
    ...(inLoop ? { loopIteration: loopManager.buildLoopIterationPath() } : {}), };
  hooks?.onStepStart(step, childId);
  ```
  `onStepStart` 在 `loopIteration` 计算之后调用，因此触发 hook 时 `loopManager.buildLoopIterationPath()` 已是当前迭代路径。
- 结论：引擎内没有名为 `buildLoopIterationPath` 的独立函数，该函数在 `LoopManager` 上；`activeLoopIterationStack` 是其底层持久化来源，两者内容同步。

## 4. 既有测试对 step 事件的断言现状

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`

- `recordSandoreEvents`（L455-466）只注册 `sandore/start`/`stage-start`/`stage-completed`/`step-start`/`step-completed`/`step-failed`/`end`/`aborted`，**未注册 `step-paused`/`step-resumed`/`step-retried`**。
- 线性执行用例（L597-654）：断言完整事件名顺序（含 `step-start`/`step-completed`）；对 step 事件只做了：
  - `records.find(r => r.name === 'sandore/step-completed' && r.args[1] === 'step-prompt')`，再断言 `args[3]` 为 output（L640-641）。
  - 未断言 `args[0]`(info) 之外的 `name`/`loopIteration`。
- 失败用例（L742）：仅 `expect(records.some(r => r.name === 'sandore/step-failed')).toBe(true)`，无 payload 字段断言。
- DAG 用例（L918-920）：`records.find(r => r.name === 'sandore/step-completed' && r.args[1] === 'step-agent')`，断言 `args[2]`(childId) 与 `args[3]`(output)。
- 重试用例（L1313-1329）：内联 `ctx.on('sandore/step-retried', (_info, stepId, mode) => retried.push({ stepId, mode }))`，断言 `retried` 等于 `[{ stepId: 'step-agent', mode: 'continue' }]`，并断言宿主 Session events 含 `sandore/step-retried`。
- 全文件对 step 事件**无任何 `name`/`loopIteration` 断言**。

相邻 spec（同为 6 事件的断言现状，直接相关）：
- `lifecycle-manager.spec.ts`：`recordSandoreEvents` 注册 `step-paused`/`step-resumed`（L135-136）；`step-paused` 断言 `args[1]`(stepId)=`'step-agent'`、`args[2]`(childId)=`'child-1'`（L253-255）；`step-resumed` 断言 `args[1]`/`args[2]`/`args[3]`(resumePrompt)（L398-401）。均无 `name`/`loopIteration` 断言。
- `recovery-manager.spec.ts`：`retried` 数组断言 `toEqual([{ stepId: 'step-1', mode: 'continue' }])`（L225），无 `name`/`loopIteration`。

## 5. types.ts / schema.ts 中 ExecutedStepDefault 的 name 与 loopIteration 字段

- `types.ts` `ExecutedStepDefault`（interface，L129-155）：
  - `name: string`（L134，必填）
  - `loopIteration?: number[]`（L150，可选）
- `schema.ts` `ExecutedStepDefaultSchema`（zod，L310-336）：
  - `name: z.string()`（L315，必填）
  - `loopIteration: z.array(z.number()).optional()`（L331，可选）
- 补充：Step 定义侧 `WorkflowStepSchema` 的 `name: z.string().optional()`（schema.ts L136）为可选；stage-executor 落盘时以 `name: step.name ?? step.id` 回退（stage-executor.ts L410/427/449）。

## 补充探索结果

`reference materials configuration` 为空（`furina config show exploration.reference` 返回 `[]`），本次全部基于项目实际代码探索。`experimental.websearch=true`、`experimental.context7=true`，但因源码信息已充分覆盖探索目标，无需补充联网检索。
