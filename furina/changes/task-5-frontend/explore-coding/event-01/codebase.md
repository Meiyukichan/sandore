## Exploration Result

`codebases list`（`furina config show project.sourcecode codebases`）返回：

```
project.sourcecode=src/
codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]
```

`docs/codebase` 目录为空（无任何文件），Phase 3 无可用素材。本项目的实际源码位于 `packages/sandore/{workflow,microflow}/src/`，以下全部结论来自 Phase 4 手动补充探索（Grep/Read/Glob）。

## Supplementary Exploration Result

### 0. 探索范围与关键文件

- `D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts` — 六个 `emitStep*` 函数、safeAppend、hooks 闭包、buildActiveInstance 接线。
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts` — Cordis `Events` 与 `SessionEventMap` 双声明。
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts` / `schema.ts` — `ExecutedStepDefault` 的 `name` 与 `loopIteration` 字段。
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts` — `StageStepHooks` 定义与 `onStepStart/onStepCompleted/onStepFailed` 调用点。
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/loop-manager.ts` — `buildLoopIterationPath` / 循环迭代栈。
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/lifecycle-manager.ts` / `recovery-manager.ts` — `emitStepPaused/Resumed/Retried` 调用点。
- 测试：`workflow-engine.spec.ts`、`lifecycle-manager.spec.ts`、`recovery-manager.spec.ts`。

---

### 1. workflow-engine.ts：六个 emitStep* 函数的当前签名与 safeAppend payload 形状

文件：`packages/sandore/workflow/src/workflow-engine.ts`（行号见各条目）。

`safeAppend(fn)`（第 906-912 行）是 `session.append(...)` 的 try/catch 包装，只用于捕获 append 异常。六个 step 事件函数如下：

| 函数 | 签名 | `emitContained` 参数（Cordis） | `safeAppend` payload（Session append） |
|---|---|---|---|
| `emitStepStart`（929-932） | `(session, info, stepId: string, childId: string)` | `['sandore/step-start', info, stepId, childId]` | `{ stepId, childId }` |
| `emitStepCompleted`（934-937） | `(session, info, stepId, childId, output: ContentBlock[])` | `['sandore/step-completed', info, stepId, childId, output]` | `{ stepId, childId, output }` |
| `emitStepFailed`（939-942） | `(session, info, stepId, childId, error: string)` | `['sandore/step-failed', info, stepId, childId, error]` | `{ stepId, childId, error }` |
| `emitStepPaused`（944-952） | `(session, active: ActiveInstance, stepId, childId)` | `['sandore/step-paused', info, stepId, childId]`（info 由 `active.state` 现算） | `{ stepId, childId }` |
| `emitStepResumed`（954-962） | `(session, active, stepId, childId, resumePrompt?: string)` | `['sandore/step-resumed', info, stepId, childId, resumePrompt]` | `{ stepId, childId, ...(resumePrompt===undefined ? {} : { resumePrompt }) }` |
| `emitStepRetried`（964-972） | `(session, active, stepId, mode: RetryMode)` | `['sandore/step-retried', info, stepId, mode]` | `{ stepId, mode }` |

要点：
- 三个「执行期」事件（start/completed/failed）接收 `info: DagRunInfo`；三个「生命周期/恢复」事件（paused/resumed/retried）接收 `active: ActiveInstance` 并在函数体内现算 `info`（`{ taskId, workflowId, jobId }`，来自 `active.state`）。
- 六个事件的 Session payload 当前都**不含** `name` 与 `loopIteration`；Cordis `emitContained` 参数里也只有 `info + stepId + childId(+output/error/resumePrompt/mode)`。

---

### 2. 调用点闭包内 name / loop 迭代路径的可用性

#### 2.1 `onStepStart/onStepCompleted/onStepFailed`（StageExecutor hooks，workflow-engine.ts 第 497-501 行）

```ts
const hooks: StageStepHooks = {
  onStepStart: (step, childId) => this.emitStepStart(session, info, step.id, childId),
  onStepCompleted: (step, childId, output) => this.emitStepCompleted(session, info, step.id, childId, output),
  onStepFailed: (step, childId, error) => this.emitStepFailed(session, info, step.id, childId, error),
};
```

- `step` 类型是 `WorkflowStep`（step 定义）。`StageStepHooks` 定义在 `microflow/src/stage-executor.ts` 第 52-56 行：
  - `onStepStart: (step: WorkflowStep, childId: string) => void`
  - `onStepCompleted: (step: WorkflowStep, childId: string, output: ContentBlock[]) => void`
  - `onStepFailed: (step: WorkflowStep, childId: string, error: string) => void`
- **name 可用性**：`WorkflowStep.name` 是可选字段（`schema.ts` 第 136 行 `name: z.string().optional()`），故 hooks 闭包内有 `step.name`，但需 `step.name ?? step.id` 兜底。StageExecutor 内部正是这样落 `executed` 的（`stage-executor.ts` 第 449 行 `name: step.name ?? step.id`）。
- **loop 迭代路径可用性**：hooks 签名**未传** loopIteration；但 hooks 闭包处于 `runInstance` 作用域内，且 `const loopManager = navigator.loopManagerInstance;`（workflow-engine.ts 第 483 行）在 hooks 定义（第 497 行）之前声明，因此闭包可捕获 `loopManager`，随时调用 `loopManager.buildLoopIterationPath()` 得到当前迭代路径。此外 StageExecutor 内部在 `hooks?.onStepStart(step, childId)`（stage-executor.ts 第 463 行）调用前已经算好了 `executed.loopIteration`（第 459 行 `...(inLoop ? { loopIteration: loopManager.buildLoopIterationPath() } : {})`），但该 `executed` 对象未传给 hooks。

StageExecutor 中三个 hook 的实际调用点（`stage-executor.ts`）：
- `hooks?.onStepStart(step, childId)` — 第 463 行（`step` 为定义，loopIteration 已在第 459 行写入 `executed`）。
- `hooks?.onStepCompleted(step, result.sessionMeta?.childId ?? childId, result.output)` — 第 547 行。
- `hooks?.onStepFailed(...)` 共三处：第 512 行（run 抛错）、第 572 行（finalize error）、第 661 行（resumePendingAsk 的 finalize error）。

#### 2.2 `emitStepPaused / emitStepResumed / emitStepRetried` 的接线（workflow-engine.ts `buildActiveInstance`）

- lifecycle（第 746-747 行）：
  - `emitStepPaused: (stepId, childId) => this.emitStepPaused(session, active, stepId, childId)`
  - `emitStepResumed: (stepId, childId, resumePrompt) => this.emitStepResumed(session, active, stepId, childId, resumePrompt)`
- recovery（第 771 行）：
  - `emitStepRetried: (stepId, mode) => this.emitStepRetried(session, active, stepId, mode)`

这些闭包内 `active: ActiveInstance` 在作用域内，可经 `active.state.executedSteps` 反查 step 的 `name`/`loopIteration`。

更进一步，在管理器内部**真正发起调用的位置**，完整的 `step: ExecutedStep`（含 `name`/`loopIteration`）本身就已在作用域：
- `lifecycle-manager.ts` 第 121 行：`this.deps.emitStepPaused(this.stepIdOf(step), childId)`。
- `lifecycle-manager.ts` 第 141 行：`this.deps.emitStepResumed(this.stepIdOf(step), childId, resumePrompt)`。
- `recovery-manager.ts` 第 165 行：`this.deps.emitStepRetried(stepIdOf(step), mode)`。

其中 `step` 类型为 `WorkflowTaskState['executedSteps'][number]`，其 `name` 必填、`loopIteration` 可选（见第 5 节），因此这三处调用点可直接拿到 name 与 loopIteration（当前只传了 `stepIdOf(step)`）。

---

### 3. seam.ts 双声明当前 payload 类型

文件：`packages/sandore/workflow/src/seam.ts`。

**Cordis `Events`（`declare module '@deepseek-ai/cordis'`，第 34-48 行）**：
- `'sandore/step-start'(info: DagRunInfo, stepId: string, childId: string): void`
- `'sandore/step-completed'(info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[]): void`
- `'sandore/step-failed'(info: DagRunInfo, stepId: string, childId: string, error: string): void`
- `'sandore/step-paused'(info: DagRunInfo, stepId: string, childId: string): void`
- `'sandore/step-resumed'(info: DagRunInfo, stepId: string, childId: string, resumePrompt?: string): void`
- `'sandore/step-retried'(info: DagRunInfo, stepId: string, mode: string): void`

**`SessionEventMap`（`declare module '@deepseek-ai/dsh-session/types'`，第 51-66 行）**：
- `'sandore/step-start': { stepId: string; childId: string }`
- `'sandore/step-completed': { stepId: string; childId: string; output: ContentBlock[] }`
- `'sandore/step-failed': { stepId: string; childId: string; error: string }`
- `'sandore/step-paused': { stepId: string; childId: string }`
- `'sandore/step-resumed': { stepId: string; childId: string; resumePrompt?: string }`
- `'sandore/step-retried': { stepId: string; mode: string }`

注意：`step-retried` 的 `mode` 在 seam 双声明中均为 `string`（Cordis 与 SessionEventMap），而引擎实现里的 `RetryMode = 'continue' | 'revert' | 'fork'`（`recovery-manager.ts` 第 34 行）。两者均无 `name`/`loopIteration`。

---

### 4. loop 迭代路径在引擎里的来源

- 权威来源是 `LoopManager`（`packages/sandore/microflow/src/loop-manager.ts`）持有的 `LoopState`（第 24-27 行）：
  ```ts
  export interface LoopState {
    readonly activeLoopStack: string[];
    readonly activeLoopIterationStack: number[];
  }
  ```
- `buildLoopIterationPath()`（第 136-138 行）直接返回 `[...this.state.activeLoopIterationStack]`，即扁平嵌套数组（如 `[1, 2]`），无活跃循环返回 `[]`。
- 迭代推进：`pushActiveLoop`（150-155，压栈并初始计数 1）、`incrementLoopIteration`（141-147，最内层 +1 并清后缀映射）、`popActiveLoop`（158-162）。
- 引擎侧播种（`workflow-engine.ts` 第 476-483 行）：`WorkflowDagNavigator` 构造入参 `loopState: { activeLoopStack: active.state.activeLoopStack, activeLoopIterationStack: active.state.activeLoopIterationStack }`，随后 `const loopManager = navigator.loopManagerInstance;`。即 `LoopManager` 的迭代栈与持久化 `WorkflowTaskState.activeLoopIterationStack`（`schema.ts` 第 377 行 `z.array(z.number())`）共享引用、随主循环推进。
- 写入 `ExecutedStepDefault.loopIteration` 的位置在 `stage-executor.ts`：
  - 命令节点第 459 行：`...(inLoop ? { loopIteration: loopManager.buildLoopIterationPath() } : {})`。
  - 循环内路由节点第 413 行：`...(inLoopRouting ? { loopIteration: loopManager.buildLoopIterationPath() } : {})`。

---

### 5. types.ts / schema.ts 中 ExecutedStepDefault 的 name 与 loopIteration 字段

**browser-safe 版本**（`packages/sandore/workflow/src/types.ts` 第 129-155 行 `interface ExecutedStepDefault`）：
- `name: string` — 第 134 行，**必填**（运行时已由 `step.name ?? step.id` 兜底解析）。
- `loopIteration?: number[]` — 第 150 行，**可选**。
- 相邻字段：`type: 'default'`、`id: string`、`stepId?: string`、`stageId: string`、`status: StepStatus`、`loopMeta?: BranchMeta`（151）、`retryHistory?: RetryRecord[]`（152）。

**Zod Schema 版本**（`packages/sandore/workflow/src/schema.ts` 第 310-336 行 `ExecutedStepDefaultSchema`）：
- `name: z.string()` — 第 315 行。
- `loopIteration: z.array(z.number()).optional()` — 第 331 行。
- 派生类型 `WorkflowTaskState = z.infer<typeof WorkflowTaskStateSchema>`（第 441 行）的 `executedSteps` 元素即含 `name`（必填）与 `loopIteration`（可选）。

另注意：step **定义** `WorkflowStep.name` 是可选（`schema.ts` 第 136 行 `name: z.string().optional()`），与已执行条目 `ExecutedStepDefault.name`（必填、已兜底）不同——对 step-start/completed/failed 事件（拿定义 `WorkflowStep`）而言 name 需 `step.name ?? step.id`。

---

### 6. 既有测试对 step 事件 payload 的断言现状

**`workflow-engine.spec.ts`**（`packages/sandore/workflow/src/workflow-engine.spec.ts`）：
- `recordSandoreEvents`（第 455-466 行）只记录 `sandore/start`、`stage-start`、`stage-completed`、`step-start`、`step-completed`、`step-failed`、`end`、`aborted`；**未记录** step-paused/resumed/retried。
- 线性执行（597-654）：断言完整事件顺序；`promptCompleted?.args[3]`（output）；**未断言** step 事件的 `name`/`loopIteration`。
- DAG 执行（843-925）：`agentCompleted?.args[2]`（childId）与 `args[3]`（output）；循环断言针对 `state.executedSteps`（第 905 行 `iterations.map(step => step.loopIteration)).toEqual([[1],[2],[3]])`），**不对事件 payload** 断言 loopIteration。
- 嵌套循环（954-970）：第 969 行同样只断言 state 的 `loopIteration`。
- step-retried（1295-1330）：`ctx.on('sandore/step-retried', (_info, stepId, mode) => retried.push({ stepId, mode }))`；断言 `retried === [{ stepId: 'step-agent', mode: 'continue' }]` 与 Session 事件存在（第 1328-1329 行）；未断言 name/loopIteration。

**`lifecycle-manager.spec.ts`**（step-paused/resumed 断言所在，非 workflow-engine.spec.ts）：
- `recordSandoreEvents`（133-141）记录 `step-paused`/`step-resumed`/`step-completed`/`step-failed`/`aborted`。
- pause（225-262）：`record?.args[1] === 'step-agent'`、`args[2] === 'child-1'`；Session append 事件存在。未断言 name/loopIteration。
- resume（367-405）：`args[1]`、`args[2]`、`args[3] === '请继续处理 X'`。未断言 name/loopIteration。

**`recovery-manager.spec.ts`**（step-retried 单元测试）：
- harness 的 `emitStepRetried` 记录 `retried: Array<{ stepId; mode }>`（第 102、126-128 行）。
- continue 模式（217-234）：第 225 行 `expect(harness.retried).toEqual([{ stepId: 'step-1', mode: 'continue' }])`。未断言 name/loopIteration。
