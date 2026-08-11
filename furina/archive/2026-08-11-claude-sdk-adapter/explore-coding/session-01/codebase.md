## Exploration Result

### Phase 3: furina-codebase 探索结果

`furina config show project.sourcecode codebases` 返回：
- `project.sourcecode=src/`
- `codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`

`docs/codebase` 目录为**空目录**（无任何文件），无法从中获取项目自有代码库信息。`.claude/furina.json` 中 `project.codebase.enable=false`、`path=docs/codebase`、`project.sourcecode=src/`（根目录 `src/` 不存在）。`packages/sdk/claude/src/` 目前仅有 `infra-01` 完成产物 `types.ts`（无 `session-state.ts` / `session.ts`）。全部探索信息来自 Phase 4 补充探索。

## Supplementary Exploration Result

### 1. 任务边界与前置状态（infra-01 已完成）

- `packages/sdk/claude/` 已就绪：`package.json`（`@meiyukichan/claude-sdk`、`type: module`、`@anthropic-ai/claude-agent-sdk` 为 peerDependency `>=0.3.0`、`typescript`/`vitest` 为 devDependency）、`tsconfig.json`（继承 `tsconfig.base.json`，ESNext/bundler/strict）、`src/types.ts`（已导出全部协议类型）、`test/types.test.ts`（vitest + `expectTypeOf` 编译期断言 + 值构造运行时断言）。
- `plan.json` 中 `session-01` 状态 `in_progress`，`files` 为 `packages/sdk/claude/src/session-state.ts`、`src/session.ts`、`test/session.test.ts`（均**尚未创建**）。
- 类型层（`src/types.ts`）已为本任务提供全部所需协议类型，详见 §6。

### 2. Claude SDK query() 流式输入模式（核心参考，design.md D2）

`scripts/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（v0.3.227）：

- **`query()` 签名**（行 2664）：`query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query`。`prompt` 传 `AsyncGenerator<SDKUserMessage>` 即为**流式输入模式**（多轮持久会话）。
- **`Query` 接口**（行 2356）：`interface Query extends AsyncGenerator<SDKMessage, void>`。控制方法：
  - `interrupt(): Promise<SDKControlInterruptResponse | undefined>`（行 2370）——仅流式输入模式下可用；CLI 通告 `interrupt_receipt_v1` 能力（`SDKSystemMessage.capabilities`）时 resolve 为 `SDKControlInterruptResponse`（`{ still_queued: string[]; cancelled?: string[] }`），旧 CLI resolve 为 `undefined`。
  - `close(): void`（行 2661）——关闭 query 并终止底层 CLI 进程，清理所有资源。
  - `streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>`（行 2634）——多轮对话的补充输入流（可选，非必需）。
  - `supportedModels()`、`initializationResult()`、`supportedCommands()` 等（D9 控制 Query 用，本任务不涉及）。
- **`Options` 相关字段**（行 1346 起）：`cwd?`（行 1413，默认 `process.cwd()`）、`agent?`（行 1375）、`model?`（行 1737，如 `'claude-sonnet-5'`）、`includePartialMessages?`（行 1655，置 true 产出 `SDKPartialAssistantMessage`/`stream_event`）、`resume?: string`（行 1827）、`abortController?`（行 1351）、`allowedTools?`、`permissionMode?`、`maxTurns?` 等。

**`scripts/conversation.ts` 参考蓝本**（流式输入 + 流式输出，已验证可行）：
- 输入队列模式：`const pending: SDKUserMessage[]` + `wake` 回调；`enqueueUserMessage(text)` 向队列 push `{ type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null }` 并 `wake?.()`。
- 无限异步生成器 `chatStream(): AsyncGenerator<SDKUserMessage>`：`for(;;) { while(pending.length===0) await new Promise(res => wake=res); yield pending.shift()! }`——即「队列空则挂起等待，有消息才 yield」的 push/yield 语义。
- 后台消费：`for await (const message of q)` 遍历 `Query`（AsyncGenerator<SDKMessage>），按 `message.type` 分支：`system`(init) 捕获 `session_id`；`stream_event` 处理 token 增量；`assistant` 处理完整消息；`result` 处理回合结束。
- 结束：`q.close()` 关闭 query 终止 CLI 子进程。

### 3. SDKMessage 事件通道（原始通道由 session-01 提供，归一化归 event-01）

- `SDKMessage` 联合（行 4184）：约 50 种子类型。本任务相关子集：
  - **`SDKSystemMessage`**（行 4601）：`{ type:'system'; subtype:'init'; session_id; cwd; model; permissionMode; capabilities?; uuid; ... }`——首条 init 携带 `session_id`，**session.create() 由此捕获会话 ID 并 resolve**。
  - **`SDKSessionStateChangedMessage`**（行 4562）：`{ type:'system'; subtype:'session_state_changed'; state:'idle'|'running'|'requires_action'; uuid; session_id }`——**wait() 事件驱动的关键**（idle 信号）。
  - **`SDKResultMessage = SDKResultSuccess | SDKResultError`**（行 4470）：`type:'result'`；success（行 4472）含 `subtype:'success'`、`total_cost_usd`、`usage`、`modelUsage`；error（行 4440）含 `subtype:'error_during_execution'|'error_max_turns'|...`、`is_error:true`、`errors`。**回合结束信号**（wait() 也可据此判定）。
  - **`SDKPartialAssistantMessage`**（行 4321）：`{ type:'stream_event'; event: BetaRawMessageStreamEvent; parent_tool_use_id; uuid; session_id }`——`includePartialMessages:true` 时的 token 级增量（event-01 归一化为 `message.part.delta`）。
  - `SDKAssistantMessage`（行 3019）：完整助手消息，`message.content` 为内容块数组。
  - `SDKUserMessage`（行 4772）：`{ type:'user'; message: MessageParam; parent_tool_use_id: string|null; isSynthetic?; priority?; uuid?; session_id?; ... }`——prompt() 入队载荷。
- **事件通道语义**（event-streaming/spec.md + design.md D4）：会话事件通道为**回放型广播通道**——事件自会话创建起缓冲，晚订阅的消费者（先 create 再 events）同样收到 `session.created` 等已发生事件；会话 query() 完成（result 产出）后事件流正常终止。session-01 的 SessionState 只需暴露原始 `AsyncIterable<SDKMessage>` 通道，GlobalEvent 归一化由 event-01 的 events.ts 消费。

### 4. SessionManager 方法集约束（spec session-management + api.yaml paths + design.md D2/D5/D7）

- **`create`**（api.yaml `/client/session/create`）：后台启动 `query({ prompt: inputQueue, options: { includePartialMessages: true, cwd, agent, model } })`，消费首条 `system/init` 捕获 `session_id` 后 resolve `SessionV2Info`（**不阻塞等待后续消息**）；init 在合理超时内未到达则 reject 抛 `TimeoutError`。返回 `SessionV2Info`：`id`（= 捕获的 session_id，保留 Claude 原始 ID，见 D7）、`projectID`（cwd 编码生成）、`time{created,updated}`、`title`、`location.directory`（= 客户端 cwd）、`cost`、`tokens`；`agent` 透传。入参 `{ model?: ModelRef, agent?: string, location?: LocationRef }`。
- **`messages`**（api.yaml `/client/session/messages`）：包装 Claude SDK `getSessionMessages(sessionId, options?)`（行 759）。SDK 侧 `GetSessionMessagesOptions = { dir?; limit?; offset?; includeSystemMessages?; sessionStore? }`（行 764）；返回 `SessionMessage[]`，SDK 侧 `SessionMessage = { type:'user'|'assistant'|'system'; uuid; session_id; message: unknown; parent_tool_use_id: string|null; parent_agent_id: string|null }`（行 4916）。适配层映射为 `SessionMessagesResponse { data: SessionMessage[]; cursor: { previous?, next? } }`（分页游标由适配层生成，spec 场景要求 `limit`/`cursor.next` 可用于下一页）。
- **`prompt`**（api.yaml `/client/session/prompt`）：向该会话输入队列 push `SDKUserMessage`（`{ type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null }`），返回 `SessionInputAdmitted`（`id` 以 `msg_` 前缀生成、`delivery:'queue'`、`admittedSeq`、`timeCreated` date-time）；会话不存在抛 `SessionNotFoundError`。
- **`interrupt`**（api.yaml `/client/session/interrupt`）：调用该会话 `Query.interrupt()`；空闲会话为 no-op（不抛错）；会话不存在抛 `SessionNotFoundError`。前置条件：CLI 需通告 `interrupt_receipt_v1` 能力，无能力时降级为 `close()`（design.md 风险节）。
- **`wait`**（api.yaml `/client/session/wait`）：基于结果消息（`type:'result'`）与状态变更事件（`session_state_changed` state 变 idle）**事件驱动**等待空闲，避免高频轮询；支持 `timeout` 参数，超时 reject 抛 `TimeoutError`；会话不存在抛 `SessionNotFoundError`。
- **`close`**：关闭 `Query`（`q.close()`）并从 `Map<sessionId, SessionState>` 移除，事件通道结束（spec「Session state management」场景）。

### 5. 关键设计决策（design.md）

- **D2 一体化 query() 解耦**：`session.create()` 后台运行 `query({ prompt: inputQueue, options:{includePartialMessages:true} })`；`system/init → resolve SessionV2Info`；`stream_event/assistant/result → 推入 sessionEvents 通道`；`inputQueue` 由 `prompt()` 控制 yield。`SessionState { query, sessionId, inputQueue, eventsChannel }`。备选（每次 prompt 新建 query）被否决——会破坏会话连续性。
- **D5 暂停语义**：`interrupt` + `wait` 两方法；wait 用事件驱动（结果/状态变更）而非轮询。
- **D7 ID 生成与映射**：session_id 保留 Claude 原始值（UUID 形式，不做 `^ses` 转换，因需用于 resume/getSessionMessages）；message/part/event ID 在归一化时按 `^msg_`/`^prt`/`^evt_` 前缀生成。**prompt() 返回的 `id`（`^msg_` 前缀）由适配层在 session-01 生成**。
- **风险与权衡**：一体化解耦的状态管理复杂度 → `Map<sessionId, SessionState>` 集中管理、close() 清理；create() 首条消息前无法 resolve → Promise 在 init 到达时 resolve + 超时保护；wait() 轮询效率 → 结果/状态变更事件驱动 + 超时退出；interrupt() 依赖 CLI `interrupt_receipt_v1` 能力 → 无能力降级 close()。

### 6. 类型层现状（src/types.ts 已导出，session-01 直接复用）

- `SessionV2Info`：必填 `id/projectID/cost/tokens/time/title/location`；`cost: Cost`（`{total_cost_usd?, currency?}`）、`tokens: TokenUsage`（全可选）、`time: {created, updated, archived?}`（date-time 字符串）、`location: LocationRef`（`directory` 必填）、`agent?`、`model?`。
- `SessionMessagesResponse`：`{ data: SessionMessage[]; cursor: { previous?, next? } }`；`SessionMessage`：`id: MessageID (^msg_)`、`type: 'user'|'assistant'|'system'`、`time?`、`text?`、`content?`（assistant 内容块）、`finish?`、`cost?`、`tokens?`。
- `PromptInput`（`text` 必填）、`SessionInputAdmitted`（必填 `admittedSeq/id/sessionID/prompt/delivery/timeCreated`；`id: MessageID`、`delivery: 'steer'|'queue'`、`promotedSeq?`）。
- 错误：`SessionNotFoundError`（`_tag`/`sessionID`/`message`）、`TimeoutError`（`_tag`/`message`/`timeoutMs?`）、`InvalidRequestError`；`ClaudeSDKError` 判别联合（`_tag` 判别）。
- 注意：`SessionV2Info.id` 类型为 `string`（非 `^ses` 前缀约束，符合 D7）。

### 7. 测试约定（infra-01 types.test.ts 蓝本）

- `vitest`（`describe`/`it`/`expect`），`expectTypeOf` 做编译期断言、值构造做运行时断言。
- 断言风格示例：`expect(admitted.id).toMatch(/^msg_/)`、`expect(admitted.delivery).toBe('queue')`。session-01 的 `test/session.test.ts` 需覆盖 plan.json 的 acceptance_criteria 全部场景（create/messages/prompt/interrupt/wait/close、并发隔离、错误路径）。

### 8. 关键事实与约束汇总

- **query() 流式输入是唯一能维持多轮会话连续性的方式**（`prompt: AsyncIterable<SDKUserMessage>`），`scripts/conversation.ts` 已验证。
- **session.create() 的 resolve 时机**：`system/init`（`SDKSystemMessage`，`subtype:'init'`）首条消息的 `session_id`；带超时保护（`TimeoutError`）。
- **prompt() 入队载荷**：`{ type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null }`；返回 ID 以 `msg_` 前缀生成。
- **interrupt()**：`Query.interrupt()`，空闲 no-op，依赖 `interrupt_receipt_v1` 能力。
- **wait() 事件驱动**：基于 `result`（回合结束）与 `session_state_changed`（state='idle'）事件，支持 timeout，超时抛 `TimeoutError`。
- **messages()**：包装 `getSessionMessages`，SDK 侧 `SessionMessage`（`type/uuid/session_id/message/parent_tool_use_id/parent_agent_id`）需映射为 opencode `SessionMessage`（`id^msg_/type/text/content/finish/cost/tokens`），分页游标由适配层生成。
- **SessionState 四要素**：Query 句柄、流式输入队列（push/yield）、SDKMessage 事件通道（原始，回放型广播，event-01 归一化）、后台 query 泵。`Map<sessionId, SessionState>` 会话间状态隔离；close() 关闭 Query、事件通道结束并从 Map 移除。
