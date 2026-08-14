## ADDED Requirements

### Requirement: Structured prompt parts

系统 SHALL 在 `client.session.prompt` 的 `input.prompt` 中支持可选 `parts?: Array<{ type: 'text'; text: string }>` 字段。提供 parts 时，MUST 将其构造为 Claude SDK 的 `SDKUserMessage`，其 `message.content` 为内容块数组（`[{ type: 'text', text }, ...]`），而非单字符串。未提供 parts 时（仅 `text` 字段），MUST 保持现有行为（content 为字符串）。parts 与 text 互斥使用；若同时提供，parts 优先。

#### Scenario: 发送结构化 parts 消息

- **WHEN** 调用 `client.session.prompt('ses-xxx', { prompt: { parts: [{ type: 'text', text: '## 任务' }, { type: 'text', text: '执行重构' }] } })`
- **THEN** 向该 session 的输入队列 push 一条 `SDKUserMessage`，其 `message.content` 为 `[{ type:'text', text:'## 任务' }, { type:'text', text:'执行重构' }]`
- **AND** 返回 SessionInputAdmitted 对象，包含 `sessionID`、`prompt`、`delivery`、`timeCreated`、`id`

#### Scenario: parts 缺省时回退单文本

- **WHEN** 调用 `client.session.prompt('ses-xxx', { prompt: { text: 'hello' } })`（未提供 parts）
- **THEN** 向输入队列 push 一条 `SDKUserMessage`，其 `message.content` 为字符串 `'hello'`（保持现有行为）

#### Scenario: parts 与 text 同时提供时 parts 优先

- **WHEN** 调用 `client.session.prompt('ses-xxx', { prompt: { text: 'ignored', parts: [{ type: 'text', text: 'used' }] } })`
- **THEN** 向输入队列 push 的 `SDKUserMessage` 的 `message.content` 为 `[{ type:'text', text:'used' }]`（parts 优先，text 被忽略）

### Requirement: PromptInput parts type extension

`PromptInput` 类型 MUST 扩展为支持 `parts` 字段：`{ text?: string; files?: ...; agents?: ...; parts?: Array<{ type: 'text'; text: string }> }`。每个 part 的 `type` 当前限定为 `'text'`；`text` 为非空字符串。parts 数组的每个元素 MUST 顺序对应构造的 content block 数组元素。

#### Scenario: PromptInput 类型接受 parts

- **WHEN** 以 `{ prompt: { parts: [{ type: 'text', text: 'a' }] } }` 作为 prompt 入参
- **THEN** TypeScript 类型校验通过（PromptInput 含可选 parts 字段）

#### Scenario: 空 parts 数组

- **WHEN** 调用 `client.session.prompt('ses-xxx', { prompt: { parts: [] } })`（空数组）
- **THEN** 向输入队列 push 的 `SDKUserMessage` 的 `message.content` 为空数组 `[]`
