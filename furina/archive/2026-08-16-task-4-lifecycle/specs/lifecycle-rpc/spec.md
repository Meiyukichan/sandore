## ADDED Requirements

### Requirement: 7 个生命周期 RPC
`remote.ts`（`sandore.*` RPC）SHALL 补充 7 个生命周期方法，全部转调 `ctx.sandoreEngine` 对应实例级方法：

| RPC 方法 | 转调 Service 方法 |
|---|---|
| `sandore.replyQuestion` | `replyQuestion(instanceId, requestId, answers)` |
| `sandore.replyPermission` | `replyPermission(instanceId, requestId, reply)` |
| `sandore.pauseStep` | `pauseStep(instanceId, stepId)` |
| `sandore.resumeStep` | `resumeStep(instanceId, stepId, resumePrompt?)` |
| `sandore.pauseAll` | `pauseAllSteps(instanceId)` |
| `sandore.resumeAll` | `resumeAllSteps(instanceId, resumePrompt?)` |
| `sandore.retryStep` | `retryStep(instanceId, stepId, mode, message)` |

SHALL NOT 添加 `recover` RPC（崩溃恢复是启动自动扫描）与讨论类 RPC（`getDiscussion`/`addChatMessage`——讨论数据走宿主 Session 日志直读，避免双轨数据源）。

#### Scenario: RPC 方法齐备
- **WHEN** 检查 `SandoreRemote` 的方法面
- **THEN** 存在上述 7 个方法且参数/返回与 Service 方法签名一致；不存在 `recover`/`getDiscussion`/`addChatMessage`

#### Scenario: RPC 转调链路
- **WHEN** 前端调用 `sandore.pauseStep(instanceId, stepId)` 且实例 running
- **THEN** RPC 透传到 `engine.pauseStep`，暂停生效，返回成功响应

#### Scenario: RPC 错误透传
- **WHEN** RPC 调用的 Service 方法抛 SandoreError
- **THEN** RPC 响应携带错误（code/message），与既有 RPC 错误风格一致
