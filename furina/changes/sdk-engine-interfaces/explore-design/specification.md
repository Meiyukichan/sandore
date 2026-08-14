# Specification Exploration — 工作流引擎所需 SDK 接口能力评估

> 探索日期: 2026-08-12
> 规格来源: `docs/engine/agentic-native.md`（Harness Workflow Engine V2 技术设计文档, v2.3）
> 被评估对象: `packages/sdk/claude`（`@meiyukichan/claude-sdk` 适配层）
> 参考归档: `furina/archive/2026-08-11-claude-sdk-adapter/`（design.md / specs / api.yaml）
> 引擎目标目录: `packages/daemon/engine/`（当前为空目录）

---

## 1. 需求理解（Explore Content 分析）

**What**: 用户计划在 `packages/daemon/engine` 实现 `docs/engine/agentic-native.md` 描述的 Harness Workflow Engine V2（Stage→Step 两级 DAG 工作流引擎）。本次探索评估当前 `packages/sdk/claude` 适配层能否满足引擎文档中「SDK 集成层」（§18）、「API 提取层与 SDK 包」（§19）、「人机交互—权限与问答」（§10）、「SSE 事件流架构」（§9）所需的 SDK 接口能力；**重点核实权限申请（permission.asked）与问题选择（question.asked）事件在 SDK 中是否已实现**。

**Boundaries**:
- 引擎规格: `docs/engine/agentic-native.md`（重点 §9/§10/§18/§19）
- 被评估源码: `packages/sdk/claude/src/*.ts`（client.ts / session.ts / session-state.ts / events.ts / model.ts / types.ts）
- SDK 测试: `packages/sdk/claude/test/*.ts`
- SDK 设计归档: `furina/archive/2026-08-11-claude-sdk-adapter/`
- `docs/engine/MASE.md` 为另一独立引擎规格（MASE V3 动态编排），不在本次 exploreContent 范围内，未纳入评估。

**Goal**: 给出当前 SDK 已满足 / 部分满足 / 缺失的接口能力清单，明确权限申请与问题选择事件的现状，为后续「补足 SDK 接口能力」提供事实依据。

---

## 2. 当前 SDK 能力盘点

`packages/sdk/claude` 是「Claude Code SDK（`@anthropic-ai/claude-agent-sdk`）→ opencode 协议风格方法级客户端」的适配层。客户端工厂 `createClaudeClient({ cwd })` 返回 `{ session, model, global }` 三个命名空间，不启动 HTTP 服务器（进程内使用）。

### 2.1 客户端命名空间与方法（src/client.ts）

| 命名空间 | 方法 | 签名要点 | 说明 |
|---|---|---|---|
| `session` | `create` | `(options?) → Promise<SessionV2Info>` | 支持 model/agent/location/cwd/firstMessage/allowedTools/disallowedTools/permissionMode/systemPrompt/maxTurns/thinking/toolAuth |
| `session` | `messages` | `(sessionId, options?) → Promise<SessionMessagesResponse>` | limit/cursor/order 分页 |
| `session` | `prompt` | `(sessionId, input) → Promise<SessionInputAdmitted>` | 向输入队列 push（fire-and-forget），匹配引擎 sendChat 语义 |
| `session` | `interrupt` | `(sessionId) → Promise<void>` | 中断当前 agent loop（空闲 no-op） |
| `session` | `wait` | `(sessionId, {timeout}?) → Promise<void>` | 事件驱动等待空闲 |
| `session` | `events` | `(sessionId) → AsyncIterable<GlobalEvent>` | 会话级归一化事件流 |
| `session` | `respondPermission` | `(sessionId, {requestID, reply}) → void` | reply: once/always/reject（canUseTool 桥接回复） |
| `session` | `respondQuestion` | `(sessionId, {requestID, answers}) → void` | answers: question→label 映射 |
| `model` | `list` | `(options?) → Promise<ModelListResponse>` | providerID 固定 'anthropic' |
| `global` | `event` | `(options?) → AsyncIterable<GlobalEvent>` | 目录级全局事件流（directory 过滤） |
| — | `close` | `() → void` | 关闭全部会话 + 控制 Query |

### 2.2 事件类型（src/types.ts GlobalEventType）

```
session.created | message.part.delta | message.part.updated | session.next.step.ended
session.error   | session.idle      | permission.asked     | permission.replied
question.asked  | question.replied
```

**关键结论：权限申请事件（permission.asked）与问题选择事件（question.asked）在 SDK 中已实现**，通过 canUseTool 桥接产出（src/session-state.ts）：
- 受限工具（permissionMode='default' 时，如 Bash/Write）→ `permission.asked`（properties.id 为 `per_` 前缀 requestID，含 permission/patterns/metadata/tool 字段），Promise 挂起等待 `respondPermission`。
- `AskUserQuestion` 工具 → `question.asked`（properties.id 为 `que_` 前缀 requestID，含 questions: QuestionInfo[]），Promise 挂起等待 `respondQuestion`。
- 回复后分别产出 `permission.replied` / `question.replied` 控制事件。
- 桥接开关 `toolAuth: 'bridge' | 'disabled'`（缺省 bridge）；`toolConfig.askUserQuestion.previewFormat = 'markdown'`。
- 测试覆盖完整：`test/session.test.ts`「canUseTool 桥接（权限/问题）」describe 块（inject/once/reject/question/合并流 6 例）；`test/events.test.ts` 有「消息流挂起时控制事件仍被消费」测试。

事件消费路径：`client.session.events(sessionId)` 或 `client.global.event({ directory })`（目录过滤，与引擎 SdkSseManager per-directory 订阅方向一致）。`session.idle` 事件 properties 含 sessionID，可支撑引擎 `sessionIdleResolvers` 路由。

### 2.3 权限/问题数据结构（src/session-state.ts）

- `PermissionRequestInfo { id(^per_), sessionID, permission, patterns, metadata, always, tool:{messageID, callID} }` — permission.asked 的 properties。
- `QuestionRequestInfo { id(^que_), sessionID, questions: QuestionInfo[], tool }` — question.asked 的 properties。
- `QuestionInfo { question, header, options: QuestionOption[], multiple?, custom? }` — 对应引擎 PendingQuestion.questions 元素。
- `RespondPermissionInput { requestID, reply: 'once'|'always'|'reject' }` — 对应引擎 PendingPermission.answer 枚举。
- `RespondQuestionInput { requestID, answers: QuestionAnswer }`。
- permissionMode 透传：`bypassPermissions`/`acceptEdits` 由 Claude SDK 自动放行（canUseTool 不触发）；`default` 才触发桥接事件——与引擎 §18.1 三种权限模式行为一致。

---

## 3. 与引擎文档所需 SDK 接口的对照

### 3.1 SDK 集成层（§18.2 会话管理）对照

| 引擎需求 | 引擎调用方式 | 当前 SDK 状态 | 差异说明 |
|---|---|---|---|
| `createSession` | `client.session.create` | ✅ 满足 | 支持 permission_mode 透传；缺 permission 规则数组注入（引擎用 ALLOW_ALL_TOOLS 12 项/ALLOW_EDIT_TOOLS 11 项，当前 SDK 靠 permissionMode 让 Claude SDK 处理） |
| `sendChat` | `client.session.promptAsync` | ✅ 满足 | fire-and-forget 语义一致；`client.session.prompt` push 即返回 |
| `subscribeEvents` | `client.event.subscribe` | 🟡 部分 | 有 `client.global.event({directory})` 目录级全局事件流；但为进程内内存 ReplayChannel，非独立订阅接口，无 AbortSignal/断线重连（重连由引擎侧 SdkSseManager 自行实现） |
| `getSessionMessages` | `client.session.messages` | ✅ 满足 | 分页/排序已支持 |
| `getCommands` | `client.command.list` | ❌ 缺失 | 无 `command` 命名空间 |
| `listHooks` | `client.mcp.status` | ❌ 缺失 | 无 `mcp` 命名空间 |
| `abortSession` | `client.session.abort` | 🟡 部分 | 有 `client.session.interrupt`（中断当前 agent loop、保留会话）；引擎暂停语义 `session.abort()` 可映射到 interrupt，但无独立 `session.delete` 清理 |
| `deleteSession` | `client.session.delete` | ❌ 缺失 | 无删除会话方法（仅内部 `close()` 清理内存态） |
| `revertSession` | `client.session.revert` | ❌ 缺失 | 引擎 V2.3 重试机制 revert 模式必需 |
| `unrevertSession` | `client.session.unrevert` | ❌ 缺失 | 同上 |
| `forkSession` | `client.session.fork` | ❌ 缺失 | 引擎 V2.3 重试机制 fork 模式必需 |

### 3.2 权限自动回复（§18.2 autoReplyPermission / §10.3）

引擎 SDK 集成层通过 `client.permission.reply({ requestID, reply: 'once'|'always'|'reject', directory })` 以**目录级**方式自动/手动回复权限。当前 SDK：
- 🟡 **无目录级 `client.permission.reply` 接口**；回复是**会话级**的 `client.session.respondPermission(sessionId, {requestID, reply})`，需先由事件中的 sessionID 定位会话。
- ✅ permissionMode 行为（bypassPermissions→全允许 / acceptEdits→排除 Bash / default→不自动回复）由 Claude SDK 原生处理，引擎侧无需自行实现 autoReplyPermission 的规则表（ALLOW_ALL_TOOLS/ALLOW_EDIT_TOOLS 常量在 SDK 中不存在，需引擎自行定义或在适配层补齐）。

### 3.3 会话直通 API（§19.6 api/sessions.ts）对照

| 引擎 API | 当前 SDK 支撑 | 说明 |
|---|---|---|
| `createSessionDir` | ✅ `client.session.create` | |
| `getSessionMsgs` | ✅ `client.session.messages` | |
| `sendSessionChat` | ✅ `client.session.prompt` | |
| `sendSessionCommand` | ❌ | 依赖缺失的 `command` 命名空间 |
| `abortSessionById` | 🟡 `client.session.interrupt` | |
| `revertSessionById` / `unrevertSessionById` / `forkSessionById` | ❌ | 依赖缺失的 revert/unrevert/fork |
| `listPendingQuestions` / `listPendingPermissions` | ❌ | 无目录级待处理请求查询；当前 SDK 挂起请求仅存在于 SessionState 内部 Map，且事件流为内存回放 |
| `replySessionPermission` | 🟡 `client.session.respondPermission` | 会话级，需 requestID 定位 |
| `replySessionQuestion` | 🟡 `client.session.respondQuestion` | 会话级 |
| `rejectSessionQuestion` | 🟡 可经 `respondQuestion` 空答模拟 | 无独立 reject 语义（respondQuestion 无 reject 选项） |

### 3.4 SSE 事件流（§9）对照

| 引擎事件依赖 | 当前 SDK | 说明 |
|---|---|---|
| `session.idle` | ✅ 有 | properties 含 sessionID |
| `question.asked` | ✅ 有（canUseTool 桥接） | |
| `permission.asked` | ✅ 有（canUseTool 桥接） | |
| `message.part.updated` | ✅ 有 | 仅产出 TextPart / ToolPart（completed 变体）；**subtask 内容块被静默跳过**（events.ts mapContentBlock 仅处理 text/tool_use）→ 引擎「子 Agent 会话追踪」（从 part 中提取子 sessionId）无法在 SDK 层完成，需引擎另辟途径或适配层补 subtask 事件 |
| `message.part.delta` | ✅ 有 | text / tool_input 两种 field |
| 事件 ID 规范化 | ✅ | evt_/msg_/prt_ 前缀生成 |
| jsonl 会话持久化 / 断点续传 | ❌ | 引擎 V2.3 `readLastTextFromJsonl`/`~/.harness/sessions/{sessionId}.jsonl` 需引擎侧 SdkSseManager 自行实现（SDK 不负责） |

### 3.5 其它工具函数（§18.2 辅助）

- `stripThinkTags` / `readLastTextFromJsonl` / `reconstructMessagesFromJsonl` / `appendMessagesToJsonl`：均为引擎 SDK 集成层工具，当前 SDK **不含**（引擎自实现）。
- `getSessionMessages` jsonl 混合策略（jsonl 优先 + SDK 回退）：当前 SDK `client.session.messages` 直接调 Claude SDK `getSessionMessages`，无 jsonl 层。

---

## 4. 结论摘要

**权限申请与问题选择事件：SDK 已实现（重点确认项）**
- `permission.asked` / `question.asked` 事件 + `respondPermission`（once/always/reject）`/`respondQuestion` 回复已存在于 `client.session` 命名空间，基于 canUseTool 桥接，测试覆盖完整。引擎可直接消费事件并回复。
- 但回复为**会话级**（需 sessionID），引擎文档假定的**目录级** `client.permission.reply({requestID, reply, directory})` 与 `listPendingQuestions/listPendingPermissions` 在 SDK 中**不存在**。

**主要缺口（引擎 V2.3 特性依赖）**
1. `session.revert` / `unrevert` / `fork` — 重试机制（continue/revert/fork 三模式）必需。
2. `session.delete` / `session.abort`（有 interrupt 近似）— 会话生命周期管理。
3. `command.list` / `mcp.status` — 引擎 getCommands / listHooks 直通能力。
4. 子 Agent 会话追踪 — SDK 归一化跳过 subtask 内容块，无法从 message.part.updated 提取子 sessionId。
5. 目录级待处理交互查询与回复（listPending* / reply*Permission|Question / rejectQuestion）。

**架构适配注意**
- 引擎文档基于 `@codeagent/sdk`（CodeAgentDataApi: session.create/promptAsync/abort/delete/revert/unrevert/fork、event.subscribe、command.list、mcp.status、permission.reply），而当前 `packages/sdk/claude` 是 **opencode 协议风格方法级适配层**（createClaudeClient）。接口命名不同（prompt vs promptAsync、interrupt vs abort、global.event vs event.subscribe），引擎 SDK 集成层需要做一层命名/语义适配，而非直接使用。
- 当前 SDK 无 HTTP 服务器、无进程启动管理（引擎 §18.1 的 Connect/Auto-Start 启动 launcher、TTL 缓存等由引擎 client.ts 自行实现）。

**与引擎空目录状态**
- `packages/daemon/engine/` 为空目录，引擎尚未实现；`docs/engine/` 下另有 `MASE.md`（独立引擎规格，不在本次范围）。

---

## 5. 关键文件路径

| 文件 | 说明 |
|---|---|
| `D:\project-code\llm\sandore\docs\engine\agentic-native.md` | 引擎规格（v2.3），§9/§10/§18/§19 为 SDK 接口需求来源 |
| `D:\project-code\llm\sandore\packages\sdk\claude\src\client.ts` | 客户端工厂与命名空间定义 |
| `D:\project-code\llm\sandore\packages\sdk\claude\src\session.ts` | SessionManager：create/messages/prompt/interrupt/wait/events/respondPermission/respondQuestion |
| `D:\project-code\llm\sandore\packages\sdk\claude\src\session-state.ts` | SessionState + canUseTool 桥接（permission.asked/question.asked 产出与挂起） |
| `D:\project-code\llm\sandore\packages\sdk\claude\src\events.ts` | GlobalEventManager：SDKMessage→GlobalEvent 归一化、目录过滤 |
| `D:\project-code\llm\sandore\packages\sdk\claude\src\types.ts` | GlobalEventType 联合（含 permission.asked/question.asked）、PermissionReply/QuestionInfo 类型 |
| `D:\project-code\llm\sandore\packages\sdk\claude\test\session.test.ts` | canUseTool 桥接（权限/问题）测试覆盖 |
| `D:\project-code\llm\sandore\furina\archive\2026-08-11-claude-sdk-adapter\` | SDK 适配层设计归档（design.md / api.yaml / specs） |
