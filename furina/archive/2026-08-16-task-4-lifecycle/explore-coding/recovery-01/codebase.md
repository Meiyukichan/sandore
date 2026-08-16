## Exploration Result

Phase 3（furina-codebase 探索）目标 `docs/codebase` 为空目录，无返回结果。全部结论来自 Phase 4 手动补充探索。

## Supplementary Exploration Result

### 需求理解（What / Boundaries / Goal）

- **What**：Task 4 recovery-01（`furina/changes/task-4-lifecycle/plan.json` 中 id=`recovery-01`，status=`in_progress`）——新建 `packages/sandore/workflow/src/recovery-manager.ts` 实现「retryStep 三模式（continue/revert/fork）」与「崩溃恢复（recoverInstance 单实例 + recoverOrphanedInstances 启动扫描）」。当前仓库尚无 `recovery-manager.ts` 文件。
- **Boundaries**：探索范围限定于 `packages/sandore/{microflow,workflow}` 的引擎/执行器/schema/测试桩，以及 DSH 参考源码 `D:\project-code\llm\deepseek-harness` 的 `packages/core/session`、`packages/core/agent`、`packages/subagent/subagent` 三包。不涉及 RPC 层（`remote.ts`，属 engine-rpc-01）。
- **Goal**：确认 recovery-01 各落点的当前实现状态（stub 位置、可复用的续跑机制、schema 字段、测试桩能力、DSH 真实语义、存量测试断言），供后续实现与 TDD 使用。
- **Project Context**：sandore 为 pnpm monorepo，源码在 `packages/sandore/*`（无 `src/` 顶层目录）。workflow 引擎（`workflow-engine.ts`）是 Stage 级线性主循环运行时；microflow 提供 Step 执行/Stage 调度/收尾/循环等子能力；recovery-01 依赖 seam-01/host-agent-01/interaction-01/lifecycle-01（均已 done）。

### ① workflow-engine.ts 的 stub 位置与主循环（`packages/sandore/workflow/src/workflow-engine.ts`）

- `recoverInstance` stub：第 311–313 行，`throw new SandoreError('SandoreEngineRuntime.recoverInstance is not implemented', 'INVALID_OPERATION')`。
- `retryStep` stub：第 357–359 行，`throw new SandoreError('SandoreEngineRuntime.retryStep is not implemented', 'INVALID_OPERATION')`，签名 `(instanceId, stepId, mode: 'continue'|'revert'|'fork', message): Promise<void>`。
- 其余 6 个生命周期方法已接线：`replyQuestion`（315–321）、`replyPermission`（323–329）、`pauseStep`/`resumeStep`（332–342）、`pauseAllSteps`/`resumeAllSteps`（345–355），均委托 `InteractionManager` / `LifecycleManager`。
- `execute(instanceId)`（363–386）：fire-and-forget 入口，`runInstance` 抛错时落 `failed` 终态 + `emitEnd`。
- `runInstance(active)`（388–574）：置 `running` → `emitStart` → 构造 `runnerConfig`/`WorkflowDagNavigator`/`FinalizeManager` → `while(stageId !== '')` 线性 Stage 主循环 → 每个 Stage 新建 `StageExecutor` 并 `await executor.execute()` → **交互/暂停续跑循环**（471–510）：`while (result.status === 'interacting' || result.status === 'paused')`，`interacting` 分支走 `interactions.ask`（await 用户回复），`paused` 分支走 `waitForResume(active)`（等待 `resumeStep`/`resumeAllSteps` 的 `notifyResume` 或 `signal.aborted`）→ 循环末尾 `result = await executor.execute()` 从断点续跑（StageExecutor 内部 `runState` 保留 `pendingAsk`/`pendingPaused`）。这是 recovery-01 可复用的「断点续跑 + while 等待循环」机制。
- `runnerConfig(definition, hostAgent, active)`（585–624）：返回 `StepRunnerConfig`，注入 `onChildStarted`（把真实 childId 写回 `sessionMeta`）、`isPausedChild`（查 `lifecycle.hasPaused`）、`onDelegatedAsk`（子代理 `[[SANDORE_ASK]]` 转接）。
- `persistState(active)`（679–689）：`persistence.saveWorkflowState(active.state)`（`state.put(taskId, state)` 全量覆盖），异常仅 `logger.warn`。
- 关键发现（影响「重跑 runInstance」的续跑落点）：
  - `WorkflowDagNavigator` 构造函数（`dag-navigator.ts` 71–82）把 `currentStageId` 硬编码为 `stageOrder[0]`，**不从 `active.state.currentStageId` / `active.state.stageContracts` 播种**；`getState` 兜底读 `persistence.state.get(instanceId)`（259–270），但 `runInstance` 重跑时会从第一个 Stage 重新开始，而非从快照中的 `currentStageId` 续跑。恢复实现若要「DAG 从该 Step 继续推进」，需先重建导航器当前 Stage/契约（当前未实现）。
  - `StageExecutor.runState`（含 `pendingAsk`/`pendingPaused` 断点）是 `StageExecutor` 实例内存态，Stage 循环每次新建 executor，进程重启后断点丢失；崩溃恢复只能按 crash-recovery spec 的「Step 分类恢复」策略（running/interacting → followup 冷恢复、paused → 重建登记表）处理，而非直接复用 `runState`。
- 已存在事件双发方法：`emitStepPaused`（744）、`emitStepResumed`（754）、`emitQuestion`（774）、`emitPermission`（784）；**`emitStepRetried` 尚不存在**（`sandore/step-retried` 仅在 `seam.ts` 的 `Events`/`SessionEventMap` 双声明，43 行与 61 行），recovery-01 需补发。
- 注入面：`static inject = ['sessions','sessionPersistence','subagents','agents','llm','shell','fs','storageDomain','userQuestions']`（168 行）；`instances` 为 `Map<string, ActiveInstance>`；`TERMINAL_STATUSES = completed|failed|aborted`（67 行）。

### ② microflow/src/subagents.ts 的接缝签名（`packages/sandore/microflow/src/subagents.ts`）

- `AgentRegistry`（103–107）：`get(id): Agent | undefined`、`create(options: CreateAgentOptions): Promise<AgentHandle>`、`resume(options: ResumeAgentOptions): Promise<AgentHandle>`。
- `CreateAgentOptions`（78–92）：`sessionId`、`meta?`（`cwd`/`parentSession`/`seedLength`/`origin:'subagent'`/`delegationDepth`/`agentPreset`）、`seed?: readonly SessionEvent[]`、`agentOptions?`、`signal?`、`setup?`。
- `ResumeAgentOptions`（95–100）：`resumeSessionId`、`agentOptions?`、`signal?`、`setup?`（**无 seed 字段**）。
- `Agent`（37–46）：`id`/`options`/`session`/`inbox: { hasPending: boolean }`/`status: 'idle'|'running'`/`ctx`/`whenIdle(): Promise<void>`。
- `Session`（32–34）：`{ readonly events: readonly SessionEvent[] }`。
- `SubagentRuntime`（187–193）：`startContinuable(spec)`、`followup(parent, childId, content, options): Promise<MessageId>`、`interrupt(targetSessionId, authority)`、`listChildren(parentSessionId, signal?)`、`start(name, request)`。
- `SubagentFollowupOptions`（140–143）：`{ source: MessageSource; signal: AbortSignal }`。
- `SubagentInterruptAuthority`（146–148）：`{kind:'user'; parentSessionId}` | `{kind:'ancestor'; agent: Agent}`。
- `SessionEvent`（216–218）：仅精确建模 `assistant/message` 与 `assistant/chunk` 两类（含 `seq`/`time` 包络），`finalAssistantOutput(events)`（230–245）按「最后一条非空 assistant/message → 回退累积 text-delta」选子代理最终输出。

### ③ microflow/src/step-runner.ts（`packages/sandore/microflow/src/step-runner.ts`）

- `StepRunnerConfig`（60–90）：`defaultTimeoutMs`、`defaultProvider?`/`defaultModel?`、`skills?`/`mcps?`/`agents?`、`hostAgent?`、`onChildStarted?`、`onDelegatedAsk?`、`isPausedChild?`。
- `runSubagent`（489–515）：`ctx.subagents.startContinuable({provider, label, request:{prompt, parent, agentOptions}, signal})` → `onChildStarted` → `collectSubagentOutput`。
- `collectSubagentOutput`（534–576）：`ctx.agents.get(childId)` → `whenIdle()` → `finalAssistantOutput` → 可选 `onDelegatedAsk` 转接循环（最大 3 轮 + 无进展 break）→ 返回 `{ output, sessionMeta: { childId, synthetic:false, command } }`。
- `resumeSubagent`（524–531，lifecycle-01 已抽取）：pause 后 `resumeStep` 的 followup 之后被引擎续跑路径调用，等价 `collectSubagentOutput` 尾段（重新 whenIdle + final output）。**recovery-01 的 continue/revert/fork 续跑收尾可直接复用此方法与 `collectSubagentOutput` 的共享后处理（whenIdle + finalAssistantOutput）**。

### ④ microflow/src/stage-executor.ts 断点续跑状态机（`packages/sandore/microflow/src/stage-executor.ts`）

- `StageRunState`（189–213）：内存态字段 `stepIndex`/`executedSteps`/`previousOutputs`/`passThroughVars`/`batch`/`batchIndex`/`nextBatch`/`status`/`errorDetail` + 两个断点：
  - `pendingAsk`（200–205）：ask 中断的 Step + `assessResult`，`resumePendingAsk`（559–600）重跑门禁（`finalizeStepAfterAsk`）后 `resolveNextNodes` 推进。
  - `pendingPaused`（207–212）：被 interrupt 且命中暂停登记表的子代理 Step，`resumePendingPaused`（530–547）调用 `runner.resumeSubagent` 重新收集输出后走 `finishCommandNode(..., resumed=true)`。
- `execute()`（246–267）：首次 `initState()`；有 `pendingPaused` 先 `resumePendingPaused`，有 `pendingAsk` 再 `resumePendingAsk`，最后 `runLoop`。
- 取消类错误分支（434–443）：`isCancellationError(error) && this.isPausedStep(step.id)` → Step 置 `paused` + `state.pendingPaused` + 返回 `'paused'`（不落 failed）；`isPausedStep`（550–556）经 `realChildIds`（`onChildStarted` 记录）反查 `runnerConfig.isPausedChild`。
- 说明：以上断点均为 executor 实例内存态，跨进程不可恢复（见①）。

### ⑤ workflow/src/schema.ts 重试/血缘字段（`packages/sandore/workflow/src/schema.ts`）

- `RetryRecordSchema`（301–307）：`mode: enum(['continue','revert','fork'])`、`timestamp`、`userMessage`、`revertMessageId?: string`、`result: enum(['running','completed','failed'])`。
- `ExecutedStepDefaultSchema`（310–336）相关字段：`sessionMeta: StepSessionMetaSchema.optional()`（`StepSessionMetaSchema` 185–190：`childId`/`synthetic`/`command`/`hostSessionId?`）、`retryHistory: z.array(RetryRecordSchema).optional()`（333）、`parentSessionId: z.string().optional()`（334）、`finalizeMeta`（322，含 `assessResult`/`gateResult`）、`pausedAt`/`resumedAt`/`resumePrompt`/`sessionMessages`/`pauseEntryId`（326–330，retry 状态清理要清除的残留字段）。
- `WorkflowTaskStateSchema`（363–384）：全量快照含 `status`/`currentStageId`/`executedSteps`/`stageInfos`/`pendingInteractions`/`pendingQueue`/`visitCounts`/`passThroughVars`/`activeLoopIterationStack`/`activeLoopNodeId`/`activeLoopStack`/`pausedChildIds`/`stageContracts`/`createdAt`/`updatedAt`。`retryHistory`/`parentSessionId` 目前仅有 schema/type 声明，无运行时代码写入。
- 存储域三表（`sandoreDomainSpec` 408–416）：`definitions`/`jobs`/`state`，`state` 表 `domainTable<string, WorkflowTaskState>`（key=instanceId），`saveWorkflowState` 在 `persistence.ts` 65–67 行 `state.put(taskId, state)`。

### ⑥ DSH 参考源码真实语义

`packages/core/session/src/index.ts`（`sessions.fork`）：

- `SessionForkErrorCode`（771–776）：`SESSION_NOT_FOUND` / `SESSION_NOT_LIVE` / `SESSION_ALREADY_EXISTS` / `INVALID_BOUNDARY` / `OPEN_TURN`；错误类型 `SessionForkError`（779–784）。
- `fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session`（1081–1095）：`boundary` 为**含端点（inclusive）**的源事件 seq；省略 = 源当前最后一个事件（空源省略 → 空子会话）。child 以 `seed`（前缀拷贝）+ `meta: { cwd(继承自源 header), parentSession: source.id, seedLength: seed.length }` 创建。
- `_forkSeed`（1097–1138）校验顺序：boundary 必须为非负安全整数（否则 `INVALID_BOUNDARY`）；`boundary < events.length` 且 `events[boundary].seq === boundary`（连续 seq，否则 `INVALID_BOUNDARY`）；最后取 `events.slice(0, boundary+1)` 中最后一个 `turn/start` 或 `turn/end`，若为 `turn/start`（落在未闭合 turn 内）抛 `OPEN_TURN`（含 `data.turn`）。返回 `events.slice(0, boundary+1)`。
- `_resolveForkSource`（1140–1153）：字符串 id 查不到 → `SESSION_NOT_FOUND`；Session 对象不是 store 的 live 实例 → `SESSION_NOT_LIVE`。

`packages/core/agent/src/index.ts`（`agents.create` / `agents.resume`）：

- `CreateAgentOptions`（80–133）：`sessionId`、`meta?`（`cwd`/`parentSession`/`seedLength`/`origin:'subagent'`/`delegationDepth`/`agentPreset`）、`seed?: readonly SessionEvent[]`（注释：fork 提供的已完成 turn 平衡前缀，需从 seq 0 连续、仅 lossless-JSON、不含未闭合 turn/step 或悬空 tool call）、`agentOptions?`、`signal?`、`setup?`。
- `ResumeAgentOptions`（139–156）：`resumeSessionId`、`agentOptions?`、`signal?`、`setup?`（**无 seed，恢复即加载持久化 Session**）。
- `AgentRegistry.create`（405–415）/`resume`（424–430）：都经 `requireFactory()` 后 `Reflect.apply` 到工厂的 `createAgent`/`resume`；`resume` 语义是「先 `sessionPersistence.prepare` 加载持久化 Session，再 mint agentCtx + await setup，发布前未公开」（工厂侧）。

`packages/subagent/subagent/src/continuation.ts`（`followup` 冷恢复）：

- `followup(parent, childId, content, options)`（476–505）：`assertAdmitting(parent)`（父授权）→ 在 child 锁内查 `activations.get(childId)`：存在 → `submitAdmitted`（入 inbox 队列）；不存在 → `coldResume`。
- `coldResume`（883–932）：`persistence.inspect(childId, signal)` 加载持久化 Session → `authorizeLineage(parent, childId, loaded.meta.parentSession)`（parent 必须是持久化 header 记录的直系父）→ `foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength))`（只折叠子日志自身后缀）→ 若 descriptor 缺失或 `mode !== 'continuable'` 抛 `NOT_RESUMABLE` → `materialize`（`create===undefined` 时走 `ctx.agents.resume({ resumeSessionId: childId, agentOptions, signal, setup })`，1010–1015）→ `submitMaterialized` → `submitAdmitted`（投递 content）。
- `interrupt(targetSessionId, authority)`（528–559）：absent target 是接受的 no-op；`ancestor` 权限要求 `ctx.agents.get(caller.id) === caller`（exact live）且 `caller.id !== target`；`user` 权限校验 `header.parentSession === authority.parentSessionId`。
- 冷恢复要点：absent child 的 followup 自动从持久化 Session 冷恢复（无需显式 resume）；continuable child 的持久化 descriptor 是唯一重建输入。

### ⑦ workflow/tests/mocks 现状

- `sessions.ts`（`FakeSessionStore.fork`，40–50）：`fork(source, boundary?, childSessionId?)` 从源会话复制到 boundary（`end = boundary ?? events.length-1`，`slice(0, end+1)` 含端点）登记为新子会话。**mock 版不做 DSH 的 OPEN_TURN/INVALID_BOUNDARY 校验**。
- `agents.ts`（`FakeAgentRegistry`，95–154）：`create` 记录 `meta.cwd`、回放 `setup`、新建空 `FakeAgent` 并注册、联动 `sessions.create(sessionId)`；`resume` 回放 `setup`、复用已注册 agent 或新建。**当前 mock 的 create/resume 均不消费 `options.seed`**（`seed` 字段仅在 `subagents.ts` 的 `CreateAgentOptions` 声明，mock 不把 seed 事件回放进 `FakeAgent.session.events`）；recovery-01 的 revert/fork 测试若需断言「新 agent 从 forked 前缀续跑」，需要扩展该 mock 或自行注入带 seed 的 agent。
- `storage-domain.ts`（`MemoryKvTable`，13–49）：提供 `get`/`entries()`/`keys()`/`size`/`put`/`delete`/`update`；`entries()` 返回 `IterableIterator<[K,V]>`，可直接用于「state 表 entries 扫描」（对应 `recoverOrphanedInstances` 遍历）。
- `subagents.ts`（`FakeSubagents`，38–103）：维护 `childParent`/`childStates` 与 interrupt→followup 状态机；`interrupt` 触发 `whenIdleCancels` 注册的取消钩子（模拟 whenIdle 被打断）；`listChildren` 遍历同父 child 返回 `continuable` 条目。recovery 测试可借 `followups`/`interrupts`/`whenIdleCancels` 断言冷恢复路径。

### ⑧ 现有 workflow-engine.spec.ts 对未实现方法的断言

`packages/sandore/workflow/src/workflow-engine.spec.ts`：

- 第 394–400 行测试名：`'throws INVALID_OPERATION with not implemented for the 2 remaining unimplemented methods'`——**仅剩 `recoverInstance` 与 `retryStep` 两个未实现方法**，均断言 `rejects.toMatchObject({ code: 'INVALID_OPERATION' })` 且 `rejects.toThrow(/not implemented/)`。
- 其余已接线方法的边界断言：pause/resume 对未知实例 `NODE_NOT_FOUND`（402–408）；replyQuestion/replyPermission 未知实例 `NODE_NOT_FOUND`（410–414）；abortInstance 对 completed 实例 `INVALID_OPERATION`（720–733）。
- 说明：实现 recovery-01 后，上述第 394–400 行断言需改为「真实行为」断言（或移入 recovery-manager.spec.ts），与 plan.json 中 engine-rpc-01 的「8 个实例方法不再抛 not implemented」验收一致（recovery-01 只覆盖 recoverInstance/retryStep 两项）。

### 相关落点文件清单（绝对路径）

- `D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\dag-navigator.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\engine-surface.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\lifecycle-manager.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\persistence.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\workflow-engine.spec.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\{sessions,agents,subagents,storage-domain}.ts`
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\{subagents,step-runner,stage-executor}.ts`
- DSH 参考：`D:\project-code\llm\deepseek-harness\packages\core\session\src\index.ts`、`D:\project-code\llm\deepseek-harness\packages\core\agent\src\index.ts`、`D:\project-code\llm\deepseek-harness\packages\subagent\subagent\src\continuation.ts`
