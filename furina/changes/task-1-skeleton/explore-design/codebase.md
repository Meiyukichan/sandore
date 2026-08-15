# Task 1 骨架 — 代码库探索结果

## Exploration Result

（Phase 3：furina-codebase explore）

`furina config show project.sourcecode codebases` 返回：

```
project.sourcecode=src/
codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]
```

`docs/codebase` 目录为**空目录**，无 code-document tree（无 `toc.md` / 模块 spec 文档）。furina-codebase explore 依赖已生成的文档树进行层级导航，故 Phase 3 **无匹配结果**，转入 Phase 4 手动补充探索。

---

## Supplementary Exploration Result

（Phase 4：手动补充探索）

### 1. 当前项目状态（sandore 仓库）

本仓库为全新 greenfield 状态，Task 1 从零搭建：

- 仓库根 `D:\project-code\llm\sandore` 下**无** `package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`。
- `packages/` 目录**为空**；`src/`（`project.sourcecode` 指向的目录）**不存在**。
- `docs/codebase/` 为空目录。
- 仅有：`AGENTS.md`、`README.md`（内容仅为 `# sandore`）、`LICENSE`、`docs/`（设计文档）、`furina/`（`changes/` 与 `archive/`）。
- 引擎源码不在本仓库——`docs/engine/dsh-workflow.md` §2.1 明确「`packages/` 目录为空……引擎源码不在本仓库。本次开发需按设计文档重新实现引擎」。

**项目约束（`AGENTS.md`）**：
1. UI 能复用 DSH 就复用，不能复用就照着风格做成一模一样；
2. 引擎和后端尽量复用 DSH 组件；
3. 所有代码参考 DSH 的代码风格。

### 2. Task 1 规格要点（源自 work.md + design.md）

**定位**：实现「工作流引擎 DSH 插件」骨架的第一步——仓库脚手架（4 个包）+ Service Definition + 最小端到端链路。**仅骨架，无真实执行逻辑**。

**4 个产出包**：
| 包 | 路径 | 内容 |
|---|---|---|
| seam + Provider 桩 + RPC | `packages/sandore/workflow/` | `abstract class SandoreEngine extends Service`（11 实例级方法）+ `sandore/*` 13 事件（Cordis `Events` + Session `SessionEventMap` 双声明）+ 13 基础类型 + 空 Provider 桩（`static Config` schemastery + `inject`）+ 最小 RPC（`@Remote`/`harness.handle` 的 `sandore.ping`） |
| 空占位 | `packages/sandore/microflow/` | package.json + tsconfig，后续 Task 填充 `StageExecutor`/`StepRunner` |
| 空占位 | `packages/sandore/tool/` | package.json + tsconfig，后续 Task 填充 `sandore_*` 模型工具 |
| Client 插件 | `packages/sandore/ui/` | 注册 `sidebar.footer.action`（工作流按钮，设置上方）+ 点击展开 WorkflowPanel 占位；`host.call('sandore.ping')` 往返 |

**命名空间（D1）**：Service key `ctx.sandoreEngine`；事件前缀 `sandore/*`；模型工具 `sandore_*`；RPC 方法 `sandore.*`（Task 1 最小 `sandore.ping`）。

**11 个实例级方法**：`startInstance` / `recoverInstance` / `abortInstance` / `replyQuestion` / `replyPermission` / `pauseStep` / `resumeStep` / `pauseAllSteps` / `resumeAllSteps` / `retryStep` / `getState`。

**13 个事件（`sandore/*`，Task 1 全部声明）**：
`sandore/start`、`sandore/stage-start`、`sandore/stage-completed`、`sandore/step-start`、`sandore/step-completed`、`sandore/step-failed`、`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`、`sandore/question`、`sandore/permission`、`sandore/end`、`sandore/aborted`。
- 关键修正：**无 `default-session-mounted`、无 `user-message` 事件**（D9 收敛）。
- Session 事件（`session.append` + `SessionEventMap`）是**必需**的；Cordis `Events` 声明是引擎内部可选触发源，不能替代 Session 事件。

**13 个基础类型（design.md §5.3）**：`DagRunInfo` / `DagStartRequest` / `DagRun` / `DagRunStatus` / `DagInstanceState` / `ExecutedStepDefault` / `StageInfo` / `StepStatus` / `StageContract` / `PendingQuestion` / `AskUserQuestionPayload` / `PendingPermission` / `DagResultInfo`。

**硬约束（不可违反）**：纯插件不改 DSH 源码；零外部 Agent SDK（`@codeagent/sdk` 整体删除），引擎/后端全用 DSH `ctx.*` 服务；UI 复用 DSH（`ui-primitives`/theme/locale/标准 hook），不能复用就照着风格自绘。

### 3. DSH 参考范式（work.md 必读清单 → 源码）

> 以下均为 DSH 仓库 `D:\project-code\llm\deepseek-harness` 中的既有实现，是 Task 1 各部分的直接参照。Task 1 不改这些文件，只仿照其范式在 `packages/sandore/` 下新建。

#### 3.1 Service Definition 范式

**源文件**：`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`（203 行）

核心形态：抽象类 `extends Service` + `super(ctx, '<key>')` + `declare module '@deepseek-ai/cordis'` 合并 `Context` 与 `Events`。

```typescript
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowEngine: WorkflowEngine
  }
  interface Events {
    'workflow/start'(info: WorkflowRunInfo): void
    'workflow/phase'(info: WorkflowRunInfo, title: string): void
    'workflow/log'(info: WorkflowRunInfo, message: string): void
    'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
    'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
    'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
  }
}

export abstract class WorkflowEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflowEngine')
  }
  abstract start(request: WorkflowStartRequest): WorkflowRun

  protected emitWorkflowEvent(name: WorkflowEventName, ...args: unknown[]): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
      try {
        const returned: unknown = (callback as (...payload: unknown[]) => unknown)(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`workflow: ${name} listener rejected: ${renderListenerError(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow: ${name} listener threw: ${renderListenerError(error)}`)
      }
    }
  }
}
export default WorkflowEngine
```

要点：
- `WorkflowError extends HarnessError` 带 `readonly fatal: boolean`（`fatal` 默认 `true`）——`SandoreError` 对齐此模式（overall-design.md §4.4）。
- `emitWorkflowEvent`（protected）对 listener 异常做 try/catch 捕获——`SandoreEngine` 基类继承此安全发射模式。
- 事件签名首参是 `info`（身份快照），DSH `workflow/*` 对应 Task 1 `sandore/*` 首参 `DagRunInfo`。

#### 3.2 Session 事件 append + SessionEventMap 声明合并范式

**源文件**：
- `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\types.ts`（65 行）
- `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\index.ts`（336 行）

`types.ts` 中的声明合并（Task 1 的 `SessionEventMap` 双声明照此）：

```typescript
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface ToolWorkflowRunStartData {
  readonly runId: WorkflowRunId
  readonly name: string
}
// ... 其余 event data 接口（ToolWorkflowAgentStartData / AgentEndData / RunEndData）

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'tool-workflow/run-start': ToolWorkflowRunStartData
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    'tool-workflow/run-end': ToolWorkflowRunEndData
  }
}
```

`index.ts` 中的 append 范式（先 `ctx.on` 作触发源，再 `session.append` 写 log）：

```typescript
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'

const append = <Type extends keyof ToolWorkflowRecordEventMap>(
  session: Session,
  type: Type,
  data: SessionEventMap[Type],
): boolean => {
  const appendRecord = session.append.bind(session) as <Event extends keyof ToolWorkflowRecordEventMap>(
    event: Event,
    value: SessionEventMap[Event],
  ) => void
  try {
    appendRecord(type, data)
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`tool-workflow: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`)
    return false
  }
}

ctx.on('workflow/agent-start', (info, agent) => {
  const session = active.get(info.id)
  if (session === undefined) return
  const data: ToolWorkflowAgentStartData = { runId: info.id, seq: agent.seq, label: agent.label, childId: agent.childId }
  if (!append(session, 'tool-workflow/agent-start', data)) active.delete(info.id)
})
```

要点（与 Task 1 强相关）：
- `sandore/*` 是 **Session 事件**（`session.append('sandore/…', data)`），经 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }` 合并——这是 D8 讨论面板折叠与 apiproxy `session/event` 透传的前提。
- tool-workflow 的 `ToolWorkflowRecordEventMap` 是包内私有接口，但 append 的 `data` 类型取自 `SessionEventMap[Type]`（公开合并后的事件表），Task 1 的 `sandore/*` 事件 data 类型同样要合并进 `SessionEventMap`。

#### 3.3 footer 按钮 + 展开面板范式（ui-cordis，D6 入口）

**源文件**：
- `D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\index.ts`（9 行，Host 半空壳）
- `D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\index.ts`（171 行）

Host 半（空 apply，纯 UI 插件在 host 侧无行为）：

```typescript
/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
```

Client 半 `sidebar.footer.action` 注册（设置上方的 footer 动作位）：

```typescript
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export const inject = ['slots', 'locale', 'inputTriggers', 'remote', ...]

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cordis: dictionaries')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'cordis-panel',
    locale: NS,
    inject: (): CordisPanelFace => ({
      hooks: {
        inventory,
        activeRuns: runner.activeRuns,
        runErrors: runner.lastRunError,
        loaded,
        renderFailures: runner.renderFailures,
      },
      onApprove: (requestId, approveFutureVersions) => runner.approve(requestId, approveFutureVersions),
      // ... 其余回调
    }),
  }, CordisPanel))
}
```

要点（Task 1 UI 直接照此）：
- `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name, id, locale, inject: () => ({ hooks, onXxx }) }, Component))`。
- `inject` 回调无参数（root scope），面板开关状态是插件自有 client 状态（inventory/hooks），组件（`CordisPanel`）负责渲染展开面板——Task 1 的 `WorkflowButton`/`WorkflowPanel` 同构。
- `import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'` 用于引入 `sidebar.footer.action` 的 slot 类型声明。

#### 3.4 conversation.chat.node keyed 节点范式（ui-workflow-run，D8 讨论面板）

**源文件**：
- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\index.ts`（32 行）
- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\workflow-definition.ts`（193 行）

注册入口（`conversationEvents.register` + `conversation.chat.node` keyed）：

```typescript
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(workflowRunDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflow-run: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'workflow-run',
    locale: NS,
    inject: (): WorkflowRunInjected => ({
      openSession: (id: SessionId) => { ctx.sessions.open(id) },
    }),
  }, WorkflowRunPanel))
}
```

`ConversationNodeDefinition`（折叠 `sandore-step` 节点的骨架，Task 1 声明、后续 Task 填充）：

```typescript
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'workflow-run': WorkflowRunChatData
  }
}

export const workflowRunDefinition: ConversationNodeDefinition<WorkflowState> = {
  kind: 'workflow-run',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool-workflow/run-start') return { id: String(event.data.runId), role: 'start' }
    if (event.type === 'tool-workflow/agent-start' || event.type === 'tool-workflow/agent-end'
      || event.type === 'tool-workflow/run-end') {
      return { id: String(event.data.runId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool-workflow/run-start') throw new Error('...')
    return { name: match.event.data.name, members: [] }
  },
  update: (context, match) => { /* 按事件类型折叠 state */ return context.state },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return { key: context.key, kind: 'workflow-run', id: context.id, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location, visibility: 'visible', data }
  },
}
```

要点：`match` 折叠的是 **append 到 log 的 Session 事件**（带 `seq`），Task 1 的 `sandore-step` 节点 key = `'sandore-step'`、`kind` 仿此；`ChatNodeDataMap` 声明合并 key = `'sandore-step'`。

#### 3.5 RPC 范式（@Remote / TypertRemoteService + 动态插件 harness.handle）

**源文件**：`D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts`（383 行）

生产 RPC（`@Remote` 装饰器 + `TypertRemoteService` 基类，Task 1 `sandore.ping` 的最小形式）：

```typescript
import s from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Context {
    messageFeedback: MessageFeedbackService
  }
}

export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']

  static Config: s<Config> = s.object({
    maxNoteBytes: s.number().step(1).min(1).required(),
  })

  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(messageFeedbackDomainSpec)
    this.ctx.effect(() => async () => { await domain.close() }, 'message-feedback.domainClose')
    this.table = domain.table('sessions')
  }

  @Remote('list')
  async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> { /* ... */ }
  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> { /* ... */ }
  @Remote('delete')
  delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult> { /* ... */ }
}
export default MessageFeedbackService
```

动态插件原型 RPC（`cordis_define`/`cordis_run`，Task 1 原型验证用，来自 `tool-cordis/src/prompt.ts:98`）：

> Host and Client communicate through Package-private JSON methods: Host uses `harness.handle(method, handler)`, and Client uses `host.call(method, args)`. The direction is Client→Host, and only lossless JSON may cross it.

要点：
- 生产态 RPC：`extends TypertRemoteService` + `@Remote('<name>')`，`super(ctx, '<key>')`；`static Config` 用 **schemastery**（`s.object({...})`），`static inject` 声明硬依赖。
- Task 1 Provider 桩的 `static Config` 用 schemastery、`inject` 声明 `sessions/sessionPersistence/subagents/llm/shell/fs/storageDomain`（design.md §7.3）。
- Task 1 最小 RPC 名 `sandore.ping`（点号）；动态插件原型走 `harness.handle`/`host.call`。

#### 3.6 storageDomain.open(spec) / defineDomain 范式（Task 1 背景约定）

**源文件**：
- `D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\spec.ts`（defineDomain）
- `D:\project-code\llm\deepseek-harness\packages\workspace\workspace\src\index.ts`（`storageDomain.open` + `domain.table`/`domain.global`）

```typescript
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const messageFeedbackDomainSpec = defineDomain({
  name: 'message_feedback',
  version: 0,
  tables: {
    sessions: domainTable<SessionId, MessageFeedbackRow>(messageFeedbackRowSchema),
  },
})
```

```typescript
const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
this.table = domain.table('workspaces')
this.global = domain.global
```

要点（Task 1 不实现，仅类型/约定背景）：`sandore` 域三表 `definitions`（key=workflowId）/`jobs`（key=jobId）/`state`（key=instanceId），`defineDomain` + `domainTable` + Zod schema；`open(spec)` 打开、`ctx.effect(() => () => domain.close())` 释放。

#### 3.7 package.json 约定（脚手架）

**源文件**：
- Host 包：`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\package.json`
- Client 包：`D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\package.json`、`packages\extensions\ui-cordis\package.json`

Host 包关键字段（`@deepseek-ai/dsh-workflow`）：
```json
{
  "name": "@deepseek-ai/dsh-workflow",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "peerDependencies": { "@deepseek-ai/cordis": "workspace:^", /* ... */ }
}
```

Client 包关键字段（`@deepseek-ai/dsh-client-ui-workflow-run` / `ui-cordis`）：
```json
{
  "name": "@deepseek-ai/dsh-client-ui-workflow-run",
  "type": "module",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation"],
      "platform": "web"
    }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "workspace:^", "react": "^18.2.0", /* ... */ }
}
```

要点：
- ESM 全量（`"type": "module"`）；Host 包无 `dsh.client`，Client 包声明 `dsh.client`（`inject` + `platform: "web"`）+ `exports["./client"]`。
- `@deepseek-ai/cordis` 始终为 peerDependency。
- 包名对齐 Task 1 命名：`@deepseek-ai/dsh-sandore-workflow` / `@deepseek-ai/dsh-sandore-microflow` / `@deepseek-ai/dsh-sandore-tool` / `@deepseek-ai/dsh-client-ui-sandore`。

### 4. 关键结论（探索汇总）

1. **Greenfield**：sandore 无 `src/`、无根 `package.json`、`packages/` 为空、引擎源码缺失——Task 1 需按设计文档从零搭建 `packages/sandore/` 四个包与 monorepo 骨架。
2. **Service Definition 三件套范式已定位**：抽象类 `extends Service`（`super(ctx, 'sandoreEngine')`）+ `declare module '@deepseek-ai/cordis'`（`Context` + `Events`）+ `emitWorkflowEvent` 安全发射（`workflow/workflow/src/index.ts`）。
3. **Session 事件声明合并范式已定位**：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap }` + `session.append`（`tool-workflow/src/types.ts` + `index.ts`）。
4. **Client Slot 注入范式已定位**：`sidebar.footer.action`（list, root scope）注册（`ui-cordis/src/client/index.ts`）；`conversation.chat.node` keyed + `ConversationNodeDefinition`（`ui-workflow-run`）。
5. **RPC 范式已定位**：生产 `TypertRemoteService` + `@Remote`（`message-feedback`）；动态插件原型 `harness.handle`/`host.call`（`tool-cordis` 约定）；`static Config` 用 schemastery（`s.object`）。
6. **storageDomain 范式已定位**：`defineDomain` + `domainTable` + Zod schema + `ctx.storageDomain.open(spec)`（`workspace`/`message-feedback`，Task 1 仅背景约定）。
7. **package.json 约定已定位**：ESM + `exports`（Host 含 `./types`，Client 含 `./client` + `dsh.client`）+ `@deepseek-ai/cordis` peerDependency。
