## Context

sandore monorepo 需要以统一的 opencode API 协议（`docs/sdk/openapi.json`，OpenAPI 3.1.0）接入多个 LLM provider。Claude Code（`@anthropic-ai/claude-agent-sdk` v0.3.227）是首个接入对象。

**当前状态**：
- `packages/sdk/claude` 为空目录，无任何已有实现。
- 根目录无 `package.json` / `pnpm-workspace.yaml`（pnpm 工作区未建立）。
- `scripts/conversation.ts` 已演示 Claude SDK 的流式输入 + 流式输出模式（`query()` + `includePartialMessages` + `stream_event` 消费），作为适配示例的参考蓝本。
- `scripts/` 用 npm + tsx，`type: "module"`、`moduleResolution: bundler`、`strict`。

**核心形态差异**：
- 源（Claude SDK）：`query({prompt, options}): Query` 返回 `AsyncGenerator<SDKMessage>`，是「创建会话 + 输入消息 + 流式输出」**一体化**的拉模型。会话 ID 从首条 `system/init` 消息的 `session_id` 字段获取。
- 目标（opencode 协议）：`create`（返回 SessionV2Info）→ `prompt`（入队，返回 SessionInputAdmitted）→ `events`（SSE 推流，AsyncIterable）**三段式解耦**。
- 适配层必须把一体化 AsyncGenerator 拆成三个独立方法，在后台运行 query 并维护会话状态。

**关键约束**：
- 目标协议 ID 前缀：session `^ses`、message `^msg_`、part `^prt`、event `^evt_`、workspace `^wrk`。
- GlobalEvent 信封：`{directory?, project?, workspace?, payload: {id, type, properties}}`。
- Claude SDK 会话持久化到 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`。

## Goals / Non-Goals

**Goals:**
- 提供方法级客户端 `createClaudeClient({ cwd })`，使消费者以 opencode 协议风格调用 Claude，无需理解 Claude SDK 的 AsyncGenerator 细节。
- 把 Claude SDK 的一体化 `query()` 模型解耦为 `session.create()` / `session.prompt()` / `session.events()` 三段式独立方法。
- 将 SDKMessage 流统一归一化为 GlobalEvent 信封（`AsyncIterable<GlobalEvent>`），按 directory 参数过滤。
- 覆盖 5 个能力域：创建会话、会话消息/发送/暂停、获取模型、流式获取消息、事件系统。
- 初始化 pnpm 工作区，为后续 provider 包（codex/gemini/opencode）铺路。

**Non-Goals:**
- 不实现 HTTP 服务器（不启动 Express/Hono 等服务，不做真实 SSE 端点）。消费者通过方法调用获取 AsyncIterable。
- 不适配 opencode v1 legacy 端点（`/session`、`/event`、`/global/event` 路径形式）——REST 操作用 v2，事件产出 GlobalEvent 信封但通过方法返回而非 HTTP。
- 不适配全部 88 种 GlobalEvent 类型——仅适配 Claude SDK 消息中「有对应」的事件（session.created、message.part.delta、message.part.updated、session.next.step.ended 等）。
- 不改写 `scripts/conversation.ts`（仅作为参考蓝本）。
- 不实现 opencode 的 provider/agent/command/permission/todo 等本次 5 步范围外的能力。

## Decisions

### D1: 方法级库形态（无 HTTP 服务器）

**选择**：导出 `createClaudeClient({ cwd })` 工厂方法，返回客户端对象。不启动 HTTP 服务。

**备选**：
- HTTP 服务器（真正实现 openapi.json 端点 + SSE）——被否决，因当前无需跨进程消费，方法级库更轻量、更易测试，且与 `@opencode-ai/sdk` 的 `createOpencodeClient()` 用法一致。
- 两者都要——被否决，当前只需方法级库；HTTP 层可在未来作为薄封装叠加。

**理由**：消费者（如未来的 CLI/server）直接 import 并调用，避免端口管理、序列化开销。AsyncIterable 天然契合 TS 流式。

### D2: 一体化 query() 解耦策略

**选择**：`session.create()` 内部后台启动 `query()`（流式输入模式，prompt 传一个可控的 AsyncGenerator）。后续 `prompt()` 向该 AsyncGenerator 的输入队列 push `SDKUserMessage`；`events()` 订阅 query 的输出流。

```
session.create()
   │
   ├─▶ 启动 query({ prompt: inputQueue, options: {includePartialMessages:true} })
   │      │
   │      ├─ system/init ──▶ 捕获 session_id → resolve SessionV2Info
   │      ├─ stream_event ──▶ 推入 sessionEvents 通道
   │      ├─ assistant ────▶ 推入 sessionEvents 通道
   │      └─ result ───────▶ 推入 sessionEvents 通道
   │
   ├─▶ inputQueue: AsyncIterable<SDKUserMessage>（由 prompt() 控制 yield）
   └─▶ SessionState { query, sessionId, inputQueue, eventsChannel }
```

**备选**：每次 prompt 新建一个 query（单消息模式）——被否决，因会破坏会话连续性，无法在同一 session_id 下多轮对话。

**理由**：流式输入模式（`prompt: AsyncIterable<SDKUserMessage>`）是 Claude SDK 官方支持的多轮持久会话方式，`scripts/conversation.ts` 已验证可行。

### D2.1: create() 惰性回填 + firstMessage（集成测试发现，SDK init 契约）

**背景（集成测试实证）**：Claude SDK 流式输入模式下，`system/init` 消息**仅在首条用户消息被 yield 后才产出**；`query()` 以空输入队列启动时永不产出 init（无消息正常挂起）。`Query.initializationResult()` 不含 session_id，无替代获取路径。适配层原设计（create() 空队列启动后等 init）在真实 SDK 下必然超时。

**选择**：
- `session.create(options)` 支持可选 `firstMessage?: string` 参数。
  - **提供 firstMessage**：create() 启动 query 后立即将该消息 push 为首条用户消息 → init 触发 → 捕获真实 session_id → resolve 完整 SessionV2Info（`id` 为真实 session_id）。该消息即会话第一条真实输入（与 `scripts/conversation.ts` 蓝本一致）。
  - **未提供 firstMessage**：create() 启动 query（空输入队列），返回**占位** SessionV2Info（`id` 为预生成占位，如 `ses_<uuid>` 以符合 opencode ID pattern）。会话进入 `pending` 状态（已创建但未完成初始化）。**首个 `prompt()` push 后** → init 触发 → 捕获真实 session_id → 会话转为 `created`（首消息后才算创建完成）。
- 会话状态机增加 `pending`（create 已返回但未捕获真实 session_id）与 `created`（已捕获）区分。
- `session.created` 事件在真实 session_id 捕获后产出（基于真实 id，而非占位 id）。
- `prompt()` 在真实 session_id 捕获后，返回的 `SessionInputAdmitted.sessionID` 使用真实 session_id；捕获前的 push 在 init 触发时按真实 id 归位。
- `initTimeoutMs` 超时保护仍生效：create()（firstMessage 路径）与首个 prompt() 触发的 init 捕获均受超时约束，超时 reject TimeoutError 并清理。

**备选**：
- 强制 firstMessage——被否决，create() 应支持「只创建会话」的直观语义，不应强制首条消息。
- 纯惰性回填（create 必返回占位、无 firstMessage 选项）——被否决，用户明确要求 firstMessage + 惰性回填两者兼有。

**理由**：兼顾两种用法——需要真实 session_id 立即创建者传 firstMessage；需要先建会话再逐步交互者不传，首消息后回填。

### D3: 命名空间简化（无 v2 前缀）

**选择**：`client.session.create()` / `client.model.list()` / `client.global.event()`，不使用 `client.v2.*`。

**理由**：只适配 v2 一套，无需版本区分；消费者调用更简洁。

### D4: 流式与事件统一为 GlobalEvent

**选择**：第 4 步（流式获取消息）与第 5 步（事件系统）都产出 `AsyncIterable<GlobalEvent>`。`session.events(id)` 是会话级视图（产出该 session 的 GlobalEvent），`global.event({directory})` 是全局视图（按 directory 过滤）。两者共享同一套 SDKMessage → GlobalEvent 归一化逻辑。

**映射表**：

| Claude SDKMessage | GlobalEvent payload.type | properties 要点 |
|---|---|---|
| `system` (subtype=init) | `session.created` | `{sessionID, info: Session}` |
| `stream_event` (text_delta) | `message.part.delta` | `{sessionID, messageID, partID, field:'text', delta}` |
| `stream_event` (input_json_delta) | `message.part.delta` | `{..., field:'tool_input', delta}` |
| `assistant` (完整消息) | `message.part.updated` | `{sessionID, part: Part, time}`（每个内容块 → 一个事件，part 为 TextPart 或 ToolPart） |
| `result` (success) | `session.next.step.ended` | `{sessionID, finish, cost, tokens}` |
| `result` (error) | `session.error` | `{sessionID, error}` |
| `system` (session_state_changed) | `session.idle` / `session.status` | `{sessionID, status}` |

> 注：`message.part.updated` 的 properties 采用 `{sessionID, part: Part, time}`（与 `docs/sdk/openapi.json` 中 `EventMessagePartUpdated` 一致）：`assistant` 完整消息的每个内容块映射为一条 `message.part.updated` 事件，`part` 为对应的文本块（TextPart）或工具调用块（ToolPart），而非 `info: Message`。

**会话事件回放**：`session.events(id)` 的事件通道为**回放型广播通道**——事件自会话创建起缓冲，晚订阅的消费者（如先 `session.create()` 再 `session.events(id)`）同样会收到 `session.created` 等已发生事件。这与 opencode `v2.session.events` 的「缺省从起始回放 durable 事件」语义一致。

**备选**：第4步用 SessionDurableEvent（data 容器）、第5步用 GlobalEvent（properties 容器）分开——被否决，用户明确要求统一为事件，流式输出最后转换为 message.part.delta 和 message.part.updated。

### D5: 暂停语义——interrupt + wait 两方法

**选择**：
- `session.interrupt(sessionId)` → `Query.interrupt()`，中断当前执行。对应 v2 `POST /api/session/{id}/interrupt`。
- `session.wait(sessionId)` → 轮询会话状态直到 idle。对应 v2 `POST /api/session/{id}/wait`。

**备选**：仅 interrupt——被否决，用户明确要求两个方法。

### D6: 事件订阅参数过滤

**选择**：`client.global.event({ directory })` 接收 directory 参数，库内部只产出匹配该 directory（即 cwd 编码后对应的项目）的事件。GlobalEvent 信封自带 directory/project/workspace 字段，库在产出前按入参 directory 过滤。

**理由**：方法级库无真实 HTTP 订阅，需在库层面模拟「按项目订阅」语义；directory 是 opencode 中标识项目的核心字段。

### D7: ID 生成与映射

**选择**：Claude SDK 的 session_id 是其内部生成的（如 UUID 形式），与 opencode 的 `^ses` 前缀约束不完全一致。适配层保留 Claude 原始 session_id 作为 `SessionV2Info.id`（不做前缀转换），因为该 ID 需用于 `resume`/`getSessionMessages` 等 Claude 侧操作。message/part/event ID 在归一化时按 `^msg_`/`^prt`/`^evt_` 前缀生成（用 Claude 的 uuid 映射或生成新 ID）。

**风险**：不严格符合 opencode ID pattern。作为适配层权衡——保证 Claude 侧可用性优先于协议 ID 格式严格性。

### D8: 工程结构

**选择**：
```
sandore/
  package.json            （私有根包，type: module）
  pnpm-workspace.yaml     （packages: ['packages/*']）
  tsconfig.base.json      （共享 TS 配置）
  packages/sdk/claude/
    package.json          （@meiyukichan/claude-sdk, type: module）
    tsconfig.json         （继承 base, ESNext/bundler/strict）
    src/
      client.ts           （createClaudeClient 工厂）
      session.ts          （SessionManager: create/messages/prompt/interrupt/wait/events）
      model.ts            （ModelManager: list）
      events.ts           （GlobalEventManager: global.event + SDKMessage→GlobalEvent 归一化）
      types.ts            （opencode 协议类型：SessionV2Info, ModelV2Info, GlobalEvent, ...）
      session-state.ts    （SessionState: query/inputQueue/eventsChannel 后台状态）
    test/
      *.test.ts
```

**依赖**：`@anthropic-ai/claude-agent-sdk` 作为 peerDependency（由消费者提供）；`typescript`、`vitest` 为 devDependency。

### D9: model.list() 的 Query 获取方式

**选择**：`ModelManager.list()` 惰性初始化并缓存一个「控制 Query」——首次调用时以 `query({ prompt: <永不产出的空 AsyncIterable>, options: { cwd } })` 创建，复用其 `supportedModels()` / `initializationResult().models`，在 `client.close()` 时关闭。该控制 Query 不 yield 任何用户消息，不产生对话轮次；代价是启动一次 CLI 子进程（一次性开销，可接受）。若客户端已有活跃会话，实现也可复用其 Query（细节由计划阶段确定）。

**理由**：`supportedModels()` 与 `initializationResult()` 是 `Query` 实例方法（Claude SDK 无模块级模型列举函数），而 `Query` 通常由 `session.create()` 创建；`model.list()` 作为客户端级方法可能在创建任何会话前被调用（如先渲染模型选择器），因此需要独立的 Query 来源。

## Risks / Trade-offs

- **[一体化解耦的状态管理复杂度]** session.create() 后台运行 query 需维护 SessionState（query 句柄、输入队列、事件通道），prompt/events/interrupt 需跨方法共享状态。→ 用 `Map<sessionId, SessionState>` 集中管理，SessionState 封装输入队列（push/yield）与事件通道（AsyncIterable）。close() 时清理。

- **[Claude SDK query() 首条消息前 session.create() 无法 resolve]** session.create() 必须等 system/init 产出 session_id 才能返回 SessionV2Info，存在启动延迟。→ 用 Promise 在 init 消息到达时 resolve；设置超时保护。

- **[ID 前缀不完全合规]** Claude session_id 不带 `^ses` 前缀。→ D7 决策：保留原始 ID 保证 Claude 侧可用性，文档标注此偏差。

- **[事件类型覆盖不全]** 仅适配「有对应」的 GlobalEvent 类型，部分 Claude 消息（如 hook、task_notification）无 opencode 对应项。→ 文档明确不映射的事件类型；未映射消息静默跳过（不产出事件）。

- **[wait() 轮询效率]** Claude SDK 无原生 wait，需轮询 session 状态。→ 基于结果消息/状态变更事件驱动，避免高频轮询；超时退出。

- **[流式输入模式依赖 CLI capability]** `interrupt()` 需 CLI 通告 `interrupt_receipt_v1` 能力。→ 文档标注前置条件；无能力时降级为 close()。

- **[并发会话管理]** 多个 session.create() 并发时每个 SessionState 独立。→ SessionManager 用 Map 隔离，无共享可变状态。

## Migration Plan

- 全新包，无迁移。部署即 `pnpm install` + `pnpm build`。
- 后续 `scripts/conversation.ts` 可改写为 import `@meiyukichan/claude-sdk`，作为端到端验证示例（本次不实施）。

## Open Questions

- 消费者如何提供 `@anthropic-ai/claude-agent-sdk`（peerDependency 版本范围）？建议 `>=0.3.0`，待实现时确认实际兼容版本。
- `global.event({directory})` 的 directory 默认值：若消费者不传，是否默认用 client 的 cwd？建议默认用 cwd。
