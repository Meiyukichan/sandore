## ADDED Requirements

### Requirement: continue 模式重试
`retryStep(instanceId, stepId, 'continue', message)` SHALL 在同一子代理 Session 中继续：`ctx.subagents.followup(hostAgent, childId, text(message), { source, signal })` 追加用户消息 → 等待 `whenIdle()` → `finalAssistantOutput` 收集结果 → 走共享后处理（output 提取 + finalize + outputTo）→ DAG 推进。sessionId 不变。

#### Scenario: continue 同会话续跑
- **WHEN** 对 failed Step 以 continue 模式重试并附带 message
- **THEN** `followup` 发往原 childId；完成后 Step 恢复正常推进；`retryHistory` 新增 `{ mode:'continue', result }` 记录；sessionMeta.childId 不变

### Requirement: revert 模式重试
`retryStep(instanceId, stepId, 'revert', message)` SHALL：计算安全 turn 边界（最后一个闭合 turn 末事件 seq，不得落未闭合 turn）→ `ctx.sessions.fork(childId, boundary)` 取前缀 → `ctx.agents.create({ seed: forkedSession.events, sessionId: 新合成 childId, ... })` 续跑 → 产生新 session id。executedStep SHALL 记录 `parentSessionId`（旧 childId）并更新 `sessionMeta.childId` 为新值。

#### Scenario: revert 回退到安全边界
- **WHEN** revert 模式重试
- **THEN** 引擎计算最后一个闭合 turn 的末事件 seq 作为安全 boundary，fork 以该 boundary 截取前缀；新子代理从回退点携带 message 续跑；executedStep 的 childId 更新为新 session id、parentSessionId 记录旧值

#### Scenario: 边界计算落未闭合 turn 被拒
- **WHEN** 无法取到合法闭合 turn（计算得到的 boundary 落在未闭合 turn 内）
- **THEN** 重试以错误结束（透传 DSH OPEN_TURN 类错误），实例状态不变坏（保持可重试的 failed）

### Requirement: fork 模式重试
`retryStep(instanceId, stepId, 'fork', message)` SHALL：`ctx.sessions.fork(childId, boundary?)`（省略 boundary = 保留全部历史）→ `agents.create({ seed })` 创建新子代理续跑 → 产生新 session id，`parentSessionId` 记录旧值。

#### Scenario: fork 分叉新会话
- **WHEN** fork 模式重试
- **THEN** fork 不指定 boundary（全量历史）；新 agent 续跑产生新 childId；`retryHistory` 记录 `{ mode:'fork' }`；后续 Step 推进使用新会话输出

### Requirement: 重试前置校验
`retryStep` SHALL 仅对 `failed` 状态的 Step 发起（或对已 completed 实例返回无害 no-op）；对执行中（running/interacting/paused）Step 重试 SHALL 抛 `SandoreError`（`INVALID_OPERATION`）。

#### Scenario: 执行中不可重试
- **WHEN** 对 `running` 状态的 Step 调用 `retryStep`
- **THEN** 抛 `INVALID_OPERATION`，无任何副作用

#### Scenario: completed 实例重试 no-op
- **WHEN** 实例处于 `completed`，调用 `retryStep`
- **THEN** 返回结构化 no-op 结果，不抛错、不改变状态

### Requirement: 重试状态清理与历史记录
每次重试 SHALL：Step/工作流状态置 `running` → 清除上一轮残留字段（`pausedAt`/`resumedAt`/`resumePrompt`/`sessionMessages`/`pauseEntryId`/`finalizeMeta`）→ sessionMeta 清空 `outputJson`（fork/revert 额外更新 childId）→ 发射 `sandore/step-retried` 事件（payload 含 stepId 与 mode）→ 将 `RetryRecord`（mode/timestamp/userMessage/revertMessageId?/result）追加到 `executedStep.retryHistory`，result 随最终结果更新为 `completed`/`failed`。

#### Scenario: 重试事件与历史
- **WHEN** 任一模式重试发起
- **THEN** `sandore/step-retried` 事件 Session append + Cordis 双发且载荷含 mode；完成后 retryHistory 末条记录 result 与实际结果一致

### Requirement: 重试对工作流状态的影响
重试成功后工作流 SHALL 按正常完成路径流转（可能转 `completed`，宿主 Session 自然降级）；重试失败 SHALL 保持工作流 `failed`（主代理可再次调用 `sandore_retryStep`）。

#### Scenario: 重试成功转 completed
- **WHEN** 最后一个 failed Step 重试成功且无其他待执行节点
- **THEN** 工作流转 `completed`，宿主 Session 自然降级为自由对话

#### Scenario: 重试失败保持 failed
- **WHEN** 重试后 Step 仍失败
- **THEN** 工作流保持 `failed`；`retryStep` 可再次发起
