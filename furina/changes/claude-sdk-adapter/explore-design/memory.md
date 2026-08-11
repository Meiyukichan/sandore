# Furina Explore — 探索结果（memory）

## Explore Content
在 `packages/sdk/claude` 下编写 `@meiyukichan/claude-sdk` 适配器层 SDK，将 `docs/sdk/claude` 下的 Claude Code SDK 接口适配为 `docs/sdk/openapi.json` 接口协议。逐步适配范围：
1. 创建会话
2. 会话消息 / 发送消息 / 暂停会话
3. 获取模型
4. 流式获取消息
5. 事件系统（适配为 GlobalEvent，适配有的对应的）

技术约束：TypeScript、pnpm、ESM module 类型；`scripts/conversation.ts` 作为对话示例。

---

## 1. 项目当前状态（事实清单）

- 根目录无 `package.json`、无 `pnpm-workspace.yaml`、无 `tsconfig.json`（`ls` 根目录 + `find` 均未找到）。
- `packages/` 下 `cli / client / daemon / server / sdk` 全部为**空目录**；`packages/sdk/` 下 `claude / codex / gemini / opencode` 均为空目录（无任何文件，含 node_modules）。
- `docs/sdk/claude/` = Claude Code Agent SDK 的**中文文档**（overview / typescript-sdk-api / sessions / streaming-output / streaming-vs-single-mode 等，共 25 个 md）。
- `docs/sdk/openapi.json` = **OpenCode API** 协议（`info.title = "opencode"`，OpenAPI 3.1.0，162 个 path，472 个 schema）。`x-codeSamples` 引用 `@opencode-ai/sdk` 的 `createOpencodeClient()`，方法形如 `client.session.create({...})`、`client.session.prompt({...})`、`client.event.subscribe({...})`、`client.global.event({...})`、`client.provider.list({...})`。
- `scripts/conversation.ts` 是**已可运行**的交互式会话示例，基于 `@anthropic-ai/claude-agent-sdk`；`scripts/package.json` 中该依赖为 `"latest"`，实际安装版本 **0.3.227**（`scripts/node_modules/@anthropic-ai/claude-agent-sdk/package.json`：`type: module`，exports 指向 `sdk.mjs` + `sdk.d.ts`）。
- `scripts/` 自带 node_modules（anthropic-ai-sdk、esbuild、tsx、tsc 等），有独立的 `package.json`（name `claude-session-chat`）与 `tsconfig.json`（`module: ESNext`, `moduleResolution: bundler`, `noEmit`）。
- `furina/changes.json` 已登记 `claude-sdk-adapter`（createdAt 2026-08-11T14:39:46），尚无 features/todo/artifacts。
- `docs/codebase/` 为空目录；`.claude/furina.json` 的 codebase.enable=false。
- git 仅 1 个提交 `79368bf Initial commit`；`furina/`、`.claude/` 等位于 `.gitignore`。

---

## 2. 创建会话

### Claude Code SDK 侧（docs/sdk/claude/typescript-sdk-api.md、overview.md、sessions.md）
- 入口函数 `query({ prompt, options }): Query`；`Query extends AsyncGenerator<SDKMessage, void>`。
- 会话创建 = 调用 `query()` 后收到的 `system/init` 消息：`message.session_id` 即为会话 ID（也可从 `result` 消息的 `session_id` 读取）。
- 会话相关 options：`resume`（按 ID 恢复）、`continue`（恢复最近会话）、`forkSession`、`sessionId`（指定 UUID）、`cwd`、`persistSession`、`settingSources`、`title`。
- 辅助函数：`listSessions({dir,limit,includeWorktrees})`、`getSessionInfo(id)`、`renameSession()`、`tagSession()`。

### openapi 侧（v1，operationId 前缀 `session.`）
- `POST /session` → `session.create`，query 参数 `directory`/`workspace`；requestBody（additionalProperties:false）：
  - `parentID`(`^ses`)、`title`、`agent`、`model{id,providerID,variant}`、`metadata`、`permission`(PermissionRuleset)、`workspaceID`(`^wrk`)
  - 200 → `Session` schema。
- `Session` 关键字段（required: id(`^ses`), slug, projectID, directory, title, version, time）：
  - `summary{additions,deletions,files,diffs}`、`cost`、`tokens{input,output,reasoning,cache{read,write}}`、`share{url}`、`agent`、`model{id,providerID,variant}`、`time{created,updated,compacting,archived}`、`permission`、`revert`。
- 相关：`GET /session/{sessionID}` → `session.get`（返回 Session）；`PATCH /session/{sessionID}` → `session.update`（body 可含 `title`/`metadata`/`permission`/`time.archived`）；`GET /session/status` → `session.status`（返回 `{ [sessionID]: SessionStatus }`）。

### openapi 侧（v2，operationId 前缀 `v2.session.`）
- `POST /api/session` → `v2.session.create`：body `{id(^ses), agent, model:ModelRef, location:LocationRef}`，200 → `SessionV2Info`。
- `SessionV2Info`（required: id, projectID, cost, tokens, time, title, location）：`parentID`、`agent`、`model:ModelRef`、`tokens`、`time{created,updated,archived}`、`location{directory,workspaceID}`、`subpath`、`revert`。

---

## 3. 会话消息 / 发送消息 / 暂停会话

### 消息读取（会话消息）
- Claude：`getSessionMessages(sessionId, {dir,limit,offset}): Promise<SessionMessage[]>`；`SessionMessage = {type:'user'|'assistant', uuid, session_id, message, parent_tool_use_id, parent_agent_id}`。
- openapi v1：`GET /session/{sessionID}/message` → `session.messages`，query `directory`/`workspace`/`limit`/`before`；200 → 数组，每项 `{info: Message, parts: Part[]}`。
  - `Message = UserMessage | AssistantMessage`（anyOf）。
  - `UserMessage`（required: id(`^msg`), sessionID, role='user', time, agent, model）：`format:OutputFormat`、`summary`、`system`、`tools:{name:boolean}`。
  - `AssistantMessage`（required: id, sessionID, role='assistant', time, parentID, modelID, providerID, mode, agent, path, cost, tokens）：`error`(anyOf 8 种错误)、`finish`、`structured`、`variant`。
  - `Part` = 12 种变体 anyOf：TextPart / SubtaskPart / ReasoningPart / FilePart / ToolPart / StepStartPart / StepFinishPart / SnapshotPart / PatchPart / AgentPart / RetryPart / CompactionPart。公共形如 TextPart：`{id(^prt), sessionID, messageID, type:'text', text, synthetic, ignored, time{start,end}, metadata}`；ToolPart：`{id, sessionID, messageID, type:'tool', callID, tool, state:ToolState, metadata}`。

### 发送消息
- Claude：流式输入模式 yield `SDKUserMessage = {type:'user', message:{role:'user', content: string|Block[]}, parent_tool_use_id: string|null}`（`scripts/conversation.ts` 用队列+`AsyncGenerator` 实现）；单消息模式传 `prompt: string`。
- openapi v1：`POST /session/{sessionID}/message` → `session.prompt`，query `directory`/`workspace`；requestBody（required: `parts`）：
  - `messageID(^msg)`、`model{providerID,modelID}`、`agent`、`noReply:boolean`、`tools:{name:boolean}`、`format:OutputFormat`、`system`、`variant`、`parts[]`（anyOf：TextPartInput / FilePartInput / AgentPartInput / SubtaskPartInput）。
  - TextPartInput：`{id, type:'text', text, synthetic, ignored, time, metadata}`，required `type`,`text`。
  - 200 → `{info: AssistantMessage, parts: Part[]}`。
- openapi v2：`POST /api/session/{sessionID}/prompt` → `v2.session.prompt`，body `{id(^msg_), prompt:PromptInput{text,files,agents}, delivery:'steer'|'queue', resume:boolean}`。

### 暂停会话
- openapi.json 全文中**无 "pause"**（grep 计数为 0）。最近的对应物：
  - `POST /session/{sessionID}/abort` → `session.abort`（"Abort an active session and stop any ongoing AI processing or command execution"，200 → boolean）。
  - `GET /session/status` → `session.status`（`SessionStatus` = anyOf：`{type:'idle'}` / `{type:'retry', attempt, message, action, next}` / `{type:'busy'}`）。
  - `PATCH /session/{sessionID}` → `session.update` 可设 `time.archived`。
  - v2：`POST /api/session/{sessionID}/interrupt` → `v2.session.interrupt`（204）；`POST /api/session/{sessionID}/wait` → `v2.session.wait`（204）。
- Claude 侧对应：`Query.interrupt()`（流式输入模式，中断当前轮次）、`Query.close()`（结束会话）。
- 事件侧：GlobalEvent 含 `session.interrupt`、`session.idle`、`session.status` 类型。

---

## 4. 获取模型

- Claude：`Query.supportedModels(): Promise<ModelInfo[]>`；`Query.initializationResult()` 返回 `{commands, agents, models: ModelInfo[], account, ...}`。
- openapi v1：`GET /provider` → `provider.list`，200 → `{all: Provider[], default: {[providerID]:modelID}, connected: string[]}`。
  - `Provider`（required: id, name, source('env'|'config'|'custom'|'api'), env, options, models）：`models: { [id]: Model }`。
  - `Model`（required: id, providerID, api{id,url,npm}, capabilities, cost...）：`family`、`name`、`capabilities{temperature,reasoning,attachment,toolcall,input{...},output{...},interleaved}`、`cost{input,output,cache,tiers}`。
- openapi v2：`GET /api/model` → `v2.model.list`（query `location`），200 → `ModelV2Info[]`；`ModelV2Info` 更完整（required: id, providerID, name, api, capabilities, request, variants, time, cost, status('alpha'|'beta'|'deprecated'|'active'), enabled, limit）。
- 另有 `GET /config/providers` → `config.providers`（Config 相关，非模型清单主入口）。

---

## 5. 流式获取消息

### Claude 侧
- 开启 `options.includePartialMessages: true` 后，流中会出现 `SDKPartialAssistantMessage = {type:'stream_event', event: BetaRawMessageStreamEvent, parent_tool_use_id:null, uuid, session_id, ttft_ms?}`。
- `event.type`：`message_start` / `content_block_start`(text 或 tool_use) / `content_block_delta`(delta.type=`text_delta` 或 `input_json_delta`) / `content_block_stop` / `message_delta` / `message_stop`。
- 消息流顺序：`system/init` → `stream_event*` → `assistant`（完整）→ 工具执行 → 下一轮 `stream_event*` → `result`。

### openapi 侧（流式不在 prompt 响应内，而走 SSE 事件端点）
- `session.prompt` 的 200 响应是 `application/json`（非 SSE）；全 openapi 中仅 4 个 SSE 端点：
  - `GET /event` → `event.subscribe`（text/event-stream，schema `Event`）
  - `GET /global/event` → `global.event`（text/event-stream，schema `GlobalEvent`）
  - `GET /api/session/{sessionID}/event` → `v2.session.events`（text/event-stream，schema `SessionDurableEventStream`，即 `SessionDurableEvent`）
  - `GET /api/event` → `v2.event.subscribe`（text/event-stream，schema `V2Event`）
- 逐 token / 增量事件：
  - `EventSessionNextTextDelta`：`type:'session.next.text.delta'`，properties `{timestamp, sessionID, assistantMessageID, textID, delta}`（另有 `EventSessionNextTextStarted/Ended`、`SessionNextTextDelta` 的 data 风格同构）。
  - `EventMessagePartDelta`：`type:'message.part.delta'`，properties `{sessionID, messageID, partID, field, delta}`。
  - 工具流：`session.next.tool.input.started/delta/ended`、`session.next.tool.called/success/failed/progress`（对应 Claude `input_json_delta` / tool_use）。
  - 推理流：`session.next.reasoning.started/delta/ended`。
  - 轮次/步骤：`session.next.step.started/ended/failed`、`session.next.retried`、`session.next.synthetic`、`session.next.shell.started/ended`、`session.next.compaction.started/delta/ended`。
- 完整消息事件：`message.updated`（properties `{sessionID, info: Message}`）、`message.removed`、`message.part.updated/removed`；会话生命周期：`session.created`、`session.updated`、`session.deleted`、`session.idle`、`session.status`、`session.error`、`session.diff`。

---

## 6. 事件系统（适配为 GlobalEvent）

### Claude 侧（SDKMessage 联合）
`SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | ...`（约 40 种，见 typescript-sdk-api.md）。核心：`system/init`、`assistant`、`user`、`result`、`stream_event`。

### openapi 侧两种事件载体
1. **Event**（`GET /event`，`event.subscribe`）：anyOf **89 种**事件 schema。两种形态：
   - "properties" 风格（如 `EventSessionCreated`、`EventMessageUpdated`）：`{id(^evt_), type, properties}`。
   - "data" 风格（如 `SessionNextStepStarted`、`SessionNextTextDelta`）：`{id(^evt_), metadata, type, durable{aggregateID,seq,version}, location:LocationRef, data}`。
2. **GlobalEvent**（`GET /global/event`，`global.event`）：包装结构 `{directory, project, workspace, payload}`，`payload` 为事件对象（anyOf，`type` 枚举共 **114 种**）。

### GlobalEvent 的 114 种 type 枚举（payload.type）
`agent.cycle`、`catalog.updated`、`command.executed`、`file.edited`、`file.watcher.updated`、`global.disposed`、`installation.updated`、`installation.update-available`、`integration.updated`、`integration.connection.updated`、`lsp.updated`、`mcp.tools.changed`、`mcp.browser.open.failed`、`message.updated`、`message.removed`、`message.part.updated`、`message.part.removed`、`message.part.delta`、`models-dev.refreshed`、`permission.asked`、`permission.replied`、`permission.v2.asked`、`permission.v2.replied`、`plugin.added`、`project.updated`、`project.directories.updated`、`prompt.submit`、`prompt.clear`、`pty.created/updated/exited/deleted`、`question.asked/replied/rejected`、`question.v2.asked/replied/rejected`、`reference.updated`、`server.connected`、`session.created`、`session.updated`、`session.deleted`、`session.status`、`session.idle`、`session.error`、`session.interrupt`、`session.diff`、`session.compact`、`session.compacted`、`session.share`、`session.first`、`session.new`、`session.list`、`session.page.up/down`、`session.half.page.up/down`、`session.line.up/down`、`session.last`、`session.next.*`（agent.switched / model.switched / moved / prompted / prompt.admitted / context.updated / synthetic / shell.started / shell.ended / step.started / step.ended / step.failed / text.started / text.delta / text.ended / reasoning.started / reasoning.delta / reasoning.ended / tool.input.started / tool.input.delta / tool.input.ended / tool.called / tool.progress / tool.success / tool.failed / retried / compaction.started / compaction.delta / compaction.ended / revert.staged / revert.cleared / revert.committed）、`todo.updated`、`tui.command.execute`、`tui.prompt.append`、`tui.session.select`、`tui.toast.show`、`vcs.branch.updated`、`workspace.ready/failed/status`、`worktree.ready/failed`。

### Claude SDK 消息 → GlobalEvent 类型的可对应关系（仅记录已存在的事实映射）
| Claude SDK 消息 | GlobalEvent payload.type（存在对应者） |
| --- | --- |
| `system/init`、会话创建 | `session.created`、`session.updated`、`server.connected` |
| `assistant` 完整消息 / 消息变更 | `message.updated`、`message.part.updated` |
| `stream_event` text | `session.next.text.started` / `text.delta` / `text.ended`、`message.part.delta` |
| `stream_event` tool | `session.next.tool.input.started/delta/ended`、`session.next.tool.called/success/failed/progress` |
| `stream_event` reasoning | `session.next.reasoning.started/delta/ended` |
| `result` 回合结束 | `session.idle`、`session.status`、`session.error`、`session.compacted` |
| 中断 / 停止 | `session.interrupt`、`session.abort`（operation） |
| 会话删除 / 归档 | `session.deleted`、`session.updated`（`time.archived`） |

---

## 7. 关键数据结构速查（openapi.json）

- 会话 ID 前缀：`^ses`；消息 ID：`^msg`；part ID：`^prt`；事件 ID：`^evt_`。
- 事件 ID pattern `^evt_`，两种事件形态见第 6 节。
- `SessionStatus` = `{type:'idle'}` | `{type:'retry',attempt,message,action,next}` | `{type:'busy'}`。
- `OutputFormat` = `OutputFormatText{type:'text'}` | `OutputFormatJsonSchema{type:'json_schema',schema,retryCount}`。
- `ModelRef` = `{id, providerID, variant?}`；`LocationRef` = `{directory, workspaceID?}`。
- `v2.session.prompt` 返回体、`v2.session.messages`（GET /api/session/{sessionID}/message → `SessionMessagesResponse{data: SessionMessage[], cursor{previous,next}}`）为 v2 分页形态。

## 8. 与脚本示例的关联
- `scripts/conversation.ts` 直接使用 `@anthropic-ai/claude-agent-sdk` 的 `query()`、`SDKUserMessage`，覆盖"创建会话(system/init)、发送消息(yield user)、流式消费(stream_event)、回合结束(result)、resume 恢复"。它是适配器 SDK 的目标示例：适配后应能让 `scripts/conversation.ts` 通过 `@meiyukichan/claude-sdk` 走 openapi.json 协议完成同样流程。
- `scripts/` 为 ESM（`type: module`）+ `tsx` + `moduleResolution: bundler`，可作为适配器包的技术基准。
