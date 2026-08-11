## Exploration Result

### Phase 3: furina-codebase 探索结果

`furina config show project.sourcecode codebases` 返回：
- `project.sourcecode=src/`
- `codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`

`docs/codebase` 目录为**空目录**（无任何文件），无法从中获取项目自有代码库信息。`.claude/furina.json` 中 `project.codebase.enable=false`、`path=docs/codebase`，`project.sourcecode=src/`（根目录 `src/` 不存在）。本项目 `packages/*` 全部为空脚手架目录（cli/client/daemon/server/sdk/claude/sdk/codex/sdk/gemini/sdk/opencode 均无任何文件）。探索信息全部来自 Phase 4 补充探索。

## Supplementary Exploration Result

### 1. 项目当前状态（与 infra-01 相关）

- 根目录 `D:\project-code\llm\sandore`：git 仓库（main 分支，仅 1 个 Initial commit 79368bf）。
- **根级脚手架尚未创建**：无 `pnpm-workspace.yaml`、无根 `package.json`、无 `tsconfig.base.json`。
- `packages/sdk/claude/` 为**空目录**（无 package.json / tsconfig.json / src/types.ts）。
- `.gitignore` 已忽略 `node_modules/`、`dist/`、`coverage/`、`package-lock.json`、`CLAUDE.md` 等（未忽略 `.pnpm-store` 等 pnpm 特有项）。
- 当前 shell 环境 **`pnpm` 命令不可用**（`pnpm: command not found`）——验收标准中 `pnpm install` 需先在环境安装 pnpm。
- `furina/changes/claude-sdk-adapter/` 已有：`design.md`、`api.yaml`、`proposal.md`、`plan.json`、`specs/{session-management,model-providers,event-streaming}/spec.md`、`explore-design/{codebase,memory,repository,specification}.md`。
- `plan.json` 中 `infra-01` 任务状态 `in_progress`，`files` 列表：`pnpm-workspace.yaml`、`package.json`、`tsconfig.base.json`、`packages/sdk/claude/package.json`、`packages/sdk/claude/tsconfig.json`、`packages/sdk/claude/src/types.ts`。

### 2. 技术栈基线（scripts/package.json + scripts/tsconfig.json）

`scripts/package.json`：
- `name: "claude-session-chat"`、`version: "0.1.0"`、`private: true`、**`"type": "module"`**（ESM）。
- `dependencies`：`@anthropic-ai/claude-agent-sdk: "latest"`（已安装于 `scripts/node_modules`，实际 v0.3.227）。
- `devDependencies`：`@types/node ^26.2.0`、`tsx ^4.19.0`、`typescript ^5.5.0`。

`scripts/tsconfig.json`：
- `target: "ES2022"`、`module: "ESNext"`、**`moduleResolution: "bundler"`**、**`strict: true`**、`skipLibCheck: true`、`noEmit: true`、`types: ["node"]`、`include: ["conversation.ts"]`。

此即 infra-01 需建立的 tsconfig.base.json 共享配置蓝本（ESNext/bundler/strict），以及包 ESM 形态（type: module）的依据。design.md 明确依赖约定：`@anthropic-ai/claude-agent-sdk` 为 peerDependency（消费者提供），`typescript`、`vitest` 为 devDependency。

### 3. docs/sdk/openapi.json 中目标类型 schema 定义

（OpenAPI 3.1.0，title=opencode，472 个 components.schemas；`docs/sdk/claude` 官方文档 25 篇为源接口参考。）

#### 3.1 SessionV2Info（行 30882）
- properties：`id(^ses)`、`parentID?(^ses)`、`projectID`、`agent?`、`model?(ModelRef)`、`cost`、`tokens`、`time`、`title`、`location(LocationRef)`、`subpath?`、`revert?(RevertState)`。
- **required=[id, projectID, cost, tokens, time, title, location]**（任务重点约束）。
- `tokens`（内联）：`{input, output, reasoning, cache:{read, write}}`，required=[input,output,reasoning,cache]，`additionalProperties:false`。
- `time`：`{created, updated, archived?}`，required=[created, updated]，`additionalProperties:false`。
- `cost`：此处为 `type:number`（openapi 原生）；api.yaml 则定义为 `Cost` 对象 `{total_cost_usd, currency}`——types.ts 需以 api.yaml 契约为准。

#### 3.2 SessionMessagesResponse（行 26468）
- `{data: SessionMessage[], cursor:{previous?, next?}}`；required=[data, cursor]，`additionalProperties:false`。

#### 3.3 SessionMessage（行 31768）——anyOf 8 变体
`SessionMessageAgentSwitched | SessionMessageModelSwitched | SessionMessageUser | SessionMessageSynthetic | SessionMessageSystem | SessionMessageShell | SessionMessageAssistant | SessionMessageCompaction`。

- **SessionMessageUser**（行 31129）：`{id(^msg_), metadata?, time{created}, text, files?(PromptFileAttachment[]), agents?(PromptAgentAttachment[]), type:"user"}`；required=[id, time, text, type]。
- **SessionMessageSystem**（行 31226）：`{id(^msg_), metadata?, time{created}, type:"system", text}`；required=[id, time, type, text]。
- **SessionMessageAssistant**（行 31588）：`{id(^msg_), metadata?, time{created, completed?}, type:"assistant", agent, model(ModelRef), content[], snapshot?, finish?, cost?(number), tokens?, error?(SessionErrorUnknown)}`；required=[id, time, type, agent, model, content]。`content` 项 anyOf = SessionMessageAssistantText / AssistantReasoning / AssistantTool。`tokens` 内联结构与 SessionV2Info.tokens 相同。
- 其余变体（agent-switched / model-switched / synthetic / shell / compaction）非本次 user/assistant/system 适配子集，仅记录存在。

#### 3.4 PromptInput（行 26237）
- `{text, files?(PromptInputFileAttachment[]), agents?(PromptAgentAttachment[])}`；required=[text]，`additionalProperties:false`。
- `PromptInputFileAttachment`（行 30985）：`{uri(required), name?, description?, source?(PromptSource)}`，`additionalProperties:false`。
- `PromptAgentAttachment`（行 27428）：`{name(required), source?(PromptSource)}`，`additionalProperties:false`。
- `Prompt`（行 18323，SessionInputAdmitted 中引用的）：`{text, files?(PromptFileAttachment[]), agents?(PromptAgentAttachment[])}`，required=[text]。
- `PromptFileAttachment`（行 27403）：`{uri(required), mime(required), name?, description?, source?}`。

#### 3.5 SessionInputAdmitted（行 31006）
- `{admittedSeq(integer≥0), id(^msg_), sessionID(^ses), prompt(Prompt), delivery("steer"|"queue"), timeCreated, promotedSeq?(integer≥0)}`；required=[admittedSeq, id, sessionID, prompt, delivery, timeCreated]，`additionalProperties:false`。

#### 3.6 ModelRef（行 27348）/ LocationRef（行 27367）
- `ModelRef`：`{id, providerID, variant?}`；required=[id, providerID]，`additionalProperties:false`。
- `LocationRef`：`{directory, workspaceID?(^wrk)}`；required=[directory]，`additionalProperties:false`。

#### 3.7 LocationInfo（行 30727）
- `{directory, workspaceID?(^wrk), project:{id, directory}}`；required=[directory, project]，`additionalProperties:false`。

#### 3.8 ModelV2Info（行 34161）/ ModelCost（行 34109）/ ModelApi（行 34024）/ ModelCapabilities（行 34083）
- `ModelV2Info` properties：`id`、`providerID`、`family?`、`name`、`api(ModelApi)`、`capabilities(ModelCapabilities)`、`request{headers, body, variant?}`、`variants[]`、`time{released}`、`cost(ModelCost[])`、`status(alpha|beta|deprecated|active)`、`enabled`、`limit{context, output, input?}`。
  - openapi.json required=[id, providerID, name, api, capabilities, request, variants, time, cost, status, enabled, limit]。
  - **api.yaml required=[id, providerID, name, status]**（适配层契约，types.ts 应按此精简为必需项，其余可选）。
- `ModelCost`：`{tier?{type:"context", size}, input, output, cache:{read, write}}`；required=[input, output, cache]。
- `ModelApi`：anyOf aisdk `{id, type, package, url?, settings?}` / native `{id, type, url?, settings?}`。
- `ModelCapabilities`：`{tools(boolean), input(string[]), output(string[])}`，required=[tools, input, output]。

#### 3.9 GlobalEvent（行 18586）与 payload 前缀约束
- `GlobalEvent`：`{directory?(string), project?(string), workspace?(string), payload}`；required=[payload]。
- `payload` 为 **anyOf 124 个变体**：约 88 个内联事件（如 models-dev.refreshed、integration.updated、catalog.updated、session.created/updated/deleted、message.updated/removed、message.part.updated/removed、message.part.delta、session.next.*、session.error、session.status、session.idle 等），每个内联变体均为 `{id(^evt_), type(枚举), properties}` 且 **required=[id, type, properties]、additionalProperties:false**；另约 36 个 `$ref` 变体（EventServerInstanceDisposed、SyncEventSession*/Message*/SessionNext* 系列）。
- **GlobalEvent.payload.id 使用 `^evt_` 前缀约束**（任务重点约束）。
- 与归一化相关的事件 schema：
  - `SessionCreated`（行 35475）：`{id(^evt_), metadata?, type:"session.created", durable?, location?, data:{sessionID(^ses), info(Session)}}`，required=[id, type, data]。适配层按 api.yaml/spec 以 `properties:{sessionID, info}` 承载。
  - `EventMessagePartUpdated`（行 39459）：`{id(^evt_), type:"message.part.updated", properties:{sessionID(^ses), part(Part), time(number)}}`，properties required=[sessionID, part, time]。
  - `SessionNextStepEnded`（行 32550）：data 含 `timestamp, sessionID(^ses), assistantMessageID(^msg_), finish, cost(number), tokens`。
  - `SessionError`（行 36383）：data 含 `sessionID(^ses), error`（error anyOf ProviderAuthError|UnknownError|MessageOutputLengthError|MessageAbortedError|...）。
  - `SessionIdle`（行 38351）：data 含 `sessionID(^ses)`。
  - `Session`（行 16556，session.created 的 info）：`{id(^ses), slug?, projectID, workspaceID?(^wrk), directory?, path?, parentID?(^ses), summary?, cost(number), tokens, share?, title, agent?, model?, version?, metadata?, time{created,updated,compacting?,archived?}, permission?, revert?}`。

#### 3.10 错误类型（openapi.json 原生）
- `SessionNotFoundError`（行 26214）：`{_tag:"SessionNotFoundError", sessionID, message}`；required=[_tag, sessionID, message]。
- `InvalidRequestError`（行 16439）：`{_tag:"InvalidRequestError", message, kind?, field?}`；required=[_tag, message]。
- 其它错误 schema：`ConflictError`、`ServiceUnavailableError`、`MessageNotFoundError`、`UnknownError1`、`UnauthorizedError`、`InvalidCursorError`、`MoveSessionError`、`UnknownError`、`ProviderNotFoundError` 等（均有 `_tag`/`name` + `message` 结构）。
- **`TimeoutError` 在 openapi.json 中不存在**——为 api.yaml 适配层自定义错误。

### 4. api.yaml definitions（适配层契约，types.ts 最直接依据）

`furina/changes/claude-sdk-adapter/api.yaml`（Swagger 2.0 结构承载方法级客户端契约）definitions：
- **LocationRef**：required=[directory]；`directory`（绝对路径）、`workspaceID(^wrk)`。
- **ModelRef**：required=[id, providerID]；`id`（如 sonnet）、`providerID`（固定 anthropic）、`variant?`（如 claude-sonnet-4-0）。
- **TokenUsage**：`{input?(integer), output?(integer), reasoning?(integer), cache?{read?(integer), write?(integer)}}`（api.yaml 未标 required；openapi 侧 tokens 全字段 required）。
- **Cost**：`{total_cost_usd?(number), currency?(string, default "USD")}`。
- **SessionV2Info**：required=[id, projectID, cost, tokens, time, title, location]；`id` 保留 Claude 原始 session_id 不做 ^ses 转换（design.md D7）、`parentID?`、`projectID`（cwd 编码生成）、`agent?`、`model?(ModelRef)`、`cost(Cost)`、`tokens(TokenUsage)`、`time{created, updated, archived?}`（format date-time）、`title`、`location(LocationRef)`、`subpath?`、`revert?`。
- **PromptInput**：required=[text]；`text`、`files?`（PromptInputFileAttachment：uri/name/description/source，required=[uri]）、`agents?`（name/source，required=[name]）。
- **SessionInputAdmitted**：required=[admittedSeq, id, sessionID, prompt, delivery, timeCreated]；`admittedSeq(integer≥0)`、`id(^msg_)`、`sessionID`、`prompt`（text/files/agents）、`delivery(steer|queue)`（本适配层用 queue）、`timeCreated(date-time)`、`promotedSeq?(integer≥0)`。
- **SessionMessage**：required 未标全量；properties=`id(^msg_)`、`type(user|assistant|system)`、`time{created, completed?}`、`text?`（user/system）、`content?`（assistant 内容块）、`finish?`、`cost?(number)`、`tokens?`。对应 opencode 联合的 User/Assistant/System 子集。
- **SessionMessagesResponse**：required=[data, cursor]；`data(SessionMessage[])`、`cursor{previous?, next?}`。
- **ModelV2Info**：required=[id, providerID, name, status]；`id`（映射自 ModelInfo.value）、`providerID`（固定 'anthropic'）、`family?`、`name`（映射自 displayName）、`api?`、`capabilities?`、`variants?`（resolvedModel 保留于此）、`time?{released}`、`cost?(ModelCost[])`、`status`（默认 'active'）、`enabled?`（默认 true）、`limit?{context, input, output}`。
- **LocationInfo**：required=[directory, project]；`directory`、`workspaceID?(^wrk)`、`project{id, directory}`（required=[id, directory]）。
- **ModelListResponse**：`{location(LocationInfo), data(ModelV2Info[])}`（两者 required）。
- **GlobalEventPayload**：required=[id, type, properties]；`id(^evt_)`、`type`（如 session.created / message.part.delta / session.next.step.ended / session.error / session.idle）、`properties`（常见字段 sessionID/messageID/partID/field/delta/info/finish/cost/tokens/error/status）。
- **GlobalEvent**：required=[payload]；`directory?`、`project?`、`workspace?`、`payload(GlobalEventPayload)`。
- **错误**：
  - `SessionNotFoundError`：required=[_tag, sessionID, message]。
  - `TimeoutError`：required=[_tag, message]；`timeoutMs?(integer)`。
  - `InvalidRequestError`：required=[_tag, message]；`kind?`、`field?`。

### 5. specs 字段约束（session-management / model-providers / event-streaming）

- **session-management/spec.md**：
  - `client.session.create()` 返回的 SessionV2Info MUST 包含 `id`、`projectID`、`time`、`title`、`location`、`cost`、`tokens`；`location.directory` 等于客户端 cwd；agent 透传。
  - `client.session.messages()` 返回 `{ data: SessionMessage[], cursor: { previous?, next? } }`。
  - `client.session.prompt()` 返回 SessionInputAdmitted，含 `sessionID`、`prompt`、`delivery`、`timeCreated`、`id`（`^msg_` 前缀）。
  - 不存在的会话抛 SessionNotFoundError；超时抛超时错误。
- **model-providers/spec.md**：
  - `client.model.list()` 返回 `{ location: LocationInfo, data: ModelV2Info[] }`；每项含 `id`、`providerID`、`name`、`status`；`location.directory` 等于客户端 cwd。
  - ModelInfo→ModelV2Info 映射：`value→id`、`displayName→name`、`providerID='anthropic'`、`status='active'`、`resolvedModel` 保留在 variants。
- **event-streaming/spec.md**：
  - GlobalEvent 信封：`{ directory?, project?, workspace?, payload: { id(^evt_), type, properties } }`；`payload.id` MUST 以 `evt_` 开头。
  - 归一化映射表：system/init→session.created、text_delta→message.part.delta(field:'text')、input_json_delta→message.part.delta(field:'tool_input')、assistant→message.part.updated(properties:{sessionID, part, time})、result success→session.next.step.ended(properties:finish/cost/tokens)、result error→session.error、idle→session.idle；无对应的 SDKMessage 静默跳过。

### 6. design.md#D8 工程结构（infra-01 直接依据）

```
sandore/
  package.json            （私有根包，type: module）
  pnpm-workspace.yaml     （packages: ['packages/*']）
  tsconfig.base.json      （共享 TS 配置）
  packages/sdk/claude/
    package.json          （@meiyukichan/claude-sdk, type: module）
    tsconfig.json         （继承 base, ESNext/bundler/strict）
    src/
      client.ts / session.ts / model.ts / events.ts / types.ts / session-state.ts
    test/
      *.test.ts
```
- **依赖**：`@anthropic-ai/claude-agent-sdk` 作为 **peerDependency**（由消费者提供）；`typescript`、`vitest` 为 **devDependency**。
- design.md 其它相关决策：D1 方法级库形态（无 HTTP 服务器）；D7 ID 前缀——session 保留 Claude 原始 id（不转 ^ses），message/part/event 分别按 `^msg_`/`^prt`/`^evt_` 前缀生成；D8 依赖如上。

### 7. Claude SDK 源类型（@anthropic-ai/claude-agent-sdk v0.3.227，sdk.d.ts）

（`scripts/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`，7457 行；`scripts/conversation.ts` 为参考蓝本。）
- `query({prompt: string | AsyncIterable<SDKUserMessage>, options?: Options}): Query`；`Query extends AsyncGenerator<SDKMessage, void>`，含 `interrupt(): Promise<SDKControlInterruptResponse | undefined>`、`supportedModels(): Promise<ModelInfo[]>`、`initializationResult(): Promise<SDKControlInitializeResponse>`、`streamInput(...)`、`close()`。
- **SDKUserMessage**（行 4772）：`{type:"user", message: MessageParam, parent_tool_use_id: string|null, isSynthetic?, shouldQuery?, tool_use_result?, priority?, origin?, uuid?, session_id?, subagent_type?, task_description?, timestamp?}`。
- **SDKSystemMessage**（行 4601）：`{type:"system", subtype:"init", agents?, apiKeySource, betas?, claude_code_version, cwd, tools, mcp_servers[], model, permissionMode, slash_commands, output_style, skills, plugins[], capabilities?, uuid, session_id}`。
- **SDKAssistantMessage**（行 3019）：`{type:"assistant", message: BetaMessage, parent_tool_use_id, error?, uuid, session_id, request_id?, aborted?, subagent_type?, task_description?, timestamp?}`。
- **SDKResultSuccess**（行 4472）：`{type:"result", subtype:"success", duration_ms, total_cost_usd, usage, modelUsage, permission_denials, ..., uuid, session_id}`。
- **SDKPartialAssistantMessage**：`{type:"stream_event", event: BetaRawMessageStreamEvent, parent_tool_use_id:null, uuid, session_id, ttft_ms?}`。
- **ModelInfo**（行 1224）：`{value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode?}`。
- **getSessionMessages(sessionId, options?{dir?, limit?, offset?, includeSystemMessages?, sessionStore?}): Promise<SessionMessage[]>`；SDK 侧 `SessionMessage={type:"user"|"assistant"|"system", uuid, session_id, message, parent_tool_use_id, parent_agent_id}`。
- 重要差异：SDK 侧消息无 `^msg_` 前缀 ID（用 `uuid`）；无 cost/tokens 汇总字段（result 消息的 `total_cost_usd`/`usage`/`modelUsage` 是来源）。适配层需在归一化时生成 opencode ID（`^msg_`/`^prt`/`^evt_`）。

### 8. 关键事实与约束汇总

- **字段对齐来源优先级**：types.ts 字段定义应与 `api.yaml#/definitions` 及 specs 保持一致（design.md D8 + plan.json acceptance_criteria「字段与 specs 及 api.yaml 一致」）；openapi.json 为底层协议参考（字段更全、含前缀 pattern）。
- **ID 前缀约束**：session `^ses`、message `^msg_`、part `^prt`、event `^evt_`、workspace `^wrk`（openapi.json pattern；D7 例外：SessionV2Info.id 保留 Claude 原始 session_id）。
- **GlobalEvent 约束**：`{directory?, project?, workspace?, payload:{id(^evt_), type, properties}}`；payload required=[id, type, properties]。
- **SessionV2Info 必填**：id、projectID、cost、tokens、time、title、location（openapi.json 与 api.yaml 一致）。
- **TokenUsage/Cost 差异**：openapi.json 中 tokens 为内联 `{input,output,reasoning,cache{read,write}}`（全 required）、cost 为 number；api.yaml 定义独立 `TokenUsage`/`Cost` 类型（api.yaml 侧字段可选，Cost 含 total_cost_usd/currency）。types.ts 按任务要求导出 TokenUsage/Cost，应采用 api.yaml 的独立类型定义。
- **错误类型**：SessionNotFoundError、InvalidRequestError 在 openapi.json 与 api.yaml 均有定义（结构一致，`_tag` 判别）；TimeoutError 为适配层自定义（api.yaml），openapi.json 无。
- **验收标准（plan.json infra-01）**：`tsc --noEmit` 在 `packages/sdk/claude` 下编译通过；root 工作区 `packages: ['packages/*']`；根 package.json private + type: module；包 tsconfig 继承 base、bundler、strict。
