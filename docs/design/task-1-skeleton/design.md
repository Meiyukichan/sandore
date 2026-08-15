# Task 1 骨架：工作流引擎 DSH 插件设计规格

> **本文档范围**：本文档是 Task 1 骨架的完整设计规格，内容提取自 [dsh-workflow.md](../../engine/dsh-workflow.md) 与 [dynamic-workflow-engine.md](../../engine/dynamic-workflow-engine.md)。Task 1 定位为实现「工作流引擎 DSH 插件」的骨架：仓库脚手架 + Service Definition（`ctx.sandoreEngine` 抽象接口 + 事件词汇）+ 最小端到端链路（活动栏按钮 + 视图 tab + Host RPC 往返）。**不包含**任何真实引擎执行逻辑。

---

## 1. 目标与范围

### 1.1 任务目标

实现工作流引擎 DSH 插件的骨架，包括：

1. **仓库脚手架**：创建 `packages/sandore/` 目录结构及各包的 `package.json`
2. **Service Definition**：定义 `ctx.sandoreEngine` 抽象接口 + `sandore/*` 事件声明
3. **最小端到端链路**：
   - 工作流入口按钮（`sidebar.footer.action`，位于设置上方）
   - 点击展开的 WorkflowPanel 占位（仿 workspace 风格）
   - Host RPC 往返（`host.call()` 测试调用）

### 1.2 范围边界

| 在范围内 | 不在范围内 |
|---|---|
| 仓库脚手架（目录结构 + package.json） | 真实引擎执行逻辑（Stage/Step/DAG） |
| Service Definition（抽象类 + 事件声明） | 具体 Service Provider 实现 |
| Client 端 Slot 注册（sidebar + conversation） | 完整的 UI 组件（DagEditor/RunView） |
| 最小 Host RPC 接口定义 | 实际的 RPC 业务逻辑 |
| 验证 Slot 注入与 RPC 链路 | 完整的前端功能 |

### 1.3 核心硬约束

**零外部 Agent SDK，全用 DSH 组件**：这是本设计的最高优先级约束。原 sandore 引擎的 `@codeagent/sdk` 依赖整体删除，所有 AI 会话、Shell 命令、文件读写、模型推理、事件流/SSE、会话持久化等能力，全部改由 DSH 自身的组件（Cordis 服务）实现。

理由：
1. **单一运行时**：DSH 本身就是 agent harness，已具备完整能力
2. **权限/沙箱/审计统一**：DSH 的权限模式、沙箱、事件溯源 Session 是产品级的一体化设计
3. **会话模型一致**：避免两套语义混用导致暂停/恢复/崩溃恢复语义不一致
4. **可维护性**：DSH 的 `workflow` 子系统已示范正确模式

---

## 2. 命名空间决策（D1）

DSH 已占用 `ctx.workflowEngine`、`workflow/*` 事件、`tool-workflow` 工具名。为避免冲突，新引擎使用独立命名空间：

| 概念 | sandore 引擎命名 | DSH 中命名 |
|---|---|---|
| 引擎 Service | `WorkflowEngineV2` | `ctx.sandoreEngine`（`SandoreEngine`） |
| 事件前缀 | `workflow.*` | `sandore/*` |
| 模型工具（可选） | — | `sandore_*`（主代理编排器工具） |
| 包名 | `@optix/workflow-engine` | `@deepseek-ai/dsh-sandore-workflow` |
| 前端包 | — | `@deepseek-ai/dsh-client-ui-sandore` |

**决策 D1**：新引擎不扩展 `ctx.workflowEngine`（其接口为「脚本编排」设计），而是新开一个 `ctx.sandoreEngine` Service，避免语义冲突。

---

## 3. DSH 插件机制速览

### 3.1 Cordis 插件模型

- DSH 基于 vendored **Cordis** DI 框架，「一切皆插件」
- 插件有三种形态：函数、类、`{ apply }` 对象；`apply(ctx)` 是入口
- 一个**能力 seam（capability seam）** 由三部分组成：
  1. **Service Definition**（抽象类，定义接口 + 事件）
  2. **Service Provider**（具体实现，注册为 `ctx.<key>`）
  3. **Consumer**（工具 / UI / 其他插件，消费该服务）
- 关键约定：ESM 全量（`"type": "module"`）、包名 `@deepseek-ai/dsh-<name>`、`@deepseek-ai/cordis` 为 peerDependency

### 3.2 Host 插件与 Client 插件

- **Host 插件**：运行在 DSH Node 进程，`apply(ctx)` 里 `ctx.reflect.provide('key', service)` 提供服务、`ctx.on(...)` 订阅事件
- **Client 插件**：运行在浏览器页。一个包通过 package.json 声明 `dsh.client`（`platform: 'web'`）+ `exports["./client"]` 导出构建产物
- 一个包可**同时**提供 Host 半（`src/`）和 Client 半（`src/client/`）

### 3.3 挂载方式

- **静态组合**：在 `cordis.yml` 中添加插件行，由 Loader 在 boot 时加载（持久化插件的标准方式）
- **动态插件**：`ctx.dynamicCordisRunner` / `cordis_define`/`cordis_run` 是「模型自我修改运行时」的临时机制，**适合**原型验证

### 3.4 Slot 系统（Client UI 注入）

DSH 前端是**三栏布局**，顶级 slot 结构：

```
root
├── sidebar            (single, root scope)
│   ├── sidebar.workspaces  (single)
│   ├── sidebar.settings    (single)
│   └── sidebar.footer.action (list)          —— 设置上方的附加动作位（工作流入口）★
├── conversation       (single, session-maybe)
│   └── conversation.session (single, session)
│       └── conversation.chat.node (keyed)     —— 消息节点（sandore-step 讨论节点）★
├── details            (single, session scope)
└── shell.overlay      (list, root scope)
```

与本任务直接相关的两个 slot：

1. **`sidebar.footer.action`**（list，root scope）：设置上方的附加动作位，**可加性（additive）**——注册 `id: 'sandore-btn'` 即新增「工作流」按钮，点击展开 WorkflowPanel。
2. **`conversation.chat.node`**（keyed，session scope）：消息流里的节点渲染——`sandore-step` 讨论节点注册 `key: 'sandore-step'`（仿 `ui-workflow-run` 的 `key: 'workflow-run'`）。

---

## 4. 总体架构设计

### 4.1 三层分离（对齐 DSH capability seam）

把 sandore 的「引擎 + server + client」映射为 DSH 的 Service Definition / Provider / Consumer 三层 + 一个 Client UI 插件：

```
┌─────────────────────────────────────────────────────────────────────┐
│  Client（浏览器）                                                    │
│  @deepseek-ai/dsh-client-ui-sandore                    │
│  ├── sidebar.footer.action  → 「工作流」按钮（设置上方入口）         │
│  ├── conversation.chat.node → 「sandore-step」讨论节点（宿主 Session）   │
│  └── host.call() ──────────────► Host RPC（JSON）                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │ host.call / Remote
┌─────────────────────────────────────────────────────────────────────┐
│  Host（Node 进程）                                                  │
│  @deepseek-ai/dsh-sandore-workflow（seam + Provider + RPC）        │
│  │   abstract class SandoreEngine extends Service（Service Definition）│
│  │   SandoreEngineRuntime（Service Provider，Task 1 桩实现）       │
│  │   @Remote RPC（暴露最小方法给 Client）                          │
│  ├── @deepseek-ai/dsh-sandore-microflow（Task 1 空占位）           │
│  └── @deepseek-ai/dsh-sandore-tool（Task 1 空占位）                │
└─────────────────────────────────────────────────────────────────────┘
                                    │ 复用 DSH Host 服务
┌─────────────────────────────────────────────────────────────────────┐
│  DSH 基础设施（复用，不重造）                                       │
│  ctx.agents / ctx.sessions / ctx.llm / ctx.shell / ctx.fs           │
│  ctx.subagents / ctx.sessionPersistence / ctx.storageDomain         │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 根 monorepo 工作区（前置条件）

> 仓库当前是 **greenfield**（仅 docs/AGENTS.md，无任何 package.json）。`pnpm run typecheck` 验证标准要求先建立根 monorepo 工作区配置：

```
<repo-root>/
├── package.json              # name: sandore；private；packageManager: pnpm@11.7.0；engines node >=22
│                             # scripts: { typecheck, build, ... }；devDependencies: typescript/tsdown/tsx
├── pnpm-workspace.yaml       # packages: ['packages/sandore/*']
├── tsconfig.base.json        # 各包 extends 的 base（strict、moduleResolution、declaration 等）
└── .npmrc                    # 如需要（registry / node-linker 等）
```

**DSH 依赖来源（关键约定）**：`@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 是 **npm public scope**（DSH 公测已开放 npm 插件生态，当前版本 `0.1.0-rc.5`）。sandore 各包以 **peerDependencies 声明**（版本 `0.1.0-rc.5`），开发/安装时从 npm 解析，**不用 `file:`/`link:` 指向本地 DSH 源码**（DSH 源码仅作参考阅读）。

- `workflow` 包的 peerDependencies：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`（SessionEventMap 声明合并）、`@deepseek-ai/dsh-llm`（`ContentBlock` 类型）、`@deepseek-ai/dsh-typert-protocol`（`TypertRemoteService`/`Remote`）、`@deepseek-ai/dsh-agent`（后续 Task 用）、`@deepseek-ai/dsh-storage`（storageDomain，后续 Task 用）
- `ContentBlock` 类型来源：`import type { ContentBlock } from '@deepseek-ai/dsh-llm'`（type-only，无运行时依赖；DSH 先例 `dsh-workflow` 的 `output: ContentBlock[]`）

### 4.3 包结构

按 DSH 仓库布局（`packages/<group>/<pkg>/`），创建 `packages/sandore/`：

```
packages/sandore/
├── workflow/                    # Service Definition + Provider 桩 + @Remote RPC（seam/Provider/RPC 合一）
│   ├── package.json                 # 无 dsh.client
│   └── src/
│       ├── index.ts                 # abstract class SandoreEngine + Events + Provider 桩
│       ├── types.ts                 # WorkflowDefinition/Stage/Step/状态/契约 类型
│       ├── runtime-types.ts         # DagRun / DagStartRequest / DagResult
│       └── remote.ts                # TypertRemoteService + @Remote（super(ctx,'sandore') + @Remote('ping') → sandore.ping）
├── microflow/                  # Stage 内部执行（Task 1: 空目录占位）
│   ├── package.json
│   └── tsconfig.json
├── tool/                       # 模型工具 Consumer（Task 1: 空目录占位）
│   ├── package.json
│   └── tsconfig.json
└── ui/                         # Client UI（Task 1: 最小 Slot 注册）
    ├── package.json                 # 声明 dsh.client + exports["./client"]
    └── src/
        ├── index.ts                 # 注册 sidebar.footer.action 按钮
        └── client/
            ├── WorkflowButton.tsx   # 设置上方的「工作流」入口按钮
            └── WorkflowPanel.tsx    # 展开面板（占位：header 编排/新增 + 三态列表）
```

**Task 1 暂不实现的内容**（后续阶段）：
- `microflow` 的 StageExecutor/StepRunner（Task 2/3 填充）
- `tool` 的 `sandore_*` 模型工具（Task 4 填充）

---

## 5. Service Definition（`ctx.sandoreEngine`）

### 5.1 抽象类定义

仿照 `packages/workflow/workflow/src/index.ts` 的写法，定义抽象 seam：

```typescript
// packages/sandore/workflow/src/index.ts
import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandoreEngine: SandoreEngine
  }
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
    // （D9 修正：无 default-session-mounted——宿主 Session 自然延续为自由对话，不额外挂载）
  }
}

// 同名事件还需作为 Session 事件声明合并（D8 讨论面板折叠的前提，见 §5.2 关键说明）：
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'sandore/start': { taskId: string; workflowId: string; jobId: string }
    'sandore/stage-start': { taskId: string; stageId: string }
    'sandore/stage-completed': { taskId: string; stageId: string; stageContract: StageContract }
    'sandore/step-start': { stepId: string; childId: string }
    'sandore/step-completed': { stepId: string; childId: string; output: ContentBlock[] }
    'sandore/step-failed': { stepId: string; childId: string; error: string }
    'sandore/step-paused': { stepId: string; childId: string }
    'sandore/step-resumed': { stepId: string; childId: string; resumePrompt?: string }
    'sandore/step-retried': { stepId: string; mode: string }
    'sandore/question': { question: PendingQuestion }
    'sandore/permission': { permission: PendingPermission }
    'sandore/end': { taskId: string; jobId: string; result: DagResultInfo }
    'sandore/aborted': { taskId: string }
  }
}

export abstract class SandoreEngine extends Service {
  constructor(ctx: Context) { super(ctx, 'sandoreEngine') }

  // 实例生命周期
  abstract startInstance(request: DagStartRequest): DagRun
  abstract recoverInstance(instanceId: string): Promise<DagRun>
  abstract abortInstance(instanceId: string): Promise<void>

  // 交互
  abstract replyQuestion(instanceId: string, requestId: string, answers: unknown): Promise<void>
  abstract replyPermission(instanceId: string, requestId: string, reply: 'once'|'always'|'reject'): Promise<void>

  // 暂停/恢复/重试（D9：含广播恢复；暂停登记表由引擎自建，DSH 无 paused 状态）
  abstract pauseStep(instanceId: string, stepId: string): Promise<void>
  abstract resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>
  abstract pauseAllSteps(instanceId: string): Promise<void>
  abstract resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>
  abstract retryStep(instanceId: string, stepId: string, mode: 'continue'|'revert'|'fork', message: string): Promise<void>

  // 状态查询
  abstract getState(instanceId: string): DagInstanceState
}
```

**决策 D2**：Service 层只暴露「实例级」操作（start/recover/abort/reply/pause/resume/retry/getState），工作流定义/Job 的 CRUD 与「实例的持久化文件/讨论/产物」查询放在 `workflow`（Host RPC 层），避免 Service 接口臃肿。

### 5.2 事件清单

> **关键（经探索确认）**：`sandore/*` 是 **Session 事件**（`session.append('sandore/…', data)` 写入宿主 Session log，经 `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`），**不是纯 Cordis 事件**。只有 append 到 log 的事件才会被 `ConversationNodeDefinition`（D8 讨论面板）折叠、被 apiproxy `session/event` 帧透传。上表 Cordis `Events` 声明仅作引擎内部可选触发源；**Session 事件声明是必需的**（见上方代码第二段）。

| 事件名（Session 事件） | 数据 | 触发时机 |
|--------|------|---------|
| `sandore/start` | `{taskId, workflowId, jobId}` | execute() 开始 |
| `sandore/stage-start` | `{taskId, stageId}` | Stage 开始执行 |
| `sandore/stage-completed` | `{taskId, stageId, stageContract}` | Stage 执行完成 |
| `sandore/step-start` | `{stepId, childId}` | Step 开始执行（childId = 子代理 SessionId） |
| `sandore/step-completed` | `{stepId, childId, output}` | Step 完成（output = `finalAssistantOutput` 子代理最终结果，内联展示用） |
| `sandore/step-failed` | `{stepId, childId, error}` | Step 执行失败 |
| `sandore/question` | `PendingQuestion` | 问答请求 |
| `sandore/permission` | `PendingPermission` | 权限请求 |
| `sandore/end` | `{taskId, jobId, result}` | 工作流结束 |
| `sandore/aborted` | `{taskId}` | 工作流被中止 |
| `sandore/step-paused` | `{stepId, childId}` | Step 暂停（引擎登记表记录） |
| `sandore/step-resumed` | `{stepId, childId, resumePrompt?}` | Step 恢复 |
| `sandore/step-retried` | `{stepId, mode}` | Step 重试开始 |

（D9 修正：无 `default-session-mounted` 事件——宿主 Session 自然延续为自由对话。）

### 5.3 类型定义基础

Task 1 需要的基础类型（来自 `dynamic-workflow-engine.md` §3）：

#### DagRunInfo

```typescript
interface DagRunInfo {
  taskId: string        // 实例 ID
  workflowId: string    // 工作流定义 ID
  jobId: string         // Job ID
}
```

#### DagStartRequest

```typescript
interface DagStartRequest {
  workflowId: string    // 工作流定义 ID
  jobId: string         // Job ID
  originalInput: string // 用户原始需求
  cwd?: string          // 工作目录
  // 注：无 permissionMode（权限修正后废弃——权限由宿主 Session 的 permission preset 决定）
}
```

#### DagRun

```typescript
interface DagRun {
  instanceId: string
  status: DagRunStatus
}
```

#### DagRunStatus

```typescript
type DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'
```

#### DagInstanceState

```typescript
interface DagInstanceState {
  taskId: string
  jobId: string
  workflowId: string
  status: DagRunStatus
  originalInput: string
  currentStageId: string
  executedSteps: ExecutedStepDefault[]
  stageInfos: StageInfo[]
  pendingQueue: string[]
  createdAt: string
  updatedAt: string
}
```

#### ExecutedStepDefault

```typescript
interface ExecutedStepDefault {
  type: 'default'
  id: string
  stepId?: string
  stageId: string
  name: string
  status: StepStatus
  command?: CommandConfig
  inputFrom?: InputFromItem[]
  outputTo?: OutputToItem[]
  passThroughVars?: PassThroughVar[]
  sessionMeta?: StepSessionMeta
  finalizeMeta?: FinalizeMeta
  visitCount: number
  branchMeta?: BranchMeta
  error?: string
  pausedAt?: string
  resumedAt?: string
  resumePrompt?: string
  sessionMessages?: SessionMessage[]
  pauseEntryId?: string
  loopIteration?: number[]
  loopMeta?: BranchMeta
  retryHistory?: RetryRecord[]
  parentSessionId?: string
}
```

#### StageInfo

```typescript
interface StageInfo {
  id: string
  name: string
  status: 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'
}
```

#### StepStatus

```typescript
type StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'
```

#### StageContract

```typescript
interface StageContract {
  stageId: string
  stageName: string
  status: StepStatus
  artifacts: Array<{
    stepId: string
    outputToId: string
    files: string[]
    returnPrompt?: string
  }>
  passThroughVars: Record<string, {
    value: string
    description: string
    refresh?: boolean
  }>
  contractArtifacts: Record<string, string[]>
  completedAt: string
  errorDetail?: string
}
```

#### PendingQuestion

```typescript
interface PendingQuestion {
  stepId: string
  sessionId: string
  requestId: string
  questions: AskUserQuestionPayload
}
```

#### AskUserQuestionPayload

```typescript
interface AskUserQuestionPayload {
  questions: Array<{
    id: string
    question: string
    header?: string
    options?: Array<{
      label: string
      description?: string
    }>
    multi_select?: boolean
  }>
}
```

#### PendingPermission

```typescript
interface PendingPermission {
  stepId: string
  sessionId: string
  requestId: string
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  tool?: string
}
```

#### DagResultInfo

```typescript
interface DagResultInfo {
  taskId: string
  jobId: string
  status: 'completed' | 'failed' | 'aborted'
  error?: string
}
```

---

## 6. Client 端设计

### 6.1 Slot 注册

`ui` 的 Client 插件 `apply(ctx)` 注册两个 slot：

```typescript
// packages/sandore/ui/src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkflowButton } from './client/WorkflowButton.tsx'

export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: Context): void {
  // 工作流入口按钮（sidebar.footer.action，位于设置上方）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sandore-btn',
    inject: () => ({ /* 面板开关状态（自包含） */ }),
  }, WorkflowButton))  // 点击展开 WorkflowPanel
}
```

**决策 D6（工作流管理 UI 入口，经探索收敛）**：入口是 **`sidebar.footer.action` 按钮 + 点击展开仿 workspace 风格的 WorkflowPanel**（设置上方）。纯插件约束下放弃了「常驻 sidebar 分组」（需改 ui-sidebar），也放弃了「conversation.view tab 为主入口」；完整交互（编排/新增/三态/分组）在展开面板内实现；无跨 scope 联动难点（面板开关是插件自有 client 状态，参考 ui-cordis 的 footer 按钮 + 展开 CordisPanel）。

### 6.2 Task 1 最小 UI

#### WorkflowButton + WorkflowPanel（占位）

```tsx
// packages/sandore/ui/src/client/WorkflowButton.tsx
export function WorkflowButton() {
  return (
    <button onClick={() => { /* 展开 WorkflowPanel（占位） */ }}>
      Workflow
    </button>
  )
}

// packages/sandore/ui/src/client/WorkflowPanel.tsx（占位）
export function WorkflowPanel() {
  return (
    <div>
      <h2>Workflow Panel</h2>
      <p>Task 1: header(编排/新增) + 三态列表占位（仿 workspace 风格）</p>
    </div>
  )
}
```

---

## 7. 挂载与集成

### 7.1 静态组合（生产）

在目标 Web 组合的 `cordis.yml`（或 agent preset）中插入插件行：

```yaml
- insert:
    - id: workflow
      name: '@deepseek-ai/dsh-sandore-workflow'
      config:
        defaultTimeoutMs: 7200000
        # 注：无 permissionMode 配置（权限修正后废弃——权限由宿主 Session 的
        # permission preset 决定，Step 子代理继承父级）
    - id: microflow
      name: '@deepseek-ai/dsh-sandore-microflow'
    - id: tool
      name: '@deepseek-ai/dsh-sandore-tool'
    - id: ui
      name: '@deepseek-ai/dsh-client-ui-sandore'
```

### 7.2 原型验证（动态插件）

Task 1 使用 DSH 的**动态 Cordis 插件**机制（`cordis_define`/`cordis_run`）做快速原型：

1. 定义 Host 半（`ctx.sandoreEngine` 的桩实现 + `harness.handle` RPC）
2. 定义 Client 半（`sidebar.footer.action` 按钮 + 展开 WorkflowPanel）
3. 验证 slot 注入与 RPC 链路

### 7.3 依赖注入清单

Task 1 桩实现的 `inject`：

```typescript
class SandoreEngineStub extends SandoreEngine {
  static inject = [
    'sessions',           // 会话管理
    'sessionPersistence', // 会话持久化
    'subagents',          // 子代理
    'llm',                // 模型推理
    'shell',              // Shell 执行
    'fs',                 // 文件操作
    'storageDomain',      // 存储域
  ]
  // 可选（用 ctx.get() 软依赖）：
  //   ctx.subprocess —— shell Step 需 stdin 注入/流式/终端时
  //   ctx.sandbox    —— 需要显式沙箱约束时
}
```

---

## 8. 验证标准

Task 1 完成后，需要验证以下内容：

### 8.1 脚手架验证

- [ ] `packages/sandore/workflow/` 目录结构正确
- [ ] `packages/sandore/microflow/` 目录结构正确
- [ ] `packages/sandore/tool/` 目录结构正确
- [ ] `packages/sandore/ui/` 目录结构正确
- [ ] 各包的 `package.json` 声明正确（ESM、peerDependencies、dsh.client 等）

### 8.2 Service Definition 验证

- [ ] `ctx.sandoreEngine` 抽象类定义正确
- [ ] `sandore/*` 事件声明正确
- [ ] 类型定义完整（DagRunInfo、DagStartRequest、DagRun 等）

### 8.3 Slot 注入验证

- [ ] `sidebar.footer.action` 按钮可显示（设置上方）
- [ ] 点击按钮展开 WorkflowPanel
- [ ] 面板开关状态正常（自包含 client 状态）

### 8.4 Host RPC 验证

- [ ] `host.call('sandore.ping')` 往返 JSON 正常
- [ ] 返回桩数据（非真实引擎状态）

### 8.5 动态插件验证

- [ ] 使用 `cordis_define` 定义 Host + Client 插件
- [ ] 使用 `cordis_run` 激活插件
- [ ] 验证 Slot 注入与 RPC 链路

---

## 9. 关键设计决策汇总

| 编号 | 决策 | 说明 |
|---|---|---|
| D1 | 新引擎用 `ctx.sandoreEngine` + `sandore/*` 事件 | 不扩展 `ctx.workflowEngine`，避免语义冲突 |
| D2 | Service 层只暴露实例级操作 | 定义/Job CRUD + 讨论/产物查询放 Host RPC 层 |
| D3 | Step 会话用 `ctx.subagents.startContinuable()` | 支持 followup/interrupt/resume；临时推理用 `ctx.llm.stream()` |
| D4 | `work.json` 用 `ctx.storageDomain` 的 `state` 表；`chat.json` 用 Session 事件日志；SQLite 两张表 + YAML 定义文件 + jobs.json 迁入 `definitions`/`jobs` 表 | schema 验证 KV + 事件溯源 |
| D5 | 事件/SSE 全用 DSH，零自建 | 删除 WorkflowEventBus/WorkflowSseManager/SdkSseManager |
| D6 | 工作流管理 UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方，仿 workspace 风格） | 纯插件约束（不改 ui-sidebar）；放弃常驻分组与 conversation.view tab；无跨 scope 联动 |
| D7 | 前端复用 DSH 组件与设计语言 | ui-primitives/theme/locale/消息渲染/交互卡片 |
| D8 | 讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制 | 每个 Step 折叠为一个 `sandore-step` 节点（ConversationNodeDefinition + conversation.chat.node keyed），内联最后结果消息，点击跳转子对话页 |
| D9 | 主代理 = 工作流编排器，身份不切换 | 「默认挂载会话」= 宿主 Session 自然延续（无需 DefaultSessionManager）；广播恢复改为「自然语言 → 主代理显式调用 sandore_* 工具」 |

---

## 10. 参考文档

- [dsh-workflow.md](../../engine/dsh-workflow.md)：插件化设计
- [dynamic-workflow-engine.md](../../engine/dynamic-workflow-engine.md)：引擎规格
- DSH Slot 系统：`packages/client/ui-layout`
- DSH Slot 注册范例：`packages/client/ui-trajectory`、`packages/client/ui-settings`
- DSH Service Definition 范例：`packages/workflow/workflow/src/index.ts`

---

## 附录 A：V2.6 核心概念速查

### Stage 即独立可抽象节点

- Stage 从"Step 的逻辑分组容器"升维为**独立可抽象的执行节点**
- Stage 对外只暴露**产物契约（StageContract）**
- Stage 间流转与 Stage 内部执行彻底解耦
- 为 V3 引擎（MASE）的**微流程 = 一个 Stage**复用做架构准备

### 收尾过程拆分

- **Finalize 第 1 部分 — FinalizeAssessor**：fork 会话完成判定 + 透传变量提取
- **Finalize 第 2 部分 — GateEvaluator**：独立新 session 门禁审查
- 两部分职责单一，可独立重试

### 默认挂载会话

- 工作流执行完成（终态 `completed` 或 `failed`）后，自动为该 instance 挂载一个**默认会话**
- 每 instance 独立，生命周期与 instance 绑定
- 用户可在其上继续输入执行其他任务

### DagNodeRef — 统一节点视图

```typescript
interface DagNodeRef {
  kind: 'stage' | 'step'
  stage: WorkflowStage       // 始终可用
  step?: WorkflowStep        // 仅 kind='step'
  id: string                 // nodeId
  name: string
  next?: string
  condition?: CommandConfig
  branches?: DagBranch[]
  loop?: DagLoop
}
```

Stage 和 Step 在 DAG 调度层面没有本质区别——都有 `next`/`condition`/`branches`/`loop`。统一为 `DagNodeRef` 后，`resolveNextNodes()` 不需要区分节点类型，简化了调度逻辑。

---

## 附录 B：DSH 基础设施 API 速查

| Service（ctx key） | 核心方法 | 用途 |
|---|---|---|
| `ctx.llm` | `stream(options)` / `prepareCall()` / `listProviders()` / `listModels()` | 模型推理（分支/finalize 临时会话） |
| `ctx.subagents` | `startContinuable(spec)` / `start(name, req)` / `followup()` / `interrupt()` | 可续接子代理（Step 执行）+ 一次性子代理 |
| `ctx.sessions` | `create(id, {seed})` / `append` / `flush` / `list` | Session 事件日志（chat.json 替代） |
| `ctx.sessionPersistence` | `create` / `append` / `load` / `inspect` | 会话持久化（崩溃恢复） |
| `ctx.storageDomain` | `open(spec)` → schema 验证 KV | work.json 状态快照 |
| `ctx.shell` | `resolve(request)` / `run(spec)` / `get sandboxMode()` | Shell 执行（高层 `bash -c`） |
| `ctx.subprocess` | `resolveExecutable()` / `spawn()` / `spawnTerminal()` | 底层进程（stdin 注入/流式/终端） |
| `ctx.fs` | `readText` / `writeText` / `editText` / `listDir` / `stat` | 产物/文件 |
| `ctx.sandbox` | `confine(argv, policy)` | 沙箱约束 |
| `ctx.sessionProjections` | `register(unit)` | 前端状态推送 |
| `ctx.agents` | `create()` / `resume()` / `get(id)` | 底层 agent 工厂 |

---

## 附录 C：关键文件对照（sandore → DSH）

| sandore（设计文档中的模块） | DSH 落点 |
|---|---|
| `engine/internal/engine/workflow-engine-v2.ts` | `packages/sandore/workflow/src/workflow-engine-v2.ts` |
| `engine/internal/engine/stage-executor.ts`（v2.6） | 同包 `stage-executor.ts` |
| `engine/internal/engine/workflow-step.ts` | 同包 `workflow-step.ts`（改用 ctx.subagents/ctx.shell/ctx.subprocess） |
| `engine/internal/engine/branch-evaluator.ts` | 同包 `branch-evaluator.ts`（改用 ctx.llm） |
| `engine/internal/engine/workflow-finalize-manager.ts` | 同包 `finalize-manager.ts`（FinalizeAssessor/GateEvaluator） |
| `engine/internal/engine/state-persistence.ts` | 同包 `persistence.ts`（存储域 + Session 事件） |
| `engine/internal/sdk/*`（@codeagent/sdk 封装） | 删除，改用 ctx.subagents/ctx.llm/ctx.shell/ctx.subprocess/ctx.fs |
| `engine/api/*` + `server/express/*` | `packages/sandore/workflow/`（Remote/RPC） |
| `client/src/*`（React 前端） | `packages/sandore/ui/`（Client 插件） |

---

> **版本**: 0.1.0 | **状态**: 设计草案 | **最后更新**: 2025-07-20
