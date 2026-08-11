## Why

sandore 是一个多 LLM provider 适配的 monorepo，需要在统一的 opencode API 协议（`docs/sdk/openapi.json`）下接入不同的 agent SDK。Claude Code（`@anthropic-ai/claude-agent-sdk`）是首批需要接入的 provider，但其接口是「本地进程 + AsyncGenerator 拉模型」，与 opencode 协议的「HTTP REST + SSE 推流」模型存在根本性形态差异。需要一个适配器层 SDK，把 Claude Code SDK 的接口包装为 opencode 协议风格的方法级客户端，使上层消费者以统一的 opencode API 形态调用 Claude。

## What Changes

- 新建 `@meiyukichan/claude-sdk` 包（位于 `packages/sdk/claude`），TypeScript + pnpm + ESM（`"type": "module"`）。
- 初始化根级 pnpm 工作区（`pnpm-workspace.yaml` + 根 `package.json`），将 `packages/sdk/claude` 纳入工作区管理。
- 提供 `createClaudeClient({ cwd })` 工厂方法，返回 opencode 协议风格的方法级客户端对象（无 HTTP 服务器）。
- 客户端命名空间采用简化结构（无 v2 前缀）：`client.session.*`、`client.model.*`、`client.global.event()`。
- 逐步适配 5 个能力域：
  1. **创建会话**：`client.session.create()` — 后台启动 Claude SDK `query()`，从 `system/init` 消息捕获 `session_id`，维护 session_id → Query 映射。
  2. **会话消息 / 发送消息 / 暂停会话**：`client.session.messages()`（读历史）、`client.session.prompt()`（发送）、`client.session.interrupt()`（中断执行）+ `client.session.wait()`（等待空闲）。
  3. **获取模型**：`client.model.list()` — 包装 `Query.supportedModels()`。
  4. **流式获取消息**：`client.session.events(sessionId)` — 将 `stream_event` 流转换为 `AsyncIterable<GlobalEvent>`，增量产出 `message.part.delta`。
  5. **事件系统**：`client.global.event({ directory })` — 将 SDKMessage 流统一归一化为 GlobalEvent 信封，按 directory 参数过滤项目事件。
- 把 Claude SDK 的「创建+输入+流式输出」一体化 AsyncGenerator 解耦为 opencode 的「create → prompt → events」三段式独立方法（后台运行 query + 会话状态管理）。
- 流式与事件统一为 GlobalEvent：流式增量 → `message.part.delta`，完整消息 → `message.part.updated`（文本或工具调用），会话创建 → `session.created`，回合结束 → `session.next.step.ended`。

## Capabilities

### New Capabilities

- `session-management`: 创建会话、读取会话消息、发送消息、暂停会话（interrupt + wait）。对应 opencode v2 的 `session.create` / `session.messages` / `session.prompt` / `session.interrupt` / `session.wait`。
- `model-providers`: 获取可用模型列表。对应 opencode v2 的 `model.list`，包装 `Query.supportedModels()`。
- `event-streaming`: 流式获取消息与会话事件、全局事件订阅，统一产出 GlobalEvent 信封。对应 opencode 的 session events 与 `global.event`，按 directory 过滤。涵盖 Claude SDK 的 `system/init`、`stream_event`、`assistant`、`result` 等 SDKMessage 到 GlobalEvent 的归一化映射。

### Modified Capabilities

（无 — 全新包，无既有 spec 需修改）

## Impact

- **新增代码**：`packages/sdk/claude/`（src、test、package.json、tsconfig.json）；根级 `pnpm-workspace.yaml`、根 `package.json`。
- **依赖**：`@anthropic-ai/claude-agent-sdk`（peerDependency，由消费者提供，如 scripts 包）；`typescript`、`vitest`/测试框架（devDependency）。
- **受影响系统**：无既有代码受影响（全新包 + 工作区初始化）。`scripts/conversation.ts` 将作为适配示例的参考蓝本，后续可改写为使用 `@meiyukichan/claude-sdk`。
- **API 契约**：导出 `createClaudeClient` 工厂方法及 opencode 协议风格类型（SessionV2Info、ModelV2Info、GlobalEvent、PromptInput、SessionInputAdmitted 等）。
