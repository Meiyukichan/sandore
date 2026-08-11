## ADDED Requirements

### Requirement: Session events stream

系统 SHALL 提供 `client.session.events(sessionId)` 方法，返回该会话的 `AsyncIterable<GlobalEvent>`。事件源为该会话后台 query() 产出的 SDKMessage 流，经归一化转换为 GlobalEvent 信封。消费者 MUST 能通过 `for await...of` 消费事件。

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

系统 SHALL 提供 `client.global.event(options?)` 方法，返回全局事件 `AsyncIterable<GlobalEvent>`。options 可包含 `directory` 字段。当提供 directory 时，系统 MUST 只产出匹配该 directory（项目）的事件。当未提供 directory 时，MUST 使用客户端的 cwd 作为默认 directory 过滤。

#### Scenario: 按 directory 订阅全局事件

- **WHEN** 调用 `client.global.event({ directory: '/path/to/project' })`
- **THEN** 只产出该 directory 对应项目的事件
- **AND** 每个 GlobalEvent 的 `directory` 字段等于 '/path/to/project'

#### Scenario: 默认使用 cwd 过滤

- **WHEN** 调用 `client.global.event()` 不传 directory
- **THEN** 使用客户端 cwd 作为过滤 directory

### Requirement: SDKMessage to GlobalEvent normalization

系统 SHALL 将 Claude SDK 的 SDKMessage 流归一化为 GlobalEvent 信封。映射规则如下：

| SDKMessage | GlobalEvent payload.type |
|---|---|
| `system` (subtype=init) | `session.created` |
| `stream_event` (content_block_delta, text_delta) | `message.part.delta` |
| `stream_event` (content_block_delta, input_json_delta) | `message.part.delta` |
| `assistant` (完整消息) | `message.part.updated` |
| `result` (subtype=success) | `session.next.step.ended` |
| `result` (subtype=error) | `session.error` |
| `system` (session_state_changed, idle) | `session.idle` |

每个 GlobalEvent 的 `payload.id` MUST 符合 `^evt_` 前缀。无对应 opencode 事件类型的 SDKMessage SHALL 被静默跳过（不产出事件）。

#### Scenario: system/init 映射为 session.created

- **WHEN** query() 产出 `{ type:'system', subtype:'init', session_id:'ses-xxx', ... }`
- **THEN** 产出 GlobalEvent，payload.type 为 `session.created`
- **AND** payload.properties 包含 `sessionID: 'ses-xxx'` 和 `info`（Session 结构）

#### Scenario: text_delta 流式增量映射为 message.part.delta

- **WHEN** query() 产出 `{ type:'stream_event', event:{ type:'content_block_delta', delta:{ type:'text_delta', text:'hel' } } }`
- **THEN** 产出 GlobalEvent，payload.type 为 `message.part.delta`
- **AND** payload.properties 包含 `sessionID`、`messageID`、`partID`、`field: 'text'`、`delta: 'hel'`

#### Scenario: input_json_delta 工具入参增量映射为 message.part.delta

- **WHEN** query() 产出 stream_event 且 delta.type 为 `input_json_delta`
- **THEN** 产出 GlobalEvent，payload.type 为 `message.part.delta`
- **AND** payload.properties 的 `field` 为 `'tool_input'`

#### Scenario: assistant 完整消息映射为 message.part.updated

- **WHEN** query() 产出 `{ type:'assistant', message: BetaMessage, session_id, uuid }`
- **THEN** 对 `message.content` 的每个内容块产出 GlobalEvent，payload.type 为 `message.part.updated`
- **AND** payload.properties 包含 `sessionID` 和 `part`（Part 结构，文本块 TextPart 或工具调用块 ToolPart），与 `docs/sdk/openapi.json` 的 `EventMessagePartUpdated`（`{sessionID, part, time}`）一致

#### Scenario: result success 映射为 session.next.step.ended

- **WHEN** query() 产出 `{ type:'result', subtype:'success', session_id, total_cost_usd, usage }`
- **THEN** 产出 GlobalEvent，payload.type 为 `session.next.step.ended`
- **AND** payload.properties 包含 `sessionID`、`finish`、`cost`、`tokens`

#### Scenario: result error 映射为 session.error

- **WHEN** query() 产出 `{ type:'result', subtype:'error_max_turns', errors:[...] }`
- **THEN** 产出 GlobalEvent，payload.type 为 `session.error`
- **AND** payload.properties 包含 `sessionID` 和 `error`

#### Scenario: 无对应的事件类型被跳过

- **WHEN** query() 产出无 opencode 对应的 SDKMessage（如 hook_started、task_notification）
- **THEN** 不产出任何 GlobalEvent，该消息被静默跳过

### Requirement: GlobalEvent envelope structure

每个产出的 GlobalEvent MUST 符合以下信封结构：`{ directory?: string, project?: string, workspace?: string, payload: { id: string (^evt_), type: string, properties: Record<string, unknown> } }`。`payload.type` MUST 使用 opencode 定义的事件类型字符串。`directory` 字段 MUST 反映产出该事件的项目目录。

#### Scenario: GlobalEvent 包含正确的 directory

- **WHEN** 客户端 cwd 为 '/projects/myapp'，产出 session.created 事件
- **THEN** GlobalEvent.directory 等于 '/projects/myapp'

#### Scenario: event ID 符合前缀约束

- **WHEN** 产出任意 GlobalEvent
- **THEN** payload.id 以 `evt_` 开头
