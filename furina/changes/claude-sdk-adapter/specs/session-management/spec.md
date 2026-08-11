## ADDED Requirements

### Requirement: Client factory

系统 SHALL 导出 `createClaudeClient(options)` 工厂方法，返回一个 opencode 协议风格的方法级客户端对象。options MUST 包含 `cwd` 字段（工作目录）。客户端对象 MUST 暴露 `session`、`model`、`global` 三个命名空间属性。客户端不 SHALL 启动任何 HTTP 服务器。

#### Scenario: 创建客户端实例

- **WHEN** 调用 `createClaudeClient({ cwd: '/path/to/project' })`
- **THEN** 返回一个客户端对象，包含 `session`、`model`、`global` 命名空间

#### Scenario: cwd 作为默认项目标识

- **WHEN** 调用 `createClaudeClient` 时传入 `cwd`
- **THEN** 该 cwd 作为客户端的默认 directory，用于会话创建与事件过滤

### Requirement: Create session

系统 SHALL 提供 `client.session.create(options)` 方法，创建一个新的 Claude 会话并返回符合 opencode `SessionV2Info` 结构的对象。方法内部 MUST 后台启动 Claude SDK 的 `query()`（流式输入模式），从 `system/init` 消息的 `session_id` 字段捕获会话 ID。返回的 SessionV2Info MUST 包含 `id`、`projectID`、`time`、`title`、`location`、`cost`、`tokens` 字段。

鉴于 Claude SDK 的 `system/init` 仅在首条用户消息 yield 后才产出（集成测试实证），create() MUST 支持两种初始化路径：
- 提供可选 `firstMessage` 参数时，create() 立即 push 该消息作为首条用户消息，捕获真实 session_id 后 resolve 完整 SessionV2Info（id 为真实 session_id）。
- 未提供 `firstMessage` 时，create() 返回占位 SessionV2Info（id 为预生成占位 `ses_<uuid>`），会话处于 pending 状态；首个 prompt() push 后触发 init，捕获真实 session_id，会话转为 created（首消息后才算创建完成）。

create() 的 init 捕获（firstMessage 路径）MUST 受 `initTimeoutMs` 超时保护，超时 reject TimeoutError 并清理。首个 prompt() 触发的 init 捕获亦受超时约束。

#### Scenario: 成功创建会话（提供 firstMessage）

- **WHEN** 调用 `client.session.create({ model: { id: 'sonnet', providerID: 'anthropic' }, firstMessage: 'hello' })`
- **THEN** 后台启动 query()，将该消息 push 为首条用户消息，捕获 `system/init` 消息的 `session_id`
- **AND** 返回 SessionV2Info 对象，其 `id` 等于捕获的真实 session_id
- **AND** 返回对象的 `location.directory` 等于客户端 cwd
- **AND** 会话在返回前已完成创建（created 状态），首条消息被调度为该会话第一条真实输入

#### Scenario: 创建会话而不提供 firstMessage（惰性回填）

- **WHEN** 调用 `client.session.create({ model: { id: 'sonnet', providerID: 'anthropic' } })`（无 firstMessage）
- **THEN** 返回占位 SessionV2Info，其 `id` 为预生成占位（`ses_` 前缀）
- **AND** 会话处于 pending 状态，尚未完成初始化
- **WHEN** 随后调用 `client.session.prompt('ses-xxx', { prompt: { text: 'hello' } })`
- **THEN** 该消息触发 init，捕获真实 session_id，会话转为 created
- **AND** 后续 prompt 返回的 SessionInputAdmitted 使用真实 session_id

#### Scenario: 创建会话时指定 agent

- **WHEN** 调用 `client.session.create({ agent: 'general-purpose' })`
- **THEN** 内部 query() 的 options 设置 `agent: 'general-purpose'`
- **AND** 返回的 SessionV2Info 包含该 agent 值

#### Scenario: session.create 在启动超时后失败

- **WHEN** 提供 firstMessage 时 Claude SDK 的 `system/init` 消息在合理超时时间内未到达
- **THEN** session.create() reject 并抛出超时错误

### Requirement: Read session messages

系统 SHALL 提供 `client.session.messages(sessionId, options?)` 方法，读取指定会话的历史消息。返回结果 MUST 符合 opencode `SessionMessagesResponse` 结构（`{ data: SessionMessage[], cursor: { previous?, next? } }`）。内部 MUST 调用 Claude SDK 的 `getSessionMessages()`。

#### Scenario: 读取会话全部消息

- **WHEN** 调用 `client.session.messages('ses-xxx')`
- **THEN** 返回 SessionMessagesResponse，其 `data` 包含该会话的历史消息（user/assistant/system 类型）
- **AND** 每条消息符合 SessionMessage 结构

#### Scenario: 分页读取消息

- **WHEN** 调用 `client.session.messages('ses-xxx', { limit: 10, cursor: '<opaque>' })`
- **THEN** 返回最多 10 条消息
- **AND** 返回的 `cursor.next` 可用于下一页请求

### Requirement: Send message (prompt)

系统 SHALL 提供 `client.session.prompt(sessionId, input)` 方法，向指定会话发送消息。input MUST 包含 `prompt` 字段（符合 PromptInput 结构，含 `text`）。方法 MUST 通过向该会话的流式输入队列 push `SDKUserMessage` 实现。返回结果 MUST 符合 opencode `SessionInputAdmitted` 结构。

#### Scenario: 发送文本消息

- **WHEN** 调用 `client.session.prompt('ses-xxx', { prompt: { text: 'hello' } })`
- **THEN** 向该 session 的输入队列 push 一条 `{ type:'user', message:{role:'user', content:'hello'}, parent_tool_use_id:null }`
- **AND** 返回 SessionInputAdmitted 对象，包含 `sessionID`、`prompt`、`delivery`、`timeCreated`、`id`（`^msg_` 前缀）

#### Scenario: 向不存在的会话发送消息

- **WHEN** 调用 `client.session.prompt('ses-nonexistent', { prompt: { text: 'hi' } })`
- **THEN** 抛出 SessionNotFoundError 或等价错误

### Requirement: Interrupt session execution

系统 SHALL 提供 `client.session.interrupt(sessionId)` 方法，中断指定会话当前正在执行的 agent loop。内部 MUST 调用 Claude SDK 的 `Query.interrupt()`。对应 opencode v2 的 `POST /api/session/{id}/interrupt`。

#### Scenario: 中断正在执行的会话

- **WHEN** 会话 'ses-xxx' 正在执行，调用 `client.session.interrupt('ses-xxx')`
- **THEN** 调用该会话 Query 的 `interrupt()` 方法
- **AND** 中断当前 agent loop 执行

#### Scenario: 中断空闲会话为 no-op

- **WHEN** 会话 'ses-xxx' 处于空闲状态，调用 `client.session.interrupt('ses-xxx')`
- **THEN** 不抛出错误，操作为 no-op

### Requirement: Wait for session idle

系统 SHALL 提供 `client.session.wait(sessionId, options?)` 方法，等待指定会话的 agent loop 变为空闲状态。对应 opencode v2 的 `POST /api/session/{id}/wait`。

#### Scenario: 等待执行中的会话空闲

- **WHEN** 会话 'ses-xxx' 正在执行，调用 `client.session.wait('ses-xxx')`
- **THEN** 方法在会话变为空闲状态后 resolve

#### Scenario: 等待超时

- **WHEN** 调用 `client.session.wait('ses-xxx', { timeout: 5000 })` 且会话在 5 秒内未空闲
- **THEN** 方法 reject 并抛出超时错误

### Requirement: Session state management

系统 SHALL 在后台维护 `Map<sessionId, SessionState>`，每个 SessionState MUST 封装该会话的 Query 句柄、流式输入队列、事件通道。session.create() 创建 SessionState，prompt/interrupt/wait/events 通过 sessionId 查找对应 SessionState 操作。

#### Scenario: 会话状态隔离

- **WHEN** 并发创建两个会话 'ses-a' 和 'ses-b'
- **THEN** 两个会话的 SessionState 相互独立
- **AND** 向 'ses-a' 发送消息不影响 'ses-b' 的输入队列

#### Scenario: 会话关闭清理资源

- **WHEN** 调用会话的关闭操作（如 close）
- **THEN** 该会话的 Query 句柄被关闭，事件通道结束，SessionState 从 Map 中移除
