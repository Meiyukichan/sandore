# Furina Explore — Exploration Results

# Explore Content

在 `packages/daemon/engine` 按 `docs/engine/agentic-native.md` 实现工作流引擎，评估当前 `packages/sdk/claude`（@meiyukichan/claude-sdk）是否能满足引擎所需的 SDK 接口能力，重点核对**权限申请（permission.asked）**与**问题选择（question.asked）**事件是否已有实现，并列出引擎所需的 SDK 接口缺口（本次任务 = 补足这些接口）。

# Explore Type

repository

# 需求理解

- **What**：将 agentic-native.md 描述的 Harness Workflow Engine V2（DAG 引擎，Stage→Step 两级，AI 驱动的分支/循环/收尾验证，SSE 事件流，权限/问答人机交互，暂停/恢复/重试，崩溃恢复）在 packages/daemon/engine 落地。引擎的 SDK 集成层（文档 §18 `engine/package/internal/sdk/`）与 API 提取层（§19 `sessions.ts`）定义了对底层 LLM SDK 的接口需求。
- **Boundaries**：只评估 `packages/sdk/claude` 与引擎所需 SDK 接口的匹配度；不评估引擎自身设计（DAG/状态机/SSE 管理）。
- **Goal**：逐项比对引擎文档中 SDK 接口需求 vs 当前 claude-sdk 能力，定位缺失接口（尤其权限/问题事件），为「补足 SDK 接口能力」提供依据。

# Exploration Results

## 1. 引擎文档要求的 SDK 接口（agentic-native.md §18/§19/§10）

引擎设计面向 `@codeagent/sdk`（CodeAgent Data API），SDK 集成层四文件：

### §18.1 client.ts — 客户端管理
- `SdkClient` = CodeAgentDataApi；`PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'`；`DEFAULT_PERMISSION_MODE = 'bypassPermissions'`
- `getClient()` / `ensureWorkspace(directory, permissionMode?)`（→ `client.workspaces.create`）/ `setPermissionMode` / `getPermissionMode` / `connectClient` / `setExternalClient` / `invalidateClient`

### §18.2 session.ts — 会话管理（引擎核心依赖）
| 引擎封装函数 | 底层 SDK 方法 | 说明 |
|---|---|---|
| `createSession` | `client.session.create({directory, title, permission: rules, permission_mode})` | 创建会话，注入权限规则数组 + permission_mode |
| `sendChat` | `client.session.promptAsync({sessionID, directory, parts, format:{type:'text'}, permission_mode})` | fire-and-forget 发送，**parts 为结构化数组** |
| `subscribeEvents` | `client.event.subscribe(directory, signal)` | 目录级 SSE 订阅（共享连接） |
| `getSessionMessages` | `client.session.messages({sessionID, directory, limit, before})` | 历史消息，limit/before 分页 |
| `getCommands` / `listHooks` | `client.command.list` / `client.mcp.status` | 命令 / MCP 列表 |
| `abortSession` / `deleteSession` | `client.session.abort` / `client.session.delete` | 暂停用 abort（会话存活），删除 |
| `revertSession` / `unrevertSession` / `forkSession` | `client.session.revert` / `unrevert` / `fork` | **V2.3 重试机制核心依赖**（continue/revert/fork 三种重试模式） |
| `autoReplyPermission` | `client.permission.reply({requestID, reply:'always', directory})` | bypass→全允许；acceptEdits→除 Bash 外允许；default→不自动回复 |
| `subscribeSessionEvents` | `client.event.subscribe` + 子 Agent 追踪 | 从 message.part.updated 提取子 sessionId（tool task/Agent、正则 agentId、subtask part.sessionID） |

### §18.3 utils.ts — 临时会话
- `startTempSession` / `collectTempSession` / `runTempSession`：createSession + sendChat + waitForSessionIdle + readLastTextFromJsonl + deleteSession（供分支评估/收尾验证/参数填充）

### §18.4 sse-manager.ts — SdkSseManager 单例
- per-directory ref-counted SSE、`subscribe(directory, listener)` / `addRef` / `releaseRef` / `setEventPublisher` / `resolveDirectory(sessionId)`
- 需要的 SDK 事件：`session.idle`、`question.asked`、`permission.asked`、`message.part.updated`、`message.part.delta`、`message.updated`

### §10 人机交互 — 权限与问答
- SSE 收到 `question.asked` / `permission.asked` → 路由到 StepRunner → `notifyQuestion/notifyPermission` → 引擎 `addPendingQuestion/addPendingPermission` → 前端展示
- 用户回复 → `engine.replyQuestion(requestId, answers)` / `engine.replyPermission(requestId, 'once'|'always'|'reject')` / `rejectQuestion(requestId)` → 底层 SDK client.reply
- `PendingPermission` 含 `permission, patterns?, metadata?, tool?: {name?, description?, messageID?, callID?}`
- `PendingQuestion.questions: unknown[]`

### §19.6 sessions.ts — API 层 SDK 直通
- `createSessionDir` / `getSessionMsgs` / `sendSessionChat` / `sendSessionCommand` / `abortSessionById` / `revertSessionById` / `unrevertSessionById` / `forkSessionById`
- `listPendingQuestions` / `listPendingPermissions` / `replySessionPermission` / `replySessionQuestion` / `rejectSessionQuestion`
- `providers.ts`：`listProviders` / `listAllModels` / `listProviderModels`（→ `client.model.list`）

## 2. 当前 packages/sdk/claude 现状

包：`@meiyukichan/claude-sdk`（v0.1.0），opencode 协议风格方法级客户端，基于 `@anthropic-ai/claude-agent-sdk`（peerDependency）。**无 HTTP 服务器，方法级调用，流式以 AsyncIterable 返回。**

### 2.1 现有接口面（src/client.ts + session.ts + events.ts + model.ts + session-state.ts）

**client 命名空间**：
- `client.session.create({model, agent, location/cwd, firstMessage, initTimeoutMs, allowedTools, disallowedTools, permissionMode, systemPrompt, maxTurns, thinking, toolAuth})` → SessionV2Info
- `client.session.messages(sessionId, {limit, cursor, order})` → SessionMessagesResponse
- `client.session.prompt(sessionId, {prompt:{text, files?, agents?}, delivery})` → SessionInputAdmitted（queue 语义 = fire-and-forget）
- `client.session.interrupt(sessionId)` / `wait(sessionId, {timeout})`
- `client.session.events(sessionId)` → AsyncIterable<GlobalEvent>（会话级回放）
- `client.session.respondPermission(sessionId, {requestID, reply:'once'|'always'|'reject'})`
- `client.session.respondQuestion(sessionId, {requestID, answers})`
- `client.model.list({location})` → ModelListResponse
- `client.global.event({directory})` → AsyncIterable<GlobalEvent>（目录级，按 directory 过滤）
- `client.close()`

**GlobalEventType**（types.ts）：`session.created`、`message.part.delta`、`message.part.updated`、`session.next.step.ended`、`session.error`、`session.idle`、`permission.asked`、`permission.replied`、`question.asked`、`question.replied`

### 2.2 权限申请与问题选择事件 —— **已有实现（canUseTool 桥接，session-state.ts）**

- 构造 `SessionState` 时若 `toolAuth !== 'disabled'`，向 query options 注入 `canUseTool`（`bridgeCanUseTool`），并配置 `toolConfig.askUserQuestion.previewFormat`
- `AskUserQuestion` 工具 → **`question.asked`** 事件（properties: `{id: que_<uuid>, sessionID, questions: QuestionInfo[], tool:{messageID, callID}}`），挂起 Promise 至 `respondQuestion`
- 其他受限工具 → **`permission.asked`** 事件（properties: `{id: per_<uuid>, sessionID, permission: "Bash(cmd)", patterns:[], metadata:{toolInput, blockedPath, decisionReason}, always:[], tool:{messageID, callID}}`），挂起至 `respondPermission`
- 回复后产出 `permission.replied` / `question.replied` 控制事件；`pendingPermissions`/`pendingQuestions` 以 requestID 为键
- `respondPermission` 支持 once/always/reject；`respondQuestion` 支持 answers 映射（question→label 或 label 数组）
- 事件通过 `controlEvents` 通道与 SDKMessage 归一化流合并（mergeAsyncIterables），`client.session.events` / `client.global.event` 均可见
- **e2e.ts 已实证**：场景 A（Bash → permission.asked → respondPermission 自动放行）、场景 B（AskUserQuestion → question.asked → respondQuestion 自动回复）

**结论：权限申请与问题选择事件 SDK 已做，且回复链路完整。**

## 3. 差距清单 —— 引擎需要但当前 SDK 缺失/不匹配的接口

### 3.1 功能性缺口（引擎直接依赖）

| # | 引擎需求 | 当前 SDK | 缺口性质 |
|---|---|---|---|
| G1 | `revertSession` / `unrevertSession` / `forkSession`（client.session.revert/unrevert/fork） | **完全不存在**（grep 无 revert/fork 实现，types.ts 仅 `SessionV2Info.revert?` 字段） | **关键缺口**：V2.3 三种重试模式（continue/revert/fork）的 SDK 依赖，引擎 §18.2/§20.2/§19.6 多处引用 |
| G2 | `sendChat` 支持结构化 **parts 数组**（`Array<{type:'text', text:string}>`） | `prompt()` 仅接受 `prompt.text`（单文本），内部 makeUserMessage 包装为单个 content 字符串 | 引擎 §6.2 用 4 段结构化 XML parts（`## 你的任务`/`## 参考信息`/`## 前置Steps输出与产物`/`## 任务规则`）发送；BranchEvaluator/utils 也传 parts。**需补 parts 入参** |
| G3 | `rejectQuestion(requestId)`（问题拒绝，emit `workflow.question_rejected`） | `respondQuestion` 只能回答案，**无拒绝路径**；`respondPermission` 有 reject | 引擎 §10.1/§19.6 `rejectSessionQuestion` 依赖。openapi.json 有 `v2.session.question.reject` / `question.reject` 对照 |
| G4 | `listPendingPermissions` / `listPendingQuestions` | **不存在** | 引擎 §19.6 sessions.ts API 依赖（openapi.json 有 `v2.permission.request.list`/`v2.session.permission.list`/`v2.question.request.list`/`v2.session.question.list`） |
| G5 | `client.event.subscribe(directory, signal)` 目录级订阅带 **AbortSignal** | `global.event({directory})` 可用（目录过滤已实现），但**无 signal 参数**（需手动 break 循环） | 引擎 SdkSseManager/API events 依赖 signal 中断 |
| G6 | `getSessionMessages` 的 **before（messageID 分页）** | `messages()` 用 offset 游标 | 引擎 §18.2/§19.6 传 `before`。部分匹配（limit 有，before 无） |
| G7 | `session.abort`（暂停中止、会话存活）+ `session.delete` | `interrupt()`（Query.interrupt，空闲 no-op，功能等价 abort）；`close()` 仅客户端清理，**无服务端 delete** | abort 部分匹配（命名不同）；delete 缺口（引擎 §18.2 deleteSession） |
| G8 | `sendSessionCommand` / `client.command.list`（斜杠命令） | **不存在** | 引擎 §19.6 `sendSessionCommand`、§18.2 `getCommands` 依赖（次要） |
| G9 | `client.mcp.status`（listHooks） | **不存在** | 引擎 §18.2 `listHooks` 依赖（次要） |

### 3.2 接口形态/命名不匹配（能力近似，需适配映射）

| # | 引擎需求 | 当前 SDK | 说明 |
|---|---|---|---|
| G10 | `client.workspaces.create`（ensureWorkspace） | 无 workspace 概念；`location.directory` 即目录 | 语义等价（cwd 即工作区），surface 不同，适配层可 no-op |
| G11 | `session.create({directory, title, permission: rules[], permission_mode})` | `create({cwd, title?, permissionMode, allowedTools, toolAuth, model})` | 引擎用权限规则数组（ALLOW_ALL_TOOLS 12 项 / ALLOW_EDIT_TOOLS 11 项）注入；当前 SDK 用 `permissionMode`+`allowedTools`，机制不同但功能覆盖；`SessionV2Info.title` 恒为 ''（未从 create 透传）；providerId 固定 'anthropic' |
| G12 | `client.model.list` 聚合 Provider（listProviders/listAllModels） | `model.list()` 返回扁平 ModelV2Info[]，providerID 固定 'anthropic'，无 provider 分组 | 部分匹配 |
| G13 | 子 Agent 追踪（message.part.updated 中提取子 sessionId：tool task/Agent、正则 agentId、subtask part.sessionID） | 归一化为 ToolPart（tool/callID/metadata.input），**无 subtask 类型映射、无子 sessionId 字段**；子会话 ID 仅在工具入参 metadata.input 内可见 | 部分匹配，需验证 Claude SDK 子 Agent 事件形状；引擎可自行从 metadata.input 提取 |
| G14 | per-prompt `permission_mode` 传递 | `permissionMode` 仅 create 时生效；prompt() 无此参数 | 引擎 sendChat 每次传 permission_mode。当前 SDK 需补 per-prompt 参数或靠 create 时确定 |

### 3.3 打包/入口缺口

- `packages/sdk/claude` **无 index.ts 入口**（src 仅 client/events/model/session/session-state/types 六文件），`package.json` 无 `main`/`module`/`exports`/`types` 与 build 脚本；当前仅能源码路径直引（e2e.ts 即 `import ... from '../packages/sdk/claude/src/client'`）。引擎落地时需要正式包入口与构建产物。

## 4. 结论

- **权限申请（permission.asked）与问题选择（question.asked）事件：SDK 已完整实现**（canUseTool 桥接 + pending 挂起 + respondPermission/respondQuestion 回复 + replied 事件 + e2e 实证），且事件载荷与引擎 `PendingPermission`/`PendingQuestion` 结构兼容（permission/patterns/metadata/tool、questions/requestId 均对齐）。
- **引擎所需 SDK 接口存在明确缺口**，核心为：
  1. `revertSession` / `unrevertSession` / `forkSession`（重试机制，最关键的缺失功能）
  2. 结构化 **parts 数组**发送（引擎 4 段 XML 提示词依赖）
  3. **问题拒绝** `rejectQuestion`
  4. `listPendingPermissions` / `listPendingQuestions`
  5. 目录级订阅 AbortSignal、before 分页、session 服务端 delete、session.command、mcp.status 等次要缺口
- 其余大量能力（会话 CRUD、fire-and-forget chat、目录级 SSE、session.idle/message.part.* 事件、model.list、interrupt/wait、权限自动回复底层原语）已具备，但接口命名/形态与引擎文档中 `@codeagent/sdk` 口径不同，落地时需在引擎 SDK 集成层做适配映射。

## 关键文件路径

- 引擎规格：`D:\project-code\llm\sandore\docs\engine\agentic-native.md`（§10 人机交互、§18 SDK 集成层、§19 API 提取层）
- SDK 权限/问题事件实现：`D:\project-code\llm\sandore\packages\sdk\claude\src\session-state.ts`（bridgeCanUseTool/bridgePermission/bridgeQuestion/respondPermission/respondQuestion）
- SDK 事件归一化：`D:\project-code\llm\sandore\packages\sdk\claude\src\events.ts`、`src\types.ts`（GlobalEventType 含 permission.asked/question.asked/replied）
- SDK 会话/客户端：`D:\project-code\llm\sandore\packages\sdk\claude\src\session.ts`、`src\client.ts`、`src\model.ts`
- e2e 实证：`D:\project-code\llm\sandore\scripts\e2e.ts`（场景 A 权限 / 场景 B 问题）
- 归档设计：`D:\project-code\llm\sandore\furina\archive\2026-08-11-claude-sdk-adapter\design.md`、`api.yaml`
- 目标协议对照：`D:\project-code\llm\sandore\docs\sdk\openapi.json`（session.revert/fork/unrevert、question.reject、permission/question.list 等端点）
- 引擎落地目录：`D:\project-code\llm\sandore\packages\daemon\engine`（当前为空）
