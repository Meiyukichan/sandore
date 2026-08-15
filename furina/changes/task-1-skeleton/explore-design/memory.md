# 记忆探索结果（memory）

## 一、需求理解（Phase 2）

- **What（要理解什么）**：`docs/design/task-1-skeleton/work.md` 要求实现 sandore DAG 工作流引擎（v2.6）作为 DeepSeek Harness (DSH) 插件的第一步「骨架」——仓库脚手架（4 个包）+ Service Definition（`ctx.sandoreEngine` 抽象接口 + `sandore/*` 事件词汇）+ 最小端到端链路（活动栏按钮 + WorkflowPanel 占位 + Host RPC 往返）。本探索梳理项目内与 Task 1 直接相关的「设计决策记忆」。
- **Boundaries（范围）**：仅 Task 1 骨架；不涉及真实引擎执行逻辑、完整 UI、YAML 解析、持久化实现（这些是 Task 2–5）。核心记忆来源是 `docs/design/task-1-skeleton/design.md`、`docs/design/overall-design.md`、`docs/engine/dsh-workflow.md` 三份设计文档。
- **Goal（目标）**：为 Task 1 的实现/设计提供事实依据——明确命名空间、硬约束、抽象类接口、13 事件、13 基础类型、4 包结构、UI 入口与验证标准，以及它们在 DSH 源码中的既有范式落点。
- **Project Context**：sandore 仓库目前只有设计文档（`docs/`），`packages/` 目录为空，`furina/changes/task-1-skeleton/` 下仅有空目录（`changes.json` 中该 change 的 `artifacts` 为空数组）。引擎源码不在本仓库，需按设计文档从零实现。DSH 仓库位于 `D:\project-code\llm\deepseek-harness`，为插件的宿主运行时与范式来源。

## 二、项目现状（当前状态事实）

| 位置 | 现状 |
|---|---|
| `packages/` | 空目录（无任何 sandore 包） |
| `docs/design/task-1-skeleton/` | 含 `design.md`（权威规格）与 `work.md`（任务说明） |
| `docs/design/overall-design.md` | 总体设计（D1–D9 决策、5 个 Task 边界、持久化三表） |
| `docs/engine/dsh-workflow.md` | 插件化核心设计（§1.3/§1.4 硬约束、§3 插件机制、§5.1/§5.1A、§5.4、§6.1、§10.2 决策） |
| `docs/engine/dynamic-workflow-engine.md` | 引擎 v2.6 技术设计（类型体系、DAG 执行） |
| `furina/changes/task-1-skeleton/` | 仅目录，无任何产出文件 |
| `AGENTS.md` | 关键事项：UI 能复用 DSH 就复用，不能复用就照风格自绘；引擎/后端尽量复用 DSH 组件；代码风格参考 DSH |

## 三、核心硬约束（不可违反）

1. **零外部 Agent SDK**：原 sandore 引擎的 `@codeagent/sdk` 依赖（`engine/internal/sdk/` 下 `client.ts`/`session.ts`/`sse-manager.ts`/`utils.ts`）整体删除，所有 AI 会话、Shell、文件读写、模型推理、事件流/SSE、会话持久化、权限、问答、fork/revert、子代理追踪能力全部改由 DSH 的 `ctx.*` 服务实现。
2. **纯插件分发，不改任何 DSH 源码**：插件要分发给其他 DSH web 用户。DSH 的 sidebar 子 slot（`sidebar.workspaces`/`sidebar.settings`/`sidebar.footer.action`）由 `ui-sidebar` 这个 shell 包「声明即独占」，插件无法新增常驻分组；工作流 UI 入口只能是 `sidebar.footer.action` 按钮 + 点击展开面板。
3. **UI 复用优先**：复用 `ui-primitives`/theme/locale/标准 hook；不能复用就照着 DSH 风格自绘（`AGENTS.md` 同义）。

## 四、命名空间决策（D1）

DSH 已占用 `ctx.workflowEngine`、`workflow/*` 事件、`tool-workflow` 工具名。为避免语义冲突，新引擎使用独立命名空间：

| 概念 | 命名 |
|---|---|
| Service key | `ctx.sandoreEngine`（`abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`） |
| 事件前缀 | `sandore/*`（Session 事件，`session.append('sandore/…', data)` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`） |
| 模型工具 | `sandore_*`（下划线，Task 1 不实现，仅约定） |
| RPC 方法 | `sandore.*`（点号，Task 1 最小 `sandore.ping`） |
| Host 包 | `@deepseek-ai/dsh-sandore-workflow` / `@deepseek-ai/dsh-sandore-microflow` / `@deepseek-ai/dsh-sandore-tool` |
| 前端包 | `@deepseek-ai/dsh-client-ui-sandore` |

## 五、Service Definition（`ctx.sandoreEngine`）

抽象类含 **11 个实例级方法**（对齐原 engine 的 execute/recover/abort + interactionManager + lifecycleManager + retryFromStep）：

- 实例生命周期：`startInstance(request: DagStartRequest): DagRun`、`recoverInstance(instanceId): Promise<DagRun>`、`abortInstance(instanceId): Promise<void>`
- 交互：`replyQuestion(instanceId, requestId, answers): Promise<void>`、`replyPermission(instanceId, requestId, reply: 'once'|'always'|'reject'): Promise<void>`
- 暂停/恢复/重试：`pauseStep(instanceId, stepId)`、`resumeStep(instanceId, stepId, resumePrompt?)`、`pauseAllSteps(instanceId)`、`resumeAllSteps(instanceId, resumePrompt?)`、`retryStep(instanceId, stepId, mode: 'continue'|'revert'|'fork', message)`
- 状态查询：`getState(instanceId): DagInstanceState`

> **决策 D2**：Service 层只暴露「实例级」操作；工作流定义/Job 的 CRUD 与「实例的持久化文件/讨论/产物」查询放在 `workflow`（Host RPC 层），避免接口臃肿。

### 事件声明两套（必需 + 可选）

- **Session 事件（必需）**：`sandore/*` 是 Session 事件，通过 `session.append('sandore/…', data)` 写入宿主 Session log，经 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }` 合并。只有 append 到 log 的事件才会被 `ConversationNodeDefinition`（D8 讨论面板）折叠、被 apiproxy `session/event` 帧透传。
- **Cordis `Events`（可选触发源，不能替代）**：`declare module '@deepseek-ai/cordis' { interface Events { … } }`，`info: DagRunInfo` 作首参；仅作引擎内部进程内通信的可选触发源。

### 13 个 `sandore/*` 事件清单（Task 1 全部声明）

`sandore/start`、`sandore/stage-start`、`sandore/stage-completed`、`sandore/step-start`、`sandore/step-completed`、`sandore/step-failed`、`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`、`sandore/question`、`sandore/permission`、`sandore/end`、`sandore/aborted`。

关键点：
- `step-start`/`step-completed`/`step-failed`/`step-paused`/`step-resumed` 增补 `childId`（子代理 SessionId）；`step-completed` 增补 `output`（`finalAssistantOutput` 子代理最终结果，内联展示用）。
- **D9 修正**：无 `default-session-mounted` 事件（宿主 Session 在 `completed` 后自然延续为自由对话，不额外挂载默认会话）。
- 无 `user-message` 事件（用户消息由 DSH 原生 turn/message 承载）。

## 六、13 个基础类型（design.md §5.3）

`DagRunInfo`、`DagStartRequest`、`DagRun`、`DagRunStatus`、`DagInstanceState`、`ExecutedStepDefault`、`StageInfo`、`StepStatus`、`StageContract`、`PendingQuestion`、`AskUserQuestionPayload`、`PendingPermission`、`DagResultInfo`。要点：

- `DagStartRequest` 无 `permissionMode` 字段（权限修正后废弃：权限由宿主 Session 的 permission preset 决定，Step 子代理继承父级）。
- `DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'`。
- `StepStatus` / `StageInfo.status = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`。

## 七、4 个包结构（Task 1 产出）

| 包 | Task 1 内容 |
|---|---|
| `packages/sandore/workflow/` | seam + Provider 桩 + RPC（三者合一）：`src/index.ts`（抽象类 + Events 声明）、`types.ts`、`runtime-types.ts`、`remote.ts`（`@Remote`/`harness.handle` 的最小 `sandore.ping`） |
| `packages/sandore/microflow/` | 空目录占位（package.json + tsconfig）；后续 Task 填充 `StageExecutor`/`StepRunner` |
| `packages/sandore/tool/` | 空目录占位（package.json + tsconfig）；后续 Task 填充 `sandore_*` 模型工具 |
| `packages/sandore/ui/` | Client 插件：`src/index.ts` 注册 `sidebar.footer.action`（工作流按钮，设置上方）+ 点击展开 WorkflowPanel 占位；`host.call('sandore.ping')` 往返 |

Provider 桩要求：`export default class ... extends SandoreEngine`，`static Config` 用 schemastery，`inject` 声明 `sessions/sessionPersistence/subagents/llm/shell/fs/storageDomain`（可选软依赖 `ctx.subprocess`、`ctx.sandbox`）。运行时依赖方向：`workflow → microflow`，`microflow → workflow` 仅 `import type`。

## 八、UI 入口（D6）

- 工作流入口 = `sidebar.footer.action` 按钮（slot 位于工作区下方、设置上方，是纯插件能插入的唯一合适位置）+ 点击展开 WorkflowPanel（仿 workspace 风格，ui-primitives 自绘，含「编排」toggle +「新增」按钮 + 三态列表占位）。
- **不用** `conversation.view` tab 作为主入口（D6 已收敛放弃）。
- 面板开关是插件自有 client 状态，无跨 scope 联动。

## 九、权限与持久化（背景，Task 1 不实现，仅约定）

- **无 `permissionMode`**：权限由宿主 Session 的 permission preset（`sandbox/mode` + `approval/policy`）决定，Step 子代理继承父级、approval 固定 `never`。`static Config` 与 `DagStartRequest` 里不要加 permissionMode 字段。
- **持久化 `sandore` 域三表**：`definitions`（key=workflowId）/`jobs`（key=jobId）/`state`（key=instanceId）——SQLite 两张表 + YAML 定义文件 + jobs.json 迁入 storageDomain（D4）。Task 1 不实现，仅作类型/约定背景。

## 十、关键设计决策汇总（D1–D9）

| 编号 | 决策 |
|---|---|
| D1 | 新引擎用 `ctx.sandoreEngine` + `sandore/*` 事件，不扩展 `ctx.workflowEngine` |
| D2 | Service 层只暴露实例级操作；定义/Job CRUD + 讨论/产物查询放 Host RPC 层 |
| D3 | Step 会话用 `ctx.subagents.startContinuable()`；分支/finalize 临时推理用 `ctx.llm.stream()` |
| D4 | `work.json` 用 `ctx.storageDomain` 的 `state` 表；`chat.json` 用 Session 事件日志；SQLite/YAML/jobs.json 迁入 `definitions`/`jobs` 表 |
| D5 | 事件/SSE 全用 DSH，零自建（删 WorkflowEventBus/WorkflowSseManager/SdkSseManager） |
| D6 | 工作流管理 UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方，仿 workspace 风格） |
| D7 | 前端复用 DSH 组件与设计语言（ui-primitives/theme/locale/消息渲染/交互卡片） |
| D8 | 讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制（`ConversationNodeDefinition` + `conversation.chat.node` keyed） |
| D9 | 主代理 = 工作流编排器，身份不切换；「默认挂载会话」= 宿主 Session 自然延续；`sandore_*` 工具 per-instance 挂宿主 Session |

## 十一、DSH 源码范式落点（已核实的参考实现）

以下范式来自 DSH 源码 `D:\project-code\llm\deepseek-harness`，是 design.md 中代码块的事实依据：

1. **Service Definition 范式**：`packages/workflow/workflow/src/index.ts`。`import { Context, Service } from '@deepseek-ai/cordis'`；`declare module '@deepseek-ai/cordis' { interface Context { workflowEngine: WorkflowEngine } interface Events { 'workflow/start'(info: WorkflowRunInfo): void … } }`；`export abstract class WorkflowEngine extends Service { constructor(ctx) { super(ctx, 'workflowEngine') } … protected emitWorkflowEvent(name, ...args) }`；末尾 `export default WorkflowEngine`。`emitWorkflowEvent` 内含 listener 异常捕获（try/catch + `Promise.resolve().catch()`），design.md §6.7 建议 SandoreEngine 继承此安全发射模式。

2. **Session 事件 append + SessionEventMap 范式**：`packages/workflow/tool-workflow/src/types.ts` 与 `src/index.ts`。`types.ts` 中 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'tool-workflow/run-start': ToolWorkflowRunStartData … } }`；`index.ts` 中 `session.append(type, data)`，data 类型取自 `SessionEventMap[Type]`。

3. **footer 按钮 + 展开面板范式**：`packages/extensions/ui-cordis/src/client/index.ts`。`export const inject = ['slots', 'locale', …]`；`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'cordis-panel', locale: NS, inject: () => ({ hooks, … }), }, CordisPanel))`。

4. **`conversation.chat.node` keyed 范式**：`packages/client/ui-workflow-run/src/client/workflow-definition.ts`。`declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData } }`；`ConversationNodeDefinition<State>` 含 `kind`/`target: 'chat'`/`match`/`start`/`update`/`buildViewNode`。

5. **`@Remote` RPC 范式**：`packages/feedback/message-feedback/src/index.ts`、`packages/goal/goal/src/index.ts`、`packages/host/plugin-inventory/src/index.ts`。`import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'`，方法上 `@Remote('list')`/`@Remote('put')` 等装饰器（对应 `host.call('sandore.ping')` 的 RPC 面）。

6. **`ctx.storageDomain.open(spec)` 范式**：`packages/workspace/workspace/src/index.ts`。`static inject = ['storageDomain', 'sessionPersistence']`；`[Service.init]()` 内 `const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)`、`this.ctx.effect(() => () => domain.close(), …)`、`this.table = domain.table('workspaces')`、`this.global = domain.global`。

7. **Client 插件 package.json 范式**：`packages/extensions/ui-cordis/package.json`。`"type": "module"`、`exports["./client"]`、`"dsh": { "client": { "inject": [client 依赖清单], "platform": "web" } }`、`peerDependencies` 含 `@deepseek-ai/cordis` 与 `react`。

## 十二、Task 1 验证标准

- `pnpm run typecheck` 通过；4 个包目录/package.json 正确。
- `ctx.sandoreEngine` 抽象类（11 方法）+ `sandore/*` 13 事件（Cordis `Events` + Session `SessionEventMap`）声明正确。
- 挂载后 sidebar 设置上方出现「工作流」按钮；点击展开 WorkflowPanel。
- `host.call('sandore.ping')` 往返 JSON 正常。
- 无对 DSH 源码的任何修改。
