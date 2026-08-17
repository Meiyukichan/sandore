# 探索：sandore 6 个 step-* Session 事件 payload 补 name/loopIteration 需求的参考实现现状

> Explore Type: specification
> 探索范围：`packages/sandore/workflow/src` 与 `packages/sandore/microflow/src` 中与 6 个 step-* 事件发射、双声明、循环迭代路径、ExecutedStepDefault 类型相关的现状。
> 说明：本文件仅记录现状，不提出实现方案。

## 需求理解（What / Boundaries / Goal）

- **What**：为 sandore 的 6 个 step-* Session 事件（`step-start` / `step-completed` / `step-failed` / `step-paused` / `step-resumed` / `step-retried`）的 payload 补充 `name` 与 `loopIteration` 两个字段。需要先摸清这 6 个 emit 函数当前签名与 payload 形状、其调用点闭包内是否已有 step 定义的 name 和循环迭代路径可用、双声明类型、循环迭代路径在引擎里的来源，以及 ExecutedStepDefault 已有字段与测试现状。
- **Boundaries**：仅限 `workflow-engine.ts`、`seam.ts`、`types.ts`、`schema.ts`、`workflow-engine.spec.ts`，以及相关依赖 `stage-executor.ts` / `loop-manager.ts` / `dag-navigator.ts` / `lifecycle-manager.ts` / `recovery-manager.ts`。
- **Goal**：为后续补充字段提供精确的现状参照（函数签名、调用点可用的 name/loopIteration 数据、类型声明位置、测试断言位置）。

---

## 1. workflow-engine.ts 六个 emit 函数签名与 safeAppend payload 形状

所有 6 个 emit 函数均为 `SandoreEngineRuntime`（`packages/sandore/workflow/src/workflow-engine.ts`）的 private 方法。事件双发统一走 `emitContained`（Cordis `ctx.events.dispatch('emit', ...)`）与 `safeAppend`（宿主 Session append）。

`safeAppend` 签名（workflow-engine.ts:906-912）：

```ts
private safeAppend(fn: () => void): void
```

内部对 `session.append(...)` 做 try/catch，失败仅 `ctx.logger.warn`。

### 1.1 六个函数签名与 payload（行号对应 workflow-engine.ts）

| 函数 | 签名 | emitContained args | safeAppend payload |
|---|---|---|---|
| `emitStepStart` (929-932) | `(session, info: DagRunInfo, stepId: string, childId: string)` | `[info, stepId, childId]` | `{ stepId, childId }` |
| `emitStepCompleted` (934-937) | `(session, info, stepId, childId, output: ContentBlock[])` | `[info, stepId, childId, output]` | `{ stepId, childId, output }` |
| `emitStepFailed` (939-942) | `(session, info, stepId, childId, error: string)` | `[info, stepId, childId, error]` | `{ stepId, childId, error }` |
| `emitStepPaused` (944-952) | `(session, active: ActiveInstance, stepId, childId)` | `[info, stepId, childId]` | `{ stepId, childId }` |
| `emitStepResumed` (954-962) | `(session, active, stepId, childId, resumePrompt?)` | `[info, stepId, childId, resumePrompt]` | `{ stepId, childId, ...(resumePrompt !== undefined ? { resumePrompt } : {}) }` |
| `emitStepRetried` (964-972) | `(session, active, stepId, mode: RetryMode)` | `[info, stepId, mode]` | `{ stepId, mode }` |

要点：
- 前三个（Start/Completed/Failed）接收显式 `info: DagRunInfo`；后三个（Paused/Resumed/Retried）接收 `active: ActiveInstance`，并在函数体内从 `active.state` 重建 `info`（`taskId/workflowId/jobId`）。
- 当前 6 个 payload 均**不含** `name` 与 `loopIteration`。

### 1.2 StageExecutor hooks 调用点闭包内可用的数据

`runInstance`（workflow-engine.ts:458）内先取得 `loopManager`：

```ts
const loopManager = navigator.loopManagerInstance;  // workflow-engine.ts:483
```

hooks 闭包定义在 workflow-engine.ts:497-501：

```ts
const hooks: StageStepHooks = {
  onStepStart: (step, childId) => this.emitStepStart(session, info, step.id, childId),
  onStepCompleted: (step, childId, output) => this.emitStepCompleted(session, info, step.id, childId, output),
  onStepFailed: (step, childId, error) => this.emitStepFailed(session, info, step.id, childId, error),
};
```

闭包内可用：
- `step: WorkflowStep`：含可选 `name?: string`（`WorkflowStepSchema` 中 `name: z.string().optional()`，schema.ts:136）。当前闭合里只用 `step.id`，未取 `step.name`。
- `loopManager`：在 `runInstance` 作用域内（483 行），故 `loopManager.buildLoopIterationPath()` 可访问，但当前闭包未使用。

`StageStepHooks` 接口（stage-executor.ts:52-56）当前形参仅为：

```ts
onStepStart: (step: WorkflowStep, childId: string) => void
onStepCompleted: (step: WorkflowStep, childId: string, output: ContentBlock[]) => void
onStepFailed: (step: WorkflowStep, childId: string, error: string) => void
```

即 loop iteration path 在 StageExecutor 内部已计算但未通过 hook 传给引擎。

StageExecutor 内部（`processCommandNode`，stage-executor.ts:439-460）在调用 `hooks?.onStepStart(step, childId)` 之前已计算：

```ts
const inLoop = loopManager.buildLoopIterationPath().length > 0;      // stage-executor.ts:442
...
...(inLoop ? { loopIteration: loopManager.buildLoopIterationPath() } : {}),  // stage-executor.ts:459
```

同时 `executed: ExecutedStepDefault` 上已写 `name: step.name ?? step.id`（stage-executor.ts:449）与 `loopIteration`（459）。分支路由条目同样写了 `name: step.name ?? step.id` 与 `loopIteration`（stage-executor.ts:410、413）。

`onStepCompleted`（finishCommandNode，stage-executor.ts:547）与 `onStepFailed`（572、512、472）的调用点同样只有 `step`/`childId`/`output`/`error`，未传 name 或 loopIteration。

### 1.3 LifecycleManager / RecoveryManager 调用点闭包内可用的数据

`buildActiveInstance` 内注入（workflow-engine.ts:746-747、771）：

```ts
emitStepPaused: (stepId, childId) => this.emitStepPaused(session, active, stepId, childId),
emitStepResumed: (stepId, childId, resumePrompt) => this.emitStepResumed(session, active, stepId, childId, resumePrompt),
emitStepRetried: (stepId, mode) => this.emitStepRetried(session, active, stepId, mode),
```

对应 manager 内部调用点：
- `LifecycleManager.pauseStep`（lifecycle-manager.ts:121）：`this.deps.emitStepPaused(this.stepIdOf(step), childId)`
- `LifecycleManager.resumeStep`（lifecycle-manager.ts:141）：`this.deps.emitStepResumed(this.stepIdOf(step), childId, resumePrompt)`
- `RecoveryManager.retryStep`（recovery-manager.ts:165）：`this.deps.emitStepRetried(stepIdOf(step), mode)`

三处调用点的 `step` 都是 `ExecutedStep = WorkflowTaskState['executedSteps'][number]`，其类型上**已含必填 `name: string` 与可选 `loopIteration?: number[]`**。但当前 emit 回调仅传 `stepId`（`stepIdOf(step)` = `step.stepId ?? step.id`）、`childId`（Paused/Resumed）或 `mode`（Retried），未透传 `step.name` / `step.loopIteration`。

---

## 2. seam.ts 双声明当前 payload 类型

`packages/sandore/workflow/src/seam.ts` 有两处声明，均为当前形状（无 name/loopIteration）。

### 2.1 Cordis `Events`（seam.ts:34-48）

```ts
'sandore/step-start'(info: DagRunInfo, stepId: string, childId: string): void;
'sandore/step-completed'(info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[]): void;
'sandore/step-failed'(info: DagRunInfo, stepId: string, childId: string, error: string): void;
'sandore/step-paused'(info: DagRunInfo, stepId: string, childId: string): void;
'sandore/step-resumed'(info: DagRunInfo, stepId: string, childId: string, resumePrompt?: string): void;
'sandore/step-retried'(info: DagRunInfo, stepId: string, mode: string): void;
```

注意：`step-retried` 的 `mode` 在 Cordis Events 里声明为 `string`（而非 `RetryMode`），与 emit 函数的 `mode: RetryMode` 略有差异。

### 2.2 Session `SessionEventMap`（seam.ts:51-66）

```ts
'sandore/step-start': { stepId: string; childId: string };
'sandore/step-completed': { stepId: string; childId: string; output: ContentBlock[] };
'sandore/step-failed': { stepId: string; childId: string; error: string };
'sandore/step-paused': { stepId: string; childId: string };
'sandore/step-resumed': { stepId: string; childId: string; resumePrompt?: string };
'sandore/step-retried': { stepId: string; mode: string };
```

SessionEventMap 的 payload 形状与 safeAppend 传入的对象一一对应（仅 `stepId/childId/(output|error|resumePrompt|mode)`）。

---

## 3. loop 迭代路径在引擎里的来源

- **持久化字段**：`WorkflowTaskState.activeLoopIterationStack: z.array(z.number())`（schema.ts:377），是扁平嵌套迭代路径数组（如 `[1,2]`）。
- **LoopManager 状态视图**：`LoopState = { activeLoopStack: string[]; activeLoopIterationStack: number[] }`（loop-manager.ts:24-27）。
- **引擎播种**：`runInstance` 构造 `WorkflowDagNavigator` 时传入 `{ activeLoopStack: active.state.activeLoopStack, activeLoopIterationStack: active.state.activeLoopIterationStack }`（workflow-engine.ts:480）。由于传的是数组引用，`LoopManager` 对 `activeLoopIterationStack` 的原地 push/pop/递增会同步反映到 `active.state.activeLoopIterationStack`。
- **管理器暴露**：`navigator.loopManagerInstance`（dag-navigator.ts:108-110）返回 `LoopManager`，引擎在 483 行取到 `loopManager` 供主循环使用。
- **路径构建方法**：`LoopManager.buildLoopIterationPath(): number[]` 返回 `[...this.state.activeLoopIterationStack]`（loop-manager.ts:136-138），即当前嵌套迭代路径的浅拷贝；无活跃循环返回 `[]`。
- **栈维护**：`pushActiveLoop`（压 1，loop-manager.ts:150-155）、`incrementLoopIteration`（末元素 +1，141-147）、`popActiveLoop`（弹出，158-162）；`getLoopIterationContext`（165-169）返回 `loopTurn`/`loopMaxIterations`。
- **消费点**：StageExecutor 用 `loopManager.buildLoopIterationPath()` 判定 `inLoop` 并写入 `ExecutedStepDefault.loopIteration`（stage-executor.ts:403、413、442、459）。

结论：payload 中 `loopIteration` 的权威来源是 `loopManager.buildLoopIterationPath()`（等价于 `active.state.activeLoopIterationStack` 的快照），或已落到快照上的 `ExecutedStepDefault.loopIteration`。

补充：`WorkflowTaskState.activeLoopNodeId`（schema.ts:378）在 `makeInitialState` 初始为 `null`（workflow-engine.ts:130），引擎本身不更新它；`LoopManager.activeLoopNodeId` getter 由 `activeLoopStack` 栈顶推导（loop-manager.ts:105-107），未回写 `state.activeLoopNodeId`。

---

## 4. 既有测试 workflow-engine.spec.ts 对 step 事件的断言现状

`packages/sandore/workflow/src/workflow-engine.spec.ts`：

- **事件记录器** `recordSandoreEvents`（455-466）仅捕获 `[info, stepId, childId]`（completed/failed 追加 `output`/`error`），未捕获 name 或 loopIteration。
- **事件顺序断言**（611-622、626-637）只比对事件名列表。
- **step-completed payload 断言**：640-641 只断言 `args[3]`（output），920 只断言 `args[2]`（childId）与 `args[3]`（output）。
- **step-failed 断言**：742 只断言事件存在（`records.some(...)`）。
- **step-retried 断言**（1313-1329）：监听 `(_info, stepId, mode)` 记录 `{ stepId, mode }`，断言 `retried` 等于 `[{ stepId: 'step-agent', mode: 'continue' }]`，并断言宿主 Session events 含 `sandore/step-retried` 类型。
- **loopIteration 断言**（仅针对持久化快照，非事件 payload）：905 `iterations.map(step => step.loopIteration)).toEqual([[1],[2],[3]])`；969 嵌套 `[[1,1],[1,2],[2,1],[2,2]]`。

即：当前无任何对 step 事件 payload 中 `name` 或 `loopIteration` 的断言；`loopIteration` 仅在 `state.executedSteps` 上被断言。

（相邻测试文件 `lifecycle-manager.spec.ts` 对 `step-paused`/`step-resumed` 的断言同样只覆盖 `info/stepId/childId/resumePrompt`，lifecycle-manager.spec.ts:135-136、252-257、397-398。）

---

## 5. types.ts / schema.ts 中 ExecutedStepDefault 的 name 与 loopIteration 字段

### 5.1 `types.ts`（browser-safe 持久化类型）

`ExecutedStepDefault`（types.ts:129-155）：

```ts
name: string          // 必填，types.ts:134
loopIteration?: number[]  // 可选，types.ts:150
```

### 5.2 `schema.ts`（Zod schema 与派生类型）

`ExecutedStepDefaultSchema`（schema.ts:310-336）：

```ts
name: z.string(),                    // 必填，schema.ts:315
loopIteration: z.array(z.number()).optional(),  // 可选，schema.ts:331
```

派生类型 `WorkflowTaskState = z.infer<typeof WorkflowTaskStateSchema>`（schema.ts:441），`executedSteps: z.array(ExecutedStepDefaultSchema)`（371）。

补充：定义层的 `WorkflowStepSchema.name` 是可选（`z.string().optional()`，schema.ts:136），因此运行时写 `ExecutedStepDefault.name` 时统一用 `step.name ?? step.id` 兜底（stage-executor.ts:410、449；dag-navigator.ts:397 节点索引的 `name` 同理）。
