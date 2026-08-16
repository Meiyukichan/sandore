## Exploration Result

> 目标：探索 Task 4 `engine-rpc-01`（引擎接线 + 7 个生命周期 RPC）的现状与落点。本结果全部基于实际代码，覆盖 `workflow-engine.ts`、`remote.ts`、`remote.spec.ts`、`seam.ts`、`engine-surface.ts`、三个管理器（interaction/lifecycle/recovery）与 `microflow/src/stage-executor.ts` 的接线现状，以及 `furina/changes/task-4-lifecycle/api.yaml` 的 7 个 RPC 描述。所有文件绝对路径均位于 `D:\project-code\llm\sandore\`。

### 一、需求理解（Phase 2）

- **What**：`engine-rpc-01` 是 Task 4 的最终接线层任务，分两块：(1) 把 `workflow-engine.ts` 里 `SandoreEngineRuntime` 的 8 个实例级方法从 stub 接到交互/生命周期/恢复三个管理器，并在 `runInstance` 补上 interacting 交互等待循环、interrupt 取消后的暂停登记表协作、以及 5 个新增事件的双发；(2) 在 `remote.ts`（`sandore.*` Host RPC）补 7 个生命周期 RPC 并带 zod 入参校验。
- **Boundaries**：`packages/sandore/workflow/src` 下的 `workflow-engine.ts`、`remote.ts`、`remote.spec.ts`、`seam.ts`、`engine-surface.ts`、三个管理器文件，以及 `packages/sandore/microflow/src/stage-executor.ts`（interrupt 取消协作的 microflow 侧）；加上 `furina/changes/task-4-lifecycle/api.yaml` 与 `specs/lifecycle-rpc/spec.md`。
- **Goal**：判定「8 个方法接线 / interacting 循环 / 5 事件 / interrupt 协作」是否已落地、`remote.ts` 缺哪 7 个 RPC、zod 范式与测试范式如何、`seam.ts` 抽象面与 `api.yaml` 描述，为后续实施 `engine-rpc-01` 剩余部分（主要是 remote.ts 7 RPC + 测试扩展）定位落点。

### 二、plan.json 中 engine-rpc-01 的任务状态

`furina/changes/task-4-lifecycle/plan.json` 中 `engine-rpc-01` 的 `status` 为 `"in_progress"`，依赖 `seam-01 / tools-01 / host-agent-01 / interaction-01 / lifecycle-01 / recovery-01` 均已 `"done"`。其 6 个子任务：

- 7.1 workflow-engine.ts 将 8 个 stub 方法接到四管理器
- 7.2 runInstance interacting 分支接交互等待循环
- 7.3 补 interrupt 取消后的暂停登记表协作（不落 failed）
- 7.4 补发 5 个事件（step-paused/resumed/retried/question/permission）
- 7.5 remote.ts 补 7 个生命周期 RPC + zod 入参校验
- 7.6 扩展 workflow-engine.spec.ts 与 remote.spec.ts 覆盖接线/事件/RPC 链路

**现状对照**：7.1 / 7.2 / 7.3 / 7.4 已在 `workflow-engine.ts` 内落地；7.5（remote.ts 7 RPC）**未落地**；7.6 中 remote.spec.ts 侧尚未扩展（见下文各节）。

### 三、workflow-engine.ts 的 8 个实例方法接线状态

`SandoreEngineRuntime`（`workflow-engine.ts`）继承 `SandoreEngine`。seam 抽象类共 11 个实例方法，其中 `startInstance`/`getState`/`abortInstance` 为既有实现，其余 **8 个**（`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`）即「8 个实例方法」。**结论：8 个方法已全部接管理器，无任何 stub 残留**（`grep "not implemented"` 在 workflow-engine.ts 中零命中）。

| 方法 | 行号 | 接线状态 | 委托目标 |
|---|---|---|---|
| `recoverInstance` | 282–341 | 已接 recovery | `active.recovery.recover()`（321），冷恢复宿主主代理后 `resumeExecution` |
| `replyQuestion` | 372–378 | 已接 interaction | `active.interactions.replyQuestion(requestId, answers)` |
| `replyPermission` | 380–386 | 已接 interaction | `active.interactions.replyPermission(requestId, reply)` |
| `pauseStep` | 389–392 | 已接 lifecycle | `active.lifecycle.pauseStep(stepId)`（同步） |
| `resumeStep` | 395–399 | 已接 lifecycle | `await active.lifecycle.resumeStep(stepId, resumePrompt)` + `notifyResume(active)` |
| `pauseAllSteps` | 402–405 | 已接 lifecycle | `active.lifecycle.pauseAllSteps()` |
| `resumeAllSteps` | 408–412 | 已接 lifecycle | `await active.lifecycle.resumeAllSteps(resumePrompt)` + `notifyResume(active)` |
| `retryStep` | 415–418 | 已接 recovery | `await active.recovery.retryStep(stepId, mode, message)` |

- 三个管理器实例在 `buildActiveInstance`（704–786）中统一构造并注入 `ActiveInstance`（`interactions`/`lifecycle`/`recovery`），通过 `readState`/`commitState` 闭包回写 `active.state` 并 `persistState`。
- 各管理器依赖注入的接线点：interaction 的 `emitQuestion`/`emitPermission`/`followup`/`persist`（712–727）、lifecycle 的 `interrupt`/`followup`/`getAgent`/`signal`/`readState`/`commitState`/`emitStepPaused`/`emitStepResumed`（728–747）、recovery 的 `followup`/`createAgent`/`getSession`/`forkSession`/`emitStepRetried`/`resumeExecution`（748–772）。
- **注意（一处过期注释）**：类级 JSDoc（158–163）仍写着「其余 8 个实例级方法抛 `SandoreError('INVALID_OPERATION')`（`not implemented`）」，与实际实现不符，属陈旧文档，非代码 stub。

### 四、interacting 分支交互等待循环

`runInstance`（457–651）的 Stage 执行循环中，`let result = await executor.execute()` 之后进入 `while (result.status === 'interacting' || result.status === 'paused')`（548–587）。interacting 分支已接交互等待循环：

1. `markStageStatus(active, stageId, 'interacting')` + 实例状态置 `interacting` + `persistState`（551–553）。
2. `findAskStep(active.state.executedSteps)`（84–94）定位携带 `finalizeMeta.assessResult.askQuestion` 的 interacting Step；无 ask 载荷时 `return`（558）。
3. 构造 `PendingQuestionEntry`（560–570，含 requestId/kind='question'/status='pending'）。
4. `await active.interactions.ask({ entry, ...(signal === undefined ? {} : { signal }) })`（571）—— 引擎级 ask 主通道，await 用户回复（`InteractionManager.ask` 168–186，内部 `ctx.userQuestions.ask` + waiter 汇合）。
5. 回复后 `result = await executor.execute()`（586）从断点续跑（StageExecutor 的 `resumePendingAsk` 639+）。

**结论**：interacting 分支已从「置标记后 return」升级为「await interactions.ask 后再续跑」，符合 7.2 的验收。

### 五、interrupt 取消协作（暂停登记表协作）

interrupt 取消协作已端到端实现，链路如下：

1. **发起暂停**：`pauseStep` → `LifecycleManager.pauseStep`（lifecycle-manager.ts 91–122）→ `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })`（118）→ 登记表 `pausedChildIds` add → `commitStepStatus(..., 'paused', { pausedAt })`。
2. **取消判定（microflow 侧）**：`StageExecutor.processCommandNode` 的 catch（stage-executor.ts 493–502）：`isCancellationError(error) && this.isPausedStep(step.id)` 命中 → `executed.status='paused'`、`state.status='paused'`、`state.pendingPaused=...`、`return 'paused'`（不落 failed、不发 step-failed）。
3. **登记表查询桥接**：`isPausedStep`（stage-executor.ts 629–636）→ `runnerConfig.isPausedChild?.(childId)` → workflow-engine.ts 686 `isPausedChild: (childId) => active.lifecycle.hasPaused(childId)`。
4. **主循环 paused 分支**：workflow-engine.ts 572–577 命中 `result.status === 'paused'` 时仅 `await this.waitForResume(active)`（不落 failed、不推进 Stage、不发射 step-failed）；`waitForResume`（847–864）监听 `signal.aborted` 与 `resumeWaiters`，`notifyResume`（867–876）在 resumeStep/resumeAllSteps 成功后唤醒。
5. **abortInstance 中止传播**：workflow-engine.ts 260–265 `active.controller.abort()` + 遍历 `active.lifecycle.pausedIds` 逐个 `subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })`，随后 aborted 终态 + `emitAborted`。

**结论**：interrupt 取消协作已实现，Step 被 interrupt 打断且登记表命中时保持 paused 不落 failed，符合 7.3 验收。

### 六、5 个事件的补发状态

5 个新增事件（`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`、`sandore/question`、`sandore/permission`）均已补发，且全部走「`emitContained`（Cordis `ctx.events.dispatch('emit')`，892–903）+ `safeAppend`（`session.append`，905–911）」双发：

| 事件 | 发射方法（行号） | 管理器回调接线（行号） | 载荷 |
|---|---|---|---|
| `sandore/step-paused` | `emitStepPaused` 943–951 | lifecycle `emitStepPaused` 745 | `[info, stepId, childId]` |
| `sandore/step-resumed` | `emitStepResumed` 953–961 | lifecycle `emitStepResumed` 746 | `[info, stepId, childId, resumePrompt?]` |
| `sandore/step-retried` | `emitStepRetried` 963–971 | recovery `emitStepRetried` 770 | `[info, stepId, mode]` |
| `sandore/question` | `emitQuestion` 983–991 | interaction `emitQuestion` 719 | `[info, entry]` |
| `sandore/permission` | `emitPermission` 993–1001 | interaction `emitPermission` 720 | `[info, entry]` |

- 与这 5 个事件并列的基础 8 个事件（start/stage-start/stage-completed/step-start/step-completed/step-failed/end/aborted）也已在 913–981 双发。`seam.ts` 共声明 13 个事件（Cordis `Events` 34–48 + Session `SessionEventMap` 51–67），与发射一一对应。
- **结论**：5 个事件均已补发，符合 7.4 验收。

### 七、remote.ts 现有 RPC 清单与缺失的 7 个生命周期 RPC

`SandoreRemote`（`remote.ts`，`extends TypertRemoteService`，`super(ctx, 'sandore')`）现有 **20 个 RPC**：

- 定义 CRUD（6）：`listDefinitions`(128)、`createDefinition`(141)、`updateDefinition`(160)、`deleteDefinition`(179)、`getYaml`(185)、`updateYaml`(191)
- Job CRUD（5）：`listJobs`(211)、`createJob`(222)、`getJob`(242)、`updateJob`(248)、`deleteJob`(266)
- 实例生命周期（5）：`listInstances`(274)、`startInstance`(292)、`deleteInstance`(306)、`getInstanceState`(312)、`abortInstance`(318)
- 产物/转发（4）：`getArtifacts`(332)、`listProviders`(352)、`listModels`(358)、`ping`(120)

**缺失的 7 个生命周期 RPC（7.5 待做）**，按 `specs/lifecycle-rpc/spec.md` 的转调映射：

| 目标 RPC 方法 | 转调 engine 方法 | remote.ts 现状 |
|---|---|---|
| `sandore.replyQuestion` | `replyQuestion(instanceId, requestId, answers)` | 无 |
| `sandore.replyPermission` | `replyPermission(instanceId, requestId, reply)` | 无 |
| `sandore.pauseStep` | `pauseStep(instanceId, stepId)` | 无 |
| `sandore.resumeStep` | `resumeStep(instanceId, stepId, resumePrompt?)` | 无 |
| `sandore.pauseAll` | `pauseAllSteps(instanceId)` | 无 |
| `sandore.resumeAll` | `resumeAllSteps(instanceId, resumePrompt?)` | 无 |
| `sandore.retryStep` | `retryStep(instanceId, stepId, mode, message)` | 无 |

- 命名差异要点：RPC 方法名用 `pauseAll`/`resumeAll`（api.yaml path 亦为 `/pauseAll`/`/resumeAll`），转调的 engine 方法名为 `pauseAllSteps`/`resumeAllSteps`。
- spec 明确 SHALL NOT 添加 `recover`、`getDiscussion`、`addChatMessage`（崩溃恢复走启动自动扫描，讨论数据走宿主 Session 日志直读）。

### 八、remote.ts 的 zod 入参校验范式

`remote.ts` 现有 zod 范式（`import { z } from 'zod'`，非 schemastery）：

1. 文件顶部为每个「对象入参」定义一个 `const XInputSchema = z.object({...})`（55–84），字段用 `z.string()` / `.optional()`。
2. 同步 `export type XInput = z.infer<typeof XInputSchema>`（86–90）。
3. 方法体首行 `const parsed = XInputSchema.parse(input)`（如 143、162、224、250、294），后续只读 `parsed.*`。
4. 标量入参（`id`、`yaml` 字符串）不走 zod，靠 `require*` 守卫（`requireDefinition` 365–371 / `requireJob` 373–379 / `requireInstanceState` 381–387）抛 `SandoreError('NODE_NOT_FOUND')`。

现有 5 个 schema：`CreateDefinitionInputSchema`（yaml）、`UpdateDefinitionInputSchema`（name/version/description?）、`CreateJobInputSchema`（name/workflowId/cwd?）、`UpdateJobInputSchema`（name?/cwd?）、`StartInstanceInputSchema`（jobId/originalInput/cwd?）。

7 个新 RPC 需新增的对象入参按此范式（含枚举约束）：`replyPermission` 的 `reply ∈ 'once'|'always'|'reject'`（engine 签名 seam.ts 90）、`retryStep` 的 `mode ∈ 'continue'|'revert'|'fork'`（`RetryMode`，recovery-manager.ts 34）、`resumeStep`/`resumeAll` 的 `resumePrompt?`、`replyQuestion` 的 `answers`（`AskUserQuestionAnswer`）。错误透传沿用 `SandoreError` code/message 风格（远程层不吞业务错误）。

### 九、remote.spec.ts 测试范式

`remote.spec.ts` 范式（vitest）：

- **harness**（94–154）：`new Context()` → `ctx.provide('storageDomain', new MemoryStorageDomain())` → `await ctx.plugin(SandorePersistence)`；注入 mock `llm`（`listProviders`/`listModels`）；注入 mock `sandoreEngine` —— **当前 mock 仅实现 `startInstance` + `abortInstance`**（142–149），无 reply/pause/resume/retry 方法，因此 7 个生命周期 RPC 的测试尚未覆盖。
- **状态工厂**：`makeState(overrides)`（39–65）构造字段完整的 `WorkflowTaskState`（taskId 必填，其余字段有默认值）。
- **错误断言**：`catchCode(fn)` / `catchCodeAsync(fn)`（71–91）捕获 `SandoreError.code`；异常断言 `await expect(...).rejects.toMatchObject({ code: 'YAML_PARSE' | 'INVALID_OPERATION' | 'NODE_NOT_FOUND' })`。
- **describe 分组**：definition CRUD / job CRUD / instance lifecycle / artifacts & llm forwarding，用 `validV2Yaml` 常量（20–36）。
- 扩展 7 个 RPC 测试时，需在 harness 的 mock engine 中补充 7 个方法，并新增 zod 校验失败、`SandoreError` 透传、no-op（如 retryStep 对 completed）等断言。

### 十、seam.ts 抽象面方法声明

`seam.ts` 定义 `ctx.sandoreEngine` 抽象能力面：

- **`SandoreEngine` 抽象类**（75–105，`extends Service` 并 `implements SandoreEngineSurface`），11 个抽象方法：`startInstance`、`recoverInstance`、`abortInstance`、`replyQuestion`、`replyPermission`、`pauseStep`、`resumeStep`、`pauseAllSteps`、`resumeAllSteps`、`retryStep`、`getState`。
- **`SandoreEngineSurface`**（engine-surface.ts 12–35）为纯 type-only 结构面（tool 包以 `import type` 共享），方法签名与抽象类一致。
- **13 个 `sandore/*` 事件双声明**：Cordis `Events`（34–48）+ `@deepseek-ai/dsh-session/types` 的 `SessionEventMap`（51–67）。
- **`SandoreEngineStub`**（137–190）：11 个方法全部 `throw new Error('...not implemented')`，`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain','agents','userQuestions']`。
- **`UserQuestions`**（115–117）：`ask(request: UserQuestionsRequest): Promise<AskUserQuestionAnswer>`。
- **`SandoreConfig`**（120–129）：`defaultTimeoutMs?/maxConcurrentSteps?/defaultProvider?/defaultModel?`。

**一处 inject 差异**：`SandoreEngineStub.inject`（seam.ts 145，9 项，无 `sandorePersistence`）与 `SandoreEngineRuntime.inject`（workflow-engine.ts 172，10 项，含 `sandorePersistence`）不同——运行时装填 `sandorePersistence`。

### 十一、api.yaml 的 7 个 RPC 描述

`furina/changes/task-4-lifecycle/api.yaml` 用 Swagger 2.0 描述 Task 4 增量（`basePath: /sandore`，各 path 段对应 RPC 方法名；`host.call('sandore.<method>', ...)` 调用）。7 个 path：

| path | tag | summary 要点 |
|---|---|---|
| `/replyQuestion` | Interactions | 回复待处理问答（兼容路径，resolve 内部 Promise 与 ask 的 await 汇合） |
| `/replyPermission` | Interactions | 回复待处理权限请求（镜像兼容路径，无自动审批） |
| `/pauseStep` | Lifecycle | 暂停单个 Step（interrupt 子代理 + 登记表 pausedChildIds） |
| `/resumeStep` | Lifecycle | 恢复单个 Step（followup 子代理 + 移出登记表，可选 resumePrompt） |
| `/pauseAll` | Lifecycle | 暂停实例内全部活跃 Step |
| `/resumeAll` | Lifecycle | 恢复实例内全部已暂停 Step（可选统一 resumePrompt） |
| `/retryStep` | Lifecycle | 按三模式重试失败 Step（continue/revert/fork，`RetryMode` 枚举） |

- 关键 definitions：`ErrorResponse`（code 为 `INVALID_OPERATION / NODE_NOT_FOUND / STEP_EXECUTION / PERSISTENCE_FAILED / OPEN_TURN` 子集）、`PendingInteractionEntry`、`RetryMode`（continue/revert/fork）、`NoopResult`。
- 边界约定（17–19）：不新增 `recover` RPC（崩溃恢复是 `Service.init` 自动扫描）、不新增 `getDiscussion`/`addChatMessage`（讨论走宿主 Session 日志直读）。

## Supplementary Exploration Result

`furina config show experimental.websearch experimental.context7` 返回 `websearch=true, context7=true`；但 Phase 3 对项目代码的探索已完整覆盖 exploreContent 全部要点（8 方法接线、interacting 循环、5 事件、interrupt 协作、remote 清单/缺失 7 RPC/zod 范式、remote.spec 范式、seam 抽象面、api.yaml 7 RPC），信息充分，未触发联网补充探索。
