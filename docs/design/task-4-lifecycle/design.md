# Task 4 生命周期 — 设计文档

> 来源文档：
> - [dsh-workflow.md](../../engine/dsh-workflow.md)（引擎 v2.6 插件化设计）
> - [dynamic-workflow-engine.md](../../engine/dynamic-workflow-engine.md)（引擎 v2.6 技术设计）
>
> 最后更新: 2025-07-20

## 本文档范围

本文档从两份源设计文档中提取与 **Task 4 生命周期** 相关的全部内容，重新组织为一份自包含的设计文档。Task 4 的定位是：

**补齐工作流引擎的完整生命周期能力**：交互（问答/权限/askUserQuestion）+ 暂停/恢复/中止 + 重试（continue/revert/fork）+ 崩溃恢复（断点续传）+ 默认挂载会话（DefaultSessionManager）+ 消息聚合（多 session 讨论数据）。

**验证标准**：暂停/恢复/重试/崩溃恢复/默认会话全链路可用。

---

## 目录

1. [交互机制 — 问答与权限](#1-交互机制--问答与权限)
2. [暂停与恢复机制](#2-暂停与恢复机制)
3. [中止机制](#3-中止机制)
4. [重试机制 — continue/revert/fork](#4-重试机制--continuerevertfork)
5. [崩溃恢复 — 断点续传](#5-崩溃恢复--断点续传)
6. [默认挂载会话 — DefaultSessionManager](#6-默认挂载会话--defaultsessionmanager)
7. [事件与 SSE 推送（决策 D5）](#7-事件与-sse-推送决策-d5)
8. [讨论面板：sandore-step Chat 节点（决策 D8）](#8-讨论面板sandore-step-chat-节点决策-d8)
9. [验证标准](#9-验证标准)

---

## 1. 交互机制 — 问答与权限

> 来源：`dynamic-workflow-engine.md` §5.3、§10

### 1.1 WorkflowInteractionManager

**职责**：问答/权限的注册、回复、拒绝、清理。

**字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `pendingQuestions` | `Map<string, PendingQuestion>` | requestId → 待回复问答 |
| `pendingPermissions` | `Map<string, PendingPermission>` | requestId → 待回复权限 |

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `addPendingQuestion` | `(data: {stepId, sessionId, requestId, questions}): void` | 注册问答 → emit `workflow.question` + `workflow.chat_updated` |
| `addPendingPermission` | `(data: {stepId, sessionId, requestId, permission, patterns?, metadata?, tool?}): void` | 注册权限 → emit `workflow.permission` + `workflow.chat_updated` |
| `replyQuestion` | `async (requestId, answers: string[][]): Promise<void>` | 回复问答 → runner.replyQuestion → emit `workflow.question_replied` |
| `replyPermission` | `async (requestId, reply: 'once'\|'always'\|'reject'): Promise<void>` | 回复权限 → runner.replyPermission → emit `workflow.permission_replied` |
| `rejectQuestion` | `async (requestId): Promise<void>` | 拒绝问答 → runner.rejectQuestion → emit `workflow.question_rejected` |
| `hasQuestion` / `hasPermission` | `(id): boolean` | 检查存在性 |
| `clearPendingInteractions` | `(stepId): void` | 清除指定 Step 的所有交互 → emit replied 事件 |
| `clearAll` | `(): void` | 清除所有交互（崩溃恢复用） |
| `getPendingQuestions` / `getPendingPermissions` | `(): PendingQuestion[] / PendingPermission[]` | 返回数组 |

> **V2.3 变更**：`resolveOriginalStepId()` 方法已移除。`addPendingPermission` 新增 `metadata` 和 `tool` 字段。`clearPendingInteractions` 现在发出 replied 事件。

### 1.2 PendingQuestion / PendingPermission 结构

```typescript
PendingQuestion {
  id: string;            // requestId
  stageId: string;
  stepId: string;        // 经 getActualStepId 解析后的真实 step ID
  sessionId: string;
  requestId: string;
  questions: unknown[];
  status: 'pending' | 'replied' | 'rejected';
  answer?: string[][];
}

PendingPermission {
  id: string;
  stageId: string;
  stepId: string;
  sessionId: string;
  requestId: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  tool?: { name?: string; description?: string; messageID?: string; callID?: string };
  status: 'pending' | 'replied' | 'rejected';
  answer?: 'once' | 'always' | 'reject';
}
```

### 1.3 完整交互流程

```
SDK Agent 执行中遇到权限/问答需求
    │
    ▼
SDK SSE: question.asked / permission.asked
    │
    ▼
引擎共享 SSE 接收事件
    │
    ▼
sseManager.findRunnerBySessionId(sid) → 找到对应的 WorkflowStepRunner
    │
    ▼
runner.notifyQuestion() / runner.notifyPermission()
    │  ├── runner._status = 'interacting'
    └── runner.emit('question' / 'permission')
    │
    ▼
引擎接收事件 → interactionManager.addPendingQuestion() / addPendingPermission()
    │  ├── getActualStepId(stepId) → 解析循环后缀得到真实 step ID
    ├── findStepLocation(stepId) → 定位 stageId
    ├── 构造 PendingQuestion / PendingPermission 条目，存入 pendingQuestions / pendingPermissions Map
    ├── updateStepStatusInExecutedSteps(actualStepId, 'interacting')
    ├── persistState()
    ├── emit('workflow.question' / 'workflow.permission')
    └── emit('workflow.chat_updated', { jobId, instanceId })
    │
    ▼
前端 SSE 收到事件，展示问答/权限对话框
    │
    ▼
用户回复 → POST /question/reply 或 /permission/reply
    │
    ▼
engine.replyQuestion() / engine.replyPermission() → interactionManager.replyQuestion() / replyPermission()
    │  ├── 从 pendingQuestions / pendingPermissions Map 取出 pending 条目
    ├── findStepRunner(pending.stepId) → 找到对应 WorkflowStepRunner
    ├── runner.replyQuestion() / runner.replyPermission() → SDK client.reply()
    ├── 更新 pending.status = 'replied'，记录 answer
    ├── 删除 pending 记录
    ├── updateStepStatusInExecutedSteps(stepId, 'running')
    ├── emit('workflow.question_replied' / 'workflow.permission_replied')
    └── persistState()
```

### 1.4 权限自动回复

SDK 集成层提供 `autoReplyPermission()` 函数，在 SSE 事件流中自动处理 `permission.asked` 事件：

- **`bypassPermissions` 模式**（默认）：自动允许所有权限请求
- **`acceptEdits` 模式**：允许除 Bash 外的所有权限
- **`default` 模式**：不自动回复，等待用户处理

```
bypassPermissions → shouldAllow = true (所有权限)
acceptEdits       → shouldAllow = ACCEPT_EDITS_PERMISSIONS.has(type) (排除 Bash)
default           → shouldAllow = false (不自动回复)
→ shouldAllow=true: client.permission.reply({ requestID, reply: 'always', directory })
```

> **DSH 移植说明（经探索修正）**：DSH **没有** `bypassPermissions`/`acceptEdits`/`permissionMode` 概念，而是用 `sandbox/mode` + `approval/policy` 折叠成 **permission presets**（默认 `workspace-write`=workspace-write+ask、`danger-full-access`=full+never）。且 `ctx.subagents.startContinuable()` 的 `ContinuableStartSpec` **无权限字段**——**Step 子代理继承父会话（工作流宿主 Session）的 permission preset，approval 固定 `never`**。因此：
> - 原 sandore 的「实例级 permissionMode」在 DSH 中映射为「**工作流宿主 Session 的 permission preset**」，Step 子代理继承它；
> - **无法 Step 级单独指定权限**（若确需不同权限，须先切宿主会话 preset，代价大）；
> - 不再手写 `buildPermissionRules`/`autoReplyPermission`，权限治理完全交给 DSH 的 permission presets seam。
> - 这是迁移后**唯一真实的控制力损失**（per-Step 权限差异化），其余生命周期/交互/恢复能力均等价或更强。

### 1.5 askUserQuestion 转换（V2.6 新增）

> 来源：`dynamic-workflow-engine.md` §5.5.1、§6.7

V2.6 的 `FinalizeAssessResult.completionType` 支持两种值：

| 类型 | 含义 | Step 后续行为 |
|------|------|--------------|
| `completed` | 任务已正确完成，无遗留问题 | 继续门禁审查（如配置）→ 推进下一节点 |
| `ask` | 存在疑问或需要用户确认才能继续 | 注入 askUserQuestion → Step 进入 `interacting` → 等待用户回复 |

#### AskUserQuestionPayload Schema（对齐 DSH harness）

```typescript
AskUserQuestionPayload {                   // 对齐 DSH harness ask_user_question 工具 schema
  questions: Array<{
    id: string                             // stable id，用于路由回复（echoed in answer）
    question: string                       // 具体问题
    header?: string                        // 可选短标题（如 "Confirm" / "Choose Mode"）
    options?: Array<{
      label: string                        // 选项标签（推荐选项可加 "(Recommended)"）
      description?: string                 // 一句话说明选项的权衡或影响
    }>
    multi_select?: boolean                 // 是否允许多选，默认 false
  }>
}
```

> **askUserQuestion 对齐 DSH harness**：`askQuestion` 的 schema 对齐 DSH harness 的 `ask_user_question` 工具参数结构。当 `completionType='ask'` 时，引擎将 `askQuestion` 注入 `WorkflowInteractionManager` 作为 `PendingQuestion`，Step 进入 `interacting` 状态。用户回复后（`replyQuestion`），Step 恢复执行。

#### askUserQuestion 转换流程

```
FinalizeAssessor 判定 completionType='ask'
    │
    ▼
提取 askQuestion 字段（JSON 解析 → regex 回退）
    │
    ▼
构造 AskUserQuestionPayload:
    { questions: [{ id, question, header?, options?, multi_select? }] }
    │
    ▼
注入 WorkflowInteractionManager:
    ├── 构造 PendingQuestion { id: requestId, questions: askQuestion.questions }
    ├── addPendingQuestion() → emit workflow.question + workflow.chat_updated
    └── updateStepStatusInExecutedSteps(stepId, 'interacting')
    │
    ▼
Step 进入 interacting 状态，等待用户回复
    │
    ▼
用户回复 → POST /question/reply
    │
    ▼
engine.replyQuestion() → interactionManager.replyQuestion()
    ├── runner.replyQuestion(requestId, answers) → SDK client.reply()
    ├── 更新 pending.status = 'replied'
    ├── updateStepStatusInExecutedSteps(stepId, 'running')
    └── emit workflow.question_replied
    │
    ▼
Step 恢复执行:
    ├── 若配置了门禁 → gateEvaluator.evaluate() 继续第 2 部分
    └── finalize 完成 → 推进下一节点
```

#### askUserQuestion 与 SDK 原生 question 的统一

V2.6 的 `askUserQuestion` 与 V2.5 的 SDK 原生 `question.asked` 事件统一走同一套交互管道（`WorkflowInteractionManager`）：

| 来源 | 触发方式 | 数据结构 | 回复路径 |
|------|---------|---------|---------|
| SDK 原生 `question.asked` | SDK Agent 执行中遇到问答需求 | `PendingQuestion.questions`（SDK 原生格式） | `replyQuestion()` |
| V2.6 `askUserQuestion` | FinalizeAssessor 判定 `completionType='ask'` | `PendingQuestion.questions`（对齐 DSH harness schema） | `replyQuestion()` |

> **区别**：SDK 原生 question 在 Step **执行中**触发（Agent 主动提问），askUserQuestion 在 Step **收尾时**触发（FinalizeAssessor 判定需确认）。两者统一走 `WorkflowInteractionManager`，前端无需区分处理。

### 1.6 DSH 中的交互映射

> 来源：`dsh-workflow.md` §5.3A

| sandore 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| `addPendingQuestion()` / `addPendingPermission()` | **引擎级 ask 以宿主主代理身份 `ctx.userQuestions.ask({ agent: hostAgent })`**（DSH 原生问答卡片 + await 答案）；pending Map 降级为「镜像持久化」（崩溃恢复） | **Step 子代理不能直接问用户**（`ctx.userQuestions.ask` 对 owned child 抛 `DELEGATED_CALLER`）；问答统一由宿主主代理发起 |
| `replyQuestion()` / `replyPermission()` | `ctx.userQuestions.ask` 的 await 返回值为主通道；`sandore.replyQuestion` RPC 保留为兼容回复路径 | 前端复用 DSH 原生问答卡片（`ui-user-questions`），审批卡片自写 ~50 行 |
| `buildPermissionRules()` / `autoReplyPermission()` | **DSH permission presets（子代理继承父级）** | DSH 无 permissionMode；Step 子代理继承宿主 Session 的 preset，approval 固定 `never` |
| 交互事件推送 | `question/requested` / `approval/requested` 帧（apiproxy SSE） | 前端无需区分工作流专属交互与普通交互 |

> **前端交互 UI 复用**（探索确认）：DSH 的问答/审批组件**不可跨插件 import**，但载体与领域类可复用——`PendingQuestion`（`ui-user-questions` 已导出）驱动自写问答卡片（照抄 QuestionComposer ~100 行），`PendingWait<'approval'>` 驱动自写审批卡片（照抄 ApprovalPanel ~50 行）。

> **DELEGATED_CALLER 关键修正（探索确认）**：DSH 的 `ctx.userQuestions.ask({ agent })` 对**非 root agent**（owned child，即可续接子代理）抛 `DELEGATED_CALLER`——「human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result」。因此 v2.6 的「SDK 原生 question（子会话直接问用户）」在 DSH 里**不可行**，语义迁移为：
> - **引擎级 ask（finalize `completionType='ask'`）**：以宿主主代理（root）身份 `ctx.userQuestions.ask({ agent: hostAgent, questions })`，DSH 原生卡片 + await 答案，直接闭环
> - **子代理 ask_user_question**：子代理问会 `DELEGATED_CALLER` → 子代理把问题写进 final result → 引擎从 `finalAssistantOutput` 解析问题 → 转成引擎级 ask（hostAgent 问）→ 答案 `followup` 给子代理继续
> - **pending Map 角色**：从「唯一权威」降级为「引擎级 ask 的镜像持久化」（requestId + 状态，崩溃恢复时重建交互），`replyQuestion` RPC 保留兼容

### 1.7 Task 4 RPC 清单（`remote.ts`）

Task 4 补 **7 个生命周期 RPC**（对齐 dsh-workflow §7.2，`@Remote` 装饰器挂 `SandoreRemote`，端点前缀 `sandore.*`）：

| RPC 方法 | 说明 | 对应 Service 方法 |
|---|---|---|
| `replyQuestion` | 问答回复（兼容路径，主通道是 `ctx.userQuestions.ask` 的 await） | `replyQuestion` |
| `replyPermission` | 权限回复 | `replyPermission` |
| `pauseStep` | 暂停某 Step | `pauseStep` |
| `resumeStep` | 定向恢复某 Step | `resumeStep` |
| `pauseAll` | 全局暂停所有 running/interacting Step | `pauseAllSteps` |
| `resumeAll` | 广播恢复所有暂停 Step | `resumeAllSteps` |
| `retryStep` | 重试失败 Step（continue/revert/fork） | `retryStep` |

**不做**：
- `getDiscussion`/`addChatMessage`——D5/D8 下讨论数据从宿主 Session 日志直读（`session/event` 帧），用户消息走宿主会话天然通道（DSH 原生 composer → 主代理），无需冗余 RPC
- `recoverInstance` RPC——崩溃恢复是「启动自动扫描」（`Service.init` 时 `recoverOrphanedInstances`），`recoverInstance` 作为内部 Service 方法，不单独暴露 RPC

---

## 2. 暂停与恢复机制

> 来源：`dynamic-workflow-engine.md` §5.4、§13

### 2.1 WorkflowLifecycleManager

**职责**：EventBus 订阅、暂停/恢复/中止。

**字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `pausedStepIds` | `string[]` | 当前暂停的 Step ID 列表 |
| `_onPauseStep` 等 5 个 | `((event) => void) \| null` | EventBus 处理器（V2.4: 移除 `_onRetryStep`） |

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `subscribeToEventBus` | `(): void` | 订阅 5 个 EventBus 事件（按 instanceId 过滤） |
| `unsubscribeFromEventBus` | `(): void` | 取消所有订阅 |
| `pauseStep` | `async (stepId): Promise<void>` | 暂停：runner.pause() → 获取最后 10 条会话消息快照（text 300 字符/tool 200 字符/reasoning 150 字符截断）→ renameStepMessage → 更新 pausedStepIds → emit `workflow.step_paused` |
| `resumeStep` | `async (stepId, resumePrompt?): Promise<void>` | 恢复：runner.resume() → 更新状态 → emit `workflow.step_resumed` |
| `pauseAllSteps` | `async (): Promise<void>` | 遍历所有 running/interacting runner → pauseStep → emit `workflow.all_paused` |
| `resumeAllSteps` | `async (resumePrompt?): Promise<void>` | 遍历 pausedStepIds → resumeStep → emit `workflow.all_resumed` |
| `abort` | `(): void` | setAborted → updateStatus('aborted') → 清空 concurrencyQueue → sseManager.stop() → emit `workflow.aborted` |
| `getPausedStepIds` / `setPausedStepIds` | — | 暂停列表 getter/setter |

> **V2.4 变更**：`retryStep()` 方法移至引擎本体（`retryFromStep()`），LifecycleManager 从 ~404 行缩减到 ~192 行。EventBus 订阅从 6 个事件减少到 5 个（移除 `workflow.retry_step`）。

### 2.2 架构概述

暂停/恢复通过**全局事件总线** `WorkflowEventBus` 实现 API 层到引擎的信号传递：

```
API 层 (POST /pause)                    引擎层
    │                                      │
    ▼                                      │
workflowEventBus.publishPauseStep()        │
    │                                      │
    └────────── EventBus 事件 ────────────►│
                                           │
                              lifecycle._onPauseStep()
                                           │
                              pauseStep(stepId)
                              ├── runner.pause()
                              │   ├── 设置 _paused/_status='paused'
                              │   ├── 创建 _resumePromise
                              │   └── SDK abortSession() 中止当前提示
                              ├── getSessionMessages(10) → 快照
                              │   过滤 system/user → 取最后 5 条
                              ├── updateStepStatusInExecutedSteps('paused')
                              ├── updateStepPauseMeta({ pausedAt, sessionMessages, pauseEntryId })
                              ├── clearPendingInteractions(stepId)
                              ├── 更新 pausedStepIds
                              ├── updateStatus('paused')
                              ├── renameStepMessage() 重命名 chat.json step ID
                              ├── persistState()
                              └── emit step_paused + chat_updated
```

### 2.3 WorkflowEventBus

全局单例 `EventEmitter`，`setMaxListeners(200)` 允许多引擎实例同时订阅。

**事件名称与负载**：

| 事件名 | 负载字段 | 发布方法 |
|--------|---------|---------|
| `workflow.pause_step` | `{jobId, instanceId, stepId}` | `publishPauseStep()` |
| `workflow.resume_step` | `{jobId, instanceId, stepId, resumePrompt?}` | `publishResumeStep()` |
| `workflow.pause_all` | `{jobId, instanceId}` | `publishPauseAll()` |
| `workflow.resume_all` | `{jobId, instanceId, resumePrompt?}` | `publishResumeAll()` |
| `workflow.abort` | `{jobId, instanceId}` | `publishAbort()` |
| `workflow.chat_updated` | `{jobId, instanceId}` | `publishChatUpdated()` |

> **注意**：`resume_step` 和 `resume_all` 事件负载包含 `resumePrompt` 字段，用于传递用户自定义恢复提示。

### 2.4 暂停流程

1. API 层调用 `workflowEventBus.publishPauseStep()`
2. 引擎 `_onPauseStep` 处理器：
   - 调用 `runner.pause()` → SDK `session.abort()` 中止当前提示
   - V2.3: 获取最后 **10** 条会话消息作为快照（text 截断 300 字符/tool 截断 200 字符/reasoning 截断 150 字符）
   - 调用 `renameStepMessage()` 在 chat.json 中重命名 step ID（添加 4 位 hex 后缀）
   - 更新 `pausedStepIds`
   - 持久化状态（`persistState()` 在 `renameStepMessage` **之后**调用）

### 2.5 恢复流程

1. API 层调用 `workflowEventBus.publishResumeStep()`
2. 引擎 `_onResumeStep` 处理器：
   - 通过正则 `/^(.+)-[a-f0-9]{4}$/` 解析带后缀的 ID（先查 `stepRunners.get(stepId)`，未命中则尝试去后缀再查）
   - 调用 `runner.resume(resumePrompt)` → SDK `sendChat()` 发送恢复提示
   - 调用 `appendStepMessage()` 在 chat.json 中追加新消息
   - 从 `pausedStepIds` 移除
   - 持久化状态

### 2.6 全局暂停/恢复

- `pauseAllSteps()`：遍历所有 StepRunner，逐个暂停
- `resumeAllSteps(resumePrompt?)`：遍历所有 StepRunner，逐个恢复

### 2.7 Step 级暂停/恢复（WorkflowStepRunner 内置）

- **`pause()`**：调用 SDK `session.abort()` 中止当前提示（会话保持存活），创建 `_resumePromise`
- **`resume(resumePrompt?)`**：通过 SDK `sendChat()` 发送恢复提示，resolve `_resumePromise`
- **`initPausedState(sessionId)`**：从崩溃恢复时初始化为暂停状态，返回 `_resumePromise`

### 2.8 DSH 中的暂停/恢复映射

> 来源：`dsh-workflow.md` §5.3

| sandore 能力 | DSH 等价组件 |
|---|---|
| `runner.pause()`（session.abort） | `ctx.subagents.interrupt(stepSessionId, authority)` |
| `runner.resume()`（sendChat） | `ctx.subagents.followup(parent, stepSessionId, ...)` |
| EventBus `workflow.pause_step` 等 | Cordis 事件 `ctx.emit`/`ctx.on` |

### 2.9 主代理 = 工作流编排器（广播恢复语义的迁移）

> 来源：`dsh-workflow.md` §5.1A（关键设计）

**核心矛盾**：迁移后「工作流宿主 Session」是真正可对话的**主代理**。原 sandore 的「讨论面板发消息（无 @）= 广播恢复所有暂停 Step」在 DSH 里会触发主代理的 agent loop（消息被当闲聊处理），广播恢复语义丢失。

**解决**：把「隐式广播恢复」替换为「主代理持有的编排器工具」——用户自然语言意图 → 主代理 agent loop → 显式调用工具：

| 原 sandore 交互 | DSH 迁移后 |
|---|---|
| 发消息（无 @）→ 广播恢复 | 用户说「继续」→ 主代理调 `sandore_resumeAllPaused` |
| `@StepA xxx` → 定向恢复 | 用户说「让 StepA 继续做 xxx」→ 主代理调 `sandore_resumeStep(A, xxx)` |
| `@StepA` + 重试选择器 → 重试 | 用户说「重试 StepA，fork 模式」→ 主代理调 `sandore_retryStep(A, 'fork')` |

**主代理工具清单**（`tool` Consumer 注册到 `ctx.tools`）：

| 工具名 | 功能 |
|---|---|
| `sandore_getState` | 查看执行状态 |
| `sandore_startInstance` / `sandore_abortInstance` | 启动 / 中止工作流 |
| `sandore_pauseStep` / `sandore_pauseAllSteps` | 暂停某 Step / 全部 |
| `sandore_resumeStep` / `sandore_resumeAllPaused` | 定向恢复 / 广播恢复 |
| `sandore_retryStep` | 重试失败 Step（continue/revert/fork） |

**与 Step 子对话页互补**：Step 级精确暂停/继续仍走子对话页 composer 的 Stop/Send 原生路由（`subagent.interrupt`/`subagent.prompt`），主对话走「自然语言 → 编排器工具」——两条路不冲突。

**主代理身份不切换，靠「工具语义 + 实例状态」自然降级**（回答「何时编排、何时自由对话」）：

主代理**始终是同一个 agent**，同时持有 `sandore_*` 工具 + 普通 agent 能力，角色区分靠**实例状态 + 工具语义自然降级**：

| 实例状态 | 工具行为 | 主对话自然角色 |
|---|---|---|
| running / interacting / paused | `pauseStep`/`resumeStep`/`retryStep` 有效 | 编排器 |
| completed | `resume`/`retry` 失效（no-op），仅 `getState` 只读 | 自由对话（自然延续） |
| failed | `retryStep` 有效 | 编排器（可重试） |

工具**不需要退场**——`resume`/`retry` 对已完成实例返回无害 no-op，`getState` 对任何状态都有意义。工具存在 ≠ 强制使用。

**影响隔离**：`sandore_*` 工具**只挂在「工作流宿主 Session」这个 agent 上**（per-instance 组合），不是全局注册——DSH 普通会话（默认 preset）无这些工具、其他工作流实例各有自己的工具（绑定各自 `instanceId`），互不干扰。

**「默认挂载会话」修正**：v2.6 的「完成后额外挂载新默认会话」被取代——**宿主 Session 本身在 `completed` 后自然降级为自由对话 agent，它就是那个"默认挂载会话"**。全程同一个 Session，无需切换、无需挂载、无需「组合 chat.json 消息注入」（宿主 Session 日志天然就是工作流历史 + 后续对话）。

**暂停登记表（引擎自建，DSH 无 paused 状态）**：DSH 的 `Agent.status` 只有 `idle`/`running`，无 `paused`/`interacting`；续接管理器的 `ActivationState` 是私有类型。因此 `resumeAllPaused` **无法靠查询子代理状态枚举「暂停集」**——引擎必须自建 `pausedChildIds: Set<string>`（对应原 `pausedStepIds[]`），并持久化到 work.json 快照：

```
pauseStep:  interrupt(childId, {kind:'ancestor', agent:hostAgent}) + pausedChildIds.add(childId) + persist
resumeAllSteps: 遍历 pausedChildIds → followup(hostAgent, childId, content, {source,signal}) + delete + persist
```

辅助信号（非权威）：`agent.status==='idle'` + `agent.inbox.hasPending`（排队中也会满足）。

> **决策 D9（新增）**：主代理 = 工作流编排器。广播恢复从「隐式消息路由」改为「显式工具调用」；主代理身份不切换，靠「工具语义 + 实例状态」自然降级（编排器 ↔ 自由对话）；「默认挂载会话」= 宿主 Session 的自然延续，无需额外挂载；「暂停登记表」由引擎自建（DSH 无 paused 状态）。

---

## 3. 中止机制

> 来源：`dynamic-workflow-engine.md` §5.4

### 3.1 abort 流程

`WorkflowLifecycleManager.abort()` 执行以下操作：

1. `setAborted(true)` — 设置中止标志
2. `updateStatus('aborted')` — 更新引擎状态
3. 清空 `concurrencyQueue`
4. `sseManager.stop()` — 停止 SSE 连接
5. `emit('workflow.aborted')` — 发射中止事件

> **中止后清理**：`deleteInstance()` 时同步调用 `closeDefaultSession()`（V2.6）。`aborted` 状态**不**挂载默认会话，直接清理。

### 3.2 API 层

```typescript
abortInstance(jobId, instanceId): { instanceId, status }
  // → 验证非终态 → engine.abort()
```

---

## 4. 重试机制 — continue/revert/fork

> 来源：`dynamic-workflow-engine.md` §20.3

### 4.1 三种重试模式

用户通过 `retryStep()` API 对失败的 Step 发起重试，支持 3 种模式：

| 模式 | 说明 | SDK 操作（原 sandore） | DSH 实现（经探索修正） |
|------|------|---------|---------|
| `continue` | 在同一会话中继续（追加用户消息） | `sendChat(sessionId, userMessage)` | `ctx.subagents.followup(hostAgent, childId, [{type:'text',text:message}], {source,signal})` |
| `revert` | 回退到指定消息后继续 | `revertSession(sessionId, messageID)` → `sendChat()` | **DSH 无 revert 原语**：`ctx.sessions.fork(childId, turn边界)` + `ctx.agents.create({seed})` 续跑，**产生新 session id**，回退粒度是 turn 边界 |
| `fork` | 从指定消息分叉新会话 | `forkSession(sessionId, messageID)` → `sendChat(newSessionId)` | `ctx.sessions.fork(childId, boundary?)`（现成原语）→ 新 agent 续跑 |

### 4.2 StepExecutionOptions 类型

```typescript
type StepExecutionMode = 'normal' | 'retry' | 'recover' | 'resume';

interface StepExecutionOptions {
  mode: StepExecutionMode;
  retryMode?: 'continue' | 'revert' | 'fork';
  retryUserMessage?: string;
  revertMessageId?: string;
  recoverSessionId?: string;
  recoverResumePrompt?: string;
}
```

### 4.3 RetryRecord 类型

```typescript
interface RetryRecord {
  mode: 'continue' | 'revert' | 'fork';
  timestamp: string;                       // ISO 时间戳
  userMessage: string;                     // 用户重试消息
  revertMessageId?: string;               // revert 模式下的消息 ID
  result: 'running' | 'completed' | 'failed';  // 重试结果
}
```

> `retryHistory` 存储在 `ExecutedStepDefault.retryHistory` 数组中。

### 4.4 API 层流程

```typescript
async retryStep(jobId, instanceId, stepId, mode, message, revertMessageId?): Promise<{ stepId, status }>
```

流程（V2.4 重构）：
1. 获取旧引擎实例 → `workflowManager.delete()` 销毁
2. 从 work.json 加载持久化状态
3. 重新解析 YAML → 创建新 `WorkflowEngineV2`（传入 `permissionMode`）
4. `workflowManager.register()` 注册新引擎
5. 调用 `engine.retryFromStep(stepId, mode, userMessage, revertMessageId)`

### 4.5 引擎层流程（`engine.retryFromStep()`）

V2.4: 从 LifecycleManager 移至引擎本体。

1. 查找 Step 定义和 DAG 节点（`getNodeIndex().get(stepId)` → `node.step`）
2. 查找 executedSteps 中的 Step 条目（`findStepInExecutedSteps(stepId)`）
3. 记录旧 sessionId（Fork 模式用于 parentSessionId 追踪）
4. 更新工作流 + Step 状态 → `running`
5. 清除上一轮 pause/finalize 残留字段（`pausedAt`/`resumedAt`/`resumePrompt`/`sessionMessages`/`pauseEntryId`/`finalizeMeta`）
6. 更新 sessionMeta（清空 `outputJson`；fork 模式额外清空 `sessionId`）
7. 清除该 Step 的 passThroughVars（finalize 重新提取）
8. 更新 chat.json：`pruneOrphanedStepMessages()` 清理孤立消息 → `renameStepMessage()` 重命名旧条目为 `stepId-XXXX`（status='failed'）→ `appendStepMessage()` 追加新 running 条目
9. 持久化状态 + 发射 `workflow.step_retry` / `workflow.chat_updated` 事件 + 启动 SSE
10. 创建新 runner → `runner.initForRetry(oldSessionId)` → 存入 `stepRunners` → `relayStepEvents()`
11. `enqueueNode(stepId, {mode:'retry', retryMode, retryUserMessage, revertMessageId})` → `runExecutionLoop()`
12. Fork 模式：若 sessionId 变化则记录 `parentSessionId` 到 executedStep
13. 添加 `RetryRecord` 到 `retryHistory`（result = `'completed'` 或 `'failed'`）
14. 更新工作流状态（completed/failed）+ 持久化
15. 异常分支：标记 Step failed + 添加 failed RetryRecord + 工作流 failed
16. finally：工作流 failed 时保持 EventBus + SSE 存活

### 4.6 executeStepNode retry 分支

`runExecutionLoop()` → `processNode()` → `executeStepNode()` 中，retry 模式复用 `stepRunners` 中的 runner 和 `executedSteps` 中的 runningEntry：

- `runner.retry(retryMode, retryUserMessage, revertMessageId)` → `runner.collectOutput()`
- `runPostStepPipeline()` 共享后处理（output.json + finalize + outputTo）

### 4.7 runner.retry() 流程

- 设置 status = `running`
- `continue`：直接 `sendChat(sessionId, userMessage)`
- `revert`：`revertSession(sessionId, revertMessageId)` → `sendChat()`
- `fork`：`forkSession(oldSessionId)` → 更新 `_sessionId` → `sendChat(newSessionId)`
- 发射 `started` 事件（引擎据此更新 sessionMeta + 文件名映射）
- `listenForEvents()` 等待会话空闲
- 若 retry 期间被 pause，等待 resume 后重新监听
- 发射 `interaction_resolved` 事件

### 4.8 DSH 中的重试映射

> 来源：`dsh-workflow.md` §5.3

| sandore 能力 | DSH 等价组件 |
|---|---|
| `retry()` continue 模式 | `ctx.subagents.followup(parent, stepSessionId, ...)` |
| `retry()` revert 模式 | `ctx.sessions.create({ seed })`（seed 前缀）/ session 回退原语 |
| `retry()` fork 模式 | `ctx.sessions.create({ seed })`（fork seed = 父日志前缀） |

---

## 5. 崩溃恢复 — 断点续传

> 来源：`dynamic-workflow-engine.md` §5.7、§14

### 5.1 WorkflowRecoveryManager

**职责**：崩溃恢复、状态恢复。

**无私有字段**（纯协调器，所有状态通过引擎 getter/setter 访问）。

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `restoreFromState` | `(state: WorkflowTaskState): void` | 从持久化状态恢复所有内存数据 |
| `recover` | `async (persistedState: WorkflowTaskState): Promise<void>` | 主恢复入口：A-H 阶段编排 |
| `updateOverallStatusAfterRecovery` | `(): void` | 扫描 executedSteps 更新整体状态 |

> **V2.4 重大变更**：`recoverStepNode()` 方法已删除（~100 行）。恢复路径统一：
> - **Running 步骤**：`enqueueNode(stepId, {mode:'recover'})` → `runExecutionLoop()` → `executeStepNode` 中 recover 分支 → `runner.recoverFromSession()` + `runner.collectOutput()` + `runPostStepPipeline()`
> - **Paused 步骤**：preload runner + `initPausedState(sessionId)`，后台 Promise 等待 resume 后调用 `runPostStepPipeline`

### 5.2 恢复策略表

| Step 状态 | 恢复策略 |
|----------|---------|
| `running` / `interacting` | `enqueueNode(stepId, {mode:'recover', recoverSessionId})` → 统一走 `executeStepNode` recover 分支 → `runner.recoverFromSession()` + `collectOutput()` + `runPostStepPipeline()` |
| `paused` | 不自动恢复：preload runner + `initPausedState(sessionId)`，发出 `step_paused` + `chat_updated` 事件；后台 Promise 等待用户 resume 后 `collectOutput()` → `runPostStepPipeline()` → `resolveNextNodes()` |
| `completed` / `failed` | 无需恢复 |
| Shell 类型 | 无法恢复（子进程已丢失），标记为 `failed` |
| 无 `sessionId` | 无法恢复（会话已丢失），标记为 `failed` |

### 5.3 recover() 八阶段流程（A–H）

```
A. restoreFromState(persistedState) — 恢复所有内存数据
   ├── status, currentStageId, createdAt
   ├── pendingQueue, visitCounts, pausedStepIds
   ├── activeLoopStack, activeLoopIterationStack (V2.3)
   ├── passThroughVars, permissionMode (setPermissionModeSilent，不触发 persistState)
   ├── userChatMessages
   └── 从 executedSteps 重建 stepStatuses / stepSessionIds / stepInput/Output/PartsFileNames / stepIdSuffixMap

B. interactionManager.clearAll() — 清除 stale pendingInteractions（旧 requestId 已失效）

C. 启动共享 SSE + 订阅 EventBus（startSharedSSE + subscribeToEventBus）

D. 遍历 executedSteps，筛选需恢复的步骤（running / interacting / paused）

E. 逐 Step 恢复（preloadForRecovery + 分类处理）：
   ├── Shell 步骤 / 无 sessionId → 标记为 failed，跳过
   ├── paused → preload runner + initPausedState(sessionId)
   │     ├── relayStepEvents(runner)，runner.skipCollectOutput = true
   │     ├── 发出 step_status_changed + step_paused + chat_updated 事件
   │     └── 后台 Promise：waitForResumeAndComplete() → collectOutput()
   │           → runPostStepPipeline() → finalizeExecutedStep() → resolveNextNodes()
   │           → 若有新步骤入队则再跑一轮 runExecutionLoop
   └── running/interacting → 标记 running + 发出 step_status_changed + chat_updated 事件
         └── enqueueNode(stepId, {mode:'recover', recoverSessionId: sessionId})

F. 持久化 + 协调 chat.json
   ├── updateStatus(hasPausedSteps ? 'paused' : 'running')
   ├── persistState()
   ├── reconcileChatState()（V2.4: 检查 renamed variant stepId-XXXX，追加缺失步骤）
   └── 发出 chat_updated 事件

G. 若 pendingQueue 为空且无暂停步骤 → enqueueNextUnexecutedStep()（补入当前 stage 未执行步骤）

H. 主执行循环 runExecutionLoop()（与 execute() 共享）
   ├── 处理 E 阶段入队的 recover 步骤（经 executeStepNode recover 分支）
   ├── 完成后判定：hasFailedSteps → 'failed'；否则（无暂停步骤）→ 'completed'
   └── finally：status 非 'failed'/'paused' 时关闭 EventBus + SSE
```

> **DSH 迁移映射（经探索确认，覆盖上面 A–H 的原始语义）**：
> - **C 阶段「启动共享 SSE」废弃**（D5）：改为 apiproxy 双 SSE 流 + Cordis 事件，无需自建。
> - **A 阶段的 `permissionMode` 废弃**（权限修正）：权限由宿主 Session preset 决定。
> - **新增：宿主 Session（主代理）冷恢复**——崩溃恢复时引擎必须先 `ctx.agents.resume({ resumeSessionId: hostSessionId })` 重建宿主主代理。关键：`resume` 会**重新执行 `setup(agentCtx)` 回调**（见 dsh-workflow.md §5.1A），因此 `sandore_*` 工具 + instanceId 闭包 + system prompt 会自动重新注册；同时引擎重新持有 live `hostAgent` 引用（后续 interrupt 的 authority）。
> - **新增：子代理冷恢复**——running/interacting 的 Step 子代理用 `ctx.subagents.followup(hostAgent, childId, ...)` 触发冷恢复（followup 对 absent child 自动从持久化 Session 恢复），无需显式 `ctx.agents.resume()`；或 `listChildren(hostSessionId)` 枚举 durable 子代理。
> - **Step 完成等待**：`ctx.agents.get(childId).whenIdle()`（先 followup 再 await，再读 `finalAssistantOutput(child.session.events)`），详见 task-2 §5.3 / task-3 §2.1。
> - **A 阶段 `pausedStepIds` → `pausedChildIds` 改名**（§2.9）：恢复时从 state 快照读 `pausedChildIds`（值=子代理 SessionId）重建引擎暂停登记表；`resumeStep(stepId)` 经 `executedSteps[].sessionMeta.childId` 反查 childId。

### 5.4 孤儿实例扫描

启动时扫描存储域 `sandore` 的 state 表（**经探索修正**：不再是 `~/.harness/data/workflows/jobs/` 文件目录）：

- 遍历 storageDomain 的 state 表所有 key（= instanceId），跳过终态实例
- 对非终态实例：从 work.json 快照重建引擎 + `ctx.agents.resume({ resumeSessionId: hostSessionId })` 冷恢复宿主主代理 + 恢复 running/interacting/paused 的 Step 子代理
- 返回 `{ recovered: string[], errors: Array<{ instanceId, error }> }`

**recoverInstance 流程**（DSH 迁移版）：
1. 从 storageDomain 读 work.json 快照 → 重建引擎内存状态
2. `ctx.agents.resume({ resumeSessionId: hostSessionId })` 冷恢复宿主主代理（setup 重跑，工具/instanceId 重注册，重新持有 hostAgent authority）
3. 遍历 executedSteps：running/interacting → `followup` 冷恢复子代理并等待完成；paused → 恢复暂停登记表，等待手动 resume
4. 持久化 + 重跑执行循环

### 5.5 DSH 中的崩溃恢复映射

> 来源：`dsh-workflow.md` §5.3

| sandore 能力 | DSH 等价组件 |
|---|---|
| `recoverFromSession(sessionId)` | `ctx.agents.resume({ resumeSessionId })`（冷恢复可续接子代理） |
| `work.json` 持久化 | `ctx.storageDomain.open(spec)` — schema 验证 KV，key = instanceId |
| `chat.json` 持久化 | DSH Session 事件日志（`ctx.sessions` + `ctx.sessionPersistence`） |
| 孤儿实例扫描 | DSH 启动时调用 `recoverOrphanedInstances()` |

---

## 6. 默认挂载会话 — DefaultSessionManager（D9 修正：已被「宿主 Session 自然延续」取代）

> 来源：`dynamic-workflow-engine.md` §5.10、§13A。**⚠️ D9 修正后，本节整段是「原 v2.6 语义」的历史规格，迁移到 DSH 后不再实现 DefaultSessionManager**——「默认挂载会话」= 宿主 Session（主代理）在 `completed` 后自然降级为自由对话 agent，无需额外挂载新会话、无需 `buildSessionParts` 组合消息注入（宿主 Session 日志天然就是工作流历史 + 后续对话）。以下 §6.1–§6.11 仅作语义对照保留。

### 6.1 设计理念（v2.6 原始语义，迁移后废弃）

V2.5 工作流执行完成后，实例进入终态（`completed`/`failed`/`aborted`），用户无法继续交互。V2.6 引入**默认挂载会话**机制（迁移后废弃，见 D9）：

- **无缝衔接**：工作流完成后自动挂载默认会话，用户无需重新创建会话即可继续对话
- **上下文继承**：默认会话创建时，将 `chat.json` 中的消息列表统一组合为 parts 注入，Agent 消息按 `assistant` 角色，用户消息按 `user` 角色
- **每 instance 独立**：每个工作流实例完成后挂载自己的默认会话，生命周期与 instance 绑定

### 6.2 DefaultSessionMeta 类型

```typescript
DefaultSessionMeta {
  sessionId: string                       // SDK 会话 ID
  instanceId: string                      // 关联的实例 ID
  status: 'active' | 'idle' | 'closed'    // 会话状态
  mountedAt: string                       // 挂载时间（工作流完成后）
  lastActivityAt: string                  // 最后活动时间（用于空闲清理）
  messageCount: number                    // 组合注入的 chat.json 消息数
}
```

### 6.3 字段与方法

**字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `defaultSessions` | `Map<string, DefaultSessionMeta>` | instanceId → 默认会话元数据 |
| `idleCheckTimer` | `NodeJS.Timeout \| null` | 空闲检查定时器（30 分钟周期） |

**方法清单**：

| 方法 | 签名 | 说明 |
|------|------|------|
| `mountDefaultSession` | `async (instanceId: string): Promise<DefaultSessionMeta>` | 工作流进入终态后挂载默认会话。幂等：已存在默认会话时直接返回 |
| `routeUserMessage` | `async (instanceId: string, message: string, atStepId?: string): Promise<void>` | 终态消息路由。`failed` 且带 `@mention` → 走重试逻辑；否则 → `sendToDefaultSession()` |
| `buildSessionParts` | `(chatState: ChatState): Array<...>` | 将 chat.json 消息列表组合为 parts |
| `sendToDefaultSession` | `async (instanceId: string, message: string): Promise<void>` | 向默认会话发送用户消息（fire-and-forget） |
| `getDefaultSession` | `(instanceId: string): DefaultSessionMeta \| undefined` | 获取默认会话元数据 |
| `closeDefaultSession` | `async (instanceId: string): Promise<void>` | 关闭默认会话（删除 SDK 会话 + 清理元数据） |
| `checkIdleSessions` | `(): void` | 扫描所有默认会话，关闭空闲超过 30 分钟的会话 |
| `recoverDefaultSession` | `async (instanceId: string, meta: DefaultSessionMeta): Promise<void>` | 崩溃恢复时恢复默认会话 |

### 6.4 挂载时机

默认会话在工作流进入终态（`status='completed'` 或 `status='failed'`）后自动挂载，触发点位于 `execute()` 的 `finally` 块：

```
WorkflowEngineV2.execute() 进入终态
    │
    ├── status = 'completed'
    │
    └── status = 'failed'（保持 EventBus+SSE 存活，支持重试）
    │
    ▼
defaultSessionManager.mountDefaultSession(instanceId)
    ├── 读取 chat.json
    ├── 组合消息为 parts（assistant/user 角色）
    ├── 创建 SDK 会话
    ├── 注入消息（sendChat with parts）
    ├── 持久化 DefaultSessionMeta 到 work.json
    └── 发射 workflow.default_session_mounted 事件
```

> **两种完成态均挂载**：`completed` 与 `failed` 都触发挂载（幂等：已挂载则跳过）。`failed` 态挂载默认会话后，仍保持 EventBus + SSE 存活以支持 @mention 重试，两者互不冲突。`aborted` 状态不挂载，直接清理。

### 6.5 消息组合规则

`buildSessionParts(chatState)` 将 chat.json 消息列表组合为 SDK 会话的 parts：

| chat.json 消息类型 | SDK 会话角色 | 组合内容 |
|-------------------|-------------|---------|
| `type='step'`（Agent 输出） | `assistant` | `"{stepName}\n{returnPrompt}\n[状态: {status}]"` |
| `type='user'`（用户消息） | `user` | `data.content`（原始内容） |

**过滤规则**：
- 跳过 `returnPrompt` 为空的 step 消息
- 跳过暂停重命名的 step 消息（`id` 含 4 位 hex 后缀，保留为历史记录不注入）
- 保持消息时间顺序

### 6.6 用户交互

默认会话挂载后，用户通过 API 发送消息：

```
POST /api/workflows/jobs/:jobId/instances/:instanceId/default-session/chat
Body: { message: string }
    │
    ▼
defaultSessionManager.sendToDefaultSession(instanceId, message)
    ├── 获取 DefaultSessionMeta
    ├── SDK sendChat(sessionId, message)（fire-and-forget）
    ├── 更新 lastActivityAt
    └── 发射 workflow.default_session_message 事件
```

### 6.7 终态消息路由（completed / failed）

工作流进入终态后，用户在输入框发送的消息按实例状态 + 是否 `@mention` 分流：

| 实例状态 | 输入形态 | 路由目标 |
|---------|---------|---------|
| `completed` | 任意消息 | 默认会话（`sendToDefaultSession`） |
| `failed` | `@mention` 失败 Step | 原重试逻辑（`retryStep`） |
| `failed` | 直接消息（无 @mention） | 默认会话（`sendToDefaultSession`） |

> **failed 态两条路径并存**：`failed` 状态下 `@mention` 仍是之前的重试逻辑；不带 `@mention` 的直接消息走挂载的默认会话。重试成功后工作流转为 `completed`，默认会话保持存活，用户可继续在其上对话。

### 6.8 空闲清理

- `checkIdleSessions()` 每 30 分钟扫描所有默认会话
- `lastActivityAt` 超过 30 分钟未活动的会话自动关闭（`closeDefaultSession`）
- 关闭操作：删除 SDK 会话 + 清理 `DefaultSessionMeta` + 持久化

### 6.9 崩溃恢复

进程重启后，`recoverOrphanedInstances()` 恢复实例时：
- 检查 `work.json` 中的 `defaultSessionMeta` 字段
- 若存在且 `status='active'`：调用 `recoverDefaultSession(instanceId, meta)` 恢复
- 恢复后用户可继续向默认会话发送消息

### 6.10 生命周期管理

| 事件 | 行为 |
|------|------|
| 工作流进入终态（`completed` / `failed`） | `mountDefaultSession()`（`failed` 同时保持 EventBus+SSE 存活） |
| `failed` 态用户发送消息 | `routeUserMessage()`：`@mention` 失败 Step → 重试；直接消息 → `sendToDefaultSession()` |
| 用户向默认会话发送消息 | 更新 `lastActivityAt` |
| 空闲超 30 分钟 | `closeDefaultSession()` |
| `deleteInstance()` | `closeDefaultSession()` + 清理 |
| 进程重启 | `recoverDefaultSession()`（若 meta 存在） |

### 6.11 API 端点

| Method | Path | 说明 |
|--------|------|------|
| GET | `.../default-session` | 获取默认会话元数据 |
| POST | `.../default-session/chat` | 向默认会话发送消息（fire-and-forget） |
| DELETE | `.../default-session` | 关闭默认会话 |

### 6.12 DSH 中的默认会话映射

> 来源：`dsh-workflow.md` §5.3

| sandore 能力 | DSH 等价组件 |
|---|---|
| `createSession()` + `sendChat()` | `ctx.agents.create({ sessionId, ... })` + `send()` |
| `defaultSessionMeta` 持久化 | `work.json` → `ctx.storageDomain` 存储域 |

---

## 7. 事件与 SSE 推送（决策 D5）

> 来源：`dsh-workflow.md` §5.5

### 7.1 决策 D5：事件/SSE 全用 DSH，零自建

**完全移除** sandore 的 `WorkflowEventBus` + `WorkflowSseManager` + `SdkSseManager` 三套事件/SSE 机制，**不新建**任何独立事件总线、SSE 端点或 SSE 管理器。全部复用 DSH 既有链路：

1. **引擎内部事件**：`sandore/*` 用 Cordis 事件（`ctx.emit`/`ctx.on`，observe-only emit + 数据快照，与 DSH `workflow/*` 事件同构）；
2. **推送到前端**：走 DSH apiproxy 的**双 SSE 流**（`/api/events.mux` 会话帧 + `/api/events.host` 主机帧）——宿主 Session 的 `sandore/*` 事件经 `session/event` 帧透传，状态快照经 `ctx.sessionProjections` 的 `session/projection` 帧推送，问答/权限经 `question/requested`/`approval/requested` 帧；
3. **子代理追踪 + idle 等待**：由 `ctx.subagents`（`subagent/start`/`subagent/end` 事件 + `listChildren`）与可续接子代理的 Session 事件驱动，不重造 `sessionIdleResolvers`/`sessionSubAgents`；
4. **SSE 重连/规范化/持久化**：由 apiproxy SSE 客户端与 `ctx.sessionPersistence` 承担，不重造指数退避/partId 修复/jsonl。

### 7.2 sandore/* 事件定义

```typescript
declare module '@deepseek-ai/cordis' {
  interface Events {
    'sandore/start'(info: DagRunInfo): void
    'sandore/stage-start'(info: DagRunInfo, stageId: string): void
    'sandore/stage-completed'(info: DagRunInfo, stageId: string, contract: StageContract): void
    'sandore/step-start'(info: DagRunInfo, stepId: string, childId: string): void
    'sandore/step-completed'(info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[]): void
    'sandore/step-failed'(info: DagRunInfo, stepId: string, childId: string, error: string): void
    'sandore/step-paused'(info: DagRunInfo, stepId: string, childId: string): void
    'sandore/step-resumed'(info: DagRunInfo, stepId: string, childId: string, resumePrompt?: string): void
    'sandore/step-retried'(info: DagRunInfo, stepId: string, mode: string): void
    'sandore/question'(info: DagRunInfo, question: PendingQuestion): void
    'sandore/permission'(info: DagRunInfo, permission: PendingPermission): void
    'sandore/end'(info: DagRunInfo, result: DagResultInfo): void
    'sandore/aborted'(info: DagRunInfo): void
    // （D9 修正：无 default-session-mounted 事件——宿主 Session 自然延续为自由对话，不额外挂载默认会话）
  }
}
```

### 7.3 推送链路

```
引擎内部事件 (sandore/*)
    │
    ├── ctx.emit('sandore/step-completed', ...)
    │
    ▼
DSH apiproxy 双 SSE 流
    ├── /api/events.mux（会话帧）
    │   ├── session/event：sandore/* 事件透传
    │   ├── session/projection：状态快照推送
    │   ├── question/requested：问答交互
    │   └── approval/requested：权限交互
    └── /api/events.host（主机帧）
```

### 7.4 实时监控

前端 `WorkflowRunView` 通过轮询 `host.call('sandore.getState', { instanceId })`（对齐原 3s/5s 轮询）+ 订阅 `sandore/*` 事件推送。

---

## 8. 讨论面板：sandore-step Chat 节点（决策 D8）

> 来源：`dsh-workflow.md` §6.4

### 8.1 决策 D8

**讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制**：每个 Step 折叠为一个 `sandore-step` 节点（`ConversationNodeDefinition` + `conversation.chat.node` keyed），内联最后结果消息，点击跳转子对话页。不复制单 Session Chat 视图。

### 8.2 数据来源（两级）

| 层级 | Session | 承载内容 | 对应 chat.json |
|---|---|---|---|
| 骨架 | 工作流宿主 Session（每 instance 一个） | `sandore/*` 事件：Step 开始/完成/失败、用户消息、暂停/恢复、循环迭代 | ChatMessage 的 `type`/`status`/`createdAt`/`loopIteration` |
| 内容 | 每个 Step 的可续接子代理 Session | 该 Step 的实际对话（returnPrompt、工具调用、产物） | ChatStepData 的 `returnPrompt`/`sessionMessages` |

### 8.3 渲染方式

参考 DSH 现有 `ui-workflow-run` 的「多 member 组合为 Chat 节点」模式：

```
sandore-step Chat 节点（主对话消息流里，与普通消息节点混排）
├── 每个 Step 折叠为一个 sandore-step 节点（ConversationNodeDefinition + conversation.chat.node keyed）
│   ├── 状态徽章 + 名称 + loopIteration 标签（#1.2）
│   ├── 执行中：running，无结果；完成：内联最后一条 assistant 结果消息（returnPrompt）
│   └── 失败：红色边框；暂停：琥珀色边框
├── 用户消息：右对齐气泡（DSH 原生渲染）
└── 点击 Step 节点 → ctx.sessions.open(childId) 跳到子代理 Session 完整对话页（DSH 默认 UI）
```

### 8.4 关键设计点

1. **不复制 DSH 的单 Session Chat 视图**，而是复用 `ui-workflow-run` 的「多 run 折叠为 Chat 节点」模式（`ConversationNodeDefinition` + `conversation.chat.node` keyed），每个 Step 折叠为一个 `sandore-step` 节点。
2. **子代理 Session 导航**：点击某 Step 条目可打开对应子代理 Session 的完整对话（复用 `ctx.sessions.open(id)` / 普通 Session 视图），而非在工作流视图内内联重放整个子代理对话。
3. **实时性**：骨架靠宿主 Session 的 `sandore/*` 事件（经 apiproxy SSE `session/event` 帧）实时更新；内容按需从子代理 Session 派生（打开时才加载）。

> **Task 4 落点（仅引擎侧就绪，渲染器留 Task 5）**：Task 4 产出只有 `workflow` + `tool` 两包（无 `ui` 包）。「可渲染性」由**引擎侧事件载荷保证**——`step-paused`/`step-resumed`/`step-retried`/`question`/`permission` 事件正确 `session.append` 且 payload 完整（`childId`/`output` 内联），单测断言事件序列 + 载荷；`ConversationNodeDefinition` + `conversation.chat.node` keyed 渲染器（DagStepNodeView）留 Task 5（`ui` 包）。

---

## 9. 验证标准

Task 4 的验收标准为 **暂停/恢复/重试/崩溃恢复/消息聚合（宿主主代理延续）全链路可用**。具体验证点：

### 9.1 交互验证

- [ ] SDK Agent 执行中触发权限请求 → 前端展示权限卡片 → 用户回复 → Agent 继续执行
- [ ] SDK Agent 执行中触发问答 → 前端展示问答卡片 → 用户回复 → Agent 继续执行
- [ ] FinalizeAssessor 判定 `ask` → Step 进入 interacting → 用户回复 → Step 恢复 → 推进下一节点
- [ ] 权限自动回复（`bypassPermissions` 模式）→ 权限请求静默处理

### 9.2 暂停/恢复验证

- [ ] `pauseStep` → `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })` → 引擎暂停登记表记录 → 前端显示暂停状态（`sandore/step-paused` 事件）
- [ ] `resumeStep`（含 `resumePrompt`）→ `ctx.subagents.followup(hostAgent, childId, ...)` → 前端恢复（`sandore/step-resumed` 事件）
- [ ] `pauseAllSteps`（全部暂停）→ 所有 running/interacting Step 暂停并登记
- [ ] `resumeAllSteps`（全部恢复）→ 遍历暂停登记表恢复所有暂停 Step

### 9.3 重试验证

- [ ] `retryStep(mode='continue')` → 在同一会话中追加消息 → Step 重新执行 → 成功/失败
- [ ] `retryStep(mode='revert')` → 回退到指定消息 → 继续执行
- [ ] `retryStep(mode='fork')` → 分叉新会话 → 继续执行 → 新 sessionId 记录
- [ ] 重试成功 → 工作流转 `completed` → 宿主 Session 自然降级为自由对话（D9）
- [ ] 重试失败 → 工作流保持 `failed` → 主代理可用 `sandore_retryStep` 再次重试

### 9.4 崩溃恢复验证

- [ ] 进程重启 → 启动扫描 storageDomain `state` 表（`recoverOrphanedInstances`）→ 恢复非终态实例
- [ ] Running/interacting 步骤 → `ctx.agents.resume({ resumeSessionId: hostSessionId })` 冷恢复宿主主代理 + `followup` 冷恢复子代理 → 继续执行
- [ ] Paused 步骤 → 恢复暂停登记表 → 等待用户手动恢复
- [ ] Shell 步骤 → 标记为 `failed`（不可恢复）
- [ ] 状态快照从 storageDomain `state` 表重建，与 Session 事件日志一致
- [ ] 恢复后 `sandore/*` Session 事件 + apiproxy SSE 正常工作

### 9.5 宿主主代理延续验证（D9）

- [ ] 工作流 `completed` → 宿主 Session 自然降级为自由对话 agent → 用户可继续对话（无需额外挂载默认会话）
- [ ] 工作流 `failed` → 主代理可用 `sandore_retryStep` 工具重试失败 Step → 直接消息由主代理自然处理
- [ ] `sandore_*` 工具仅挂宿主 Session（per-instance 闭包捕获 instanceId），不影响普通会话/其他工作流
- [ ] 崩溃恢复 → `ctx.agents.resume({ resumeSessionId: hostSessionId })` 重建宿主主代理（`setup` 重跑，工具/instanceId 闭包重注册）

### 9.6 事件推送验证

- [ ] `sandore/*` 事件通过 apiproxy SSE 实时推送到前端
- [ ] 状态快照通过 `session/projection` 帧推送
- [ ] 问答/权限通过 `question/requested`/`approval/requested` 帧推送
- [ ] 讨论面板：`sandore-step` Chat 节点（复用 `ui-workflow-run`）正确渲染

---

## 附录：关键设计决策汇总

| 编号 | 决策 | 来源 |
|------|------|------|
| D5 | **事件/SSE 全用 DSH，零自建**：删除 `WorkflowEventBus`/`WorkflowSseManager`/`SdkSseManager`，改用 Cordis 事件总线 + apiproxy 双 SSE 流 + session projection | dsh-workflow.md |
| D8 | **讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制**（`ConversationNodeDefinition` + `conversation.chat.node` keyed）：每个 Step 折叠为一个 `sandore-step` 节点，内联最后结果消息 | dsh-workflow.md |
| D9 | **主代理 = 工作流编排器，身份不切换**：广播恢复改为「自然语言 → 主代理显式调用 `sandore_*` 工具」；「默认挂载会话」= 宿主 Session 自然延续（无需 DefaultSessionManager）；暂停登记表由引擎自建 | dsh-workflow.md |
| — | Step 会话用 `ctx.subagents.startContinuable()`（可续接，支持 followup/interrupt/resume） | dsh-workflow.md D3 |
| — | `work.json` 用 `ctx.storageDomain` 的 `state` 表；`chat.json` 用 Session 事件日志；SQLite 两张表迁入 `definitions`/`jobs` 表 | dsh-workflow.md D4 |
| — | 交互管理改用 DSH permission presets（子代理继承宿主 Session preset，approval 固定 `never`） | dsh-workflow.md §5.3A |
