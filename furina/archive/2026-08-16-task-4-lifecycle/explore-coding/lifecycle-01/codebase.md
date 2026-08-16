## Exploration Result

`furina config show project.sourcecode codebases` 返回 `codebases=[{"path":"docs/codebase","description":"codebase dir of current project, ..."}]`。经检查 `D:/project-code/llm/sandore/docs/codebase` 为空目录（无任何文件），Phase 3（furina-codebase 遍历 codebases list）无结果。因此本次探索全部由 Phase 4 手动补充探索完成；真实代码位于 `packages/sandore/{microflow,workflow,tool}/`，与 exploreContent 所列文件一一对应。

## Supplementary Exploration Result

> 说明：以下所有事实均来自实际代码。行号以探索时（2026-08-16）文件为准。所有路径均为绝对路径。

### ① workflow-engine.ts — ActiveInstance / instances / persistState / 双发 / runnerConfig / runInstance / abortInstance

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`

**ActiveInstance 结构（L51-58）**：
```ts
interface ActiveInstance {
  readonly controller: AbortController;
  readonly session: Session;
  readonly hostAgent: Agent;
  readonly definition: WorkflowDefinition;
  readonly interactions: InteractionManager;
  state: WorkflowTaskState;   // 唯一可变的字段
}
```
仅 `state` 可变，其余五个字段 `readonly`。终态集合 `TERMINAL_STATUSES`（L61）= `Set(['completed','failed','aborted'])`。

**instances Map（L164）**：`private readonly instances = new Map<string, ActiveInstance>()`。`startInstance`（L171-220）在创建后 `this.instances.set(instanceId, active)`（L216），随后 `void this.persistState(active)` + `void this.execute(instanceId)`（fire-and-forget，L217-218）。

**persistState（L519-529）**：`private async persistState(active)` 取 `this.persistence()`（=`this.ctx.get('sandorePersistence')`，L515-517），存在则 `await persistence.saveWorkflowState(active.state)`；整体 try/catch，失败仅 `ctx.logger.warn`，永不抛错。**每次状态变化都先 `active.state = {...active.state, ...}` 不可变重建，再 persistState**（全文件一致）。

**emitContained / safeAppend 双发范式（L533-612）**：
- `emitContained(name, args)`（L533-544）：`this.ctx.events.dispatch('emit', [name, ...args])`，对每个 callback 以 `...args` 调用；同步抛错与 reject 的 Promise 均 catch + `logger.warn`，不向上抛。
- `safeAppend(fn)`（L546-552）：try/catch 包裹 `session.append(...)`，失败 `logger.warn`。
- 每个 `sandore/*` 事件都是「emitContained（Cordis）+ safeAppend（Session）成对」：`emitStart`/`emitStageStart`/`emitStageCompleted`/`emitStepStart`/`emitStepCompleted`/`emitStepFailed`/`emitEnd`/`emitAborted`/`emitQuestion`/`emitPermission`（L554-612）。Session 侧 payload 形状（不含 `info` 参数，仅 taskId/stepId 等精简字段）见 seam.ts 的 `SessionEventMap`。

**runnerConfig（L490-513）**：`private runnerConfig(definition, hostAgent, active): StepRunnerConfig`，返回 `{ defaultTimeoutMs（config 缺省 7200000）, defaultProvider?/defaultModel?（配置存在才展开）, skills, mcps, agents, hostAgent, onDelegatedAsk }`。`onDelegatedAsk` 转 `active.interactions.delegateSubagentAsk({ childId, output, stageId, stepId, sessionId, signal })` 并返回 `result.delegated`。

**runInstance 主循环与 Step 完成等待点（L315-479）**：
- `runInstance` 读 `const signal = controller.signal`（L317），置 `status='running'` 后 `emitStart`。
- 循环 `while (stageId !== '')`（L339）：`markStageStatus('running')` → 构造 `StageExecutor`（传 `signal`、`hooks`、`runnerConfig`、`onPersist` 等，L355-392）→ `let result = await executor.execute()`（**L394，这是引擎层等 Stage 全部 Step 完成的点**）。
- 交互循环 `while (result.status === 'interacting')`（L397-423）：`findAskStep` 找 interacting+ask 载荷 Step → `active.interactions.ask({ entry, signal })` → 回复后 `result = await executor.execute()` 续跑（断点续跑）。
- **真正的「单 Step 完成等待点」在 microflow**：子代理 Step（agent/skill/mcp）在 `step-runner.ts` L506/L529 的 `await child.whenIdle()`。当前引擎代码**没有任何 `subagents.interrupt` 调用**；`controller.signal` 的取消传导链是：`runInstance` L317 → `StageExecutor` options.signal（L370）→ `StepRunner.run` 的 `request.signal`（stage-executor L397）→ shell/prompt/`startContinuable` 的 signal（step-runner L378/L461/L500）。**`whenIdle()` 本身不接收 signal**——agent/skill/mcp Step 挂起时 `controller.abort()` 不会直接打断 `whenIdle()` 等待，只能等 shell/prompt/subprocess 等路径观察到 signal（这就是 abort/interrupt 与 whenIdle 的交互缝隙）。
- `result.status==='failed'` 分支（L432-454）：若 `signal.aborted` → 置 `status='aborted'` + persist + `emitAborted`；否则置 `status='failed'` + `emitEnd`。Stage 完成后 `tryAdvanceStage` 推进，最后置 `status='completed'` + `emitEnd`。

**abortInstance 当前实现（L237-246）**：
```ts
async abortInstance(instanceId) {
  const active = this.instances.get(instanceId);
  if (active === undefined) throw new SandoreError(`instance '...' not found`, 'NODE_NOT_FOUND');
  if (TERMINAL_STATUSES.has(active.state.status)) throw new SandoreError(`instance '...' is already in terminal state '...'`, 'INVALID_OPERATION');
  active.controller.abort();
}
```
只发 AbortSignal，**不直接置 aborted 状态**；aborted 终态由 `runInstance` 在观察到 `signal.aborted` 时落盘（L434-437）。`recoverInstance`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep` 六个 stub 仍抛 `SandoreError('... not implemented','INVALID_OPERATION')`（L248-286）；`replyQuestion`/`replyPermission` 已接 interaction-manager（L252-266）。`execute`（L290-313）异常兜底落 failed 终态。

### ② microflow/src/subagents.ts — SubagentRuntime.interrupt/followup、Agent.status/inbox、SubagentInterruptAuthority

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.ts`

- **Agent（L37-46）**：`{ readonly id: SessionId; readonly options: AgentOptions; readonly session: Session; readonly inbox: { readonly hasPending: boolean }; readonly status: AgentStatus; readonly ctx: unknown; whenIdle(): Promise<void> }`。`AgentStatus = 'idle' | 'running'`（L29）。注意：seam 的 `Agent` **没有** DSH 真实 Agent 的 `cancel()`/`followup()`/`steer()`/`inject()`/`runMaintenance()`。
- **SubagentInterruptAuthority（L146-148）**：`{ readonly kind: 'user'; readonly parentSessionId: SessionId } | { readonly kind: 'ancestor'; readonly agent: Agent }`。
- **SubagentFollowupOptions（L140-143）**：`{ readonly source: MessageSource; readonly signal: AbortSignal }`。
- **SubagentRuntime（L187-193）**：
  - `startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>`（`ContinuableStart = { childId, messageId }`，L134-137）
  - `followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>`
  - `interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void`（同步、void）
  - `listChildren(parentSessionId: SessionId, signal?): Promise<SubagentListEntry[]>`
  - `start(name, request: SubagentStartRequest): Promise<SubagentRun>`
- **AgentRegistry（L103-107）**：`get(id)` / `create(options)` / `resume(options)`；`CreateAgentOptions` 已含 `meta`/`seed`/`agentOptions`/`signal`/`setup`（L78-92），`ResumeAgentOptions` 含 `setup`（L95-100）。
- 模块级 `declare module '@deepseek-ai/cordis'`（L247-252）声明 `Context.subagents: SubagentRuntime` 与 `Context.agents: AgentRegistry`。

### ③ stage-executor.ts / step-runner.ts — executedSteps 的 sessionMeta.childId 与 StepStatus

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`、`.../step-runner.ts`

- **合成 childId（stage-executor L90-93）**：`synthesizeChildId(stepId)` = `step-{stepId}-{crypto.randomUUID() 去 '-' 后前 8 位}`；循环内用 `loopManager.getActualStepId(step.id)`（L353，循环 id 为 4 位 hex 后缀）。
- **executed 初值（processCommandNode L353-369）**：`status: 'running'`、`sessionMeta: { childId, synthetic: true, command: command.type }`、`visitCount`。
- **子代理真实 sessionMeta 覆盖（L402-407）**：`executed.sessionMeta = { childId: result.sessionMeta.childId ?? childId, synthetic: result.sessionMeta.synthetic, command }`（agent/skill/mcp 返回 `synthetic:false` 与真实 `started.childId`；shell/prompt 无 sessionMeta 时保持 synthetic:true）。
- **StepRunSessionMeta（step-runner L107-111）**：`{ childId?: string; synthetic: boolean; command: CommandConfig['type'] }`。
- **StepStatus 枚举**（来自 types.ts，见 ⑤）：`'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'` —— 含 `paused`/`running`/`interacting`。`ExecutedStepDefault.status` 用它（`StepStatusSchema`）。
- **断点续跑状态机（stage-executor）**：`StageRunState`（L189-206）持 `executedSteps`/`batch`/`batchIndex`/`nextBatch`/`status`/`pendingAsk`；`execute()`（L222-236）首次 `initState`，`pendingAsk` 存在时 `resumePendingAsk` 续跑（L466-507）。ask 中断时 `state.status='interacting'` 且 return `'ask'`（L424-430）；onPersist 逐 Step upsert 到引擎 `executedSteps`（engine L376-391，按 `id` 去重）。

### ④ workflow/src/schema.ts — WorkflowTaskStateSchema.pausedChildIds 与 ExecutedStepDefaultSchema 暂停字段

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

- **StepStatusSchema（L15）**：`z.enum(['blocked','ready','interacting','running','completed','failed','paused'])`。
- **DagRunStatusSchema（L18）**：`z.enum(['pending','running','interacting','completed','failed','aborted','paused'])`。
- **StepSessionMetaSchema（L185-190）**：`{ childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']); hostSessionId: z.string().optional() }`。
- **ExecutedStepDefaultSchema（L310-336）**：`status: StepStatusSchema`，可选字段含 `pausedAt: z.string().optional()`（L326）、`resumedAt: z.string().optional()`（L327）、`resumePrompt: z.string().optional()`（L328）、`pauseEntryId: z.string().optional()`（L330）、`sessionMessages`（L329）、`retryHistory`（L333）、`parentSessionId`（L334）。其余：`type:'default'`/`id`/`stepId?`/`stageId`/`name`/`command?`/`inputFrom?`/`outputTo?`/`passThroughVars?`/`sessionMeta?`/`finalizeMeta?`/`visitCount`/`branchMeta?`/`error?`/`loopIteration?`/`loopMeta?`/`output?`。
- **WorkflowTaskStateSchema（L363-384）**：`pausedChildIds: z.array(z.string())`（**L380**，seam-01 已从 `pausedStepIds` 改名）；`pendingInteractions` 已收紧为 `z.array(z.union([PendingQuestionEntrySchema, PendingPermissionEntrySchema]))`（L373）；`executedSteps: z.array(ExecutedStepDefaultSchema)`（L371）；`activeLoopNodeId: z.string().nullable()`（L378）。
- 改名断言见 `schema.spec.ts` L155-166：`WorkflowTaskStateSchema.shape` 含 `pausedChildIds`、不含 `pausedStepIds`；仅带 `pausedStepIds` 的 legacy 快照 `parse` 抛 `z.ZodError`。

### ⑤ workflow/src/types.ts — ExecutedStepDefault / StepStatus / DagRunStatus

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`

- **DagRunStatus（L111）**：`'pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused'`。
- **StepStatus（L165）**：`'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'`。
- **ExecutedStepDefault（L129-155）**：`type:'default'` + `id` + `stepId?` + `stageId` + `name` + `status: StepStatus` + `command?`/`inputFrom?`/`outputTo?`/`passThroughVars?`/`sessionMeta?`/`finalizeMeta?`/`visitCount`/`branchMeta?`/`error?` + `pausedAt?`/`resumedAt?`/`resumePrompt?`（L145-147）+ `sessionMessages?`/`pauseEntryId?`/`loopIteration?`/`loopMeta?`/`retryHistory?`/`parentSessionId?`/`output?: ContentBlock[]`。
- 其余：`DagInstanceState`（L114-126，仅含 taskId/jobId/workflowId/status/originalInput/currentStageId/executedSteps/stageInfos/pendingQueue/createdAt/updatedAt）、`StageInfo`（L158-162）、`StageContract`（L168-186）、`DagResultInfo`（L198-203）。

### ⑥ DSH 参考源码 — interrupt/followup 真实语义

目录：`D:/project-code/llm/deepseek-harness/packages/subagent/subagent/src`（另有 `packages/core/agent/src`、`packages/core/agent-loop/src`）

- **类型定义与 sandore seam 完全一致**：`continuation.ts` L139-142 `SubagentInterruptAuthority`（`user`/`ancestor`）、L144-149 `SubagentFollowupOptions`（`source`/`signal`）。`index.ts` L231-257 是 `SubagentRuntime.followup`/`interrupt` 的门面：`followup` 转 `requireContinuations().followup`；`interrupt` 转 `this.continuations?.interrupt(...)`（manager-less 组合即天然 no-op）。
- **followup（continuation.ts L476-505）**：`assertAdmitting(parent)`（DRAINING 时拒绝）→ 每 child 锁 `locks.run(childId)` → 有 `activation` 走 `submitAdmitted`；**absent activation 走 `coldResume`（冷恢复）**。`options.signal` 只拥有到 inbox acceptance（接受后不可取消）。
- **followup 冷恢复（L883-932）**：`persistence.inspect(childId, signal)` 读持久化 Session → `authorizeLineage(parent, childId, loaded.meta.parentSession)` → `foldSubagentDescriptor(events.slice(seedLength))` 折叠 descriptor（`mode !== 'continuable'` 抛 `NOT_RESUMABLE`）→ `materialize`（经 `ctx.agents.resume`）→ `submitMaterialized`。
- **authorizeLineage（L1211-1225）**：parent 必须是 exact live agent（`ctx.agents.get(parent.id) !== parent` → `UNAUTHORIZED`），且 child 的 `session.header.parentSession === parent.id`，否则 `UNAUTHORIZED`。`submitAdmitted`（L1181-1204）先 `signal.throwIfAborted()` → `assertAdmitting` → 处置中的 activation 抛 `ACTIVATION_CLOSING` → `authorizeLineage`。
- **interrupt（continuation.ts L528-568）**：同步准入、异步生效（fire-and-return）：
  1. `authority.kind === 'ancestor'`：先查 `this.ctx.agents.get(caller.id) !== caller` → 即使 target absent 也抛 `UNAUTHORIZED`（防 stale caller 探测）；`caller.id === targetSessionId` → 抛 `UNAUTHORIZED`（不可自中断）。
  2. `this.activations.get(targetSessionId) === undefined` → **直接 `return`（absent target 是已接受 no-op**，覆盖完成竞态/重复请求/one-shot/未知 id）。
  3. `authority.kind === 'user'`：`activation.handle.agent.session.header.parentSession !== authority.parentSessionId` → `UNAUTHORIZED`（须是 target 的 durable direct parent）。
  4. `authority.kind === 'ancestor'`：`!activation.ancestry.has(authority.agent)` → `UNAUTHORIZED`（须在 target 的 live lineage 内）。
  5. `activation.disposal !== undefined` → no-op return。
  6. `activation.handle.agent.cancel(cause, { keepInbox: true })`（user → `{kind:'user'}`，ancestor → `{kind:'parent'}`）。保留 Activation/handle/inbox/后代，不重排队已 claim 的 turn。
- **DSH 真实 Agent（packages/core/agent/src/runtime-types.ts L64-144）**：`{ id, options, session, inbox: Inbox, status: AgentStatus, ctx }` + `cancel(cause, options?: { keepInbox? })` + `whenIdle()` + `runMaintenance` + `send/followup/steer/inject`。`AgentStatus = 'idle'|'running'`（L50）。
- **agent-loop 实现（packages/core/agent-loop/src/agent.ts）**：`status` getter L99-101（phase `idle`/`maintenance` → idle，否则 running）；`cancel` L134-140（`keepInbox` 不清 inbox，非 idle 时 `phase.abort.abort(cause)`）；`followup` = `send(...,'next-turn',true)`（L122-124）。`interrupt` 的取消 cause 落在该 agent 的 phase.abort.signal 上。

### ⑦ 测试 mock — FakeSubagents（interrupt/followup 状态机）与 FakeAgent（status/inbox）

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/subagents.ts`、`.../agents.ts`

- **FakeSubagents（subagents.ts L38-99）**：
  - 状态机字段（L44-45，seam-01 已扩展）：`private readonly childParent = new Map<SessionId, SessionId>()`、`private readonly childStates = new Map<SessionId, FakeChildStatus>()`；`FakeChildStatus = 'running' | 'interrupted'`（L35）。
  - `startContinuable`（L47-54）：push spec，`childId = child-{index}`，`childParent.set(childId, spec.request.parent.id)` + `childStates.set(childId, 'running')`，返回 `{ childId, messageId: msg-{index} }`。
  - `followup`（L56-60）：push `{ parent, childId, content, options }`，`childStates.set(childId, 'running')`。
  - `interrupt`（L62-65）：push `{ targetSessionId, authority }`，`childStates.set(targetSessionId, 'interrupted')`。
  - `listChildren`（L67-82）：按 `childParent.get(id) === parentSessionId` 过滤 childStates，产 `{ kind:'child', id, activity: running?'running':'inactive', hasChildren:false, mode:'continuable', label:'test child' }`。
  - `childStatus(childId)`（L85-87）查询当前状态。
- **FakeAgent（agents.ts L65-84）**：`status: AgentStatus = 'idle'`（可变）、`inbox = { hasPending: false }`、`ctx = undefined`、`whenIdle()` 立即 resolve（测试中可覆写）。`FakeAgentRegistry`（L95-154）：`get/create/resume` + `createCwds`/`setupCount`/`setupError`/`register`；`create` 时 `runSetup` 并在 sessions store 发布 Session。
- **状态机链路测试**：`D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.spec.ts` L141-162（`FakeSubagents lifecycle state machine`）断言 `startContinuable → interrupt → followup` 的 childStatus 迁移与 `listChildren` 的 activity 投影（interrupted → 'inactive'）。

### ⑧ workflow-engine.spec.ts 对 abortInstance 的既有断言

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`（`describe('SandoreEngineRuntime abort', L678-728)`）

- **"aborts a hanging shell step to the aborted terminal state"（L679-712）**：`shell.runHandler` 返回挂起 Promise，监听 `spec.signal` 的 `abort` 事件后 resolve `{ aborted: true, signal: 'SIGTERM', ... }`；流程 `startInstance → await waitForStepStart → await engine.abortInstance(run.instanceId) → await waitForAborted`。断言：`records.some(r => r.name === 'sandore/aborted')` 为 true，且 `persistence.state.get(run.instanceId)?.status === 'aborted'`。
- **"rejects abortInstance for a completed instance"（L714-727）**：实例 completed 后 `engine.abortInstance(run.instanceId)` `rejects.toMatchObject({ code: 'INVALID_OPERATION' })`。
- 辅助：`waitForAborted`（L367-371）监听 `sandore/aborted`；`recordSandoreEvents`（L346-357）已注册全部 13 个 `sandore/*` 监听（含 `sandore/aborted`，但 `step-paused`/`step-resumed`/`step-retried` 三个事件当前只声明未注册监听也未发射）。

### 补充：相关落点上下文（lifecycle-01 直接相关）

- **seam.ts**（`D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`）：`SandoreEngine` 抽象类（L75-105）声明 11 个实例级方法签名（`startInstance`/`recoverInstance`/`abortInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`/`getState`）；13 个 `sandore/*` 事件在 Cordis `Events`（L34-48）与 Session `SessionEventMap`（L52-66）均已双声明，其中 `sandore/step-paused`/`sandore/step-resumed`/`sandore/step-retried` 三个目前**未被 workflow-engine 发射**。`SandoreEngineStub.inject`（L145）= `['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain','agents','userQuestions']`；`SandoreEngineRuntime.inject`（workflow-engine L162）= `['sessions','sessionPersistence','subagents','agents','llm','shell','fs','storageDomain','userQuestions']`。
- **engine-surface.ts**：`SandoreEngineSurface` 纯 type-only 结构面（11 方法签名），供 seam 与 tool 包共享。
- **host-agent.ts**（`D:/project-code/llm/sandore/packages/sandore/workflow/src/host-agent.ts`）：`createHostAgentSetup({ instanceId, engine })` 返回 `AgentSetup`，在 `agentCtx` 注册 `createSandoreTools` 的 8 个工具 + system prompt section（`sandore-host`）。create 与 resume 共用。
- **interaction-manager.ts**（`D:/project-code/llm/sandore/packages/sandore/workflow/src/interaction-manager.ts`）：`InteractionManager` 持 `pendingQuestions`/`pendingPermissions` Map 与 `resolvedEntries` 历史；`ask()` 主通道走 `ctx.userQuestions.ask({ agent: hostAgent })`；`delegateSubagentAsk()` 解析 `[[SANDORE_ASK]]` 标记块后转引擎级 ask，答案经 `deps.followup(childId, content)` 注回（followup 由 workflow-engine L208-213 注入为 `ctx.subagents.followup(hostAgent, childId, content, { source:{kind:'user'}, signal: controller.signal })`）。
- **tool/src/index.ts**（`D:/project-code/llm/sandore/packages/sandore/tool/src/index.ts`）：8 个 `sandore_*` 工具已实现（L277-349）。`sandore_pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllPaused`/`retryStep` 经 `runUnlessCompleted`（completed 时 no-op）转调 `engine.pauseStep` 等 —— 这些 engine 方法当前仍是 stub（抛 `INVALID_OPERATION`），故工具调用会得到 error result；`sandore_abortInstance` 经 `abortUnlessTerminal`（终态 no-op）。
