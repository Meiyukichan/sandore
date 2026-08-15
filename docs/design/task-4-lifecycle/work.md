# Task 4：生命周期 — 交互 + 暂停/恢复 + 重试 + 崩溃恢复 + 宿主主代理

在 Task 3 完整 DAG 之上，补齐工作流引擎的完整生命周期能力：交互（问答/权限/askUserQuestion）+ 暂停/恢复/中止 + 重试（continue/revert/fork）+ 崩溃恢复（断点续传）+ 宿主主代理（默认会话自然延续，D9）+ 消息聚合（多 session 讨论数据）。

## 必读（按优先级）
1. `docs/design/task-4-lifecycle/design.md` —— Task 4 权威规格（交互/暂停恢复/重试/崩溃恢复/宿主主代理/事件 SSE/讨论面板）
2. `docs/engine/dsh-workflow.md` —— 插件化核心设计（§5.1A 主代理编排器、§5.5 事件/SSE、§6.4 讨论面板、§10.2 D1–D9）
3. `docs/design/overall-design.md` —— 总体设计（§4.2 事件词汇表、D5/D8/D9）
4. DSH 源码 `D:\project-code\llm\deepseek-harness` 参考：`packages/interaction`（权限/问答 seam）、`ctx.subagents`（`interrupt`/`followup`/`listChildren`）、`ctx.agents`（`create`/`resume`/`whenIdle`）、`packages/client/ui-workflow-run`（Chat 节点）

## 硬约束（不可违反）
- **纯插件，不改任何 DSH 源码**；**零外部 Agent SDK**，全用 DSH `ctx.*` 服务
- 命名沿用：`ctx.sandoreEngine` / `sandore/*`（13 事件）/ `sandore_*`（工具，下划线）/ `sandore.*`（RPC，点号）/ 4 包

## 产出（`workflow` + `tool` 两包）
1. `packages/sandore/workflow/`：
   - `interaction-manager.ts`：`pendingQuestions`/`pendingPermissions` Map + `addPendingQuestion/Permission` → `sandore/question`/`sandore/permission` 事件 + `replyQuestion`/`replyPermission`
   - `lifecycle-manager.ts`：`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps` + **暂停登记表**（`pausedChildIds`，DSH 无 paused 状态，引擎自建并持久化）
   - `recovery-manager.ts`：`recoverOrphanedInstances`（启动扫描 storageDomain `state` 表）+ 崩溃恢复
   - `host-agent.ts`：宿主主代理——`ctx.agents.create({ sessionId, meta: { cwd }, setup(agentCtx) })` + `sandore_*` 工具注册（D9）
2. `packages/sandore/tool/`：**8 个 `sandore_*` 模型工具**（per-instance 闭包捕获 `instanceId`，通过 `agents.create({ setup })` 注册，非 preset standing mount）：
   `sandore_getState` / `sandore_startInstance` / `sandore_abortInstance` / `sandore_pauseStep` / `sandore_resumeStep` / `sandore_pauseAllSteps` / `sandore_resumeAllPaused` / `sandore_retryStep`

## 关键决策
- **D5**：事件/SSE 全用 DSH，零自建——删除 `WorkflowEventBus`/`WorkflowSseManager`/`SdkSseManager`，改用 `sandore/*` Session 事件 + apiproxy 双 SSE 流 + `ctx.sessionProjections`
- **D8**：讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制——每个 Step 折叠为一个 `sandore-step` 节点（`ConversationNodeDefinition` + `conversation.chat.node` keyed），内联最后结果消息
- **D9**：主代理 = 工作流编排器，身份不切换——广播恢复改为「自然语言 → 主代理显式调用 `sandore_*` 工具」；「默认挂载会话」= 宿主 Session 在 `completed` 后自然降级为自由对话（**无 DefaultSessionManager**、无 `default-session-mounted` 事件）；暂停登记表由引擎自建（DSH 无 paused 状态）
- **暂停/恢复**：`pause` = `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })`；`resume` = `ctx.subagents.followup(hostAgent, childId, ...)`
- **重试 revert/fork**：DSH 无 revert 原语——用 `ctx.sessions.fork(childId, boundary)` + `ctx.agents.create({ seed })`（产生新 session id）；continue 用 `followup`
- **崩溃恢复**：`ctx.agents.resume({ resumeSessionId: hostSessionId })` 冷恢复宿主主代理（`setup` 重跑 → 工具/instanceId 闭包重注册）+ `followup` 冷恢复子代理
- **权限**：无 `permissionMode`——子代理继承宿主 Session 的 permission preset，approval 固定 `never`

## 验证标准（Task 4 完成门槛）
- 暂停/恢复/重试（continue/revert/fork 三模式）/崩溃恢复全链路可用
- 交互（问答/权限/askUserQuestion）全链路可用
- 宿主主代理：`completed` 后自然降级为自由对话；`sandore_*` 工具仅挂宿主 Session（per-instance），不影响普通会话
- 讨论面板 `sandore-step` 节点正确渲染（复用 `ui-workflow-run`）

先读 `task-4-lifecycle/design.md` 全文，再开始实现。
