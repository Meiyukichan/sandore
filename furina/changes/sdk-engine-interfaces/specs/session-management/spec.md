## ADDED Requirements

### Requirement: Delete session

系统 SHALL 提供 `client.session.delete(sessionId)` 方法，删除指定会话。该方法 MUST 先关闭本地 SessionState（关闭 Query、结束事件通道、从 Map 移除），再调用底层 `deleteSession(resolvedId, { dir })` 删除磁盘会话文件。delete 与 close 的区别：delete 额外清理服务端/磁盘会话数据，close 仅清理客户端内存态。

#### Scenario: 删除存在的会话

- **WHEN** 调用 `client.session.delete('ses-xxx')`
- **THEN** 该会话的 SessionState 被关闭（Query 关闭、事件通道结束、从 Map 移除）
- **AND** 底层调用 `deleteSession('ses-xxx', { dir })` 删除磁盘会话文件

#### Scenario: 删除不存在的会话

- **WHEN** 调用 `client.session.delete('ses-nonexistent')`
- **THEN** 抛出 SessionNotFoundError

### Requirement: Set permission mode at runtime

系统 SHALL 提供 `client.session.setPermissionMode(sessionId, mode)` 方法，在运行时切换指定会话的权限模式。底层 MUST 调用该会话 Query 的 `setPermissionMode(mode)`（仅 streaming input mode 可用）。mode MUST 为 Claude SDK 的 `PermissionMode` 联合（`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`）。该方法支撑引擎 V2.3 updateInstancePermissionMode 运行时权限切换。

#### Scenario: 运行时切换权限模式

- **WHEN** 会话 'ses-xxx' 当前为 default 模式，调用 `client.session.setPermissionMode('ses-xxx', 'acceptEdits')`
- **THEN** 底层调用该会话 Query 的 `setPermissionMode('acceptEdits')`
- **AND** 后续该会话的工具调用按 acceptEdits 模式处理（文件编辑类自动放行）

#### Scenario: 切换不存在的会话权限模式

- **WHEN** 调用 `client.session.setPermissionMode('ses-nonexistent', 'default')`
- **THEN** 抛出 SessionNotFoundError

### Requirement: Prompt with per-message permission mode

`client.session.prompt` 的 input SHALL 支持可选 `permissionMode` 字段。提供时，若该值与当前会话权限模式不同，MUST 在 push 消息前调用 `Query.setPermissionMode(mode)` 切换为该模式。未提供时保持当前会话权限模式不变。

#### Scenario: prompt 时指定权限模式

- **WHEN** 会话 'ses-xxx' 当前为 default 模式，调用 `client.session.prompt('ses-xxx', { prompt: { text: 'edit file' }, permissionMode: 'acceptEdits' })`
- **THEN** 在 push 消息前调用 `Query.setPermissionMode('acceptEdits')`
- **AND** 随后 push 用户消息到输入队列

#### Scenario: prompt 未指定权限模式时不变

- **WHEN** 调用 `client.session.prompt('ses-xxx', { prompt: { text: 'hi' } })`（未传 permissionMode）
- **THEN** 不调用 setPermissionMode，保持会话当前权限模式

## MODIFIED Requirements

### Requirement: Create session

系统 SHALL 提供 `client.session.create(options)` 方法，创建一个新的 Claude 会话并返回符合 opencode `SessionV2Info` 结构的对象。方法内部 MUST 后台启动 Claude SDK 的 `query()`（流式输入模式），从 `system/init` 消息的 `session_id` 字段捕获会话 ID。返回的 SessionV2Info MUST 包含 `id`、`projectID`、`time`、`title`、`location`、`cost`、`tokens` 字段。

鉴于 Claude SDK 的 `system/init` 仅在首条用户消息 yield 后才产出（集成测试实证），create() MUST 支持两种初始化路径：
- 提供可选 `firstMessage` 参数时，create() 立即 push 该消息作为首条用户消息，捕获真实 session_id 后 resolve 完整 SessionV2Info（id 为真实 session_id）。
- 未提供 `firstMessage` 时，create() 返回占位 SessionV2Info（id 为预生成占位 `ses_<uuid>`），会话处于 pending 状态；首个 prompt() push 后触发 init，捕获真实 session_id，会话转为 created（首消息后才算创建完成）。

create() 的 init 捕获（firstMessage 路径）MUST 受 `initTimeoutMs` 超时保护，超时 reject TimeoutError 并清理。首个 prompt() 触发的 init 捕获亦受超时约束。

options SHALL 支持可选 `title?: string` 字段，提供时返回的 SessionV2Info 的 `title` 字段 MUST 使用该值（而非空字符串）。options SHALL 支持可选 `enableFileCheckpointing?: boolean` 字段（详见 session-retry 能力）。

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

#### Scenario: 创建会话时指定 title

- **WHEN** 调用 `client.session.create({ firstMessage: 'hello', title: 'my-session' })`
- **THEN** 返回的 SessionV2Info 的 `title` 字段等于 `'my-session'`

#### Scenario: session.create 在启动超时后失败

- **WHEN** 提供 firstMessage 时 Claude SDK 的 `system/init` 消息在合理超时时间内未到达
- **THEN** session.create() reject 并抛出超时错误

### Requirement: Read session messages

系统 SHALL 提供 `client.session.messages(sessionId, options?)` 方法，读取指定会话的历史消息。返回结果 MUST 符合 opencode `SessionMessagesResponse` 结构（`{ data: SessionMessage[], cursor: { previous?, next? } }`）。内部 MUST 调用 Claude SDK 的 `getSessionMessages()`。

options SHALL 支持可选 `before?: string` 字段（消息 ID 游标）。提供 before 时，MUST 透传给底层 `getSessionMessages` 的 before 参数，返回该消息 ID 之前的消息（用于向前分页）。before 与 offset cursor 互斥；同时提供时 before 优先。

#### Scenario: 读取会话全部消息

- **WHEN** 调用 `client.session.messages('ses-xxx')`
- **THEN** 返回 SessionMessagesResponse，其 `data` 包含该会话的历史消息（user/assistant/system 类型）
- **AND** 每条消息符合 SessionMessage 结构

#### Scenario: 分页读取消息

- **WHEN** 调用 `client.session.messages('ses-xxx', { limit: 10, cursor: '<opaque>' })`
- **THEN** 返回最多 10 条消息
- **AND** 返回的 `cursor.next` 可用于下一页请求

#### Scenario: 按 before 消息 ID 分页读取

- **WHEN** 调用 `client.session.messages('ses-xxx', { limit: 10, before: 'msg-123' })`
- **THEN** 底层 `getSessionMessages` 的 options 包含 `before: 'msg-123'`
- **AND** 返回 msg-123 之前的最多 10 条消息

### Requirement: Send message (prompt)

系统 SHALL 提供 `client.session.prompt(sessionId, input)` 方法，向指定会话发送消息。input MUST 包含 `prompt` 字段（符合 PromptInput 结构）。PromptInput 支持两种消息形式：（1）`text` 字段——单文本字符串；（2）`parts` 字段——结构化文本块数组（详见 structured-prompt-parts 能力）。方法 MUST 通过向该会话的流式输入队列 push `SDKUserMessage` 实现。返回结果 MUST 符合 opencode `SessionInputAdmitted` 结构。input SHALL 支持可选 `permissionMode` 字段（详见 per-message permission mode 要求）。

#### Scenario: 发送文本消息

- **WHEN** 调用 `client.session.prompt('ses-xxx', { prompt: { text: 'hello' } })`
- **THEN** 向该 session 的输入队列 push 一条 `{ type:'user', message:{role:'user', content:'hello'}, parent_tool_use_id:null }`
- **AND** 返回 SessionInputAdmitted 对象，包含 `sessionID`、`prompt`、`delivery`、`timeCreated`、`id`（`^msg_` 前缀）

#### Scenario: 发送结构化 parts 消息

- **WHEN** 调用 `client.session.prompt('ses-xxx', { prompt: { parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } })`
- **THEN** 向输入队列 push 的 SDKUserMessage 的 `message.content` 为 `[{ type:'text', text:'a' }, { type:'text', text:'b' }]`

#### Scenario: 向不存在的会话发送消息

- **WHEN** 调用 `client.session.prompt('ses-nonexistent', { prompt: { text: 'hi' } })`
- **THEN** 抛出 SessionNotFoundError 或等价错误
