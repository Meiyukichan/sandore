## Why

Task 3 已交付完整 DAG 执行能力（agent/skill/mcp Step + 分支 + 循环 + Finalize），但引擎的 8 个实例级生命周期方法（`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`）仍全部抛 `not implemented`，宿主 Session 只是裸 `sessions.create` 而非真正的主代理（D9 缺失），`interacting` 状态只置标记后中断无等待循环，`tool` 包空占位。Task 4 补齐工作流引擎的完整生命周期能力——交互（问答/权限/askUserQuestion）+ 暂停/恢复/中止 + 重试（continue/revert/fork）+ 崩溃恢复（断点续传）+ 宿主主代理（默认会话自然延续），是 Task 5 前端可用的前置条件。

## What Changes

- **宿主主代理（D9）**：`startInstance` 从裸 `sessions.create` 升级为 `ctx.agents.create({ sessionId, meta: { cwd }, setup })` 的真 Agent——闭包捕获 `instanceId` 注册 8 个 `sandore_*` 编排器工具 + system prompt；`completed` 后自然降级为自由对话（无 DefaultSessionManager）；`StepRunnerConfig.hostAgent` 接到 live `hostAgent` 引用。
- **新建 `workflow/src/host-agent.ts`**：宿主主代理创建/冷恢复工厂（`agents.create` / `agents.resume({ resumeSessionId, setup })`，setup 重跑保证工具重注册）。
- **新建 `workflow/src/interaction-manager.ts`**：引擎级 ask 以宿主主代理身份 `ctx.userQuestions.ask({ agent: hostAgent })`（DSH 原生卡片 + await 答案闭环）；`pendingQuestions`/`pendingPermissions` Map 为镜像持久化（崩溃恢复重建交互）；`replyQuestion`/`replyPermission` 兼容回复路径；子代理 ask（`DELEGATED_CALLER`）→ 问题写 final result → 引擎解析转引擎级 ask → 答案 `followup` 子代理。
- **新建 `workflow/src/lifecycle-manager.ts`**：`pauseStep`（`subagents.interrupt(childId, {kind:'ancestor', agent: hostAgent})`）/ `resumeStep`（`followup`）/ `pauseAllSteps`/`resumeAllSteps` + 引擎自建暂停登记表 `pausedChildIds`（值=子代理 SessionId，持久化）。
- **新建 `workflow/src/recovery-manager.ts`**：`recoverOrphanedInstances` 启动扫描 storageDomain `state` 表（跳过终态）→ 非终态实例 `agents.resume` 冷恢复宿主主代理 + `followup` 冷恢复 running/interacting 子代理 + paused 恢复登记表。
- **`tool` 包新建**：8 个 `sandore_*` 模型工具（`sandore_getState`/`sandore_startInstance`/`sandore_abortInstance`/`sandore_pauseStep`/`sandore_resumeStep`/`sandore_pauseAllSteps`/`sandore_resumeAllPaused`/`sandore_retryStep`），per-instance 闭包捕获 `instanceId`，经 `agents.create({ setup })` 注册。
- **`retryStep` 三模式**：`continue` = `followup`；`revert` = `sessions.fork(childId, turn 边界)` + `agents.create({ seed })` 续跑（产生新 session id）；`fork` = `sessions.fork(childId, boundary?)` → 新 agent 续跑。
- **改造 `workflow-engine.ts`**：8 个 stub 方法接到四管理器；`runInstance` 的 `interacting` 分支接交互等待循环；补发 5 个事件（`step-paused`/`step-resumed`/`step-retried`/`question`/`permission`，Session append + Cordis 双发）。
- **补 7 个生命周期 RPC**（`remote.ts`）：`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`（无 recover RPC——崩溃恢复走启动自动扫描；无讨论 RPC——Session 日志直读）。
- **接缝与 schema 扩展**：`microflow/src/subagents.ts` 补 `CreateAgentOptions.meta/seed/setup`、`ResumeAgentOptions.setup`、`Agent.inbox/ctx`、`SubagentRuntime.listChildren`；**BREAKING**（schema）：`WorkflowTaskStateSchema.pausedStepIds` → `pausedChildIds`（值=childId，开发期改名零迁移成本）；`pendingInteractions` 从 `unknown[]` 收紧为结构化 pending 条目；`seam.ts` inject 补 `agents`/`userQuestions`。
- **测试基建**：扩展 `FakeAgentRegistry`（setup 回放、meta.cwd 记录）、`FakeSubagents`（listChildren、interrupt/followup 状态机）、`FakeSessions`（fork）；新增四管理器 + 工具 + 引擎生命周期单测。

## Capabilities

### New Capabilities
- `host-agent`: 宿主主代理——`ctx.agents.create({ sessionId, meta: { cwd }, setup })` 创建编排器 Agent，per-instance 闭包注册 `sandore_*` 工具，`completed` 后自然降级自由对话，`agents.resume` 冷恢复（setup 重跑重注册）
- `interaction-management`: 引擎级 ask（`ctx.userQuestions.ask({ agent: hostAgent })` 原生卡片闭环）+ pending Map 镜像持久化 + `replyQuestion`/`replyPermission` 兼容路径 + 子代理 ask 转接（DELEGATED_CALLER 规避）
- `lifecycle-pause-resume`: `pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps` + 引擎自建暂停登记表 `pausedChildIds`（interrupt/followup 映射 + 持久化）
- `retry-management`: `retryStep` 三模式（continue=followup / revert=fork+seed 续跑 / fork=fork+新 agent）+ `RetryRecord` 历史
- `crash-recovery`: `recoverOrphanedInstances` 启动扫描 + 宿主/子代理冷恢复 + 暂停登记表重建
- `orchestrator-tools`: 8 个 `sandore_*` 模型工具（per-instance 闭包，仅挂宿主 Session，不影响普通会话；completed 态 resume/retry no-op、getState 只读）
- `lifecycle-rpc`: 7 个生命周期 RPC（`sandore.replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`）——前端「全链路可用」通路

### Modified Capabilities
（无——Task 1–3 的 specs 已归档至 `furina/archive/`，其需求未变；Task 4 是新增能力，不修改既有 spec 行为。schema 的 `pausedStepIds`→`pausedChildIds` 改名属于本变更内部字段演进，开发期无生产数据，不作为既有 capability 的 spec 级行为变更。）

## Impact

- **代码**：
  - 新建：`packages/sandore/workflow/src/{host-agent,interaction-manager,lifecycle-manager,recovery-manager}.ts`、`packages/sandore/tool/src/{index.ts,8 个工具}`
  - 改造：`packages/sandore/workflow/src/{workflow-engine,seam,schema,types,remote}.ts`、`packages/sandore/microflow/src/subagents.ts`、`packages/sandore/workflow/tests/mocks/{agents,subagents,sessions}.ts`
  - 依赖方向不变：`workflow → microflow` 单向（microflow 对 workflow 仍仅 `import type`）
- **API/事件**：13 个 `sandore/*` 事件全部激活（新增发射 5 个）；`sandore.*` RPC +7；`ctx.sandoreEngine` inject +2（`agents`/`userQuestions`）
- **硬约束（不可违反）**：纯插件不改 DSH 源码；零外部 Agent SDK，全用 DSH `ctx.*` 服务；命名沿用 `ctx.sandoreEngine`/`sandore/*`/`sandore_*`/`sandore.*`/4 包
- **关键决策**：D5（事件/SSE 全用 DSH 零自建）、D8（讨论面板引擎侧就绪，渲染器留 Task 5）、D9（主代理=编排器身份不切换）、权限无 `permissionMode`（子代理继承宿主 preset，approval 固定 `never`）
- **范围外**：`ui` 包讨论面板渲染器（Task 5）、`getDiscussion`/`addChatMessage` RPC（Session 日志直读）、per-Step 权限差异化（DSH 能力外）
