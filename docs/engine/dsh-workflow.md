# 工作流引擎 DSH 插件化设计（dsh-workflow）

> 版本: 0.1.0 | 状态: 设计草案 | 最后更新: 2025-07-20
> 前置文档: [dynamic-workflow-engine.md](dynamic-workflow-engine.md)（引擎 v2.6）、[MASE.md](MASE.md)（引擎 v3 演进）

## 目录

1. [目标与范围](#1-目标与范围)
2. [现状与关键发现](#2-现状与关键发现)
3. [DSH 插件机制速览](#3-dsh-插件机制速览)
4. [总体架构设计](#4-总体架构设计)
5. [Host 端设计](#5-host-端设计)
6. [Client 端设计](#6-client-端设计)
7. [数据流与 RPC](#7-数据流与-rpc)
8. [挂载与集成](#8-挂载与集成)
9. [分阶段实施计划](#9-分阶段实施计划)
10. [风险与设计决策](#10-风险与设计决策)
11. [与 V3（MASE）的衔接](#11-与-v3mase的衔接)

---

## 1. 目标与范围

### 1.1 目标

把 sandore 的 **DAG 工作流引擎 v2.6**（`engine` + `server` + `client` 三部分）开发为 **DeepSeek Harness（DSH）** 的一个持久化插件，最终效果：

- 在 DSH Web 界面**左侧活动栏**出现一个「工作流」按钮；
- 点击后，**编辑区（主内容区）**切换到工作流 UI，包含：
  - **工作流编排器**（DAG 可视化编辑，Stage/Step 定义）；
  - **工作流列表**（定义 CRUD、Job/实例列表）；
  - **执行页面**（实例运行时监控、讨论面板、产物、暂停/恢复/重试）。

> 即把原 sandore 的 React 前端（`client/`）+ Express 后端（`server/`）+ 引擎（`engine/internal/engine/`）整体「内嵌」为 DSH 的一个能力插件，复用 DSH 的会话、Shell、文件、模型、事件等基础设施。

### 1.2 范围边界

| 在范围内 | 不在范围内（本轮） |
|---|---|
| 引擎核心（Stage/Step DAG 执行）移植为 DSH Host Service | V3/MASE 的 Router/Telecom/信誉/自进化等（见 §11） |
| 工作流定义/Job/实例的 CRUD API | 独立 Express 服务器（改为 DSH Host RPC + 存储域） |
| 工作流编排器 + 列表 + 执行页 UI（Client 插件） | 原 sandore 前端的技术栈（React Flow 等）的完整复刻 |
| 暂停/恢复/重试、透传变量、门禁、循环、断点续传 | **任何外部 Agent SDK（`@codeagent/sdk` 等）的引入** |
| 默认挂载会话（v2.6 新增） | 跨实例共享的默认会话（仍为每 instance 独立） |

### 1.3 核心硬约束：零外部 Agent SDK，全用 DSH 组件

> **这是本设计的最高优先级约束**。原 sandore 引擎的 `engine/internal/sdk/` 层封装了 `@codeagent/sdk`（含 client/session/sse-manager/utils 四个文件）。移植到 DSH 时，**这层 SDK 封装整体删除，不允许在引擎里引入任何 `@codeagent/sdk` 依赖**——所有 AI 会话、Shell 命令、文件读写、模型推理、事件流/SSE、会话持久化、权限模式、问答、临时会话、fork/revert、子代理追踪等能力，**全部改由 DSH 自身的组件（Cordis 服务 + 交互 seam + apiproxy）实现**。

理由：

1. **单一运行时**：DSH 本身就是 agent harness，已具备 `ctx.agents`/`ctx.subagents`/`ctx.llm`/`ctx.shell`/`ctx.fs` 等完整能力；再引一个 `@codeagent/sdk` 会形成「套娃」——在一个 agent 运行时里跑另一个 agent SDK。
2. **权限/沙箱/审计统一**：DSH 的权限模式（`packages/interaction`）、沙箱（`ctx.sandbox`）、事件溯源 Session（`ctx.sessions`）是产品级的一体化设计；用外部 SDK 会绕过这套治理。
3. **会话模型一致**：`@codeagent/sdk` 与 DSH 的 Session 事件模型是两套语义，混用会导致暂停/恢复/崩溃恢复语义不一致。
4. **可维护性**：DSH 的 `workflow` 子系统（脚本编排）已示范「引擎不直接依赖外部 SDK，而是复用 `ctx.subagents`」的正确模式。

完整映射见 [§5.3A SDK 能力全量映射](#53a-sdk-能力全量映射零-codeagent-sdk-依赖)。

### 1.4 核心硬约束：纯插件分发，不改 DSH 源码

> **这是与 §1.3 并列的最高优先级约束**。本插件最终要**分发给其他 DSH web 用户使用**，因此必须是**纯插件、自包含、零 DSH 源码修改**：

1. **不改任何 DSH shell 包**：`ui-sidebar`/`ui-layout`/`ui-conversation`/`ui-workspace` 等一律不动。后果：**无法在 sidebar 里新增常驻分组**（sidebar 子 slot 由 `ui-sidebar` 声明并渲染，"声明即独占"），工作流 UI 入口只能是 **`sidebar.footer.action` 按钮 + 点击展开面板**（该 slot 位于工作区下方、设置上方，是纯插件能插入的最优位置，见 §6.1 / 决策 D6）。
2. **只复用 DSH 公开扩展点**：`ctx.*` 服务、Slot、事件、`ui-primitives`/theme/locale/标准 hook。DSH 内部私有的组件（如 `ui-workspace` 的 header、分组逻辑）**不可 import，照着风格用 `ui-primitives` 自绘**（AGENTS.md：UI 能复用就复用，不能复用就照着风格做成一模一样）。
3. **插件自包含**：所有代码、资源、i18n 都在 `packages/sandore/` 包内，通过 `cordis.yml` 静态组合或 agent preset 挂载即可运行，无编译期/运行期对 DSH 仓库的侵入。

---


## 2. 现状与关键发现

### 2.1 sandore 引擎现状

- 本仓库（`D:\project-code\llm\sandore`）中**只有设计文档**：`docs/engine/dynamic-workflow-engine.md`（已升级至 v2.6）、`docs/engine/MASE.md`（v3 演进）。
- `packages/` 目录为空，`furina/` 仅含 `archive/`（历史归档）与 `changes/`，**引擎源码不在本仓库**。因此本次开发需**按设计文档重新实现**引擎（或从外部移植），而非直接改造现有源码。
- 引擎 v2.6 的三大新增能力（见前置文档）：
  1. **Stage 即独立可抽象节点**（`StageExecutor` + `StageContract`，为 V3 微流程复用铺路）；
  2. **收尾拆分**（`FinalizeAssessor` fork 会话 + `GateEvaluator` 独立 session）；
  3. **默认挂载会话**（`DefaultSessionManager`，每 instance 独立）。

### 2.2 DSH 已有 workflow 子系统（重要）

DSH 已有一个 `workflow` capability family（`packages/workflow/`）：

| 包 | 角色 | ctx key |
|---|---|---|
| `workflow/workflow` | Service Definition | `ctx.workflowEngine` |
| `workflow/workflow-worker-thread` | Service Provider（worker 线程） | 注册在 `ctx.workflowEngine` |
| `workflow/tool-workflow` | Consumer（模型工具） | 注册在 `ctx.tools` |
| `workflow/tool-ralph` | Consumer（固定 Ralph 工具） | 注册在 `ctx.tools` |
| `client/ui-workflow-run` | 前端（Chat 中的 run 面板） | Client Slot |

**关键结论**：DSH 的 workflow 是「**模型编写的 JS 编排脚本**」——LLM 写一段 JavaScript（`agent()`/`parallel()`/`pipeline()`），由 worker 线程执行并编排子代理。它与 sandore 的「**声明式 DAG 工作流引擎**」（Stage/Step DAG + YAML 定义）**在概念上几乎没有重叠**：

| 维度 | DSH workflow | sandore 2.5/2.6 DAG 引擎 |
|---|---|---|
| 核心范式 | 模型编写 JS 编排脚本 | 声明式 Stage/Step DAG |
| 定义格式 | JS script + JSON meta | YAML |
| 持久化 | Cordis Session 事件 | work.json + chat.json |
| UI | Chat 内 run 面板 | 独立 React 编辑器 |
| 变量透传/门禁 | 无 | 有 |

### 2.3 命名冲突与决策

DSH 已占用 `ctx.workflowEngine`、`workflow/*` 事件、`tool-workflow` 工具名。为避免冲突，新引擎使用**独立命名空间**：

| 概念 | sandore 引擎命名 | DSH 中建议命名 |
|---|---|---|
| 引擎 Service | `WorkflowEngineV2` | `ctx.sandoreEngine`（`SandoreEngine`） |
| 事件前缀 | `workflow.*` | `sandore/*` |
| 模型工具（可选） | — | `sandore_*`（主代理编排器工具） |
| 包名 | `@optix/workflow-engine` | `@deepseek-ai/dsh-sandore-workflow` |
| 前端包 | — | `@deepseek-ai/dsh-client-ui-sandore` |

> **决策 D1**：新引擎不扩展 `ctx.workflowEngine`（其接口为「脚本编排」设计），而是新开一个 `ctx.sandoreEngine` Service，避免语义冲突。

---

## 3. DSH 插件机制速览

> 本节提炼自对 `D:\project-code\llm\deepseek-harness` 的实地调查，作为后续设计的依据。

### 3.1 Cordis 插件模型

- DSH 基于 vendored **Cordis** DI 框架，「一切皆插件」。插件有三种形态：函数、类、`{ apply }` 对象；`apply(ctx)` 是入口，`ctx` 提供 `get()`（可选依赖）、`inject`（硬依赖）、`effect()`（可逆副作用）、`on()`（事件订阅）。
- 一个**能力 seam（capability seam）** 由三部分组成，缺一不可：
  1. **Service Definition**（抽象类，定义接口 + 事件）；
  2. **Service Provider**（具体实现，注册为 `ctx.<key>`）；
  3. **Consumer**（工具 / UI / 其他插件，消费该服务）。
- 关键约定：ESM 全量（`"type": "module"`）、包名 `@deepseek-ai/dsh-<name>`、`@deepseek-ai/cordis` 为 peerDependency、注册都是 effect（`register()` 返回 disposer）、类型化事件用 declaration merging。

### 3.2 Host 插件与 Client 插件

- **Host 插件**：运行在 DSH Node 进程，`apply(ctx)` 里 `ctx.reflect.provide('key', service)` 提供服务、`ctx.on(...)` 订阅事件、注册模型工具。源码在 `packages/<group>/<pkg>/src/`。
- **Client 插件**：运行在浏览器页。一个包通过 package.json 声明 `dsh.client`（`platform: 'web'`，可选 `inject` 边、`immediately`）+ `exports["./client"]` 导出构建产物，由 `ctx.clientModules`（`ClientModuleRegistry`）扫描并组合进 `window.__DSH_BOOT__`，浏览器侧 `ctx.modules` 拉取并物化 bundle。
- 一个包可**同时**提供 Host 半（`src/`）和 Client 半（`src/client/` 或独立 `client.js` bundle）。

### 3.3 挂载方式

- **静态组合**：在某个 `cordis.yml`（host 组合或 agent preset）中添加一行 `{ id, name: '@deepseek-ai/dsh-xxx', config? }`，由 Loader 在 boot 时加载。这是持久化插件的标准方式。
- **动态插件**（`ctx.dynamicCordisRunner` / `cordis_define`/`cordis_run` 工具）是「模型自我修改运行时」的临时机制，**不适合**作为工作流引擎这类持久能力的载体（但可用于原型验证）。

### 3.4 Slot 系统（Client UI 注入）

DSH 前端是**三栏布局**（`packages/client/ui-layout`），顶级 slot 由 `ui-layout` 在 `root` 上声明：

```
root
├── sidebar            (single, root scope)   —— 整条左栏，被 ui-sidebar 占据
│   ├── sidebar.workspaces  (single)          —— 工作区/会话浏览
│   ├── sidebar.settings    (single)          —— 底部设置位
│   └── sidebar.footer.action (list)          —— 底部附加动作（活动栏入口）★
├── conversation       (single, session-maybe)—— 整条中栏，被 ui-conversation 占据
│   └── conversation.session (single, session) —— 会话体
│       └── conversation.view (list, session)  —— 视图 tab（Chat/Trajectory）★
├── details            (single, session scope) —— 右栏
└── shell.overlay      (list, root scope)     —— 全帧浮层
```

> 注：`conversation.view` 实际由 `conversation.session`（`ConversationSession`）声明，视图切换由 `ChatStoreState.view` + `actions.setView(id)` 驱动，`only: active.id` 只渲染活动视图。

与本需求相关的 slot（D6 收敛后）：

1. **`sidebar.footer.action`**（list，root scope）：侧边栏底部的附加动作位，**可加性（additive）**——注册一个 `id: 'sandore-btn'` 即可新增按钮，不替换现有内容。这就是「工作流管理 UI 入口」的落点（D6）。
2. **`conversation.view`**（list，session scope）：会话中栏的**视图 tab**，现有 `Chat` 与 `Trajectory` 两个 tab。**曾**考虑注册 `id: 'workflow'` 作为「编辑区视图」落点，但 D6 收敛后放弃（管理 UI 应全局、不挂某个 session）；保留此处仅作 slot 能力记录。

> 参考实现：`packages/client/ui-trajectory/src/client/index.ts`（`conversation.view` 注册范式）、`packages/client/ui-settings`（`sidebar.settings`/`sidebar.footer.action` 注册范式）。

---

## 4. 总体架构设计

### 4.1 三层分离（对齐 DSH capability seam）

把 sandore 的「引擎 + server + client」映射为 DSH 的 **Service Definition / Provider / Consumer** 三层 + 一个 Client UI 插件：

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
│  ├── @deepseek-ai/dsh-sandore-workflow (seam + Stage 编排引擎)      │
│  │     抽象契约 + 类型/事件 + WorkflowEngineV2（Stage 间 DAG 编排）  │
│  │     + 实例级生命周期（暂停/恢复/重试/崩溃恢复/交互/宿主主代理）  │
│  │     + @Remote RPC（定义/Job/实例 CRUD、讨论、产物、交互）        │
│  ├── @deepseek-ai/dsh-sandore-microflow (Stage 内部执行)            │
│  │     StageExecutor + StepRunner + BranchEvaluator + Finalize + Loop │
│  ├── @deepseek-ai/dsh-sandore-tool (Consumer: 模型工具)             │
│  │     sandore_* 工具（主代理编排器，agents.create({setup}) 注册）   │
│  └── ctx.sandoreEngine（workflow 包提供的 Service）                 │
└─────────────────────────────────────────────────────────────────────┘
                                    │ 复用 DSH Host 服务
┌─────────────────────────────────────────────────────────────────────┐
│  DSH 基础设施（复用，不重造）                                       │
│  ctx.agents / ctx.sessions / ctx.llm / ctx.shell / ctx.fs           │
│  ctx.subagents / ctx.sessionPersistence / ctx.storageDomain         │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 包结构

按 DSH 仓库布局（`packages/<group>/<pkg>/`），建议新建一个 capability 组 `packages/sandore/`：

```
packages/sandore/                      ← 插件 sandore（顶层 group，唯一带 sandore 的目录）
│
├── workflow/                          # ① seam 定义 + Stage 编排引擎 + @Remote RPC
│   ├── package.json                   # name: @deepseek-ai/dsh-sandore-workflow
│   └── src/
│       ├── index.ts                   # 抽象契约 + 事件声明（SessionEventMap + Cordis Events）
│       ├── types.ts                   # WorkflowDefinition/Stage/Step/StageContract 类型（纯类型）
│       ├── runtime-types.ts           # DagRun / DagStartRequest / DagResult
│       ├── workflow-engine.ts         # WorkflowEngineV2：Stage 间 DAG 编排（调用 microflow 的 StageExecutor）
│       ├── dag-navigator.ts           # DAG 导航 + StageContract + tryAdvanceStage
│       ├── lifecycle-manager.ts       # 实例级：暂停/恢复/中止 + 暂停登记表
│       ├── interaction-manager.ts     # 实例级：交互（问答/权限/askUserQuestion）
│       ├── recovery-manager.ts        # 实例级：崩溃恢复 + 孤儿实例扫描
│       ├── host-agent.ts              # 宿主主代理（编排器工具面 + 自然降级）
│       ├── persistence.ts             # work.json/chat.json → 存储域 + Session 事件
│       └── remote.ts                  # @Remote RPC（定义/Job/实例 CRUD、讨论、产物、交互）
│
├── microflow/                         # ② Stage 内部执行（v3 微流程核心，可独立复用）
│   ├── package.json                   # name: @deepseek-ai/dsh-sandore-microflow
│   └── src/
│       ├── index.ts                   # export StageExecutor
│       ├── stage-executor.ts          # StageExecutor（执行 Stage 内部 Step DAG）
│       ├── step-runner.ts             # Step 执行器（五种 Command）
│       ├── step-execution.ts          # executeStepNode + runPostStepPipeline（单 Step 编排）
│       ├── branch-evaluator.ts        # 分支/循环评估（ctx.llm）
│       ├── finalize-manager.ts        # FinalizeAssessor + GateEvaluator
│       └── loop-manager.ts            # 循环管理（扁平化/ID后缀/跳出检测）
│
├── tool/                              # ③ 模型工具（主代理编排器）
│   ├── package.json                   # name: @deepseek-ai/dsh-sandore-tool
│   └── src/index.ts                   # sandore_* 工具（agents.create({setup}) 注册）
│
└── ui/                                # ④ 前端
    ├── package.json                   # name: @deepseek-ai/dsh-client-ui-sandore（dsh.client）
    └── src/
        ├── index.ts                   # apply(ctx)（Host 空壳）
        └── client/
            ├── WorkflowButton.tsx     # footer 按钮（设置上方）
            ├── WorkflowPanel.tsx      # 展开面板（编排/新增/三态列表）
            ├── InstanceList.tsx       # 实例列表（按工作区分组）
            ├── DefinitionList.tsx     # 定义列表
            ├── DagEditor.tsx          # 编排器
            ├── RunView.tsx            # 执行详情
            └── SandoreStepNodeView.tsx # 讨论节点（conversation.chat.node keyed）
```

> **依赖关系**：运行时单向 `workflow → microflow`（workflow 调 StageExecutor 执行 Stage）；`microflow → workflow` 仅 `import type` 类型依赖（编译期擦除，打破循环）。`tool`/`ui` 依赖 `workflow`。
>
> **v3 扩展性**：`microflow` 独立 = v3 微流程（Router 直接 import StageExecutor，不依赖 workflow 编排）；`workflow` = v3 流程组绑定编排层；v3 新增 Router/Telecom/信誉/审计 → `packages/sandore/` 下新增包。
>
> 说明：`ui` 的 client bundle 遵循 DSH 约定——package.json 声明 `dsh.client`、`exports["./client"]` 指向构建产物；`tsdown.client.ts`（或等价配置）产出浏览器 bundle。

### 4.3 引擎三部分到 DSH 的映射总表

| sandore v2.6 组成 | 职责 | DSH 落点 | 关键映射 |
|---|---|---|---|
| `engine/internal/engine/`（WorkflowEngineV2 + Stage 编排相关子管理器） | Stage 间 DAG 编排 + 实例级生命周期 | `workflow` 包（`dsh-sandore-workflow`） | 核心编排逻辑保留，底层 SDK 调用替换为 DSH 服务 |
| `engine/internal/engine/`（StageExecutor + Step 执行相关子管理器） | Stage 内部 Step DAG 执行 | `microflow` 包（`dsh-sandore-microflow`） | v3 微流程复用核心；运行时 `workflow → microflow` |
| `engine/internal/sdk/`（@codeagent/sdk 封装） | AI 会话/SSE/临时会话 | **删除**，改用 `ctx.agents`/`ctx.llm`/`ctx.subagents` | Step 会话 = 子 agent；临时会话 = `ctx.llm.stream()` |
| `engine/api/` + `server/express/` | REST API + Express 路由 | `workflow` 包的 `@Remote` RPC（`remote.ts`） | 不移植 Express，改为 `@Remote` 装饰器注册在 workflow 包内（DSH 惯例，无独立 api 包） |
| `client/`（React 编辑器 + 运行时视图） | 前端 UI | `ui`（Client 插件） | Slot 注入 + `host.call()` |
| SQLite（`harness_workflows` + `harness_workflow_jobs` 表）+ YAML 定义文件 + jobs.json 实例索引 | 定义/Job 元数据持久化 | DSH 存储域 `definitions`/`jobs` 表 | 见 §5.4（D4） |
| `work.json` / `chat.json` | 实例状态 + 讨论持久化 | DSH 存储域 `state` 表 / Session 事件 | 见 §5.4（D4） |

---

## 5. Host 端设计

### 5.1 Service Definition（`ctx.sandoreEngine`）

仿照 `packages/workflow/workflow/src/index.ts` 的写法，定义抽象 seam：

```ts
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
    // （D9 修正：无 default-session-mounted 事件——宿主 Session 自然延续为自由对话，不额外挂载）
  }
}

export abstract class SandoreEngine extends Service {
  constructor(ctx: Context) { super(ctx, 'sandoreEngine') }

  // 实例生命周期（对齐原 engine.execute/recover/abort + api/instances）
  abstract startInstance(request: DagStartRequest): DagRun
  abstract recoverInstance(instanceId: string): Promise<DagRun>
  abstract abortInstance(instanceId: string): Promise<void>
  // 交互（对齐原 interactionManager）
  abstract replyQuestion(instanceId: string, requestId: string, answers: unknown): Promise<void>
  abstract replyPermission(instanceId: string, requestId: string, reply: 'once'|'always'|'reject'): Promise<void>
  // 暂停/恢复/重试（对齐原 lifecycleManager + retryFromStep）
  abstract pauseStep(instanceId: string, stepId: string): Promise<void>
  abstract resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>
  abstract pauseAllSteps(instanceId: string): Promise<void>       // 全局暂停
  abstract resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>  // 广播恢复所有暂停 Step
  abstract retryStep(instanceId: string, stepId: string, mode: 'continue'|'revert'|'fork', message: string): Promise<void>
  // 状态查询
  abstract getState(instanceId: string): DagInstanceState
}
```

> **决策 D2**：Service 层只暴露「实例级」操作（start/recover/abort/reply/pause/resume/retry/getState），工作流定义/Job 的 CRUD 与「实例的持久化文件/讨论/产物」查询放在 `workflow`（Host RPC 层），避免 Service 接口臃肿，也便于 Client 通过 RPC 访问。

### 5.1A 主代理 = 工作流编排器（模型工具面）

> **核心设计**（解决「主代理抢占广播恢复消息」的矛盾）：迁移后「工作流宿主 Session」是**真正可对话的主代理**，用户在主对话发消息会触发主代理的一轮 agent loop。为避免消息被主代理当闲聊处理而丢失「广播恢复」语义，主代理被设计为**编排器**——它持有一组工作流控制**模型工具**，用户自然语言意图 → 主代理 agent loop → 调用工具。原 sandore 的「发消息 = 隐式广播恢复」被替换为「自然语言 → 主代理显式调用 `resumeAllPaused`/`resumeStep` 等工具」。

**工具清单**（`tool` Consumer 包注册到 `ctx.tools`，供主代理调用）：

| 工具名 | 参数 | 功能 | 对应原 sandore 交互 |
|---|---|---|---|
| `sandore_getState` | `instanceId` | 查看执行状态（Stage/Step/executedSteps） | 前端轮询 getInstanceState |
| `sandore_startInstance` | `jobId, originalInput, cwd?` | 启动新工作流实例 | 执行 Job |
| `sandore_abortInstance` | `instanceId` | 中止工作流 | abort |
| `sandore_pauseStep` | `instanceId, stepId` | 暂停某 Step | `@Step` + pause |
| `sandore_resumeStep` | `instanceId, stepId, prompt?` | 定向恢复某 Step（prompt 作为 resumePrompt） | `@Step` 定向恢复 |
| `sandore_pauseAllSteps` | `instanceId` | 暂停所有运行中 Step | 全局暂停 |
| `sandore_resumeAllPaused` | `instanceId, prompt?` | 恢复所有暂停 Step（广播恢复） | 无 `@` 广播恢复「继续」 |
| `sandore_retryStep` | `instanceId, stepId, mode, message` | 重试失败 Step（continue/revert/fork） | `@Step` + 重试三模式选择器 |

**注册方式（经探索修正：per-session 注册，非 preset standing mount）**：

> **关键**：`sandore_*` 工具**不能**写进 agent preset 的 `cordis.yml` 行——那会是 standing mount（同一 preset 的多个宿主 Session 共享同一套工具实例、同一闭包，无法绑定不同 instanceId）。正确做法是**在创建宿主 Session 时，通过 `ctx.agents.create({ setup(agentCtx) })` 的 `setup` 回调里 `agentCtx.tools.register(...)`**，闭包捕获该实例的 instanceId，实现 per-session 工具绑定。

```ts
// 引擎创建「工作流宿主 Session」时（workflow 内部）
const handle = await ctx.agents.create({
  sessionId: hostSessionId,
  meta: {
    cwd,                       // ★ 必填（经探索确认：session.list 对持久化会话过滤 meta.cwd !== undefined；
                               //   无 cwd 的宿主会话在进程重启后从侧边栏消失，不可导航）
    agentPreset: 'sandore-host',  // 可选：标记宿主会话的 preset
  },
  setup(agentCtx) {
    agentCtx.systemPrompt.section({
      name: 'sandore-host', order: 116,
      text: `你正在编排工作流实例 ${instanceId}。用 sandore_* 工具控制它（查看状态/暂停/恢复/重试）。`,
    })
    // 每个工具闭包捕获 instanceId，无需模型传 instanceId 参数
    agentCtx.tools.register(defineTool({
      name: 'sandore_resumeAllPaused',
      description: '恢复该工作流实例的所有暂停 Step（广播恢复）',
      parameters: {},
      async execute(_args, exec) {
        await ctx.sandoreEngine.resumeAllSteps(instanceId)  // 闭包捕获
        return { resumed: true }
      },
    }))
    // ... 其余 7 个工具同理（getState/startInstance/abortInstance/pauseStep/resumeStep/pauseAllSteps/retryStep）
  },
})
// 创建后设标题（经探索确认：meta 无 title 字段，标题靠 session/title 事件 + projection）
ctx.sessionTitle.rename(handle.session, `工作流实例 ${instanceId}`)
```

> 备选：全局工具 + `exec.agent.id`（= SessionId）去引擎的 `Map<SessionId, instanceId>` 查 instanceId。但**首推 setup 闭包捕获**（更直接，无映射表）。

**宿主会话的 UI 可见性与导航（经探索确认）**：

- 非 subagent origin 的 `agents.create` 会话**会出现在普通侧边栏会话列表**（`ui-workspace` 只过滤 `origin === 'subagent'`），引擎无需额外动作；新会话经 `session/created` → `host/session-added` 帧自动进列表。
- **`meta.cwd` 必填**（否则重启后冷会话被 `session.list` 过滤掉）；**标题**在 `create` 后 `sessionTitle.rename` 设置。
- **blank 会话隐藏**（经探索补）：刚 `create`、还没跑过任何 turn 的宿主会话是 `blank`（日志无 `turn/start`），侧边栏**只在其为当前选中会话时可见**。所以宿主 Session 要「创建即可见」，需引擎立刻驱动第一轮 turn（第一个 Step 启动即产生 turn/start），否则仅能靠编程导航（`sessions.open`）直达。
- 用户导航到宿主会话看讨论面板：`ctx.sessions.open(hostSessionId)`（`ui-workflow-run` 的 `openSession` 同款）；管理 UI 的 RunView 提供一个「打开讨论」按钮跳转。
- **冷会话点击只读回放**（不自动 resume agent）——崩溃恢复需引擎显式 `ctx.agents.resume()`（见 task-4 §5.3）。

**关键语义**：

1. **主对话消息 = 自然语言 → 工具调用**（而非隐式广播）：用户说「继续」「让 StepA 继续做 xxx」「重试第三步，fork」→ 主代理 agent loop 理解意图 → 调 `resumeAllPaused`/`resumeStep`/`retryStep`。这比原 sandore 的「@ + 精确语法」更强、更自然。
2. **与 Step 子对话页互补**：Step 级精确控制（暂停/继续）仍走子对话页 composer 的 Stop/Send 原生路由（`subagent.interrupt`/`subagent.prompt`），主对话走「自然语言 → 编排器工具」——两条路不冲突。

**主代理身份不切换，靠「工具语义 + 实例状态」自然降级**（回答「何时编排、何时自由对话」）：

> 主代理**始终是同一个 agent**，不需要「编排器 ↔ 自由对话」的身份切换。它同时持有 `sandore_*` 工具 + 普通 agent 能力，区分角色靠**实例状态 + 工具语义自然降级**：

| 实例状态 | 工具行为 | 主对话自然角色 |
|---|---|---|
| running / interacting / paused | `pauseStep`/`resumeStep`/`retryStep` 有效 | 编排器（用户意图自然是「控制工作流」） |
| completed | `resume`/`retry` 失效（引擎返回 no-op），仅 `getState` 只读 | 自由对话（自然延续，继续其他任务） |
| failed | `retryStep` 有效 | 编排器（可重试） |

工具**不需要退场**——`resume`/`retry` 对已完成实例返回无害 no-op，`getState` 对任何状态都有意义（查历史）。工具存在 ≠ 强制使用（正如持有 shell 工具的 agent，用户不聊 shell 时就用别的能力）。

**影响隔离**（回答「是否影响非工作流会话」）：

`sandore_*` 工具**只挂在「工作流宿主 Session」这个 agent 上**（通过该 Session 的 agent preset / per-session 组合），不是全局注册：
- **DSH 普通会话**（点新建会话）：默认 preset，无 `sandore_*` 工具，完全不受影响；
- **其他工作流实例**：各自有独立宿主 Session + 独立工具实例（绑定各自 `instanceId`），互不干扰。

**instanceId 绑定**：每个工作流实例的宿主 Session 是独立 agent，`tool` 在创建该 agent 时实例化并绑定 `instanceId`（闭包捕获，或从 `exec.agent` 上下文推导），模型无需手动传错 id。

**暂停登记表（引擎自建，DSH 无 paused 状态）**：

> **关键事实**：DSH 的 Agent 只有 `idle`/`running` 两态，**没有 `paused`/`interacting` 状态**。子代理被 `interrupt()` 后变 `idle`，与「未开始/已完成」的子代理状态无法区分。因此 `resumeAllPaused`/`resumeStep` **无法靠查询 DSH 子代理状态来枚举「暂停集」**——引擎必须自己维护一份「暂停登记表」，且必须持久化（否则崩溃恢复后丢失）。

```ts
class SandoreEngine {
  // 暂停登记表：记录引擎主动 interrupt 过哪些 childId（对应原 v2.6 的 pausedStepIds[]）
  private pausedChildIds: Set<string> = new Set()

  async pauseStep(stepId) {
    const childId = this.stepToChildId(stepId)
    ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })  // 暂停
    this.pausedChildIds.add(childId)        // ① 登记
    this.persistState()                     // ② 持久化到 work.json 快照（崩溃恢复靠它）
  }

  async resumeAllSteps(resumePrompt?) {
    const content = [{ type: 'text', text: resumePrompt ?? '继续' }]
    for (const childId of [...this.pausedChildIds]) {
      await ctx.subagents.followup(hostAgent, childId, content, { source, signal })  // 恢复
      this.pausedChildIds.delete(childId)   // ③ 移除
    }
    this.persistState()
  }
}
```

- **权威性**：登记表是「哪些 Step 暂停了」的**唯一权威**。DSH 的 `agent.status === 'idle'` + `agent.inbox.hasPending` 只是辅助信号（排队中的子代理也满足此条件），不能替代登记表。
- **持久化**：`pausedChildIds` 必须写入 work.json 状态快照（`storageDomain`），崩溃恢复时恢复。
- **与 v2.6 的关系**：它就是原 `WorkflowTaskState.pausedStepIds[]` 字段，迁移到 DSH 后从「辅助记录」升级为「唯一权威」（因为 DSH 子代理无 paused 状态）。

**「默认挂载会话」的修正**：引入「主代理 = 宿主 Session」后，v2.6 的「工作流完成后额外挂载一个新默认会话」设计**被取代**——**宿主 Session 本身在 `completed` 后自然从编排器降级为自由对话 agent，它就是那个"默认挂载会话"**。全程同一个 Session，无需切换、无需挂载新会话、无需「组合 chat.json 消息为 parts 注入」（宿主 Session 的日志天然就是工作流历史 + 后续对话）。这也彻底解决了「默认挂载会话抢占广播消息」的矛盾。

> **与 Host RPC 的区别**：`tool`（模型工具，供主代理 agent loop 调用）与 `workflow`（Host RPC，供前端 Client 调用）是**两个不同的消费方**，但底层都调 `ctx.sandoreEngine` 的同一组实例级方法。前端 UI 用 RPC，主代理用工具，各取所需。

### 5.2 引擎核心移植映射

`sandore` 引擎核心（`WorkflowEngineV2` + 9 个子管理器）整体移植为 `workflow`，但**底层依赖全部替换**：

| sandore 引擎模块 | DSH 移植要点 |
|---|---|
| `WorkflowEngineV2`（Stage 级编排 + 委托层） | 保留逻辑；`execute()` 改为 Stage 级编排（调用 `StageExecutor`）；完成后宿主 Session 自然降级为自由对话（**不再需要 DefaultSessionManager 额外挂载**，见 §5.1A） |
| `StageExecutor`（Stage 内部执行） | 直接复用，输入改为 `StageExecutionInput`（含 `contractArtifacts` + `passThroughVars`） |
| `WorkflowStepRunner`（Step 执行） | **重点改造**：Agent 会话改用 `ctx.subagents.startContinuable()`；Shell 改用 `ctx.shell.run()`/`ctx.subprocess.spawn()`；产物收集改用 `ctx.fs` |
| `BranchEvaluator`（分支/循环评估） | 临时 AI 会话改用 `ctx.llm.stream()` 或轻量子 agent |
| `WorkflowFinalizeManager`（FinalizeAssessor + GateEvaluator） | fork 会话改用 `ctx.sessions.fork(childId, boundary)`（现成 fork 原语）；门禁 session 用临时 agent（`ctx.llm.stream()`） |
| `WorkflowDagNavigator`（DAG 导航 + StageContract） | 保留逻辑，`resolveCrossStageInput()` 保留 |
| `WorkflowLoopManager` / `WorkflowRecoveryManager` / `WorkflowSseManager` / `WorkflowInteractionManager` / `WorkflowLifecycleManager` | 保留逻辑；SSE/事件改为 DSH 事件系统；交互改为 DSH 交互服务 |
| `StatePersistence`（work.json + chat.json） | **重点改造**：改为 DSH 存储域（见 §5.4） |

### 5.3 Step 执行器映射（关键）

sandore 的五种 Command 类型映射到 DSH 服务：

| Command 类型 | sandore 实现 | DSH 实现 |
|---|---|---|
| `agent`（AI Agent + 参数模板） | `@codeagent/sdk` createSession + sendChat + SSE | `ctx.agents.create({ sessionId, ... })` 创建子 agent，`send()` 发送提示词，事件经 DSH 事件系统 |
| `prompt`（纯提示词） | 同上 | `ctx.llm.stream()` 或 `ctx.agents.create()` |
| `skill`（技能调用） | SDK 技能名 | DSH `ctx.skill`（技能注册表）或保持为 prompt 前缀 |
| `mcp`（MCP 工具调用） | SDK MCP 名 | DSH `ctx.mcp`（如有）或保持为 prompt 前缀 |
| `shell`（简单命令） | `child_process.exec` | `ctx.shell.resolve()` + `ctx.shell.run()`（`bash -c`，返回 stdout/stderr 文本） |
| `shell`（需 stdin 注入/流式/终端，v2.4.2 特性） | `child_process.exec` + stdin 写入 | `ctx.subprocess.spawn()`（底层进程，支持原始 stdio/进程树/终端会话） |

> **shell Step 的 stdin 注入**：v2.4.2 的 `resolveRawInputOutputs()` 将 `inputFrom` 解析的 Step 输出 JSON 数组写入子进程 stdin。DSH 中 `ctx.shell.run()` 是高层 `bash -c`（无 stdin 注入），需改用 `ctx.subprocess.spawn()`（提供原始 stdio 流）。简单命令用 `ctx.shell.run()`，需 stdin 交互/流式输出/终端会话用 `ctx.subprocess.spawn()`。
>
> **shell Step 的沙箱**：DSH 的 shell 执行受沙箱约束（`ctx.sandbox`，`SandboxMode = 'read-only'|'workspace-write'|'danger-full-access'`；`ctx.shell.get sandboxMode()`）。工作流 Step 的 shell 命令默认走当前组合的沙箱模式，产物写入需 `workspace-write` 及以上。这与 sandore 引擎的 `permissionMode` 是正交的两个维度：`permissionMode` 控制 AI Agent 的权限自动回复，`sandboxMode` 控制 shell/fs 的系统级限制。

**Step 会话的生命周期**（对齐 DSH 可续接子代理模型）：

```
Step 开始（agent/prompt/skill/mcp 类型）
    │
    ▼
ctx.subagents.startContinuable({ ... })               // 创建可续接子代理（等价原 createSession）
    │  （parent = 工作流宿主 agent，origin: 'subagent'）
    ▼
（首条提示词随 startContinuable 投递）               // 等价原 sendChat
    │
    ▼
监听 DSH 事件（subagent/* / session/event）等待 idle  // 等价原 SSE session.idle
    │
    ▼
读取会话输出（从子代理 Session 日志派生历史）        // 等价原 readOutput
    │
    ▼ 暂停 / 恢复 / 重试
ctx.subagents.interrupt(stepSessionId, authority)    // 暂停（等价原 session.abort + 保留会话）
ctx.subagents.followup(parent, stepSessionId, ...)   // 恢复 / 重试 continue（等价原 sendChat）
ctx.agents.resume({ resumeSessionId })               // 崩溃恢复（等价原 recoverFromSession）
```

> **决策 D3**：Step 的「AI 会话」用 `ctx.subagents.startContinuable()` 创建的**可续接子代理**承载，而非临时 `ctx.llm.stream()` 调用。理由：① Step 需要完整的多轮会话（工具调用、权限、问答、暂停/恢复、崩溃恢复），可续接子代理原生支持 `followup`/`interrupt`/`reportFrom`，且带 parent 归属 + 持久化；② 权限/问答通过 DSH 的交互 seam（`packages/interaction`）自动接入；③ 崩溃恢复用 `ctx.agents.resume({ resumeSessionId })`（冷恢复可续接子代理）。
>
> 而**分支评估 / finalize 的临时 AI 会话**（一次性、只读、红线约束）用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()`，避免为临时评估创建长期会话。

### 5.3A SDK 能力全量映射（零 @codeagent/sdk 依赖）

原 sandore 引擎的 `engine/internal/sdk/` 有 4 个文件，每个能力逐一映射到 DSH 组件。**映射后 `engine/internal/sdk/` 整层删除。**

#### 5.3A.1 `client.ts`（SDK 客户端）→ 删除

| sandore `client.ts` 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| `getClient()`（TTL 缓存 + Auto-Start/Connect + 单例 Promise） | **不需要** | DSH 的 `ctx.llm`/`ctx.agents`/`ctx.subagents` 已内置 provider 路由、模型解析、适配器注册（`ctx.llm.registerAdapter`），无「连接客户端」概念 |
| `discoverBinaryPath()`（Linux 二进制发现） | **删除** | DSH 无独立 codeagent 二进制 |
| `ensureWorkspace(directory, mode)` | `ctx.fs` + workspace 服务（`ctx.workspaces`） | 工作流实例目录用 `ctx.fs` 创建 |
| `setPermissionMode`/`getPermissionMode`（bypassPermissions/acceptEdits/default） | **DSH permission presets（子代理继承父级）** | DSH 无 permissionMode 概念；Step 子代理继承工作流宿主 Session 的 permission preset（`sandbox/mode` + `approval/policy`），approval 固定 `never`；**无法 Step 级单独指定**（`ContinuableStartSpec` 无权限字段） |
| `setExternalClient`/`invalidateClient`/`connectClient` | **删除** | 无外部 SDK 客户端可注入 |

#### 5.3A.2 `session.ts`（SDK 会话）→ 替换

| sandore `session.ts` 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| `createSession()` | `ctx.subagents.startContinuable()` / `ctx.agents.create()` | Step 会话（可续接）；临时会话用一次性子代理或 `ctx.llm.stream()` |
| `sendChat()`（fire-and-forget） | `ctx.subagents.followup()` / `agent.send()` | 发送消息 |
| `subscribeEvents()`（目录级 SSE） | DSH Cordis 事件（`ctx.on('subagent/*')` + `session/event`）+ apiproxy SSE | 见 §5.5 |
| `getSessionMessages()`（jsonl 优先 + SDK 回退） | `ctx.sessions`（Session 日志派生历史）/ `ctx.sessionQuery` | DSH 消息历史是**从事件日志派生**的，无需 jsonl 文件 |
| `getCommands()`/`listHooks()` | `ctx.commands` / `ctx.mcp`（如引擎支持 skill/mcp 命令类型） | skill/mcp 命令类型的名称校验 |
| `abortSession()` | `ctx.subagents.interrupt(targetSessionId, { kind: 'ancestor', agent: hostAgent })` | 中止当前提示（会话保留）；authority 用宿主 Agent 的 live 引用 |
| `deleteSession()` | `ctx.sessions` 生命周期 / session 删除 | 清理 |
| `revertSession()`/`unrevertSession()` | **DSH 无 revert 原语**——改为 `ctx.sessions.fork(childId, boundary)` + `ctx.agents.create({ seed })` 续跑 | 重试 revert 模式：fork 到最近 turn 边界 + 新建 agent；**产生新 session id**；回退粒度是 turn 边界（非任意消息） |
| `forkSession()` | `ctx.sessions.fork(childId, boundary?)`（现成原语，`source` 接受 SessionId） | 重试 fork 模式 + finalize fork 会话；boundary 不能落在未闭合 turn 内 |
| `buildPermissionRules()`/`autoReplyPermission()` | **DSH permission presets（子代理继承父级，approval 固定 `never`= 自动拒绝提权）** | 不再手写权限规则；普通 sandbox 内文件/shell 正常执行，仅提权被自动拒绝 |
| `stripThinkTags()`/`readLastTextFromJsonl()`/`reconstructMessagesFromJsonl()`/`appendMessagesToJsonl()` | DSH 历史派生 + `ctx.sessionQuery`（全文检索） | think 标签剥离复用 `llm-streaming` 的既有处理；jsonl 持久化由 `ctx.sessionPersistence` 承担 |

#### 5.3A.3 `sse-manager.ts`（SdkSseManager 单例）→ 删除

| sandore `sse-manager.ts` 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| per-directory ref-counted SSE 连接 | apiproxy 双 SSE 流（`/api/events.mux` + `/api/events.host`） | DSH 统一 SSE 架构，无需自建 |
| `normalizeEvent()`（messageID/partId 修复） | **删除** | DSH 的 session 事件已是规范化事件，无此需求 |
| 事件规范化 + jsonl 持久化 | `ctx.sessionPersistence`（JSONL/SQLite 后端） | 会话事件持久化由 seam 负责 |
| 指数退避重连（1s→30s） | apiproxy SSE 的重连机制 | 由 DSH 前端 SSE 客户端处理 |
| 子 Agent sessionId 追踪 | `ctx.subagents`（`subagent/start`/`subagent/end` + `listChildren`） | 原生支持 |
| `setEventPublisher`/`resolveDirectory` | **删除** | 事件发布用 `ctx.emit`；目录解析无需（DSH 无 directory 概念） |

#### 5.3A.4 `utils.ts`（临时会话工具）→ 替换

| sandore `utils.ts` 能力 | DSH 等价组件 | 说明 |
|---|---|---|
| `startTempSession()` | `ctx.llm.prepareCall()` + `ctx.llm.stream()`（或一次性 `ctx.subagents.start()`） | 分支评估/finalize 的一次性推理 |
| `collectTempSession()` | 收集 `ctx.llm.stream()` 的 AsyncIterable 输出 | 读取临时推理结果 |
| `runTempSession()` | 上面两步的组合 | 便捷方法 |
| `waitForSessionIdle()` | `ctx.on('subagent/end')` / 子代理 Session 事件等待 | 等待一次性子代理结算 |

> **结论**：`engine/internal/sdk/` 的四个文件**全部删除或替换**，引擎零外部 SDK 依赖。唯一保留的是引擎对「会话/推理/Shell/文件」的**抽象调用点**——它们的实现由 DSH 的 `ctx.*` 服务提供。

### 5.4 持久化映射（关键）

sandore 用 `work.json` + `chat.json` 文件持久化。DSH 用**事件溯源（event-sourced）Session** + **存储域（storage domain）**。映射方案：

sandore 的持久化分**四层**（见 v2.6 §22.6.1 存储概览）：SQLite 两张表（定义元数据 + Job 元数据）、YAML 定义文件、jobs.json 实例索引、实例目录（work.json + chat.json + 产物）。DSH 用**事件溯源（event-sourced）Session** + **存储域（storage domain）** 统一收敛，映射方案：

| sandore 持久化 | DSH 映射 | 说明 |
|---|---|---|
| SQLite `harness_workflows` 表（Workflow 定义元数据） | **存储域 `definitions` 表**（`ctx.storageDomain.open(sandoreDomainSpec)`） | key = `workflowId`（`wfl-{uuid}`），value = `WorkflowDefinitionRecord`（含 YAML 文本 + 元数据），`entries()` 列全部定义 |
| YAML 文件 `~/.harness/data/workflows/defines/{id}.yaml` | **`definitions` 表 value**（YAML 文本作为 JSON string 存 value） | 不再落盘文件；Zod `z.string().max(N)` 设上限；`domain/changed` 事件驱动前端实时刷新 |
| SQLite `harness_workflow_jobs` 表（Job 元数据） | **存储域 `jobs` 表** | key = `jobId`，value = `JobRecord`，`entries()` 列全部 Job |
| Job 文件 `~/.harness/data/workflows/jobs/{jobId}/jobs.json`（实例索引） | **`jobs` 表 value + `state` 表派生** | 不再维护 jobs.json 实例索引文件；某 Job 的实例清单从 `state` 表 `entries()` 按 `jobId` 过滤派生 |
| `work.json`（完整引擎状态） | **存储域 `state` 表**（`ctx.storageDomain.open(sandoreDomainSpec)`） | key = `{instanceId}`，value = 引擎状态快照（Zod 校验），崩溃恢复时整体读出 |
| `chat.json`（增量讨论） | **DSH Session 事件日志**（`ctx.sessions` + `ctx.sessionPersistence`） | 每个 instance 对应一个「工作流宿主 Session」，Step 消息/用户消息以自定义 `sandore/*` 事件追加，由 `sessionPersistence` 持久化 |
| `{uuid}_input/output/parts.json` | 实例目录文件（`ctx.fs` 写入） | 保留文件式产物/输入/输出，便于产物面板读取 |

> **决策 D4**：**`work.json` 用 `storageDomain` 的 `state` 表，`chat.json` 用 Session 事件日志；SQLite 两张表 + YAML 定义文件 + jobs.json 实例索引一并迁入 storageDomain 的 `definitions`/`jobs` 表**。
>
> - **统一存储域**：用 `ctx.storageDomain.open(spec)` 定义一个 `sandore` 域（`tables: { definitions, jobs, state }` 三表，Zod schema 校验），替代 v2.6 的「SQLite（`harness_workflows` + `harness_workflow_jobs` 表）+ YAML 定义文件 + jobs.json 实例索引 + 实例目录 work.json」四层分散存储。三表：`definitions`（key=workflowId，value=YAML 文本 + 元数据）、`jobs`（key=jobId，value=JobRecord）、`state`（key=instanceId，value=WorkflowTaskState 快照）。
> - **SQLite 表迁移**：原 `node:sqlite` 的 `Database` 单例（`common/database.ts`）与 `Workflow Mapper`（`mapper/workflow-mapper.ts`）/`Workflow Jobs Mapper`（`mapper/workflow-jobs-mapper.ts`）的泛型 CRUD **整体删除**，由 `storageDomain` 的 schema 验证 KV + `entries()` 全量列举承担；SQLite/JSON/内存后端切换由 DSH storage seam 提供，**引擎不再直接持有 SQLite 连接**。定义/Job 的 CRUD 走 `workflow` 包 RPC（`listDefinitions`/`createDefinition`/`listJobs`/`createJob`/…），底层读写 storageDomain。
> - **YAML 定义文件**：原 `~/.harness/data/workflows/defines/{id}.yaml` 不再落盘，YAML 文本作为 JSON string 存入 `definitions` 表 value（业务数据走 KV，先例 `workspace`/`message-feedback`），Zod `z.string().max(N)` 设上限防失控。
> - **jobs.json 实例索引**：不再维护 `~/.harness/data/workflows/jobs/{jobId}/jobs.json`，某 Job 的实例清单从 `state` 表 `entries()` 按 `jobId` 过滤派生。
> - **work.json**（引擎运行时状态：executedSteps/pendingQueue/passThroughVars/…）是引擎私有快照，写入 `state` 表（key = instanceId），Zod schema 校验值，崩溃恢复时按 instanceId 读出。
> - **chat.json**（讨论消息流）用 DSH Session 事件日志重构：每个 instance 创建一个「工作流宿主 Session」，Step 完成/用户消息/暂停/恢复都作为自定义 `sandore/*` 事件追加，`ctx.sessionPersistence` 负责持久化（JSONL 或 SQLite 后端），讨论面板从 Session 派生渲染。
> - **Logger（winston）**：原 `common/logger.ts` 的 winston 单例 + `~/.harness/logs/workflow.log` 文件轮转**删除**，改用 DSH 的 `ctx.logger`（Cordis logger 服务，统一日志 seam + 后端）。

### 5.5 事件与 SSE 推送

sandore 的 `WorkflowEventBus` + `WorkflowSseManager` 映射为 DSH 事件 + 前端订阅：

> **关键澄清（经探索修正）**：`sandore/*` 有**双重角色**，必须区分清楚——它是 **Session 事件**（`session.append('sandore/…', data)` 写入宿主 Session log），而非纯 Cordis 事件（`ctx.emit`）。这是 D8「讨论面板复用 `ConversationNodeDefinition`」能成立的前提：`ConversationNodeDefinition.match(event)` 折叠的是 **append 到 log 的 Session 事件**（带 `seq`/`time`），不是 `ctx.emit` 的进程内事件。`tool-workflow` 正是这个范式——先 `ctx.on('workflow/*')` 作触发源，再 `session.append('tool-workflow/*', data)` 写 log。

- **Session 事件（必需）**：`sandore/*` 作为 **log-only Session 事件** `session.append` 到宿主 Session log，通过 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }` 声明合并。这驱动：① `ConversationNodeDefinition` 折叠成 `sandore-step` 节点（D8）；② apiproxy `session/event` 帧实时透传到前端。
- **Cordis 事件（可选）**：引擎内部模块如需进程内同步通信，可额外 `ctx.emit` 同名事件，但**不能替代** Session 事件——只有 append 到 log 的才被前端可见。
- **推送到前端**：DSH 有**双 SSE 流**——`/api/events.mux`（会话事件，含 `session/event`、`session/projection`、`approval/requested`、`question/requested` 等帧）与 `/api/events.host`（主机事件）。工作流引擎的推送走这两条既有通道：
  1. **Session 事件 + projection**：宿主 Session 的 `sandore/*` Session 事件（append 到 log）经 apiproxy `session/event` 帧透传到前端；状态快照经 `ctx.sessionProjections` 注册 projection unit → `session/projection` 帧推送；
  2. **交互事件**：问答/权限复用 DSH 交互 seam 的 `question/requested`/`approval/requested` 帧（前端无需区分工作流专属交互与普通交互）；
  3. **Host Remote 服务**：前端通过 `host.call()` / Remote RPC 拉取或订阅状态。
- **实时监控**：前端 `WorkflowRunView` 通过轮询 `host.call('sandore.getState', { instanceId })`（对齐原 3s/5s 轮询）+ 订阅 `sandore/*` Session 事件推送。

> **决策 D5（事件与 SSE 全用 DSH，零自建）**：**完全移除 sandore 的 `WorkflowEventBus` + `WorkflowSseManager` + `SdkSseManager` 三套事件/SSE 机制，不新建任何独立事件总线、SSE 端点或 SSE 管理器**。全部复用 DSH 既有链路：
>
> 1. **引擎内部事件**：`sandore/*` 用 Cordis 事件（`ctx.emit`/`ctx.on`，observe-only emit + 数据快照，与 DSH `workflow/*` 事件同构）；
> 2. **推送到前端**：走 DSH apiproxy 的**双 SSE 流**（`/api/events.mux` 会话帧 + `/api/events.host` 主机帧）——宿主 Session 的 `sandore/*` 事件经 `session/event` 帧透传，状态快照经 `ctx.sessionProjections` 的 `session/projection` 帧推送，问答/权限经 `question/requested`/`approval/requested` 帧；
> 3. **子代理追踪 + idle 等待**：由 `ctx.subagents`（`subagent/start`/`subagent/end` 事件 + `listChildren`）与可续接子代理的 Session 事件驱动，不重造 `sessionIdleResolvers`/`sessionSubAgents`；
> 4. **SSE 重连/规范化/持久化**：由 apiproxy SSE 客户端与 `ctx.sessionPersistence` 承担，不重造指数退避/partId 修复/jsonl。

### 5.6 Host RPC（替代 Express server）

原 `server/express/` 的 REST 路由（`/api/workflows/*`、`/jobs/*`、`/session/*`、`/providers/*`、`/fs/*`）**不移植**，改为 Host RPC：

- **对外 API**：`workflow` 包注册一个 **Remote 服务**（`TypertRemoteService` + `@Remote`，参考 `packages/host/apiproxy` 与 `packages/session/session-projection` 的 Remote 模式），暴露：
  - `listDefinitions()` / `createDefinition()` / `updateDefinition()` / `deleteDefinition()` / `getYaml()` / `updateYaml()`
  - `listJobs()` / `createJob()` / `listInstances()` / `startInstance()` / `deleteInstance()` / `abortInstance()`
  - `getDiscussion()` / `addChatMessage()`
  - `getArtifacts()`
  - `listProviders()` / `listModels()`（直接复用 `ctx.llm.listProviders()/listModels()`）
- **Client 调用**：前端通过 `host.call('sandore.listDefinitions', {})` 等 Package-private RPC，或通过 Remote 服务的 generated client。

> 说明：若采用 Dynamic Plugin 机制（原型阶段），用 `harness.handle(method, handler)` + `host.call(method, args)`；若采用持久化插件（生产阶段），用 Typert Remote 服务。两种都在设计里给出。

---

## 6. Client 端设计

### 6.1 Slot 注册

> **经探索确认的硬约束**：sidebar 的子 slot（`sidebar.workspaces`/`sidebar.settings`/`sidebar.footer.action`）由 `ui-sidebar` 这个 shell 包在 `SidebarRoot` 里声明并渲染，"声明即独占"，**插件无法新增 `sidebar.workflows` 这样的常驻分组**（那需改 ui-sidebar 源码，违反「纯插件」约束）。因此工作流管理 UI 的入口是 **`sidebar.footer.action` 按钮 + 点击展开面板**——该 slot 位于 sidebar foot 区域、**设置按钮的上方**（`SidebarRoot.tsx:181` 注释 "Footer actions stack above Settings"），是纯插件能插入「设置上面的工作流入口」的唯一位置，参考 `ui-cordis` 的先例（footer 按钮 + 展开 CordisPanel）。

`ui` 的 Client 插件 `apply(ctx)` 注册：

```ts
// packages/sandore/ui/src/index.ts（示意）
export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui: dict')

  // 1) 工作流入口按钮（sidebar.footer.action，位置在设置上面）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sandore-btn',
    locale: NS,
    inject: () => ({
      // 面板开关状态（自包含，无跨 scope 问题）
      hooks: { open: createPanelStore() },
      onOpen: (workspaceId?) => { /* 展开 WorkflowPanel */ },
    }),
  }, WorkflowButton))  // 按钮点击 → 展开 WorkflowPanel（§6.2）

  // 2) 讨论面板的 sandore-step 节点（conversation.chat.node keyed，见 §6.4）
  //    （在宿主 Session 的 chat 视图里渲染，非管理 UI 内）
}
```

> **决策 D6（工作流管理 UI 入口，经探索收敛）**：工作流管理 UI 的入口是 **`sidebar.footer.action` 按钮 + 点击展开仿 workspace 风格的面板（WorkflowPanel）**，位于设置按钮上方。这是纯插件约束下的最优解：
> - **放弃了**「常驻 sidebar 分组」——需改 ui-sidebar 源码，违反「纯插件」约束；
> - **放弃了**「conversation.view tab 为主入口」——管理 UI 应是全局的（不挂某个 session），且用户期望它贴近 workspace 的侧栏导航位置；
> - **保留**完整交互（编排/新增/三态列表/按工作区分组）在展开面板内实现（§6.2）；
> - **无跨 scope 联动难点**：面板开关是插件自有的 client 状态（参考 ui-cordis 的 CordisPanel 弹层），不再需要 root→session 的 `setView` 桥接。

### 6.2 UI 结构

> **风格参考**：WorkflowPanel 完全仿 DSH workspace（`ui-workspace` 的 WorkspaceBrowser）的观感——header（搜索 + 操作按钮）+ 分组/平铺列表。workspace 的 header 组件与分组逻辑都是包内私有，不可 import，工作流用 `@deepseek-ai/dsh-client-ui-primitives` 自绘同款观感；`useSessions`/`useWorkspaces` 是框架全局标准 hook，可直接用于「实例 → 父 session → workspace」分组映射。

```
sidebar（footArea，设置上方）
└── [工作流 按钮]（sidebar.footer.action）★
        └── 点击展开 WorkflowPanel（仿 workspace 风格，自绘）
            ├── header：搜索图标 | 「编排」toggle 按钮 + 「新增」按钮
            │
            ├── 默认态（编排 off）：
            │   └── 工作流实例列表（按工作区分组，仿 session 列表的分组树）
            │         └── 分组依据：实例的父 session id → workspace.sessionIds（显式成员表）
            │
            ├── 编排态（点「编排」on）：
            │   └── 工作流定义列表（storageDomain definitions 表 entries()）
            │         └── 点某个定义 → 进入 DagEditor（§6.2.1）
            │
            └── 「新增」按钮（按当前态）：
                ├── 默认态 → 新增实例（选择工作流定义 + 输入 originalInput → startInstance）
                └── 编排态 → 新增定义（进入空 DagEditor 新建 YAML）
```

**三态切换**：`编排` 是一个 toggle（off=实例列表，on=定义列表），非独立页面；`新增` 按钮的动作随当前态改变。

**点击列表项的导航**：
- 点「实例」→ `ctx.sessions.open(实例宿主 sessionId)` 打开宿主 Session（chat 视图里是 sandore-step 讨论节点，见 §6.4），或进入执行详情 RunView。
- 点「定义」→ 进入 DagEditor（编排该工作流）。

#### 6.2.1 DagEditor（编排器）

点击「编排态」列表里的某个定义，或「新增→定义」，进入 DagEditor：

```
DagEditor（面板内展开，或切到 conversation 视图，实现细节）
├── Stage DAG 可视化（ui-primitives 简化：节点列表 + 连线示意；React Flow 作后续增强）
├── Step 编辑（命令/输入/输出/透传变量/门禁）
└── YAML 预览 + 保存（host.call('sandore.updateYaml')）
```

#### 6.2.2 RunView（执行详情）

点击实例可查看执行详情（执行轨迹 + 产物 + 交互控件），讨论面板（sandore-step 节点）则在宿主 Session 的 chat 视图（§6.4）：

```
RunView（执行详情）
├── 头部：实例状态 + 「打开讨论」按钮（ctx.sessions.open(hostSessionId)）
├── 执行轨迹（executedSteps + stageInfos 只读视图）
├── 产物面板（artifacts）
└── 交互/暂停/恢复/重试 控件
```

> **关于 React Flow**：原 sandore 前端用 React Flow + Dagre 做 DAG 可视化。DSH 前端依赖里**未必包含 React Flow**。首推**先用 ui-primitives 实现简化版 DAG 视图**（节点列表 + 连线示意），避免引入新的重依赖；确需完整 DAG 编辑体验时再评估引入 React Flow 的代价。

### 6.3 前端技术栈与风格一致性

> **原则**：工作流 UI 是 DSH Web 的一个视图，必须**视觉与交互上融入 DSH web**——复用 DSH 已有的组件基元、theme token、locale、消息渲染、交互卡片，不自建平行的设计语言或 UI 库。

| 项 | 选择 | 说明 |
|---|---|---|
| 框架 | React（DSH client 统一） | 与 DSH 前端一致 |
| 组件基元 | `packages/client/ui-primitives`（按钮/输入/列表/对话框/徽章等） | 复用，不引第三方 UI 库 |
| 样式 | DSH theme token（`ctx.theme` + `styles.insert`，CSS 变量） | 与 DSH web 同主题、明暗色自适应 |
| i18n | `ctx.locale`（zh/en，与 DSH 统一） | 复用 DSH 的 locale 服务 |
| 消息/讨论渲染 | 复用 `ui-conversation` 的消息渲染 + `conversation.chat.node` 节点定义（参考 `ui-workflow-run`） | 见 §6.4 |
| 交互卡片 | 复用 DSH 问答/权限 UI（`ui-user-questions` / 权限卡片） | 不重造 Question/Permission 卡片 |
| 工具调用展示 | 复用 `ui-tool` 的工具卡片（`tool.call.toolview`） | Step 内工具调用可视化 |
| 数据获取 | `host.call()` RPC + DSH 事件订阅 | 不用独立 axios/fetch |
| DAG 可视化 | 先简化（ui-primitives），React Flow 作为后续增强 | 见下注 |

> **关于 React Flow**：原 sandore 前端用 React Flow + Dagre。DSH 前端依赖里**未必包含 React Flow**。首推**先用 ui-primitives 实现简化版 DAG 视图**（节点列表 + 连线示意），避免引入新的重依赖；确需完整 DAG 编辑体验时再评估引入 React Flow 的代价。

### 6.4 讨论面板：复用 ui-workflow-run 的 Chat 节点机制（关键）

> **最终结论（经探索 DSH 源码确认）**：DSH 的对话消息组件**不可跨插件 import**（`ui-conversation` 的消息组件全部 package-internal），但 DSH 提供了官方的「多子代理组合」范本 `ui-workflow-run`（`packages/client/ui-workflow-run/`），它通过 `ConversationNodeDefinition` + `conversation.chat.node` keyed slot 把多个子代理 run 折叠成主对话里的一个节点——**这套机制与主对话页面完全一致，直接复用**。

工作流的「讨论/对话页」因此**不再是一个自定义 UI**，而是让每个 Step 成为**主对话消息流里的一个 `sandore-step` Chat 节点**，与普通消息节点混排。

**机制**（照抄 `ui-workflow-run` 三件套）：

```
① 注册 ConversationNodeDefinition（kind='sandore-step', target='chat'）
   ├── match: sandore/step-start | step-completed | step-failed | step-paused | step-resumed | step-retried 事件
   ├── start/update: 折叠出 { stepId, childId, name, status, loopIteration }
   ├── buildViewNode: 返回 ChatConversationViewNode（data 含 childId）
   └── declare module 扩展 ChatNodeDataMap { 'sandore-step': DagStepChatData }

② 注册 conversation.chat.node keyed 渲染器（key='sandore-step'）
   ├── inject: (sessionId) => ({ getChildSession(id), openSession(id) })
   └── 渲染 DagStepNodeView

③ 内联消息：primitives 自绘（照抄薄胶水）
   ├── MarkdownText / MessageText（@deepseek-ai/dsh-client-ui-primitives，可 import）
   ├── 照抄 AssistantMarkdown.tsx(~110行) / UserStyleBubble(~100行) / ToolCallTree(~105行)
   └── 结果来源（经探索修正）：引擎在 append `sandore/step-completed` Session 事件时，
        把「子代理最终结果」直接塞进事件 payload（宿主侧 `ctx.sessions.get(childId)` +
        `finalAssistantOutput(childSession.events)`）→ renderer 从 `sandore-step` 节点 state 取结果，
        绕开跨会话读 snapshot（客户端 `binding(childId)` 需子会话窗口 open，不可靠）
```

**Step 节点渲染规则**：

```
主对话消息流（宿主 Session，完全复用 DSH 消息 UI 的节点体系）
├── [sandore-step 节点 A] ── 状态徽章 + 名称 + 内联「最后结果消息」（primitives 自绘）
│       ├── 执行中：running 状态，无结果消息
│       ├── 完成：内联该 Step 子会话最后一条 assistant 结果消息（returnPrompt）
│       ├── 失败：红色边框 + errorDetail
│       └── 暂停：琥珀色边框 + 会话快照
├── [用户消息]（右对齐气泡，DSH 原生渲染）
├── [sandore-step 节点 B] ── 内联最后结果消息
└── ...
```

**点击跳转子对话页**（复用 DSH 默认会话 UI + 原生生命周期控件）：

- 点击 Step 节点 → `ctx.sessions.open(childId)`，跳到该 Step 子代理 Session 的完整对话页（DSH 默认 UI）。
- 子对话页的 composer **自动**提供生命周期控件（DSH 原生，无需工作流插件实现）：
  - **暂停**：`interruptible = running && continuable` → 独立 Stop 按钮 → `subagent.interrupt`（等价 `pauseStep`）
  - **继续**：Send → `subagent.prompt`（follow-up 加入子代理 FIFO inbox，等价 `resumeStep`/「指定会话发送消息继续」）
  - **fork 重试**：TurnTail 的 onBranch → `forkAt(seq)`（等价重试 fork 模式）
- continue / revert 两种重试模式需在 Step 节点上补一个「重试」按钮（工作流专属语义，映射 `retryStep`）。

**关于 @xxx 指定会话**（重要差异）：

原 sandore 的「讨论面板输入 `@Step` → 定向恢复/重试」交互**不能复用 DSH 的 @ 源**——DSH 的 `@` 提及源（`ctx.inputTriggers`）是**故意惰性**的：只插入字面 `@label ` 文本，**不解析成 continuation 地址**（`ui-subagent` README 明确声明）。复用 DSH 后，该交互被更自然的 DSH 原生交互取代：**进入 Step 子对话页 Send**（即「指定会话发送消息继续」）。若仍需「主对话内 @Step 路由」，需工作流插件自行实现一个 mention 源（扩展 `ctx.inputTriggers`），但**首推前者**（零新增机制）。

**问答 / 审批复用**（无需自建完整 UI，载体复用 + 薄卡片自绘）：

| 交互 | 复用 | 自绘 |
|---|---|---|
| 问答（askUserQuestion） | `PendingQuestion`（`ui-user-questions` 已导出）+ `PendingWait<'question'>` 载体 | QuestionFlow 卡片 ~100 行（照抄 QuestionComposer） |
| 权限/审批 | `PendingWait<'approval'>` 载体 + 应答编码 | Approval 卡片 ~50 行（照抄 ApprovalPanel） |
| 权限模式 | DSH permission presets（**子代理继承父级**，见下） | 无 |

**权限模式修正**（探索发现，推翻 D3 中「权限模式对接 autoReplyPermission」的旧表述）：

DSH **没有** `bypassPermissions`/`acceptEdits`/`permissionMode` 概念，而是用 `sandbox/mode` + `approval/policy` 折叠成 **permission presets**（默认 `workspace-write`=workspace-write+ask、`danger-full-access`=full+never）。且 `ctx.subagents.startContinuable()` 的 `ContinuableStartSpec` **无权限字段**——**子代理继承父会话（工作流宿主 Session）的 permission preset，approval 固定 `never`**。因此原 sandore 的「实例级 permissionMode」在 DSH 中映射为：**工作流宿主 Session 的 permission preset**（Step 子代理继承它），不提供 Step 级独立权限覆盖（若确需不同权限，须先切宿主会话 preset）。

---

## 7. 数据流与 RPC

### 7.1 端到端数据流（以「执行一个工作流」为例）

```
用户（DSH Web）
  │
  ▼ 点击「工作流」按钮（sidebar.footer.action，设置上方）
  │   → 展开 WorkflowPanel（面板开关，自包含 client 状态）
  │
  ▼ WorkflowPanel（默认态：实例列表，按工作区分组）渲染
  │   host.call('sandore.listInstances') ──► Host RPC ──► 存储域 state 表
  │   ◄── 实例列表（JSON）
  │
  ▼ 点击「编排」toggle → 定义列表
  │   host.call('sandore.listDefinitions') ──► 存储域 definitions 表
  │   ◄── 定义列表（JSON）
  │
  ▼ 「新增」→ 定义（编排态）：进入空 DagEditor 新建 YAML
  │
  ▼ 选择 Job → 点击「执行」
  │   host.call('sandore.startInstance', { jobId, originalInput })
  │       │
  │       ▼ Host: workflow → ctx.sandoreEngine.startInstance()
  │            ├── 解析 YAML → WorkflowDefinition
  │            ├── 创建 DagRun（注册到 workflowManager）
  │            ├── 创建「工作流宿主 Session」（承载 chat.json 事件）
  │            └── 引擎异步执行（StageExecutor 逐 Stage 执行）
  │                 ├── Step: ctx.agents.create() → send → 监听事件 → 读输出
  │                 ├── shell: ctx.shell.run()
  │                 ├── finalize: ctx.llm.stream()（fork/临时会话）
  │                 └── 持久化: 存储域快照 + sandore/* 事件
  │
  ▼ RunView（执行态）渲染
  │   轮询 host.call('sandore.getState') + 订阅 sandore/* 事件推送
  │   ◄── 实时状态 / 讨论 / 产物
  │
  ▼ 进入终态（completed）→ 宿主 Session 自然降级为自由对话 agent（主代理）
       用户继续在主对话自由对话（继续其他任务）；failed 态：主代理可用 retryStep 工具重试
       无「额外挂载默认会话」步骤（宿主 Session 本身就是默认会话，见 §5.1A）
```

### 7.2 RPC 清单（`workflow`）

| 方法名 | 说明 | 对应原 Express 路由 |
|---|---|---|
| `listDefinitions` / `createDefinition` / `updateDefinition` / `deleteDefinition` / `getYaml` / `updateYaml` | 定义 CRUD + YAML | `/api/workflows/defines/*` |
| `listJobs` / `createJob` / `getJob` / `updateJob` / `deleteJob` | Job CRUD | `/api/workflows/jobs/*` |
| `listInstances` / `startInstance` / `deleteInstance` / `getInstanceState` / `abortInstance` | 实例生命周期 | `/jobs/:id/instances/*` |
| `getDiscussion` / `addChatMessage` | 讨论/聊天 | `.../discussion` + `.../chat/message` |
| `getArtifacts` | 产物查询 | `.../artifacts` |
| `replyQuestion` / `replyPermission` | 交互回复 | `.../question/reply` + `.../permission/reply` |
| `pauseStep` / `resumeStep` / `pauseAll` / `resumeAll` / `retryStep` | 暂停/恢复/重试 | `.../pause` / `.../resume` / `.../retry` |
| `listProviders` / `listModels` | Provider/Model（复用 `ctx.llm`） | `/providers/*` |
| （D9 修正：无 default-session RPC——宿主 Session 自然延续，前端用普通会话 RPC 即可） | — | — |

---

## 8. 挂载与集成

### 8.1 静态组合（生产）

在目标 Web 组合的 `cordis.yml`（或 agent preset）中插入插件行：

```yaml
- insert:
    - id: workflow
      name: '@deepseek-ai/dsh-sandore-workflow'
      config:
        # 引擎配置（遵循 DSH "No hardcoded tunables" 约定）
        defaultTimeoutMs: 7200000
        # 注：无 permissionMode 配置（权限修正后废弃——权限由宿主 Session 的
        # permission preset 决定，Step 子代理继承父级，见 §5.3A）
    - id: microflow
      name: '@deepseek-ai/dsh-sandore-microflow'
    - id: tool
      name: '@deepseek-ai/dsh-sandore-tool'
    - id: ui
      name: '@deepseek-ai/dsh-client-ui-sandore'
```

> 包的 `package.json` 需要：Host 包正常声明；`ui` 声明 `dsh.client`（`platform: 'web'`）+ `exports["./client"]`，其 bundle 由 `ctx.clientModules` 扫描并组合进 `window.__DSH_BOOT__`。
>
> **Config 约定**（DSH「No hardcoded tunables」）：`workflow`（Provider）用 `static Config = z.object({...})`（schemastery）声明可配置项（`defaultTimeoutMs`/`maxConcurrentSteps` 等），Loader 在启动前自动校验；引擎内部不得硬编码这些 tunable，统一通过 `config` 解析（默认值走显式 `resolve(request): Spec` 步骤，而非隐藏的 `?? default`）。

### 8.2 原型验证（动态插件）

在正式落包前，可用 DSH 的**动态 Cordis 插件**机制（`cordis_define`/`cordis_run`）做快速原型：先定义 Host 半（`ctx.sandoreEngine` 的最小实现 + `harness.handle` RPC）与 Client 半（`sidebar.footer.action` 按钮 + 展开 WorkflowPanel），验证 slot 注入与 RPC 链路后再固化到仓库包。

### 8.3 依赖注入清单与 Provider 声明

`workflow`（Provider）的 `inject` 与 `static Config`：

```ts
import z from '@deepseek-ai/schemastery'
import { SandoreEngine } from '@deepseek-ai/dsh-sandore-workflow'

class SandoreEngineRuntime extends SandoreEngine {
  static inject = [
    'sessions',           // 工作流宿主 Session（chat.json 事件日志）
    'sessionPersistence', // 会话持久化（崩溃恢复）
    'subagents',          // 可续接子代理（Step 执行）
    'llm',                // 分支评估/finalize 临时推理
    'shell',              // shell 类型 Step（简单命令）
    'fs',                 // 产物/文件读写
    'storageDomain',      // work.json 状态快照（schema 验证 KV）
  ]
  // 可选（用 ctx.get() 软依赖）：
  //   ctx.subprocess —— shell Step 需 stdin 注入/流式/终端时
  //   ctx.sandbox    —— 需要显式沙箱约束时（默认走组合级 sandboxMode）

  static Config = z.object({
    defaultTimeoutMs: z.natural().default(7200000),
    maxConcurrentSteps: z.natural().default(0),   // 0 = 不限（对齐 v2.5 停用并发限制）
    // 注：无 permissionMode（权限修正后废弃——子代理继承宿主 Session preset）
  })

  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx)  // super(ctx, 'sandoreEngine')
    this.config = config
  }
  // ...
}
export default SandoreEngineRuntime
```

---

## 9. 分阶段实施计划

### Phase 0 — 骨架与原型（验证可行性）

- [ ] 新建 `packages/sandore/workflow`（Service Definition：类型 + 事件 + 抽象类）
- [ ] 用动态插件做一个最小 Host（`ctx.sandoreEngine` 桩 + `harness.handle`）+ Client（footer 按钮 + 展开面板）原型，验证：
  - [ ] `sidebar.footer.action` 按钮可显示（设置上方）
  - [ ] 点击按钮展开 WorkflowPanel
  - [ ] `host.call` 往返 JSON 正常

### Phase 1 — 引擎核心移植（Host）

- [ ] `workflow`：移植 YAML 解析 + `WorkflowDefinition` 类型（Zod）
- [ ] 移植 `StageExecutor` + `WorkflowDagNavigator`（Stage 级编排 + StageContract）
- [ ] 移植 `WorkflowStepRunner`（五种 Command 类型，底层改用 `ctx.subagents`/`ctx.shell`/`ctx.subprocess`/`ctx.llm`）
- [ ] 移植 `BranchEvaluator` / `FinalizeManager`（FinalizeAssessor + GateEvaluator）/ `LoopManager`
- [ ] 移植持久化：`work.json` → 存储域；`chat.json` → Session 事件

### Phase 2 — API 层（替代 Express）

- [ ] `workflow`：定义/Job/实例 CRUD + 交互 + 暂停/恢复/重试的 Remote/RPC 方法
- [ ] 讨论/产物查询（从存储域 + Session 派生）

### Phase 3 — 前端 UI（Client）

- [ ] `ui`：`WorkflowView` 三态容器 + `WorkflowList`
- [ ] `DagEditor`（简化 DAG 编辑 + YAML 预览）
- [ ] `RunView`（执行轨迹 + 讨论 + 产物 + 交互控件）
- [ ] 活动栏按钮 + 视图 tab 联动

### Phase 4 — 高级能力与固化

- [ ] 暂停/恢复/重试（continue/revert/fork）
- [ ] 崩溃恢复（`recoverOrphanedInstances` → DSH 启动扫描）
- [ ] 主代理编排器工具面（`tool`：`sandore_*` 8 个工具 + 宿主 Session 完成后自然降级为自由对话，见 §5.1A）
- [ ] 固化为持久化插件（`cordis.yml` 静态组合），移除动态插件原型

---

## 10. 风险与设计决策

### 10.1 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **引擎源码缺失**：sandore 只有文档，无源码 | 需按文档重写，工作量 + 正确性风险 | 文档 v2.6 已非常详尽（字段/方法/时序），可作为实现规格；Phase 0 先用最小原型验证关键链路 |
| **Step 会话映射差异**：`@codeagent/sdk` 的 session/SSE 与 DSH `ctx.agents` 语义不同 | Step 执行、暂停/恢复、崩溃恢复行为需适配 | Phase 1 先做 agent/prompt/shell 三种类型跑通，再补 skill/mcp；暂停/恢复用 DSH 子 agent 的 interrupt/resume |
| **管理 UI 入口的全局性**：sidebar 无法常驻分组（纯插件约束），入口为 footer 按钮 + 展开面板 | 管理 UI 不在会话内，但需面板开关自包含 | footer 按钮（设置上方）+ 展开 WorkflowPanel，面板开关是插件自有 client 状态（D6） |
| **UI 技术栈差异**：React Flow 等前端依赖可能需引入 | 编排器复杂 | Phase 3 先用 ui-primitives 简化实现，React Flow 作为可选增强 |
| **命名冲突**：`workflowEngine`/`workflow/*` 已被 DSH 占用 | 混淆 | 全部用 `sandore`/`sandore/*` 前缀（决策 D1） |
| **持久化模型差异**：文件 → 事件溯源 | 崩溃恢复语义需重构 | 决策 D4：work.json 用存储域，chat.json 用 Session 事件，逐步迁移 |

### 10.2 关键设计决策汇总

| 编号 | 决策 |
|---|---|
| D1 | 新引擎用 `ctx.sandoreEngine` + `sandore/*` 事件，不扩展 `ctx.workflowEngine` |
| D2 | Service 层只暴露实例级操作；定义/Job CRUD + 讨论/产物查询放 Host RPC 层 |
| D3 | Step 会话用 `ctx.subagents.startContinuable()`（可续接，支持 followup/interrupt/resume）；分支评估/finalize 临时推理用 `ctx.llm.stream()` |
| D4 | `work.json` 用 `ctx.storageDomain` 的 `state` 表；`chat.json` 用 Session 事件日志（`ctx.sessionPersistence`）；SQLite 两张表 + YAML 定义文件 + jobs.json 实例索引迁入 `definitions`/`jobs` 表，`Database` 单例/`Workflow Mapper`/`Logger` 删除 |
| D5 | **事件/SSE 全用 DSH，零自建**：删除 `WorkflowEventBus`/`WorkflowSseManager`/`SdkSseManager`，改用 Cordis 事件总线 + apiproxy 双 SSE 流 + session projection |
| D6 | 工作流管理 UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（仿 workspace 风格，自包含 client 状态），位于设置上方；放弃常驻 sidebar 分组与 conversation.view tab 主入口 |
| D7 | **前端复用 DSH 组件与设计语言**（ui-primitives/theme/locale/消息渲染/交互卡片），与 DSH web 风格一致 |
| D8 | **讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制**（`ConversationNodeDefinition` + `conversation.chat.node` keyed slot）：每个 Step 折叠为一个 `sandore-step` 节点，内联最后结果消息（primitives 自绘），点击跳转子对话页 |
| D9 | **主代理 = 工作流编排器，身份不切换**：广播恢复从「隐式消息路由」改为「自然语言 → 主代理显式调用 `sandore_*` 工具」；「默认挂载会话」= 宿主 Session 在 `completed` 后自然降级为自由对话（无需 DefaultSessionManager）；`sandore_*` 工具 per-instance 挂宿主 Session（`agents.create({ setup })` 闭包捕获 instanceId） |

---

## 11. 与 V3（MASE）的衔接

本插件化设计天然为 V3 升级铺路（对应 `dynamic-workflow-engine.md` §24 与 v2.6 的 StageExecutor 重构）：

- **微流程 = 一个 Stage**：`StageExecutor` 移植为 DSH Service 后，V3 的 `MicroflowEngine` 直接实例化 `StageExecutor` 执行微流程，无需完整 `WorkflowEngineV2`。
- **执行者调度**：V3 的 Router/Telecom 是全新的 Host 编排层，可复用 `workflow` 的 Step/Stage 执行能力作为「低手执行者」。
- **收尾拆分 + fork 会话**：v2.6 的 `FinalizeAssessor`（fork 会话）与 V3 的「收尾在 fork session 中进行」完全一致，可直接复用。
- **主代理自然延续**：宿主 Session（主代理）在 `completed` 后自然降级为自由对话，可扩展为 V3 的「流程组默认一般任务 Agent」（D9）。
- **产物契约**：`StageContract` 为 V3 的执行者间数据依赖（`resolveInputFrom`）提供基础。

> 建议顺序：先完成本设计（v2.6 DAG 引擎插件化），再在其上叠加 V3 的 Router/Telecom/信誉/审计等编排层。D2/D3/D4/D5 的「复用 DSH 基础设施」决策，使 V3 升级时无需替换引擎底层。

---

## 附录 A：关键 DSH API 参考（速查）

| Service（ctx key） | 核心方法 | 用途 |
|---|---|---|
| `ctx.llm` | `stream(options)` / `prepareCall()` / `listProviders()` / `listModels()` / `resolveModelInfo()` | 模型推理（分支/finalize 临时会话）；waterfall `llm/stream` |
| `ctx.subagents` | `startContinuable(spec)` / `start(name, req)` / `followup()` / `interrupt()` / `reportFrom()` / `listChildren()` | 可续接子代理（Step 执行）+ 一次性子代理 |
| `ctx.sessions` | `create(id, {seed})` / `append` / `flush` / `list` | Session 事件日志（chat.json 替代） |
| `ctx.sessionPersistence` | `create` / `append` / `load` / `inspect` / `prepare` / `readFrom` / `list` | 会话持久化（崩溃恢复） |
| `ctx.storageDomain` | `open(spec)` → schema 验证 KV（tables/global） | work.json 状态快照 |
| `ctx.shell` | `resolve(request)` / `run(spec)` / `start(spec)` / `get sandboxMode()` | Shell 执行（高层 `bash -c`） |
| `ctx.subprocess` | `resolveExecutable()` / `spawn()` / `spawnTerminal()` | 底层进程（stdin 注入/流式/终端） |
| `ctx.fs` | `readText` / `writeText` / `editText` / `listDir` / `stat` / `resolve` / `streamText` | 产物/文件；waterfall `fs/write-intent`/`fs/edit-intent` |
| `ctx.sandbox` | `confine(argv, policy)` | 沙箱约束（`read-only`/`workspace-write`/`danger-full-access`） |
| `ctx.sessionProjections` | `register(unit)`（event 折叠） | 前端状态推送（`session/projection` 帧） |
| `ctx.agents` | `create()` / `resume()` / `get(id)` | 底层 agent 工厂（崩溃恢复用 `resume`） |

## 附录 B：关键文件对照（sandore → DSH）

| sandore（设计文档中的模块） | DSH 落点 |
|---|---|
| `engine/internal/engine/workflow-engine-v2.ts` | `packages/sandore/workflow/src/workflow-engine.ts`（Stage 编排） |
| `engine/internal/engine/workflow-dag-navigator.ts` | `packages/sandore/workflow/src/dag-navigator.ts` |
| `engine/internal/engine/workflow-lifecycle-manager.ts` | `packages/sandore/workflow/src/lifecycle-manager.ts` |
| `engine/internal/engine/workflow-interaction-manager.ts` | `packages/sandore/workflow/src/interaction-manager.ts` |
| `engine/internal/engine/workflow-recovery-manager.ts` | `packages/sandore/workflow/src/recovery-manager.ts` |
| `engine/internal/engine/default-session-manager.ts` | `packages/sandore/workflow/src/host-agent.ts`（宿主主代理，D9 修正） |
| `engine/internal/engine/state-persistence.ts` | `packages/sandore/workflow/src/persistence.ts`（存储域 + Session 事件） |
| `engine/internal/engine/stage-executor.ts`（v2.6） | `packages/sandore/microflow/src/stage-executor.ts` |
| `engine/internal/engine/workflow-step.ts` | `packages/sandore/microflow/src/step-runner.ts`（改用 ctx.subagents/ctx.shell/ctx.subprocess） |
| `engine/internal/engine/branch-evaluator.ts` | `packages/sandore/microflow/src/branch-evaluator.ts`（改用 ctx.llm） |
| `engine/internal/engine/workflow-finalize-manager.ts` | `packages/sandore/microflow/src/finalize-manager.ts`（FinalizeAssessor/GateEvaluator） |
| `engine/internal/engine/workflow-loop-manager.ts` | `packages/sandore/microflow/src/loop-manager.ts` |
| `engine/internal/sdk/*`（@codeagent/sdk 封装） | 删除，改用 ctx.subagents/ctx.llm/ctx.shell/ctx.subprocess/ctx.fs |
| `engine/api/*` + `server/express/*` | `packages/sandore/workflow/src/remote.ts`（@Remote RPC，合并进 workflow 包） |
| `client/src/*`（React 前端） | `packages/sandore/ui/`（Client 插件） |

**保留（原样移植，逻辑见 dynamic-workflow-engine.md）**：

| sandore（设计文档中的模块） | DSH 落点 |
|---|---|
| `engine/internal/engine/types.ts`（全部 Zod Schema + TS 类型） | `packages/sandore/workflow/src/schema.ts` |
| `engine/internal/engine/workflow-engine-types.ts`（WorkflowStatus/PendingQuestion/PendingPermission/DagNodeRef） | `packages/sandore/workflow/src/types.ts` |
| `engine/internal/engine/yaml-parser.ts`（V1/V2 双格式 + Zod） | `packages/sandore/workflow/src/yaml-parser.ts` |
| `engine/internal/engine/workflow-engine-helpers.ts`（变量提取/ID 后缀/期望匹配） | `packages/sandore/workflow/src/helpers.ts` |
| `engine/internal/engine/messages.ts`（WorkflowMessagesManager：Stage→Step 两层消息聚合，v2.6 §8） | `packages/sandore/workflow/src/messages.ts` |
| `engine/internal/engine/common/file-utils.ts`（变量替换 + glob→regex，v2.6 §8.3） | `packages/sandore/microflow/src/file-utils.ts` |
| `engine/internal/engine/workflow-jobs.ts`（REST 路由层，v2.6 §22.2） | `packages/sandore/workflow/src/remote.ts`（@Remote RPC，见 §5.6） |

**删除（由 DSH 组件承担）**：

| sandore（设计文档中的模块） | 删除理由 |
|---|---|
| `engine/internal/engine/workflow-event-bus.ts` | D5：改用 Cordis 事件总线（§5.5） |
| `engine/internal/engine/workflow-sse-manager.ts` | D5：改用 apiproxy 双 SSE 流 + session projection（§5.5） |
| `engine/internal/engine/file-event-store.ts`（SSE 事件持久化 + 断点续传重播） | D5：SSE 持久化/重播由 `ctx.sessionPersistence` 承担（§5.5） |
| `engine/common/database.ts`（node:sqlite `Database` 单例） | D4：由 `storageDomain` 后端承担，引擎不再持有 SQLite 连接（§5.4） |
| `engine/common/logger.ts`（winston 单例 + 按日轮转） | D4：改用 `ctx.logger`（§5.4） |
| `engine/mapper/workflow-mapper.ts`（Workflow 定义 DB CRUD） | D4：`definitions` 表取代（§5.4） |
| `engine/mapper/workflow-jobs-mapper.ts`（Job DB CRUD + Instance 文件 CRUD） | D4：`jobs` 表 + `state` 表派生取代（§5.4） |
