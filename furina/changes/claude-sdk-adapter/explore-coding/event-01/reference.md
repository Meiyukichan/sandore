## Exploration Result

### Phase 1: 参考资料配置

`furina config show exploration.reference` 返回空数组 `[]`，但 exploreContent 已显式列出本次探索所需的全部参考资料（Claude SDK 消息结构、ModelInfo、`docs/sdk/openapi.json` 事件 schema、`specs/event-streaming` 与 `specs/model-providers`、`design.md` 的 D1/D3/D4/D6/D9、session-01 已落地产物、`@anthropic-ai/claude-agent-sdk` 签名），故按下述清单逐项探索：

1. `node_modules/.pnpm/@anthropic-ai+claude-agent-_3d6e0582a1149899b85c7d67a91390db/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（实际安装 **v0.3.226**，7453 行；design.md/api.yaml 标注 v0.3.227，字段级差异不影响本次探索）
2. `node_modules/.pnpm/@anthropic-ai+sdk@0.116.0_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts`（`BetaMessage`/`BetaRawMessageStreamEvent`/`BetaTextDelta`/`BetaInputJSONDelta` 内容块与流式子事件权威定义）
3. `docs/sdk/claude/streaming-output.md` 与 `typescript-sdk-api.md`（流式事件序列、`supportedModels()`/`initializationResult()`/`ModelInfo` 用法）
4. `scripts/conversation.ts`（流式消费 stream_event/assistant/result 的参考蓝本）
5. `furina/changes/claude-sdk-adapter/specs/event-streaming/spec.md` 与 `specs/model-providers/spec.md`（归一化映射、GlobalEvent 信封、回放、model.list 契约）
6. `furina/changes/claude-sdk-adapter/design.md`（D1/D3/D4/D6/D9 决策）
7. `furina/changes/claude-sdk-adapter/api.yaml` 与 `plan.json`（event-01 方法级契约与 8 条验收口径）
8. `docs/sdk/openapi.json`（EventSessionCreated/EventMessagePartUpdated/EventMessagePartDelta/EventSessionNextStepEnded/EventSessionError/EventSessionIdle/Session/TextPart/ToolPart 的 properties 结构）
9. session-01 已落地产物：`packages/sdk/claude/src/types.ts`、`src/session-state.ts`、`src/session.ts`、`test/session.test.ts`（GlobalEventManager 的集成点与测试惯例）

---

### Phase 2: 需求理解

**What**：实现 event-01 三个能力域——(a) `src/events.ts` 的 SDKMessage→GlobalEvent 归一化与 `GlobalEventManager`（`sessionEvents(sessionId)` 会话级视图 + `global.event({directory})` 全局视图）；(b) `src/model.ts` 的 `ModelManager.list()`（惰性初始化并缓存控制 Query，包装 `Query.supportedModels()`，ModelInfo→ModelV2Info 映射）；(c) `src/client.ts` 的 `createClaudeClient({cwd})` 工厂（组装 session/model/global 三命名空间，cwd 作默认 directory，不启动 HTTP 服务器）。

**Boundaries**：仅覆盖 plan.json `event-01` 范畴。session-01 的 `SessionState`（后台 query 泵、输入队列、原始 SDKMessage 回放通道）与 `SessionManager`（create/messages/prompt/interrupt/wait/close）已完成且**不改动**——event-01 在其之上叠加归一化层与客户端装配。归一化只处理「有 opencode 对应」的 7 类 SDKMessage（system/init、stream_event text_delta/input_json_delta、assistant、result success/error、session_state_changed idle），其余静默跳过。不实现 HTTP 服务器（D1）。

**Goal**：摸清 (a) 每类 SDKMessage 到 GlobalEvent 的**精确字段映射**——payload.type、properties 各字段（sessionID/messageID/partID/field/delta/info/part/time/finish/cost/tokens/error）分别取自 SDK 消息的哪个字段；(b) 流式归一化所需的**跨消息状态**（message_start 的 message.id→messageID、content_block 索引→partID 生成）；(c) `sessionEvents` 与 `global.event` 在回放型广播通道上的订阅/过滤/终止语义；(d) `ModelManager.list()` 控制 Query 的惰性初始化、缓存与关闭时机（D9），及 ModelInfo→ModelV2Info 逐字段映射；(e) `createClaudeClient` 三命名空间的装配点（如何把 SessionManager.events 的原始通道接到 GlobalEventManager 归一化）；(f) 现有 types.ts/session-state.ts/session.ts 可直接复用与需新增的类型/访问器。

---

### Phase 3: 参考物探索结果

#### 3.1 event-streaming/spec.md 的归一化映射与回放语义（event-01 核心契约）

**映射表**（`specs/event-streaming/spec.md`「SDKMessage to GlobalEvent normalization」）：

| SDKMessage | GlobalEvent payload.type | properties 要点 |
|---|---|---|
| `system`（subtype=init） | `session.created` | `sessionID`（=session_id）+ `info`（Session 结构） |
| `stream_event`（content_block_delta，delta.type=text_delta） | `message.part.delta` | `sessionID`、`messageID`、`partID`、`field:'text'`、`delta`（=text） |
| `stream_event`（content_block_delta，delta.type=input_json_delta） | `message.part.delta` | 同上，但 `field:'tool_input'`、`delta`（=partial_json） |
| `assistant`（完整消息） | `message.part.updated` | 对 `message.content` 的每个内容块产出一条：`sessionID` + `part`（TextPart 或 ToolPart） + `time`，与 openapi 的 `EventMessagePartUpdated`（`{sessionID, part, time}`）一致 |
| `result`（subtype=success） | `session.next.step.ended` | `sessionID`、`finish`、`cost`、`tokens` |
| `result`（subtype=error_*） | `session.error` | `sessionID`、`error` |
| `system`（session_state_changed，state=idle） | `session.idle` | `sessionID` |

**约束**：
- 每个 GlobalEvent 的 `payload.id` MUST 符合 `^evt_` 前缀（spec「GlobalEvent envelope structure」场景「event ID 符合前缀约束」）。
- 无对应 opencode 事件类型的 SDKMessage（如 hook_started、task_notification、SDKCompactBoundaryMessage、SDKStatusMessage 等 40+ 联合成员中的其余类型）**静默跳过，不产出事件**。
- **信封结构**：`{ directory?, project?, workspace?, payload: { id(^evt_), type, properties } }`；`payload.type` 用 opencode 定义的事件类型字符串；`directory` 反映产出该事件的项目目录（spec「GlobalEvent 包含正确的 directory」：客户端 cwd 为 '/projects/myapp' 时 GlobalEvent.directory 等于它）。
- **会话事件回放**（spec「Session events stream」场景「create 之后订阅仍收到 session.created」）：`session.events` 的事件通道为**回放型广播通道**——事件自会话创建起缓冲，`session.create()` 之后再 `session.events(id)` 的晚订阅者同样收到 `session.created` 等已发生事件；会话 query() 完成后事件流在产出最终 `session.next.step.ended` 后**正常结束（AsyncIterable return）**。
- **directory 过滤**（spec「Global event stream with directory filter」）：`global.event(options?)` 的 options 可含 `directory`；提供时只产出匹配该 directory 的事件且 GlobalEvent.directory 等于它；省略时**用客户端 cwd 作默认 directory** 过滤。
- `message.part.delta` 的 properties 必含 `sessionID`、`messageID`、`partID`、`field`、`delta`（text_delta 场景字段值为 'text'；input_json_delta 场景为 'tool_input'）。

#### 3.2 SDKMessage → GlobalEvent 归一化的 SDK 源类型（claude-agent-sdk sdk.d.ts）

**`SDKMessage` 联合**（行 4184）：`SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | SDKAPIRetryMessage | SDKControlRequestProgressMessage | SDKModelRefusalFallbackMessage | ... | SDKSessionStateChangedMessage | ...`（40+ 成员）——归一化 switch 需按 `type`/`subtype` 判别，未映射类型走 default 静默跳过。

**`SDKSystemMessage`（init）**（行 4601）：`{ type:'system', subtype:'init', uuid, session_id: string, cwd: string, model: string, permissionMode, claude_code_version, apiKeySource, tools: string[], mcp_servers: {name,status}[], slash_commands, output_style, skills, plugins, capabilities?: string[], agents? }`。→ `session.created`：`sessionID = message.session_id`；`info` 由 SessionV2Info 结构承载（含 `location.directory`）。

**`SDKPartialAssistantMessage`（stream_event）**（行 4321）：`{ type:'stream_event', event: BetaRawMessageStreamEvent, parent_tool_use_id: string|null, uuid: UUID, session_id: string, ttft_ms?: number }`。→ 归一化只关心 `event` 的 `content_block_delta` 子事件（text_delta / input_json_delta）。

**`SDKAssistantMessage`**（行 3019）：`{ type:'assistant', message: BetaMessage, parent_tool_use_id: string|null, error?: SDKAssistantMessageError, uuid, session_id, request_id?, aborted?: true, subagent_type?, task_description?, timestamp?: string（ISO 时间戳） }`。→ `message.part.updated` 的 `part` 逐块取自 `message.content`（BetaMessage.content）。

**`SDKResultSuccess`**（行 4472）：`{ type:'result', subtype:'success', uuid, session_id, duration_ms, duration_api_ms, result: string, stop_reason: string|null, num_turns, total_cost_usd: number, usage: NonNullableUsage, modelUsage: Record<string, ModelUsage>, permission_denials, terminal_reason?, ... }`。→ `session.next.step.ended`：`cost` 来源 `total_cost_usd`；`tokens` 由 `usage`（BetaUsage 映射）构造；`finish` 可取自 `stop_reason`/`terminal_reason`。

**`SDKResultError`**（行 4440）：`{ type:'result', subtype:'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries', uuid, session_id, duration_ms, total_cost_usd, usage, modelUsage, errors: string[], stop_reason, ... }`。→ `session.error`：`error` 由 subtype/errors 构造（openapi 侧 error 为 `{name, data}` 结构的错误联合）。

**`SDKSessionStateChangedMessage`**（行 4562）：`{ type:'system', subtype:'session_state_changed', state: 'idle'|'running'|'requires_action', uuid, session_id }`。→ 仅 `state === 'idle'` 时映射 `session.idle`（properties 仅含 `sessionID`）；running/requires_action 不产出（或按 D4 可归为 session.status，spec 映射表只列 idle）。

**`BetaUsage`/`NonNullableUsage`**（sdk.d.ts 行 1284 + @anthropic-ai/sdk messages.d.ts 行 2902）：`NonNullableUsage = { [K in keyof BetaUsage]: NonNullable<BetaUsage[K]> }`；BetaUsage 含 `input_tokens: number`、`output_tokens: number`、`cache_creation_input_tokens: number|null`、`cache_read_input_tokens: number|null`、`iterations`、`inference_geo` 等。→ tokens 映射：`input←input_tokens`、`output←output_tokens`、`cache.write←cache_creation_input_tokens`、`cache.read←cache_read_input_tokens`（openapi tokens 的 `reasoning` 无 BetaUsage 直接来源，可省）。

#### 3.3 stream_event 子事件（BetaRawMessageStreamEvent）与 assistant 消息内容块

**`BetaRawMessageStreamEvent`**（messages.d.ts 行 1837）= `BetaRawMessageStartEvent | BetaRawMessageDeltaEvent | BetaRawMessageStopEvent | BetaRawContentBlockStartEvent | BetaRawContentBlockDeltaEvent | BetaRawContentBlockStopEvent`。

| 子事件 | 结构（messages.d.ts） | 归一化用途 |
|---|---|---|
| `message_start`（行 1830） | `{ type:'message_start', message: BetaMessage }` | **messageID 捕获点**（`message.id`，如 'msg_01...'）；也可用于会话内消息序列 |
| `content_block_start`（行 1777） | `{ type:'content_block_start', index: number, content_block: BetaTextBlock|BetaThinkingBlock|BetaToolUseBlock|... }` | 内容块索引 → **partID 生成**（`prt_` 前缀）；tool_use 块此处置 name |
| `content_block_delta`（行 1772） | `{ type:'content_block_delta', index: number, delta: BetaTextDelta|BetaInputJSONDelta|BetaCitationsDelta|BetaThinkingDelta|BetaSignatureDelta|BetaCompactionContentBlockDelta }` | **归一化主事件源** |
| `content_block_stop`（行 1785） | `{ type:'content_block_stop', index: number }` | 块边界（归一化可忽略） |
| `message_delta`（行 1789） | `{ type:'message_delta', delta:{stop_reason, stop_sequence, container, stop_details}, usage, context_management }` | stop_reason/finish 可选项 |
| `message_stop`（行 1834） | `{ type:'message_stop' }` | 消息结束（归一化可忽略） |

**delta 载荷**：
- `BetaTextDelta`（行 2139）：`{ text: string, type:'text_delta' }` → `message.part.delta` properties：`field:'text'`、`delta: event.delta.text`。
- `BetaInputJSONDelta`（行 1266）：`{ partial_json: string, type:'input_json_delta' }` → `message.part.delta` properties：`field:'tool_input'`、`delta: event.delta.partial_json`。

**`BetaMessage`**（行 1487）：`{ id: string, container, content: Array<BetaContentBlock>, context_management, diagnostics, model, role, stop_reason, stop_sequence, usage, ... }`。
**内容块**（assistant 完整消息 `message.content`）：
- `BetaTextBlock`（行 2116）：`{ citations, text: string, type:'text' }` → TextPart（`type:'text'`、`text`）。
- `BetaToolUseBlock`（行 2862）：`{ id: string, input: unknown, name: string, type:'tool_use', caller? }` → ToolPart（`type:'tool'`、`callID: block.id`、`tool: block.name`、`input`）。
- `BetaThinkingBlock`（行 2207）：`{ signature: string, thinking: string, type:'thinking' }` → openapi 对应 ReasoningPart，但 spec 只要求 TextPart/ToolPart 两种（thinking 块映射属实现细节，spec 未列）。

**消息流顺序**（streaming-output.md「消息流」）：`message_start → content_block_start(文本块) → content_block_delta(text_delta...) → content_block_stop → content_block_start(tool_use 块) → content_block_delta(input_json_delta...) → content_block_stop → message_delta → message_stop → AssistantMessage(完整消息) → [工具执行...] → 下一轮流事件 → ResultMessage`。要点：**流式增量事件与最终完整 assistant 消息并存**——`message.part.delta`（流式）与 `message.part.updated`（完整）都产出。

#### 3.4 openapi.json 各 GlobalEvent 事件 schema 与 Part 结构

| schema | 行号 | properties（适配层按 api.yaml 用 `properties` 承载） |
|---|---|---|
| `EventSessionCreated` | 39268 | `sessionID`(^ses)、`info`(Session)；properties required=[sessionID, info] |
| `EventMessagePartUpdated` | 39459 | `sessionID`(^ses)、`part`(Part)、`time`(number)；properties required=[sessionID, part, time] |
| `EventMessagePartDelta` | 41245 | `sessionID`(^ses)、`messageID`(^msg)、`partID`(^prt)、`field`(string)、`delta`(string)；properties required=[sessionID, messageID, partID, field, delta] |
| `EventSessionNextStepEnded` | 40039 | `timestamp`(number)、`sessionID`(^ses)、`assistantMessageID`(^msg_)、`finish`(string)、`cost`(number)、`tokens`({input,output,reasoning,cache{read,write}} 全 required)；properties required=[timestamp, sessionID, assistantMessageID, finish, cost, tokens] |
| `EventSessionError` | 41338 | `sessionID`(^ses)、`error`(anyOf ProviderAuthError\|UnknownError\|MessageOutputLengthError\|MessageAbortedError\|StructuredOutputError\|ContextOverflowError\|ContentFilterError\|APIError) |
| `EventSessionIdle` | 42414 | `sessionID`(^ses)；properties required=[sessionID] |

> 注：`EventSessionNextStepEnded` 的 openapi required 含 `timestamp`、`assistantMessageID`，但 spec/plan 的映射要点只列 `finish/cost/tokens`（plan.json 验收：「result success→session.next.step.ended(finish/cost/tokens)」）；适配层 `GlobalEventPayload.properties` 为 `Record<string, unknown>`，以 spec 为准补 `sessionID` 即可。

**`Session`**（行 16556，session.created 的 `info`）：required=[id, slug, projectID, directory, title, version, time]；properties 含 `id`(^ses)、`projectID`、`directory`、`title`、`agent?`、`model?{id, providerID, variant?}`、`cost`(number)、`tokens`、`time{created, updated, compacting?, archived?}`、`metadata?` 等。types.ts 的 `SessionV2Info`（required id/projectID/cost/tokens/time/title/location）为适配层精简口径（api.yaml 为准）。

**`TextPart`**（行 17330）：required=[id(^prt), sessionID(^ses), messageID(^msg), type:'text', text]；可选 `synthetic?`、`ignored?`、`time?{start, end}`、`metadata?`。
**`ToolPart`**（行 17898）：required=[id(^prt), sessionID(^ses), messageID(^msg), type:'tool', callID, tool, state(ToolState), （metadata? 可选）]。
**`Part`**（行 18283）：anyOf TextPart|SubtaskPart|ReasoningPart|FilePart|ToolPart|StepStartPart|StepFinishPart|SnapshotPart|PatchPart|AgentPart|RetryPart|CompactionPart。
**`ToolState`**（行 17882）：anyOf ToolStatePending|Running|Completed|Error，各变体用 `status`(枚举) 判别、含 `input`/`output`/`time` 等；**types.ts 已将其简化为字符串联合 `'pending'|'running'|'completed'|'error'`**（event-01 若产出 ToolPart.state 需注意该口径差异）。

#### 3.5 GlobalEventManager：sessionEvents 与 global.event（回放与过滤）

**会话级视图**（spec「Session events stream」）：`client.session.events(sessionId)` 返回该会话的 `AsyncIterable<GlobalEvent>`；事件源为该会话后台 query() 产出的 SDKMessage 流，经归一化转换；消费者 `for await...of` 消费；query() 完成后事件流在最终事件后正常结束；create() 之后订阅仍回放已缓冲事件（含 session.created）。

**全局视图**（spec「Global event stream with directory filter」）：`client.global.event(options?)` 返回全局事件 `AsyncIterable<GlobalEvent>`；options 含 `directory` 时只产出匹配该 directory 的事件且 GlobalEvent.directory 等于该值；省略时用客户端 cwd 作默认过滤 directory。api.yaml `/client/global/event` 与 design.md D6 描述一致：「库内部只产出匹配该 directory（即 cwd 编码后对应的项目）的事件；GlobalEvent 信封自带 directory/project/workspace 字段，库在产出前按入参 directory 过滤」。design.md D4：`session.events(id)` 与 `global.event({directory})` **共享同一套 SDKMessage→GlobalEvent 归一化逻辑**。

**回放通道实现基础**（session-01 已落地）：`session-state.ts` 的 `ReplayChannel<T>`（私有类，行 104-135）——缓冲所有消息（`buffer: T[]`）、`write()` 写入并 notify 全部订阅者、`close()` 后各订阅者 `end()`；`ReplaySubscriber<T>`（行 138-177）——共享 buffer、各自 `index` 游标、`notify()/end()` 唤醒挂起迭代；`SessionState.events` getter（行 241-243）每次访问返回 `this.channel.subscribe()`（新订阅从缓冲回放）。事件通道为**原始 SDKMessage 通道**（`AsyncIterable<SDKMessage>`），归一化为 GlobalEvent 由 event-01 负责（session-state.ts 文件头注释明确此分工）。

**集成点**：`session.ts` 的 `SessionManager.events(sessionId)`（行 223-226）返回 `AsyncIterable<SDKMessage>`（`getState(sessionId)` 后返回 `state.events`）。GlobalEventManager 需在 `sessionEvents(sessionId)` 中读取该会话后台通道（原始 SDKMessage）并归一化。`SessionManager` 的 `sessions: Map<string, SessionState>` 为私有（行 106），`create()` 将 `state.directory`（=options cwd）存入 SessionState；global.event 按 directory 过滤需要跨会话枚举——当前 `SessionManager` 公开面**无按 directory 枚举或列出全部会话的方法**，event-01 装配时需在 client 工厂或 GlobalEventManager 侧建立会话注册/枚举来源（或在 SessionManager 增补访问器）。

#### 3.6 model-providers/spec.md 与 ModelManager.list()（D9 控制 Query）

**`model.list()`**（spec「List models」）：返回 `{ location: LocationInfo, data: ModelV2Info[] }`；内部调用 `Query.supportedModels()` 或 `Query.initializationResult().models`；每项含 `id`、`providerID`、`name`、`status`；`location.directory` 等于客户端 cwd；`model.list({ location: { directory: '/custom/path' } })` 时返回的 location.directory 等于 '/custom/path'；无会话时惰性初始化控制 Query（`query({ prompt: <空 AsyncIterable>, options: { cwd } })`），该控制 Query 不 yield 用户消息、不产生对话轮次，在 `client.close()` 时关闭（spec 场景 + design.md D9）。

**`ModelInfo→ModelV2Info` 映射**（spec「ModelInfo to ModelV2Info mapping」）：`value→id`、`displayName→name`、providerID 固定 `'anthropic'`、status 默认 `'active'`；含 `resolvedModel` 时保留在 ModelV2Info 的扩展字段或 **variants** 中供消费者使用。api.yaml `/client/model/list`（行 691-723）同样标注「value→id、displayName→name、providerID 固定 'anthropic'、status 默认 'active'、resolvedModel 保留在 variants」。

#### 3.7 ModelInfo 结构与 SDK 签名（claude-agent-sdk sdk.d.ts + typescript-sdk-api.md）

**`ModelInfo`**（sdk.d.ts 行 1224）：
```ts
type ModelInfo = {
  value: string;          // → ModelV2Info.id
  resolvedModel?: string; // 规范 wire id（如 'sonnet'→'claude-sonnet-5'）→ variants
  displayName: string;    // → ModelV2Info.name
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ('low'|'medium'|'high'|'xhigh'|'max')[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};
```
typescript-sdk-api.md 行 3217-3228 与其一致（`resolvedModel` 需 Claude Code v2.1.197+；描述「别名条目解析为显式模型 ID，供主机将持久化的显式 ID 与覆盖它的别名条目匹配」）。

**`Query` 方法签名**（sdk.d.ts 行 2356、2459、2488）：
```ts
interface Query extends AsyncGenerator<SDKMessage, void> {
  supportedModels(): Promise<ModelInfo[]>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  close(): void;
  // setModel / setPermissionMode / supportedCommands / supportedAgents / streamInput 等
}
```
`SDKControlInitializeResponse`（行 3613）：`{ commands, agents, output_style, available_output_styles, models: ModelInfo[], account, fast_mode_state? }`——`initializationResult().models` 与 `supportedModels()` 同为模型列举来源。
`query()` 签名（行 2664）：`query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query`；`Options.includePartialMessages?: boolean`（行 1655，true 时产出 `SDKPartialAssistantMessage` token 级事件）、`Options.cwd?: string`（行 1413，默认 `process.cwd()`）、`Options.agent?`/`Options.model?`。

**关键前提（D9 理由）**：`supportedModels()`/`initializationResult()` 是 **Query 实例方法**（Claude SDK 无模块级模型列举函数），而 Query 通常由 `session.create()` 创建；`model.list()` 作为客户端级方法可能在创建任何会话前被调用（如渲染模型选择器），故需独立控制 Query 来源。控制 Query 用「永不产出的空 AsyncIterable」作 prompt——不 yield 用户消息即不产生对话轮次，代价是启动一次 CLI 子进程（一次性开销）。

#### 3.8 design.md 决策（event-01 相关）

- **D1（方法级库形态）**：导出 `createClaudeClient({ cwd })` 工厂，返回客户端对象，不启动 HTTP 服务；与 `@opencode-ai/sdk` 的 `createOpencodeClient()` 用法一致。
- **D3（命名空间简化）**：`client.session.create()` / `client.model.list()` / `client.global.event()`，不用 `client.v2.*`。
- **D4（流式与事件统一为 GlobalEvent）**：`session.events(id)` 会话级视图 + `global.event({directory})` 全局视图，共享同一套 SDKMessage→GlobalEvent 归一化逻辑；映射表见 3.1；`message.part.updated` 采用 `{sessionID, part: Part, time}`（与 openapi EventMessagePartUpdated 一致）；「会话事件回放」：事件自会话创建起缓冲，晚订阅者仍收到 session.created，与 opencode v2 的「缺省从起始回放 durable 事件」语义一致；流式输出最后转换为 message.part.delta 与 message.part.updated。
- **D6（事件订阅参数过滤）**：`client.global.event({ directory })` 接收 directory 参数，库内部只产出匹配该 directory 的事件；GlobalEvent 信封自带 directory/project/workspace 字段，库在产出前按入参 directory 过滤。
- **D7（ID 生成与映射）**：session 保留 Claude 原始 session_id（不做 ^ses 转换）；message/part/event ID 在归一化时按 `^msg_`/`^prt`/`^evt_` 前缀生成（用 Claude 的 uuid 映射或生成新 ID）。
- **D9（model.list() 的 Query 获取方式）**：`ModelManager.list()` 惰性初始化并缓存一个「控制 Query」——首次调用以 `query({ prompt: <永不产出的空 AsyncIterable>, options: { cwd } })` 创建，复用其 `supportedModels()` / `initializationResult().models`，在 `client.close()` 时关闭；若客户端已有活跃会话也可复用其 Query（细节由计划阶段确定）。
- **D8（工程结构）**：`src/{client,session,model,events,types,session-state}.ts` + `test/*.test.ts`；`@anthropic-ai/claude-agent-sdk` 为 peerDependency。
- **风险条目**：事件类型覆盖不全——仅适配「有对应」的 GlobalEvent 类型，未映射消息静默跳过（不产出事件）。

#### 3.9 session-01 已落地产物的集成点（types.ts / session-state.ts / session.ts）

**`src/types.ts`**（infra-01 产物，event-01 直接复用）：
- `GlobalEventType`（行 34-40）：`'session.created' | 'message.part.delta' | 'message.part.updated' | 'session.next.step.ended' | 'session.error' | 'session.idle'`——与 6 类归一化目标一一对应。
- `GlobalEventPayload`（行 225-229）：`{ id: EventID(^evt_${string}), type: GlobalEventType, properties: Record<string, unknown> }`。
- `GlobalEvent`（行 232-237）：`{ directory?, project?, workspace?, payload }`。
- `ModelV2Info`（行 192-209）：required `id/providerID/name/status`；`variants?: Array<Record<string, unknown>>`（resolvedModel 保留处）、`status: ModelStatus`（默认 'active'）、`enabled?`（默认 true）。
- `LocationInfo`（行 212-216）：`{ directory, workspaceID?, project: { id, directory } }`（required=[directory, project]）。
- `ModelListResponse`（行 219-222）：`{ location: LocationInfo, data: ModelV2Info[] }`。
- `SessionV2Info`（行 77-93）、`TokenUsage`（行 56-61）、`Cost`（行 64-67）、`MessageID = \`msg_${string}\``、`EventID = \`evt_${string}\``、`WorkspaceID`。
- **types.ts 未定义 TextPart/ToolPart**——event-01 产出 `message.part.updated` 的 `part` 时需自行定义（可对照 openapi TextPart/ToolPart 的 required，id 用 `^prt` 前缀模板类型）。
- 注意口径差异：types.ts `SessionV2Info.time` 为 date-time 字符串（api.yaml 为准），openapi `EventMessagePartUpdated.time` 为 number（epoch 毫秒）——归一化 `time` 字段的形态需按 spec 的「与 EventMessagePartUpdated 的 {sessionID, part, time} 一致」权衡。

**`src/session-state.ts`**（session-01 产物，event-01 只读）：
- `SessionState.events` getter（行 241-243）：`get events(): AsyncIterable<SDKMessage> { return this.channel.subscribe(); }`——每次访问返回新订阅（回放型）。event-01 的 `sessionEvents(sessionId)` 即消费此原始通道并归一化。
- `SessionState.directory`（行 218）：会话工作目录（create 时客户端 cwd）——global.event 按 directory 过滤的匹配依据。
- `SessionState.sessionId` getter（行 221-223）、`isIdle`（行 231-233）、`lastError`（行 236-238）、`close()`（行 323-333，关闭通道触发订阅者 end()）——会话结束后流正常终止的基础。
- 通道关闭语义：`ReplayChannel.close()`（行 117-124）置 closed 并对各订阅者 `end()`；`ReplaySubscriber.iterate()`（行 158-176）在 `ended` 且游标消费完缓冲后 `return`（正常终止）。

**`src/session.ts`**（session-01 产物，event-01 只读/扩展）：
- `SessionManager.events(sessionId)`（行 223-226）：返回 `AsyncIterable<SDKMessage>`（原始通道）——**client 工厂需经 GlobalEventManager 归一化后才对外暴露 `client.session.events` 返回 GlobalEvent**。
- `SessionManager` 构造（行 112-117）：`{ cwd, queryFn?, getSessionMessagesFn?, initTimeoutMs? }`——`cwd` 为客户端工作目录。
- `create()`（行 120-157）：`SessionState` 以 `directory`（=options.location?.directory ?? options.cwd ?? this.cwd）启动 query；SessionV2Info.location.directory = directory。`create({ location: { directory: '/custom/path' } })` 支持自定义 location。
- `closeAll()`（行 236-241）：客户端销毁时清理全部会话。
- 私有 `sessions: Map<string, SessionState>`（行 106）+ `getState()`（行 243-249）抛 `SessionNotFoundError`。

**`test/session.test.ts`**（测试惯例）：依赖注入 `queryFn`/`getSessionMessagesFn`（FakeQuery 实现 `QueryLike`，pushMessage/end/fail/readInput 可控）；`initMessage()`/`stateMessage()`/`resultMessage()` 以 `as unknown as SDKMessage` 构造 SDK 消息（SDK 联合类型字段极多，只关心子集）；`flush()`（`await new Promise(resolve => setTimeout(resolve, 0))`）推进后台泵；`describe/it/expect/vi` 来自 vitest。event-01 的 events/model/client 测试可沿用同一 FakeQuery + 依赖注入模式。

#### 3.10 工程基线、ID/信封约束与验收口径汇总

**ID 前缀约束**（openapi pattern + design D7）：session `^ses`（适配层保留原始 session_id，例外）、message `^msg_`、part `^prt`、event `^evt_`、workspace `^wrk`。归一化时 message/part/event ID 按前缀生成（D7：用 Claude 的 uuid 映射或生成新 ID；session.ts 已示范 `msg_${crypto.randomUUID()}` 用 Web Crypto 全局 randomUUID，避免 @types/node 依赖）。

**GlobalEvent 信封**：`{ directory?, project?, workspace?, payload: { id(^evt_), type, properties } }`；payload required=[id, type, properties]；`properties` 为 `Record<string, unknown>`。

**plan.json event-01 验收口径**（8 条）：
1. `model.list()` 返回 `{location, data}`，data 为 ModelV2Info[]（含 id/providerID/name/status）；location.directory=cwd；指定 location.directory 时返回其值；无会话时惰性初始化控制 Query（D9）。
2. ModelInfo→ModelV2Info：value→id、displayName→name、providerID='anthropic'、status='active'；resolvedModel 保留在 variants。
3. `session.events(sessionId)` 返回 AsyncIterable<GlobalEvent>；create() 之后订阅仍收到 session.created（回放）；query() 完成后事件流在最终事件后正常 return。
4. `global.event({ directory })` 只产出匹配该 directory 的事件且 GlobalEvent.directory 等于该值；省略 directory 用客户端 cwd 过滤。
5. 归一化映射：init→session.created、text_delta→message.part.delta(field:'text')、input_json_delta→message.part.delta(field:'tool_input')、assistant 每个内容块→message.part.updated(part: TextPart|ToolPart)、result success→session.next.step.ended(finish/cost/tokens)、result error→session.error、idle→session.idle；无对应类型静默跳过。
6. 每个 GlobalEvent 符合信封结构，payload.id 以 evt_ 开头，payload.type 为 opencode 事件类型字符串。
7. `createClaudeClient({ cwd })` 返回含 session/model/global 三命名空间客户端对象，不启动 HTTP 服务器。
8. `test/events.test.ts`、`test/model.test.ts`、`test/client.test.ts` 覆盖上述场景且全部通过。

**api.yaml 命名空间映射**：`client.session.*` → v2.session.*；`client.model.list` → v2.model.list（GET /api/model）；`client.global.event` → global.event（GET /global/event）。

**编码规范（furina-cleancode clean-ts，来自 infra-01/session-01 cleancode.md 已确立）**：命名导出、`import type`、相对导入、单引号、显式分号、2 空格缩进、类 `private readonly`/参数属性/声明处初始化、getter 纯函数、错误用 `Error` 子类承载 `_tag` 判别字段、switch 必含 default（静默跳过未映射类型）、`as` 断言需运行时守卫+注释、文件头 JSDoc、避免 `any` 用 `unknown`、`crypto.randomUUID()` 生成 ID（不引 @types/node）。

---

## Supplementary Exploration Result

`experimental.websearch=true`、`experimental.context7=true`。本次参考物信息充分且互为印证：Claude SDK 源类型（`sdk.d.ts` v0.3.226 与 `@anthropic-ai/sdk` beta messages `messages.d.ts`）、官方文档（`docs/sdk/claude/streaming-output.md`、`typescript-sdk-api.md`）、本地权威契约（`specs/event-streaming`、`specs/model-providers`、`design.md`、`api.yaml`、`plan.json`）、目标协议（`docs/sdk/openapi.json` 各事件与 Part schema）、session-01 已落地产物（`types.ts`/`session-state.ts`/`session.ts`/`session.test.ts`）均已直接读取核实，归一化映射字段、ModelInfo→ModelV2Info 映射、回放/过滤语义、控制 Query（D9）、客户端装配点均已有权威来源，足以支撑 event-01 的 events.ts/model.ts/client.ts 实现，无需启用 websearch/context7 补充查询。无额外补充结果。
