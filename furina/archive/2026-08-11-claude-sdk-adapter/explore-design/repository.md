# 仓库探索报告 —— @meiyukichan/claude-sdk 适配器层 SDK

> 探索类型：repository
> 目标：在 `packages/sdk/claude` 下编写 `@meiyukichan/claude-sdk` 适配器层 SDK，将 Claude Code SDK 接口逐步适配为 `docs/sdk/openapi.json` 接口协议。
> 探索范围（5 步）：①创建会话 ②会话消息/发送消息/暂停会话 ③获取模型 ④流式获取消息 ⑤事件系统（适配为 GlobalEvent）。
> 技术栈要求：TypeScript、pnpm、ESM（module 类型）；`scripts/conversation.ts` 为对话示例。

---

## 1. 项目当前状态

### 1.1 根目录
- 无根级 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`（尚不存在 monorepo/pnpm 工作区配置）。
- 仅有：`.gitignore`、`LICENSE`、`README.md`（内容仅 `# sandore` 一行）、`docs/`、`packages/`、`scripts/`、`furina/`、`.claude/`。
- `.gitignore` 已包含 `node_modules/`、`dist/`、`furina/`、`package-lock.json` 等（注意 `furina/` 被忽略，属于 furina 工具产物）。

### 1.2 packages/ 目录（全部为空，无源码）
```
packages/
  cli/        (空)
  client/     (空)
  daemon/     (空)
  sdk/
    claude/   (空 —— 本次适配层 SDK 的目标位置)
    codex/    (空)
    gemini/   (空)
    opencode/ (空)
  server/     (空)
```
没有任何现有 SDK 包可作代码级参考；`packages/sdk/claude` 为全新的空包。

### 1.3 scripts/ 目录
- `conversation.ts`（6395 字节）—— 基于 `@anthropic-ai/claude-agent-sdk` 的交互式会话示例，见第 5 节。
- `package.json`：包名 `claude-session-chat`、`private: true`、`type: "module"`；依赖 `@anthropic-ai/claude-agent-sdk: latest`；devDeps `@types/node`、`tsx`、`typescript`；脚本 `chat: tsx conversation.ts`。
- `tsconfig.json`：`target: ES2022`、`module: ESNext`、`moduleResolution: bundler`、`strict: true`、`noEmit: true`、`types: ["node"]`。
- 存在 `package-lock.json`（使用 npm，非 pnpm）—— 用户新 SDK 要求改用 pnpm。

### 1.4 furina/（历史变更参考）
- `furina/changes.json`：framework `@meiyukichan/furina@1.0.3`；仅一条进行中变更 `claude-sdk-adapter`（即本任务），`path: furina/changes/claude-sdk-adapter`，`artifacts: []`；`archive: []`（无已归档变更）。
- `furina/changes/` 目录为空，无历史产物可参考。
- `.claude/furina.json`：furina 配置（switchProviders、exploration.repository 默认空等），无项目级代码约定。

---

## 2. 目标协议 —— docs/sdk/openapi.json

### 2.1 概览
- OpenAPI 3.1.0；`info.title = "opencode api"`；`components.schemas` 共 **472** 个；tags 约 38 组。
- 存在**两套 API 面**：
  - **v1 / legacy experimental**（tag 无 `v2` 前缀，路径不带 `/api`）：如 `POST /session`、`GET /session/{sessionID}/message`、`POST /session/{sessionID}/message`、`POST /session/{sessionID}/abort`、`GET /event`、`GET /global/event`。
  - **v2 / opencode HttpApi**（tag `sessions/messages/models/providers/events/...`，路径带 `/api`）：如 `POST /api/session`、`GET /api/session/{sessionID}/message`、`POST /api/session/{sessionID}/prompt`、`GET /api/model`、`GET /api/session/{sessionID}/event`、`GET /api/event`。
- 所有 x-codeSamples 均指向 `@opencode-ai/sdk` 的 `createOpencodeClient()`，例如：
  - `client.session.create(...)`（v1）
  - `client.v2.session.create(...)`、`client.v2.session.prompt(...)`、`client.v2.session.events(...)`（v2）
  - `client.event.subscribe(...)`、`client.global.event(...)`

### 2.2 五步适配对应的接口（关键端点）

#### ① 创建会话
| 版本 | 端点 | operationId | 请求 | 响应 |
|---|---|---|---|---|
| v2 | `POST /api/session` | `v2.session.create` | body `{ id?("^ses"), agent?, model?: ModelRef, location?: LocationRef }` | `{ data: SessionV2Info }` |
| v1 | `POST /session` | `session.create` | query `directory?/workspace?`；body `{ parentID?, title?, agent?, model?, metadata?, permission?, workspaceID? }` | `Session` |

- `SessionV2Info`：`{ id("^ses"), parentID?, projectID, agent?, model: ModelRef, cost, tokens{input,output,reasoning,cache{read,write}}, time{created,updated,archived?}, title, location: LocationRef, subpath?, revert? }`
- `ModelRef`：`{ id, providerID, variant? }`
- `LocationRef`：`{ directory(必填), workspaceID?("^wrk") }`
- v1 `Session`：`{ id, slug, projectID, workspaceID, directory, path, parentID, summary{additions,deletions,files,diffs?}, cost, tokens, share?, title, agent, model, version, metadata, time{created,updated,compacting?,archived?}, permission?, revert?, ... }`

#### ② 会话消息 / 发送消息 / 暂停会话
| 能力 | 版本 | 端点 | operationId | 请求 | 响应 |
|---|---|---|---|---|---|
| 获取消息 | v2 | `GET /api/session/{sessionID}/message` | `v2.session.messages` | query `limit?/order?(asc\|desc)/cursor?` | `SessionMessagesResponse` |
| 获取消息 | v1 | `GET /session/{sessionID}/message` | `session.messages` | query `limit?/before?` | `Array<{info: Message, parts: Part[]}>` |
| 发送消息 | v2 | `POST /api/session/{sessionID}/prompt` | `v2.session.prompt` | body `{ id?("^msg_"), prompt: PromptInput(必填), delivery?: "steer"\|"queue", resume?: boolean }` | `{ data: SessionInputAdmitted }` |
| 发送消息 | v1 | `POST /session/{sessionID}/message` | `session.prompt` | body `{ messageID?, model?, agent?, noReply?, tools?, format?, system?, variant?, parts[](必填) }` | `{ info: AssistantMessage, parts: Part[] }` |
| 等待空闲 | v2 | `POST /api/session/{sessionID}/wait` | `v2.session.wait` | — | `204` |
| 中断执行 | v2 | `POST /api/session/{sessionID}/interrupt` | `v2.session.interrupt` | — | `204`（空闲中断为 no-op） |
| 中止会话 | v1 | `POST /session/{sessionID}/abort` | `session.abort` | — | `boolean` |
| 会话状态 | v1 | `GET /session/status` | `session.status` | query `directory?/workspace?` | `{ sessionID: SessionStatus }` |

- **暂停会话的关键机制（v2）**：`POST /api/session/{sessionID}/prompt` 的 `resume: boolean` 字段 —— 描述原文：“Durably admit one session input and schedule agent-loop execution unless resume is false.”即 `resume: false` 时仅持久化接收输入、不调度执行（相当于“暂停/入队”），配合 `delivery: "steer" | "queue"`；恢复执行可用 `wait`（等待空闲）与 `interrupt`（中断正在执行）。
- `PromptInput`：`{ text(必填), files?: PromptInputFileAttachment[], agents?: PromptAgentAttachment[] }`
- `SessionInputAdmitted`：`{ admittedSeq, id("^msg_"), sessionID("^ses"), prompt: Prompt, delivery, timeCreated, promotedSeq? }`
- `SessionMessagesResponse`：`{ data: SessionMessage[], cursor: {previous?, next?} }`（游标分页，`cursor` 不与 `order` 混用）。
- `SessionMessage` 联合：`AgentSwitched | ModelSwitched | User | Synthetic | System | Shell | Assistant | Compaction`。
  - `SessionMessageUser`：`{ id("^msg_"), metadata?, time{created}, text, files?, agents?, type:"user" }`
  - `SessionMessageAssistant`：`{ id("^msg_"), metadata?, time{created,completed?}, type:"assistant", agent?, model?: ModelRef, content: Array<AssistantText\|AssistantReasoning\|AssistantTool>, snapshot?, finish?, cost?, tokens?, error? }`
  - `SessionMessageSystem`：`{ id, time{created}, type:"system", text }`
  - `SessionMessageSynthetic`：`{ id, time{created}, sessionID, text, type:"synthetic" }`
- `SessionStatus`：`{ type:"idle" } | { type:"retry", attempt, message, action, next } | { type:"busy" }`

#### ③ 获取模型
| 端点 | operationId | 请求 | 响应 |
|---|---|---|---|
| `GET /api/model` | `v2.model.list` | query `location?{directory?, workspace?}` | `{ location: LocationInfo, data: ModelV2Info[] }` |

- `ModelV2Info`：`{ id, providerID, family?, name, api: ModelApi, capabilities: ModelCapabilities, request{headers,body,variant?}, variants[], time{released}, cost: ModelCost[], status("alpha"\|"beta"\|"deprecated"\|"active"), enabled, limit{context,input?,output} }`
- `LocationInfo`：`{ directory, workspaceID?, project{id,directory} }`

#### ④ 流式获取消息
| 端点 | operationId | 说明 |
|---|---|---|
| `GET /api/session/{sessionID}/event` | `v2.session.events` | 回放聚合序列之后的 durable 事件，再持续推送新 durable 事件；query `after?`；200 响应体 schema 为空（SSE 流），关联 `SessionDurableEventStream`（`contentSchema: SessionDurableEvent`） |
| `GET /api/event` | `v2.event.subscribe` | 订阅服务器原生事件 payload，关联 `V2EventStream` |
| `GET /event` | `event.subscribe` | v1；query `directory?/workspace?` |
| `GET /global/event` | `global.event` | v1；SSE 订阅 OpenCode 全局事件 |

- `SessionDurableEvent`：`oneOf` 28 种 `SessionNext*` durable 事件，共同结构：
  `{ id("^evt_"), metadata?, type("session.next.*"), durable{aggregateID, seq, version}, location?: LocationRef, data{timestamp, sessionID, ...} }`
- 与“流式 token”最相关的事件：
  - `session.next.text.started` / `.delta`（`data.delta` 为增量文本）/ `.ended`（`data.text` 为完整文本）
  - `session.next.reasoning.started` / `.delta` / `.ended`
  - `session.next.tool.input.started` / `.delta`（`data.delta` 为入参 JSON 增量）/ `.ended`
  - `session.next.tool.called` / `.success` / `.failed` / `.progress`
  - `session.next.step.started`（含 `agent`、`model: ModelRef`）/ `.ended`（含 `finish`、`cost`、`tokens`）
  - `session.next.prompted` / `.prompt.admitted`（含 `prompt: Prompt`、`delivery`）
  - `session.next.shell.*`、`session.next.retried`、`session.next.compaction.*`、`session.next.revert.*`

#### ⑤ 事件系统 —— GlobalEvent
- 端点：`GET /global/event`（`global.event`，SSE）与 `GET /api/event`（`v2.event.subscribe`，V2EventStream）。
- **`GlobalEvent` schema**（事件外壳）：
  ```
  { directory?: string, project?: string, workspace?: string, payload: <联合> }
  ```
- `payload` 为 **124 个** 事件变体的 `anyOf`：
  - **88 个内联 `Event*` schema**：`{ id("^evt_"), type(<enum>), properties{...} }`（注意：GlobalEvent 内用 `properties` 字段）
  - **36 个 `$ref`**：`EventServerInstanceDisposed` + 35 个 `SyncEventSession*`/`SyncEventMessage*`/`SyncEventSessionNext*`（同步事件）。
- 事件 type 枚举（前 86 个内联部分，节选与本次适配相关）：
  `models-dev.refreshed`、`integration.updated`、`integration.connection.updated`、`catalog.updated`、
  `session.created` / `session.updated` / `session.deleted`、
  `message.updated` / `message.removed` / `message.part.updated` / `message.part.removed`、
  `session.next.agent.switched`、`session.next.model.switched`、`session.next.moved`、
  `session.next.prompted`、`session.next.prompt.admitted`、`session.next.context.updated`、`session.next.synthetic`、
  `session.next.shell.started` / `session.next.shell.ended`、
  `session.next.step.started` / `step.ended` / `step.failed`、
  `session.next.text.started` / `text.delta` / `text.ended`、
  `session.next.reasoning.started` / `reasoning.delta` / `reasoning.ended`、
  `session.next.tool.input.started` / `tool.input.delta` / `tool.input.ended` / `tool.called` / `tool.progress` / `tool.success` / `tool.failed`、
  `session.next.retried`、`session.next.compaction.started` / `.delta` / `.ended`、`session.next.revert.staged` / `.cleared` / `.committed`、
  `message.part.delta`、`session.diff`、`session.error`、`installation.updated`、`file.edited`、`reference.updated`、
  `permission.v2.asked` / `replied`、`plugin.added`、`project.directories.updated`、`file.watcher.updated`、
  `pty.*`、`question.v2.*`、`todo.updated`、`lsp.updated`、`permission.asked` / `replied`、
  `tui.prompt.append` / `tui.command.execute` / `tui.toast.show` / `tui.session.select`、
  `mcp.tools.changed`、`command.executed`、`project.updated`、`session.status`、`session.idle`、
  `question.asked` / `replied` / `rejected`、`session.compacted`、`vcs.branch.updated`、`workspace.*`、`worktree.*`、`server.connected`、`global.disposed` 等。

- **注意两种事件形态差异**：
  - `GlobalEvent.payload` 的 `Event*` 变体：`{ id, type, properties }`（`properties` 装数据）
  - `V2Event` / `SessionDurableEvent` 联合中的 `SessionNext*` 变体：`{ id, metadata?, type, durable?, location?, data }`（`data` 装数据）
  - 二者 type 枚举一致（`session.next.text.delta` 等），但字段容器不同（`properties` vs `data`），适配时需注意转换。

- 其他相关事件 schema：`V2Event`（`anyOf` 约 60+ 个 `Session*`/`Event*`/`Message*` 变体）、`Event`（v1 版，`anyOf` 的 `Event*` 变体）。

### 2.3 错误 schema（公共）
- `InvalidRequestError`：`{ _tag:"InvalidRequestError", message, kind?, field? }`
- `UnauthorizedError`：`{ _tag:"UnauthorizedError", message }`
- `SessionNotFoundError`：`{ _tag:"SessionNotFoundError", sessionID, message }`
- `ConflictError`：`{ _tag:"ConflictError", message, resource? }`
- 另见 `ServiceUnavailableError`、`BadRequestError`、`NotFoundError`、`effect_HttpApiError_BadRequest`、`InvalidCursorError`、`UnknownError1` 等。

---

## 3. 源接口 —— Claude Code SDK（docs/sdk/claude）

> 包名：`@anthropic-ai/claude-agent-sdk`（TypeScript Agent SDK 官方参考文档，位于 `docs/sdk/claude/*.md`）。

### 3.1 核心函数与对象
- `query({ prompt, options? }): Query` —— 主入口。`prompt: string | AsyncIterable<SDKUserMessage>`；字符串=单消息模式，异步生成器=流式输入模式（持久多轮会话）。
- `startup({options?, initializeTimeoutMs?}): Promise<WarmQuery>` —— 预热子进程。
- `Query` 对象（`extends AsyncGenerator<SDKMessage, void>`）方法：`interrupt()`、`rewindFiles()`、`setPermissionMode()`、`setModel()`、`setMaxThinkingTokens()`、`applyFlagSettings()`、`initializationResult()`、`reinitialize()`、`supportedCommands()`、`supportedModels(): Promise<ModelInfo[]>`、`supportedAgents()`、`mcpServerStatus()`、`accountInfo()`、`streamInput()`、`close()` 等。
- 会话读写辅助：`listSessions()`、`getSessionMessages()`、`getSessionInfo()`、`renameSession()`、`tagSession()`。

### 3.2 创建会话（Claude 侧）
- 通过 `query({ prompt, options })` 隐式创建；`options.sessionId` 可指定 ID（否则自动生成）；`options.resume` 恢复指定会话、`continue: true` 恢复最近会话、`forkSession: true` 分叉。
- 会话 ID 从流中 `SDKSystemMessage`（`type:"system"`、`subtype:"init"`）的 `session_id` 字段或 `SDKResultMessage.session_id` 获取。

### 3.3 SDKMessage 联合（30+ 类型，五步适配相关的核心子集）
| type | 说明 | 关键字段 |
|---|---|---|
| `system` / `subtype:"init"` | 会话初始化 | `session_id, cwd, model, tools, mcp_servers, permissionMode, slash_commands, output_style, skills, plugins, capabilities?, agents?, claude_code_version` |
| `system` / `"compact_boundary"` | 压缩边界 | `compact_metadata{trigger, pre_tokens}` |
| `system` / `"informational"` | 文本横幅 | `content, level` |
| `assistant` | 完整助手消息 | `uuid, session_id, message: BetaMessage, parent_tool_use_id, error?`（`message.content` 为 text/tool_use 等块） |
| `user` | 用户/工具结果 | `uuid?, session_id?, message: MessageParam, parent_tool_use_id, isSynthetic?, shouldQuery?` |
| `result` | 回合结束 | `subtype("success"\|"error_max_turns"\|"error_during_execution"\|"error_max_budget_usd"\|...), session_id, duration_ms, total_cost_usd, usage, num_turns, result?, stop_reason, permission_denials` |
| `stream_event` | token 级流（需 `includePartialMessages: true`） | `event: BetaRawMessageStreamEvent, session_id, ttft_ms?` |
| `status` / `task_notification` / `hook_*` / `permission_denied` 等 | 可观测性 | — |

- `SDKUserMessage`（流式输入 yield 的对象）：`{ type:"user", message:{role:"user", content:string|blocks}, parent_tool_use_id: string|null, ... }`；`shouldQuery:false` 可只记录不触发轮次。
- `SDKResultMessage` 成功分支含 `result`（最终文本）、`total_cost_usd`、`usage`、`num_turns`、`stop_reason`；错误分支含 `errors: string[]`。

### 3.4 流式获取（Claude 侧）
- `options.includePartialMessages: true` 后产生 `SDKPartialAssistantMessage`（`type:"stream_event"`），`event` 为 Anthropic 原始流事件：`message_start`、`content_block_start`、`content_block_delta`（`delta.type:"text_delta"` 文本增量 / `"input_json_delta"` 工具入参增量）、`content_block_stop`、`message_delta`、`message_stop`。
- 消息流顺序：`stream_event...` → `AssistantMessage` →（工具执行）→ 下一轮 → `ResultMessage`。

### 3.5 模型（Claude 侧）
- `Query.supportedModels(): Promise<ModelInfo[]>`
- `ModelInfo`：`{ value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels?: ("low"|"medium"|"high"|"xhigh"|"max")[], supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode? }`

### 3.6 暂停/中断（Claude 侧）
- `Query.interrupt()`：中断当前查询，仅流式输入模式可用；较新 CLI 返回 `SDKControlInterruptResponse { still_queued: string[] }`。
- 与 openapi v2 的“暂停”机制（`prompt` 的 `resume:false` + `wait`/`interrupt`）对应，但语义不同：Claude 侧是中断查询，openapi 侧是“入队不执行 + 等待空闲/中断”。

### 3.7 其他
- `Options` 关键字段（与适配相关）：`cwd`、`resume`、`resumeSessionAt`、`continue`、`forkSession`、`sessionId`、`persistSession`、`title`、`model`、`agent`、`maxTurns`、`maxBudgetUsd`、`includePartialMessages`、`allowedTools`、`disallowedTools`、`permissionMode`、`settingSources`、`systemPrompt`、`env` 等。

---

## 4. Claude SDK ↔ openapi.json 映射要点（探索性对照，非实现方案）

| 适配步骤 | Claude Code SDK 侧 | openapi.json 侧 |
|---|---|---|
| ①创建会话 | `query({prompt, options})`；从 `system/init.session_id` 或 `result.session_id` 取 ID | v2 `POST /api/session`（`v2.session.create`）→ `SessionV2Info`；v1 `POST /session` → `Session` |
| ②会话消息/发送/暂停 | `SDKUserMessage`、`SDKAssistantMessage`、`SDKResultMessage`；`Query.interrupt()`；`options.resume/continue/forkSession` | v2 `GET/POST /api/session/{id}/message|prompt`（`resume:false` 即暂停入队）+ `wait`/`interrupt`；v1 `GET/POST /session/{id}/message` + `abort` |
| ③获取模型 | `Query.supportedModels(): ModelInfo[]` | `GET /api/model` → `ModelV2Info[]` |
| ④流式获取消息 | `includePartialMessages:true` → `stream_event`（`BetaRawMessageStreamEvent`） | `GET /api/session/{id}/event`（SSE，`SessionNextTextDelta` 等 durable 事件） |
| ⑤事件系统→GlobalEvent | SDK 消息类型（`system/init`、`assistant`、`result`、`stream_event`、`user`…）中“有对应”者 | `GlobalEvent` 外壳 `{directory,project,workspace,payload:{id,type,properties}}`，`payload.type` 枚举（`session.*`/`session.next.*`/`message.*`/`session.error` 等） |

---

## 5. 参考示例 —— scripts/conversation.ts

- 使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 与 `SDKUserMessage`。
- 核心流程：
  1. 用 `query({ prompt: chatStream(), options: {...} })` 创建会话（`chatStream` 为无限异步生成器 → 流式输入模式）。
  2. 消费 `message.type`：`"system"(subtype:"init")` 捕获 `session_id`；`"stream_event"` 逐 token 打印（`content_block_start` 识别 `tool_use`、`content_block_delta` 的 `text_delta`/`input_json_delta`）；`"assistant"` 遍历 `message.message.content` 输出 `tool_use`；`"result"` 打印 `subtype`、`duration_ms`、`total_cost_usd`。
  3. 用户输入通过队列入队后由生成器 `yield` 给会话；支持 `--resume <sessionId>`、首条消息参数、`/exit`、`/session` 命令；结束调用 `q.close()`。
- `options`：`cwd`、`resume`、`includePartialMessages: true`、`maxTurns: 20`、`allowedTools: [Read,Glob,Grep,Bash,Edit,Write,Task,WebSearch,WebFetch]`。

---

## 6. 关键结论

1. **目标包位置** `packages/sdk/claude` 当前为空，无既有 SDK 代码或约定；根级也无 pnpm workspace / package.json，需从零搭建（pnpm + TypeScript + ESM `"type":"module"`）。
2. **openapi.json 为 “opencode api” 协议**，同时暴露 v1（`/session*`、`/event`、`/global/event`）与 v2（`/api/session*`、`/api/model`、`/api/event`）两套面；官方 code samples 指向 `@opencode-ai/sdk` 的 `createOpencodeClient()`（`client.v2.*` / `client.*`）。
3. **“暂停会话”在 v2 中的语义**是 `POST /api/session/{id}/prompt` 的 `resume:false`（持久化入队、不调度执行）+ `delivery` + `wait`/`interrupt`；v1 侧对应 `POST /session/{id}/abort`。
4. **流式消息**对应 v2 的 `GET /api/session/{id}/event`（SSE durable 事件，`session.next.text.delta` 等）；**事件系统**对应 `GlobalEvent`（外壳 + 124 个 payload 变体，内联变体用 `properties` 字段，与 V2Event 的 `data` 字段形态不同）。
5. **事件适配为 GlobalEvent** 需在 Claude SDK 的 `SDKMessage` 各类型（`system/init`、`assistant`、`result`、`stream_event`、`user` 等）中仅挑“有对应”的映射为 `payload.type`（如 `session.created`、`session.next.text.delta`、`message.*`、`session.error`），无对应者不映射。
