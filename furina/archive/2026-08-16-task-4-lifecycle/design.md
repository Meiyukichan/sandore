## Context

Task 3 已交付完整 DAG（`microflow`：StepRunner 五类 Command + StageExecutor DAG 调度 + BranchEvaluator/LoopManager/FinalizeManager；`workflow`：SandoreEngineRuntime Stage 级主循环 + 持久化 + RPC）。当前基线与 Task 4 的缝隙（经 `explore-design/` 核实）：

1. **宿主 Session 非主代理**：`startInstance` 用 `ctx.sessions.create(SessionId(instanceId), { meta: { cwd } })` 创建裸 Session——无 `setup`、无 `sandore_*` 工具、无 system prompt，`StepRunnerConfig.hostAgent` 走 stub parent。D9（主代理=编排器）完全缺失。
2. **8 个生命周期方法为 stub**：`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep` 全部抛 `INVALID_OPERATION`。
3. **interacting 无等待循环**：`runInstance` 中 `result.status === 'interacting'`（finalize ask 判定）仅置 `status='interacting'` 后 `return`，无 `PendingQuestion` 注入、无回复续跑。
4. **tool 包空占位**：仅 `package.json` + `tsconfig.json`，无 `src/`。
5. **5 个事件已声明未发射**：`step-paused`/`step-resumed`/`step-retried`/`question`/`permission`。
6. **接缝缺口**：`microflow/src/subagents.ts` 的 `CreateAgentOptions` 缺 `meta`/`seed`/`setup`，`ResumeAgentOptions` 缺 `setup`，`Agent` 缺 `inbox`/`ctx`，`SubagentRuntime` 缺 `listChildren`；`seam.ts` inject 缺 `agents`/`userQuestions`；`pendingInteractions` 为 `unknown[]` 占位。
7. **RPC 缺口**：`remote.ts` 无生命周期 RPC。

DSH 权威原语（已核实 `D:\project-code\llm\deepseek-harness` 源码）：`agents.create/resume`（`setup` 在发布前执行、resume 重跑 setup）、`subagents.interrupt/followup/listChildren`（followup 对 absent child 自动冷恢复）、`sessions.fork(source, boundary?, childSessionId?)`（boundary=含端点 seq，不得落未闭合 turn）、`userQuestions.ask({ agent })`（**owned child 抛 `DELEGATED_CALLER`**——子代理不能直接问用户）。

硬约束：纯插件不改 DSH 源码；零外部 Agent SDK；命名沿用（`ctx.sandoreEngine`/`sandore/*` 13 事件/`sandore_*` 工具/`sandore.*` RPC/4 包）；权限无 `permissionMode`（子代理继承宿主 preset，approval 固定 `never`）。

## Goals / Non-Goals

**Goals:**

- 宿主主代理（D9）：`startInstance` 经 `ctx.agents.create({ sessionId, meta: { cwd }, setup })` 创建真 Agent，per-instance 闭包注册 8 个 `sandore_*` 编排器工具；`completed` 后自然降级自由对话；崩溃恢复 `agents.resume` 重跑 setup。
- 交互全链路：引擎级 ask 以宿主主代理身份 `ctx.userQuestions.ask({ agent: hostAgent })` 原生卡片闭环；pending Map 镜像持久化；`replyQuestion`/`replyPermission` 兼容路径；子代理 ask 转接。
- 暂停/恢复/中止：`interrupt`/`followup` 映射 + 引擎自建 `pausedChildIds` 登记表（持久化）。
- 重试三模式：continue（followup）/ revert（fork+seed 续跑）/ fork（fork+新 agent）。
- 崩溃恢复：`recoverOrphanedInstances` 启动扫描 + 宿主/子代理冷恢复 + 登记表重建。
- 7 个生命周期 RPC 前端通路。
- D8 引擎侧就绪：5 个新事件正确 `session.append` + payload 完整（`childId`/`output` 内联）。

**Non-Goals:**

- `ui` 包讨论面板 `sandore-step` 渲染器（Task 5；本 Task 以单测断言事件序列/payload 保证可渲染性）。
- `getDiscussion`/`addChatMessage` 讨论直读 RPC（Session 日志 + `ConversationNodeDefinition` 直读，避免双轨数据源）。
- `recover` RPC（崩溃恢复是 `Service.init` 时自动扫描，非用户操作）。
- DefaultSessionManager（D9 废弃——宿主 Session 自然延续）。
- per-Step 权限差异化（DSH 无此能力）。
- 并发信号量（V2.5 已停用，DSH provider 级 cap 兜底）。

## Decisions

### D-1 宿主主代理的创建路径：`agents.create({ sessionId, meta, setup })`，非「先 sessions.create 再 agents.create」

宿主 Session id 即 `instanceId`。`startInstance` 直接 `ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup })`——`setup` 在 agent/session 发布前执行，注册的工具/system prompt 在首轮 prompt 组装前就绪。**替代方案**（否决）：先 `sessions.create` 再叠加 `agents.create`——DSH `agents.create` 本就管理 session 生命周期，先建裸 session 会产生孤儿引用；且 setup 的发布前语义只有 agents.create 提供。

- 工具注册在 `setup(agentCtx)` 内：`agentCtx.tools.register(defineTool({ name: 'sandore_getState', ... }))`，闭包捕获 `instanceId` → per-instance 隔离（D9「工具仅挂宿主 Session」）。
- system prompt：`agentCtx.systemPrompt.section(...)` 注入编排器角色说明（含「completed 后 resume/retry 为 no-op」的降级语义）。
- **hostAgent 持有**：`ActiveInstance` 增 `hostAgent` 字段；`StepRunnerConfig.hostAgent` 接到它（子代理 parent + interrupt authority + followup parent 三合一）。
- **主代理激活**：宿主主代理创建后**不自动发首轮 prompt**（`agents.create` 仅 mint，不 run）；引擎编排（`runInstance`）与主代理对话并行——用户消息走 DSH 原生 composer → 主代理 agent loop → 显式调 `sandore_*` 工具（D9「自然语言 → 工具」）。引擎侧不模仿 agent loop，编排逻辑仍在 `runInstance` 主循环。

### D-2 交互承载：引擎级 ask 走 `ctx.userQuestions.ask({ agent: hostAgent })`，pending Map 降级为镜像持久化

**DELEGATED_CALLER 修正后的三层结构**：

1. **主通道（引擎级 ask）**：finalize `completionType='ask'` → `interactionManager.addPendingQuestion()` 登记 → `ctx.userQuestions.ask({ agent: hostAgent, questions })` 发原生卡片 → `await` 答案 → `replyQuestion` 内部 resolve → Step 恢复（继续门禁 → 推进下一节点）。
2. **镜像持久化**：`pendingQuestions`/`pendingPermissions` Map（requestId → 条目）在 `addPending*` 时写入 `WorkflowTaskState.pendingInteractions`（收紧为结构化 schema），崩溃恢复时重建。**不是**回复的权威路径——权威是 `userQuestions.ask` 的 await。
3. **兼容回复路径**：`sandore.replyQuestion` RPC → `interactionManager.replyQuestion()` → resolve 内部 Promise（与 ask 的 await 汇合）。仅当 DSH 卡片通道不可用（如 headless 测试）时使用。

**子代理 ask 转接**（DELEGATED_CALLER 规避）：Step 子代理调 `ask_user_question` → DSH 抛 `DELEGATED_CALLER` → 错误信息指引「把问题写进 final result」→ 引擎在 `finalAssistantOutput` 后解析问题文本（约定标记，如 JSON 块）→ 转引擎级 ask（hostAgent 问）→ 答案 `followup` 给子代理继续。首版解析采用**保守约定**：子代理 final result 含 `[[SANDORE_ASK]]{...json...}[[/SANDORE_ASK]]` 标记块时转接，否则不转接（普通输出）。

**权限**：无引擎级权限路径——子代理 approval 固定 `never`（提权 ask 确定性拒绝），`PendingPermission` 仅在 DSH approval 事件镜像时登记（`sandore/permission` 事件 + 兼容 `replyPermission`），不做自动审批。

- **替代方案**（否决）：纯引擎自建（选项 2）——前端 reply UI 是 Task 5 产物，Task 4 阶段无法闭环；仅 askUserQuestion 走引擎（选项 3）——前提「子代理自动流转」已被 DELEGATED_CALLER 推翻，且丢 pending Map 会失去崩溃恢复交互状态。

### D-3 暂停登记表：`pausedChildIds`（改名自 `pausedStepIds`，值=childId）+ 内存 `Set` 与持久化条目同步

DSH `Agent.status` 仅 `idle|running`，无 paused——登记表是「暂停集」唯一权威。字段改名理由：值语义是子代理 SessionId（`interrupt(childId)`/`followup(childId)` 的直接参数），`pausedStepIds` 名实不符；开发期改名零迁移成本。

- `pauseStep(stepId)`：`childId = executedSteps[].sessionMeta.childId` 反查 → `interrupt(childId, {kind:'ancestor', agent: hostAgent})` → `pausedChildIds.add(childId)` + `executedStep.status='paused'` + `pausedAt` 时间戳 → persist → emit `sandore/step-paused`。
- `resumeStep(stepId, resumePrompt?)`：反查 childId → `followup(hostAgent, childId, text(resumePrompt ?? 默认提示), {source, signal})` → 从登记表删除 + `status='running'`/`resumedAt` → persist → emit `sandore/step-resumed`。
- `pauseAllSteps`：遍历 running/interacting Step 逐个 `pauseStep`（不含已完成/失败）；`resumeAllSteps` 遍历登记表逐个 resume。
- **runInstance 协作**：`runInstance` 对每个 Step 的 `whenIdle()` 等待被 pause 打断后（`CANCELLED`/`agent cancelled` 错误），不视为失败——查登记表命中则等待 resume 的 `followup` Promise，未命中才落 failed。
- **abort**：`controller.abort()` + 登记表内全部子代理 `interrupt` + `emit sandore/aborted` + 清理 `ActiveInstance`（保留持久化快照，状态 `aborted`）。

### D-4 重试三模式：continue=followup / revert=fork+seed / fork=fork+新agent，全部产生重试续跑循环

| 模式 | DSH 操作 | session 变化 |
|---|---|---|
| `continue` | `followup(hostAgent, childId, text(message), ...)` | 同 session 追加 |
| `revert` | `sessions.fork(childId, boundary)` 取前缀 → `agents.create({ seed: forked.events, sessionId: newChildId })` 续跑 | **新 session id**，回退粒度 turn 边界 |
| `fork` | `sessions.fork(childId, boundary?)` → `agents.create({ seed })` 新 agent | **新 session id**，保留全部历史 |

- `boundary` 语义：含端点 seq，省略 = 源最后一条事件；**不得落未闭合 turn**（否则 `OPEN_TURN` 错误）——引擎在 fork 前用 `sessions.get(childId).events` 计算安全边界（最后一个闭合 turn 的末事件 seq）。
- 三模式共用「重试续跑循环」：更新 Step/工作流 `running` → 清残留 `pausedAt/resumedAt/resumePrompt/sessionMessages/pauseEntryId/finalizeMeta` → sessionMeta 清 `outputJson`（fork/revert 清 `childId` 记新值 + `parentSessionId`）→ `RetryRecord` 入 `retryHistory`（result 先 `running`，完成/失败后更新）→ emit `sandore/step-retried` → `whenIdle()` + `finalAssistantOutput` → `runPostStepPipeline`（output 提取 + finalize + outputTo）→ DAG 推进。
- revert/fork 的 `newChildId` 合成：`step-{stepId}-{8hex}`（与 shell/prompt 的 `synthesizeChildId` 同规则），`parentSessionId` 记旧 childId。
- **执行中 Step 不可重试**：仅 `failed`（或 completed 态的 no-op 校验）可发起；执行中重试抛 `INVALID_OPERATION`。

### D-5 崩溃恢复：启动扫描 + 宿主冷恢复 + 子代理 followup 冷恢复 + 登记表重建

`recoverOrphanedInstances()` 在 `SandoreEngineRuntime` 启动时执行——接线采用 Cordis Service 生命周期钩子 `[Service.init]()`（`protected async [Service.init]()`，与 `SandorePersistence` 同款签名，Cordis 在构造后调用并 `await` 其返回 Promise）；为确保扫描时 `state` 表已就绪，`SandoreEngineRuntime.inject` 增列 `sandorePersistence`（与 `SandoreRemote.inject` 一致，保证 `SandorePersistence` 先于引擎加载）。已核实本仓库 Cordis `Service` 基类存在 `static readonly init: unique symbol` 生命周期钩子，故无需「首次注入惰性触发」兜底方案。

1. `persistence.state.entries()` 遍历所有 instanceId → 跳过终态（completed/failed/aborted）。
2. 非终态实例：从快照重建引擎内存态 → `ctx.agents.resume({ resumeSessionId: hostSessionId, setup })`（setup 重跑 → 8 工具 + instanceId 闭包重注册，重新持有 hostAgent）。
3. 遍历 `executedSteps`：shell/prompt 合成 session → 标记 `failed`（不可恢复）；`running`/`interacting` 子代理 Step → 仅对**第一个**可续跑 Step 执行 `followup(hostAgent, childId, 冷恢复提示, ...)` 触发冷恢复（与引擎 `resumeStageId`/`resumeInfo` 的单步 `.find()` 收口一致，其余并发 running Step 不 followup，避免「已 followup 但引擎不收口」的半恢复态）→ `whenIdle()` 续跑；`paused` → 登记表重建（`pausedChildIds` 已在快照），等待手动 resume。
4. 持久化 + 重跑 `runInstance` 主循环（若有入队节点）。
- **宿主冷恢复的 setup 一致性**：`setup` 回调由 `host-agent.ts` 工厂函数生成（同参数同闭包），create 与 resume 共用——保证重注册的工具行为一致。
- **主代理与引擎的恢复顺序**：先宿主后子代理（followup 需要 live hostAgent 作 parent）。
- 返回 `{ recovered: string[], errors: Array<{ instanceId, error }> }`；单实例恢复失败不阻断其他实例（逐个 try/catch）。
- **与 `recoverInstance` 的关系**：seam 的 8 个 stub 之一 `recoverInstance(instanceId)` 是单实例恢复入口（返回 `Promise<DagRun>`），复用本节的 per-instance 恢复例程（宿主冷恢复 → Step 分类恢复 → 登记表重建 → 重跑 runInstance）；`recoverOrphanedInstances()` 启动扫描时遍历非终态实例逐一对该例程执行并聚合 `{ recovered, errors }`。

### D-6 microflow 接缝扩展（结构类型，无 DSH 运行时依赖）

`subagents.ts` 按已核实的 DSH API 补齐：
- `CreateAgentOptions`：+ `meta?: { cwd?, parentSession?, seedLength?, origin?, delegationDepth?, agentPreset? }`、`seed?: readonly SessionEvent[]`、`setup?: AgentSetup`。
- `ResumeAgentOptions`：+ `setup?: AgentSetup`。
- `Agent`：+ `inbox: { hasPending: boolean }`、`ctx: unknown`（结构最小面）。
- `SubagentRuntime`：+ `listChildren(parentSessionId, signal?)`。
- `AgentSetup = (agentCtx: AgentSetupContext) => AgentSetupCommit | Promise<...> | void`，`AgentSetupContext` 定义为结构最小面（`tools.register`/`systemPrompt.section`）。
- microflow 不反向依赖 workflow——host-agent 工厂在 workflow 包，microflow 只提供类型面。

### D-7 inject 与事件发射扩展

- `seam.ts` `static inject = [...现有 7 项, 'agents', 'userQuestions']`。 Cordis inject 声明的服务在运行时必然存在（DSH host 提供），`userQuestions` 为软依赖的实际使用方是 interaction-manager（经 ctx 直取）。
- 5 个新事件发射沿用既有 `emitContained`（Cordis `ctx.emit`）+ `safeAppend`（`session.append`）双发范式，payload 含 `DagRunInfo` + 事件专属字段（`step-paused/resumed/retried` 带 `childId`；`question`/`permission` 带 pending 条目）。

### D-8 tool 包结构：单文件 8 工具 + setup 注册器

`tool/src/index.ts` 导出 `createSandoreTools(options: { instanceId, engine }): SandoreToolFactory`——返回 `setup` 回调用的工具定义数组（`defineTool` 形状的结构对象，经 `agentCtx.tools.register` 注册）。工具逻辑全部转调 `engine` 的实例级方法（不持有业务状态）：

| 工具 | 转调 |
|---|---|
| `sandore_getState` | `engine.getState(instanceId)` |
| `sandore_startInstance` | `engine.startInstance(request)`（新实例时另起新 instanceId） |
| `sandore_abortInstance` | `engine.abortInstance(instanceId)` |
| `sandore_pauseStep` / `sandore_resumeStep` | `engine.pauseStep/resumeStep(instanceId, ...)` |
| `sandore_pauseAllSteps` / `sandore_resumeAllPaused` | `engine.pauseAllSteps/resumeAllSteps(instanceId, ...)` |
| `sandore_retryStep` | `engine.retryStep(instanceId, stepId, mode, message)` |

- `resume`/`retry` 对 completed 实例返回结构化 no-op 结果（非报错），`getState` 任何状态可用（D9 自然降级）。
- 工具包不依赖 microflow/workflow 的运行时代码（仅 `import type`）——依赖方向保持 `tool → workflow(type-only)`，实际注册由 workflow 的 host-agent setup 完成闭环。

### D-9 schema/types 变更面（收紧 + 改名，一次到位）

- `WorkflowTaskStateSchema`：`pausedStepIds` → **`pausedChildIds: z.array(z.string())`**；`pendingInteractions: z.array(z.unknown())` → **`z.array(z.union([PendingQuestionEntrySchema, PendingPermissionEntrySchema]))`**（新增两 schema：`{ id, stageId, stepId, sessionId, requestId, kind: 'question'|'permission', status: 'pending'|'replied'|'rejected', payload, answer?, createdAt }`）。
- `types.ts`：`PendingQuestion`/`PendingPermission` 补 `id`/`stageId`/`status`/`answer` 字段（对齐 design 文档 §1.2）。
- `StepSessionMetaSchema` 增 `hostSessionId` 字段（崩溃恢复从快照定位宿主）。

## Risks / Trade-offs

- [DSH `agents.create` 实际行为与接缝假设不符（如 setup 时序）] → 接缝是结构类型（structural typing），测试用 FakeAgentRegistry 回放语义；实现时若 DSH 真实签名有出入，只需修接缝类型 + mock，不动业务逻辑。
- [`userQuestions.ask` await 期间引擎崩溃] → pending Map 已持久化；恢复时重建「已登记未 resolved」条目并重新发起 ask（幂等 requestId）；已 resolved 的直接续跑。
- [revert 的 turn 边界计算错误（落未闭合 turn → OPEN_TURN）] → fork 前计算安全边界（最后闭合 turn 末事件 seq）；单测覆盖边界计算 + 异常路径。
- [pause 后 `whenIdle()` 已 resolve 与 interrupt 竞态（子代理恰好在 interrupt 前完成）] → interrupt 前先查 `agent.status === 'idle' && !inbox.hasPending`，已完成则 pauseStep 幂等 no-op 返回；登记表操作在 interrupt 后原子更新。
- [多实例并发恢复互相干扰] → 每实例独立 try/catch + 独立 AbortController；`recoverOrphanedInstances` 聚合 errors 数组，单实例失败不阻断。
- [子代理 ask 转接的标记块约定被模型输出「伪造」] → 保守策略：仅解析首个标记块 + schema 校验失败则不转接（当普通输出处理）；转接动作本身以引擎级 ask 呈现，用户在 DSH 原生卡片上仍可拒绝。
- [`agents.create` 的 `seed` 语义与 fork 配合（revert 模式）产生意料外的 session 树] → `parentSessionId` 链记录到 executedStep；`listChildren` 枚举校验纳入单测。
- [测试 mock 的保真度不足（FakeAgent 无 inbox 状态机）] → FakeAgentRegistry/FakeSubagents 扩展为状态机（idle→running→idle + interrupt/followup 驱动迁移），核心生命周期链路（pause→resume、crash→recover、retry×3）全部走 mock 状态机断言。

## Migration Plan

开发期（无生产数据），schema 改名 `pausedStepIds`→`pausedChildIds` 直接改字段名，无迁移代码。存量 Task 2/3 单测中引用旧字段的用例同步更新。回滚 = git revert（无数据兼容负担）。

## Open Questions

（无——4 项关键决策已在 brainstorm 阶段定案并回写设计文档；DSH API 形状已逐一核实。）
