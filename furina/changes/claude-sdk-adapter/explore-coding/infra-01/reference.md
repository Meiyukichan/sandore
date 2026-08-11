## Exploration Result

### Phase 1: 参考资料配置

`furina config show exploration.reference` 返回空数组 `[]`，但 exploreContent 已显式列出本次探索所需的参考资料，故按下述清单逐项探索：

1. `docs/sdk/openapi.json`（OpenAPI 3.1.0，title=opencode）中的目标协议 schema 定义
2. `scripts/tsconfig.json` 与 `scripts/package.json`（技术栈基线：ESM / bundler / strict）
3. `scripts/conversation.ts` 及其依赖的 `@anthropic-ai/claude-agent-sdk`（v0.3.227）类型定义
4. `furina/changes/claude-sdk-adapter/specs/**/*.md` 与 `design.md#D8`、`api.yaml#definitions`（字段约束）

---

### Phase 2: 需求理解

**What**：为 `@meiyukichan/claude-sdk`（`packages/sdk/claude`）搭建工程骨架——根级 pnpm 工作区（`pnpm-workspace.yaml`、根 `package.json`、`tsconfig.base.json`），包脚手架（`package.json` 以 `@anthropic-ai/claude-agent-sdk` 为 peerDependency、`typescript`/`vitest` 为 devDependency，`tsconfig.json` 继承 base），并在 `src/types.ts` 中定义适配层所需的全部 opencode 协议类型与错误类型。

**Boundaries**：仅涉及「工作区初始化 + 包脚手架 + `src/types.ts` 类型定义」这一层（plan.json 中 `infra-01`）。不涉及 session/model/event/client 等运行时实现（`session-01`、`event-01` 的范畴）。参考物为 specs 三份、design.md、api.yaml 以及 openapi.json 中与目标类型对应的 schema。

**Goal**：摸清 (a) 根级工程配置与包脚手架应遵循的技术栈基线；(b) `src/types.ts` 中每个协议类型的字段结构、必填项与 ID 前缀约束，确保与 specs / api.yaml / openapi.json 保持一致；(c) Claude SDK 侧用于支撑这些类型的源类型（SDKMessage、Query、ModelInfo、getSessionMessages 等）。

---

### Phase 3: 参考物探索结果

#### 3.1 工程基线现状与 `scripts/` 技术栈（files: `scripts/package.json`、`scripts/tsconfig.json`、根目录）

**根目录当前状态**（design.md「当前状态」得到印证）：
- 根目录**不存在** `pnpm-workspace.yaml`、根 `package.json`、`tsconfig.base.json`（`ls` 确认均无此文件）。
- `packages/sdk/claude` 为空目录（无任何实现）。
- `.gitignore` 已忽略 `node_modules/`、`dist/`、`coverage/`、`package-lock.json` 等。

**`scripts/package.json`**（npm + tsx，非工作区成员）：
```json
{
  "name": "claude-session-chat",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": { "@anthropic-ai/claude-agent-sdk": "latest" },
  "devDependencies": { "@types/node": "^26.2.0", "tsx": "^4.19.0", "typescript": "^5.5.0" }
}
```

**`scripts/tsconfig.json`**（技术栈基线：ESM / bundler / strict）：
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "skipLibCheck": true, "noEmit": true, "types": ["node"]
  },
  "include": ["conversation.ts"]
}
```
要点：`type: module`（ESM 产物）、`moduleResolution: bundler`、`strict: true`、`skipLibCheck`。`tsconfig.base.json` 需在此基调上做「共享配置」抽取（ESNext/bundler/strict），供 `packages/sdk/claude/tsconfig.json` 继承。

**SDK 版本确认**：`scripts/node_modules/@anthropic-ai/claude-agent-sdk/package.json` → `version: 0.3.227`（与 design.md 一致）。

#### 3.2 Claude SDK 源类型（`scripts/conversation.ts` + `scripts/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）

`conversation.ts` 演示的「流式输入 + 流式输出」模式即为适配层的参考蓝本：

- **`query()` 签名**：`query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query`。
- **`Query`**：`interface Query extends AsyncGenerator<SDKMessage, void>`，含控制方法：`interrupt(): Promise<SDKControlInterruptResponse | undefined>`、`setPermissionMode(mode)`、`setModel(model?)`、`supportedModels(): Promise<ModelInfo[]>`、`initializationResult(): Promise<SDKControlInitializeResponse>`（其 `models: coreTypes.ModelInfo[]`）、`supportedCommands()`、`supportedAgents()` 等。
- **`SDKMessage`** 联合（约 50 种）；与本适配相关的子类型：
  - `SDKSystemMessage`：`type:'system'; subtype:'init'; session_id; cwd; model; permissionMode; capabilities?; uuid`（首条 init 携带 `session_id` → 适配层由此捕获会话 ID）。
  - `SDKPartialAssistantMessage`：`type:'stream_event'; event: BetaRawMessageStreamEvent; parent_tool_use_id; uuid; session_id`（`includePartialMessages: true` 时产出 token 级增量）。
  - `SDKAssistantMessage`：`type:'assistant'; message: BetaMessage; parent_tool_use_id; error?; uuid; session_id`（完整助手消息，`message.content` 为内容块数组）。
  - `SDKResultMessage = SDKResultSuccess | SDKResultError`：`type:'result'; subtype:'success'|'error_during_execution'|'error_max_turns'|...; total_cost_usd: number; usage; modelUsage; uuid; session_id`（回合结束，携带成本/用量）。
  - `SDKUserMessage`：`type:'user'; message: MessageParam; parent_tool_use_id: string|null; isSynthetic?; uuid?; session_id?`（prompt() 入队时 push 的载荷，`message: { role:'user', content: text }`）。
  - `SDKSessionStateChangedMessage`：`type:'system'; subtype:'session_state_changed'; state:'idle'|'running'|'requires_action'; uuid; session_id`（idle → 可映射 `session.idle`，用于 wait() 事件驱动）。
- **`ModelInfo`**：`{ value: string; resolvedModel?: string; displayName: string; description: string; supportsEffort?; supportedEffortLevels?; supportsAdaptiveThinking?; supportsFastMode?; supportsAutoMode? }`（`value→id`、`displayName→name`、`resolvedModel→variants` 的映射源）。
- **`getSessionMessages(_sessionId, _options?): Promise<SessionMessage[]>`**；`GetSessionMessagesOptions = { dir?; limit?; offset?; includeSystemMessages?; sessionStore? }`；返回 `SessionMessage = { type:'user'|'assistant'|'system'; uuid; session_id; message: unknown; parent_tool_use_id: string|null; parent_agent_id: string|null }`。
- **`Options` 相关字段**（`query()` 第二参）：`cwd?`、`agent?`、`allowedTools?`、`disallowedTools?`、`includePartialMessages?`、`maxTurns?`、`permissionMode?`、`resume?`、`model?`、`includeHookEvents?`、`forwardSubagentText?` 等。

#### 3.3 api.yaml `definitions` —— 适配层权威契约（`src/types.ts` 字段以本文件为准）

文件头注明：paths 的每个路径代表**客户端方法**（`client.<namespace>.<method>`）而非真实 HTTP 端点；字段契约定义在 `definitions`。目标协议参考 `docs/sdk/openapi.json`，源接口参考 SDK v0.3.227。

- **`LocationRef`**：required `[directory]`；props `directory: string`、`workspaceID?: string (pattern ^wrk)`。
- **`ModelRef`**：required `[id, providerID]`；props `id`、`providerID`（本适配层固定 `'anthropic'`）、`variant?`。
- **`TokenUsage`**：props 全可选 `input?/output?/reasoning?: integer`、`cache?: { read?/write?: integer }`。
- **`Cost`**：props `total_cost_usd?: number`、`currency?: string (default "USD")`。
- **`SessionV2Info`**：required `[id, projectID, cost, tokens, time, title, location]`；props `id`（**保留 Claude 原始 session_id，无 `^ses` 前缀**，见 D7）、`parentID?`、`projectID`（由 cwd 编码生成）、`agent?`、`model? (ModelRef)`、`cost (Cost)`、`tokens (TokenUsage)`、`time: { created, updated (required, date-time), archived? }`、`title`、`location (LocationRef)`、`subpath?`、`revert?`。
- **`PromptInput`**：required `[text]`；props `text`、`files?`（`PromptInputFileAttachment`：required `uri`，另 `name?/description?/source?`）、`agents?`（`PromptAgentAttachment`：required `name`，另 `source?`）。
- **`SessionInputAdmitted`**：required `[admittedSeq, id, sessionID, prompt, delivery, timeCreated]`；props `admittedSeq: integer(min 0)`、`id (^msg_)`、`sessionID`、`prompt`、`delivery: 'steer'|'queue'`（本适配层用 queue）、`timeCreated (date-time)`、`promotedSeq?`。
- **`SessionMessage`**（opencode SessionMessage 联合的 User/Assistant/System 子集）：props `id (^msg_)`、`type: 'user'|'assistant'|'system'`、`time?: { created?/completed? }`、`text?`（user/system）、`content?`（assistant 内容块数组）、`finish?`、`cost?`、`tokens?`。
- **`SessionMessagesResponse`**：required `[data, cursor]`；`data: SessionMessage[]`；`cursor: { previous?/next? }`（不透明分页游标）。
- **`ModelV2Info`**：required `[id, providerID, name, status]`；props `id`（映射自 ModelInfo.value）、`providerID`（固定 `'anthropic'`）、`family?`、`name`（映射自 ModelInfo.displayName）、`api?`、`capabilities?`、`variants?`（resolvedModel 保留于此）、`time?: { released? }`、`cost?`、`status: 'alpha'|'beta'|'deprecated'|'active' (default active)`、`enabled?: boolean (default true)`、`limit?: { context?/input?/output? }`。
- **`LocationInfo`**：required `[directory, project]`；props `directory`、`workspaceID? (^wrk)`、`project: { id (required), directory (required) }`。
- **`ModelListResponse`**：required `[location, data]`；`location: LocationInfo`、`data: ModelV2Info[]`。
- **`GlobalEventPayload`**：required `[id, type, properties]`；`id (^evt_)`、`type: string`（如 `session.created` / `message.part.delta` / `message.part.updated` / `session.next.step.ended` / `session.error` / `session.idle`）、`properties: Record<string, unknown>`（常见字段 sessionID、messageID、partID、field、delta、info、finish、cost、tokens、error、status）。
- **`GlobalEvent`**：required `[payload]`；props `directory?`、`project?`、`workspace?`、`payload (GlobalEventPayload)`。**注意：api.yaml 中 directory 可选**。
- **错误类型**（`_tag` 判别式，Effect-style）：
  - `SessionNotFoundError`：required `[_tag, sessionID, message]`，`_tag` enum `SessionNotFoundError`。
  - `TimeoutError`：required `[_tag, message]`，另 `timeoutMs?: integer`。
  - `InvalidRequestError`：required `[_tag, message]`，另 `kind?`、`field?`。
  - （exploreContent 中「等」——若需扩展，可参考 openapi.json 的 43 个 Error schema，见 3.4）

#### 3.4 docs/sdk/openapi.json 目标协议 schema（与 api.yaml 的差异对照）

共 472 个 schemas。目标类型全部存在（除 `TokenUsage`、`Cost` 不是顶层 schema，内联于 SessionV2Info）。

- **`SessionV2Info`**：required `[id, projectID, cost, tokens, time, title, location]`；`additionalProperties: false`。差异：`id` 带 `pattern ^ses`（api.yaml 刻意去掉——适配层保留原始 session_id）；`cost: number`（api.yaml 为 `Cost` 对象）；`tokens` 内联 `{ input/output/reasoning required, cache:{read/write required} }`；`time` 内联 `{ created/updated required, archived? }`（值为 number，api.yaml 为 date-time 字符串）；`revert: RevertState`（required `messageID` ^msg_、`partID?`、`snapshot?`、`diff?`、`files?`）。
- **`SessionMessagesResponse`**：required `[data, cursor]`；`cursor: { previous?/next? }`、`additionalProperties: false`。
- **`SessionMessage`**：`anyOf` 8 种子类型——`SessionMessageAgentSwitched / ModelSwitched / User / Synthetic / System / Shell / Assistant / Compaction`。User/System/Assistant 三个子集（本适配层只用这 3 种）：
  - `SessionMessageUser`：required `[id, time, text, type]`；`id ^msg_`、`text`、`files?/agents?`、`type='user'`。
  - `SessionMessageSystem`：required `[id, time, type, text]`；`id ^msg_`、`type='system'`、`text`。
  - `SessionMessageAssistant`：required `[id, time, type, agent, model, content]`；`content` 数组 anyOf `SessionMessageAssistantText {type:'text', id, text}` / `SessionMessageAssistantReasoning {type:'reasoning', id, text, providerMetadata?}` / `SessionMessageAssistantTool {type:'tool', id, name, provider?, state, time}`。
- **`PromptInput`**：required `[text]`、`additionalProperties: false`；`files: PromptInputFileAttachment[]`（required `uri`）、`agents: PromptAgentAttachment[]`（required `name`）；`Prompt`（SessionInputAdmitted 引用的 prompt）结构与 PromptInput 一致（text/files/agents）。
- **`SessionInputAdmitted`**：required `[admittedSeq, id, sessionID, prompt, delivery, timeCreated]`、`additionalProperties: false`；`id ^msg_`、`sessionID ^ses`、`delivery 'steer'|'queue'`、`timeCreated number`、`promotedSeq?`。
- **`ModelRef`**：required `[id, providerID]`、`additionalProperties: false`。
- **`LocationRef`**：required `[directory]`、`additionalProperties: false`；`workspaceID ^wrk`。
- **`LocationInfo`**：required `[directory, project]`、`additionalProperties: false`；`project` 内联 `{ id, directory }` 均 required。
- **`ModelV2Info`**：required 12 项 `[id, providerID, name, api, capabilities, request, variants, time, cost, status, enabled, limit]`、`additionalProperties: false`；`status` enum `[alpha, beta, deprecated, active]`；`api: ModelApi`、`capabilities: ModelCapabilities {tools:boolean, input:string[], output:string[]}`、`cost: ModelCost[] {tier?, input/output/cache}`。
- **`GlobalEvent`**：required `[directory, payload]`、`additionalProperties: false`——**openapi 中 directory 必填**，与 api.yaml（directory?）不一致；exploreContent 采用 api.yaml 的可选形式。`payload` 为 84 个事件的 `anyOf` 联合（`EventSessionCreated`、`EventMessagePartDelta`、`EventMessagePartUpdated`、`EventSessionNextStepEnded`、`EventSessionError`、`EventSessionIdle` 及 `SyncEvent*` 系列等）。
- 事件 schema 统一形态（如 `EventMessagePartUpdated`）：`{ id (^evt_, required), type ('message.part.updated', enum), properties (required, object) }`——即 `GlobalEventPayload` 的逐类型特化。
- **错误 schema**（43 个）：`SessionNotFoundError { _tag enum 'SessionNotFoundError', sessionID, message }` 三项 required、`additionalProperties: false`；`InvalidRequestError { _tag enum 'InvalidRequestError', message }` required、`kind?/field?`；`BadRequestError { name:'BadRequest', data:{message, kind?} }`、`NotFoundError { name, data }` 等为 REST 风格（`name`+`data`）；**openapi 顶层无 `TimeoutError`**（api.yaml 新增定义）。

#### 3.5 specs/**/*.md 字段约束

- **`session-management/spec.md`**：
  - `session.create` 返回 `SessionV2Info` MUST 含 `id/projectID/time/title/location/cost/tokens`；`location.directory` 等于客户端 cwd；`agent` 透传。
  - `session.messages` 返回 `{ data: SessionMessage[], cursor: { previous?, next? } }`，内部调 `getSessionMessages()`。
  - `session.prompt` input MUST 含 `prompt`（PromptInput，含 `text`）；push 载荷 `{ type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null }`；返回 `SessionInputAdmitted`，含 `sessionID/prompt/delivery/timeCreated/id(^msg_)`；不存在的会话抛 `SessionNotFoundError` 或等价错误。
  - `session.interrupt` 调 `Query.interrupt()`；空闲为 no-op。`session.wait({ timeout })` 超时抛超时错误。
- **`event-streaming/spec.md`**：
  - 每个 GlobalEvent 符合 `{ directory?, project?, workspace?, payload: { id: string (^evt_), type: string, properties: Record<string, unknown> } }`；`payload.id` 以 `evt_` 开头。
  - SDKMessage→GlobalEvent 映射表（payload.type）：`system(init)→session.created`、`stream_event(text_delta)→message.part.delta`、`stream_event(input_json_delta)→message.part.delta`、`assistant→message.part.updated`、`result(success)→session.next.step.ended`、`result(error)→session.error`、`system(session_state_changed idle)→session.idle`；无对应类型静默跳过。
  - `message.part.updated` 的 properties 采用 `{ sessionID, part: TextPart|ToolPart, time }`（与 openapi `EventMessagePartUpdated` 一致）。
- **`model-providers/spec.md`**：
  - `model.list` 返回 `{ location: LocationInfo, data: ModelV2Info[] }`；每项含 `id/providerID/name/status`；`location.directory` 等于客户端 cwd。
  - 映射：`ModelInfo.value→id`、`ModelInfo.displayName→name`、`providerID='anthropic'`、`status='active'`；`resolvedModel` 保留在 variants。

#### 3.6 design.md（D8 工程结构 + D7 ID 策略）

- **D8**：目标结构为根 `package.json`（私有根包，type: module）、`pnpm-workspace.yaml`（`packages: ['packages/*']`）、`tsconfig.base.json`（共享 TS 配置），以及 `packages/sdk/claude/{package.json, tsconfig.json, src/{client,session,model,events,types,session-state}.ts, test/*.test.ts}`。依赖：`@anthropic-ai/claude-agent-sdk` 为 peerDependency（由消费者提供）；`typescript`、`vitest` 为 devDependency。
- **D7**：Claude 原始 `session_id` 不做 `^ses` 前缀转换，直接作为 `SessionV2Info.id`（保证 resume/getSessionMessages 可用）；message/part/event ID 在归一化时按 `^msg_`/`^prt`/`^evt_` 前缀生成。
- **D9**：`model.list()` 惰性初始化并缓存「控制 Query」，`query({ prompt: <空 AsyncIterable>, options: { cwd } })`，复用其 `supportedModels()`/`initializationResult().models`。
- 协议 ID 前缀总则：session `^ses`、message `^msg_`、part `^prt`、event `^evt_`、workspace `^wrk`。
- plan.json 中 `infra-01` 的 acceptance criteria：根 pnpm-workspace.yaml（`packages: ['packages/*']`）+ 根 package.json（private/type: module）；`packages/sdk/claude/package.json` 包名 `@meiyukichan/claude-sdk`、type module、peer `@anthropic-ai/claude-agent-sdk`、dev `typescript`/`vitest`；`tsconfig.json` 继承 base、bundler、strict；`src/types.ts` 导出所列类型且字段与 specs/api.yaml 一致；`tsc --noEmit` 通过。

---

## Supplementary Exploration Result

`experimental.websearch=true`、`experimental.context7=true`。本次参考物（openapi.json / api.yaml / specs / design.md / SDK 类型定义）信息充足且为本地权威来源，无需启用 websearch/context7 补充查询。无额外补充结果。
