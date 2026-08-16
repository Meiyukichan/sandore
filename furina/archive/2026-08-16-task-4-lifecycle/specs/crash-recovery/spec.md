## ADDED Requirements

### Requirement: 单实例恢复入口（recoverInstance）
`recoverInstance(instanceId)`（seam 中 8 个 stub 之一）SHALL 实现为单实例恢复入口：对指定 instanceId 执行与 `recoverOrphanedInstances` 相同的 per-instance 恢复例程（宿主冷恢复 → Step 分类恢复 → 登记表重建 → 重跑 runInstance），返回 `Promise<DagRun>`。`recoverOrphanedInstances()`（启动扫描）SHALL 遍历非终态实例逐个调用该例程并聚合 `{ recovered, errors }`。

#### Scenario: 单实例恢复复用同一例程
- **WHEN** 调用 `engine.recoverInstance(instanceId)` 且该实例非终态
- **THEN** 执行与启动扫描相同的恢复步骤（宿主冷恢复 → Step 分类恢复 → 登记表重建 → 重跑 runInstance），返回该实例的 DagRun

#### Scenario: 恢复终态实例报错
- **WHEN** 对终态实例（completed/failed/aborted）调用 `recoverInstance`
- **THEN** 抛 `SandoreError`（`INVALID_OPERATION`），不改变状态

### Requirement: 孤儿实例启动扫描
引擎 SHALL 在启动时（`Service.init`）执行 `recoverOrphanedInstances()`：遍历 storageDomain `state` 表全部条目（key=instanceId）→ 跳过终态实例（completed/failed/aborted）→ 对每个非终态实例执行恢复流程。返回 `{ recovered: string[], errors: Array<{ instanceId, error }> }`；单实例恢复失败 SHALL NOT 阻断其他实例（逐实例 try/catch，错误聚合进 errors）。

#### Scenario: 扫描跳过终态
- **WHEN** state 表含 completed/failed/aborted/running/paused 五个实例，引擎启动
- **THEN** 仅 running/paused（及 interacting）实例进入恢复流程；终态实例不动

#### Scenario: 单实例失败不阻断
- **WHEN** 恢复实例 A 时抛错，实例 B 正常
- **THEN** A 的错误记入 errors 数组，B 照常恢复完成，`recovered` 含 B 不含 A

### Requirement: 宿主主代理冷恢复
每个非终态实例的恢复 SHALL 先执行 `ctx.agents.resume({ resumeSessionId: hostSessionId, setup })` 冷恢复宿主主代理：setup 重跑（8 个 `sandore_*` 工具 + instanceId 闭包 + system prompt 重注册），引擎重新持有 live hostAgent 引用（后续 interrupt authority / followup parent 的必要条件）。

#### Scenario: 冷恢复顺序先宿主后子代理
- **WHEN** 恢复含 running 子代理的实例
- **THEN** 先 `agents.resume` 宿主成功，再对子代理发起 followup；宿主恢复失败则该实例恢复失败进 errors

### Requirement: Step 分类恢复策略
恢复时引擎 SHALL 按快照中 `executedSteps` 的状态分类处理：

| Step 状态 | 恢复策略 |
|---|---|
| `running`/`interacting` | `ctx.subagents.followup(hostAgent, childId, 冷恢复提示, ...)` 触发冷恢复（absent child 自动从持久化 Session 恢复）→ `whenIdle()` 等待续跑 → 共享后处理 → DAG 推进 |
| `paused` | 从快照 `pausedChildIds` 重建暂停登记表，等待用户手动 resume（不自动恢复） |
| `completed`/`failed` | 无需恢复 |
| shell/prompt 合成 session（子进程已丢失/无真实子代理会话） | 标记为 `failed`（不可恢复） |

#### Scenario: running Step 冷恢复续跑
- **WHEN** 恢复含 `running` 状态 agent Step 的实例
- **THEN** followup 触发子代理冷恢复并等待完成；完成后走 output 提取/finalize/outputTo；DAG 从该 Step 继续推进

#### Scenario: paused Step 恢复登记表等待手动
- **WHEN** 恢复含 `paused` 状态 Step 的实例
- **THEN** 登记表重建含该 childId；不自动 followup；实例状态保持 `paused` 直到用户 resumeStep/resumeAllSteps

#### Scenario: 合成 session 标记失败
- **WHEN** 快照含 shell Step（synthetic childId、无真实子代理）
- **THEN** 该 Step 标记 `failed`，不尝试冷恢复

### Requirement: 恢复后状态一致性
恢复完成后引擎 SHALL 持久化最新状态，且恢复的实例上 `sandore/*` Session 事件与 apiproxy SSE 链路正常工作（沿用 emitContained + safeAppend 双发范式，无自建 SSE）。

#### Scenario: 恢复后事件正常
- **WHEN** 恢复完成的实例继续执行 Step
- **THEN** `sandore/step-start` 等事件正常 Session append；实例状态快照更新

#### Scenario: 快照重建内存态
- **WHEN** 执行恢复流程
- **THEN** 引擎从 state 快照重建全部内存数据（executedSteps/pendingQueue/visitCounts/passThroughVars/activeLoopStack/pausedChildIds/pendingInteractions/stageContracts），与持久化前语义一致
