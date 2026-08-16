## ADDED Requirements

### Requirement: 单步暂停
`pauseStep(instanceId, stepId)` SHALL：经 `executedSteps[].sessionMeta.childId` 反查子代理 SessionId → 调用 `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })` → 暂停登记表 `pausedChildIds` 添加该 childId → Step 状态置 `paused`（含 `pausedAt` 时间戳）→ 持久化 → 发射 `sandore/step-paused` 事件（payload 含 childId）。

#### Scenario: 暂停 running Step
- **WHEN** 对 `running` 状态的 Step 调用 `pauseStep`
- **THEN** `subagents.interrupt` 以 ancestor authority 调用；childId 进入 `pausedChildIds`；executedStep 状态变 `paused`；快照持久化；`sandore/step-paused` 事件 Session append + Cordis 双发

#### Scenario: 暂停已空闲 Step 幂等 no-op
- **WHEN** 目标子代理恰好在 interrupt 前完成（`agent.status==='idle'` 且 inbox 无 pending）
- **THEN** `pauseStep` 不产生中断副作用，按 Step 实际完成状态处理（不误标 paused）

#### Scenario: 暂停不存在/终态 Step 报错
- **WHEN** stepId 不存在或 Step 处于 completed/failed 终态
- **THEN** 抛 `SandoreError`（`INVALID_OPERATION`）

### Requirement: 单步恢复
`resumeStep(instanceId, stepId, resumePrompt?)` SHALL：反查 childId → 从登记表移除 → `ctx.subagents.followup(hostAgent, childId, text(resumePrompt ?? 默认恢复提示), { source, signal })` → Step 状态置 `running`（记 `resumedAt`/`resumePrompt`）→ 持久化 → 发射 `sandore/step-resumed` 事件（payload 含 childId 与 resumePrompt）。

#### Scenario: 带自定义提示恢复
- **WHEN** 对登记表中 paused 的 Step 调用 `resumeStep(stepId, '请继续处理 X')`
- **THEN** `subagents.followup` 以 hostAgent 为 parent 发送该文本；childId 移出 `pausedChildIds`；Step 状态变 `running`；事件载荷含 resumePrompt

#### Scenario: 恢复非登记 Step 报错
- **WHEN** 对不在 `pausedChildIds` 登记表中的 Step 调用 `resumeStep`
- **THEN** 抛 `SandoreError`（`INVALID_OPERATION`）

### Requirement: 全局暂停/恢复
`pauseAllSteps(instanceId)` SHALL 遍历所有 `running`/`interacting` 状态的 Step 逐个执行暂停语义；`resumeAllSteps(instanceId, resumePrompt?)` SHALL 遍历 `pausedChildIds` 登记表逐个执行恢复语义。两者 SHALL 在完成后持久化并发射对应事件。

#### Scenario: 全局暂停仅作用于活跃 Step
- **WHEN** 实例含 running×2 + interacting×1 + completed×1 的 Step，调用 `pauseAllSteps`
- **THEN** 仅 3 个活跃 Step 被暂停并入登记表；completed Step 不受影响

#### Scenario: 广播恢复遍历登记表
- **WHEN** 登记表含 3 个 childId，调用 `resumeAllSteps`
- **THEN** 3 个子代理各收到 followup；登记表清空；实例状态从 `paused` 回到 `running`

### Requirement: 暂停登记表（引擎自建权威）
引擎 SHALL 自建暂停登记表 `pausedChildIds`（DSH `Agent.status` 仅 `idle|running`，无 paused 态）：内存 `Set` 与 `WorkflowTaskState.pausedChildIds`（持久化字段，值=子代理 SessionId）同步更新。登记表是「暂停集」的唯一权威，SHALL NOT 以子代理状态查询替代。

#### Scenario: 登记表持久化与重建
- **WHEN** 暂停后进程崩溃再恢复
- **THEN** 恢复的引擎从快照 `pausedChildIds` 重建内存登记表，paused Step 等待手动 resume

#### Scenario: schema 字段命名
- **WHEN** 检查 `WorkflowTaskStateSchema`
- **THEN** 暂停登记表字段名为 `pausedChildIds`（不再存在 `pausedStepIds` 字段）

### Requirement: 引擎等待与暂停协作
`runInstance` 主循环中 Step 的 `whenIdle()` 等待因 interrupt 被取消时，引擎 SHALL 先查暂停登记表：命中则挂起该 Step 的后续处理等待 resume（不落 failed），未命中才按失败处理。实例整体状态在存在暂停 Step 时 SHALL 为 `paused`。

#### Scenario: interrupt 不误判为失败
- **WHEN** Step 执行中被 `pauseStep` interrupt，`whenIdle()`/执行 Promise 以取消类错误结束
- **THEN** 引擎查登记表命中该 childId → Step 保持 `paused`、实例状态 `paused`，不发射 `sandore/step-failed`

### Requirement: 中止
`abortInstance` SHALL：置中止标志 → 对登记表内全部子代理执行 interrupt → 实例状态置 `aborted` → 清理内存 `ActiveInstance`（保留持久化快照）→ 发射 `sandore/aborted` 事件。对终态实例调用 SHALL 抛 `INVALID_OPERATION`。

#### Scenario: 中止暂停中的实例
- **WHEN** 实例含登记表中的 paused 子代理，调用 `abortInstance`
- **THEN** 中止传播到全部子代理；实例状态 `aborted`；再次调用抛 `INVALID_OPERATION`
