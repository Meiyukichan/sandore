## ADDED Requirements

### Requirement: Revert session

系统 SHALL 提供 `client.session.revert(sessionId, messageId, options?)` 方法，将指定会话回退到某个历史消息点。revert MUST 实现双层语义：（1）对话层——通过底层 `forkSession(sessionId, { upToMessageId: messageId, dir })` 分叉出新会话，新会话历史截断到 messageId（含），丢弃 messageId 之后的消息；（2）文件层——若原会话启用了 `enableFileCheckpointing`，对原会话 Query 调用 `rewindFiles(messageId)` 将文件恢复到该消息时的状态。返回值 MUST 包含新会话 ID（`newSessionId`）与原会话 ID（`originalSessionId`）的映射。原会话句柄 MUST 保留存活（供 unrevert 使用）。

#### Scenario: revert 到指定消息点（启用文件检查点）

- **WHEN** 会话 'ses-xxx' 启用了 `enableFileCheckpointing`，调用 `client.session.revert('ses-xxx', 'msg-123')`
- **THEN** 底层调用 `forkSession('ses-xxx', { upToMessageId: 'msg-123', dir })` 分叉出新会话
- **AND** 对原会话 Query 调用 `rewindFiles('msg-123')` 回滚文件
- **AND** 返回结果包含 `newSessionId`（新分叉会话）与 `originalSessionId: 'ses-xxx'`
- **AND** 原会话 'ses-xxx' 句柄保留存活

#### Scenario: revert 到指定消息点（未启用文件检查点）

- **WHEN** 会话 'ses-xxx' 未启用 `enableFileCheckpointing`，调用 `client.session.revert('ses-xxx', 'msg-123')`
- **THEN** 底层调用 `forkSession` 分叉出新会话（对话层截断）
- **AND** 不调用 `rewindFiles`（文件层跳过，因未启用检查点）
- **AND** 返回结果包含 `newSessionId` 与 `originalSessionId`

#### Scenario: revert 不存在的会话

- **WHEN** 调用 `client.session.revert('ses-nonexistent', 'msg-123')`
- **THEN** 抛出 SessionNotFoundError

### Requirement: Unrevert session

系统 SHALL 提供 `client.session.unrevert(sessionId)` 方法，撤销之前的 revert 操作，切回 revert 前的原会话。系统 MUST 维护 revert 产生的映射（`newSessionId → originalSessionId`）。unrevert 时 MUST 返回原会话 ID，使调用方可继续在原会话上操作。原会话在 revert 后保留存活，unrevert 无需重建。

#### Scenario: unrevert 回到原会话

- **WHEN** 此前调用了 `revert('ses-xxx', 'msg-123')` 得到 `newSessionId: 'ses-fork-1'`，现调用 `client.session.unrevert('ses-fork-1')`
- **THEN** 返回 `originalSessionId: 'ses-xxx'`
- **AND** 调用方可继续在 'ses-xxx' 上 prompt / events

#### Scenario: unrevert 未曾 revert 的会话

- **WHEN** 调用 `client.session.unrevert('ses-never-reverted')`，该会话无 revert 映射
- **THEN** 抛出错误（无 revert 记录）

### Requirement: Fork session

系统 SHALL 提供 `client.session.fork(sessionId, messageId?, options?)` 方法，从指定会话分叉出一个新会话。底层 MUST 调用 `forkSession(sessionId, { upToMessageId?: messageId, dir, title? })`。原会话历史与句柄 MUST 保持不变。返回值 MUST 包含新会话 ID。新会话 MUST 经 SessionManager 注册以纳入管理（事件流、prompt 等可操作）。messageId 省略时 MUST 全量复制原会话历史。

#### Scenario: fork 会话（指定分叉点）

- **WHEN** 调用 `client.session.fork('ses-xxx', 'msg-123')`
- **THEN** 底层调用 `forkSession('ses-xxx', { upToMessageId: 'msg-123', dir })`
- **AND** 返回结果包含 `newSessionId`（与原会话不同）
- **AND** 原会话 'ses-xxx' 的历史与 Query 句柄不受影响

#### Scenario: fork 会话（全量复制）

- **WHEN** 调用 `client.session.fork('ses-xxx')`（不传 messageId）
- **THEN** 底层调用 `forkSession('ses-xxx', { dir })`（不传 upToMessageId，全量复制）
- **AND** 返回结果包含 `newSessionId`

#### Scenario: fork 不存在的会话

- **WHEN** 调用 `client.session.fork('ses-nonexistent')`
- **THEN** 抛出 SessionNotFoundError

### Requirement: File checkpointing option

系统 SHALL 在 `client.session.create` 的 options 中支持 `enableFileCheckpointing?: boolean` 字段。提供且为 true 时，MUST 将 `enableFileCheckpointing: true` 透传给底层 query() options，并设置 `extraArgs: { 'replay-user-messages': null }` 以在响应流中获取 checkpoint UUID（user message 的 uuid）。该选项是 revert 文件层回滚的前提。

#### Scenario: 创建会话时启用文件检查点

- **WHEN** 调用 `client.session.create({ firstMessage: 'hello', enableFileCheckpointing: true })`
- **THEN** 底层 query() options 包含 `enableFileCheckpointing: true`
- **AND** 底层 query() options 的 extraArgs 包含 `'replay-user-messages': null`

#### Scenario: 创建会话时不启用文件检查点（默认）

- **WHEN** 调用 `client.session.create({ firstMessage: 'hello' })`（未传 enableFileCheckpointing）
- **THEN** 底层 query() options 不设置 enableFileCheckpointing（或为 false）
- **AND** 后续 revert 调用 rewindFiles 时文件层不可用
