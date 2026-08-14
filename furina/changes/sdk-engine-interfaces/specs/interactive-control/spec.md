## ADDED Requirements

### Requirement: Reject question

系统 SHALL 提供 `client.session.rejectQuestion(sessionId, input)` 方法，拒绝一个挂起的问题提问请求。input MUST 包含 `requestID` 字段（对应 question.asked 事件的 `properties.id`，`^que_` 前缀）。拒绝时 MUST 将挂起的 canUseTool Promise resolve 为 `{ behavior: 'deny', message: 'rejected by user' }`，终止该问题工具调用。拒绝后 MUST 产出 `question.rejected` 控制事件，其 properties 包含 `sessionID` 与 `requestID`。

#### Scenario: 拒绝挂起的问题

- **WHEN** 会话 'ses-xxx' 产出了 `question.asked` 事件（requestID 为 'que_123'），调用 `client.session.rejectQuestion('ses-xxx', { requestID: 'que_123' })`
- **THEN** 挂起的问题 Promise resolve 为 `{ behavior: 'deny', message: 'rejected by user' }`
- **AND** 产出 `question.rejected` 事件，properties 含 `sessionID: 'ses-xxx'` 与 `requestID: 'que_123'`

#### Scenario: 拒绝不存在的请求

- **WHEN** 调用 `client.session.rejectQuestion('ses-xxx', { requestID: 'que_nonexistent' })`，该 requestID 无挂起请求
- **THEN** 抛出 SessionNotFoundError 或等价错误

### Requirement: question.rejected event type

`GlobalEventType` 联合 MUST 包含 `question.rejected` 事件类型。该事件由 `rejectQuestion` 产出，properties 包含 `sessionID`（string）与 `requestID`（string，`^que_` 前缀）。该事件 MUST 经会话级控制事件通道与全局事件流可达。

#### Scenario: question.rejected 事件经事件流可达

- **WHEN** 调用 `rejectQuestion` 后，消费 `client.session.events('ses-xxx')` 或 `client.global.event({ directory })`
- **THEN** 事件流中可收到 `question.rejected` 事件，payload.type 为 `'question.rejected'`

### Requirement: List pending permissions

系统 SHALL 提供 `client.session.listPendingPermissions(sessionId)` 方法，返回指定会话当前所有挂起的权限申请请求快照。返回值 MUST 为数组，每个元素包含 `requestID`（`^per_` 前缀）与权限请求载荷（permission/patterns/metadata/tool 等）。返回值 MUST 为快照（不影响内部挂起状态）。

#### Scenario: 列出挂起的权限请求

- **WHEN** 会话 'ses-xxx' 有 2 个挂起的权限请求（requestID 分别 'per_1'、'per_2'），调用 `client.session.listPendingPermissions('ses-xxx')`
- **THEN** 返回长度为 2 的数组
- **AND** 每个元素包含 requestID 与权限请求载荷

#### Scenario: 无挂起权限请求时返回空数组

- **WHEN** 会话 'ses-xxx' 无挂起权限请求，调用 `client.session.listPendingPermissions('ses-xxx')`
- **THEN** 返回空数组

### Requirement: List pending questions

系统 SHALL 提供 `client.session.listPendingQuestions(sessionId)` 方法，返回指定会话当前所有挂起的问题提问请求快照。返回值 MUST 为数组，每个元素包含 `requestID`（`^que_` 前缀）与问题载荷（questions 数组）。返回值 MUST 为快照。

#### Scenario: 列出挂起的问题请求

- **WHEN** 会话 'ses-xxx' 有 1 个挂起的问题请求，调用 `client.session.listPendingQuestions('ses-xxx')`
- **THEN** 返回长度为 1 的数组
- **AND** 元素包含 requestID 与 questions 载荷

#### Scenario: 无挂起问题请求时返回空数组

- **WHEN** 会话 'ses-xxx' 无挂起问题请求，调用 `client.session.listPendingQuestions('ses-xxx')`
- **THEN** 返回空数组
