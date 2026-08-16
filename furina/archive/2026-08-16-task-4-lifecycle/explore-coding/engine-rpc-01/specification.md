# engine-rpc-01 现状与落点探索

## 需求理解

- **What**：探索 Task 4 `engine-rpc-01`（"引擎接线与 7 个生命周期 RPC"，plan.json 中 status=`in_progress`）涉及的 5 个文件当前接线状态：
  - `workflow-engine.ts`：8 个原 stub 实例方法（recoverInstance / replyQuestion / replyPermission / pauseStep / resumeStep / pauseAllSteps / resumeAllSteps / retryStep）是否已接到 interaction/lifecycle/recovery 管理器；`interacting` 分支交互等待循环是否已接；interrupt 取消后暂停登记表协作是否已实现；5 个事件（step-paused / step-resumed / step-retried / question / permission）是否已补发。
  - `remote.ts`：现有 RPC 清单、缺的 7 个生命周期 RPC、zod 入参校验范式。
  - `remote.spec.ts`：测试范式（harness / mock engine / 错误断言）。
  - `seam.ts`：抽象面方法声明。
  - `api.yaml`：7 个 RPC 描述。
- **Boundaries**：限定在上述 5 个文件，以及为佐证"接线/事件/协作"而关联引用的三个管理器（interaction-manager.ts / lifecycle-manager.ts / recovery-manager.ts）、engine-surface.ts 与 microflow stage-executor.ts 的相关行。
- **Goal**：定位 Task 4 剩余未完成的落点，明确哪些子任务（7.1~7.6）已完成、哪些待补。

## 核心结论（现状快照）

- `workflow-engine.ts` 的 7.1/7.2/7.3/7.4 全部已落地：8 个方法均已接到管理器、interacting 分支已接交互等待循环、interrupt 取消协作已实现、5 个事件已补发。但类头注释（L158-163）仍声称"其余 8 个实例级方法抛 `INVALID_OPERATION`（not implemented）"，**注释已过期**。
- `remote.ts` 的 7.5 **尚未落地**：现有 20 个 RPC，7 个生命周期 RPC 全部缺失。
- `remote.spec.ts` 的 7.6 **尚未覆盖**：现有 mock engine 只含 `startInstance`/`abortInstance`，7 个生命周期 RPC 无测试。
- `seam.ts` 与 `api.yaml` 是"已完成并稳定的契约面"，7 个 RPC 的方法名/入参在两端已定死（注意 `pauseAll`/`resumeAll` 与 engine 方法 `pauseAllSteps`/`resumeAllSteps` 的命名映射）。

---

## 1. workflow-engine.ts（`packages/sandore/workflow/src/workflow-engine.ts`）

### 1.1 8 个实例方法接线状态（task 7.1：已完成）

全部 8 个原 stub 方法已实现并转调管理器，无任何 `not implemented` 残留：

| 方法 | 位置 | 接线目标 |
|---|---|---|
| `recoverInstance(instanceId)` | L282 | `active.recovery.recover()`（RecoveryManager）；重建 ActiveInstance 时经 `LifecycleManager` 的 `initialPausedChildIds: state.pausedChildIds` 重建暂停登记表；`abortInstance` 内还读 `active.lifecycle.pausedIds` |
| `replyQuestion(instanceId, requestId, answers)` | L372 | `active.interactions.replyQuestion(...)` |
| `replyPermission(instanceId, requestId, reply)` | L380 | `active.interactions.replyPermission(...)` |
| `pauseStep(instanceId, stepId)` | L389 | `active.lifecycle.pauseStep(stepId)` |
| `resumeStep(instanceId, stepId, resumePrompt?)` | L395 | `active.lifecycle.resumeStep(...)` + `this.notifyResume(active)` |
| `pauseAllSteps(instanceId)` | L402 | `active.lifecycle.pauseAllSteps()` |
| `resumeAllSteps(instanceId, resumePrompt?)` | L408 | `active.lifecycle.resumeAllSteps(...)` + `this.notifyResume(active)` |
| `retryStep(instanceId, stepId, mode, message)` | L415 | `active.recovery.retryStep(stepId, mode, message)` |

三个管理器实例统一在 `buildActiveInstance`（L704-786）构造，全部经回调注入：
- `InteractionManager`（L712-727）：`persist` / `emitQuestion` / `emitPermission` / `followup`。
- `LifecycleManager`（L728-747）：`interrupt` / `followup` / `getAgent` / `signal` / `readState` / `commitState` / `emitStepPaused` / `emitStepResumed` / `initialPausedChildIds`。
- `RecoveryManager`（L748-772）：`signal` / `readState` / `commitState` / `followup` / `createAgent` / `getSession` / `forkSession` / `emitStepRetried` / `resumeExecution`。

> 注意：类头注释（L158-163）原文"实现 `startInstance`/`getState`/`abortInstance`，其余 8 个实例级方法抛 `SandoreError('INVALID_OPERATION')`（`not implemented`）"与当前代码不符，属过期注释。

### 1.2 interacting 分支交互等待循环（task 7.2：已完成）

`runInstance` 内 `while (result.status === 'interacting' || result.status === 'paused')`（L548-587）：
- `interacting` 分支（L549-571）：`markStageStatus(interacting)` → `persistState` → `findAskStep` 定位 ask 载荷 → 构造 `PendingQuestionEntry`（L560-570）→ `await active.interactions.ask({ entry, ...(signal) })`（L571）**阻塞等待回复**；回复 resolve 后循环回到 `result = await executor.execute()`（L586）从断点续跑，直至 Stage 完成/失败。
- 非"置标记后 return"（仅无 ask 载荷的异常收尾 L556-559 才 `return`）。

### 1.3 interrupt 取消协作（task 7.3：已完成）

- 引擎侧注入暂停登记表判定：`runnerConfig.isPausedChild: (childId) => active.lifecycle.hasPaused(childId)`（L686）。
- microflow `stage-executor.ts` 在命令节点取消类错误时查登记表：`isCancellationError(error) && this.isPausedStep(step.id)` → `executed.status='paused'`、`state.status='paused'`、返回 `'paused'`（stage-executor.ts L496-501）；`isPausedStep` 调 `runnerConfig.isPausedChild?.(childId)`（L632-636）。
- 引擎 `paused` 分支（L572-577）：命中暂停登记表时 `await this.waitForResume(active)`，**不落 failed、不发射 step-failed、不推进下一 Stage**。
- 等待期内中止协作：`waitForResume`（L847-864）监听 `signal.aborted` 与 `resumeWaiters` 竞争；`notifyResume`（L867-876）由 resumeStep/resumeAllSteps 唤醒；中止处理分支（L581-583、L589-601）落 aborted 终态且 `status !== 'aborted'` 守卫避免 `sandore/aborted` 双发。

### 1.4 5 个事件补发（task 7.4：已完成）

5 个事件均有专属 emit 方法，均 `emitContained`（Cordis `events.dispatch('emit', …)`）+ `safeAppend`（`session.append`）双发：

| 事件 | emit 方法 | 位置 | 管理器回调接线点 |
|---|---|---|---|
| `sandore/step-paused` | `emitStepPaused` | L943 | `lifecycle` 选项 `emitStepPaused`（L745） |
| `sandore/step-resumed` | `emitStepResumed` | L953 | `lifecycle` 选项 `emitStepResumed`（L746） |
| `sandore/step-retried` | `emitStepRetried` | L963 | `recovery` 选项 `emitStepRetried`（L770） |
| `sandore/question` | `emitQuestion` | L983 | `interactions` 选项 `emitQuestion`（L719） |
| `sandore/permission` | `emitPermission` | L993 | `interactions` 选项 `emitPermission`（L720） |

管理器触发点：`LifecycleManager.pauseStep`/`resumeStep` 内 `emitStepPaused`/`emitStepResumed`；`RecoveryManager.retryStep` 内 `emitStepRetried`；`InteractionManager.addPendingQuestion`/`addPendingPermission` 内 `emitQuestion`/`emitPermission`。载荷均含 childId（或 pending 条目）。

---

## 2. remote.ts（`packages/sandore/workflow/src/remote.ts`）

### 2.1 现有 RPC 清单（20 个）

`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`，`static inject = ['sandorePersistence','sandoreEngine','llm']`。

定义 CRUD：`listDefinitions` / `createDefinition` / `updateDefinition` / `deleteDefinition` / `getYaml` / `updateYaml`（6）
Job CRUD：`listJobs` / `createJob` / `getJob` / `updateJob` / `deleteJob`（5）
实例生命周期（已有）：`listInstances` / `startInstance` / `deleteInstance` / `getInstanceState` / `abortInstance`（5）
产物/Provider：`getArtifacts` / `listProviders` / `listModels`（3）
其他：`ping`（1）

### 2.2 缺的 7 个生命周期 RPC（task 7.5：未落地）

当前 remote.ts 中**不存在**以下任何方法：

| RPC 方法名（api.yaml path） | 应转调 engine 方法 | 入参 |
|---|---|---|
| `replyQuestion`（/replyQuestion） | `ctx.sandoreEngine.replyQuestion` | instanceId, requestId, answers |
| `replyPermission`（/replyPermission） | `ctx.sandoreEngine.replyPermission` | instanceId, requestId, reply('once'\|'always'\|'reject') |
| `pauseStep`（/pauseStep） | `ctx.sandoreEngine.pauseStep` | instanceId, stepId |
| `resumeStep`（/resumeStep） | `ctx.sandoreEngine.resumeStep` | instanceId, stepId, resumePrompt? |
| `pauseAll`（/pauseAll） | `ctx.sandoreEngine.pauseAllSteps` | instanceId |
| `resumeAll`（/resumeAll） | `ctx.sandoreEngine.resumeAllSteps` | instanceId, resumePrompt? |
| `retryStep`（/retryStep） | `ctx.sandoreEngine.retryStep` | instanceId, stepId, mode('continue'\|'revert'\|'fork'), message |

> 命名映射注意：api.yaml 的 path 名是 `/pauseAll`、`/resumeAll`，而 engine/seam 方法名是 `pauseAllSteps`/`resumeAllSteps`（`resumeAll`→`resumeAllSteps` 在 plan.json tools-01 中也有对应 `sandore_resumeAllPaused→resumeAllSteps`）。
> 边界：不新增 `recover`（Service.init 自动扫描）、不新增 `getDiscussion`/`addChatMessage`。

### 2.3 zod 入参校验范式

- 关键差异：remote.ts 使用 `import { z } from 'zod'`（**原生 zod**），而 workflow-engine.ts / seam.ts 使用 `import z from '@deepseek-ai/schemastery'`。
- 范式三步：
  1. 顶部定义 `const XxxInputSchema = z.object({ ... })`（字段 `z.string()`，可选 `.optional()`）；
  2. `export type XxxInput = z.infer<typeof XxxInputSchema>`；
  3. 每个 async `@Remote` 方法**首行** `const parsed = XxxInputSchema.parse(input)`。
- 现有 5 个 schema：`CreateDefinitionInputSchema` / `UpdateDefinitionInputSchema` / `CreateJobInputSchema` / `UpdateJobInputSchema` / `StartInstanceInputSchema`（L55-84）。
- 错误透传：方法体不 try/catch，`SandoreError` 直接向上抛（Typert 映射为 code/message）。

---

## 3. remote.spec.ts（`packages/sandore/workflow/src/remote.spec.ts`）

### 测试范式

- **框架**：vitest `describe` / `it` / `expect`。
- **harness()**（L94-154）：构造 `Context` → `MemoryStorageDomain`（`tests/mocks/storage-domain.ts`）→ `ctx.plugin(SandorePersistence)` → mock `llm`（`listProviders`/`listModels`）→ mock `sandoreEngine`。**当前 mock engine 仅含 `startInstance` + `abortInstance`**（L142-150），`as unknown as SandoreEngine` 断言类型。
- **makeState()**（L39-65）：构造字段完整的 `WorkflowTaskState`（`taskId` 必填，含 `pendingInteractions: []`、`pausedChildIds: []` 等）。
- **错误断言双助手**：`catchCode(fn)`（同步）/ `catchCodeAsync(fn)`（异步）捕获 `SandoreError.code`；另用 `expect(...).rejects.toMatchObject({ code: '...' })`。
- **分组**：definition CRUD / job CRUD / instance lifecycle / artifacts and llm forwarding。
- **落点影响**：补 7 个生命周期 RPC 的测试需扩展 mock engine 加入 `replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`（当前只有 startInstance/abortInstance）。

---

## 4. seam.ts（`packages/sandore/workflow/src/seam.ts`）

### 抽象面方法声明（11 个 abstract）

`SandoreEngine extends Service implements SandoreEngineSurface`（`SandoreEngineSurface` 来自 `engine-surface.ts`，type-only 单一事实来源）：

1. `startInstance(request: DagStartRequest): Promise<DagRun>`
2. `recoverInstance(instanceId): Promise<DagRun>`
3. `abortInstance(instanceId): Promise<void>`
4. `replyQuestion(instanceId, requestId, answers: AskUserQuestionAnswer): Promise<void>`
5. `replyPermission(instanceId, requestId, reply: 'once'|'always'|'reject'): Promise<void>`
6. `pauseStep(instanceId, stepId): Promise<void>`
7. `resumeStep(instanceId, stepId, resumePrompt?): Promise<void>`
8. `pauseAllSteps(instanceId): Promise<void>`
9. `resumeAllSteps(instanceId, resumePrompt?): Promise<void>`
10. `retryStep(instanceId, stepId, mode: 'continue'|'revert'|'fork', message): Promise<void>`
11. `getState(instanceId): DagInstanceState`

其他要点：
- 13 个 `sandore/*` 事件双声明（Cordis `Events` + `SessionEventMap`），5 个新事件（step-paused/step-resumed/step-retried/question/permission）已在其中。
- `SandoreEngineStub`：11 个方法全部 `throw new Error('SandoreEngineStub.X is not implemented')`；`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain','agents','userQuestions']`。
- 对比：`SandoreEngineRuntime`（workflow-engine.ts）的 `static inject` 为 `['sessions','sessionPersistence','subagents','agents','llm','shell','fs','storageDomain','sandorePersistence','userQuestions']`（比 stub 多 `sandorePersistence`）。
- 另声明 `UserQuestionsRequest`/`UserQuestions` 接口与 `SandoreConfig` 接口。

---

## 5. api.yaml（`furina/changes/task-4-lifecycle/api.yaml`）

Swagger 2.0，`basePath: /sandore`，仅描述 Task 4 增量（完整 CRUD/产物面见归档 `furina/archive/2026-08-15-task-2-minimal-engine/api.yaml`）。7 个 RPC path：

| path | tag | 入参（required） |
|---|---|---|
| `/replyQuestion` | Interactions | instanceId, requestId, answers |
| `/replyPermission` | Interactions | instanceId, requestId, reply(once/always/reject) |
| `/pauseStep` | Lifecycle | instanceId, stepId |
| `/resumeStep` | Lifecycle | instanceId, stepId, resumePrompt? |
| `/pauseAll` | Lifecycle | instanceId |
| `/resumeAll` | Lifecycle | instanceId, resumePrompt? |
| `/retryStep` | Lifecycle | instanceId, stepId, mode($ref RetryMode), message |

定义（definitions）：
- `ErrorResponse`：code/message/fatal（SandoreErrorCode 子集：INVALID_OPERATION / NODE_NOT_FOUND / STEP_EXECUTION / PERSISTENCE_FAILED / OPEN_TURN 透传）。
- `PendingInteractionEntry`：id/stageId/stepId/sessionId/requestId/kind(question|permission)/status(pending|replied|rejected)/payload/answer/createdAt。
- `RetryMode`：continue / revert / fork。
- `NoopResult`：ok（恒 false）+ reason（如实例已 completed 终态）。

边界约定（api.yaml L17-19）：不新增 recover RPC（崩溃恢复是 `Service.init` 自动扫描）；不新增 getDiscussion/addChatMessage（讨论数据走宿主 Session 日志直读）。

---

## 附：关联文件落点索引

- 管理器：`packages/sandore/workflow/src/interaction-manager.ts`（`ask` L168 / `replyQuestion` L195 / `replyPermission` L210）、`lifecycle-manager.ts`（`pauseStep` L91 / `resumeStep` L125 / `pauseAllSteps` L145 / `resumeAllSteps` L157）、`recovery-manager.ts`（`retryStep` L134 / `recover` L230）。
- 结构面：`packages/sandore/workflow/src/engine-surface.ts`（11 方法 type-only 声明）。
- microflow 协作：`packages/sandore/microflow/src/stage-executor.ts`（L496-501 取消类错误查登记表返回 'paused'；L632-636 `isPausedStep` 调 `isPausedChild`）。
