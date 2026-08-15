# Task 1 骨架探索结果（Specification）

> 探索类型：specification（规格材料探索）
> 探索内容：严格准确地按照 `docs/design/task-1-skeleton/work.md` 的内容和要求执行，完成 task1 的任务
> 当前项目路径：`D:\project-code\llm\sandore`
> 语言：中文

---

## 一、需求理解（Phase 2）

### What（要理解什么）

本任务要求理解「sandore DAG 工作流引擎（v2.6）作为 DeepSeek Harness (DSH) 插件」第一步 —— **Task 1 骨架** 的完整规格：仓库脚手架（4 个包）+ Service Definition（`ctx.sandoreEngine` 抽象接口 + `sandore/*` 事件词汇）+ 最小端到端链路（`sidebar.footer.action` 工作流按钮 + 展开 WorkflowPanel + `sandore.ping` Host RPC 往返）。**仅做骨架，不做真实引擎执行逻辑。**

### Boundaries（探索边界）

范围收敛在 Task 1 骨架本身及为它服务的规格材料，具体包括：

1. `docs/design/task-1-skeleton/work.md` —— Task 1 的任务清单、硬约束、命名空间、4 包产出、13 事件清单、UI 入口、验证标准（本文档的探索入口）。
2. `docs/design/task-1-skeleton/design.md` —— Task 1 权威规格（Service 接口、13 事件、13 类型、Slot 注册代码、验证标准）。
3. `docs/design/overall-design.md` —— 总体设计（包结构、命名约定、D1–D9 决策、持久化三表）。
4. `docs/engine/dsh-workflow.md` —— 插件化核心设计（§1.3/§1.4 硬约束、§3 插件机制、§5.1/§5.1A、§5.4、§6.1、§6.4、§8.3、§10.2 决策汇总）。
5. DSH 源码（`D:\project-code\llm\deepseek-harness`）参考实现：
   - `packages/workflow/workflow/src/index.ts` —— Service Definition 范式
   - `packages/workflow/tool-workflow/src/index.ts` —— Session 事件 append 范式
   - `packages/extensions/ui-cordis` —— footer 按钮 + 展开面板
   - `packages/client/ui-workflow-run` —— `conversation.chat.node` keyed（D8 讨论面板）
   - `packages/workspace/workspace/src/spec.ts` + `index.ts` —— `ctx.storageDomain.open(spec)` 范式

**明确不在范围内**：Task 2–5 的实现细节（真实引擎执行、YAML 解析、CRUD、DAG、生命周期、完整前端）、V3/MASE、以及任何实现代码的编写。

### Goal（探索要达成的目标）

准确、完整地提取 Task 1 骨架所需的全部规格信息（接口签名、事件清单、类型清单、包结构、Slot 注册范式、RPC 范式、DSH 参考实现的精确写法），为后续按 work.md 执行 Task 1 实现提供权威依据；同时记录规格材料之间的关键差异点（如 `step-completed.output` 类型的不一致）供实现时判断。

---

## 二、探索材料配置说明

`furina config show exploration.specification` 返回空数组 `[]`（无显式配置的规格材料）。因此本次探索的材料来源改为 `exploreContent` 指向的 `work.md` 中「必读」清单所列的规格文档与 DSH 源码参考文件（即上文「探索边界」所列 5 类材料）。

---

## 三、探索结果（Phase 3）

### 3.1 当前仓库现状（关键前提）

- `D:\project-code\llm\sandore` 仓库中 `packages/` 目录**存在但为空**（2025-08-14 建），无根 `package.json`，无任何 sandore 引擎源码。
- `docs/design/task-1-skeleton/` 下只有 `design.md`（29.7KB）与 `work.md`（6.2KB）。
- `furina/changes/task-1-skeleton/` 目录已存在（本探索输出目录）。
- 结论：Task 1 是**从零搭建骨架**，无既有代码可改造；引擎源码需按设计文档重写（`dsh-workflow.md §2.1` 已确认 sandore 仓库仅有设计文档）。

### 3.2 Task 1 目标与范围（work.md + design.md §1）

**任务目标**（三件事，`work.md` / `design.md §1.1`）：
1. **仓库脚手架**：创建 `packages/sandore/` 目录结构及各包 `package.json`。
2. **Service Definition**：定义 `ctx.sandoreEngine` 抽象接口 + `sandore/*` 事件声明。
3. **最小端到端链路**：`sidebar.footer.action` 工作流按钮（设置上方）+ 点击展开的 WorkflowPanel 占位 + Host RPC 往返（`host.call('sandore.ping')`）。

**范围边界**（`design.md §1.2`）：在范围内 = 脚手架 / Service Definition / Slot 注册 / 最小 RPC / 验证 Slot 注入与 RPC 链路；不在范围内 = 真实引擎执行逻辑 / 具体 Provider 实现 / 完整 UI 组件 / 实际 RPC 业务逻辑 / 完整前端功能。

### 3.3 硬约束（不可违反，`work.md` + `dsh-workflow.md §1.3/§1.4`）

1. **零外部 Agent SDK，全用 DSH 组件**（§1.3，最高优先级）：删除原 sandore 引擎的 `@codeagent/sdk` 依赖（`engine/internal/sdk/` 四个文件 client/session/sse-manager/utils 整体删除），所有 AI 会话、Shell、文件读写、模型推理、事件流/SSE、会话持久化、权限等全部改由 DSH 自身组件（Cordis 服务）实现。理由：单一运行时、权限/沙箱/审计统一、会话模型一致、可维护性（DSH 的 `workflow` 子系统已示范正确模式）。
2. **纯插件分发，不改 DSH 源码**（§1.4，并列最高优先级）：分发给其他 DSH web 用户，必须自包含、零 DSH 源码修改。
   - 不改 `ui-sidebar`/`ui-layout`/`ui-conversation`/`ui-workspace` 等 shell 包 → **无法在 sidebar 新增常驻分组**（sidebar 子 slot「声明即独占」），工作流 UI 入口只能是 `sidebar.footer.action` 按钮 + 点击展开面板。
   - 只复用 DSH 公开扩展点：`ctx.*` 服务、Slot、事件、`ui-primitives`/theme/locale/标准 hook；DSH 内部私有组件不可 import，照着风格用 `ui-primitives` 自绘。
3. UI 能复用 DSH 就复用（`ui-primitives`/theme/locale/标准 hook），不能复用就照着 DSH 风格自绘。

### 3.4 命名空间（D1，`work.md` + `design.md §2`）

| 概念 | 命名 |
|---|---|
| Service key | `ctx.sandoreEngine`（`abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`） |
| 事件前缀 | `sandore/*`（**Session 事件**：`session.append('sandore/…', data)` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`；不是纯 `ctx.emit`） |
| 模型工具 | `sandore_*`（下划线，Task 1 不实现，仅约定） |
| RPC 方法 | `sandore.*`（点号，Task 1 最小 `sandore.ping`） |
| Host 包 | `@deepseek-ai/dsh-sandore-workflow` / `@deepseek-ai/dsh-sandore-microflow` / `@deepseek-ai/dsh-sandore-tool` |
| 前端包 | `@deepseek-ai/dsh-client-ui-sandore` |

理由：DSH 已占用 `ctx.workflowEngine`、`workflow/*` 事件、`tool-workflow` 工具名；新引擎不扩展 `ctx.workflowEngine`（其接口为「脚本编排」设计），另开 `ctx.sandoreEngine` 避免语义冲突。

### 3.5 产出：4 个包（`work.md` + `design.md §4.2`）

```
packages/sandore/
├── workflow/     # seam + Provider 桩 + RPC（三者合一）
│   ├── package.json          # 无 dsh.client
│   └── src/
│       ├── index.ts          # abstract class SandoreEngine + Events（两套）+ Provider 桩
│       ├── types.ts          # 类型（13 个，design.md §5.3）
│       ├── runtime-types.ts  # DagRun / DagStartRequest / DagResult
│       └── remote.ts         # @Remote / harness.handle 最小 ping RPC
├── microflow/    # 空目录占位（package.json + tsconfig），后续填 StageExecutor/StepRunner
│   └── （运行时 workflow → microflow；microflow → workflow 仅 import type）
├── tool/         # 空目录占位（package.json + tsconfig），后续填 sandore_* 模型工具
└── ui/           # Client 插件（dsh.client + exports["./client"]）
    ├── package.json
    └── src/
        ├── index.ts          # 注册 sidebar.footer.action 按钮
        └── client/
            ├── WorkflowButton.tsx   # 设置上方「工作流」按钮
            └── WorkflowPanel.tsx    # 展开面板（占位：header 编排/新增 + 三态列表）
```

依赖关系（`dsh-workflow.md §4.2`）：运行时单向 `workflow → microflow`；`microflow → workflow` 仅 `import type`（编译期擦除，打破循环）；`tool`/`ui` 依赖 `workflow`。

### 3.6 Service Definition（`ctx.sandoreEngine`，`design.md §5`）

#### 抽象类（11 个实例级方法）

`export abstract class SandoreEngine extends Service { constructor(ctx: Context) { super(ctx, 'sandoreEngine') } }`，11 个抽象方法：

| 分组 | 方法签名 |
|---|---|
| 实例生命周期 | `startInstance(request: DagStartRequest): DagRun`；`recoverInstance(instanceId: string): Promise<DagRun>`；`abortInstance(instanceId: string): Promise<void>` |
| 交互 | `replyQuestion(instanceId, requestId, answers: unknown): Promise<void>`；`replyPermission(instanceId, requestId, reply: 'once'\|'always'\|'reject'): Promise<void>` |
| 暂停/恢复/重试 | `pauseStep(instanceId, stepId): Promise<void>`；`resumeStep(instanceId, stepId, resumePrompt?): Promise<void>`；`pauseAllSteps(instanceId): Promise<void>`；`resumeAllSteps(instanceId, resumePrompt?): Promise<void>`；`retryStep(instanceId, stepId, mode: 'continue'\|'revert'\|'fork', message: string): Promise<void>` |
| 状态查询 | `getState(instanceId): DagInstanceState` |

**决策 D2**：Service 层只暴露「实例级」操作；工作流定义/Job 的 CRUD 与「实例的持久化文件/讨论/产物」查询放在 `workflow`（Host RPC 层），避免 Service 接口臃肿。

#### 事件声明（13 个 `sandore/*`，两套）

`work.md` 明确：`sandore/*` 是 **Session 事件**（必需，驱动 D8 讨论面板折叠 + apiproxy 透传），Cordis `Events` 声明是引擎内部**可选**触发源，不能替代 Session 事件。

13 个事件：`sandore/start`、`sandore/stage-start`、`sandore/stage-completed`、`sandore/step-start`、`sandore/step-completed`、`sandore/step-failed`、`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`、`sandore/question`、`sandore/permission`、`sandore/end`、`sandore/aborted`。

关键点（`work.md`）：
- `step-start`/`step-completed`/`step-failed`/`step-paused`/`step-resumed` 增补 `childId`（子代理 SessionId）；`step-completed` 增补 `output`（`finalAssistantOutput` 子代理最终结果，内联展示用）。
- **D9 修正**：**无 `default-session-mounted` 事件**（宿主 Session 在 `completed` 后自然延续为自由对话）。
- **无 `user-message` 事件**（用户消息由 DSH 原生 turn/message 承载）。

Cordis `Events`（`design.md §5.1`）—— 每个事件首参为 `info: DagRunInfo`，随后为可选参数：

```
'sandore/start'(info): void
'sandore/stage-start'(info, stageId: string): void
'sandore/stage-completed'(info, stageId: string, contract: StageContract): void
'sandore/step-start'(info, stepId: string, childId: string): void
'sandore/step-completed'(info, stepId: string, childId: string, output: unknown): void
'sandore/step-failed'(info, stepId: string, childId: string, error: string): void
'sandore/step-paused'(info, stepId: string, childId: string): void
'sandore/step-resumed'(info, stepId: string, childId: string, resumePrompt?: string): void
'sandore/step-retried'(info, stepId: string, mode: string): void
'sandore/question'(info, question: PendingQuestion): void
'sandore/permission'(info, permission: PendingPermission): void
'sandore/end'(info, result: DagResultInfo): void
'sandore/aborted'(info): void
```

Session `SessionEventMap`（`design.md §5.1`，纯数据载荷）：

```
'sandore/start': { taskId; workflowId; jobId }
'sandore/stage-start': { taskId; stageId }
'sandore/stage-completed': { taskId; stageId; stageContract: StageContract }
'sandore/step-start': { stepId; childId }
'sandore/step-completed': { stepId; childId; output: unknown }
'sandore/step-failed': { stepId; childId; error: string }
'sandore/step-paused': { stepId; childId }
'sandore/step-resumed': { stepId; childId; resumePrompt?: string }
'sandore/step-retried': { stepId; mode: string }
'sandore/question': { question: PendingQuestion }
'sandore/permission': { permission: PendingPermission }
'sandore/end': { taskId; jobId; result: DagResultInfo }
'sandore/aborted': { taskId }
```

> ⚠️ **规格差异（需实现时注意）**：`sandore/step-completed` 的 `output` 类型在三份文档中不一致 —— `design.md §5.1`（Task 1 权威规格）用 `output: unknown`；`dsh-workflow.md §5.1` 与 `overall-design.md §4.2` 用 `output: ContentBlock[]`。work.md 只描述语义（「finalAssistantOutput 子代理最终结果」）。以 `design.md`（Task 1 权威规格）为准是 `unknown`，但父文档倾向 `ContentBlock[]`。

#### 类型（13 个，`design.md §5.3`）

`DagRunInfo`、`DagStartRequest`、`DagRun`、`DagRunStatus`、`DagInstanceState`、`ExecutedStepDefault`、`StageInfo`、`StepStatus`、`StageContract`、`PendingQuestion`、`AskUserQuestionPayload`、`PendingPermission`、`DagResultInfo`。关键定义：

- `DagRunInfo { taskId; workflowId; jobId }`
- `DagStartRequest { workflowId; jobId; originalInput; cwd? }`（**无 `permissionMode` 字段**）
- `DagRun { instanceId; status: DagRunStatus }`
- `DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'`（7 态）
- `StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`
- `DagInstanceState { taskId; jobId; workflowId; status; originalInput; currentStageId; executedSteps; stageInfos; pendingQueue; createdAt; updatedAt }`
- `StageInfo { id; name; status: StepStatus }`
- `StageContract { stageId; stageName; status; artifacts[]; passThroughVars; contractArtifacts; completedAt; errorDetail? }`
- `PendingQuestion { stepId; sessionId; requestId; questions: AskUserQuestionPayload }`
- `AskUserQuestionPayload { questions: Array<{ id; question; header?; options?; multi_select? }> }`
- `PendingPermission { stepId; sessionId; requestId; permission; patterns?; metadata?; tool? }`
- `DagResultInfo { taskId; jobId; status: 'completed'|'failed'|'aborted'; error? }`

#### Provider 桩（`design.md §7.3` + `dsh-workflow.md §8.3`）

- 空 Provider 桩：`export default class ... extends SandoreEngine`。
- `static Config` 用 **schemastery**（`z.object({ defaultTimeoutMs: z.natural().default(7200000), maxConcurrentSteps: z.natural().default(0) })`；无 `permissionMode` 配置）。
- `static inject` 声明：`'sessions'`、`'sessionPersistence'`、`'subagents'`、`'llm'`、`'shell'`、`'fs'`、`'storageDomain'`（可选软依赖 `ctx.subprocess`/`ctx.sandbox`，用 `ctx.get()`）。

### 3.7 最小 RPC（`sandore.ping`）

- `remote.ts` 中定义 `@Remote`/`harness.handle` 的 `sandore.ping` 最小 RPC。
- 验证标准：`host.call('sandore.ping')` 往返 JSON 正常，返回桩数据（非真实引擎状态）。
- 原型阶段用 `harness.handle(method, handler)` + `host.call(method, args)`；生产阶段用 Typert Remote 服务（`dsh-workflow.md §5.6`）。

### 3.8 UI 入口（D6，`work.md` + `design.md §6` + `dsh-workflow.md §6.1`）

- 工作流入口 = `sidebar.footer.action` 按钮（该 slot 在工作区下方、**设置上方**，是纯插件能插入的唯一合适位置）+ 点击展开 WorkflowPanel（仿 workspace 风格，ui-primitives 自绘，含「编排」toggle +「新增」按钮 + 三态列表占位）。
- **不要**用 `conversation.view` tab 作为主入口（D6 已收敛放弃）。
- Slot 注册代码（`design.md §6.1`）：

```typescript
export const inject = ['slots', 'locale', 'sessions']
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sandore-btn',
    inject: () => ({ /* 面板开关状态（自包含） */ }),
  }, WorkflowButton))  // 点击展开 WorkflowPanel
}
```

- `sidebar.footer.action` 由 `ui-sidebar` 声明为 `{ kind: 'list'; scope: 'root' }`，owner props 仅 `{ wide: boolean }`（`wide=false` 是 56px 窄栏 rail 模式，按钮需适配两种模式；`inject` 回调无参数，点击行为靠插件自有 client 状态桥接，参考 `ui-cordis` 的 footer 按钮 + 展开 CordisPanel）。

### 3.9 权限与持久化（背景，Task 1 不实现，仅约定，`work.md`）

- **无 `permissionMode`**：权限由宿主 Session 的 permission preset（`sandbox/mode` + `approval/policy`）决定，Step 子代理继承父级、approval 固定 `never`。`static Config` 与 `DagStartRequest` 里**不要**加 permissionMode 字段。
- **持久化 `sandore` 域三表**：`definitions`（key=workflowId）/`jobs`（key=jobId）/`state`（key=instanceId）—— SQLite 两张表 + YAML 定义文件 + jobs.json 迁入 storageDomain（D4）。Task 1 不实现，仅作类型/约定背景。

### 3.10 验证标准（Task 1 完成门槛，`work.md` + `design.md §8`）

- `pnpm run typecheck` 通过；4 个包目录/package.json 正确。
- `ctx.sandoreEngine` 抽象类（11 方法）+ `sandore/*` 13 事件（Cordis `Events` + Session `SessionEventMap`）声明正确。
- 挂载后 sidebar 设置上方出现「工作流」按钮；点击展开 WorkflowPanel。
- `host.call('sandore.ping')` 往返 JSON 正常。
- 无对 DSH 源码的任何修改。

---

## 四、DSH 参考实现范式（源码实证）

### 4.1 Service Definition 范式（`packages/workflow/workflow/src/index.ts`）

`@deepseek-ai/dsh-workflow` 的 `WorkflowEngine` 是 SandoreEngine 的直接模板：

```typescript
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context { workflowEngine: WorkflowEngine }
  interface Events { 'workflow/start'(info: WorkflowRunInfo): void /* ... */ }
}

export abstract class WorkflowEngine extends Service {
  constructor(ctx: Context) { super(ctx, 'workflowEngine') }
  abstract start(request: WorkflowStartRequest): WorkflowRun
  protected emitWorkflowEvent(name, ...args): void { /* listener 异常捕获 */ }
}
export default WorkflowEngine
```

要点：
- `super(ctx, '<serviceKey>')` 注册名模式。
- `declare module '@deepseek-ai/cordis'` 同时扩展 `Context` 与 `Events`。
- 提供 `emitWorkflowEvent`（listener 异常 try/catch + `Promise.resolve().catch()` 包含）—— `overall-design.md §6.7` 建议 `SandoreEngine` 继承此「事件安全发射」模式。
- 错误体系：`WorkflowError extends HarnessError`，带 `fatal: boolean` 标志 —— `overall-design.md §4.4` 定义了对齐的 `SandoreError`/`SandoreErrorCode`（Task 1 不实现）。

### 4.2 Session 事件 append 范式（`packages/workflow/tool-workflow/src/index.ts`）

`sandore/*` 作为 Session 事件的写入范式（`dsh-workflow.md §5.5` 明确 `tool-workflow` 正是这个范式）：

```typescript
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
// 触发源用 Cordis 事件，落盘用 session.append
ctx.on('workflow/agent-start', (info, agent) => {
  session.append('tool-workflow/agent-start', data)  // data: SessionEventMap[...]
})
```

要点：先 `ctx.on('workflow/*')` 作触发源，再 `session.append('tool-workflow/*', data)` 写 log；`SessionEventMap` 类型来自 `@deepseek-ai/dsh-session`，扩展事件需 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { ... } }` 合并。

### 4.3 footer 按钮 + 展开面板范式（`packages/extensions/ui-cordis/src/client/index.ts`）

```typescript
export const inject = ['slots', 'locale', /* ... */]
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cordis: dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'cordis-panel',
    locale: NS,
    inject: (): CordisPanelFace => ({ hooks: { ... }, onApprove: ..., ... }),
  }, CordisPanel))
}
```

要点：`inject` 数组声明硬依赖；`ctx.effect(() => ctx.locale.register(...))` 注册词典；`ctx.slots.inject(slotName, factory)` + `ctx.slots.register({ name, id, locale, inject }, Component)`；`sidebar.footer.action` 是 list slot，用 `id` 标识按钮。

### 4.4 `conversation.chat.node` keyed 范式（`packages/client/ui-workflow-run`）

`ui-workflow-run` 是 D8 讨论面板「sandore-step 节点」的直接模板，三件套：

```typescript
// src/client/index.ts
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(workflowRunDefinition)   // ① ConversationNodeDefinition
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflow-run: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({   // ② keyed 渲染器
    name: 'conversation.chat.node',
    key: 'workflow-run',
    locale: NS,
    inject: (): WorkflowRunInjected => ({ openSession: (id: SessionId) => { ctx.sessions.open(id) } }),
  }, WorkflowRunPanel))
}

// src/client/workflow-definition.ts —— ③ ConversationNodeDefinition
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData }
}
export const workflowRunDefinition: ConversationNodeDefinition<WorkflowState> = {
  kind: 'workflow-run',
  target: 'chat',
  match: (event) => { /* event.type 匹配 tool-workflow/run-start 等，返回 { id, role } */ },
  start: (_ctx, match) => { /* 初始折叠 state */ },
  update: (ctx, match) => { /* 累积更新 state */ },
  buildViewNode: (ctx) => { /* 返回 ChatConversationViewNode { key, kind, id, target, anchorSeq, location, visibility, data } */ },
}
```

要点：`ConversationNodeDefinition` 的 `match` 折叠的是 **append 到 log 的 Session 事件**（带 `seq`/`time`），不是 `ctx.emit`；`conversation.chat.node` 是 keyed slot，用 `key`（sandore 用 `'sandore-step'`）而非 `id`；`buildViewNode` 返回 `anchorSeq: context.start.event.seq`。

### 4.5 `ctx.storageDomain.open(spec)` 范式（`packages/workspace/workspace/src/spec.ts` + `index.ts`）

```typescript
// spec.ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: { schema: workspaceDomainState, initial: { ... } },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})

// index.ts
const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
this.table = domain.table('workspaces')
```

要点：`defineDomain({ name, version, tables, global? })` 声明域（Task 1 虽不实现持久化，但 `sandore` 域三表 `definitions`/`jobs`/`state` 的 spec 即照此声明）；`open(spec)` 打开后调用方持有句柄并 `Domain.close()`（通常作为 `ctx.effect` disposer）；`domain.table(name)` 取表，表有 `entries()`/`keys()`/`size` 支持全量列举（`overall-design.md §4.3.1` 已确认）。

---

## 五、关键设计决策汇总（D1–D9，供 Task 1 参照）

| 编号 | 决策 |
|---|---|
| D1 | 新引擎用 `ctx.sandoreEngine` + `sandore/*` 事件，不扩展 `ctx.workflowEngine` |
| D2 | Service 层只暴露实例级操作；定义/Job CRUD + 讨论/产物查询放 Host RPC 层 |
| D3 | Step 会话用 `ctx.subagents.startContinuable()`；临时推理用 `ctx.llm.stream()`（Task 3/4） |
| D4 | `work.json` 用 `ctx.storageDomain` 的 `state` 表；`chat.json` 用 Session 事件日志；SQLite 两张表 + YAML 定义 + jobs.json 迁入 `definitions`/`jobs` 表 |
| D5 | 事件/SSE 全用 DSH，零自建（删除 WorkflowEventBus/WorkflowSseManager/SdkSseManager） |
| D6 | 工作流管理 UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方）；放弃常驻 sidebar 分组与 conversation.view tab 主入口 |
| D7 | 前端复用 DSH 组件与设计语言（ui-primitives/theme/locale/消息渲染/交互卡片） |
| D8 | 讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制（`ConversationNodeDefinition` + `conversation.chat.node` keyed `sandore-step`） |
| D9 | 主代理 = 工作流编排器，身份不切换；无 `default-session-mounted` 事件；`sandore_*` 工具 per-instance 挂宿主 Session |

---

## 六、待确认点 / 差异记录

1. **`sandore/step-completed` 的 `output` 类型不一致**：`design.md §5.1`（Task 1 权威）为 `output: unknown`；`overall-design.md §4.2` 与 `dsh-workflow.md §5.1` 为 `output: ContentBlock[]`。实现时应以 Task 1 权威规格 `design.md` 为准（`unknown`），或按父文档统一为 `ContentBlock[]`。
2. **Specification materials 配置为空**：`furina config show exploration.specification` 返回 `[]`，材料来源实际由 `work.md`「必读」清单承载。
3. **无根 `package.json`**：sandore 仓库当前无根 `package.json`，Task 1 的 `pnpm run typecheck` 验证标准需要先具备 monorepo 工作区配置（或在包内/workspace 层面补齐），这是 work.md 未显式说明的前置条件。
