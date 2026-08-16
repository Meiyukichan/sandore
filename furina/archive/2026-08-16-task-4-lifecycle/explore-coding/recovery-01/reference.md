## Exploration Result

> 说明：`furina config show exploration.reference` 返回空数组（无外部参考材料配置），本次探索全部基于 exploreContent 中指定的本地源码路径（项目内 + `D:\project-code\llm\deepseek-harness`），按 ①–⑧ 逐项落点。

### ① workflow-engine.ts：retryStep/recoverInstance stub、runInstance 主循环、persistState、runnerConfig、续跑机制

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`

**两个「未实现方法」stub 的精确位置与签名**：
- `recoverInstance`（第 311–313 行）：
  ```ts
  async recoverInstance(instanceId: string): Promise<DagRun> {
    throw new SandoreError('SandoreEngineRuntime.recoverInstance is not implemented', 'INVALID_OPERATION');
  }
  ```
- `retryStep`（第 357–359 行）：
  ```ts
  async retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void> {
    throw new SandoreError('SandoreEngineRuntime.retryStep is not implemented', 'INVALID_OPERATION');
  }
  ```
  这二者是 `SandoreEngineRuntime` 中仅剩的两个 stub；其余 9 个实例级方法均已实现（startInstance/getState/abortInstance/replyQuestion/replyPermission/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps）。

**`ActiveInstance` 运行时结构**（第 52–64 行）：`controller: AbortController`、`session: Session`、`hostAgent: Agent`、`definition: WorkflowDefinition`、`interactions: InteractionManager`、`lifecycle: LifecycleManager`、`state: WorkflowTaskState`（可变）、`resumeRequested: boolean`、`resumeWaiters: Array<() => void>`。全部实例存于 `private readonly instances = new Map<string, ActiveInstance>()`（第 170 行）。

**`execute(instanceId)`**（第 363–386 行）：从 `instances` 取 active，`await this.runInstance(active)`，catch 到引擎级故障后落 `failed` 终态并 `emitEnd`。`startInstance` 中是 fire-and-forget 调用 `void this.execute(instanceId)`。

**`runInstance(active)` 主循环**（第 388–574 行）：Stage 级线性循环 `while (stageId !== '')`。每个 Stage 内：
1. 组装 `runnerConfig`（`this.runnerConfig(...)`）、`WorkflowDagNavigator`、`FinalizeManager`、`StageExecutor`（第 401–465 行）。
2. `let result = await executor.execute();`（第 467 行）。
3. **续跑循环**（第 471–510 行）：
   ```ts
   while (result.status === 'interacting' || result.status === 'paused') {
     if (result.status === 'interacting') {
       this.markStageStatus(active, stageId, 'interacting');
       active.state = { ...active.state, status: 'interacting', updatedAt: now() };
       await this.persistState(active);
       const ask = findAskStep(active.state.executedSteps);
       if (ask === undefined) return;               // 无 ask 载荷：保持 interacting 等待后续恢复
       const entry: PendingQuestionEntry = { ... };
       await active.interactions.ask({ entry, ...(signal === undefined ? {} : { signal }) });
     } else {                                       // paused
       await this.waitForResume(active);
     }
     if (signal.aborted) break;
     result = await executor.execute();             // 断点续跑：executor 重跑门禁 + 推进剩余 Step
   }
   ```
   该 `while(interacting || paused)` + 重调 `executor.execute()` 是 lifecycle-01 已实现、recovery-01 可直接复用的续跑机制（`StageExecutor.execute()` 每次调用从内部 `runState` 的 pending 断点续跑，见 ④）。

4. aborted 分支（第 512–524 行）、failed 分支（第 533–549 行）、completed 推进（第 551–568 行），最后落 completed 终态（第 571–573 行）。

**`persistState(active)`**（第 679–689 行）：
```ts
private async persistState(active: ActiveInstance): Promise<void> {
  const persistence = this.persistence();
  if (persistence === undefined) return;
  try { await persistence.saveWorkflowState(active.state); }
  catch (error) { this.ctx.logger.warn(`sandore: persist state failed: ${renderError(error)}`); }
}
```
`persistence()`（第 626–628 行）返回 `this.ctx.get('sandorePersistence')`。

**`runnerConfig(definition, hostAgent, active)`**（第 585–624 行）：返回 `StepRunnerConfig`，含 `defaultTimeoutMs/defaultProvider/defaultModel/skills/mcps/agents/hostAgent`，以及三个注入回调：
- `onChildStarted(stepId, childId)`：把 running Step 的 `sessionMeta` 从合成占位切换为真实 childId（`synthetic: false`）。
- `isPausedChild(childId)`：`active.lifecycle.hasPaused(childId)`。
- `onDelegatedAsk({ childId, output, stepId, stageId })`：转接 `active.interactions.delegateSubagentAsk(...)`。

**暂停等待/唤醒机制**（recovery 续跑可复用）：
- `waitForResume(active)`（第 648–665 行）：`resumeRequested` 已置则消费返回；否则注册 waiter 并监听 `signal.aborted`。
- `notifyResume(active)`（第 668–677 行）：有 waiter 则逐个 resolve，无 waiter 则置 `resumeRequested = true`（处理 resume 先于主循环进入等待的竞态）。
- `resumeStep/resumeAllSteps`（第 338–355 行）在 `lifecycle.resumeStep/resumeAllSteps` 后调用 `this.notifyResume(active)`。

**`onPersist` 逐 Step 持久化钩子**（第 449–464 行）：按 `entry.id` upsert 到 `active.state.executedSteps` 并 `persistState`。

**startInstance 中可复用于冷恢复的资源创建**（第 176–256 行）：`ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup: createHostAgentSetup({ instanceId, engine: this }) })` → `hostAgent`；随后 `ctx.sessions.get(SessionId(instanceId))` 读回 live session 用于事件双发；`new InteractionManager({...})`、`new LifecycleManager({ hostAgent, initialPausedChildIds: state.pausedChildIds, ... })`（**initialPausedChildIds 从快照重建登记表**——崩溃恢复重建登记表的既有入口）。`LifecycleManager` 的 `get pausedIds()`（lifecycle-manager.ts 第 81–83 行）只读投影登记表。

### ② microflow/src/subagents.ts：AgentRegistry.create/resume、SubagentRuntime、Session 事件结构

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.ts`（这是 sandore 自建的**结构类型接缝**，不依赖 DSH 运行时包，宿主注入的真实服务结构兼容即可）。

- `AgentRegistry`（第 103–107 行）：`get(id): Agent | undefined`、`create(options: CreateAgentOptions): Promise<AgentHandle>`、`resume(options: ResumeAgentOptions): Promise<AgentHandle>`。
- `CreateAgentOptions`（第 78–92 行）：
  ```ts
  interface CreateAgentOptions {
    readonly sessionId: SessionId;
    readonly meta?: { cwd?; parentSession?; seedLength?; origin?: 'subagent'; delegationDepth?; agentPreset? };
    readonly seed?: readonly SessionEvent[];
    readonly agentOptions?: AgentOptions;
    readonly signal?: AbortSignal;
    readonly setup?: AgentSetup;
  }
  ```
- `ResumeAgentOptions`（第 95–100 行）：`resumeSessionId: SessionId`、`agentOptions?`、`signal?`、`setup?`（**无 seed**——resume 从持久化 Session 加载）。
- `Agent`（第 37–46 行）：`id/options/session/inbox: { hasPending }/status: 'idle'|'running'/ctx`，以及 `whenIdle(): Promise<void>`。
- `Session`（第 32–34 行）：`{ readonly events: readonly SessionEvent[] }`。
- `SessionEvent`（第 216–218 行）：判别联合，仅建模 `assistant/message`（data: turn/step/message/usage?）与 `assistant/chunk`（data: turn/step/chunk）两类，包络字段 `seq`/`time`。
- `AgentHandle`（第 49–52 行）：`{ agent: Agent; dispose(): Promise<void> }`。
- `AgentSetup`（第 73–75 行）：`(agentCtx: AgentSetupContext) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void`；`AgentSetupCommit`（第 55–57 行）`{ commit(): void }`；`AgentSetupContext`（第 67–70 行）含 `tools.register` 与 `systemPrompt.section`。
- `SubagentRuntime`（第 187–193 行）：
  ```ts
  interface SubagentRuntime {
    startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
    followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
    interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
    listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>;
    start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
  }
  ```
- `SubagentInterruptAuthority`（第 146–148 行）：`{ kind:'user'; parentSessionId }` | `{ kind:'ancestor'; agent: Agent }`。
- `SubagentListEntry`（第 181–184 行）：child（mode one-shot/continuable + label + activity running/inactive + hasChildren）与 diagnostic（reason corrupt/unsupported/unavailable）判别联合。
- `finalAssistantOutput(events)`（第 230–245 行）：最后一条非空 `assistant/message` → 回退累计 `assistant/chunk` text-delta → undefined。

### ③ microflow/src/step-runner.ts：runSubagent / collectSubagentOutput / resumeSubagent、StepRunnerConfig

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/step-runner.ts`

- `StepRunnerConfig`（第 60–90 行）：`defaultTimeoutMs`、`defaultProvider?`、`defaultModel?`、`skills?/mcps?/agents?`、`hostAgent?: Agent`、`onChildStarted?(stepId, childId)`、`onDelegatedAsk?(input: DelegatedAskContext) => Promise<boolean>|boolean`、`isPausedChild?(childId) => boolean`。
- `StepRunner.run(request)`（第 348–369 行）：按 `step.command.type` 分发 shell/prompt/agent/skill/mcp。
- `runSubagent(command, request)`（第 489–515 行）：agentParamsTemplate 时先 `fillParams`；`resolveProviderModel` → `buildTaskText` → `buildPromptText` → `ctx.subagents.startContinuable({ provider, label, request: { prompt, parent: resolveParent(), agentOptions }, signal })` → `this.config.onChildStarted?.(step.id, started.childId)` → `return this.collectSubagentOutput(command.type, started.childId, step.id, stageId)`。
- `resumeSubagent(commandType, childId, stepId, stageId)`（第 524–531 行，**lifecycle-01 已抽取**）：直接 `return this.collectSubagentOutput(commandType, childId, stepId, stageId)`。
- `collectSubagentOutput(...)`（第 534–576 行，首跑与暂停续跑共用）：`ctx.agents.get(childId)` → 不存在抛 `STEP_EXECUTION` → `await child.whenIdle()` → `finalAssistantOutput(child.session.events)` → 无输出抛 `STEP_EXECUTION` → 有 `onDelegatedAsk` 时进入标记块转接循环（`MAX_DELEGATED_ASK_ROUNDS = 3` + `sameOutput` 无进展守卫）→ 返回 `{ output, sessionMeta: { childId, synthetic: false, command } }`。
- `resolveParent()`（第 621–623 行）：优先 `config.hostAgent`，缺省 `createHostAgentStub()`（每次新对象）。

### ④ microflow/src/stage-executor.ts：pendingPaused / pendingAsk 断点续跑状态机

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`

- `StageRunState`（第 189–213 行）：持有 `stepIndex/executedSteps/previousOutputs/passThroughVars/batch/batchIndex/nextBatch/status/errorDetail`，以及两个断点：
  - `pendingAsk?: { nodeId; step; executed; assessResult: FinalizeAssessResult }`（ask 断点）。
  - `pendingPaused?: { nodeId; step; executed; childId }`（paused 断点，childId 取 `realChildIds.get(step.id) ?? childId`）。
- `execute()`（第 246–267 行）：首次 `initState()`；然后依次 `resumePendingPaused` → `resumePendingAsk` → `runLoop` → `buildResult`。每次 `execute()` 调用即从保留断点续跑（幂等，引擎主循环反复调用）。
- `resumePendingPaused`（第 530–547 行）：取 `pending.paused` 清空，非 agent/skill/mcp 命令即 failed；否则 `this.runner.resumeSubagent(command.type, childId, step.id, stageDef.id)` → `finishCommandNode(..., resumed=true)`。
- `resumePendingAsk`（第 559–600 行）：`finalizeManager.finalizeStepAfterAsk(..., assessResult)`；error → failed；否则 `resolveNextNodes` 推进下一批。
- `processCommandNode`（第 380–454 行）：runner.run 成功 → `finishCommandNode`；catch 取消类错误且 `isPausedStep(step.id)` → Step 置 paused、`state.pendingPaused = {...}`、return 'paused'；否则 failed。
- `finishCommandNode`（第 461–527 行）：回填 output/sessionMeta → `finalizeManager.finalizeStep`；`type==='ask'` → 保留 `state.pendingAsk`、`status='interacting'`、return 'ask'；`type==='error'` → failed；否则 `resolveNextNodes` → `nextBatch`。

### ⑤ workflow/src/schema.ts：RetryRecordSchema / retryHistory / parentSessionId / sessionMeta

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

- `RetryRecordSchema`（第 301–307 行）：
  ```ts
  z.object({
    mode: z.enum(['continue', 'revert', 'fork']),
    timestamp: z.string(),
    userMessage: z.string(),
    revertMessageId: z.string().optional(),
    result: z.enum(['running', 'completed', 'failed']),
  })
  ```
- `ExecutedStepDefaultSchema`（第 310–336 行）中与 recovery 相关字段：`retryHistory: z.array(RetryRecordSchema).optional()`（第 333 行）、`parentSessionId: z.string().optional()`（第 334 行）、`sessionMeta: StepSessionMetaSchema.optional()`（第 321 行）、另有 `pausedAt/resumedAt/resumePrompt/sessionMessages/pauseEntryId/loopIteration/loopMeta` 等清残留字段、`output`。
- `StepSessionMetaSchema`（第 185–190 行）：`{ childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']); hostSessionId?: z.string() }`。
- `FinalizeAssessResultSchema`（第 246–253 行）：`completionType`、`passThroughVars`、`askQuestion?`、`errorDetail?`、`forkSessionId: z.string()`、`assessmentRaw`。
- `WorkflowTaskStateSchema`（第 363–384 行）：`executedSteps`、`pausedChildIds: z.array(z.string())`、`stageContracts` 等；`ExecutedStepDefault` 的 TS 类型在 `types.ts` 第 129–155 行（含 `retryHistory?/parentSessionId?`）。
- 存储层（第 408–416 行）：`sandoreDomainSpec` 三表 `definitions/jobs/state`，其中 `state: domainTable<string, WorkflowTaskState>`（key = instanceId）。

### ⑥ DSH 参考源码真实语义

#### sessions.fork(source, boundary?, childSessionId?)
文件：`D:/project-code/llm/deepseek-harness/packages/core/session/src/index.ts`

- 签名（第 1081 行）：`fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session`，`SessionForkSource = Session | SessionId`（第 761 行）。
- 语义（第 1067–1138 行）：
  - `boundary` 为**含端点**的源事件 seq；省略 = 源当前最后一条事件（空源省略 = 空 child）。
  - `_forkSeed`（第 1097–1138 行）校验：`boundary` 必须为非负安全整数（否则 `INVALID_BOUNDARY`）；`boundary >= events.length` 或 `events[boundary].seq !== boundary`（非连续 seq）均抛 `INVALID_BOUNDARY`；前缀内最后一条 `turn/start`/`turn/end` 若是 `turn/start`（未闭合 turn）抛 `OPEN_TURN`（消息：`fork boundary ${boundary} ... ends inside open turn ${turn}`）。
  - 返回 `events.slice(0, boundary + 1)` 作 seed。
- `_resolveForkSource`（第 1140–1153 行）：字符串 id 未知抛 `SESSION_NOT_FOUND`；Session 对象非 store live 实例抛 `SESSION_NOT_LIVE`。
- child 已存在抛 `SESSION_ALREADY_EXISTS`（第 1082–1084 行）。
- `create` 时的 meta（第 1087–1094 行）：`cwd`（继承源 header）、`parentSession: liveSource.id`、`seedLength: seed.length`。
- `SessionHeader`（`types.ts` 第 61–99 行）字段：`version/id/createdAt/cwd?/parentSession?/seedLength?/origin?: 'subagent'/delegationDepth?/agentPreset?`。
- `SessionEvent` 包络（`types.ts` 第 404–436 行）：`{ type; seq; time; data; ignorable? }` + 表面事件（user/message、assistant/message、tool/result）额外 `sourceEventSeqs?/surfaceOp?`。`turn/start`/`turn/end` 载荷（第 243/252 行）为 `{ turn }` / `{ turn; reason }`。

#### agents.create / agents.resume（含 seed）
文件：`D:/project-code/llm/deepseek-harness/packages/core/agent/src/index.ts`

- `CreateAgentOptions`（第 80–133 行）：`sessionId`、`meta?{cwd,parentSession,seedLength,origin:'subagent',delegationDepth,agentPreset}`、`seed?: readonly SessionEvent[]`（**必须是 seq 0 起的连续、lossless-JSON、无未闭合 turn/step、无悬空 tool call**）、`agentOptions?`、`signal?`、`setup?: AgentSetup`。
- `ResumeAgentOptions`（第 139–156 行）：`resumeSessionId`、`agentOptions?`、`signal?`、`setup?`（**无 seed**，从持久化 Session 加载；resume 时 setup 重跑，发布前执行）。
- `AgentRegistry.create`（第 405 行）/ `resume`（第 424 行）委托注册的 `AgentFactory.createAgent/resume`。`AgentHandle`（第 172–175 行）`{ agent; dispose() }`，dispose 是 capability（仅持有者可拆）。
- setup 契约：发布前执行，可返回 `AgentSetupCommit`（同步 `commit()` 在发布边界前调用）；setup 抛错/commit 抛错/owner 释放会整体回滚，不发布 session/agent id。

#### subagent followup 冷恢复
文件：`D:/project-code/llm/deepseek-harness/packages/subagent/subagent/src/continuation.ts`（对外在 `index.ts` 第 231–257 行）

- `followup(parent, childId, content, options)`（第 476–505 行）：`locks.run(childId, ...)` 内查 `activations.get(childId)`；absent → `coldResume(parent, childId, content, options)`；disposal 竞争 → 等待释放后重试冷恢复。
- `coldResume`（第 883–932 行）：`persistence.inspect(childId, signal)` → `authorizeLineage(parent, childId, loaded.meta.parentSession)` → `foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))`（无 continuable descriptor 抛 `NOT_RESUMABLE`）→ `materialize`（`create === undefined` 时走 `ctx.agents.resume({ resumeSessionId: childId, agentOptions, signal, setup })`，第 1010–1015 行；`create` 存在时走 `ctx.agents.create({ sessionId: childId, meta, seed, ... })`，第 1016–1023 行）→ `submitMaterialized`。
- `interrupt`（第 528–568 行）：absent target 是 accepted no-op；ancestor authority 需 `ctx.agents.get(caller.id) === caller`（stale 拒 `UNAUTHORIZED`）、不能自中断；user authority 校验 `parentSession === authority.parentSessionId`。
- `listChildren`（`index.ts` 第 339–341 行）：live-preferred（live session store + optional persistence），不加载/不 resume Agent。

### ⑦ workflow/tests/mocks：fork / agents resume-create seed / storage-domain entries

目录：`D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/`

- `sessions.ts` `FakeSessionStore.fork(source, boundary?, childSessionId?)`（第 40–50 行，seam-01 已加）：
  ```ts
  fork(source: string, boundary?: number, childSessionId?: string): FakeSession {
    const sourceSession = this.sessions.get(source);
    const forked = new FakeSession();
    if (sourceSession !== undefined) {
      const end = boundary === undefined ? sourceSession.events.length - 1 : boundary;
      forked.events.push(...sourceSession.events.slice(0, end + 1));
    }
    const key = childSessionId ?? `session-${++this.counter}`;
    this.sessions.set(key, forked);
    return forked;
  }
  ```
  **注意**：当前 mock 是简单 slice 拷贝，**不含** DSH 的 boundary 非负/连续 seq 校验与 `OPEN_TURN`（未闭合 turn）校验；`FakeSession.events` 元素是 `{ type, data }`（无 seq/time 包络，见第 10–17 行），因此 mock 层无法直接复现 DSH 的 `events[boundary].seq !== boundary` 判定。
- `agents.ts` `FakeAgentRegistry`：
  - `create(options)`（第 110–126 行）：记录 `options.meta?.cwd` 到 `createCwds`，执行 `runSetup(options.setup)`，`new FakeAgent(options.sessionId, options.agentOptions)`，并在注入 sessions 时 `sessions.create(options.sessionId)`。**当前 create 忽略 `options.seed`**（未把 seed 事件回放进 FakeAgent.session.events）。
  - `resume(options)`（第 128–139 行）：`runSetup(options.setup)`，`existing ?? new FakeAgent(options.resumeSessionId, options.agentOptions)`。**当前 resume 不从持久化 Session 恢复 events**（无 seed 回放）。
  - `setupCount/setupError`（第 100–102 行）支持 setup 回放/抛错断言。
- `storage-domain.ts` `MemoryKvTable`（第 13–49 行）：实现 `get/entries()/keys()/size/put/delete/update`（`entries(): IterableIterator<[K, V]>` 可扫描 state 表；`update` 缺 key 抛 `DomainError('missing-key')`）。`MemoryStorageDomain.open/get` 提供域级句柄。`SandorePersistence.state` 即 `KvTable<string, WorkflowTaskState>`（persistence.ts 第 57–59 行）。
- `subagents.ts` `FakeSubagents`：`followup`（第 58–62 行，记录 + childStates 置 running）、`interrupt`（第 64–69 行，记录 + childStates 置 interrupted + 触发 `whenIdleCancels` 回调）、`listChildren`（第 71–86 行，按 `childParent` 过滤）、`childStatus` 查询。

### ⑧ 现有 workflow-engine.spec.ts 对「未实现方法」的断言

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`

- 第 394–400 行：
  ```ts
  it('throws INVALID_OPERATION with not implemented for the 2 remaining unimplemented methods', async () => {
    const { engine } = await harness();
    await expect(engine.recoverInstance('x')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.recoverInstance('x')).rejects.toThrow(/not implemented/);
    await expect(engine.retryStep('x', 's', 'continue', 'm')).rejects.toMatchObject({ code: 'INVALID_OPERATION' });
    await expect(engine.retryStep('x', 's', 'continue', 'm')).rejects.toThrow(/not implemented/);
  });
  ```
- 结论：lifecycle-01 更新后，`SandoreEngineRuntime` 中仍抛 `INVALID_OPERATION`（`not implemented`）的方法**只剩 `recoverInstance` 与 `retryStep` 两个**（测试名即「2 remaining unimplemented methods」）。其余生命周期方法已实现并有独立断言（第 402–414 行：pause/resume/reply 对未知实例抛 `NODE_NOT_FOUND`）。

### 附：工具层与 seam 落点（recovery-01 直接相关）

- `packages/sandore/tool/src/index.ts`：`sandore_retryStep` 工具（第 341–347 行）已存在，参数 schema（第 144–156 行）为 `{ stepId, mode: enum['continue','revert','fork'], message }`，execute 经 `runUnlessCompleted(engine, instanceId, 'sandore_retryStep', () => engine.retryStep(...))`（第 223–235 行：仅 completed 实例返回 no-op，其余直接转调）。**没有 `sandore_recoverInstance` 工具**；recover 仅存在于 `SandoreEngineSurface`（`engine-surface.ts` 第 16 行）与 `seam.ts` 抽象方法（第 83 行）。
- `packages/sandore/workflow/src/host-agent.ts`：`createHostAgentSetup({ instanceId, engine })`（第 46–58 行）生成的 setup 注册 8 个工具 + 编排器 system prompt，注释明确「create 与 resume 共用」（供 `agents.create` 与冷恢复 `agents.resume` 复用）。
- `packages/sandore/workflow/src/lifecycle-manager.ts`：`LifecycleManagerOptions.initialPausedChildIds`（第 47 行）+ `pausedIds` 只读投影（第 81–83 行），是崩溃恢复重建登记表的既有接口；`resumeStep`（第 125–142 行）内 `followup(hostAgent, childId, text(resumePrompt ?? 默认提示))` + 移出登记表 + `commitStepStatus(running, { resumedAt, resumePrompt })`。
- recovery-01 的 plan.json 目标（`furina/changes/task-4-lifecycle/plan.json`，id=`recovery-01`，status=in_progress）：新建 `workflow/src/recovery-manager.ts` + `recovery-manager.spec.ts`，实现 retryStep 三模式（continue=followup / revert=fork 安全边界+agents.create({seed}) / fork=fork+新 agent）、`recoverInstance`（复用 per-instance 恢复例程）与 `recoverOrphanedInstances`（state 表 entries 扫描跳过终态，宿主 `agents.resume` 冷恢复 + 子代理 `followup` 冷恢复 + paused 重建登记表 + 合成 session 标 failed，返回 `{ recovered, errors }`）。

## Supplementary Exploration Result

`experimental.websearch=true`、`experimental.context7=true`，但 Phase 3 已基于本地源码（项目内 + DSH 参考源码）取得充分且精确的落点信息，无需联网补充；本轮未使用 websearch / context7。
