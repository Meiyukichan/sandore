# 规范材料探索：模型查询、事件系统（SDKMessage→GlobalEvent 归一化）与客户端工厂装配（event-01）

> 探索类型：specification
> 探索日期：2026-08-12
> 项目路径：`D:\project-code\llm\sandore`
> 输出目录：`furina/changes/claude-sdk-adapter/explore-coding/event-01`

## 一、需求理解（Phase 2）

### What

实现 plan.json 中 `event-01`（对应 `specs/event-streaming`、`specs/model-providers` 与 `session-management` 的 Client factory），共三块：

1. **`src/events.ts`——SDKMessage → GlobalEvent 归一化 + GlobalEventManager**：
   - 将 Claude SDK `query()` 产出的原始 `SDKMessage` 流归一化为 `GlobalEvent` 信封（`{directory?, project?, workspace?, payload:{id, type, properties}}`）；
   - 映射：`system/init`→`session.created`（properties 含 `sessionID` + `info: Session`）；`stream_event` 的 `text_delta`→`message.part.delta`（`field:'text'`）；`stream_event` 的 `input_json_delta`→`message.part.delta`（`field:'tool_input'`）；`assistant`（完整 `BetaMessage`）→对每个内容块产出 `message.part.updated`（properties 为 `{sessionID, part, time}`，part 为 TextPart 或 ToolPart）；`result` success→`session.next.step.ended`（properties 含 `finish/cost/tokens`）；`result` error→`session.error`；`system/session_state_changed` idle→`session.idle`；
   - `payload.id` 以 `evt_` 前缀生成；无对应 GlobalEvent 类型的 SDKMessage 静默跳过；
   - `GlobalEventManager.sessionEvents(sessionId)`：读取会话后台原始 SDKMessage 通道（`SessionState.events`，回放型广播通道），归一化为 `AsyncIterable<GlobalEvent>`；晚订阅仍收到 `session.created`；会话 query() 结束后流正常终止（return）；
   - `GlobalEventManager.global.event({ directory })`：全局视图，只产出匹配 `directory` 的事件；省略 `directory` 时默认用客户端 cwd 过滤。

2. **`src/model.ts`——ModelManager.list()**：
   - 惰性初始化并缓存一个「控制 Query」（design.md D9：`query({ prompt: <永不产出的空 AsyncIterable>, options: { cwd } })`）；
   - 包装 `Query.supportedModels()`（或 `initializationResult().models`），`ModelInfo→ModelV2Info`：`value→id`、`displayName→name`、`providerID` 固定 `'anthropic'`、`status` 默认 `'active'`、`resolvedModel` 保留在 `variants`；
   - 返回 `{ location: LocationInfo, data: ModelV2Info[] }`；`location.directory` 默认客户端 cwd，可被 `options.location.directory` 覆盖；控制 Query 在 `client.close()` 时关闭。

3. **`src/client.ts`——createClaudeClient({ cwd }) 工厂**：
   - 返回含 `session`（create/messages/prompt/interrupt/wait/events）、`model`（list）、`global`（event）三个命名空间的客户端对象；
   - `cwd` 作为默认 directory（会话创建与事件过滤）；不启动任何 HTTP 服务器。

### Boundaries

- **源接口**：`@anthropic-ai/claude-agent-sdk` v0.3.227（`packages/sdk/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` + `docs/sdk/claude/*.md`）。
- **目标协议**：`docs/sdk/openapi.json`（OpenAPI 3.1.0 "opencode"）的 `GlobalEvent` / `EventSessionCreated` / `EventMessagePartUpdated` / `EventMessagePartDelta` / `EventSessionNextStepEnded` / `EventSessionError` / `EventSessionIdle` / `Session` / `TextPart` / `ToolPart` 等 schema。
- **适配层契约**：`furina/changes/claude-sdk-adapter/api.yaml`（`/client/model/list`、`/client/session/events`、`/client/global/event` 三个端点 + `definitions`）+ `specs/event-streaming/spec.md` + `specs/model-providers/spec.md` + `specs/session-management/spec.md#Client-factory` + `design.md#D3/D4/D6/D7/D9`。
- **已有产物（直接复用）**：`packages/sdk/claude/src/types.ts`（GlobalEvent/GlobalEventPayload/GlobalEventType/ModelV2Info/LocationInfo/ModelListResponse 等）、`src/session-state.ts`（SessionState.events 原始 SDKMessage 回放通道）、`src/session.ts`（SessionManager 的 create/messages/prompt/interrupt/wait/events/close）、`test/session.test.ts`（测试惯例与 FakeQuery）。
- **输出位置**：`packages/sdk/claude/src/events.ts`、`src/model.ts`、`src/client.ts`、`test/events.test.ts`、`test/model.test.ts`、`test/client.test.ts`（当前均不存在）。
- **范围排除**：不启动 HTTP 服务器；不适配 opencode 全部 88 种事件类型（仅「有对应」的 6 种）；不改写 `scripts/conversation.ts`。

### Goal

为 `event-01` 的实施提供字段级精确依据：SDKMessage 每类消息的判别字段与负载结构、GlobalEvent 各事件类型的 `properties` 精确 schema、回放型事件通道的语义、`ModelInfo→ModelV2Info` 映射与 D9 控制 Query 的形态、`createClaudeClient` 命名空间装配方式，以及 `api.yaml`/`spec`/`design` 与 SDK 实际类型之间的差异，避免实现与契约不一致。

---

## 二、工程现状

- `packages/sdk/claude/src/` 已有 `types.ts`（infra-01）、`session-state.ts`、`session.ts`（session-01）；`events.ts`、`model.ts`、`client.ts` 待创建。
- `packages/sdk/claude/test/` 已有 `types.test.ts`、`session.test.ts`；`events.test.ts`、`model.test.ts`、`client.test.ts` 待创建。
- `plan.json` 中 `event-01` 状态 `in_progress`，acceptance criteria 8 条（见第七节）。
- `furina config show exploration.specification` 返回空数组 `[]`，无预置规范材料配置；本次按 exploreContent 直接探索指定参考材料。

---

## 三、Claude SDK 消息结构（SDKMessage 联合）——归一化输入

来源：`packages/sdk/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（v0.3.226 实装，会话文档标注 0.3.227）+ `docs/sdk/claude/*.md`。

### 3.1 SDKMessage 联合

```ts
type SDKMessage =
  | SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage
  | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage
  | SDKStatusMessage | SDKAPIRetryMessage | SDKControlRequestProgressMessage
  | SDKModelRefusalFallbackMessage | SDKModelRefusalNoFallbackMessage
  | SDKLocalCommandOutputMessage | SDKHookStartedMessage | SDKHookProgressMessage
  | SDKHookResponseMessage | SDKPluginInstallMessage | SDKToolProgressMessage
  | SDKAuthStatusMessage | SDKTaskNotificationMessage | SDKTaskStartedMessage
  | SDKTaskUpdatedMessage | SDKTaskProgressMessage | SDKBackgroundTasksChangedMessage
  | SDKThinkingTokensMessage | SDKSessionStateChangedMessage | SDKWorkerShuttingDownMessage
  | SDKCommandsChangedMessage | SDKNotificationMessage | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage | SDKMemoryRecallMessage | SDKRateLimitEvent
  | SDKElicitationCompleteMessage | SDKPermissionDeniedMessage | SDKPromptSuggestionMessage
  | SDKMirrorErrorMessage | SDKInformationalMessage | SDKConversationResetMessage;
```

### 3.2 SDKSystemMessage（subtype=init / session_state_changed / 其它）

```ts
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;                 // ← 会话 ID（session.created 的 sessionID 来源）
  cwd: string;
  model: string;                      // ← init 时的模型（可作 session.created info 的一部分）
  claude_code_version: string;
  permissionMode: PermissionMode;
  apiKeySource: ApiKeySource;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string; version?: string }[];
  agents?: string[];
  betas?: string[];
  capabilities?: string[];            // 含 interrupt_receipt_v1 等
  fast_mode_state?: FastModeState;
};
```

**`SDKSessionStateChangedMessage`**（idle 判定依据）：
```ts
type SDKSessionStateChangedMessage = {
  type: 'system';
  subtype: 'session_state_changed';
  state: 'idle' | 'running' | 'requires_action';
  uuid: UUID;
  session_id: string;
};
```
归一化仅对 `state === 'idle'` 产出 `session.idle`；`running`/`requires_action` 无对应 GlobalEvent（静默跳过）。

### 3.3 SDKPartialAssistantMessage（stream_event，需 includePartialMessages）

```ts
type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: BetaRawMessageStreamEvent;   // 来自 @anthropic-ai/sdk 的原始 Claude API 流事件
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
  ttft_ms?: number;
};
```

`event` 为 `BetaRawMessageStreamEvent` 判别联合，其 `type` 依次为 `message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop`。归一化只消费 `content_block_delta` 中的两类增量：

| event.type | event.delta.type | 关键字段 | 映射 |
|---|---|---|---|
| `content_block_delta` | `text_delta` | `delta.text` | `message.part.delta`，`field:'text'` |
| `content_block_delta` | `input_json_delta` | `delta.partial_json` | `message.part.delta`，`field:'tool_input'` |

（`message_start` 含 `ttft_ms`；`content_block_start` 的 `content_block.type` 为 `text/tool_use/thinking`；`content_block_stop` 无增量。这三种无直接 GlobalEvent 对应，需静默跳过。）

### 3.4 SDKAssistantMessage（完整消息 → message.part.updated）

```ts
type SDKAssistantMessage = {
  type: 'assistant';
  message: BetaMessage;               // 来自 Anthropic SDK
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
  request_id?: string;
  error?: SDKAssistantMessageError;
  aborted?: true;
  subagent_type?: string;
  timestamp?: string;                 // ISO 时间戳（content block 完成时刻，可作 part.updated 的 time 来源之一）
  supersedes?: UUID[];
};
```

`BetaMessage` 含 `id`、`content`（内容块数组）、`model`、`stop_reason`、`usage`。内容块类型（assistant 侧）：
- **text 块**：`{ type: 'text', text: string, ... }` → TextPart；
- **tool_use 块**：`{ type: 'tool_use', id: string, name: string, input: Record<string, unknown> }` → ToolPart；
- **thinking 块**：`{ type: 'thinking', thinking: string, ... }`（spec 只要求 TextPart 或 ToolPart，thinking 块无对应 GlobalEvent 类型，需静默跳过或由实现决策）。

归一化规则：对 `message.content` 的**每个** `text` / `tool_use` 内容块各产出**一条** `message.part.updated` 事件，properties 为 `{ sessionID, part, time }`（与 `EventMessagePartUpdated` 一致，见 4.3）。`messageID` 用 `message.id`（加 `msg_` 前缀，D7）；`part.id` 用块 id（加 `prt_` 前缀，D7）；`time` 为 date-time 字符串（types.ts 口径）。

### 3.5 SDKResultMessage（success / error）

```ts
type SDKResultMessage = SDKResultSuccess | SDKResultError;

type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  uuid: UUID;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  api_error_status?: number | null;
  num_turns: number;
  result: string;
  stop_reason: string | null;         // ← finish 来源（如 'end_turn'）
  total_cost_usd: number;             // ← cost 来源
  usage: NonNullableUsage;            // ← tokens 来源（input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens）
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  terminal_reason?: TerminalReason;
  ttft_ms?: number;
  uuid: UUID;
};

type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  uuid: UUID;
  session_id: string;
  duration_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  errors: string[];                   // ← error 内容来源（如 'error_max_turns' 的 errors 数组）
  terminal_reason?: TerminalReason;
};
```

- success → `session.next.step.ended`，properties `{ sessionID, finish, cost, tokens }`：`finish` 取 `stop_reason`；`cost` 取 `total_cost_usd`（api.yaml 中 SessionMessage.cost 为 number）；`tokens` 由 `usage` 映射（input/output/reasoning/cache）。
- error（subtype 非 `'success'`，即 `is_error` 分支）→ `session.error`，properties `{ sessionID, error }`（error 可为 errors 数组或错误对象，opencode 侧为 SessionError 联合）。

### 3.6 SDKUserMessage / 其它系统消息

- `SDKUserMessage`：`{ type:'user', message: MessageParam, parent_tool_use_id, isSynthetic?, shouldQuery?, ... }` —— 由 prompt() 注入输入队列，**不会作为 query 输出**出现；若出现无对应 GlobalEvent，静默跳过。
- 其余系统子类型（`status`、`task_*`、`hook_*`、`plugin_install`、`permission_denied`、`compact_boundary`、`background_tasks_changed`、`commands_changed`、`rate_limit_event`、`prompt_suggestion`、`informational` 等）均无 opencode 对应 GlobalEvent，**静默跳过**（spec「无对应的事件类型被跳过」场景明确以 hook_started、task_notification 为例）。

---

## 四、GlobalEvent 目标 schema（docs/sdk/openapi.json）——归一化输出

### 4.1 GlobalEvent 信封

```json
{
  "GlobalEvent": {
    "type": "object",
    "properties": {
      "directory": { "type": "string" },
      "project": { "type": "string" },
      "workspace": { "type": "string" },
      "payload": { "anyOf": [ ...124 个变体... ] }
    }
  }
}
```
每个 payload 变体均为 `{ id(^evt_), type, properties }`，三字段必填、`additionalProperties: false`。`types.ts` 已定义 `GlobalEvent = { directory?, project?, workspace?, payload: GlobalEventPayload }`，`GlobalEventPayload = { id: EventID(^evt_), type: GlobalEventType, properties: Record<string, unknown> }`。

### 4.2 EventSessionCreated（session.created）

```json
{
  "id": { "pattern": "^evt_" },
  "type": { "enum": ["session.created"] },
  "properties": {
    "sessionID": { "pattern": "^ses" },
    "info": { "$ref": "#/components/schemas/Session" }
  },
  "required": ["sessionID", "info"]
}
```

**Session** schema（v1 会话对象，字段供 info 构造）：
- `id(^ses)`、`slug`、`projectID`、`workspaceID?(^wrk)`、`directory`、`path`、`parentID?(^ses)`、`summary{additions,deletions,files,diffs}`、`cost`（裸 number）、`tokens{input,output,reasoning,cache{read,write}}`（四字段必填）、`share{url}`、`title`、`agent`、`model{id,providerID,variant?}`、`version`、`metadata`、`time{created,updated,compacting?,archived?}`（created/updated 必填，epoch 毫秒）、`permission`、`revert`。
- 注：适配层 `types.ts` 的 `SessionV2Info`（api.yaml 口径）`id` 不做 `^ses` 前缀转换（D7 保留 Claude 原始 session_id），`time` 为 date-time 字符串；`session.created` 的 `info` 用 `Session` 结构，实现时需从 init 消息数据（session_id/cwd/model）+ SessionV2Info 组装。

### 4.3 EventMessagePartUpdated（message.part.updated）

```json
{
  "type": { "enum": ["message.part.updated"] },
  "properties": {
    "sessionID": { "pattern": "^ses" },
    "part": { "$ref": "#/components/schemas/Part" },
    "time": { "type": "number" }
  },
  "required": ["sessionID", "part", "time"]
}
```
`Part` 为 anyOf 联合：`TextPart | SubtaskPart | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | ...`。本适配层只产 `TextPart` 或 `ToolPart`。

**TextPart**（`type:'text'`）：
- required：`id(^prt)`、`sessionID(^ses)`、`messageID(^msg)`、`type`、`text`；
- 可选：`synthetic`、`ignored`、`time{start,end}`、`metadata`。

**ToolPart**（`type:'tool'`）：
- required：`id(^prt)`、`sessionID(^ses)`、`messageID(^msg)`、`type`、`callID`、`tool`、`state`；
- 可选：`metadata`。
- `state` 为 ToolState 联合（status 枚举：`pending`/`running`/`completed`/`error`，各状态含 `input` 等字段）。
- 映射：`tool_use` 块 → `id: prt_<块id>`、`callID: <tool_use.id>`、`tool: <name>`、`state`（默认 `completed`，types.ts `ToolState` 即 'pending'|'running'|'completed'|'error'）。

> 差异标注：openapi.json 的 `EventMessagePartUpdated.properties.time` 为 `number`（epoch），而 types.ts 的 `SessionV2Info.time`/`MessageTime` 为 date-time 字符串（api.yaml 口径）。design.md D4 明确 message.part.updated 的 properties 采用 `{sessionID, part, time}` 与 openapi 一致——实现时 time 取值口径需按 api.yaml（date-time 字符串）或 openapi（number）决策，spec 未强制。

### 4.4 EventMessagePartDelta（message.part.delta）

```json
{
  "type": { "enum": ["message.part.delta"] },
  "properties": {
    "sessionID": { "pattern": "^ses" },
    "messageID": { "pattern": "^msg" },
    "partID": { "pattern": "^prt" },
    "field": { "type": "string" },
    "delta": { "type": "string" }
  },
  "required": ["sessionID", "messageID", "partID", "field", "delta"]
}
```
- `text_delta` → `field:'text'`、`delta: event.delta.text`；
- `input_json_delta` → `field:'tool_input'`、`delta: event.delta.partial_json`。
- `messageID`/`partID` 需要从流上下文推导（`stream_event` 本身只有 `uuid`/`session_id`，`content_block_start` 的 `index`/`content_block.id` 与 `message_start` 的 `message.id` 是来源）——spec 场景示例只断言 `sessionID/messageID/partID/field/delta` 存在，未给推导算法，实现时需决策（D7：msg_/prt_ 前缀生成）。

### 4.5 EventSessionNextStepEnded（session.next.step.ended）

```json
{
  "type": { "enum": ["session.next.step.ended"] },
  "properties": {
    "timestamp": { "type": "number" },
    "sessionID": { "pattern": "^ses" },
    "assistantMessageID": { "pattern": "^msg_" },
    "finish": { "type": "string" },
    "cost": { "type": "number" },
    "tokens": {
      "type": "object",
      "properties": { "input": number, "output": number, "reasoning": number, "cache": { "read": number, "write": number } }
    },
    "snapshot": { "type": "string" },
    "files": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["timestamp", "sessionID", "assistantMessageID", "finish", "cost", "tokens"]
}
```
- spec 场景只要求 properties 含 `sessionID`、`finish`、`cost`、`tokens`；`assistantMessageID`/`timestamp` 为 openapi required 字段，实现时需补齐（assistantMessageID 可空/缺省，因 result 消息无 assistant message id）。

### 4.6 EventSessionError（session.error）

```json
{
  "type": { "enum": ["session.error"] },
  "properties": {
    "sessionID": { "pattern": "^ses" },
    "error": { "anyOf": [ ProviderAuthError, UnknownError, MessageOutputLengthError, MessageAbortedError, StructuredOutputError, ContextOverflowError, ContentFilterError, APIError ] }
  }
}
```
spec 场景要求 `properties` 含 `sessionID` 和 `error`；`error` 为错误联合，实现时可由 `result.errors: string[]` / `subtype` / `is_error` 组装。

### 4.7 EventSessionIdle（session.idle）

```json
{
  "type": { "enum": ["session.idle"] },
  "properties": {
    "sessionID": { "pattern": "^ses" }
  },
  "required": ["sessionID"]
}
```
properties 仅 `sessionID`。design.md D4 映射表曾提及 `session.idle / session.status`，但 event-streaming/spec.md 与 openapi 只定义 `session.idle`（`{sessionID}`）；`types.ts` 的 `GlobalEventType` 亦只含 `session.idle`（无 session.status）。**以 spec + openapi 为准：只产 `session.idle`。**

---

## 五、GlobalEventManager 与回放语义（src/events.ts）

### 5.1 事件源：SessionState.events（session-01 产物）

`SessionState`（src/session-state.ts）维护 `ReplayChannel<SDKMessage>`：
- `write(message)` 缓冲全部原始 SDKMessage 并通知订阅者；
- `subscribe()` 返回 `AsyncGenerator<SDKMessage>`，每个订阅者独立游标，晚订阅者从缓冲回放（`index < buffer.length` 时 yield），close 后 `ended=true` 流正常 return；
- `close()`/`handlePumpEnd()` 触发 `channel.close()`。

`SessionManager.events(sessionId)` 返回 `state.events`（`AsyncIterable<SDKMessage>`），对不存在的会话抛 `SessionNotFoundError`。`GlobalEventManager.sessionEvents(sessionId)` 正是读取此原始通道并逐条归一化。

### 5.2 回放型广播语义（spec 场景）

- **「create 之后订阅仍收到 session.created」**：`session.create()` 先后台启动 query 并捕获 init，消费者再调 `session.events(id)`——`ReplayChannel` 已缓冲 init 消息，晚订阅回放时仍产出 `session.created`；
- **「会话结束后事件流终止」**：query() 完成（result 消息产出、pump 结束、channel.close()）后，`AsyncIterable<GlobalEvent>` 在产出最终事件后正常 return。

### 5.3 global.event({ directory })（design.md D6）

- 全局视图按 directory 过滤：只产出 `GlobalEvent.directory === 过滤 directory` 的事件；
- 省略 `directory` 时默认用客户端 cwd（design.md Open Questions 已定：默认用 cwd；spec「默认使用 cwd 过滤」场景）；
- 每个产出的 GlobalEvent 的 `directory` 字段等于过滤 directory（spec「按 directory 订阅全局事件」场景）；
- 与 `sessionEvents` 共享同一套 SDKMessage → GlobalEvent 归一化逻辑（design.md D4）。

### 5.4 归一化器形态（facts）

- 判别顺序：按 `message.type` 分流（`system`/`stream_event`/`assistant`/`result`），`system` 再按 `subtype` 分（`init`→created、`session_state_changed`+idle→idle）；
- 每条产出的 GlobalEvent：`payload.id = 'evt_' + <uuid>`（D7；types.ts `EventID = \`evt_${string}\``，可复用 `crypto.randomUUID()`）；
- `directory` 取自该会话创建时的 cwd（`SessionState.directory` / `SessionManager.create` 的 location.directory）；`project`/`workspace` 可省略（types.ts 可选）。

---

## 六、ModelManager.list() 与 ModelInfo（src/model.ts）

### 6.1 ModelInfo（SDK 类型）

```ts
type ModelInfo = {
  value: string;                 // ← ModelV2Info.id
  resolvedModel?: string;        // 规范 wire id（如 'sonnet' → 'claude-sonnet-5'）→ 保留于 variants
  displayName: string;           // ← ModelV2Info.name
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};
```

### 6.2 获取方式（design.md D9）

- `Query.supportedModels(): Promise<ModelInfo[]>` 与 `Query.initializationResult(): Promise<SDKControlInitializeResponse>`（其 `models: ModelInfo[]`）都是 **Query 实例方法**（SDK 无模块级模型列举函数）；
- `model.list()` 可能在创建任何会话前被调用（如先渲染模型选择器），因此需要独立的 Query 来源——**控制 Query**：`query({ prompt: <永不产出的空 AsyncIterable>, options: { cwd } })`；
- 该控制 Query 不 yield 任何用户消息、不产生对话轮次；惰性初始化（首次 `list()` 调用时创建）并缓存（后续 `list()` 复用）；在 `client.close()` 时关闭；
- 若客户端已有活跃会话，实现也可复用其 Query（design.md 注明细节由计划阶段确定）。

### 6.3 ModelInfo → ModelV2Info 映射（spec model-providers）

| ModelInfo | ModelV2Info |
|---|---|
| `value` | `id` |
| `displayName` | `name` |
| —（固定） | `providerID: 'anthropic'` |
| —（默认） | `status: 'active'` |
| `resolvedModel` | 保留于 `variants`（`Array<Record<string, unknown>>`，供消费者使用） |

`ModelV2Info`（types.ts）required：`id`、`providerID`、`name`、`status`；可选：`family`、`api`、`capabilities`、`variants`、`time`、`cost`、`enabled`、`limit`。api.yaml 仅要求四项必填。

### 6.4 返回结构

`{ location: LocationInfo, data: ModelV2Info[] }`：
- `LocationInfo`（types.ts）required `directory` + `project{id, directory}`；`project.id` 可由 cwd 编码生成（复用 session.ts 的 `encodeProjectID` 逻辑）；
- `location.directory` 默认客户端 cwd；`list({ location: { directory } })` 时返回指定值（spec「按位置获取模型」场景）；
- 无会话时惰性初始化控制 Query 获取模型（spec「无会话时获取模型」场景 + D9）。

---

## 七、createClaudeClient 工厂装配（src/client.ts）

### 7.1 命名空间（design.md D3）

`client.session.*`（create/messages/prompt/interrupt/wait/events）、`client.model.list()`、`client.global.event()`——不使用 `v2` 前缀。

### 7.2 组装（facts）

- `createClaudeClient({ cwd })` 返回客户端对象；`cwd` 作为默认 directory（session.create 的默认 location、global.event 的默认过滤 directory、model.list 的默认 location.directory）；
- `session` 命名空间委托 `SessionManager`（`cwd`、默认 `query`、默认 `getSessionMessages`）；
- `model` 命名空间委托 `ModelManager`（`cwd` + D9 控制 Query）；
- `global.event` 委托 `GlobalEventManager`；
- 不启动任何 HTTP 服务器（design.md D1 Non-Goal）；`client.close()` 时关闭全部会话（`SessionManager.closeAll`）与控制 Query（`ModelManager` 关闭）。

### 7.3 Client factory spec（session-management/spec.md）

- `createClaudeClient(options)` 的 options MUST 含 `cwd`（工作目录）；
- 客户端对象 MUST 暴露 `session`、`model`、`global` 三个命名空间；
- 客户端不 SHALL 启动任何 HTTP 服务器；
- 该 cwd 作为客户端的默认 directory，用于会话创建与事件过滤。

---

## 八、types.ts 已有类型（infra-01 产物，event-01 直接复用）

- **事件**：`GlobalEvent`（`{directory?, project?, workspace?, payload}`）、`GlobalEventPayload`（`{id: EventID, type: GlobalEventType, properties}`）、`GlobalEventType`（`'session.created' | 'message.part.delta' | 'message.part.updated' | 'session.next.step.ended' | 'session.error' | 'session.idle'`）、`EventID = \`evt_${string}\``。
- **模型**：`ModelV2Info`（`id/providerID/name/status` 必填）、`LocationInfo`（`directory/project{id,directory}` 必填）、`ModelListResponse`（`{location, data}`）。
- **会话**：`SessionV2Info`、`SessionMessagesResponse`、`SessionInputAdmitted`、`PromptInput`、`SessionMessage`、`SessionMessageAssistantContent`（Text/Reasoning/Tool 联合）。
- **错误**：`SessionNotFoundError`、`TimeoutError`、`InvalidRequestError`、`ClaudeSDKError`。
- 注：types.ts 未定义 `TextPart`/`ToolPart`/`Session` 的独立类型；`message.part.updated` 的 `part` 为 `Record<string, unknown>`（GlobalEventPayload.properties 泛型），实现时可按 openapi 的 TextPart/ToolPart 形状构造。

---

## 九、plan.json event-01 acceptance criteria（实现验收口径）

1. `client.model.list()` 返回 `{ location, data }`，data 为 ModelV2Info[]（每项含 id/providerID/name/status）；location.directory 等于客户端 cwd；指定 location.directory 时返回其值；无会话时惰性初始化控制 Query（D9）获取模型。
2. ModelInfo→ModelV2Info 映射正确：value→id、displayName→name、providerID='anthropic'、status='active'；含 resolvedModel 时保留在 variants。
3. `client.session.events(sessionId)` 返回 `AsyncIterable<GlobalEvent>`，可 for await...of 消费；create() 之后订阅仍收到 session.created（事件回放）；会话 query() 完成后事件流在产出最终事件后正常结束（return）。
4. `client.global.event({ directory })` 只产出匹配该 directory 的事件且 GlobalEvent.directory 等于该值；省略 directory 时默认使用客户端 cwd 过滤。
5. 归一化映射正确：init→session.created、text_delta→message.part.delta(field:'text')、input_json_delta→message.part.delta(field:'tool_input')、assistant 每个内容块→message.part.updated(properties 含 part: TextPart|ToolPart)、result success→session.next.step.ended(finish/cost/tokens)、result error→session.error、idle→session.idle；无对应类型的 SDKMessage 被静默跳过。
6. 每个 GlobalEvent 符合 `{ directory?, project?, workspace?, payload: { id, type, properties } }`，payload.id 以 evt_ 开头，payload.type 为 opencode 事件类型字符串。
7. `createClaudeClient({ cwd })` 返回含 session/model/global 三个命名空间的客户端对象，且不启动 HTTP 服务器。
8. `test/events.test.ts`、`test/model.test.ts`、`test/client.test.ts` 覆盖上述场景且全部通过。

---

## 十、关键差异与实现注意事项

1. **事件类型覆盖范围**：只适配 6 种有对应的 GlobalEvent（session.created / message.part.delta / message.part.updated / session.next.step.ended / session.error / session.idle）；`session.status`、`session.next.*` 其余变体、hook/task/permission 等一律静默跳过（design.md Non-Goals + spec「无对应的事件类型被跳过」）。
2. **message.part.delta 的 messageID/partID 来源**：`stream_event` 本身只有 `uuid`/`session_id`；`message_start.message.id` 与 `content_block_start.content_block.id`（或 `index`）是推导来源；D7 要求 msg_/prt_ 前缀生成。spec 场景只断言字段存在，未给算法——实现需决策（如维护每会话的「当前 messageID / 当前 partID / 当前 block index」状态机）。
3. **message.part.updated 的 time 口径**：openapi 为 number（epoch），api.yaml/types.ts 为 date-time 字符串；design.md D4 引用 openapi 的 `{sessionID, part, time}` 结构但未定 time 类型，实现时需按 api.yaml 口径（date-time）决策。
4. **session.created 的 info 构造**：`Session` 结构字段多且含 `^ses`/`^wrk` 前缀约束；适配层 SessionV2Info.id 保留 Claude 原始 session_id（D7 不做 `^ses` 转换），info 组装时需注意字段可选性与前缀约束的偏差是**有意为之**。
5. **D9 控制 Query 的 prompt**：必须传「永不产出的空 AsyncIterable」（`async function*(){ /* never yields */ }` 形态），否则 query 会立即结束或产生对话轮次；控制 Query 在 `client.close()` 关闭。
6. **回放通道已是 session-01 产物**：`SessionState.events` 的 `ReplayChannel` 已实现「缓冲 + 晚订阅回放 + close 终止」；`GlobalEventManager` 只需逐条归一化，无需重复实现通道。
7. **providerID/status 硬编码**：ModelV2Info.providerID 固定 `'anthropic'`、status 默认 `'active'`、enabled 默认 `true`（api.yaml default），均无需从 ModelInfo 推导。
8. **错误对象**：`session.error` 的 `error` 字段在 openapi 为错误联合（ProviderAuthError/APIError 等），Claude 侧只有 `errors: string[]`/`subtype`/`is_error`——实现时需做结构映射（如取 `errors.join('; ')` 或构造 `{ type, message }` 形状），spec 未强制具体形状。
9. **测试惯例**：沿用 `test/session.test.ts` 的 FakeQuery + 依赖注入模式（`queryFn`/`getSessionMessagesFn` 注入），`events.ts`/`model.ts`/`client.ts` 应暴露可注入的 Query 工厂，避免真实启动 CLI 子进程。
