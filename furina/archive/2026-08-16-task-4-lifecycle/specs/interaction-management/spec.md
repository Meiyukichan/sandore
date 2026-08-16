## ADDED Requirements

### Requirement: 引擎级 ask 主通道
finalize 判定 `completionType='ask'` 时，交互管理器 SHALL 以宿主主代理身份调用 `ctx.userQuestions.ask({ agent: hostAgent, questions })` 发起 DSH 原生问答卡片，await 答案后恢复 Step 执行（继续门禁审查或推进下一节点）。Step SHALL 在 ask 期间处于 `interacting` 状态。

#### Scenario: finalize ask 全链路闭环
- **WHEN** FinalizeAssessor 判定 `completionType='ask'` 并产出 askQuestion 载荷
- **THEN** Step 状态置 `interacting`；`ctx.userQuestions.ask` 以 hostAgent 身份发起，questions 对齐 `AskUserQuestionItem` schema（`multi_select` 蛇形映射为 `multiSelect` 驼峰）；用户经 DSH 原生卡片回复后 ask 的 await resolve，Step 恢复执行并推进后续节点

#### Scenario: ask 载荷字段映射
- **WHEN** 引擎构造 ask 请求
- **THEN** 载荷 questions 数组每项含 `id`/`question`，可选 `header`/`options`/`multiSelect`，与 DSH `AskUserQuestionItem` 结构一致

### Requirement: pending Map 镜像持久化
交互管理器 SHALL 维护 `pendingQuestions`/`pendingPermissions` Map（requestId → 条目）并在登记/回复/拒绝时同步持久化到 `WorkflowTaskState.pendingInteractions`（结构化条目，非 unknown）。Map 是镜像（用于崩溃恢复重建交互），回复的权威路径是 `userQuestions.ask` 的 await。

#### Scenario: 登记即持久化
- **WHEN** `addPendingQuestion`/`addPendingPermission` 登记 pending 条目
- **THEN** 条目（含 id/stageId/stepId/sessionId/requestId/kind/status='pending'/payload/createdAt）写入 state 快照并发射 `sandore/question`/`sandore/permission` 事件（Session append + Cordis 双发）

#### Scenario: 回复后条目终态化
- **WHEN** pending 条目被回复或拒绝
- **THEN** Map 中条目移除，快照同步更新（条目状态置 replied/rejected 并持久化；不发射额外事件，回复的权威路径是 `userQuestions.ask` 的 await）

### Requirement: replyQuestion/replyPermission 兼容路径
交互管理器 SHALL 提供 `replyQuestion(requestId, answers)` 与 `replyPermission(requestId, reply)` 兼容回复路径：resolve 内部等待 Promise（与 `userQuestions.ask` 的 await 汇合），更新条目状态为 replied/rejected 并持久化。该路径用于 DSH 卡片通道不可用（如 headless 测试）的场景。

#### Scenario: 兼容路径回复
- **WHEN** pending question 存在时调用 `engine.replyQuestion(instanceId, requestId, answers)`
- **THEN** 内部等待 Promise resolve（等效于卡片回复），Step 恢复执行，条目状态更新并持久化

#### Scenario: 未知 requestId 报错
- **WHEN** `replyQuestion`/`replyPermission` 收到不存在或已 replied 的 requestId
- **THEN** 抛 `SandoreError`（`INVALID_OPERATION`），不改变任何状态

### Requirement: 子代理 ask 转接（DELEGATED_CALLER 规避）
Step 子代理不能直接向用户提问（DSH `ctx.userQuestions.ask` 对 owned child 抛 `DELEGATED_CALLER`）。引擎 SHALL 在 Step 子代理完成后扫描其 final result：含保守标记块（`[[SANDORE_ASK]]{...}[[/SANDORE_ASK]]`）且 JSON 可解析为合法 ask 载荷时，转换为引擎级 ask（hostAgent 问用户），用户答案经 `followup` 注回该子代理继续执行；否则按普通输出处理。

#### Scenario: 子代理问题转接
- **WHEN** Step 子代理 final result 含合法标记块
- **THEN** 引擎解析出 questions → 以 hostAgent 身份发起引擎级 ask → 答案 `followup` 给该子代理 → 子代理继续执行至完成

#### Scenario: 伪造/非法标记块不转接
- **WHEN** final result 含标记块但 JSON 解析失败或 schema 校验不通过
- **THEN** 不转接，按普通输出继续正常流程

### Requirement: 权限镜像（无自动审批）
引擎 SHALL NOT 实现 permissionMode 或自动审批（DSH 权限治理完全交给 permission presets：子代理继承宿主 Session preset，approval 固定 `never`）。`PendingPermission` 条目仅作 DSH approval 事件的镜像登记（`sandore/permission` 事件 + 兼容 `replyPermission`），提权 ask 在子代理侧确定性拒绝。

#### Scenario: 无 permissionMode 配置面
- **WHEN** 检查 Task 4 交付的引擎配置与 startInstance 请求
- **THEN** 不存在 permissionMode/bypassPermissions/acceptEdits 等权限字段
