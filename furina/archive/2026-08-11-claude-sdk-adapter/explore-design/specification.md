# 规范材料探索：@meiyukichan/claude-sdk 适配器层 SDK

> 探索类型：specification
> 探索日期：2026-08-11
> 项目路径：`D:\project-code\llm\sandore`

## 一、需求理解（Phase 2）

### What
在 `packages/sdk/claude` 下编写 TypeScript 适配器层 SDK（包名 `@meiyukichan/claude-sdk`），把 `@anthropic-ai/claude-agent-sdk`（Claude Code Agent SDK）的接口适配为 `docs/sdk/openapi.json`（OpenAPI 3.1.0 "opencode" 协议）接口。分阶段逐步适配：

1. 创建会话
2. 会话消息 / 发送消息 / 暂停会话
3. 获取模型
4. 流式获取消息
5. 事件系统（适配为 `GlobalEvent`）

技术栈：TypeScript + pnpm + ESM（`"type": "module"`）；`scripts/conversation.ts` 作为对话示例。

### Boundaries
- **源接口**：`docs/sdk/claude/*.md`（Claude Agent SDK 中文文档，25 篇）+ 已安装类型定义 `scripts/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（7457 行）
- **目标协议**：`docs/sdk/openapi.json`（162 个 path、472 个 schema，全部为 opencode 服务端接口）
- **输出位置**：`packages/sdk/claude`（当前为空目录）；示例 `scripts/conversation.ts`
- **当前工程状态**：monorepo 脚手架，仅 1 次 git 提交；`packages/` 下 `cli/client/daemon/server/sdk/claude/sdk/codex/sdk/gemini/sdk/opencode` 均为空目录

### Goal
为适配器 SDK 的设计与实现提供接口映射依据：明确 Claude SDK 每个相关接口 → openapi.json 协议中对应端点与数据模型，以及两者事件系统的对应关系。

## 二、工程现状（与 exploreContent 相关）

- **根目录**：无根 `package.json`、无 `pnpm-workspace.yaml`（pnpm 工作区尚未建立）。
- **`scripts/package.json`**（已有）：
  ```json
  {
    "name": "claude-session-chat",
    "private": true,
    "type": "module",
    "scripts": { "chat": "tsx conversation.ts" },
    "dependencies": { "@anthropic-ai/claude-agent-sdk": "latest" },
    "devDependencies": { "@types/node": "^26.2.0", "tsx": "^4.19.0", "typescript": "^5.5.0" }
  }
  ```
- **`scripts/conversation.ts`**：已存在，基于 `@anthropic-ai/claude-agent-sdk`，演示 `query()` 流式输入模式 + `includePartialMessages` 流式事件消费（system/init 取 session_id、stream_event 逐 token 打印、result 收尾）。
- **`docs/codebase/`**：空目录；**`furina/`** 下仅有 `changes.json`（已登记 `claude-sdk-adapter` 变更）；**`.gitignore`** 忽略 `furina/`、`node_modules/`、`dist/` 等。
- **`.claude/furina.json`**：`exploration.specification` 为空数组（无预置规范材料，本次按 exploreContent 直接探索上述源/目标材料）。

## 三、源接口：Claude Agent SDK（TypeScript）

### 3.1 核心函数（`sdk.d.ts` 实义签名）
| 函数 | 签名 | 说明 |
|---|---|---|
| `query` | `query({ prompt: string \| AsyncIterable<SDKUserMessage>; options?: Options }): Query` | 主要入口，返回 `AsyncGenerator<SDKMessage, void>` |
| `startup` | `startup({ options?, initializeTimeoutMs? }): Promise<WarmQuery>` | 预热 CLI 子进程；`WarmQuery.query()` 再派发 |
| `listSessions` | `listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>` | 枚举历史会话 |
| `getSessionMessages` | `getSessionMessages(sessionId, options?): Promise<SessionMessage[]>` | 读取会话消息 |
| `getSessionInfo` | `getSessionInfo(sessionId, options?): Promise<SDKSessionInfo \| undefined>` | 单会话元数据 |

### 3.2 `Query` 对象（控制方法，流式输入模式可用）
`interrupt(): Promise<SDKControlInterruptResponse \| undefined>`、`setModel(model?): Promise<void>`、`setPermissionMode(mode)`、`streamInput(stream)`、`close(): void`、`supportedModels(): Promise<ModelInfo[]>`、`supportedCommands()`、`supportedAgents()`、`accountInfo()`、`initializationResult(): Promise<SDKControlInitializeResponse>`（含 `models: ModelInfo[]`）、`mcpServerStatus()`、`setMcpServers()`、`stopTask()`、`backgroundTasks()`、`rewindFiles()`、`applyFlagSettings()` 等。

### 3.3 SDK 消息类型（`SDKMessage` 联合，与事件系统适配直接相关）
- `SDKSystemMessage`：`{ type: 'system', subtype: 'init', uuid, session_id, claude_code_version, cwd, tools[], mcp_servers[], model, permissionMode, slash_commands[], skills[], plugins[], capabilities? }` — **会话创建成功后首个消息，`session_id` 在此获取**。
- `SDKAssistantMessage`：`{ type: 'assistant', message: BetaMessage, parent_tool_use_id, uuid, session_id, error?, aborted? }`。
- `SDKUserMessage`：`{ type: 'user', message: MessageParam, parent_tool_use_id, uuid?, session_id?, isSynthetic?, shouldQuery? }` — 流式输入模式下 yield 给会话。
- `SDKPartialAssistantMessage`：`{ type: 'stream_event', event: BetaRawMessageStreamEvent, parent_tool_use_id: null, uuid, session_id, ttft_ms? }` — 流式消息基础。`event.type`：`message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop`；`content_block_delta` 内 `delta.type` 分 `text_delta`（文本增量）、`input_json_delta`（工具入参增量）。
- `SDKResultMessage` = `SDKResultSuccess | SDKResultError`：`{ type: 'result', subtype: 'success'\|'error_max_turns'\|..., result, session_id, duration_ms, total_cost_usd, usage, modelUsage, permission_denials, stop_reason, terminal_reason?, structured_output? }` — 回合结束标志。
- 其他 `type: 'system'` 子类型（事件系统适配候选）：`status`、`task_started`、`task_progress`、`task_notification`、`task_updated`、`permission_denied`、`session_state_changed`（idle/running/requires_action）、`compact_boundary`、`informational`、`commands_changed`、`plugin_install`、`background_tasks_changed` 等。
- `SessionMessage`（历史消息）：`{ type: 'user'\|'assistant'\|'system', uuid, session_id, message: unknown, parent_tool_use_id, parent_agent_id }`。

### 3.4 模型与设置
- `ModelInfo`：`{ value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode? }`。
- `SDKControlInitializeResponse`：`{ commands, agents, output_style, available_output_styles, models: ModelInfo[], account, fast_mode_state? }`。

### 3.5 会话管理（文档 `sessions.md`）
- 多轮：`query({ continue: true })` 自动续最近会话；`query({ resume: sessionId })` 按 ID 恢复；`query({ resume, forkSession: true })` 分叉。
- session_id 捕获：TypeScript 从 `system/init` 消息的 `session_id` 字段或每个 `result` 的 `session_id` 字段读取。
- 存储：`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`。
- **暂停/中断**：流式输入模式下 `q.interrupt()`；强制终止 `q.close()`。

## 四、目标协议：`docs/sdk/openapi.json`（opencode）

OpenAPI 3.1.0，title "opencode"，无 servers 定义；162 个 path、472 个 schema。存在 v1（`/session/*`，tag `session`）与 V2（`/api/session/*`，tag `sessions`）两套表面。

### 4.1 创建会话
- **`POST /session`**（v1）：body `{ parentID?(\^ses), title?, agent?, model?: { id, providerID, variant? }, metadata?, permission?: PermissionRuleset, workspaceID?(\^wrk) }` → `200 Session`。
- **`POST /api/session`**（V2）：body `{ id?(\^ses), agent?, model?: ModelRef, location?: LocationRef }` → `200 { data: SessionV2Info }`。
- `Session`（v1 核心字段）：`id(\^ses), slug, projectID, workspaceID, directory, path, parentID, summary{additions,deletions,files,diffs}, cost, tokens{input,output,reasoning,cache{read,write}}, title, agent, model{id,providerID,variant}, version, time{created,updated,compacting,archived}, permission, revert`。
- `SessionV2Info`：`id, parentID, projectID, agent, model: ModelRef, cost, tokens, time{created,updated,archived}, title, location: LocationRef, subpath, revert`。
- `ModelRef`：`{ id, providerID, variant? }`；`LocationRef`：`{ directory(必填), workspaceID?(\^wrk) }`。

### 4.2 会话消息 / 发送消息 / 暂停
- **获取消息**：
  - `GET /session/{sessionID}/message`（v1，query：directory/workspace/limit/before）→ `[{ info: Message, parts: Part[] }]`。
  - `GET /api/session/{sessionID}/message`（V2）→ `SessionMessagesResponse { data: SessionMessage[], cursor: {previous,next} }`。
- **发送消息**：
  - `POST /session/{sessionID}/message`（v1）：body `{ messageID?(\^msg), model?: {providerID,modelID}, agent?, noReply?, tools?: Record<string,boolean>, format?: OutputFormat, system?, variant?, parts: (TextPartInput|FilePartInput|AgentPartInput|SubtaskPartInput)[] }`（`parts` 必填）→ `200 { info: AssistantMessage, parts: Part[] }`。
  - `POST /session/{sessionID}/prompt_async`（异步）：同 body → `204`。
  - V2 侧发送端点未在 `/api/session/{sessionID}` 下直接提供 POST message（v1 的 `/session/{sessionID}/message` 是发送消息主端点）。
- **暂停 / 中断**：
  - `POST /session/{sessionID}/abort`（v1，"Abort an active session"）→ `200 boolean`。
  - `POST /api/session/{sessionID}/interrupt`（V2，"Interrupt active execution owned by this OpenCode process. Idle interruption is a no-op"）→ `204`。
  - `POST /api/session/{sessionID}/wait`（V2，"Wait for a session agent loop to become idle"）→ `204`。
  - 无显式 `pause` 端点；"暂停"最接近的语义为 abort / interrupt。
- 数据模型：`Message` = `UserMessage | AssistantMessage`；`Part` = `TextPart | SubtaskPart | ReasoningPart | FilePart | ToolPart | StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart | RetryPart | CompactionPart`；`TextPartInput` = `{ id?(\^prt), type: 'text', text, synthetic?, ignored?, time?, metadata? }`。

### 4.3 获取模型
- **`GET /api/model?location={directory,workspace}`**（V2）→ `200 { location: LocationInfo, data: ModelV2Info[] }`。
- `GET /api/provider` → `{ location, data: ProviderV2Info[] }`（provider 层）。
- `ModelV2Info`：`{ id, providerID, family, name, api: ModelApi, capabilities: ModelCapabilities, request{headers,body,variant}, variants[], time{released}, cost[], status('alpha'|'beta'|'deprecated'|'active'), enabled, limit{context,input,output} }`。
- `ModelApi`：`aisdk | native` 两种形态；`ModelCapabilities`：`{ tools, input[], output[] }`。

### 4.4 流式获取消息 / 事件流端点
- **`GET /api/session/{sessionID}/event?after=`**（V2）→ SSE，`SessionDurableEventStream`（`contentSchema: SessionDurableEvent`，application/json）。
- **`GET /global/event`** → SSE，`GlobalEvent`（全局事件流；无参数）。
- `GET /event`（v1，query directory/workspace）→ SSE 事件流；`GET /api/event` → SSE `V2EventStream`。
- `SessionDurableEvent`（oneOf 29 种）：统一形态 `{ id(\^evt_), metadata, type, durable: { aggregateID, seq, version }, location: LocationRef, data }`。
- `V2Event`（anyOf 约 70 种）：同时包含 `Session*`（durable 形态、`data` 字段）与 `Event*`（properties 形态）两类变体。

### 4.5 事件系统 `GlobalEvent`（适配目标）
- 信封结构：
  ```json
  { "directory"?: string, "project"?: string, "workspace"?: string,
    "payload": { "id": "^evt_", "type": "<事件类型>", "properties": { ... } } }
  ```
- payload 为 `anyOf` 124 个变体、88 种事件类型字符串（去重后），覆盖范围：
  - 会话级：`session.created/updated/deleted`（properties 含 `sessionID` + `info: Session`）、`session.status`、`session.idle`、`session.diff`、`session.error`、`session.compacted`。
  - 消息级：`message.updated`（`sessionID`+`info: Message`）、`message.removed`、`message.part.updated`、`message.part.removed`、`message.part.delta`（`sessionID/messageID/partID/field/delta`）。
  - 流式会话过程（session.next 系列）：`session.next.agent.switched`、`session.next.model.switched`、`session.next.prompted`（含 `messageID/prompt/delivery`）、`session.next.prompt.admitted`、`session.next.step.started/ended/failed`、`session.next.text.started/delta/ended`、`session.next.reasoning.started/delta/ended`、`session.next.tool.input.started/delta/ended`、`session.next.tool.called/progress/success/failed`、`session.next.retried`、`session.next.compaction.started/delta/ended`、`session.next.revert.staged/cleared/committed`。
  - 其它：`models-dev.refreshed`、`integration.updated`、`catalog.updated`、`installation.*`、`file.edited`、`permission.*`、`question.*`、`todo.updated`、`lsp.updated`、`pty.*`、`tui.*`、`mcp.*`、`command.executed`、`vcs.*`、`workspace.*`、`worktree.*`、`server.connected`、`global.disposed` 等。
- 流式文本增量示例（双形态）：
  - `EventSessionNextTextDelta`（properties 形态）：`{ id, type: 'session.next.text.delta', properties: { timestamp, sessionID, assistantMessageID(\^msg_), textID, delta } }`。
  - `SessionNextTextDelta`（durable 形态）：`{ id, metadata, type, durable{aggregateID,seq,version}, location, data: { timestamp, sessionID, assistantMessageID, textID, delta } }`。

## 五、适配映射关系（Claude SDK → openapi.json）

| 阶段 | Claude SDK 源接口 | openapi.json 目标端点/模型 |
|---|---|---|
| 1. 创建会话 | `query()`（流式输入模式）+ `SDKSystemMessage`(subtype=init) 的 `session_id` | `POST /session`（v1，返回 `Session`）或 `POST /api/session`（V2，返回 `{data: SessionV2Info}`） |
| 2. 会话消息 | `getSessionMessages(sessionId)` → `SessionMessage[]`；`query({resume})` 继续会话 | `GET /session/{sessionID}/message`（v1，`{info,parts}[]`）或 `GET /api/session/{sessionID}/message`（V2，`{data,cursor}`） |
| 2. 发送消息 | `q.streamInput()` / `query({prompt: AsyncIterable<SDKUserMessage>})` | `POST /session/{sessionID}/message`（body 含 `parts`）或 `POST /session/{sessionID}/prompt_async` |
| 2. 暂停会话 | `q.interrupt()`、`q.close()` | `POST /session/{sessionID}/abort`（v1）、`POST /api/session/{sessionID}/interrupt`（V2）、`POST /api/session/{sessionID}/wait` |
| 3. 获取模型 | `q.supportedModels()` → `ModelInfo[]`；`initializationResult().models` | `GET /api/model` → `ModelV2Info[]`（配合 `GET /api/provider`） |
| 4. 流式获取消息 | `query({includePartialMessages:true})` → `SDKPartialAssistantMessage`(stream_event, `BetaRawMessageStreamEvent`) | `GET /api/session/{sessionID}/event`（SSE `SessionDurableEvent`）、`GET /global/event`（SSE `GlobalEvent`） |
| 5. 事件系统 | 各类 `SDKMessage`（system/init、assistant、user、stream_event、result、task_*、permission_denied、session_state_changed 等） | `GlobalEvent` 信封 `{directory, project, workspace, payload{id,type,properties}}`；流式增量对应 `session.next.text.delta` / `message.part.delta` 等 88 种事件类型 |

## 六、关键接口细节摘录（供适配层设计参考）

### 6.1 已安装 SDK 版本类型（`scripts/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）
- `query()` 返回 `Query`，`Query extends AsyncGenerator<SDKMessage, void>`。
- `SDKMessage` 联合 39 个成员（assistant / user / result / system(多 subtype) / stream_event / prompt_suggestion / rate_limit_event 等）。
- `Query.interrupt()` 返回 `SDKControlInterruptResponse | undefined`（`{ still_queued: string[], cancelled? }`）。
- `ModelInfo.value` 即模型 ID（如 `sonnet` 别名），`resolvedModel` 为规范 wire id。

### 6.2 openapi.json 关键约定
- 事件/消息/会话 ID 前缀 pattern：session `^ses`、message `^msg`（V1）/ `^msg_`（V2 projected）、part `^prt`、event `^evt_`、workspace `^wrk`。
- SSE 流：`SessionDurableEventStream` / `V2EventStream` / `GlobalEvent` 均为 `type: string` + `contentSchema` + `contentMediaType: application/json`。
- 错误模型：`BadRequestError`、`InvalidRequestError`、`UnauthorizedError`、`NotFoundError`、`SessionNotFoundError`、`SessionBusyError`、`ServiceUnavailableError` 等。

## 七、结论

- 目标协议 `docs/sdk/openapi.json` 是 "opencode" 服务端 API，提供 v1（`/session/*`）与 V2（`/api/*`）两套表面，均覆盖本 exploreContent 的五项范围。
- 适配层应把 Claude Agent SDK 的**拉模型**（`AsyncGenerator<SDKMessage>` 消费）映射为 opencode 的 **HTTP 请求 + SSE 事件流**：创建会话/发送消息用 REST，流式与事件用 `GET /global/event`（GlobalEvent 信封）与 `GET /api/session/{sessionID}/event`（durable 事件）。
- 事件系统适配核心：将 `SDKMessage` 的各类消息归一化为 `GlobalEvent` 信封 `{ directory, project, workspace, payload: { id, type, properties } }`，其中 `type` 使用 openapi 定义的 88 种事件类型字符串（文本增量 → `session.next.text.delta` 等）。
- 工程上 pnpm 工作区与 `packages/sdk/claude` 包尚待初始化；`scripts/conversation.ts` 已演示 Claude SDK 流式输入 + 流式输出模式，可作为适配示例改写蓝本。
