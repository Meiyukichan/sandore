## Why

`packages/sdk/claude`（`@meiyukichan/claude-sdk`）当前仅实现了 Claude SDK 的基础会话/事件/权限-问题桥接能力，而即将在 `packages/daemon/engine` 落地的 Harness Workflow Engine V2（`docs/engine/agentic-native.md`）依赖一整套更完整的 SDK 接口：重试三模式（continue/revert/fork）、结构化 parts 发送、问题拒绝、待处理交互查询、运行时权限切换、子 Agent 会话追踪等。引擎文档假设的 SDK 表面与当前适配层存在系统性缺口，导致引擎无法直接基于现有 SDK 开发。本次变更在补齐引擎所需的全部 SDK 接口能力，使 `@meiyukichan/claude-sdk` 成为引擎可正式依赖的 SDK 基座。

## What Changes

- **会话重试机制**：新增 `session.revert`（对话历史截断 + 文件回滚）、`session.unrevert`（切回 revert 前会话）、`session.fork`（分叉新会话），基于底层 `resume`+`resumeSessionAt`+`forkSession`+`rewindFiles` 实现。
- **结构化 parts 发送**：`session.prompt` 支持 `parts: Array<{type:'text', text}>` 结构化数组入参（引擎 4 段 XML 提示词依赖），兼容现有单文本入参。
- **问题拒绝**：新增 `session.rejectQuestion`（问题拒绝路径，产出 `question.rejected` 事件），补齐 `respondQuestion` 仅有 allow 分支的缺口。
- **待处理交互查询**：新增 `session.listPendingPermissions` / `session.listPendingQuestions`，返回当前会话挂起的权限/问题请求快照。
- **会话生命周期补齐**：新增 `session.delete`（底层 `deleteSession`）、运行时 `session.setPermissionMode`（底层 `Query.setPermissionMode`）、`session.create` 透传 `title` 与 `enableFileCheckpointing` 选项（revert 文件层回滚前提）；`session.prompt` 入参新增可选 `permissionMode`（逐消息权限模式切换，底层先调 `Query.setPermissionMode` 再 push 消息）。
- **命令与 MCP 查询**：新增 `client.command.list`（斜杠命令列表）、`client.mcp.status`（MCP 服务器状态），支撑引擎 `getCommands`/`listHooks`。
- **事件流增强**：`global.event` / `session.events` 支持 `AbortSignal` 中断；`messages` 支持 `before` 消息 ID 游标分页；归一化层新增 subtask 内容块映射（产出含子 Agent 会话 ID 的 part 事件）。
- **包入口与构建** **BREAKING**：新增 `src/index.ts` 公共入口（re-export 全部公开 API），补齐 `package.json` 的 `main`/`module`/`exports`/`types` 字段与 `tsc` build 脚本，引擎可经包名 `@meiyukichan/claude-sdk` 引入（此前仅能源码路径直引）。

## Capabilities

### New Capabilities

- `session-retry`: 会话重试三模式——revert（对话截断 + 文件回滚到指定 messageID）、unrevert（切回 revert 前的会话）、fork（分叉新会话保留原会话），支撑引擎 V2.3 continue/revert/fork 重试机制。
- `structured-prompt-parts`: 结构化 prompt parts 数组发送能力，`session.prompt` 接受 `Array<{type:'text', text}>` 多段文本块，兼容单文本入参。
- `interactive-control`: 人机交互补齐——问题拒绝（`rejectQuestion`）、待处理权限/问题查询（`listPendingPermissions`/`listPendingQuestions`）、`question.rejected` 事件。
- `command-and-mcp-query`: 命令与 MCP 状态查询——`client.command.list`（斜杠命令）、`client.mcp.status`（MCP 服务器状态），支撑引擎 getCommands/listHooks。
- `package-entry`: 包公共入口与构建配置——`src/index.ts` re-export、`package.json` 的 main/exports/types/build，使包可经包名被引擎 import。

### Modified Capabilities

- `session-management`: 新增 `session.delete`、运行时 `session.setPermissionMode`、`session.create` 透传 `title` 与 `enableFileCheckpointing`；`session.prompt` 入参新增可选 `permissionMode`（逐消息切换）；`messages` 新增 `before` 消息 ID 游标分页选项。
- `event-streaming`: 事件流订阅新增 `AbortSignal` 中断支持；归一化层新增 subtask 内容块映射（从子 Agent 事件产出含子 sessionId 的 `message.part.updated`），不再静默跳过 subtask 块。

## Impact

- **代码**：`packages/sdk/claude/src/`（session.ts 新增 revert/unrevert/fork/delete/setPermissionMode/rejectQuestion/listPending*；session-state.ts 增 checkpointing/rewind 句柄管理；events.ts 增 subtask 映射与 AbortSignal；types.ts 增新类型；client.ts 增 command/mcp 命名空间；新增 index.ts）、`packages/sdk/claude/package.json`、`packages/sdk/claude/test/`（新增对应测试）、`packages/sdk/claude/tsconfig.json`（若需 build 配置）。
- **API**：客户端公开面扩展（session 命名空间新增方法、新增 command/mcp 命名空间、prompt 入参形状扩展）。`package.json` 增加 exports/build 为 **BREAKING**（消费者引用方式从源码路径改为包名）。
- **依赖**：依赖底层 `@anthropic-ai/claude-agent-sdk` 已有的 `forkSession`/`deleteSession`/`rewindFiles`/`setPermissionMode`/`resumeSessionAt` 等能力，无需升级 peerDependency 版本（已核验 sdk.d.ts 存在全部所需 API）。
- **下游**：`packages/daemon/engine`（待建引擎）将直接依赖本次补齐的接口；现有 `scripts/e2e.ts` 引用方式需适配包入口变更。
