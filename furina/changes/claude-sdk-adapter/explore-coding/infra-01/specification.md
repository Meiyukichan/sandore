# 规范材料探索：根级 pnpm 工作区 + @meiyukichan/claude-sdk 包脚手架 + opencode 协议类型

> 探索类型：specification
> 探索日期：2026-08-11
> 项目路径：`D:\project-code\llm\sandore`
> 输出目录：`furina/changes/claude-sdk-adapter/explore-coding/infra-01`

## 一、需求理解（Phase 2）

### What
本任务（plan.json 中 `infra-01`）包含三部分工程初始化工作：
1. **根级 pnpm 工作区**：创建 `pnpm-workspace.yaml`（`packages: ['packages/*']`）、根 `package.json`（`private`、`type: module`）、`tsconfig.base.json`（ESNext/bundler/strict 共享配置）。
2. **`packages/sdk/claude` 包脚手架**：`package.json` 包名为 `@meiyukichan/claude-sdk`、`type: module`，`@anthropic-ai/claude-agent-sdk` 为 `peerDependency`（由消费者提供），`typescript`/`vitest` 为 `devDependency`；`tsconfig.json` 继承 base。
3. **`src/types.ts`**：导出适配层所需的全部 opencode 协议类型（SessionV2Info、SessionMessagesResponse、SessionMessage、PromptInput、SessionInputAdmitted、ModelRef、LocationRef、LocationInfo、ModelV2Info、GlobalEvent、TokenUsage/Cost 及错误类型）。

### Boundaries
- **源接口**：`@anthropic-ai/claude-agent-sdk` v0.3.227（`scripts/node_modules/.../sdk.d.ts` + `docs/sdk/claude/*.md`）。
- **目标协议**：`docs/sdk/openapi.json`（OpenAPI 3.1.0，title=opencode）。
- **适配层契约**：`furina/changes/claude-sdk-adapter/api.yaml`（Swagger 2.0 方法级客户端契约）+ `specs/**/*.md` + `design.md#D8`。
- **技术栈基线**：`scripts/tsconfig.json` + `scripts/package.json`（ESM、bundler、strict）。
- **输出位置**：`packages/sdk/claude`（当前为空目录）。

### Goal
为 `infra-01` 的实施提供精确的字段级依据：明确 types.ts 中每个类型的字段、必填项、前缀约束，以及脚手架文件的配置基线；同时标注目标协议（openapi.json）与适配层契约（api.yaml）之间的差异，避免类型定义与 specs/api.yaml 不一致。

---

## 二、工程现状

- **根目录**：无根 `package.json`、无 `pnpm-workspace.yaml`、无 `tsconfig.base.json`（均待创建）。git 仅跟踪 `LICENSE`、`README.md`。
- **`packages/sdk/claude`**：空目录（无任何文件）。
- **`scripts/`**（已有，技术栈基线）：npm + tsx，`type: "module"`、`moduleResolution: bundler`、`strict`。
- **`.gitignore`**：忽略 `node_modules/`、`dist/`、`coverage*`、`build/`、`package-lock.json`、`.claude/`、`furina/` 等。
- **`furina config show exploration.specification`**：返回空数组 `[]`，无预置规范材料配置，本次按 exploreContent 直接探索指定参考材料。

---

## 三、脚手架基线（对应 infra-01 任务 1.1 / 1.2）

### 3.1 根级工作区（design.md D8 工程结构 + scripts 基线）

`design.md#D8` 规定目标工程结构：

```
sandore/
  package.json            （私有根包，type: module）
  pnpm-workspace.yaml     （packages: ['packages/*']）
  tsconfig.base.json      （共享 TS 配置）
  packages/sdk/claude/
    package.json          （@meiyukichan/claude-sdk, type: module）
    tsconfig.json         （继承 base, ESNext/bundler/strict）
    src/
      types.ts            （opencode 协议类型：SessionV2Info, ModelV2Info, GlobalEvent, ...）
      ...（client.ts / session.ts / model.ts / events.ts / session-state.ts）
    test/
      *.test.ts
```

`scripts/tsconfig.json` 提供共享 TS 基线（可作为 `tsconfig.base.json` 的参考）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["conversation.ts"]
}
```

`scripts/package.json` 提供包元数据基线：`type: "module"`；devDependencies 用 `typescript: ^5.5.0`；依赖 `@anthropic-ai/claude-agent-sdk`（scripts 中为 `"latest"`，node_modules 实装版本 **0.3.227**）。

### 3.2 packages/sdk/claude 包（design.md D8 依赖约束）

- `@anthropic-ai/claude-agent-sdk` 作为 **peerDependency**（由消费者提供）；版本范围见 design.md Open Questions：建议 `>=0.3.0`（实装 v0.3.227）。
- `typescript`、`vitest` 为 **devDependency**。
- 注意：该 SDK 自身声明 peerDependencies：`@anthropic-ai/sdk` `>=0.93.0`、`@modelcontextprotocol/sdk` `^1.29.0`、`zod` `^4.0.0`（消费者侧需满足，适配层实现时可能引入）。

---

## 四、src/types.ts 协议类型定义（对应 infra-01 任务 1.3）

> **契约口径**：任务要求「字段定义与 specs 及 api.yaml 中 definitions 保持一致」。下表以 `api.yaml` definitions 为适配层权威口径，并交叉标注 `docs/sdk/openapi.json`（目标协议）中对应 schema 的差异。

### 4.1 通用基础类型

**LocationRef**（api.yaml 与 openapi.json 一致）
- 必填：`directory: string`
- 可选：`workspaceID: string`（`pattern: "^wrk"`）

**ModelRef**（api.yaml 与 openapi.json 一致）
- 必填：`id: string`、`providerID: string`
- 可选：`variant: string`

**TokenUsage**（仅 api.yaml 单独定义；openapi.json 中为 SessionV2Info.tokens 内联对象）
- 可选：`input: integer`、`output: integer`、`reasoning: integer`、`cache: { read: integer, write: integer }`
- 差异：openapi.json 内联 tokens 要求 `input/output/reasoning/cache` 全部必填；api.yaml TokenUsage 全部可选。

**Cost**（仅 api.yaml 单独定义；openapi.json 中 SessionV2Info.cost 直接为 `number`）
- 可选：`total_cost_usd: number`、`currency: string`（默认 `"USD"`）
- 差异：openapi.json 的 SessionV2Info.cost 是裸 `number`，api.yaml 重构为 `Cost` 对象。**任务口径以 api.yaml 为准**。

### 4.2 会话管理

**SessionV2Info**（必填项两处完全一致）
- **必填**：`id`、`projectID`、`cost`、`tokens`、`time`、`title`、`location`
- 属性：
  - `id: string` — 适配层保留 Claude SDK 原始 session_id（UUID 形式），不做 `^ses` 前缀转换（design.md D7）；openapi.json 中 id pattern 为 `^ses`（此为偏差，有意为之）
  - `parentID?: string`
  - `projectID: string` — 由 cwd 编码生成
  - `agent?: string`
  - `model?: ModelRef`
  - `cost: Cost`（api.yaml）；openapi.json 为 `number`
  - `tokens: TokenUsage`（api.yaml）；openapi.json 为内联对象且四字段必填
  - `time: { created, updated, archived? }` — api.yaml 为 `format: date-time`（字符串）；**必填 `created`/`updated`**；openapi.json 为 `number`（epoch 毫秒）
  - `title: string`
  - `location: LocationRef`
  - `subpath?: string`
  - `revert?: object`

**PromptInput**（api.yaml 与 openapi.json 一致）
- **必填**：`text: string`
- 可选：
  - `files: PromptInputFileAttachment[]` — 附件，`{ uri: string (必填), name?, description?, source? }`
  - `agents: PromptAgentAttachment[]` — agent 附件，`{ name: string (必填), source? }`

**SessionInputAdmitted**（api.yaml 与 openapi.json 必填项一致）
- **必填**：`admittedSeq`、`id`、`sessionID`、`prompt`、`delivery`、`timeCreated`
- 属性：
  - `admittedSeq: integer`（`minimum: 0`）
  - `id: string`（`pattern: "^msg_"`）— 归一化时生成
  - `sessionID: string`（api.yaml 无 pattern；openapi.json 为 `^ses`）
  - `prompt: Prompt` — 结构含 `text`（`{ text, files?, agents? }`，openapi.json `Prompt` 必填 text）
  - `delivery: "steer" | "queue"` — 适配层当前使用 `queue` 语义
  - `timeCreated: date-time`（api.yaml）；openapi.json 为 `number`
  - `promotedSeq?: integer`（`minimum: 0`）

**SessionMessage**（user/assistant/system 子集）
- api.yaml 描述为「opencode SessionMessage 联合的 User/Assistant/System 子集」，属性：
  - `id: string`（`pattern: "^msg_"`）
  - `type: "user" | "assistant" | "system"`
  - `time: { created, completed? }`
  - `text?: string` — user/system 消息文本
  - `content?: AssistantText[] | AssistantReasoning[] | AssistantTool[]` — assistant 消息内容块
  - `finish?: string`、`cost?: number`、`tokens?: object`
- openapi.json 中 `SessionMessage` 为 anyOf 8 种（User/Synthetic/System/Shell/Assistant/Compaction/AgentSwitched/ModelSwitched），与本次相关的三种：
  - **SessionMessageUser**：必填 `id(^msg_)`/`time{created}`/`text`/`type='user'`；可选 `metadata`/`files`/`agents`
  - **SessionMessageSystem**：必填 `id(^msg_)`/`time{created}`/`type='system'`/`text`
  - **SessionMessageAssistant**：必填 `id(^msg_)`/`time{created}`/`type='assistant'`/`agent`/`model`/`content`；可选 `finish`/`cost: number`/`tokens`/`error`/`snapshot`。content 块：
    - **SessionMessageAssistantText**：`type='text'`，必填 `type`/`id`/`text`
    - **SessionMessageAssistantReasoning**：`type='reasoning'`，必填 `type`/`id`/`text`；可选 `providerMetadata`/`time`
    - **SessionMessageAssistantTool**：`type='tool'`，必填 `type`/`id`/`name`/`state`/`time`；可选 `provider`；state 为 Pending/Running/Completed/Error 联合
- 差异：openapi.json 的 time 为 `number`（epoch）；api.yaml 为 date-time 字符串。适配层以 api.yaml 为准。

**SessionMessagesResponse**（api.yaml 与 openapi.json 一致）
- **必填**：`data: SessionMessage[]`、`cursor`
- 属性：`cursor: { previous?: string, next?: string }`（不透明分页游标）

### 4.3 模型

**ModelV2Info**（api.yaml 必填项为 openapi.json 必填项的子集）
- **必填**（api.yaml）：`id`、`providerID`、`name`、`status`
- 属性：
  - `id: string` — 映射自 `ModelInfo.value`
  - `providerID: string` — 本适配层固定 `'anthropic'`
  - `family?: string`
  - `name: string` — 映射自 `ModelInfo.displayName`
  - `api?: object`
  - `capabilities?: object`（如 supportsEffort/supportsAdaptiveThinking）
  - `variants?: array` — resolvedModel（规范 wire id）保留于此
  - `time?: { released?: date-time }`
  - `cost?: array`
  - `status: "alpha" | "beta" | "deprecated" | "active"`（默认 `"active"`）
  - `enabled?: boolean`（默认 `true`）
  - `limit?: { context?: integer, input?: integer, output?: integer }`
- 差异：openapi.json 的 ModelV2Info 必填远多（id/providerID/name/api/capabilities/request/variants/time/cost/status/enabled/limit），并含 `request` 字段、`status` 无默认值说明。适配层以 api.yaml 为准（缺省字段留空/省略）。

**LocationInfo**（api.yaml 与 openapi.json 一致）
- **必填**：`directory: string`、`project`
- 属性：
  - `directory: string`
  - `workspaceID?: string`（`pattern: "^wrk"`）
  - `project: { id: string (必填), directory: string (必填) }`

**ModelListResponse**（api.yaml；供 model.list 返回）
- **必填**：`location: LocationInfo`、`data: ModelV2Info[]`

### 4.4 事件

**GlobalEvent**（api.yaml 与 specs event-streaming 完全一致）
- **必填**：`payload`
- 属性：
  - `directory?: string` — 事件所属项目目录
  - `project?: string`
  - `workspace?: string`
  - `payload: { id: string, type: string, properties: object }`
    - `id`：`pattern: "^evt_"`（specs 场景：任意 GlobalEvent 的 payload.id 必须以 `evt_` 开头）
    - `type`：opencode 事件类型字符串（session.created / message.part.delta / message.part.updated / session.next.step.ended / session.error / session.idle）
    - `properties`：按类型不同，常见 `sessionID`、`messageID`、`partID`、`field`、`delta`、`info`、`finish`、`cost`、`tokens`、`error`、`status`
- openapi.json 的 GlobalEvent payload 为 anyOf 大量具名事件对象，每个均含 `id(^evt_)`/`type`/`properties` 且三字段必填、`additionalProperties: false`。其中 **EventMessagePartUpdated**（design.md D4 引用）properties 必填 `sessionID`/`part`/`time`（time 为 number）。

### 4.5 错误类型

| 类型 | 必填 | 属性 | 来源 |
|---|---|---|---|
| **SessionNotFoundError** | `_tag`、`sessionID`、`message` | `_tag` enum `["SessionNotFoundError"]`、`sessionID: string`、`message: string` | api.yaml 与 openapi.json 一致 |
| **TimeoutError** | `_tag`、`message` | `_tag` enum `["TimeoutError"]`、`message: string`、`timeoutMs?: integer` | **仅 api.yaml 定义**；openapi.json 无此 schema（适配层自定义错误，用于 session.create 启动超时 / wait 超时） |
| **InvalidRequestError** | `_tag`、`message` | `_tag` enum `["InvalidRequestError"]`、`message: string`、`kind?: string`、`field?: string` | api.yaml 与 openapi.json 一致 |

> openapi.json 中另有其他错误 schema（ConflictError、ServiceUnavailableError、MessageNotFoundError、ProviderNotFoundError、UnknownError 等），但 api.yaml 仅定义上述三个，types.ts 只需覆盖 api.yaml 所列。

---

## 五、@anthropic-ai/claude-agent-sdk 类型参考（适配层实现依据）

来源：`scripts/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（v0.3.227）+ `scripts/conversation.ts` + `docs/sdk/claude/typescript-sdk-api.md`。

### 5.1 与类型定义直接相关的 SDK 类型

- **SDKUserMessage**（流式输入模式 yield 给 query）：`{ type: 'user', message: MessageParam, parent_tool_use_id: string|null, isSynthetic?, shouldQuery?, origin?, uuid?, session_id?, ... }`。prompt 方法 push 的形状见 api.yaml：`{ type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null }`。
- **SDKSystemMessage**（subtype='init'）：`{ type:'system', subtype:'init', uuid, session_id, cwd, model, tools[], mcp_servers[], permissionMode, slash_commands[], skills[], plugins[], capabilities? }` — **session_id 在此捕获**。
- **SDKResultMessage = SDKResultSuccess | SDKResultError**：`{ type:'result', subtype:'success', result, session_id, uuid, duration_ms, total_cost_usd: number, usage: NonNullableUsage, modelUsage: Record<string, ModelUsage>, permission_denials, stop_reason, terminal_reason? }` / error 形态 `subtype:'error_max_turns'` 等、`errors: string[]`。映射为 `session.next.step.ended` / `session.error`。
- **ModelInfo**：`{ value: string, resolvedModel?, displayName: string, description: string, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode? }` → 映射 ModelV2Info（value→id、displayName→name、resolvedModel→variants）。
- **SDKControlInitializeResponse**：`{ commands, agents, output_style, available_output_styles, models: ModelInfo[], account }` — `initializationResult()` 返回值，`models` 用于 model.list。
- **SDK SessionMessage（历史消息）**：`{ type: 'user'|'assistant'|'system', uuid, session_id, message: unknown, parent_tool_use_id: string|null, parent_agent_id: string|null }` — `getSessionMessages()` 返回类型，与 opencode SessionMessage 结构不同，需归一化映射。
- **getSessionMessages(sessionId, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>** — options：`dir`、`limit`、`offset`。注意：Claude SDK 是 limit/offset 分页，opencode 的 SessionMessagesResponse.cursor 是 previous/next 不透明游标（映射差异）。

### 5.2 Query 对象（design.md D2/D5/D9）

- `Query extends AsyncGenerator<SDKMessage, void>`；控制方法：`interrupt(): Promise<SDKControlInterruptResponse|undefined>`、`close()`、`supportedModels(): Promise<ModelInfo[]>`、`initializationResult(): Promise<SDKControlInitializeResponse>`、`setModel()`、`streamInput(stream)` 等。
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options: { cwd, resume?, includePartialMessages, maxTurns, allowedTools?, agent?, model?, ... } }): Query`。
- `conversation.ts` 已验证模式：`query({ prompt: chatStream(), options: { cwd, includePartialMessages: true, ... } })` → for await 消费，`system/init` 取 session_id、`stream_event` 逐 token、`result` 收尾。

---

## 六、关键差异与实现注意事项（供 infra-01 实施）

1. **cost 形态**：目标协议 openapi.json 的 `SessionV2Info.cost` 为裸 `number`；适配层 api.yaml 重构为 `Cost` 对象（`{total_cost_usd, currency}`）。**types.ts 按 api.yaml 定义 `Cost`**。
2. **tokens 形态**：openapi.json 内联对象四字段必填；api.yaml `TokenUsage` 全可选。**types.ts 按 api.yaml 定义 `TokenUsage`**。
3. **time 类型**：openapi.json 用 `number`（epoch 毫秒）；api.yaml 用 `format: date-time`（字符串）且 SessionV2Info.time 必填 `created`/`updated`。**types.ts 按 api.yaml 用 date-time 字符串**。
4. **ID 前缀**：session `^ses`（但适配层保留 Claude 原始 session_id，D7 有意偏差）、message `^msg_`、part `^prt`、event `^evt_`、workspace `^wrk`。GlobalEvent.payload.id 必须 `^evt_`。
5. **peerDependency 版本**：design.md Open Questions 建议 `>=0.3.0`；scripts 实装为 0.3.227。SDK 自身另有 peerDeps（@anthropic-ai/sdk、@modelcontextprotocol/sdk、zod），消费者侧需满足。
6. **ModelV2Info 必填范围**：api.yaml 仅要求 id/providerID/name/status 四项必填，远少于 openapi.json 的十二项——适配层类型按 api.yaml 定义可保持宽松（可选字段可省略）。
7. **ModelRef.variant / ModelV2Info.variants**：`ModelInfo.resolvedModel`（规范 wire id）保留于 `variants`（design.md D9 / specs model-providers 场景）。
