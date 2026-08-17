# Spec: run-view

## ADDED Requirements

### Requirement: 执行轨迹只读视图
`RunView` SHALL 渲染实例的执行轨迹：经 `ctx.remote.sandore.getInstanceState(instanceId)` 拉取 `WorkflowTaskState`，按 `stageInfos` 分组渲染 `executedSteps[]`（每 Step：状态图标（7 态 StepStatus）、名称、访问计数徽章、错误信息）；Stage 间串行推进示意；全部只读。

#### Scenario: 轨迹分组渲染
- **WHEN** 用户进入某实例 RunView
- **THEN** 按 Stage 分组展示各 Step（状态、名称、visitCount 徽章；failed Step 附 error）

### Requirement: 产物面板
RunView SHALL 提供产物面板：经 `ctx.remote.sandore.getArtifacts(instanceId, stageId?)` 拉取 `ArtifactEntry[]`（stepId/stageId/outputToId/files/returnPrompt），实例处于运行中状态时 5s 轮询、终态停止；分层显示（Stage → Step → 文件/回答）。

#### Scenario: 运行中轮询产物
- **WHEN** 实例状态为 running/interacting 且 RunView 打开
- **THEN** 每 5s 调用 `getArtifacts` 刷新产物面板；进入终态或离开 RunView 后停止

### Requirement: 交互控件
RunView SHALL 提供实例级与 Step 级交互控件，全部经 `ctx.remote.sandore.*` 调用并在动作后立即手动刷新状态：
- 实例级：`abortInstance`（中止）、`pauseAll`/`resumeAll`
- Step 级：`pauseStep`/`resumeStep`（可附 resumePrompt）、`retryStep`（mode: continue/revert/fork + message）
- 问答：`pendingInteractions` 中的 PendingQuestion 渲染问答卡片（复用 `ui-user-questions` 的 `PendingQuestion`），提交经 `replyQuestion({instanceId, requestId, answers})`
- 权限：PendingPermission 渲染审批卡片，应答经 `replyPermission({instanceId, requestId, reply})`

#### Scenario: 暂停单个 Step
- **WHEN** 用户对运行中的 Step 点击暂停
- **THEN** 调用 `pauseStep` 后立即刷新 `getInstanceState`，该 Step 状态变为 paused

#### Scenario: 问答回复
- **WHEN** 实例存在待答问题且用户提交答案
- **THEN** 调用 `replyQuestion` 成功后该待办从 pendingInteractions 消失（刷新可见）

#### Scenario: 重试失败 Step
- **WHEN** 用户对 failed Step 选择 revert 模式重试并填写 message
- **THEN** 调用 `retryStep({instanceId, stepId, mode:'revert', message})`，成功后轨迹刷新

### Requirement: 打开讨论按钮
RunView 头部 SHALL 提供「打开讨论」按钮，点击调用 `ctx.sessions.open(instanceId)`（宿主 Session id == instanceId），跳转到宿主会话 chat 视图（内含 `sandore-step` 讨论节点）。

#### Scenario: 跳转宿主会话
- **WHEN** 用户点击「打开讨论」
- **THEN** DSH 打开宿主 Session 会话页（`ctx.sessions.open(instanceId)`）

### Requirement: 实例状态轮询
RunView 打开期间 SHALL 以 5s 轮询 `getInstanceState`（实例运行中时），并展示实例状态徽章（7 态 DagRunStatus）；离开 RunView 或终态时停止轮询。

#### Scenario: 状态实时更新
- **WHEN** RunView 打开且实例从 running 转为 completed
- **THEN** 5s 内状态徽章更新为 completed，轮询停止
