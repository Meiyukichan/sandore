## ADDED Requirements

### Requirement: 宿主主代理创建
`startInstance` SHALL 经 `ctx.agents.create({ sessionId: SessionId(instanceId), meta: { cwd }, setup })` 创建宿主主代理（而非裸 `ctx.sessions.create`），setup 回调在 agent/session 发布前执行并完成工具注册与 system prompt 注入。引擎 SHALL 持有 live `hostAgent` 引用并存入 `ActiveInstance.hostAgent`，并将该引用注入 `StepRunnerConfig.hostAgent`（Step 子代理的 parent、interrupt authority、followup parent）。

#### Scenario: startInstance 创建真主代理
- **WHEN** 调用 `engine.startInstance(request)` 且创建成功
- **THEN** 内部经 `ctx.agents.create` 创建 sessionId=instanceId 的 Agent；setup 回调被调用；`ActiveInstance.hostAgent` 持有该 Agent；`StepRunnerConfig.hostAgent` 等于该引用

#### Scenario: setup 内注册 per-instance 工具
- **WHEN** `agents.create` 的 setup 回调执行
- **THEN** 8 个 `sandore_*` 工具经 `agentCtx.tools.register` 注册，每个工具闭包捕获该实例的 `instanceId`；system prompt 经 `agentCtx.systemPrompt.section` 注入编排器角色说明

#### Scenario: setup 抛错则整体回滚
- **WHEN** setup 回调抛出异常或返回失败的 commit
- **THEN** agent/session 不发布（沿用 DSH `agents.create` 回滚语义），`startInstance` 以错误结束，不留下孤儿 Session 或半注册工具

### Requirement: 主代理不自动运行编排
宿主主代理创建后 SHALL NOT 自动发送首轮 prompt 或启动 agent loop。工作流编排仍由引擎 `runInstance` 主循环驱动；主代理的 agent loop 仅由用户消息（DSH 原生 composer）触发，经自然语言决策显式调用 `sandore_*` 工具（D9）。

#### Scenario: 创建后无自动 prompt
- **WHEN** `startInstance` 完成宿主主代理创建
- **THEN** 主代理未被注入任何用户消息（status 保持 idle），引擎同步启动 `runInstance` 编排循环

### Requirement: completed 后自然降级（D9）
工作流进入 `completed` 终态后，宿主 Session SHALL 自然降级为自由对话 agent——不切换身份、不卸载工具、不挂载额外默认会话（无 DefaultSessionManager、无 default-session-mounted 事件）。`resume`/`retry` 类工具对 completed 实例返回无害 no-op，`getState` 始终可用。

#### Scenario: completed 后自由对话
- **WHEN** 实例进入 `completed` 后用户向宿主 Session 发送普通消息
- **THEN** 主代理 agent loop 正常处理该消息（自由对话），不产生新的工作流编排动作

#### Scenario: completed 态 resume 工具 no-op
- **WHEN** 主代理对 `completed` 实例调用 `sandore_resumeStep` 或 `sandore_retryStep`
- **THEN** 工具返回结构化 no-op 结果（不抛错、不改变实例状态）

### Requirement: 工具仅挂宿主 Session（影响隔离）
`sandore_*` 工具 SHALL 仅注册在对应工作流实例的宿主主代理上（per-instance 闭包），不影响 DSH 普通会话（默认 preset）与其他工作流实例（各有自己的 instanceId 闭包）。

#### Scenario: 普通会话无 sandore 工具
- **WHEN** 用户在非工作流宿主的普通 DSH 会话中查看可用工具
- **THEN** 不存在任何 `sandore_*` 工具

#### Scenario: 多实例工具互不串扰
- **WHEN** 两个工作流实例 A、B 同时运行，A 的主代理调用 `sandore_pauseStep`
- **THEN** 仅作用于 A 的 instanceId 闭包绑定的实例，B 不受影响

### Requirement: 宿主主代理冷恢复
崩溃恢复时引擎 SHALL 经 `ctx.agents.resume({ resumeSessionId: hostSessionId, setup })` 冷恢复宿主主代理，setup 回调重跑（8 个工具 + instanceId 闭包 + system prompt 自动重注册），引擎重新持有 live `hostAgent` 引用。setup 回调 SHALL 由同一工厂函数生成（create 与 resume 共用，保证注册行为一致）。

#### Scenario: 冷恢复重注册工具
- **WHEN** `recoverOrphanedInstances` 对非终态实例执行宿主冷恢复
- **THEN** `agents.resume` 以 resumeSessionId=hostSessionId 调用且携带 setup；setup 重跑后 8 个 `sandore_*` 工具再次注册；恢复后的 hostAgent 可作为 interrupt authority 与 followup parent
