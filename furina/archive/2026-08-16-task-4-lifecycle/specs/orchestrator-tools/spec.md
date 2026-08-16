## ADDED Requirements

### Requirement: 8 个编排器工具定义
`tool` 包 SHALL 提供 8 个 `sandore_*` 模型工具（`sandore_getState`/`sandore_startInstance`/`sandore_abortInstance`/`sandore_pauseStep`/`sandore_resumeStep`/`sandore_pauseAllSteps`/`sandore_resumeAllPaused`/`sandore_retryStep`），以结构化工具定义（defineTool 形状）导出工厂：`createSandoreTools({ instanceId, engine })` 返回可在宿主主代理 `setup(agentCtx)` 中经 `agentCtx.tools.register` 注册的工具数组。工具逻辑 SHALL 全部转调 `engine` 实例级方法，不持有业务状态。

#### Scenario: 工具名与转调映射
- **WHEN** 检查 8 个工具定义
- **THEN** 名称分别为 `sandore_getState`/`sandore_startInstance`/`sandore_abortInstance`/`sandore_pauseStep`/`sandore_resumeStep`/`sandore_pauseAllSteps`/`sandore_resumeAllPaused`/`sandore_retryStep`；每个 execute 转调对应 engine 方法且闭包捕获 instanceId

#### Scenario: 工具 schema 完整
- **WHEN** 注册到 agentCtx
- **THEN** 每个工具含 name/description/参数 schema（zod 或等价 JSON schema 形状）；`sandore_resumeStep` 接受可选 resumePrompt；`sandore_retryStep` 接受 stepId/mode('continue'|'revert'|'fork')/message

### Requirement: per-instance 闭包注册
工具 SHALL 经宿主主代理的 `agents.create({ setup })` / `agents.resume({ setup })` 注册（非 preset standing mount），闭包捕获各自 instanceId——普通 DSH 会话与其他工作流实例的工具面互不影响。

#### Scenario: 注册路径走 setup
- **WHEN** host-agent 创建宿主主代理
- **THEN** setup 内经 `agentCtx.tools.register` 逐个注册 `createSandoreTools` 返回的工具；无全局 `ctx.tools` standing 注册

### Requirement: 状态感知的工具语义（D9 自然降级）
工具行为 SHALL 随实例状态自然降级：`sandore_resumeStep`/`sandore_retryStep`/`sandore_pauseStep`/`sandore_pauseAllSteps`/`sandore_resumeAllPaused` 对非适用状态（如 completed 实例）返回结构化 no-op 结果（含原因说明），不抛错；`sandore_getState` 对任何状态可用（只读）；`sandore_abortInstance` 对终态实例返回 no-op。

#### Scenario: 工具 no-op 语义
- **WHEN** completed 实例的主代理调用 `sandore_pauseStep`
- **THEN** 工具返回 no-op 结果（说明实例已终态），不改变状态、不抛错

#### Scenario: 工具错误透传
- **WHEN** 主代理调用 `sandore_resumeStep` 传入不存在的 stepId
- **THEN** 工具返回错误信息结果（engine 抛出的 SandoreError 摘要），主代理可向用户解释
