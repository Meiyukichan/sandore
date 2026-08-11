## Exploration Result

### Phase 3: furina-codebase 探索结果

`furina config show project.sourcecode codebases` 返回：
- `project.sourcecode=src/`
- `codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`

`docs/codebase` 目录为**空目录**（无任何文件），无法从中获取项目自有代码库信息。`.claude/furina.json` 中 `project.codebase.enable=false`、`path=docs/codebase`、`project.sourcecode=src/`（根目录 `src/` 不存在）。`packages/sdk/claude/src/` 目前仅有 `infra-01` 产物 `types.ts` 与 `session-01` 产物 `session-state.ts`/`session.ts`（`events.ts`/`model.ts`/`client.ts` 均为 event-01 待创建）。全部探索信息来自 Phase 4 补充探索。

## Supplementary Exploration Result

### 1. 任务边界与前置状态（event-01，plan.json）

- `event-01`（category=event，function=model-and-events-and-client）**status=in_progress**，files 为 `src/events.ts`、`src/model.ts`、`src/client.ts`、`test/events.test.ts`、`test/model.test.ts`、`test/client.test.ts`（均**尚未创建**）。
- 依赖 `infra-01`（types.ts）与 `session-01`（session-state.ts/session.ts），两者 status=done。
- 验收标准（acceptance_criteria）覆盖：`model.list()` 返回 `{location, data}` 且惰性初始化控制 Query；ModelInfo→ModelV2Info 映射（value→id、displayName→name、providerID='anthropic'、status='active'、resolvedModel 保留 variants）；`session.events` 回放（create 后订阅仍收 session.created）与会话结束后流正常终止；`global.event({directory})` 按 directory 过滤且省略时默认用 cwd；六条归一化映射；GlobalEvent 信封 `{directory?, project?, workspace?, payload:{id, type, properties}}`（payload.id 以 `evt_` 开头）；`createClaudeClient({cwd})` 三命名空间且不启动 HTTP。
- spec_refs：`session-management/spec.md#Client-factory`、`model-providers/spec.md#List-models`、`model-providers/spec.md#ModelInfo-to-ModelV2Info-mapping`、`event-streaming/spec.md`（Session-events-stream / Global-event-stream-with-directory-filter / SDKMessage-to-GlobalEvent-normalization / GlobalEvent-envelope-structure）、`design.md#D4`、`design.md#D6`、`api.yaml#/client/model/list`。
- 类型层已提供 `GlobalEvent`/`GlobalEventPayload`/`GlobalEventType`/`ModelV2Info`/`LocationInfo`/`ModelListResponse`/`EventID`/`ModelRef`/`LocationRef`/`ClaudeSDKError` 等全部所需协议类型（见 §6）。

### 2. Claude SDK 消息结构与 GlobalEvent 映射所需字段（sdk.d.ts v0.3.226）

`@anthropic-ai/claude-agent-sdk` 实际安装版本 **0.3.226**（`node_modules/.pnpm/@anthropic-ai+claude-agent-_3d6e.../sdk.d.ts`，7453 行）；`packages/sdk/claude/package.json` 声明 peerDependency `>=0.3.0`。`SDKMessage` 联合（行 4184）约 50 种子类型，event-01 只映射下表子集：

| SDKMessage | 关键字段 | GlobalEvent payload.type | properties 要点 |
|---|---|---|---|
| `SDKSystemMessage`（subtype='init'） | `session_id`、`cwd`、`model`、`capabilities?`（行 4601） | `session.created` | `{sessionID, info: Session}` |
| `SDKPartialAssistantMessage`（type='stream_event'） | `event: BetaRawMessageStreamEvent`、`session_id`、`uuid`（行 4321） | `message.part.delta` | `{sessionID, messageID, partID, field, delta}` |
| `SDKAssistantMessage`（type='assistant'） | `message: BetaMessage`、`session_id`、`uuid`、`error?`、`timestamp?`（行 3019） | `message.part.updated` | `{sessionID, part: TextPart\|ToolPart, time}` |
| `SDKResultSuccess`（subtype='success'） | `total_cost_usd`、`usage`、`modelUsage`、`stop_reason`、`result`（行 4472） | `session.next.step.ended` | `{sessionID, finish, cost, tokens}` |
| `SDKResultError`（subtype='error_during_execution'\|'error_max_turns'\|'error_max_budget_usd'\|'error_max_structured_output_retries'） | `is_error:true`、`errors: string[]`、`subtype`（行 4440） | `session.error` | `{sessionID, error}` |
| `SDKSessionStateChangedMessage`（state='idle'） | `state:'idle'\|'running'\|'requires_action'`、`session_id`（行 4562） | `session.idle` | `{sessionID}` |

**`SDKPartialAssistantMessage.event`（`BetaRawMessageStreamEvent`，@anthropic-ai/sdk resources/beta/messages/messages.d.ts 行 1837）** = 六种 `message_start | message_delta | message_stop | content_block_start | content_block_delta | content_block_stop` 联合：
- `message_start`（行 1830）：`{type:'message_start', message: BetaMessage}`——**携带消息级 ID**（`BetaMessage.id`，如 `msg_01X...`），可映射为 `messageID`。
- `content_block_start`（行 1777）：`{type:'content_block_start', index, content_block: BetaTextBlock\|BetaThinkingBlock\|BetaToolUseBlock\|...}`——`index` 为块序号，可映射为 `partID` 来源；`content_block` 含 `id`（tool_use 块）、`type`。
- `content_block_delta`（行 1772）：`{type:'content_block_delta', index, delta: BetaRawContentBlockDelta}`；`BetaRawContentBlockDelta`（行 1771）= `BetaTextDelta | BetaInputJSONDelta | BetaThinkingDelta | ...`：
  - `BetaTextDelta`（行 2139）：`{type:'text_delta', text}` → `field:'text'`、`delta=text`。
  - `BetaInputJSONDelta`（行 1266）：`{type:'input_json_delta', partial_json}` → `field:'tool_input'`、`delta=partial_json`。
- `content_block_stop`（行 1785）：`{type:'content_block_stop', index}`——**本事件无对应 GlobalEvent，应静默跳过**（spec 未列入映射表）。

**`SDKAssistantMessage.message`（`BetaMessage`，messages.d.ts 行 1487）**：`content: Array<BetaContentBlock>`（行 1533）、`id`、`model`、`stop_reason` 等。`BetaContentBlock`（行 902）联合中 event-01 需要的是：
- `BetaTextBlock`（行 2116）：`{type:'text', text, citations}` → **TextPart**。
- `BetaToolUseBlock`（行 2862）：`{type:'tool_use', id, input, name}` → **ToolPart**（`callID=block.id`、`tool=block.name`、`state`）。
- `BetaThinkingBlock`（行 2207）：`{type:'thinking', thinking, signature}`——assistant 消息归一化时**不映射**（spec 场景只要求 text/tool_use 两种内容块产出 message.part.updated）。

**`SDKResultSuccess.usage`（`NonNullableUsage`，sdk.d.ts 行 1284）** = `{[K in keyof BetaUsage]: NonNullable<BetaUsage[K]>}`；`BetaUsage`（messages.d.ts 行 2902）含 `input_tokens`、`output_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens` 等。result success 归一化 `tokens` 需从 `usage` 提取（映射为 opencode TokenUsage：`input/output/reasoning/cache`），`cost` 从 `total_cost_usd`（number）映射，`finish` 可取自 `stop_reason`。

### 3. docs/sdk/openapi.json 目标事件结构与 Part/Session 结构

`docs/sdk/openapi.json`（OpenAPI 3.1.0，title=opencode，约 1.2MB）中 event-01 相关的 schema 行号与结构：

- **`GlobalEvent`**（行 18586）：`{directory?: string, project?: string, workspace?: string, payload: anyOf<Event*>}`；每种子事件 `payload` 均 `{id: string(^evt_), type: enum, properties: object}` 且 `additionalProperties:false`。
- **`EventSessionCreated`**（行 39268）：properties `{sessionID: string(^ses), info: $ref Session}`，required `[sessionID, info]`。
- **`EventMessagePartUpdated`**（行 39459）：properties `{sessionID: string(^ses), part: $ref Part, time: number}`，required `[sessionID, part, time]`——**与 event-01 归一化 `message.part.updated` 的 `{sessionID, part, time}` 完全一致**（design.md D4 注）。
- **`EventMessagePartDelta`**（行 41245）：properties `{sessionID(^ses), messageID(^msg), partID(^prt), field: string, delta: string}`，required `[sessionID, messageID, partID, field, delta]`。
- **`EventSessionNextStepEnded`**（行 40039）：properties `{timestamp, sessionID(^ses), assistantMessageID(^msg_), finish: string, cost: number, tokens: {input, output, reasoning, cache:{read, write}}}`，required `[timestamp, sessionID, assistantMessageID, finish, cost, tokens]`。
- **`EventSessionError`**（行 41338）：properties `{sessionID(^ses), error: anyOf<ProviderAuthError|UnknownError|MessageOutputLengthError|MessageAbortedError|StructuredOutputError|ContextOverflowError|ContentFilterError|APIError>}`，required `[sessionID, error]`。
- **`EventSessionIdle`**（行 42414）：properties `{sessionID(^ses)}`，required `[sessionID]`。
- **`Session`**（行 16556）：opencode v2 会话对象，properties 含 `id(^ses)/slug/projectID/workspaceID(^wrk)/directory/path/parentID(^ses)/summary/cost:number/tokens/time{created,updated,compacting,archived}/title/agent/model{id,providerID,variant}/version/metadata/revert`；required `[id, slug, projectID, directory, title, version, time]`。注意：**opencode `Session.time` 为 epoch 整数毫秒（`type:integer, minimum:0`）**，与 api.yaml `SessionV2Info.time`（date-time 字符串）口径不同；`session.created` 的 `info` 字段用哪套结构需按 event-streaming spec（`info` 为 Session 结构）与 types.ts 口径协调。
- **`TextPart`**（行 17330）：required `[id(^prt), sessionID(^ses), messageID(^msg), type:'text', text]`；可选 `synthetic/ignored/time{start,end}/metadata`。
- **`ToolPart`**（行 17898）：required `[id(^prt), sessionID(^ses), messageID(^msg), type:'tool', callID, tool, state]`；`state` 为 `ToolState`（行 17882，anyOf `ToolStatePending/Running/Completed/Error`）。
- **`Part`**（行 18283）：TextPart/SubtaskPart/ReasoningPart/FilePart/ToolPart/StepStartPart/StepFinishPart/SnapshotPart/PatchPart/AgentPart/RetryPart/CompactionPart 联合。
- **`ModelV2Info`**（行 34161）：`id/providerID/family/name/api/capabilities/request/variants/time/cost/status(alpha|beta|deprecated|active)/enabled/limit`。
- **`LocationInfo`**（行 30727）：required `[directory, project]`；`project:{id, directory}` required；`workspaceID(^wrk)` 可选。

### 4. event-streaming/spec.md 归一化映射与回放语义

- **映射表**（spec「SDKMessage to GlobalEvent normalization」）：init→session.created、text_delta→message.part.delta、input_json_delta→message.part.delta、assistant→message.part.updated、result success→session.next.step.ended、result error→session.error、session_state_changed idle→session.idle。`payload.id` MUST `^evt_` 前缀；**无对应 opencode 事件类型的 SDKMessage SHALL 静默跳过（不产出事件）**。
- **text_delta 场景**：`{type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta', text:'hel'}}}` → properties 含 `sessionID/messageID/partID/field:'text'/delta:'hel'`。
- **input_json_delta 场景**：delta.type='input_json_delta' → properties 的 `field:'tool_input'`。
- **assistant 场景**：`{type:'assistant', message: BetaMessage, session_id, uuid}` → **对 `message.content` 每个内容块**产出 message.part.updated，properties 含 `sessionID` 和 `part`（文本块 TextPart 或工具调用块 ToolPart），与 `EventMessagePartUpdated`（`{sessionID, part, time}`）一致。
- **result success 场景**：properties 含 `sessionID/finish/cost/tokens`。
- **result error 场景**：properties 含 `sessionID/error`。
- **跳过场景**：hook_started、task_notification 等无对应类型 → 不产出。
- **回放**：「Session events stream」Requirement：`client.session.events(sessionId)` 返回该会话 `AsyncIterable<GlobalEvent>`；**会话 query() 完成（result 产出）后事件流在产出最终 session.next.step.ended 后正常结束（AsyncIterable return）**；`create()` 之后再 `events()` 仍收到 session.created（回放）。
- **全局视图**：「Global event stream with directory filter」：`client.global.event(options?)`；提供 `directory` 时只产出匹配该 directory（项目）的事件且 GlobalEvent.directory 等于该值；省略时用客户端 cwd 默认过滤。
- **信封**：「GlobalEvent envelope structure」：`{directory?, project?, workspace?, payload:{id(^evt_), type, properties}}`；`directory` 反映产出事件的项目目录。

### 5. model-providers/spec.md 与 design.md D9 控制 Query

- **List models** Requirement：`client.model.list(options?)` 返回 `{location: LocationInfo, data: ModelV2Info[]}`；内部 MUST 调用 `Query.supportedModels()` **或** `Query.initializationResult().models`。`location.directory` 等于客户端 cwd；指定 `{location:{directory}}` 时返回其值。**无会话时惰性初始化一个「控制 Query」**（`query({prompt: <空 AsyncIterable>, options:{cwd}})`），复用其 `supportedModels()`/`initializationResult().models`；该控制 Query 不 yield 用户消息、不产生对话轮次，在 `client.close()` 时关闭。
- **ModelInfo to ModelV2Info mapping** Requirement：`ModelInfo{value, resolvedModel?, displayName, description, ...}` → `ModelV2Info{id, providerID, name, status, ...}`；`value→id`、`displayName→name`、`providerID` 固定 `'anthropic'`、`status` 默认 `'active'`；`resolvedModel`（规范 wire id）保留在 variants 或扩展字段供消费者使用。
- **`Query.supportedModels()` 签名**（sdk.d.ts 行 2488）：`supportedModels(): Promise<ModelInfo[]>`；`Query.initializationResult()`（行 2459）：`initializationResult(): Promise<SDKControlInitializeResponse>`，其中 `models: coreTypes.ModelInfo[]`（行 3618）。`ModelInfo`（行 1224）：`{value: string, resolvedModel?: string, displayName: string, description: string, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode?}`。
- **控制 Query 创建方式**：`query({prompt, options}): Query`（行 2664）；`prompt` 传永不产出的空 AsyncGenerator（如 `(async function*(){})()`）；`options.cwd` 为客户端 cwd。`Query.close()`（行 2661）终止底层 CLI 进程，`client.close()` 时调用。

### 6. 已完成的 session-01 产物（event-01 直接复用）

- **`src/types.ts`**（infra-01）：已导出 `GlobalEventType`（六种事件类型联合，行 34-40）、`GlobalEventPayload`（`{id: EventID, type, properties: Record<string,unknown>}`，行 225-230）、`GlobalEvent`（`{directory?, project?, workspace?, payload}`，行 232-237）、`EventID = \`evt_${string}\``（行 19）、`ModelV2Info`（行 192-209，`variants?: Array<Record<string,unknown>>`）、`LocationInfo`（行 212-216）、`ModelListResponse`（行 219-222）、`ModelRef`/`LocationRef`/`TokenUsage`/`Cost`/`ClaudeSDKError`。**注意 `GlobalEventType` 不含 `session.status`**（design.md D4 映射表提到 `session.idle / session.status`，但 spec 与 types.ts 只列 session.idle——event-01 以 types.ts 为准只产出六种）。
- **`src/session-state.ts`**：`SessionState` 的 `events` 访问器（行 241-243）返回 `AsyncIterable<SDKMessage>`（`channel.subscribe()`）；`ReplayChannel`（行 104-135）为**回放型广播通道**——缓冲全部消息、晚订阅者从缓冲回放、`close()` 后流终止（`ReplaySubscriber` 各自持有游标，行 138-177）。`SessionState` 还暴露 `sessionId`（行 221）、`state`/`isIdle`（行 230-233）、`lastError`（行 236）、`directory`（行 218）。`SessionQueryOptions`（行 30-35）为 query options 子集 `{cwd?, agent?, model?, includePartialMessages?}`。**event-01 的 `GlobalEventManager.sessionEvents(sessionId)` 直接订阅 SessionManager.events(sessionId) 返回的原始 SDKMessage 流并归一化**。
- **`src/session.ts`**：`SessionManager` 维护 `Map<sessionId, SessionState>`（行 106）；`events(sessionId)`（行 223-226）返回 `state.events`（`AsyncIterable<SDKMessage>`），不存在会话抛 `SessionNotFoundError`；`close(sessionId)`/`closeAll()`（行 229-241）；`create()`（行 120-157）返回 `SessionV2Info`（`id` 保留 Claude 原始 session_id、`projectID` 由 `encodeProjectID(directory)` 生成、`location.directory`=客户端 cwd）。`SessionManagerOptions`（行 86-95）：`{cwd, queryFn?, getSessionMessagesFn?, initTimeoutMs?}`。
- **event-01 接线要点**：client.ts 的 `session.events` 命名空间方法 = `(sessionId) => globalEventManager.sessionEvents(sessionId)`（归一化为 GlobalEvent）；`global.event` = `GlobalEventManager` 的全局视图；`model.list` = `ModelManager.list()`。`client.close()` 需关闭 SessionManager 全部会话（`closeAll()`）与控制 Query。

### 7. 关键设计决策（design.md）

- **D1** 方法级库形态：导出 `createClaudeClient({ cwd })` 工厂，**不启动 HTTP 服务器**；消费者直接 import 调用，AsyncIterable 契合 TS 流式。
- **D3** 命名空间简化（无 v2 前缀）：`client.session.create()` / `client.model.list()` / `client.global.event()`。
- **D4** 流式与事件统一为 GlobalEvent：`session.events(id)`（会话级视图）+ `global.event({directory})`（全局视图，按 directory 过滤）共享同一套 SDKMessage→GlobalEvent 归一化逻辑；映射表（init/text_delta/input_json_delta/assistant/result success/result error/session_state_changed）；**`message.part.updated` 的 properties 采用 `{sessionID, part, time}`**（与 openapi `EventMessagePartUpdated` 一致），assistant 每个内容块 → 一条事件，part 为 TextPart 或 ToolPart；会话事件通道为**回放型广播通道**（create 后订阅仍收到 session.created），与 opencode `v2.session.events`「缺省从起始回放 durable 事件」语义一致。
- **D6** 事件订阅参数过滤：`global.event({directory})` 接收 directory 参数，库内部只产出匹配该 directory（cwd 编码后对应项目）的事件；GlobalEvent 信封自带 directory/project/workspace 字段，库在产出前按入参 directory 过滤。**省略 directory 时默认用客户端 cwd**（design.md Open Questions 建议）。
- **D7** ID 生成与映射：session_id 保留 Claude 原始值（不做 `^ses` 转换）；**message/part/event ID 在归一化时按 `^msg_`/`^prt`/`^evt_` 前缀生成**（用 Claude 的 uuid 映射或生成新 ID）。
- **D9** `model.list()` 的 Query 获取方式：**惰性初始化并缓存一个「控制 Query」**——首次调用时以 `query({prompt: <永不产出的空 AsyncIterable>, options:{cwd}})` 创建，复用其 `supportedModels()`/`initializationResult().models`，在 `client.close()` 时关闭；不 yield 用户消息、不产生对话轮次（代价是启动一次 CLI 子进程）。若客户端已有活跃会话，实现也可复用其 Query（细节由计划阶段确定）。

### 8. api.yaml 契约（`furina/changes/claude-sdk-adapter/api.yaml`，Swagger 2.0 承载方法级客户端契约）

- `/client/model/list`（GET）：`client.model.list(options?)`；内部调用 `Query.supportedModels()`，ModelInfo→ModelV2Info：value→id、displayName→name、providerID 固定 'anthropic'、status 默认 'active'、resolvedModel 保留在 variants；返回 `{location: LocationInfo, data: ModelV2Info[]}`；body 可含 `location.directory`（省略用客户端 cwd）。
- `/client/session/events`（GET）：`client.session.events(sessionId)` 返回 `AsyncIterable<GlobalEvent>`，事件源为该会话后台 query() 产出的 SDKMessage 流，归一化为 GlobalEvent 信封；会话 query() 完成后事件流在最终事件后正常结束。
- `/client/global/event`（GET）：`client.global.event(options?)`；options.directory 提供时只产出匹配项目的事件，省略时用客户端 cwd；产出的 GlobalEvent.directory 等于过滤 directory；与 `session.events(id)` 共享归一化逻辑（D4）。
- definitions 中 `GlobalEvent`（`{directory?, project?, workspace?, payload}`）、`GlobalEventPayload`（`{id(^evt_), type, properties}`）、`ModelV2Info`（required id/providerID/name/status，variants 数组存 resolvedModel）、`LocationInfo`（required directory/project）、`ModelListResponse`（required location/data）。

### 9. 实现要点与差异汇总（event-01）

1. **归一化函数输入**：`GlobalEventManager` 需把 `AsyncIterable<SDKMessage>`（来自 SessionState 回放通道）逐条映射为 GlobalEvent；无对应类型静默跳过（spec）。事件 ID 用 `evt_${crypto.randomUUID()}` 或类似（与 session-01 `makeMessageId()` 同法，types.ts `EventID` 模板收窄）。
2. **message.part.delta 的 ID 来源**：`messageID` 可取自 `stream_event.event` 为 `message_start` 时的 `message.id`（`BetaMessage.id`），或按 D7 用 Claude uuid 加 `msg_` 前缀生成；`partID` 可取自 `content_block_start` 的 `content_block.id`（tool_use 块有 id）或 `index` 加 `prt_` 前缀生成。spec 场景只断言 properties 含 `sessionID/messageID/partID/field/delta`。
3. **message.part.updated 的 Part 映射**：assistant 消息 `message.content` 每个块 → 一条事件；text 块→TextPart（`{id, sessionID, messageID, type:'text', text}`），tool_use 块→ToolPart（`{id, sessionID, messageID, type:'tool', callID: block.id, tool: block.name, state}`）；`time` 字段（EventMessagePartUpdated required）需产出（可取自 `SDKAssistantMessage.timestamp` 或生成）。thinking 块不映射（spec 只要求 text/tool_use）。
4. **result success→session.next.step.ended**：`finish` 可取自 `stop_reason`；`cost` 取自 `total_cost_usd`（number）；`tokens` 从 `usage`（NonNullableUsage）提取映射为 opencode TokenUsage 结构。EventSessionNextStepEnded required 还含 `timestamp/assistantMessageID`（spec 场景只要求 sessionID/finish/cost/tokens，实现时按 api.yaml/design D4 表格）。
5. **result error→session.error**：`error` 字段承载错误信息（SDK `errors: string[]`/`subtype`），映射到 openapi `EventSessionError.properties.error`。
6. **session.idle**：仅 `session_state_changed` 且 `state==='idle'` 时产出（spec 场景）；properties 含 `sessionID`。
7. **全局过滤（D6）**：`global.event({directory})` 以入参 directory（或默认客户端 cwd）过滤每个 GlobalEvent 的 `directory` 字段；需与 SessionManager 的会话 `location.directory`（create 时用客户端 cwd）一致。
8. **控制 Query（D9）**：ModelManager 惰性创建、缓存、`close()` 关闭；`prompt` 用永不产出的空 AsyncGenerator。
9. **client.ts 装配**：`createClaudeClient({cwd})` 实例化 SessionManager、ModelManager、GlobalEventManager；暴露 `session`（create/messages/prompt/interrupt/wait/events）、`model`（list）、`global`（event）三命名空间；`cwd` 作为默认 directory；不启动 HTTP 服务器（D1）。`close()` 清理会话与控制 Query。
10. **类型口径差异**：opencode `EventSessionNextStepEnded.cost` 为 number、`EventMessagePartUpdated.time` 为 epoch 毫秒；api.yaml/types.ts 的 `SessionV2Info.cost` 为 Cost 对象、`time` 为 date-time 字符串。GlobalEvent 归一化时 properties 字段口径以 event-streaming/spec.md 与 openapi Event* schema 为准，外层 GlobalEvent 信封以 types.ts 为准。
