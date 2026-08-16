## Exploration Result

Phase 3（furina-codebase 探索）目标 `docs/codebase` 目录在当前仓库中不存在（codebases list 指向该路径，但 `docs/` 下仅有 `design/` 与 `engine/`），无返回结果。全部结论来自 Phase 4 手动补充探索。

## Supplementary Exploration Result

### 需求理解（What / Boundaries / Goal）

- **What**：Task 4 engine-rpc-01（`furina/changes/task-4-lifecycle/plan.json` 中 id=`engine-rpc-01`，category=`engine-wiring`，status=`in_progress`）——最终接线层，四件事：① 把 8 个 stub 实例方法接到 interaction/lifecycle/recovery 管理器；② `runInstance` 的 `interacting` 分支接交互等待循环；③ 补 interrupt 取消后的暂停登记表协作（不落 failed）；④ 补发 5 个事件（step-paused/step-resumed/step-retried/question/permission）。同时在 `remote.ts` 补 7 个生命周期 RPC + zod 入参校验，并扩展 `remote.spec.ts`/`workflow-engine.spec.ts`。
- **Boundaries**：探索范围限定于 `packages/sandore/workflow/src/{workflow-engine.ts, remote.ts, remote.spec.ts, seam.ts, engine-surface.ts}`，以及中断协作链路的 `packages/sandore/microflow/src/{stage-executor.ts, step-runner.ts}`，再对照 `furina/changes/task-4-lifecycle/{plan.json, design.md, api.yaml}`。不涉及 tool 包与 ui 包。
- **Goal**：确认 engine-rpc-01 各落点的当前实现状态——8 个方法哪些已接线、哪些仍是 stub；interacting 等待循环是否已接；5 个事件是否已补发；interrupt 取消协作是否已实现；remote.ts 缺哪 7 个 RPC 及 zod 范式；remote.spec.ts 测试范式；seam.ts 抽象面声明；api.yaml 的 7 个 RPC 描述。
- **Project Context**：sandore 为 pnpm monorepo，源码在 `packages/sandore/*`（无顶层 `src/`）。`workflow-engine.ts`（`SandoreEngineRuntime`）是 Stage 级线性主循环运行时；`interaction-manager.ts`/`lifecycle-manager.ts`/`recovery-manager.ts` 三个管理器是「纯协调器」（不持有引擎状态，经注入回调访问宿主主代理、subagents、readState/commitState 与事件双发回调）。engine-rpc-01 依赖的 seam-01/tools-01/host-agent-01/interaction-01/lifecycle-01/recovery-01 均 done。

### ① workflow-engine.ts：8 个实例方法接线状态（已全部接线，无 stub 残留）

8 个「原 stub」实例方法（对应 plan.json 7.1）当前**均已接线**：

| 方法 | 行号 | 接线目标 | 状态 |
|---|---|---|---|
| `recoverInstance(instanceId)` | 282–341 | `active.recovery.recover()` + `ctx.agents.resume` 冷恢复宿主 + `resumeExecution` 续跑 | 已接 |
| `replyQuestion(instanceId, requestId, answers)` | 372–378 | `active.interactions.replyQuestion` | 已接 |
| `replyPermission(instanceId, requestId, reply)` | 380–386 | `active.interactions.replyPermission` | 已接 |
| `pauseStep(instanceId, stepId)` | 389–392 | `active.lifecycle.pauseStep` | 已接 |
| `resumeStep(instanceId, stepId, resumePrompt?)` | 395–399 | `active.lifecycle.resumeStep` + `notifyResume(active)` | 已接 |
| `pauseAllSteps(instanceId)` | 402–405 | `active.lifecycle.pauseAllSteps` | 已接 |
| `resumeAllSteps(instanceId, resumePrompt?)` | 408–412 | `active.lifecycle.resumeAllSteps` + `notifyResume(active)` | 已接 |
| `retryStep(instanceId, stepId, mode, message)` | 415–418 | `active.recovery.retryStep` | 已接 |

- 无任何 `not implemented` / `INVALID_OPERATION` stub 残留；`buildActiveInstance`（704–786）构造三个管理器并注入回调（`interrupt`/`followup`/`getAgent`/`readState`/`commitState`/`emitStep*` 等）。
- **关键发现（过时注释）**：类级 docstring（158–163 行）仍写「实现 `startInstance`/`getState`/`abortInstance`，其余 8 个实例级方法抛 `SandoreError('INVALID_OPERATION')`（`not implemented`）」——与当前已全部接线的实际实现不符，属陈旧注释。
- 另 3 个 Task 2/3 已实现方法：`startInstance`（186–219）、`getState`（222–233，内存优先 + state 表兜底）、`abortInstance`（240–272）。`recoverOrphanedInstances`（348–370）为启动扫描，`Service.init` 钩子（181–183）调用。

### ② interacting 分支交互等待循环（已接）

`runInstance`（457–651）内交互/暂停续跑循环（548–587）：

```ts
while (result.status === 'interacting' || result.status === 'paused') {
  if (result.status === 'interacting') {
    // markStageStatus('interacting') → state.status='interacting' → persist
    // findAskStep → 构造 PendingQuestionEntry → await active.interactions.ask({ entry, signal })
  } else {
    await this.waitForResume(active);
  }
  if (signal.aborted) break;
  result = await executor.execute();  // 断点续跑
}
```

- `interacting` 分支（549–571）：不再「置标记后 return」，而是注入 `PendingQuestionEntry` 并 `await active.interactions.ask(...)`，回复后 `executor.execute()` 从断点续跑。
- `active.interactions.ask`（interaction-manager.ts 168–186）：`addPendingQuestion` 登记 → `ctx.userQuestions.ask({ agent: hostAgent, questions })` 发 DSH 原生卡片并 `await` 答案；兼容回复路径 `replyQuestion` resolve 内部 Promise 汇合。
- 配套 `resumePendingAsk`（stage-executor.ts 638+）负责回复后的重跑门禁（`finalizeStepAfterAsk`）。

### ③ 5 个事件补发（已全部双发）

5 个 Task 4 新增事件均经 `emitContained`（`ctx.emit`，892–903）+ `safeAppend`（`session.append`，905–911）双发：

| 事件 | 发射方法 | 行号 | 触发源 |
|---|---|---|---|
| `sandore/step-paused` | `emitStepPaused` | 943–951 | `lifecycle` 的 `emitStepPaused` 回调（745） |
| `sandore/step-resumed` | `emitStepResumed` | 953–961 | `lifecycle` 的 `emitStepResumed` 回调（746） |
| `sandore/step-retried` | `emitStepRetried` | 963–971 | `recovery` 的 `emitStepRetried` 回调（770） |
| `sandore/question` | `emitQuestion` | 983–991 | `interactions` 的 `emitQuestion` 回调（719） |
| `sandore/permission` | `emitPermission` | 993–1001 | `interactions` 的 `emitPermission` 回调（720） |

- 已全部补发，载荷含 `DagRunInfo` + 专属字段（step-paused/resumed/retried 带 `childId`；question/permission 带 pending 条目）。
- 另 8 个事件为 Task 2/3 已有：`start`（913）、`stage-start`（918）、`stage-completed`（923）、`step-start`（928）、`step-completed`（933）、`step-failed`（938）、`end`（973）、`aborted`（978）。合计 13 事件，与 seam.ts 双声明一致。

### ④ interrupt 取消协作（已实现，三层闭环）

1. **引擎注入 `isPausedChild`**（runnerConfig 686）：`isPausedChild: (childId) => active.lifecycle.hasPaused(childId)`，把暂停登记表查询注入 `StepRunnerConfig`（step-runner.ts 89 声明 `isPausedChild?`）。
2. **StageExecutor 取消分支**（stage-executor.ts 493–502）：`processCommandNode` 捕获取消类错误后判定 `isCancellationError(error) && this.isPausedStep(step.id)` → 命中则 Step 置 `paused`、`state.status='paused'`、写 `pendingPaused`、返回 `'paused'`（**不落 failed、不发 step-failed**）；未命中才走 failed 分支。`isPausedStep`（630–636）经 `realChildIds`（`onChildStarted` 记录）反查真实 childId 再调 `runnerConfig.isPausedChild`。
3. **引擎 paused 分支 + resume 唤醒**：`runInstance` 的 `paused` 分支（576）`await waitForResume(active)`（847–864）；`notifyResume(active)`（867–876）在 `resumeStep`/`resumeAllSteps` 成功后 resolve waiter（无 waiter 时置 `resumeRequested` 标志）。`waitForResume` 与 `signal.aborted` 竞争（abort 监听 resolve），避免 paused 期中止导致主循环永久悬挂。

- 配套 `abortInstance`（240–272）：`controller.abort()` → 遍历 `active.lifecycle.pausedIds` 逐个 `subagents.interrupt(childId, { kind:'ancestor', agent: hostAgent })` → `aborted` 终态落盘 → `emitAborted` → 清理内存 `ActiveInstance`（保留持久化快照）。
- `LifecycleManager.pauseStep`（lifecycle-manager.ts 91–122）实际执行 interrupt（`{kind:'ancestor', agent: hostAgent}`）+ 登记表 add + Step paused；`isNonSubagentCommand` 守卫拒绝 shell/prompt 合成 session 暂停。

### ⑤ remote.ts：现有 RPC 清单与缺失的 7 个生命周期 RPC

**现有 20 个 `@Remote` 方法**（`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`，inject=`['sandorePersistence','sandoreEngine','llm']`）：

- 健康：`ping`（120）
- 定义 CRUD：`listDefinitions`（128）、`createDefinition`（141）、`updateDefinition`（160）、`deleteDefinition`（179）、`getYaml`（185）、`updateYaml`（191）
- Job CRUD：`listJobs`（211）、`createJob`（222）、`getJob`（242）、`updateJob`（248）、`deleteJob`（266）
- 实例生命周期：`listInstances`（274）、`startInstance`（292）、`deleteInstance`（306）、`getInstanceState`（312）、`abortInstance`（318）
- 产物/Provider：`getArtifacts`（332）、`listProviders`（352）、`listModels`（358）

**缺失的 7 个生命周期 RPC**（grep 确认 remote.ts 中 0 命中，均未实现）：`replyQuestion` / `replyPermission` / `pauseStep` / `resumeStep` / `pauseAll` / `resumeAll` / `retryStep`。对应转调目标（api.yaml 与 plan.json 7.5）：`sandore.replyQuestion/replyPermission/pauseStep/resumeStep/pauseAll/resumeAll/retryStep` → `ctx.sandoreEngine.{replyQuestion, replyPermission, pauseStep, resumeStep, pauseAllSteps, resumeAllSteps, retryStep}`。注意 RPC 名 `pauseAll`/`resumeAll` 与引擎方法名 `pauseAllSteps`/`resumeAllSteps` 的命名差异。

**zod 入参校验范式**（remote.ts 用 `import { z } from 'zod'`，与 workflow-engine.ts 用 `@deepseek-ai/schemastery` 不同）：

- 对象入参建 schema 常量：`const XxxInputSchema = z.object({...})`（如 `CreateDefinitionInputSchema`/`UpdateDefinitionInputSchema`/`CreateJobInputSchema`/`UpdateJobInputSchema`/`StartInstanceInputSchema`，55–84）。
- 导出推断类型：`export type XxxInput = z.infer<typeof XxxInputSchema>`（86–90）。
- 方法内**抛错式**校验：`const parsed = XxxInputSchema.parse(input)`（143/162/224/250/294 等，非 safeParse），校验失败抛 ZodError。
- 纯标量参数（`id`/`instanceId`/`provider`）不建 schema，直接签名声明。
- 错误透传：未命中 `requireDefinition`/`requireJob`/`requireInstanceState` 抛 `SandoreError(code: 'NODE_NOT_FOUND')`；终态守卫抛 `'INVALID_OPERATION'`（105 行 `TERMINAL_STATUSES`）。RPC 层只做校验+转发/存储，无引擎业务逻辑。

### ⑥ remote.spec.ts 测试范式

- 测试框架：vitest `describe`/`it`/`expect`。
- `harness()`（94–154）组装被测环境：`new Context()` → 注入内存 `MemoryStorageDomain` + `await ctx.plugin(SandorePersistence)` → `ctx.provide('llm', mockLlm)` → `ctx.provide('sandoreEngine', engine)`（`engine as unknown as SandoreEngine` 类型收窄）→ `new SandoreRemote(ctx)`。
- **mock 引擎当前仅两个方法**（142–149）：`startInstance`（写 state 表并返回 `DagRun`）、`abortInstance`（置 aborted 落盘）。**尚未覆盖 7 个生命周期方法**（需在 harness 扩展 mock 引擎后才可测新 RPC）。
- `makeState(overrides)`（39–65）构造字段完整的 `WorkflowTaskState` 快照（taskId 必填，其余有默认值）。
- `catchCode(fn)` / `catchCodeAsync(fn)`（71–91）捕获 `SandoreError` 并返回其 `code`，用于断言 `NODE_NOT_FOUND` 等错误码。
- `validV2Yaml`（20–36）为 YAML 夹具（`stages` 顶层 + `steps` 平铺两段结构）。
- 现有用例覆盖：definition CRUD、job CRUD、instance lifecycle（startInstance/listInstances/deleteInstance/abortInstance/getInstanceState/getArtifacts）、llm 转发（listProviders/listModels）、ping。**无 7 个生命周期 RPC 的用例**。

### ⑦ seam.ts 抽象面方法声明

- `SandoreEngine` 抽象类（75–105）`implements SandoreEngineSurface`（`engine-surface.ts` 12–35 的 type-only 接口，同 11 个方法签名，作为 seam 与 tool 包的「单一事实来源」）。
- 11 个 abstract 方法：`startInstance`（81）、`recoverInstance`（83）、`abortInstance`（85）、`replyQuestion`（88）、`replyPermission`（90）、`pauseStep`（93）、`resumeStep`（95）、`pauseAllSteps`（97）、`resumeAllSteps`（99）、`retryStep`（101）、`getState`（104）。
- `SandoreEngineStub`（137–190）：`static Config`（z.object，138–143）+ `static inject`（9 项：sessions/sessionPersistence/subagents/llm/shell/fs/storageDomain/agents/userQuestions，145 行，**无 sandorePersistence**，与 Runtime 的 10 项 inject 不同）+ 11 个方法全部 `throw new Error('SandoreEngineStub.xxx is not implemented')`。
- 13 个 `sandore/*` 事件双声明：Cordis `Events`（35–47）+ `SessionEventMap`（53–65），已含 5 个 Task 4 新事件（step-paused/step-resumed/step-retried/question/permission）。
- 其他声明：`UserQuestionsRequest`（108–112）、`UserQuestions`（115–117）、`SandoreConfig`（120–129）。

### ⑧ api.yaml 的 7 个 RPC 描述

`furina/changes/task-4-lifecycle/api.yaml`（Swagger 2.0，`basePath: /sandore`，非 HTTP，`host.call('sandore.<method>', ...)`）：

| path | tag | summary | 入参（required） |
|---|---|---|---|
| `/replyQuestion` | Interactions | 回复待处理问答（兼容路径，resolve 内部 Promise 与 ask 的 await 汇合） | instanceId/requestId/answers |
| `/replyPermission` | Interactions | 回复待处理权限请求（镜像兼容路径，无自动审批） | instanceId/requestId/reply(once\|always\|reject) |
| `/pauseStep` | Lifecycle | 暂停单个 Step（interrupt 子代理 + 登记表 pausedChildIds） | instanceId/stepId |
| `/resumeStep` | Lifecycle | 恢复单个 Step（followup 子代理 + 移出登记表） | instanceId/stepId(+resumePrompt?) |
| `/pauseAll` | Lifecycle | 暂停实例内全部活跃 Step | instanceId |
| `/resumeAll` | Lifecycle | 恢复实例内全部已暂停 Step | instanceId(+resumePrompt?) |
| `/retryStep` | Lifecycle | 按三模式重试失败 Step（continue/revert/fork） | instanceId/stepId/mode/message |

- 头部明确边界：**不新增 `recover` RPC**（崩溃恢复是 `Service.init` 自动扫描）、**不新增 `getDiscussion`/`addChatMessage`**（讨论数据走宿主 Session 日志直读，避免双轨数据源）。
- 定义面：`ErrorResponse`（code/message/fatal）、`PendingInteractionEntry`（含 id/stageId/stepId/sessionId/requestId/kind/status/payload/answer/createdAt）、`RetryMode`（continue/revert/fork）、`NoopResult`（ok=false + reason，供 completed 实例 no-op）。

### 现状汇总（engine-rpc-01 落点）

- plan.json 7.1（8 方法接线）、7.2（interacting 等待循环）、7.3（interrupt 取消协作）、7.4（5 事件补发）的引擎侧改动在 `workflow-engine.ts` **均已就位**（仅类级 docstring 一处过时注释）。
- plan.json 7.5（remote.ts 7 个生命周期 RPC）**尚未实施**——`remote.ts` 缺 `replyQuestion/replyPermission/pauseStep/resumeStep/pauseAll/resumeAll/retryStep` 7 个 RPC。
- plan.json 7.6（remote.spec.ts 扩展）**尚未实施**——`remote.spec.ts` 的 mock 引擎缺 7 个生命周期方法，无对应用例。
