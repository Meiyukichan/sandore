# Codebase Exploration Result

> 探索任务：在 `packages/sdk/claude` 下编写 `@meiyukichan/claude-sdk` 适配器层 SDK，将 `docs/sdk/claude` 下的 Claude Code SDK 接口适配为 `docs/sdk/openapi.json` 接口协议。逐步适配范围：1.创建会话 2.会话消息/发送消息/暂停会话 3.获取模型 4.流式获取消息 5.事件系统(适配为 GlobalEvent)。
> 本文件仅记录项目当前状态与双方接口面，不含方案/建议。

## Exploration Result

### Phase 3: furina-codebase 探索结果

`docs/codebase`（furina.json 中 `project.codebase.path`）目录当前为**空目录**，无任何文件，无法从中获取代码库信息。本项目的 `packages/*` 全部为**空脚手架目录**（cli / client / daemon / server / sdk/claude / sdk/codex / sdk/gemini / sdk/opencode 均无任何文件），`docs/codebase` 亦为空。探索信息全部来自 Phase 4 补充探索。

## Supplementary Exploration Result

### 1. 项目当前状态

- 根目录：`D:\project-code\llm\sandore`，git 仓库（main 分支，仅 1 个 Initial commit）。
- `.gitignore` 忽略项含 `furina/`、`node_modules/` 等。
- `README.md` 仅 9 字节（占位）。
- 存在 `.claude/furina.json`（furina 工作流配置）与 `furina/changes.json`（已登记 change `claude-sdk-adapter`，path=`furina/changes/claude-sdk-adapter`，features=0、todo=0、artifacts 为空）。
- 输出目录 `furina/changes/claude-sdk-adapter/explore-design/` 已存在（空）。
- `packages/sdk/claude/` 为空目录 —— 目标 SDK 在此编写，当前无任何已有实现。

### 2. 目标接口协议：`docs/sdk/openapi.json`

- OpenAPI 3.1.0，title=opencode，version=1.0.0，无 servers 字段，共 **162 个路径**、**472 个 components.schemas**。
- 存在两代端点：老一代（tag `session`/`event`/`global` 等，无 `/api` 前缀）与新 v2 代（tag `sessions`/`messages`/`models`/`events` 等，`/api` 前缀，operationId 以 `v2.` 开头）。

#### 2.1 与 5 项适配范围直接相关的目标端点（v2 系）

| 适配项 | 端点 | operationId | 请求/响应要点 |
|---|---|---|---|
| 创建会话 | `POST /api/session` | `v2.session.create` | 请求体 `{id?(^ses), agent?, model?(ModelRef), location?(LocationRef)}`；200 返回 `{data: SessionV2Info}`；400/401 |
| 会话消息 | `GET /api/session/{sessionID}/message` | `v2.session.messages` | 查询参数 `limit?(number)`、`order?(asc\|desc)`、`cursor?(string, 不透明分页游标)`；200 返回 `SessionMessagesResponse{data: SessionMessage[], cursor:{previous?,next?}}`；400/401/404/500 |
| 会话消息 | `GET /api/session/{sessionID}/message/{messageID}` | `v2.session.message` | 单条消息 |
| 发送消息 | `POST /api/session/{sessionID}/prompt` | `v2.session.prompt` | 请求体 `{id?(^msg_), prompt: PromptInput, delivery?(steer\|queue), resume?(boolean)}`；200 返回 `{data: SessionInputAdmitted}`；400/401/404/409 |
| 暂停会话 | `POST /api/session/{sessionID}/interrupt` | `v2.session.interrupt` | 无请求体；400/401/404（无 200 描述） |
| 会话等待 | `POST /api/session/{sessionID}/wait` | `v2.session.wait` | 无请求体；400/401/404/503 |
| 获取模型 | `GET /api/model` | `v2.model.list` | 查询参数 `location?{directory?,workspace?}`；200 返回 `{location: LocationInfo, data: ModelV2Info[]}`；400/401/503 |
| 流式消息 | `GET /api/session/{sessionID}/event` | `v2.session.events` | 查询参数 `after?(string)`；200 `text/event-stream`，SSE data 为 `SessionDurableEventStream`（contentSchema=`SessionDurableEvent`） |
| 事件系统 | `GET /api/event` | `v2.event.subscribe` | 200 `text/event-stream`，SSE data 为 `V2Event`（事件联合） |
| 会话列表/活动 | `GET /api/session` / `GET /api/session/active` | `v2.session.list` / `v2.session.active` | active 返回 `{data: {^ses: SessionActive}}`，SessionActive={type:"running"} |

#### 2.2 老一代（legacy）相关端点

| 端点 | operationId | 要点 |
|---|---|---|
| `POST /session` | `session.create` | 查询参数 `directory?`、`workspace?`；请求体 `{parentID?(^ses), title?, agent?, model?, metadata?, permission?(PermissionRuleset), workspaceID?(^wrk)}`；200 返回 `Session` |
| `GET /global/event` | `global.event` | 200 `text/event-stream`，SSE data 为 **`GlobalEvent`**（含 `directory/project/workspace/payload` 包装） |
| `GET /event` | `event.subscribe` | 200 `text/event-stream`，SSE data 为 `Event`（legacy 事件联合） |

#### 2.3 关键目标 Schema

- **`SessionV2Info`**（创建会话返回）：`{id(^ses), parentID?, projectID, agent?, model?(ModelRef), cost, tokens{input,output,reasoning,cache{read,write}}, time{created,updated,archived?}, title, location(LocationRef), subpath?, revert?(RevertState)}`；required=[id,projectID,cost,tokens,time,title,location]。
- **`ModelRef`**：`{id, providerID, variant?}`（required=[id,providerID]）。
- **`LocationRef`**：`{directory, workspaceID?(^wrk)}`（required=[directory]）。
- **`LocationInfo`**：`{directory, workspaceID?, project{id,directory}}`（required=[directory,project]）。
- **`PromptInput`**：`{text, files?(PromptInputFileAttachment[]), agents?(PromptAgentAttachment[])}`（required=[text]）；`PromptInputFileAttachment`={uri(required),name?,description?,source?(PromptSource)}；`PromptAgentAttachment`={name(required),source?}。
- **`Prompt`**（事件/响应里的 prompt）：`{text, files?(PromptFileAttachment[]), agents?(PromptAgentAttachment[])}`（required=[text]）。
- **`SessionInputAdmitted`**（发送消息响应 data）：`{admittedSeq(integer≥0), id(^msg_), sessionID(^ses), prompt(Prompt), delivery(steer|queue), timeCreated, promotedSeq?(integer≥0)}`；required=[admittedSeq,id,sessionID,prompt,delivery,timeCreated]。
- **`SessionMessagesResponse`**：`{data: SessionMessage[], cursor:{previous?,next?}}`（两者均 required）。
- **`SessionMessage`**：`anyOf` = SessionMessageAgentSwitched / ModelSwitched / **User** / Synthetic / System / Shell / **Assistant** / Compaction。
- **`Message`**：`anyOf` = UserMessage | AssistantMessage。
- **`ModelV2Info`**（`GET /api/model` 的 data 项）：`{id, providerID, family?, name, api(ModelApi), capabilities(ModelCapabilities), request{headers,body,variant?}, variants[], time{released}, cost(ModelCost[]), status(alpha|beta|deprecated|active), enabled, limit{context,output,input?}}`；required 见 schema。
- **`SessionActive`**：`{type:"running"}`。
- **错误类型**：`InvalidRequestError`、`UnauthorizedError`、`SessionNotFoundError`、`ConflictError`、`InvalidCursorError`、`UnknownError1`、`ServiceUnavailableError` 等。

#### 2.4 事件系统 Schema

- **`SessionDurableEvent`**：`oneOf` = 29 个 `SessionNext*` 事件（session.next.agent.switched / model.switched / moved / prompted / prompt.admitted / context.updated / synthetic / shell.started / shell.ended / step.started / step.ended / step.failed / text.started / text.ended / tool.input.started / tool.input.ended / tool.called / tool.progress / tool.success / tool.failed / reasoning.started / reasoning.ended / retried / compaction.started / compaction.ended / revert.staged / revert.cleared / revert.committed，外加 SessionNextTextDelta、SessionNextToolInputDelta、SessionNextReasoningDelta、SessionNextCompactionDelta 的 delta 变体）。
- **会话事件统一形状**（如 `SessionNextTextDelta`）：`{id(^evt_), metadata?, type(枚举), durable?{aggregateID,seq,version}, location?(LocationRef), data{timestamp, sessionID, ...}}`；required=[id,type,data]。data 字段按事件类型不同（如 text.delta 有 `assistantMessageID, textID, delta`；step.ended 有 `assistantMessageID, finish, cost, tokens, snapshot?, files?`；tool.called 有 `assistantMessageID, callID, tool, input, provider{executed,metadata?}`）。
- **`V2Event`**：`anyOf` 约 90+ 事件 schema，含 `Event*`（session.created/updated/deleted、message.updated/removed、message.part.updated/removed、`SessionNext*`、message.part.delta、session.diff、session.error、permission.v2.*、question.v2.*、todo.updated、pty.*、file.edited、session.status、session.idle 等）与 `Models-devRefreshed`、`IntegrationUpdated`、`CatalogUpdated` 等。
- **`GlobalEvent`**（`GET /global/event` 的 SSE data，用户指定的事件系统适配目标）：包装结构 `{directory?, project?, workspace?, payload}`，其中 `payload` 为 **anyOf 共 124 个变体**：约 88 个内联 `{id(^evt_), type(枚举), properties}` 事件（如 models-dev.refreshed、integration.updated、catalog.updated、session.created/updated/deleted、message.updated/removed、message.part.*、session.next.*、message.part.delta、session.diff、session.error、installation.*、file.edited、permission.v2.*、question.v2.*、todo.updated、permission.asked/replied、tui.*、mcp.tools.changed、command.executed、session.status、session.idle、session.compacted、vcs.branch.updated、workspace.*、worktree.*、server.connected、global.disposed 等）+ 约 36 个 `$ref` 变体（`EventServerInstanceDisposed`、`SyncEventSession*`、`SyncEventMessage*`、`SyncEventSessionNext*` 系列）。
  - 内联事件 payload 的 `properties` 各不相同，例如：`session.created` properties=`{sessionID(^ses), info(Session)}`；`message.updated` properties=`{sessionID, info(Message)}`；`message.removed` properties=`{sessionID, messageID(^msg)}`；`session.next.text.delta` properties=`{timestamp, sessionID, assistantMessageID, textID, delta}`；`session.idle` properties=`{sessionID}`；`session.status` properties=`{sessionID, status(SessionStatus)}`。
- **`V2EventStream`**：`{type:"string", contentSchema: V2Event, contentMediaType:"application/json"}`（SSE data 承载方式）。

### 3. Claude Code SDK 接口（源接口，`docs/sdk/claude` + 已安装依赖）

- 已安装依赖：`scripts/node_modules/@anthropic-ai/claude-agent-sdk` **v0.3.227**（ESM，类型定义 `sdk.d.ts` 共 7457 行，另含 `browser-sdk.d.ts`、`sdk-tools.d.ts` 3866 行、`bridge`、`extract` 子路径导出）。
- `scripts/package.json`：name=`claude-session-chat`、private、**type=module**；脚本 `chat`=`tsx conversation.ts`；依赖 `@anthropic-ai/claude-agent-sdk@latest`；devDeps `@types/node@^26.2.0`、`tsx@^4.19.0`、`typescript@^5.5.0`。`scripts/tsconfig.json`：target=ES2022、module=ESNext、moduleResolution=bundler、strict、noEmit、types=[node]。
- 主要入口：`query()` 函数（`query({prompt: string | AsyncIterable<SDKUserMessage>, options?: Options}): Query`）。`Query extends AsyncGenerator<SDKMessage, void>`。

#### 3.1 `Query` 对象（与 5 项适配相关的控制方法）

- **`interrupt(): Promise<SDKControlInterruptResponse | undefined>`** —— 中断当前 query 执行（对应「暂停会话」概念；SDKControlInterruptResponse=`{still_queued: string[], cancelled?: string[]}`，需 CLI 通告 `interrupt_receipt_v1` / `interrupt_cancel_queued_v1` 能力）。
- **`setModel(model?: string): Promise<void>`** —— 切换会话模型（仅流式输入模式）。
- **`supportedModels(): Promise<ModelInfo[]>`** —— 获取可用模型（对应「获取模型」；`ModelInfo={value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode?}`）。
- **`initializationResult(): Promise<SDKControlInitializeResponse>`** —— 初始化结果，`SDKControlInitializeResponse={commands, agents, output_style, available_output_styles, models: ModelInfo[], account, fast_mode_state?}`。
- **`supportedAgents() / supportedCommands() / accountInfo()`** 等其它控制方法。
- **`streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>`** —— 多轮流式输入。
- **`close(): void`** —— 关闭 query 并终止底层 CLI 进程。

#### 3.2 `SDKMessage` 联合（query 迭代产出）

`SDKMessage` = `SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | SDKAPIRetryMessage | SDKControlRequestProgressMessage | SDKModelRefusalFallbackMessage | SDKModelRefusalNoFallbackMessage | SDKLocalCommandOutputMessage | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage | SDKPluginInstallMessage | SDKToolProgressMessage | SDKAuthStatusMessage | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskUpdatedMessage | SDKTaskProgressMessage | SDKBackgroundTasksChangedMessage | SDKThinkingTokensMessage | SDKSessionStateChangedMessage | SDKWorkerShuttingDownMessage | SDKCommandsChangedMessage | SDKNotificationMessage | SDKFilesPersistedEvent | SDKToolUseSummaryMessage | SDKMemoryRecallMessage | SDKRateLimitEvent | SDKElicitationCompleteMessage | SDKPermissionDeniedMessage | SDKPromptSuggestionMessage | SDKMirrorErrorMessage | SDKInformationalMessage | SDKConversationResetMessage`（共 37 种）。

关键成员：
- **`SDKSystemMessage`**：`{type:"system", subtype:"init", uuid, session_id, agents?, apiKeySource, betas?, claude_code_version, cwd, tools, mcp_servers[], model, permissionMode, slash_commands, output_style, skills, plugins[], capabilities?}` —— 会话创建时最先产出，`session_id` 即会话 ID；`capabilities` 含 `interrupt_receipt_v1` 等。
- **`SDKAssistantMessage`**：`{type:"assistant", message: BetaMessage, parent_tool_use_id, error?(SDKAssistantMessageError), uuid, session_id, request_id?, aborted?, ...}`。`BetaMessage` 含 `id/content/model/stop_reason/usage`。
- **`SDKUserMessage`**：`{type:"user", message: MessageParam, parent_tool_use_id, isSynthetic?, shouldQuery?, tool_use_result?, priority?, origin?, uuid?, session_id?, ...}` —— 发送消息时 yield 给 query。
- **`SDKResultMessage`** = 成功分支 `{type:"result", subtype:"success", duration_ms, duration_api_ms, ttft_ms?, total_cost_usd, usage, modelUsage, permission_denials, structured_output?, terminal_reason?, uuid, session_id, ...}` | 错误分支 `{type:"result", subtype:"error_max_turns"|"error_during_execution"|"error_max_budget_usd"|"error_max_structured_output_retries", errors[], ...}`。
- **`SDKPartialAssistantMessage`**：`{type:"stream_event", event: BetaRawMessageStreamEvent, parent_tool_use_id:null, uuid, session_id, ttft_ms?}` —— 流式消息载体；`event` 为 Anthropic 原始流事件（message_start / content_block_start / content_block_delta[text_delta|input_json_delta] / content_block_stop / message_delta / message_stop）。
- 其它：`SDKSessionStateChangedMessage`（state=idle|running|requires_action）、`SDKCompactBoundaryMessage`（compact_boundary）、`SDKPermissionDeniedMessage`、`SDKTask*`、`SDKHook*` 等。

#### 3.3 会话管理函数（TypeScript 导出）

- **`listSessions(options?{dir?,limit?,includeWorktrees?}): Promise<SDKSessionInfo[]>`**；`SDKSessionInfo={sessionId, summary, lastModified, fileSize?, customTitle?, firstPrompt?, gitBranch?, cwd?, tag?, createdAt?}`。
- **`getSessionInfo(sessionId, options?{dir?}): Promise<SDKSessionInfo | undefined>`**。
- **`getSessionMessages(sessionId, options?{dir?, limit?, offset?, includeSystemMessages?, sessionStore?}): Promise<SessionMessage[]>`**；`SessionMessage={type:"user"|"assistant"|"system", uuid, session_id, message: unknown, parent_tool_use_id, parent_agent_id}`。
- **`getSubagentMessages`**、`renameSession`、`tagSession`、`deleteSession`、`forkSession`、`importSessionToStore`、`createSdkMcpServer`、`startup(): Promise<WarmQuery>`、`tool()`、`resolveSettings` 等（均带 `_` 前缀参数名表示未使用）。

#### 3.4 `Options`（query 选项）中与会话/流式相关字段

`Options` 含：`abortController?`、`additionalDirectories?`、`agent?`、`agents?`、`allowedTools?`、`canUseTool?`、`continue?`、`cwd?`、`disallowedTools?`、`includePartialMessages?`（=true 时产出 `stream_event`，实现流式获取）、`includeHookEvents?`、`maxTurns?`、`model?`、`permissionMode?`（default|acceptEdits|plan|dontAsk|auto|bypassPermissions）、`allowDangerouslySkipPermissions?`、`persistSession?`（默认 true）、`resume?`、`sessionId?`、`forkSession?`、`resumeSessionAt?`、`thinking?`、`effort?`、`maxThinkingTokens?`、`systemPrompt?`、`mcpServers?`、`hooks?`、`plugins?`、`settingSources?`、`sessionStore?`、`pathToClaudeCodeExecutable?`、`permissionPromptToolName?`、`outputFormat?` 等。

### 4. 示例脚本：`scripts/conversation.ts`（6395 行，实为 164 行）

- 基于 `@anthropic-ai/claude-agent-sdk` 的交互式会话脚本，演示：
  1. **创建会话**：`query({ prompt: chatStream(), options: { cwd, resume: resumeSessionId?, includePartialMessages: true, maxTurns: 20, allowedTools: [...] } })`；从 `system`/`init` 消息取 `message.session_id`。
  2. **发送消息**：异步生成器 `chatStream()` 无限 yield `SDKUserMessage`（`{type:"user", message:{role:"user", content}, parent_tool_use_id:null}`）—— 流式输入模式。
  3. **流式获取**：`includePartialMessages:true` 后消费 `stream_event`（`event.type==="message_start"|"content_block_start"|"content_block_delta"|"content_block_stop"`），`text_delta` 逐 token 打印、`input_json_delta` 打印工具入参增量；`assistant` 处理完整 tool_use；`result` 打印 subtype/duration/total_cost_usd。
  4. 结束：`q.close()` 关闭查询并终止底层 CLI 进程。
- 命令：`cd scripts && npm run chat [-- 首条消息] [-- --resume <sessionId>]`。

### 5. 官方文档（`docs/sdk/claude/*.md`，中文）

- 共 25 篇，覆盖 overview、quickstart、typescript-sdk-api、sessions、streaming-output、streaming-vs-single-mode、structured-outputs、user-input、agent-loop、hooks、permissions、subagents、mcp、skills、slash-commands、plugins、hosting、cost-tracking、session-storage、todo-tracking、file-checkpointing、modifying-system-prompts、claude-code-features、custom-tools、tool-search。
- 关键内容与 `sdk.d.ts` v0.3.227 一致：`query()`、`Query` 对象方法表、`SDKMessage`/`SDKAssistantMessage`/`SDKUserMessage`/`SDKResultMessage`/`SDKSystemMessage`/`SDKPartialAssistantMessage`/`SDKCompactBoundaryMessage` 等结构、`ModelInfo`/`AgentInfo`/`McpServerStatus`、`listSessions`/`getSessionMessages`/`getSessionInfo`、流式模式（`includePartialMessages` + `stream_event` 事件流顺序 message_start → content_block_start → delta → stop → message_delta → message_stop → AssistantMessage → ResultMessage）、流式输入模式（AsyncGenerator 多轮持久会话 + `interrupt()` 中断）。
- `typescript-sdk-api.md` 明确注记：实验性 V2 会话 API（`createSession()` / send / stream 模式）已在 0.3.142 移除，应使用 `query()` 与会话选项（`continue`/`resume`/`fork`）。

### 6. 双方接口面事实对照（仅记录，非方案）

| 适配项 | Claude Code SDK 侧（源） | openapi.json 侧（目标） |
|---|---|---|
| 创建会话 | `query({prompt, options})` 迭代首条 `SDKSystemMessage`(subtype=init) 取 `session_id`；或 `listSessions/getSessionInfo` 查询已存在会话 | `POST /api/session`（v2.session.create）→ `{data: SessionV2Info}`；legacy `POST /session`（session.create）→ `Session` |
| 会话消息 | `getSessionMessages(sessionId, {limit, offset})` → `SessionMessage[]`（type=user/assistant/system） | `GET /api/session/{sessionID}/message`（v2.session.messages）→ `SessionMessagesResponse`（cursor 分页）；`GET .../message/{messageID}` 单条 |
| 发送消息 | 流式输入模式 `AsyncGenerator<SDKUserMessage>` yield `{type:"user", message, parent_tool_use_id}`；或单消息 `prompt: string` | `POST /api/session/{sessionID}/prompt`（v2.session.prompt）→ `{data: SessionInputAdmitted}`（prompt 结构 text/files/agents，delivery=steer/queue） |
| 暂停会话 | `Query.interrupt()` → `SDKControlInterruptResponse{still_queued, cancelled?}`（需 CLI capability `interrupt_receipt_v1`） | `POST /api/session/{sessionID}/interrupt`（v2.session.interrupt）；关联 `POST .../wait`（v2.session.wait） |
| 获取模型 | `Query.supportedModels()` → `ModelInfo[]`（value/displayName/description/…）；`initializationResult()` 内含 models | `GET /api/model`（v2.model.list）→ `{location: LocationInfo, data: ModelV2Info[]}`（id/providerID/name/api/capabilities/…） |
| 流式获取消息 | `options.includePartialMessages:true` → 迭代 `SDKPartialAssistantMessage`(type=stream_event, event=BetaRawMessageStreamEvent) | `GET /api/session/{sessionID}/event`（v2.session.events）→ SSE `SessionDurableEvent`（session.next.* 系列，含 text.delta / tool.input.delta 等增量事件） |
| 事件系统 | `SDKMessage` 流（system/assistant/result/stream_event/...）+ `SDKSessionStateChangedMessage`(idle/running/requires_action) + 各类 `system` subtype 事件 | `GET /global/event` → SSE `GlobalEvent`（payload 为 124 变体，`{id:^evt_, type, properties}`，含 session.created/updated/deleted、message.*、session.next.*、session.status、session.idle 等）；`GET /api/event`（v2.event.subscribe）→ SSE `V2Event` |

### 7. 关键事实与约束

- `packages/sdk/claude` 目前为空，无既有代码可参考；`docs/codebase` 为空，无项目自有代码库。
- 目标协议 openapi.json 中，创建会话/发送消息/获取模型/暂停（interrupt）均为 `POST/GET` JSON 接口；流式获取消息与事件系统均为 **SSE（text/event-stream）** 接口（`/api/session/{sessionID}/event`、`/api/event`、`/global/event`）。
- 目标侧 ID 前缀约束：session=`^ses`、message=`^msg_`、event=`^evt_`、workspace=`^wrk`。
- Claude Code SDK（源）侧为「本地进程 + CLI 子进程」模式（`query()` 内部 spawn 本地 Claude Code 二进制，会话持久化到 `~/.claude/projects/<encoded-cwd>/*.jsonl`），与 openapi.json（目标）的 HTTP/SSE 服务模式存在**传输模型差异**，适配层需承载该差异（本文件仅记录事实）。
- 示例脚本 `scripts/conversation.ts` 依赖 `@anthropic-ai/claude-agent-sdk` 已安装于 `scripts/node_modules`，可直接作为对话示例的参考基线；其 ESM/tsx 运行方式（`type:module`、`moduleResolution:bundler`）即为适配层 SDK 的既定技术栈（TypeScript + pnpm + ESM module）。
