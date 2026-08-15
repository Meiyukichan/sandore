# Task 1 骨架 — 仓库材料探索报告

> 探索类型：repository
> 目标仓库：`D:\project-code\llm\sandore`（沙箱 sandore 设计仓库）+ `D:\project-code\llm\deepseek-harness`（DSH 参考源码）
> 任务来源：`docs/design/task-1-skeleton/work.md`

---

## 一、需求理解（Phase 2）

### 1. What（要理解什么）

Task 1 是把 sandore 的 DAG 工作流引擎 v2.6 开发为 **DeepSeek Harness (DSH) 插件的第一步：骨架**。产出为：

1. **仓库脚手架**：`packages/sandore/` 下 4 个包（`workflow` / `microflow` / `tool` / `ui`）的目录结构与 `package.json`。
2. **Service Definition**：`ctx.sandoreEngine` 抽象类（11 个实例级方法）+ `sandore/*` 13 个事件声明（Cordis `Events` + Session `SessionEventMap` 两套）+ 13 个基础类型。
3. **最小端到端链路**：`sidebar.footer.action` 按钮（设置上方）→ 展开 WorkflowPanel 占位 → `host.call('sandore.ping')` Host RPC 往返。

仅做骨架，**不做真实引擎执行逻辑**。

### 2. Boundaries（探索范围）

- 范围：sandore 仓库的既有设计文档（design.md / overall-design.md / dsh-workflow.md 的关键章节）+ DSH 参考源码中与「Service Definition、Session 事件、RPC、Client Slot、storageDomain」相关的范式文件。
- 不在范围：真实引擎（Stage/Step/DAG 执行）、持久化实现、完整 UI、`sandore_*` 模型工具实现、崩溃恢复/交互/暂停恢复实现（这些是 Task 2–4）。

### 3. Goal（探索目的）

准确掌握 Task 1 所需落点与范式，回答以下问题：

- sandore 仓库当前状态（设计文档在哪、`packages/` 是否为空、furina changes 现状）。
- DSH 的 Service Definition 范式（抽象类 + `declare module` + 事件词汇）。
- `sandore/*` 事件为什么必须是 **Session 事件**（`session.append` + `SessionEventMap` 合并），Cordis `Events` 声明与之的关系。
- DSH 的 RPC 范式（`TypertRemoteService` + `@Remote` → `sandore.ping`；动态插件的 `harness.handle`）。
- Client 插件的 Slot 注册范式（`sidebar.footer.action`、`conversation.chat.node` keyed、package.json 的 `dsh.client` / `exports["./client"]`）。
- storageDomain 范式（Task 1 仅约定背景，不实现）。

---

## 二、探索结果（Phase 3）

### 2.1 仓库材料配置

`furina config show exploration.repository` 返回单元素：

```json
[{ "path": "./furina/", "type": "directory", "description": "The location of Furina Artifacts ... archived changes and ongoing changes ..." }]
```

探索 `./furina/` 结果：

- `furina/changes.json` 中当前只有一个 change：`task-1-skeleton`（描述与 work.md 一致），`features: 0`，`todo: 0`，`artifacts: []`，`archive: []`。
- `furina/changes/task-1-skeleton/` 目录当前**为空**（本次探索产出目录 `explore-design/` 为新建）。
- `furina/archive/` 不存在（无历史归档可参考）。

### 2.2 sandore 仓库现状

- `D:\project-code\llm\sandore\packages\` **为空目录** —— 引擎源码不在本仓库，需按设计文档从零新建 `packages/sandore/`。
- 设计文档：
  - `docs/design/task-1-skeleton/design.md`（Task 1 权威规格，29.7KB）
  - `docs/design/task-1-skeleton/work.md`（本任务，6.2KB）
  - `docs/design/overall-design.md`（总体设计，43KB）
  - `docs/design/task-{2,3,4,5}-*/`（后续 Task 设计，仅作边界参考）
  - `docs/engine/dsh-workflow.md`（插件化设计，85.9KB）
  - `docs/engine/dynamic-workflow-engine.md`（引擎 v2.6 技术设计，321KB，Task 1 只取 §3 基础类型）
  - `docs/engine/MASE.md`（V3 演进，不在 Task 1 范围）

### 2.3 Task 1 权威规格要点（design.md）

#### 2.3.1 命名空间（决策 D1）

| 概念 | 命名 |
|---|---|
| Service key | `ctx.sandoreEngine`（`abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`） |
| 事件前缀 | `sandore/*` |
| 模型工具 | `sandore_*`（Task 1 仅约定，不实现） |
| RPC 方法 | `sandore.*`（Task 1 最小 `sandore.ping`） |
| Host 包 | `@deepseek-ai/dsh-sandore-workflow` / `@deepseek-ai/dsh-sandore-microflow` / `@deepseek-ai/dsh-sandore-tool` |
| 前端包 | `@deepseek-ai/dsh-client-ui-sandore` |

#### 2.3.2 4 个包的目录结构

```
packages/sandore/
├── workflow/          # seam + Provider 桩 + RPC 三者合一
│   ├── package.json
│   └── src/
│       ├── index.ts        # abstract class SandoreEngine + Events + Provider 桩
│       ├── types.ts        # 类型
│       ├── runtime-types.ts # DagRun / DagStartRequest / DagResult
│       └── remote.ts       # @Remote / harness.handle 最小 ping RPC
├── microflow/         # 空占位（package.json + tsconfig.json）
├── tool/              # 空占位（package.json + tsconfig.json）
└── ui/                # Client 插件
    ├── package.json   # dsh.client + exports["./client"]
    └── src/
        ├── index.ts
        └── client/
            ├── WorkflowButton.tsx
            └── WorkflowPanel.tsx
```

#### 2.3.3 抽象类（11 个实例级方法）

```
startInstance(request: DagStartRequest): DagRun
recoverInstance(instanceId): Promise<DagRun>
abortInstance(instanceId): Promise<void>
replyQuestion(instanceId, requestId, answers): Promise<void>
replyPermission(instanceId, requestId, reply: 'once'|'always'|'reject'): Promise<void>
pauseStep(instanceId, stepId): Promise<void>
resumeStep(instanceId, stepId, resumePrompt?): Promise<void>
pauseAllSteps(instanceId): Promise<void>
resumeAllSteps(instanceId, resumePrompt?): Promise<void>
retryStep(instanceId, stepId, mode: 'continue'|'revert'|'fork', message): Promise<void>
getState(instanceId): DagInstanceState
```

决策 D2：Service 层只暴露实例级操作；定义/Job CRUD 与讨论/产物查询放 Host RPC 层。

#### 2.3.4 13 个事件（`sandore/*`，Task 1 需全部声明）

```
sandore/start  sandore/stage-start  sandore/stage-completed
sandore/step-start  sandore/step-completed  sandore/step-failed
sandore/step-paused  sandore/step-resumed  sandore/step-retried
sandore/question  sandore/permission  sandore/end  sandore/aborted
```

关键点：

- Cordis `Events` 声明：首参 `info: DagRunInfo`（可选触发源）。
- Session `SessionEventMap` 声明：纯数据载荷（必需，驱动 D8 讨论面板折叠 + apiproxy 透传）。
- `step-start/step-completed/step-failed/step-paused/step-resumed` 增补 `childId`；`step-completed` 增补 `output`。
- D9 修正：无 `default-session-mounted` 事件；无 `user-message` 事件。

#### 2.3.5 13 个基础类型

`DagRunInfo`、`DagStartRequest`、`DagRun`、`DagRunStatus`、`DagInstanceState`、`ExecutedStepDefault`、`StageInfo`、`StepStatus`、`StageContract`、`PendingQuestion`、`AskUserQuestionPayload`、`PendingPermission`、`DagResultInfo`（具体字段见 design.md §5.3，已完整列出）。

#### 2.3.6 依赖注入清单（Provider 桩 `static inject`）

`sessions` / `sessionPersistence` / `subagents` / `llm` / `shell` / `fs` / `storageDomain`（可选软依赖 `ctx.subprocess` / `ctx.sandbox`）。

### 2.4 关键硬约束（dsh-workflow.md §1.3 / §1.4）

1. **零外部 Agent SDK**：`@codeagent/sdk` 整体删除；AI 会话/Shell/文件/模型/事件流/SSE/持久化全部改用 DSH 组件（`ctx.agents`/`ctx.subagents`/`ctx.llm`/`ctx.shell`/`ctx.fs`/`ctx.sessions`/`ctx.storageDomain` 等）。
2. **纯插件分发，不改 DSH 源码**：不改 `ui-sidebar`/`ui-layout`/`ui-conversation`/`ui-workspace`；工作流 UI 入口只能是 `sidebar.footer.action` 按钮 + 点击展开面板（该 slot 位于工作区下方、设置上方）。
3. **UI 复用 DSH**：复用 `ui-primitives`/theme/locale/标准 hook；不可 import 的私有组件照着风格自绘。

### 2.5 DSH 参考源码范式（逐项对照）

> 参考源码根目录：`D:\project-code\llm\deepseek-harness`

#### 2.5.1 Service Definition 范式

**参考**：`packages/workflow/workflow/src/index.ts`

- `import { Context, Service } from '@deepseek-ai/cordis'`
- `declare module '@deepseek-ai/cordis' { interface Context { workflowEngine: WorkflowEngine }; interface Events { 'workflow/start'(info): void; ... } }`
- `export abstract class WorkflowEngine extends Service { constructor(ctx) { super(ctx, 'workflowEngine') } }`
- 基类提供 `protected emitWorkflowEvent(name, ...args)`：遍历 `this.ctx.events.dispatch('emit', [name, ...args])`，逐个 listener `try/catch + Promise.resolve().catch()` 隔离异常（**SandoreEngine 应继承此安全发射模式**）。
- 事件词汇通过 `WorkflowEventName` 联合类型收敛。

**对照 Task 1**：`SandoreEngine` 抽象类照此写法，`super(ctx, 'sandoreEngine')`，`declare module '@deepseek-ai/cordis'` 声明 `Context.sandoreEngine` 与 13 个 `Events`。

#### 2.5.2 Session 事件范式（关键）

**参考**：`packages/core/session/src/types.ts`（`SessionEventMap` 基接口，第 236 行）、`packages/session/session-title/src/index.ts`（declaration merge 范例）、`packages/workflow/tool-workflow/src/index.ts`（`session.append` 记录器范例）。

- `SessionEventMap` 是 merge-extensible 接口：各包 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'session/title': ... } }` 合并扩展。
- `Session.append` 签名（`packages/core/session/src/index.ts` 第 604 行）：

  ```ts
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts): SessionEvent<T>
  ```

  data 会被 `snapshotJsonValue` 校验为 JSON 可序列化，非 JSON 会抛错。

- `tool-workflow` 展示了 log-only 事件记录器模式：`createWorkflowRecorder` 把引擎 Cordis 事件（`workflow/agent-start` 等）转写为 Session 事件（`session.append('tool-workflow/agent-start', data)`），并用 `try/catch` 隔离记录失败（`disabled durable record`）。

**对照 Task 1**：`sandore/*` **就是 Session 事件**（`session.append('sandore/…', data)` 写宿主 Session log），经 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }` 声明合并；Cordis `Events` 同名声明仅作引擎内部可选触发源，不能替代 Session 事件。

#### 2.5.3 RPC 范式

**静态插件参考**：`packages/feedback/message-feedback/src/index.ts` + `packages/typert/protocol/src/index.ts`

- 服务类 `extends TypertRemoteService`（`@deepseek-ai/dsh-typert-protocol`）。
- `static inject = [...]`；`static Config: s<Config>`（schemastery，`@deepseek-ai/schemastery`）。
- `super(ctx, 'messageFeedback')` → 命名空间 = service key（`TypertRemoteService` 构造函数 `bindTypertRemote(this, this.name)`）。
- 方法装饰器 `@Remote('list')` / `@Remote('put')` → RPC 端点 `messageFeedback.list` 等。
- `Remote` 装饰器只支持 public 实例方法 + string 方法名；`exportName` 可选。

**对照 Task 1**：`sandore.ping` = 一个 `extends TypertRemoteService` 的 RPC 类 `super(ctx, 'sandore')` + `@Remote('ping')`。work.md 中「`@Remote`/`harness.handle` 的 `sandore.ping`」同时指两种形态：

- **静态插件**（生产）：`TypertRemoteService` + `@Remote('ping')`。
- **动态插件**（原型验证，§7.2 用 `cordis_define`/`cordis_run`）：`harness.handle(method, handler)`（见 `packages/extensions/cordis-host-runner/src/sandbox.ts` 第 30–35 行，签名 `harness.handle(method: string, handler: (args) => JsonValue | Promise<JsonValue>): () => void`）。

**客户端调用侧**：

- 静态：`ctx.remote.<namespace>.<method>(...)`（`packages/extensions/ui-cordis/src/client/index.ts` 第 45 行 `ctx.remote.dynamicCordisRunner.stopFromPanel(...)`）。
- 动态：`host.call('ping', args)`（`packages/extensions/cordis-client-runner` 的 sandbox 注入，签名 `host.call(method: string, args?: JsonValue): Promise<JsonValue>`）。

#### 2.5.4 storageDomain 范式（Task 1 仅约定背景）

**参考**：`packages/workspace/workspace/src/index.ts`

- `const domain = await this.ctx.storageDomain.open(domainSpec)`；`this.ctx.effect(() => () => domain.close(), '…')` 作为 disposer。
- `domain.table('workspaces')` → `KvTable`；`domain.global` → `DomainGlobal`。
- `table.get/put/update/delete`、`table.entries()/keys()/size`、`global.get/set`。
- `message-feedback` 的 `[Service.init]()` 里 `open` + `effect(disposer)` + `domain.table('sessions')`，并 `requireTable()` 防御未初始化。

**对照 Task 1**：Task 1 **不实现**持久化；仅约定 `sandore` 域三表 `definitions`（key=workflowId）/`jobs`（key=jobId）/`state`（key=instanceId）。

#### 2.5.5 Client 插件 + Slot 注册范式

**Host/Client 双半结构**（`packages/extensions/ui-cordis`）：

- `src/index.ts`（host 半）：`export function apply(): void {}`（纯 UI 插件 host 半为空壳）。
- `src/client/index.ts`（client 半）：`export const inject = [...]` + `export function apply(ctx: ClientContext): void`。
- package.json 关键字段（`ui-cordis` / `ui-workflow-run` 实测）：
  - `"type": "module"`
  - `"exports": { ".": {...}, "./client": { types, default } }`
  - `"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-...", ...], "platform": "web" } }`
  - `"peerDependencies"` 全部 `"workspace:^"`（含 `@deepseek-ai/cordis`、`react`、相关 `@deepseek-ai/dsh-*`）

**`sidebar.footer.action` 注册范式**（`ui-cordis/src/client/index.ts` 第 84–112 行）：

```ts
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'cordis-panel',
  locale: NS,
  inject: (): CordisPanelFace => ({ hooks: {...}, ... }),
}, CordisPanel))
```

- `sidebar.footer.action` 由 `ui-sidebar` 声明为 `{ kind: 'list'; scope: 'root' }`，owner props 仅 `wide: boolean`（`false` = 56px rail 窄栏 / `true` = 展开）。
- `CordisPanel.tsx` 展示面板开关为**插件自有 client 状态**：`const [open, setOpen] = useState(false)`，`<button aria-expanded={open} onClick={() => setOpen(v => !v)}>` 切换，`{open && <section className={css.panel}>…</section>}`。组件 props 由 `PropsRuntime<'sidebar.footer.action'> & InjectFace<Face> & PropsLocale<NS>` 合成（含 `wide`、`t`、注入的 hooks）。
- 需要 `import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'` 引入 slot 声明。

**`conversation.chat.node` keyed 注册范式**（`ui-workflow-run/src/client/index.ts` + `workflow-definition.ts`）：

```ts
ctx.conversationEvents.register(workflowRunDefinition)   // ConversationNodeDefinition
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node',
  key: 'workflow-run',
  locale: NS,
  inject: (): WorkflowRunInjected => ({ openSession: (id) => ctx.sessions.open(id) }),
}, WorkflowRunPanel))
```

- `ConversationNodeDefinition<State>` 结构：`kind / target: 'chat' / match(event) / start(context, match) / update(context, match) / buildViewNode(context)`，把一类 Session 事件（`tool-workflow/run-start` 等）折叠为一个 keyed Chat 节点。
- keyed 数据通过 `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData } }` 合并。

**对照 Task 1**：`ui` 包注册 `sidebar.footer.action`（`id: 'sandore-btn'`）+ 展开 WorkflowPanel 占位（`useState` 自包含开关）；`conversation.chat.node` keyed（`key: 'sandore-step'`）是 Task 4/5 的讨论面板落点，Task 1 不实现。

### 2.6 关键设计决策汇总（贯穿 Task 1）

| 编号 | 决策 | 说明 |
|---|---|---|
| D1 | 新引擎 `ctx.sandoreEngine` + `sandore/*` 事件 | 不扩展 `ctx.workflowEngine`，避免语义冲突 |
| D2 | Service 层只暴露实例级操作 | 定义/Job CRUD + 讨论/产物查询放 Host RPC 层 |
| D3 | Step 会话用 `ctx.subagents.startContinuable()` | 临时推理用 `ctx.llm.stream()`（Task 2+ 实现） |
| D4 | `work.json` 用 `ctx.storageDomain`；`chat.json` 用 Session 事件日志 | 三表 `definitions`/`jobs`/`state`（Task 1 仅约定） |
| D5 | 事件/SSE 全用 DSH，零自建 | 删除 WorkflowEventBus/SSE/SdkSseManager |
| D6 | UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel | 放弃常驻 sidebar 分组与 `conversation.view` tab 主入口 |
| D7 | 前端复用 DSH 组件与设计语言 | ui-primitives/theme/locale |
| D8 | 讨论面板复用 `ui-workflow-run` Chat 节点机制 | 每 Step 折叠为 `sandore-step` 节点（Task 4/5） |
| D9 | 主代理 = 工作流编排器，身份不切换 | 无 `default-session-mounted`；宿主 Session 完成后自然降级为自由对话 |

### 2.7 验证标准对应的落点

work.md §验证标准 → 对应范式：

- `pnpm run typecheck` 通过、4 个包 package.json 正确 → 见 2.5.5（`dsh.client`/`exports`/`peerDependencies`/ESM）。
- `ctx.sandoreEngine` 抽象类 + 13 事件声明正确 → 见 2.5.1（Service Definition）+ 2.5.2（Session 事件）。
- sidebar 设置上方出现「工作流」按钮、点击展开 WorkflowPanel → 见 2.5.5（`sidebar.footer.action` + `useState` 面板）。
- `host.call('sandore.ping')` 往返 JSON 正常 → 见 2.5.3（`TypertRemoteService` + `@Remote('ping')` 静态 / `harness.handle` 动态）。
- 无对 DSH 源码的任何修改 → 硬约束 2.4。

---

## 三、关键结论

1. sandore 仓库**没有引擎源码**（`packages/` 为空），Task 1 是从零建 `packages/sandore/` 脚手架；furina 当前只有一个空的 `task-1-skeleton` change，无历史归档。
2. Task 1 的权威规格集中在 `docs/design/task-1-skeleton/design.md`（11 方法、13 事件、13 类型、Slot 注册代码、依赖注入清单、验证标准均已给出精确内容）。
3. `sandore/*` 事件必须按 **Session 事件**（`session.append` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`）声明，Cordis `Events` 声明只是可选触发源。
4. `sandore.ping` RPC 的静态落点是 `class X extends TypertRemoteService { super(ctx, 'sandore') }` + `@Remote('ping')`；动态原型落点是 `harness.handle('sandore.ping', handler)`。
5. Client 入口 `sidebar.footer.action`（`id: 'sandore-btn'`）注册范式照抄 `ui-cordis`；面板开关是插件自有 `useState` client 状态，无需跨 scope。
