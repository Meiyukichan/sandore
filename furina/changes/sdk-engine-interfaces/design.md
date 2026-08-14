## Context

`packages/sdk/claude`（`@meiyukichan/claude-sdk` v0.1.0）是将 `@anthropic-ai/claude-agent-sdk` 适配为 opencode 协议风格方法级客户端的适配层。当前已实现：会话 CRUD、fire-and-forget prompt、目录级/会话级事件流（归一化为 GlobalEvent）、canUseTool 桥接（permission.asked/question.asked + respondPermission/respondQuestion）、model.list、interrupt/wait。

即将在 `packages/daemon/engine` 落地的 Harness Workflow Engine V2（`docs/engine/agentic-native.md` §9/§10/§18/§19/§20）依赖更完整的 SDK 表面：重试三模式（continue/revert/fork）、结构化 parts 发送、问题拒绝、待处理交互查询、运行时权限切换、子 Agent 追踪、命令/MCP 查询、包入口。

**当前架构关键点**：
- `SessionState`（session-state.ts）封装每个会话的 Query 句柄 + 流式输入队列 + ReplayChannel 事件通道 + canUseTool 桥接；用 `QueryLike` 结构子集接口约束 Query（仅 next/return/throw/interrupt/close）。
- `SessionManager`（session.ts）维护 `Map<sessionId, SessionState>`，注入 `queryFn`（默认 SDK `query`）与 `getSessionMessagesFn`（默认 SDK `getSessionMessages`）。
- `GlobalEventManager`（events.ts）归一化 SDKMessage → GlobalEvent，`StreamNormalizer.mapContentBlock` 仅映射 text 块，subtask 等块静默跳过。
- 客户端工厂 `createClaudeClient`（client.ts）装配 session/model/global 三命名空间。
- 包无 `index.ts`/`main`/`exports`/build，仅测试经源码路径直引。

**底层 SDK 已核验能力**（`@anthropic-ai/claude-agent-sdk` sdk.d.ts）：
- 模块级：`forkSession(sessionId, { upToMessageId?, title?, dir? })`（L700）、`deleteSession(sessionId, { dir? })`（L530）、`getSessionMessages`、`listSessions`、`listSubagents`、`getSubagentMessages`。
- Query 实例方法：`rewindFiles(userMessageId, { dryRun? })`（L2563，需 `enableFileCheckpointing`）、`setPermissionMode(mode)`（L2377，仅 streaming input mode）、`interrupt`、`setModel`。
- query options：`resume`、`resumeSessionAt`（截断到指定 UUID）、`resumeDropsTurn`、`forkSession`（内联 fork）、`enableFileCheckpointing`、`extraArgs`。

## Goals / Non-Goals

**Goals:**
- 补齐引擎 V2.3 所需的全部 SDK 接口缺口（8 类），使 `@meiyukichan/claude-sdk` 可作为引擎 SDK 集成层的直接基座。
- revert/unrevert/fork 基于底层 file-checkpointing + resume 截断 + forkSession 实现，提供对话级与文件级双层回滚语义。
- 建立包公共入口与构建配置，使引擎可经包名 import。
- 保持现有 API 向后兼容（parts 入参兼容单文本；新方法为纯增量）。
- 全部新接口有对应测试覆盖（TDD）。

**Non-Goals:**
- 不实现引擎自身（DAG/状态机/SSE Manager/jsonl 持久化/stripThinkTags 等属 `packages/daemon/engine` 职责）。
- 不实现目录级 `client.permission.reply`（引擎文档假设的目录级回复）；保持会话级回复，引擎从事件 properties.sessionID 路由。
- 不实现 HTTP 服务器或进程启动管理（Connect/Auto-Start launcher 属引擎 client.ts）。
- 不改变现有事件的 GlobalEvent 信封结构（引擎 SdkSseManager 自行解包适配）。
- 不实现 `allowDangerouslySkipPermissions: true` 的自动设置（bypassPermissions 模式仍由 canUseTool 桥接 + 引擎 autoReply 兜底，功能可行）。

## Decisions

### D1: revert/unrevert/fork 实现策略——file-checkpointing + resume 截断 + forkSession

**决策**：revert 采用"fork 到目标点 + 文件 rewind"组合，而非原地截断原会话。

**revert(sessionId, messageID)** 实现：
1. 对话层：调 `forkSession(sessionId, { upToMessageId: messageID, dir })` 分叉出新会话（历史截断到 messageID，丢弃后续）。底层 forkSession 原生支持 `upToMessageId` 切片。
2. 文件层：若原会话启用了 `enableFileCheckpointing`，对原会话 Query 调 `rewindFiles(messageID)` 回滚文件到该消息时的状态。
3. 返回新会话 ID；原会话句柄保留（供 unrevert）。
4. 新会话经 SessionManager 注册（复用 create 的 init 捕获路径：fork 后用空 prompt 或 resume 触发 init 捕获新 sessionId）。

**unrevert(sessionId)** 实现：维护 revert 映射 `newSessionId → originalSessionId`，unrevert 时切回原会话句柄（原会话在 fork 模式下天然存活，未关闭）。语义为"放弃 revert 产生的新会话，回到原会话"。

**fork(sessionId, messageID?)** 实现：调 `forkSession(sessionId, { upToMessageId: messageID, dir })`，原会话不变，返回新会话 ID 并注册。messageID 省略时全量复制。

**备选方案（已否决）**：
- *resume + resumeSessionAt 原地截断*：会破坏原会话历史（不可 unrevert），且 `resumeSessionAt` 的 `resumeDropsTurn` 校验较严格（需精确声明丢弃回合），复杂度高。fork 模式天然保留原会话，更契合引擎"保留回退选项"的语义。
- *仅暴露 fork，revert 标记 NotImplemented*：引擎重试能力受限，不符合"全部补足"要求。

**checkpointing 启用**：`create` 新增 `enableFileCheckpointing` 选项透传给 query options（默认 false，引擎按需开启）。同时透传 `extraArgs: { 'replay-user-messages': null }` 以获取 checkpoint UUID（即 user message 的 uuid）。

### D2: parts 数组发送——扩展 PromptInput 与 makeUserMessage

**决策**：扩展 `PromptInput` 增加可选 `parts?: Array<{ type: 'text'; text: string }>`。`prompt()` 优先使用 parts（拼接为 content block 数组），无 parts 时回退现有单文本路径。`makeUserMessage` 扩展为接受 `string | Array<{type:'text',text:string}>`，parts 时构造 `{ role:'user', content: [{type:'text', text}, ...] }`。

**备选（已否决）**：引擎自行拼接为单字符串。会丢失结构化语义（引擎 4 段 XML parts 的分段意图），且与 opencode 协议 `parts` 字段不对齐。

### D3: per-prompt permissionMode——Query.setPermissionMode

**决策**：`prompt()` 入参新增可选 `permissionMode`。若提供且与当前会话模式不同，先调 `Query.setPermissionMode(mode)`（底层仅 streaming input mode 可用，当前适配层正是该模式）再 push 消息。`session.setPermissionMode(sessionId, mode)` 作为独立方法暴露（引擎 V2.3 updateInstancePermissionMode 依赖运行时切换）。

### D4: rejectQuestion——deny 分支 + question.rejected 事件

**决策**：`SessionState` 新增 `rejectQuestion(requestID)`，对挂起的 question Promise resolve `{ behavior: 'deny', message: 'rejected by user' }`（与 respondPermission 的 reject 对称），并产出 `question.rejected` 控制事件（properties 含 sessionID/requestID）。`question.rejected` 加入 `GlobalEventType` 联合。

### D5: listPending*——SessionState 内部 Map 快照

**决策**：`SessionState` 暴露 `listPendingPermissions()` / `listPendingQuestions()`，返回当前 `pendingPermissions` / `pendingQuestions` Map 的值快照（深拷贝 requestID + 载荷，不含 resolve/reject 函数）。SessionManager 与 client.session 命名空间透传。

### D6: session.delete——模块级 deleteSession

**决策**：`SessionManager` 注入 `deleteSessionFn`（默认 SDK `deleteSession`）。`session.delete(sessionId)` 先 `close()` 本地 SessionState（关闭 Query/通道/清理 Map），再调 `deleteSessionFn(resolvedId, { dir })` 删除磁盘会话文件。区分于 `close()`（仅客户端内存清理）。

### D7: command.list / mcp.status——新增命名空间

**决策**：client 新增 `command` 与 `mcp` 命名空间。`command.list()` 调底层命令枚举能力（核验 SDK 是否暴露模块级函数；若未暴露，从 SDK 的 slash command 配置或 query control request 获取，见 Open Questions）。`mcp.status()` 调底层 MCP 状态查询（SDK 有 `SDKControlMcpStatusRequest` 控制请求类型）。

**实现路径**：底层 MCP 状态经 Query 的 control request 通道获取（`SDKControlMcpStatusRequest` 已在 sdk.d.ts L3894 的 SDKControlRequestInner 联合中）。command.list 经 SDK 的 `listCommands` 或本地 slash command 配置。具体底层函数签名在实现阶段核验。

### D8: AbortSignal——事件流订阅中断

**决策**：`global.event(options)` 与 `session.events(sessionId)` 的 options 新增可选 `signal?: AbortSignal`。归一化 async generator 内监听 signal，abort 时 break 循环并清理订阅。不改变现有 ReplayChannel/GlobalChannel 结构，在 generator 层包装。

### D9: before 分页——messages 新增 before 游标

**决策**：`SessionMessagesOptions` 新增 `before?: string`（消息 ID）。底层 `getSessionMessages` 的 `GetSessionMessagesOptions` 支持 `before` 游标（核验 sdk.d.ts）；提供 before 时透传，与现有 offset cursor 互斥（before 优先）。

### D10: subtask part 映射——events.ts 归一化扩展

**决策**：`StreamNormalizer` 新增对子 Agent / subtask 内容块的处理。底层 assistant 消息的 tool_use 块若为 Agent 工具（Task/Agent），其 tool_result 含子会话信息；`mapContentBlock` 扩展识别 subtask 类型块，产出 `message.part.updated` 事件且 part 携带 `subSessionId` 字段（从 tool_result output 或 SDK 的 `listSubagents`/`getSubagentMessages` 提取）。具体子 Agent 事件形状在实现阶段用真实 CLI 验证（见 Open Questions）。

### D11: 包入口与构建——index.ts + package.json exports

**决策**：新增 `src/index.ts`，re-export `createClaudeClient`、`ClaudeClient` 及全部公开类型。`package.json` 补 `main`（指向 dist/index.js）、`module`、`exports`（import 指向 dist，require 指向 dist）、`types`（指向 dist/index.d.ts）、`files: ["dist"]`、`scripts.build: "tsc"`。`tsconfig.json` 增 `outDir: "dist"`、`declaration: true`、`composite`（若 monorepo 需）。dist 加入 .gitignore。

### D12: create title 透传

**决策**：`CreateSessionOptions` 新增 `title?: string`，`buildInfo` 使用 `options.title ?? ''`。底层 SDK 的 `renameSession` 可选地持久化 title（非必须，title 当前主要在 SessionV2Info 返回）。

### D13: 依赖注入扩展——保持可测试性

**决策**：`SessionManagerOptions` 新增 `forkSessionFn?`、`deleteSessionFn?`、`listSubagentsFn?`、`getSubagentMessagesFn?` 注入点（默认指向 SDK 模块级函数），与现有 `queryFn`/`getSessionMessagesFn` 模式一致，保证测试可注入 mock。`QueryLike` 接口扩展 `rewindFiles`/`setPermissionMode` 方法签名。

## Risks / Trade-offs

- **[revert 的 fork 模式产生新会话 ID]** → 引擎需感知 revert 后 sessionId 变化。Mitigation：revert 返回值明确包含新 sessionId 与原 sessionId 映射；unrevert 封装切换逻辑，引擎层透明。
- **[file checkpointing 仅覆盖 Write/Edit/NotebookEdit，不含 Bash 命令变更]** → Bash 产生的文件变更无法 rewind。Mitigation：文档明确限制；引擎在需要文件回滚的场景应限制 Bash 使用或接受部分回滚。属底层限制，非适配层可解。
- **[resumeSessionAt/resumeDropsTurn 校验严格]** → fork 时若 fork 点不合法底层会拒绝。Mitigation：forkSession 的 upToMessageId 走独立路径（不依赖 resumeSessionAt 校验），forkSession 原生支持 upToMessageId 切片，规避该校验。
- **[setPermissionMode 仅 streaming input mode 可用]** → 当前适配层正是 streaming input mode（流式输入队列），可用。Mitigation：在非 streaming 模式（未来若引入）抛明确错误。
- **[command.list / mcp.status 底层 API 未完全确认]** → 可能底层未直接暴露模块级函数。Mitigation：实现阶段先核验 sdk.d.ts 与 SDK 导出；若需经 control request 通道，封装为 Query 控制请求。
- **[subtask 事件形状需真实验证]** → 子 Agent 事件的具体结构（subtask part/sessionId 字段位置）需用真实 CLI 验证。Mitigation：实现阶段用 e2e 脚本捕获真实子 Agent 事件，据实映射；若底层无 subtask 块，从 tool_result output 解析子会话 ID。
- **[包入口 BREAKING]** → 现有源码路径直引方式（scripts/e2e.ts）需改为包名引用。Mitigation：build 产物在本地 dev 可经 tsconfig paths 或源码直引兼容；e2e.ts 同步适配。
- **[forkSession/deleteSession 是模块级函数，与 Query 实例无关]** → 需独立注入而非经 QueryLike。Mitigation：D13 的独立注入点解决。

## Open Questions

1. **command.list 底层来源**：SDK 是否暴露模块级 `listCommands`，或需经 Query control request（`SDKControlGetSettingsRequest` 等）获取 slash commands？实现阶段核验 sdk.d.ts 导出与 docs/sdk/claude/slash-commands.md。
2. **subtask 事件真实形状**：子 Agent 会话 ID 在 SDKMessage 中的具体字段位置（tool_result output 内？独立 subtask 消息类型？`listSubagents` 返回？）。实现阶段用真实 CLI + Agent 工具捕获事件流验证。
3. **forkSession 后新会话的 init 捕获**：forkSession 返回新 sessionId 后，是否需要用空 prompt query 触发 init 才能纳入 SessionManager 管理，还是可直接用返回的 sessionId resume？实现阶段验证。

## Migration Plan

1. 先建立包入口与构建配置（index.ts + package.json + tsconfig），确保 build 通过。
2. 按依赖顺序实现新接口：D13 注入点 → D2 parts → D3/D12 permissionMode/title → D4/D5 rejectQuestion/listPending* → D6 delete → D1 revert/unrevert/fork → D8/D9 AbortSignal/before → D10 subtask → D7 command/mcp。
3. 每个接口 TDD：先写测试（含注入 mock 的单元测试 + 真实 CLI 集成测试），再实现。
4. 最后同步适配 scripts/e2e.ts 的引用方式。
5. 回滚策略：全部为纯增量新方法 + 入参可选扩展，回滚仅需移除新增方法与 index.ts，不影响现有功能。
