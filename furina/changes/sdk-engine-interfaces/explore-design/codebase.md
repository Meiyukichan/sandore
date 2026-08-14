## Exploration Result

### 需求理解（Phase 2）

- **What**：用户计划在 `packages/daemon/engine` 基于 `docs/engine/agentic-native.md` 实现工作流引擎。本次任务为评估当前 `packages/sdk/claude`（`@meiyukichan/claude-sdk`）能否满足该引擎所需的 SDK 接口能力，重点核查「权限申请」与「问题选择」事件是否已有 SDK 实现，并梳理缺口以供后续补足。
- **Boundaries**：引擎文档 `docs/engine/agentic-native.md`（重点 §9 SSE、§10 人机交互、§13 暂停/恢复、§18 SDK 集成层、§19 API 提取层、§20 重试）；SDK 源码 `packages/sdk/claude/src/*.ts` 与测试；底层 `@anthropic-ai/claude-agent-sdk` 类型定义。
- **Goal**：逐项比对引擎文档对 SDK 的方法调用假设与当前 SDK 实际 API 表面，产出「已有 / 缺失 / 形态不一致」三类结论。
- **Project Context**：sandore monorepo。`packages/sdk/claude` 是将 Claude Code SDK（`@anthropic-ai/claude-agent-sdk`）适配为 opencode 协议风格方法级客户端的适配层（`createClaudeClient`）。引擎文档 `agentic-native.md` 是按另一套 SDK（`@codeagent/sdk` / `CodeAgentDataApi`，含 `client.session.promptAsync` / `client.permission.reply` / `client.session.revert` 等）编写的，与本仓库 SDK 的方法命名与签名存在系统性差异。

### 引擎文档对 SDK 的调用假设（§18 / §19 / §10 / §20 提取）

| 引擎层使用点 | 文档假设的 SDK 方法 | 文档签名要点 |
|---|---|---|
| `session.ts` createSession | `client.session.create` | 注入 `permission` 规则数组 + `permission_mode` + `title/providerId/modelId` |
| `session.ts` sendChat | `client.session.promptAsync` | fire-and-forget；`parts: Array<{type:'text',text}>` 或 `message`；携带 `permission_mode` |
| `session.ts` subscribeEvents | `client.event.subscribe(directory, signal)` | 目录级 SSE 事件流 |
| `session.ts` getSessionMessages | `client.session.messages` | `{sessionID, directory, limit, before}` 分页 |
| `session.ts` getCommands / listHooks | `client.command.list` / `client.mcp.status` | 命令与 MCP 查询 |
| `session.ts` abort/delete | `client.session.abort` / `client.session.delete` | 暂停时 abort 当前回合、清理会话 |
| `session.ts` revert/unrevert/fork | `client.session.revert` / `.unrevert` / `.fork` | 重试三模式（§20.2） |
| `session.ts` autoReplyPermission | `client.permission.reply({requestID, reply, directory})` | 权限自动回复（bypass/acceptEdits/default） |
| `sse-manager.ts` SdkSseManager | `subscribeEvents` + 事件规范化 | `session.idle` / `question.asked` / `permission.asked` / `message.part.updated`（子 Agent 追踪） |
| `utils.ts` 临时会话 | create + sendChat + wait idle + 读输出 | `startTempSession` / `collectTempSession` / `runTempSession` |
| `client.ts` 客户端 | `client.workspaces.create`（ensureWorkspace） | 幂等初始化 workspace |
| 运行时权限模式（V2.3） | `updateInstancePermissionMode` → 新会话生效 | 实例级 `permissionMode` 动态切换 |

### 当前 SDK（`@meiyukichan/claude-sdk`）API 表面

入口：`src/client.ts` 的 `createClaudeClient({cwd})`，返回 `ClaudeClient`：
- `session.create(options)` — 支持 `firstMessage`/`model`/`agent`/`location`/`cwd`/`allowedTools`/`disallowedTools`/`permissionMode`/`systemPrompt`/`maxTurns`/`thinking`/`toolAuth`；返回 `SessionV2Info`（保留 Claude 原始 session_id）。
- `session.messages(sessionId, {limit, cursor, order})` — 返回 `{data, cursor}`。
- `session.prompt(sessionId, {prompt:{text, files?, agents?}, delivery, resume})` — 文本单条入队，返回 `SessionInputAdmitted`（fire-and-forget）。
- `session.interrupt(sessionId)` — 中断当前执行（暂停语义）。
- `session.wait(sessionId, {timeout})` — 等待空闲。
- `session.events(sessionId)` — 会话级 `AsyncIterable<GlobalEvent>`（SDKMessage 归一化流 + canUseTool 控制事件流合并）。
- `session.respondPermission(sessionId, {requestID, reply})` — 权限回复。
- `session.respondQuestion(sessionId, {requestID, answers})` — 问题回复。
- `model.list({location})` — 模型列表。
- `global.event({directory})` — 目录级全局事件流（等同文档的 `event.subscribe(directory)`）。
- `close()`。

### 权限申请与问题选择事件（用户重点关注项）— **已实现**

`src/session-state.ts` 的 canUseTool 桥接（已提交 b46d5cd，含测试）：
- **permission.asked**：`bridgePermission()` 产出 `GlobalEvent`，`properties = {id: per_<uuid>, sessionID, permission: "Bash(...)", patterns: [], metadata: {toolInput, blockedPath, decisionReason}, always: [], tool: {messageID, callID}}`；`requestID` 即 `properties.id`。
- **question.asked**：`bridgeQuestion()`（AskUserQuestion 工具）产出 `GlobalEvent`，`properties = {id: que_<uuid>, sessionID, questions: QuestionInfo[], tool: {...}}`；`QuestionInfo = {question, header, options: QuestionOption[], multiple?, custom?}`。
- **permission.replied / question.replied**：`respondPermission` / `respondQuestion` 回复后产出控制事件。
- **回复入口**：`client.session.respondPermission(sessionId, {requestID, reply:'once'|'always'|'reject'})`、`client.session.respondQuestion(sessionId, {requestID, answers: Record<string, string|string[]>})`。
- **事件可达性**：`session.events(id)` 将 canUseTool 控制事件流与 SDKMessage 归一化流 `mergeAsyncIterables` 合并；`global.event({directory})` 亦会投递（`GlobalEventManager.feedGlobal` 全量投递）。引擎的目录级 SSE 订阅可收到 `permission.asked` / `question.asked`。
- **测试覆盖**：`test/session.test.ts` L859（question.asked + respondQuestion）、`test/events.test.ts` L709/L731（permission.asked + respondPermission）；`test/types.test.ts` L304（GlobalEventType 含 question.asked）。

**形态差异（引擎文档 vs 当前 SDK）**：
1. 文档的 `client.permission.reply({requestID, reply, directory})`（无 sessionId 参数）→ 当前为 `client.session.respondPermission(sessionId, {requestID, reply})`（需 sessionId）。引擎可从 `permission.asked` 事件的 `properties.sessionID` 取得 sessionId，功能可覆盖，但接口名/签名需引擎适配。
2. 引擎 `PendingQuestion.answer` 为 `string[][]`、`replyQuestion(requestId, answers: string[][])`；当前 SDK `respondQuestion` 的 `answers: QuestionAnswer = Record<string, string|string[]>`（question→label 映射）。形状不同，需引擎层转换。
3. 引擎 `PendingPermission.answer` 为 `'once'|'always'|'reject'`，与 SDK `PermissionReply` 一致，可直接映射。
4. `bypassPermissions`/`acceptEdits` 模式：当前 SDK 将 `permissionMode` 透传给 Claude SDK query options，但**未传 `allowDangerouslySkipPermissions: true`**（Claude SDK 对 bypassPermissions 的硬性要求），故 bypass 模式下受限工具仍会走 canUseTool → `permission.asked`，由引擎 autoReply 兜底放行（功能上仍可 bypass，但多一次事件往返）。

## Supplementary Exploration Result

### 逐项缺口比对（引擎文档假设 vs 当前 SDK）

**A. 已覆盖（功能等价，命名/机制不同）**
1. 创建会话 — `session.create`（含 `permissionMode`；文档的 `permission` 规则数组注入改为 SDK 原生 `permissionMode` + canUseTool 桥接，三模式行为等价）。
2. 发送聊天（fire-and-forget）— `session.prompt` 返回 Promise 即入队不等待结果，等价文档 `promptAsync` 的 fire-and-forget 语义。
3. 目录级 SSE — `global.event({directory})` 等价文档 `event.subscribe(directory)`；`session.idle`（properties.sessionID）、`message.part.delta/updated`、`session.next.step.ended` 均已归一化产出。
4. 中断/暂停 — `session.interrupt` 等价文档 `session.abort`（Claude SDK `Query.interrupt()`，空闲 no-op；恢复用同一会话 `prompt` 发送 resumePrompt）。
5. 会话消息读取 — `session.messages` 覆盖文档 `getSessionMessages`（cursor 分页替代 before 分页）。
6. 模型列表 — `model.list` 覆盖 `listProviders`/`listAllModels`（providerID 固定 'anthropic'）。

**B. 形态差异（需引擎适配）**
1. **结构化 parts 数组**：文档 `sendChat` 传 `parts: Array<{type:'text',text}>`（引擎构建 `## 你的任务`/`## 参考信息`/`## 前置Steps输出与产物`/`## 任务规则` 四个 XML part）；当前 SDK `prompt` 仅接受单个文本字符串（`PromptInput.text`），`makeUserMessage` 仅构造 string content。**缺口**：需 SDK 支持 parts 数组（Claude SDK content 支持 block 数组）或引擎自行拼接。
2. **per-message `permission_mode`**：文档 V2.3 在 `sendChat`/`promptAsync` 级传 `permission_mode`；当前 SDK `prompt` 无该参数（仅 create 级有 `permissionMode`）。需 SDK 为 prompt 增加 permissionMode 或暴露 `Query.setPermissionMode()`。
3. **权限/问题回复签名**：见上（respondPermission/respondQuestion 需 sessionId；QuestionAnswer 形状）。

**C. 缺失（当前 SDK 未提供，且底层 SDK 部分能力可补齐）**
1. **revert / unrevert / fork**（重试三模式 §20.2 必需）：当前 SDK 未暴露。底层 `@anthropic-ai/claude-agent-sdk` 仅有 `forkSession(sessionId, options)`（sdk.d.ts L700），**无 revert/unrevert**。需评估：fork 可包装；revert/unrevert 底层不存在，需另寻方案（如基于 getSessionMessages 快照 + fork 模拟，或增加 SDK 新能力）。
2. **deleteSession**：当前 SDK 无 `session.delete`；底层有 `deleteSession()`（sdk.d.ts L530），可包装。
3. **运行时动态权限模式**：当前 SDK 无 `setPermissionMode`；底层 `Query.setPermissionMode(mode)`（sdk.d.ts L2377）存在，可包装（引擎实例级 permissionMode 动态生效需要）。
4. **`client.command.list` / `client.mcp.status`**：当前 SDK 无命令列表与 MCP hooks 查询（文档 `getCommands`/`listHooks` 需要）。
5. **`client.workspaces.create`**（ensureWorkspace）：当前 SDK 无 workspace 命名空间，以 directory 隐式充当 workspace。
6. **子 Agent 会话追踪**（§18.2 subscribeSessionEvents / SdkSseManager）：文档从 `message.part.updated` 的 tool 输出 / `part.type==='subtask'` 提取子 sessionId；当前 SDK 的 `ToolPart` 只有 `state:{status:'completed', input, time}` 与 `metadata:{input}`，**无工具输出、无 subtask part**，且公开事件面仅 GlobalEvent（原始 SDKMessage 流在 SessionManager 内部未暴露）。引擎无法从公开 API 追踪子 Agent 会话 → 子 Agent 的 question/permission 无法路由。需 SDK 增强（捕获工具输出 / 暴露 raw 事件 / 产出 subtask part）。
7. **jsonl 会话持久化**（§18.2 getSessionMessages jsonl-first 混合策略）：当前 SDK 无 jsonl 持久化；此为引擎层 SdkSseManager 职责（写入 `~/.harness/sessions/{id}.jsonl`），SDK 无需改，但引擎需自行实现（含 `stripThinkTags`/`readLastTextFromJsonl` 等辅助，属引擎层代码）。
8. **包入口 index.ts**：`packages/sdk/claude` 无 `index.ts`/`main`/`exports` 字段，当前仅测试经 `../src/*` 直接引用。补足接口前应先建立公共入口。

### 底层 Claude SDK 关键能力核验（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）

- `query({prompt, options}): Query`（L2664），`Query` 接口（L2356）含 `interrupt()`（L2370）、`setPermissionMode(mode)`（L2377）、`setModel()`（L2404）、`supportedModels()`（L2488）、`close()`（L2661）。
- `forkSession`（L700）、`deleteSession`（L530）、`getSessionMessages`（L759）、`getSubagentMessages`（L796）、`listSessions`（L954）、`listSubagents`（L1009）、`renameSession`（L2675）。
- **无 `revertSession` / `unrevertSession` 模块级函数**（grep 仅命中 `direction:'retry'|'revert'|'sticky'` 枚举）。
- Options 含 `permissionMode`（L1763）、`allowDangerouslySkipPermissions`（L1775）、`canUseTool`（L1404）、`abortController`（L1351）；`bypassPermissions` 需 `allowDangerouslySkipPermissions: true`。

### 结论

当前 `packages/sdk/claude` 已具备引擎文档 §10 交互所需的**权限申请与问题选择事件**（canUseTool 桥接产出的 `permission.asked`/`question.asked` 及 `respondPermission`/`respondQuestion`），可支撑引擎交互层；但引擎文档假设的 SDK 表面（§18/§19/§20）与该适配层存在系统性差异，需补足/适配的方向集中在：**结构化 parts 发送、per-message permission_mode、revert/unrevert/fork 重试三件套、deleteSession、运行时 setPermissionMode、command/mcp 查询、子 Agent 会话追踪、包入口 index.ts**。权限/问题的差异集中于回复签名（sessionId 参数与 QuestionAnswer 形状），属引擎层可适配，非阻塞。
