## ADDED Requirements

### Requirement: AbortSignal for event streams

`client.session.events(sessionId)` 与 `client.global.event(options)` SHALL 支持可选 `signal?: AbortSignal` 参数。提供 signal 时，当 signal 被 abort，事件流迭代 MUST 终止（async generator 正常 return），并清理订阅资源。abort 后消费者 `for await...of` 循环 MUST 正常退出而非抛错。

#### Scenario: abort 终止会话事件流

- **WHEN** 调用 `const ctrl = new AbortController(); const stream = client.session.events('ses-xxx', { signal: ctrl.signal })`，消费流过程中调用 `ctrl.abort()`
- **THEN** 事件流迭代终止，`for await...of` 循环正常退出
- **AND** 不抛出 abort 错误

#### Scenario: abort 终止全局事件流

- **WHEN** 调用 `const ctrl = new AbortController(); const stream = client.global.event({ directory: '/path', signal: ctrl.signal })`，消费过程中调用 `ctrl.abort()`
- **THEN** 全局事件流迭代终止，订阅资源被清理

#### Scenario: 未提供 signal 时行为不变

- **WHEN** 调用 `client.session.events('ses-xxx')`（不传 signal）
- **THEN** 事件流行为与现有一致（直到会话结束才终止）

### Requirement: Subtask part normalization

系统 SHALL 在 SDKMessage → GlobalEvent 归一化中处理子 Agent（subtask）内容块。当 assistant 消息的内容块为子 Agent 工具调用（如 Task/Agent 工具），或消息中含 subtask 类型内容块时，MUST 产出 `message.part.updated` 事件，且 part 携带子 Agent 会话标识（`subSessionId`）。子 Agent 会话标识从工具调用输出（tool_result）或底层子 Agent 事件中提取。不再静默跳过 subtask 内容块。

#### Scenario: 子 Agent 工具调用产出含 subSessionId 的 part

- **WHEN** query() 产出 assistant 消息，其 content 含子 Agent 工具调用块，且对应 tool_result 携带子会话信息
- **THEN** 产出 `message.part.updated` 事件
- **AND** part 的 state 或 metadata 包含 `subSessionId`（子 Agent 会话 ID）

#### Scenario: 无子会话信息时仍产出 part

- **WHEN** query() 产出 assistant 消息含工具调用块，但 tool_result 无可提取的子会话信息
- **THEN** 仍产出 `message.part.updated` 事件（不静默跳过）
- **AND** part 不含 subSessionId（或为 undefined）

## MODIFIED Requirements

### Requirement: Session events stream

系统 SHALL 提供 `client.session.events(sessionId, options?)` 方法，返回该会话的 `AsyncIterable<GlobalEvent>`。事件源为该会话后台 query() 产出的 SDKMessage 流，经归一化转换为 GlobalEvent 信封。消费者 MUST 能通过 `for await...of` 消费事件。options SHALL 支持可选 `signal?: AbortSignal` 参数，abort 时终止迭代（详见 AbortSignal for event streams 要求）。

#### Scenario: 消费会话事件流

- **WHEN** 调用 `const stream = client.session.events('ses-xxx')` 并 `for await (const ev of stream)`
- **THEN** 产出该会话的 GlobalEvent 事件序列
- **AND** 每个 ev 符合 `{ directory?, project?, workspace?, payload: { id, type, properties } }` 结构

#### Scenario: 会话结束后事件流终止

- **WHEN** 会话的 query() 完成（result 消息产出后）
- **THEN** 事件流在产出最终的 session.next.step.ended 事件后正常结束（AsyncIterable return）

#### Scenario: create 之后订阅仍收到 session.created

- **WHEN** 调用 `client.session.create()` 之后再调用 `client.session.events(sessionId)`
- **THEN** 事件流回放该会话自创建以来缓冲的全部事件，包括 `session.created`

### Requirement: Global event stream with directory filter

系统 SHALL 提供 `client.global.event(options?)` 方法，返回全局事件 `AsyncIterable<GlobalEvent>`。options 可包含 `directory` 字段与可选 `signal?: AbortSignal` 字段。当提供 directory 时，系统 MUST 只产出匹配该 directory（项目）的事件。当未提供 directory 时，MUST 使用客户端的 cwd 作为默认 directory 过滤。提供 signal 时，abort 终止迭代（详见 AbortSignal for event streams 要求）。

#### Scenario: 按 directory 订阅全局事件

- **WHEN** 调用 `client.global.event({ directory: '/path/to/project' })`
- **THEN** 只产出该 directory 对应项目的事件
- **AND** 每个 GlobalEvent 的 `directory` 字段等于 '/path/to/project'

#### Scenario: 默认使用 cwd 过滤

- **WHEN** 调用 `client.global.event()` 不传 directory
- **THEN** 使用客户端 cwd 作为过滤 directory
