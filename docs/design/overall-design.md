# 工作流引擎 DSH 插件 — 总体详细设计文档

> 版本: 1.0 | 基于: 5 份 Task 设计文档 + 2 份源文档 | 最后更新: 2025-07-21

---

## 1. 概述与目标

### 1.1 一句话定位

把 sandore 的 DAG 工作流引擎 v2.6（Stage/Step DAG + YAML + 门禁 + 透传变量 + 循环 + 暂停/恢复 + 崩溃恢复等）开发为 DeepSeek Harness (DSH) 的一个持久化 Cordis 插件，最终在 DSH Web 界面提供「工作流编排→执行→讨论」完整能力。

### 1.2 里程碑总表（5 个 Task）

| Task | 一句话目标 | 核心产出 | 设计文档 |
|------|-----------|---------|---------|
| **Task 1** 骨架 | 仓库脚手架 + Service Definition + 最小端到端链路（Slot 注入 + RPC 往返） | 4 个包的目录结构 + `ctx.sandoreEngine` 抽象类 + `sandore/*` 事件声明 + 占位 UI | [`task-1-skeleton/design.md`](task-1-skeleton/design.md) |
| **Task 2** 引擎最小可用 | 类型体系 + YAML 解析 + 定义/Job/实例 CRUD + 存储域持久化 + 线性执行 | `workflow`（Stage 编排 + RPC）+ `microflow`（StageExecutor + shell/prompt Step） | [`task-2-minimal-engine/design.md`](task-2-minimal-engine/design.md) |
| **Task 3** 完整 DAG | agent/skill/mcp Step + 分支 + 循环/嵌套循环 + Finalize 拆分（Assessor + GateEvaluator） | 完整 DAG 执行能力（`ctx.subagents.startContinuable` + `ctx.llm` 评估） | [`task-3-full-dag/design.md`](task-3-full-dag/design.md) |
| **Task 4** 生命周期 | 交互（问答/权限/askUserQuestion）+ 暂停/恢复 + 重试 + 崩溃恢复 + 宿主主代理（默认会话自然延续，D9） | `WorkflowInteractionManager` + `WorkflowLifecycleManager` + `WorkflowRecoveryManager` + 宿主主代理 | [`task-4-lifecycle/design.md`](task-4-lifecycle/design.md) |
| **Task 5** 前端 + 固化 | 列表（WorkflowList）+ 编排器（DagEditor）+ 执行页（RunView + 讨论面板）+ `cordis.yml` 静态挂载 | 完整 Client UI + 静态组合 | [`task-5-frontend/design.md`](task-5-frontend/design.md) |

### 1.3 文档关系

```
总体详细设计文档（本文档）
    ├── 引用并串联 → 5 份 Task 设计文档（权威依据）
    ├── 补充参考  → dsh-workflow.md（引擎插件化设计）
    └── 补充参考  → dynamic-workflow-engine.md（引擎 v2.6 技术设计）
```

**定位**：本文档做「串起来」的工作——架构全貌、Task 边界、跨 Task 公共设计、事件/持久化的统一视图。5 份 Task 设计文档已包含各自的详细实现规格，本文档不逐字复述，而是提供全局视图和跨 Task 一致性约束。

---

## 2. 架构总览

### 2.1 三层分离（对齐 DSH capability seam）

```
┌─────────────────────────────────────────────────────────────────────┐
│  Client（浏览器）                                                    │
│  @deepseek-ai/dsh-client-ui-sandore                                  │
│  ├── sidebar.footer.action  → 「工作流」按钮（设置上方）→ 展开 WorkflowPanel │
│  ├── conversation.chat.node → 「sandore-step」讨论节点（宿主 Session）  │
│  └── host.call() ──────────────► Host RPC（JSON）                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │ host.call / Remote
┌─────────────────────────────────────────────────────────────────────┐
│  Host（Node 进程）                                                  │
│  ├── @deepseek-ai/dsh-sandore-workflow (seam + Stage 编排引擎)      │
│  │     抽象契约 + 类型/事件 + WorkflowEngineV2（Stage 间 DAG 编排）  │
│  │     + 实例级生命周期 + @Remote RPC（CRUD/讨论/产物/交互）        │
│  ├── @deepseek-ai/dsh-sandore-microflow (Stage 内部执行)            │
│  │     StageExecutor + StepRunner + BranchEvaluator + Finalize + Loop │
│  └── @deepseek-ai/dsh-sandore-tool (Consumer: 模型工具)             │
│        sandore_* 工具（主代理编排器）                                │
└─────────────────────────────────────────────────────────────────────┘
                                    │ 复用 DSH Host 服务
┌─────────────────────────────────────────────────────────────────────┐
│  DSH 基础设施（复用，不重造）                                       │
│  ctx.subagents / ctx.llm / ctx.shell / ctx.subprocess / ctx.fs      │
│  ctx.sessions / ctx.sessionPersistence / ctx.storageDomain          │
│  ctx.agents / ctx.sandbox / ctx.sessionProjections                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 完整包结构树

```
packages/sandore/                      ← 插件 sandore（顶层 group）
│
├── workflow/                          # ① seam 定义 + Stage 编排引擎 + @Remote RPC
│   ├── package.json                   # name: @deepseek-ai/dsh-sandore-workflow
│   └── src/
│       ├── index.ts                   # 抽象契约 + 事件声明（SessionEventMap + Cordis Events）
│       ├── types.ts                   # WorkflowDefinition/Stage/Step/StageContract 类型（纯类型）
│       ├── runtime-types.ts           # DagRun / DagStartRequest / DagResult
│       ├── workflow-engine.ts         # WorkflowEngineV2：Stage 间 DAG 编排
│       ├── dag-navigator.ts           # DAG 导航 + StageContract + tryAdvanceStage
│       ├── lifecycle-manager.ts       # 实例级：暂停/恢复/中止 + 暂停登记表
│       ├── interaction-manager.ts     # 实例级：交互（问答/权限/askUserQuestion）
│       ├── recovery-manager.ts        # 实例级：崩溃恢复 + 孤儿实例扫描
│       ├── host-agent.ts              # 宿主主代理（编排器工具面 + 自然降级）
│       ├── persistence.ts             # work.json/chat.json → 存储域 + Session 事件
│       └── remote.ts                  # @Remote RPC（定义/Job/实例 CRUD、讨论、产物、交互）
│
├── microflow/                         # ② Stage 内部执行（v3 微流程核心）
│   ├── package.json                   # name: @deepseek-ai/dsh-sandore-microflow
│   └── src/
│       ├── index.ts                   # export StageExecutor
│       ├── stage-executor.ts          # StageExecutor
│       ├── step-runner.ts             # Step 执行器（五种 Command）
│       ├── step-execution.ts          # executeStepNode + runPostStepPipeline
│       ├── branch-evaluator.ts        # 分支/循环评估（ctx.llm）
│       ├── finalize-manager.ts        # FinalizeAssessor + GateEvaluator
│       └── loop-manager.ts            # 循环管理
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

### 2.3 Task 与包的覆盖映射

| 包 | Task 1 | Task 2 | Task 3 | Task 4 | Task 5 |
|----|--------|--------|--------|--------|--------|
| `workflow/` | **建**：目录 + 抽象类 + 事件声明 + 基础类型 + 桩 | **补全**：Zod Schema/类型 + YAML/CRUD/持久化 + 线性执行（Stage 编排） | **补全**：@Remote RPC（讨论/产物） | **补全**：交互/暂停恢复/重试/崩溃恢复 + 宿主主代理 | — |
| `microflow/` | — | **建**：StageExecutor + Step 执行（shell/prompt） | **补全**：agent Step/分支/循环/Finalize | — | — |
| `tool/` | — | — | — | **建**：sandore_* 工具（主代理编排器） | — |
| `ui/` | **建**：占位 UI + Slot 注册 | — | — | — | **补全**：WorkflowPanel + DagEditor + RunView + 讨论节点 + 固化 |

---

## 3. 5 个 Task 的边界与依赖

### 3.1 Task 目标与产出

#### Task 1 骨架

- **目标**：仓库脚手架 + Service Definition + 最小端到端链路（Slot 注入 + RPC 往返）
- **产出**：见 [`task-1-skeleton/design.md`](task-1-skeleton/design.md)
- **不包含**：任何真实引擎执行逻辑、完整 UI 组件

#### Task 2 引擎最小可用

- **目标**：类型体系 + YAML 解析（V1/V2 + Zod）+ 定义/Job/实例 CRUD + 存储域持久化 + 线性工作流执行
- **产出**：见 [`task-2-minimal-engine/design.md`](task-2-minimal-engine/design.md)
- **验证标准**：能跑通一个「shell Step → prompt Step」的线性工作流到 completed

#### Task 3 完整 DAG

- **目标**：agent/skill/mcp Step + 分支评估 + 循环/嵌套循环 + Finalize 拆分（Assessor + GateEvaluator）
- **产出**：见 [`task-3-full-dag/design.md`](task-3-full-dag/design.md)
- **验证标准**：能执行带分支/循环/门禁/透传变量的完整 DAG 工作流

#### Task 4 生命周期

- **目标**：交互（问答/权限/askUserQuestion）+ 暂停/恢复 + 重试 + 崩溃恢复 + 宿主主代理（默认会话自然延续，D9）
- **产出**：见 [`task-4-lifecycle/design.md`](task-4-lifecycle/design.md)
- **验证标准**：暂停/恢复/重试/崩溃恢复/消息聚合（宿主主代理延续）全链路可用

#### Task 5 前端 + 固化

- **目标**：列表（WorkflowList）+ 编排器（DagEditor）+ 执行页（RunView + 讨论面板）+ `cordis.yml` 静态挂载
- **产出**：见 [`task-5-frontend/design.md`](task-5-frontend/design.md)
- **验证标准**：完整 UI 可用（列表→编排→执行→讨论→交互），插件随 `cordis.yml` 稳定加载

### 3.2 Task 间依赖关系图

```
Task 1（骨架）
    │
    ▼ 严格依赖
Task 2（引擎最小可用）
    │
    ▼ 严格依赖
Task 3（完整 DAG）
    │
    ├──► Task 4（生命周期）──┐
    │                         │ 两者可部分并行（Task 5 的 UI 组件
    └────────────────────────►│ 可在 Task 3 完成后开始骨架，
                              │ 但完整交互依赖 Task 4）
                              ▼
                         Task 5（前端 + 固化）
```

**严格串行链**：Task 1 → Task 2 → Task 3（每个 Task 的产出是下一个 Task 的输入）

**可并行点**：
- Task 4（生命周期）的引擎层改造与 Task 5（前端）的 UI 骨架可**部分并行**——Task 5 的 DagEditor 和 RunView 骨架在 Task 3 完成后即可开始，但交互控件（暂停/恢复/重试/问答）需等 Task 4 完成
- Task 4 和 Task 5 共同完成后，进行端到端集成测试

### 3.3 每个 Task 的入口验证标准

| Task | 入口验证（前置条件） | 出口验证（完成标准） |
|------|---------------------|---------------------|
| Task 1 | 无（起始 Task） | 4 个包目录结构正确 + `ctx.sandoreEngine` 抽象类定义正确 + Slot 注入可显示 + RPC 往返 JSON 正常 |
| Task 2 | Task 1 全部通过 | 创建/读取/删除工作流定义 + 启动实例 + shell Step → prompt Step 线性执行到 completed + 存储域读写正常 |
| Task 3 | Task 2 全部通过 | agent/skill/mcp Step 可续接子代理 + 分支正确路由 + 循环迭代/跳出 + Finalize 两部分 + 门禁审查 + 透传变量完整链路 |
| Task 4 | Task 3 全部通过 | 暂停/恢复/重试（三种模式）/崩溃恢复/消息聚合（宿主主代理延续）全链路可用 + 交互（问答/权限/askUserQuestion）全链路可用 |
| Task 5 | Task 3 完成（UI 骨架可开始），Task 4 完成（完整交互可集成） | 列表→编排→执行→讨论→交互全链路可用 + 插件随 `cordis.yml` 稳定加载 |

---

## 4. 跨 Task 的公共设计

### 4.1 命名约定

| 维度 | 约定 | 示例 |
|------|------|------|
| **包名** | `@deepseek-ai/dsh-sandore-*`（Host）/ `@deepseek-ai/dsh-client-ui-sandore`（UI） | `@deepseek-ai/dsh-sandore-workflow`、`dsh-sandore-microflow`、`dsh-sandore-tool`、`dsh-client-ui-sandore` |
| **ctx key** | `ctx.sandoreEngine` | Service Definition 的唯一注册名（workflow 包提供） |
| **事件前缀** | `sandore/*` | `sandore/step-start`、`sandore/end` |
| **RPC 方法前缀** | `sandore.` | `sandore.listDefinitions`、`sandore.getState` |
| **模型工具名** | `sandore_*` | `sandore_resumeAllPaused`、`sandore_getState` |
| **存储域** | `sandore` | `ctx.storageDomain.open(spec)` 打开的域（definitions/jobs/state 三表） |
| **ID 前缀** | `wfl-{uuid}` / `stg-{uuid}` / `step-{uuid}` / `ipt-{uuid}` / `opt-{uuid}` | 工作流/Stage/Step/输入/输出的唯一标识 |

### 4.2 `sandore/*` 事件词汇表（完整总表）

> 以下事件在 Task 1 中声明，Task 2–4 逐步触发。每个事件的第一个参数始终是 `DagRunInfo`（含 `taskId`、`workflowId`、`jobId`）。

| 事件名 | 载荷（除 DagRunInfo 外） | 触发时机 | 首次可用 |
|--------|--------------------------|---------|---------|
| `sandore/start` | — | `execute()` 开始 | Task 2 |
| `sandore/stage-start` | `stageId: string` | Stage 开始执行 | Task 2 |
| `sandore/stage-completed` | `stageId: string, contract: StageContract` | Stage 执行完成，StageContract 组装完毕 | Task 2 |
| `sandore/step-start` | `stepId: string, childId: string` | Step 开始执行（childId = 子代理 SessionId） | Task 2 |
| `sandore/step-completed` | `stepId: string, childId: string, output: ContentBlock[]` | Step 执行完成（output = 子代理最终结果，内联展示用） | Task 2 |
| `sandore/step-failed` | `stepId: string, childId: string, error: string` | Step 执行失败 | Task 2 |
| `sandore/question` | `question: PendingQuestion` | 问答请求（SDK Agent 执行中或 FinalizeAssessor ask 判定） | Task 4 |
| `sandore/permission` | `permission: PendingPermission` | 权限请求 | Task 4 |
| `sandore/end` | `result: DagResultInfo` | 工作流结束（completed/failed/aborted） | Task 2 |
| `sandore/step-paused` | `stepId: string, childId: string` | Step 暂停（引擎登记表记录） | Task 4 |
| `sandore/step-resumed` | `stepId: string, childId: string, resumePrompt?: string` | Step 恢复 | Task 4 |
| `sandore/step-retried` | `stepId: string, mode: string` | Step 重试开始 | Task 4 |
| `sandore/aborted` | — | 工作流被中止 | Task 4 |

> **关键（经探索确认）**：这些 `sandore/*` 是 **Session 事件**（`session.append('sandore/…', data)` 写入宿主 Session log，经 `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`），**不是纯 Cordis 事件**。只有 append 到 log 的事件才会被 `ConversationNodeDefinition`（D8 讨论面板）折叠、被 apiproxy `session/event` 帧透传。`ctx.emit` 同名 Cordis 事件仅作引擎内部可选触发源，不能替代 Session 事件。
>
> **D9 修正**：无 `default-session-mounted` 事件（宿主 Session 自然延续为自由对话，不额外挂载）。`sandore/step-start`/`step-completed` 的 payload 增补 `childId` 与 `output`（子代理最终结果），使 renderer 直接从 `sandore-step` 节点 state 取结果，绕开跨会话读 snapshot。

### 4.3 持久化 schema

#### 4.3.1 存储域（定义/Job/状态三表）

`ctx.storageDomain.open(spec)` 打开一个名为 `sandore` 的域，结构如下（**经探索确认：一个 domain 可含多表，KvTable 有 `entries()`/`keys()`/`size` 支持全量列出**）：

```typescript
// domain spec 草图
const sandoreDomainSpec = defineDomain({
  name: 'sandore',
  version: 1,
  tables: {
    // 工作流定义（YAML 文本 + 元数据）
    definitions: {
      key: 'string',                       // workflowId（wfl-{uuid}）
      value: WorkflowDefinitionRecordSchema,  // { yaml, name, version, engine, skills, mcps, agents, rules, gates, createdAt, updatedAt }
    },
    // Job 元数据
    jobs: {
      key: 'string',                       // jobId（uuid）
      value: JobRecordSchema,              // { name, workflowId, cwd, enabled, createdAt, ... }
    },
    // 实例状态快照（原 work.json）
    state: {
      key: 'string',                       // instanceId
      value: WorkflowTaskStateSchema,
    },
  },
})
```

**Key/Value 结构**：

| Table | Key | Value | 说明 |
|-------|-----|-------|------|
| `definitions` | `workflowId`（`wfl-{uuid}`） | `WorkflowDefinitionRecord`（含 YAML 文本 + 元数据，Zod `max(N)` 设上限） | `entries()` 列全部定义；YAML 作为 JSON string 存 value |
| `jobs` | `jobId`（uuid） | `JobRecord` | `entries()` 列全部 Job |
| `state` | `instanceId`（如 `20250720-143000-abc`） | `WorkflowTaskState`（完整运行时状态快照） | 每实例一个条目，全量覆盖写入 |

> **定义存储决策（经探索确认）**：工作流定义（YAML）**走 storageDomain 的 `definitions` 表**，而非文件——因为 YAML 是用户通过 DagEditor 编辑、由 RPC 增删改的**业务数据**（先例：`workspace`/`message-feedback` 都走 storageDomain）；`skill`/`preset` 走文件是因为它们是「可被编辑器直接改的文件工件」，不适用于本场景。原 SQLite（`harness_workflows` 表）被 storageDomain 的 `definitions` 表取代，原 `~/.harness/data/workflows/defines/{id}.yaml` 文件被 KV value 取代。
>
> **补充实现细节（经探索确认）**：
> - **YAML 大小上限**：YAML 文本作为 JSON string 存 value，无显式大小上限，但建议 zod schema 设 `z.string().max(N)`（如 64KB）避免失控（先例 `message-feedback` note 封顶 8KB）。web 默认 `storage-json` 后端（整文件重写，少量定义够用），高频可路由到 `storage-sqlite`。
> - **前端实时刷新**：`domain/changed` 事件（`put`/`delete` 后发）可经 api-proxy 驱动管理 UI 列表实时刷新（workspace 已用此模式），无需前端轮询。

**WorkflowTaskState 核心字段**：

```
WorkflowTaskState
  ├── taskId (= instanceId), jobId, workflowId, cwd
  ├── status: DagRunStatus（7 种状态）
  ├── originalInput: string
  ├── currentStageId: string
  ├── executedSteps[]: ExecutedStepDefault（扁平数组）
  ├── stageInfos[]: StageInfo（全量 stage 列表）
  ├── pendingQueue[]: string（待执行节点 ID 队列）
  ├── visitCounts: Record<string, number>（仅 loop 节点）
  ├── passThroughVars: Record<string, {value, description, refresh?}>
  ├── permissionMode: 'bypassPermissions' | 'acceptEdits' | 'default'  ← 迁移到 DSH 后废弃：权限由宿主 Session 的 permission preset 决定，Step 子代理继承父级
  ├── activeLoopStack[]: string（嵌套循环栈）
  ├── activeLoopIterationStack[]: number（嵌套循环迭代路径）
  ├── pausedStepIds[]: string
  ├── stageContracts: Record<string, StageContract>（V2.6）
  ├── pausedChildIds: string[]  ← 迁移后改名：暂停登记表（DSH 无 paused 状态，引擎自建权威记录，见 §6.9）
  ├── defaultSessionMeta?: DefaultSessionMeta  ← 迁移后废弃：宿主 Session 自然延续（D9），无需挂载元数据
  ├── userChatMessages[]: { id, stageId, message }  ← 迁移后废弃：用户消息由宿主 Session log 承载
  └── createdAt, updatedAt
```

> 详细字段定义见 [task-2 §2.2](task-2-minimal-engine/design.md#22-运行时状态--workflowtaskstate)。

#### 4.3.2 Session 事件（`chat.json` 语义）

`chat.json` 的语义由 DSH Session 事件日志（`ctx.sessions` + `ctx.sessionPersistence`）承载。工作流宿主 Session（每 instance 一个）通过 `sandore/*` **Session 事件**（`session.append` 写入宿主 log）实现增量讨论数据。

> **关键（经探索确认）**：`sandore/*` **就是** Session 事件（不是两套东西）。§4.2 的事件词汇表同时就是 Session 事件类型——引擎在每次状态变化时 `session.append('sandore/step-start', …)` 等写入宿主 Session log，`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }` 声明合并。同一事件：① 驱动 `ConversationNodeDefinition` 折叠（D8）；② 经 apiproxy `session/event` 帧透传到前端。引擎内部如需进程内同步通信，可**额外** `ctx.emit` 同名 Cordis 事件，但那是可选触发源，不是必需的。

**Session 事件载荷**（即 §4.2 事件词汇表，log-only，无需 surface 参数）：

| Session 事件类型 | 关键载荷 | 说明 |
|-----------------|---------|------|
| `sandore/step-start` | `{ stepId, childId }` | Step 开始（childId = 子代理 SessionId） |
| `sandore/step-completed` | `{ stepId, childId, output: ContentBlock[] }` | Step 完成（output = `finalAssistantOutput` 子代理最终结果，内联展示用） |
| `sandore/step-failed` | `{ stepId, childId, error }` | Step 失败 |
| `sandore/step-paused` / `step-resumed` / `step-retried` | `{ stepId, childId, … }` | 暂停/恢复/重试 |

> **数据流**：引擎在宿主侧 append 事件前，用 `ctx.sessions.get(childId)` + `finalAssistantOutput(childSession.events)` 取子代理最终结果，塞进 `step-completed` 事件的 payload——renderer 直接从 `sandore-step` 节点 state 取结果，绕开客户端跨会话读 snapshot。

### 4.4 错误体系

对齐 DSH 的 `WorkflowError` / `HarnessError` 层级：

```typescript
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** DAG 工作流引擎的类型化错误 */
export class SandoreError extends HarnessError {
  readonly fatal: boolean

  constructor(message: string, code: SandoreErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'SandoreError'
    this.fatal = options?.fatal ?? true
  }
}

export type SandoreErrorCode =
  // 定义/解析错误（fatal）
  | 'YAML_PARSE'              // YAML 解析失败
  | 'DEFINITION_INVALID'      // Zod 校验失败
  | 'NODE_NOT_FOUND'          // DAG 节点不存在
  | 'CYCLE_DETECTED'          // DAG 环检测
  // 运行时错误（fatal）
  | 'STEP_TIMEOUT'            // Step 超时
  | 'STEP_EXECUTION'          // Step 执行失败
  | 'FINALIZE_FAILED'         // Finalize 失败
  | 'GATE_FAILED'             // 门禁未通过
  // 恢复性错误（non-fatal）
  | 'SESSION_LOST'            // 会话丢失（可重试）
  | 'PERSISTENCE_FAILED'      // 持久化失败（可重试）
  // 操作错误
  | 'INVALID_OPERATION'       // 非法操作（如对终态实例重试）
  | 'CANCELLED'               // 用户中止
```

### 4.5 测试策略

| Task | 测试重点 | 测试类型 |
|------|---------|---------|
| Task 1 | 目录结构 + package.json 声明 + 抽象类编译 + Slot 注册 + RPC 往返 | 单元测试 + 集成测试（动态插件验证） |
| Task 2 | YAML 解析（V1/V2）+ Zod 校验 + 定义/Job/实例 CRUD + 存储域读写 + 线性执行 | 单元测试（类型/解析/CRUD）+ 集成测试（端到端线性工作流） |
| Task 3 | 分支评估 + 循环/嵌套循环 + Finalize 两部分 + 门禁 + 透传变量 + agent/skill/mcp Step | 单元测试（分支/循环/Finalize）+ 集成测试（完整 DAG 端到端） |
| Task 4 | 暂停/恢复 + 重试三种模式 + 崩溃恢复 + 默认会话 + 交互全链路 | 单元测试（交互/恢复）+ 集成测试（全生命周期端到端） |
| Task 5 | UI 组件渲染 + RPC 调用 + 事件订阅 + `cordis.yml` 加载 | 组件测试 + E2E 测试（Playwright/Cypress） |

**覆盖率门槛**（对齐 DSH 约定「per-file 100% coverage」）：

- DSH 的 CI 覆盖率门槛是 **per-file 100%**（`pnpm run test:coverage`），不是 80%。
- 各 Task 的测试随功能走（每个模块的单测在实现时同步补齐），最终在 Task 5 统一收敛到 per-file 100%。
- 关键路径（YAML 解析/CRUD/执行器/分支/循环/Finalize/暂停恢复/重试）需额外有 keyless snapshot / e2e 覆盖（对齐 DSH「非平凡模型/产品可见行为变更必须有 snapshot」约定）。

---

## 5. 关键决策清单

> 以下决策在 Task 1 design.md 中首次提出，作为全局约束贯穿所有 Task。

| 编号 | 决策 | 说明 | 影响 Task |
|------|------|------|----------|
| **D1** | 新引擎用 `ctx.sandoreEngine` + `sandore/*` 事件 | 不扩展 `ctx.workflowEngine`（其接口为「脚本编排」设计），避免语义冲突 | 全部 |
| **D2** | Service 层只暴露实例级操作 | 定义/Job CRUD + 讨论/产物查询放 `workflow`（Host RPC 层），避免 Service 接口臃肿 | 全部 |
| **D3** | Step 会话用 `ctx.subagents.startContinuable()` | 可续接子代理支持 followup/interrupt/resume；临时推理用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()` | Task 3, 4 |
| **D4** | `work.json` 用 `ctx.storageDomain`；`chat.json` 用 Session 事件日志 | schema 验证 KV + 事件溯源 | Task 2, 3, 4 |
| **D5** | 事件/SSE 全用 DSH，零自建 | 删除 WorkflowEventBus/WorkflowSseManager/SdkSseManager，改用 Cordis 事件 + apiproxy 双 SSE 流 | 全部 |
| **D6** | 工作流管理 UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（仿 workspace 风格，自包含 client 状态） | 放弃常驻 sidebar 分组（改 ui-sidebar 违反纯插件）与 conversation.view tab 主入口；无跨 scope 联动难点 | Task 1, 5 |
| **D7** | 前端复用 DSH 组件与设计语言 | ui-primitives/theme/locale/消息渲染/交互卡片，与 DSH web 风格一致 | Task 5 |
| **D8** | 讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制 | 每个 Step = 一个 `sandore-step` Chat 节点（`ConversationNodeDefinition` + `conversation.chat.node` keyed slot），内联最后结果消息（primitives 自绘），点击跳转子对话页。消息组件不可 import，只能走 Slot + primitives 自绘 | Task 4, 5 |
| **D9** | 主代理 = 工作流编排器，身份不切换 | 广播恢复从「隐式消息路由」改为「主代理显式工具调用」；主代理始终同一 agent，靠「工具语义 + 实例状态」自然降级（编排器 ↔ 自由对话）；「默认挂载会话」= 宿主 Session 的自然延续（无需额外挂载）；`sandore_*` 工具仅挂宿主 Session（per-instance），不影响普通会话/其他工作流 | Task 4 |

---

## 6. 关键实现注意点

> 以下内容来自探索 deepseek-harness 代码库时发现的实现细节，作为 5 份 Task 设计文档的补充说明。**不推翻 Task 文档的既有决策**。

### 6.1 `conversation.view` Slot 注册

**发现**：DSH 的 `conversation.view` slot 由 `ui-conversation` 声明为 `{ kind: 'list'; scope: 'session' }`。注册时 `inject` 回调接收 `sessionId: SessionId`，组件通过该 sessionId 获取会话状态。

**参考实现**（`ui-trajectory/src/client/index.ts`）：

```typescript
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'trajectory',
  order: 10,
  locale: NS,
  label: () => t('view.trajectory'),
  inject: (sessionId: SessionId): TrajectoryViewInjected => {
    const session = ctx.sessions.binding(sessionId)?.session
    // ... 构造注入对象
    return { hooks, loadOlder, setActualDuration }
  },
}, TrajectoryView))
```

**注意点**：
- `inject` 回调返回的对象作为组件的注入 props
- `order` 控制 tab 排序（trajectory 用 10，sandore 用 20 即可）
- `locale` 绑定命名空间用于 tab label 的多语言
- `ctx.sessions.binding(sessionId)` 获取会话绑定，可用于读取会话状态

### 6.2 `sidebar.footer.action` Slot 注册

**发现**：`sidebar.footer.action` 由 `ui-sidebar` 声明为 `{ kind: 'list'; scope: 'root' }`，owner props 仅含 `wide: boolean`。

```typescript
// SidebarFooterActionOwnerProps
interface SidebarFooterActionOwnerProps {
  wide: boolean  // 侧边栏是否展开（false = 56px rail 模式）
}
```

**注意点**：
- 按钮组件需适配 `wide: false`（窄栏模式）和 `wide: true`（展开模式）
- `inject` 回调无参数（root scope），点击行为需通过插件自有状态桥接

### 6.3 `ctx.storageDomain.open()` 的 schema 写法

**发现**：`open(spec)` 按严格顺序执行——拒绝已打开名称、解析路由、要求后端 `kv` facet、打开 unit、按 spec 的 zod schema 校验每条已存储记录和 global。调用方拥有返回的句柄并通过 `Domain.close()` 释放。

**关键约束**：
- 域名全局唯一，同一域名不能重复打开（`already-open` 错误）
- 调用方负责 `Domain.close()`（通常作为 `ctx.effect` 的 disposer）
- 每次写入后触发 `domain/changed` 事件（`put`/`deleted`）
- 跨进程变更推送是已知限制（仅进程内事件）

### 6.4 `ctx.subagents.startContinuable()` 参数

**发现**：`startContinuable(spec)` 返回 `Promise<ContinuableStart>`（含 `{ childId, messageId }`），在 inbox 接受初始提示词时 resolve——**不等待轮次开始，也不等待消息进入 Session 日志**。

```typescript
async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
// ContinuableStart = { childId: SessionId, messageId: MessageId }
```

**注意点**：
- resolve 时机是 inbox 接受，不是 agent 开始执行
- 每个 failure 在 inbox 接受之前 reject（不返回 id），并 dispose 已创建的 handle
- `followup(parent, childId, content, options)` 发送后续消息，支持冷恢复（absent child 从持久化 Session 恢复）
- `interrupt(targetSessionId, authority)` 中断当前轮次，保留 Activation 和 pending inbox

### 6.5 `ctx.subagents.interrupt()` 的 authority 参数

**发现**：`interrupt` 需要一个 `SubagentInterruptAuthority`（human parent address 或 exact live ancestor Agent），用于权限验证。工作流引擎作为 parent agent，需要传递正确的 authority。

```typescript
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void
```

**实现注意**：引擎需持有创建 Step 时的 parent Agent 引用，用于后续 interrupt/followup 的 authority 传递。

### 6.6 `ctx.subagents.followup()` 的冷恢复能力

**发现**：`followup` 对 absent child 会自动从持久化 Session 冷恢复——这意味着崩溃恢复时，引擎只需持有 childId，无需显式调用 `ctx.agents.resume()`，直接 `followup` 即可触发冷恢复。

### 6.7 Service Definition 的事件安全发射

**发现**：DSH 的 `WorkflowEngine` 基类提供了 `emitWorkflowEvent(name, ...args)` 方法，包含 listener 异常捕获（try/catch + Promise.resolve().catch()），防止 listener 故障影响引擎。

**建议**：`SandoreEngine` 基类应继承此模式，确保 `sandore/*` 事件发射的安全性。

### 6.8 DSH WorkflowError 的 fatal 标志

**发现**：DSH 的 `WorkflowError` 有 `fatal: boolean` 标志，`fatal = true` 时 combinators（parallel/pipeline）必须 re-throw 而不是 null 化 item。`SandoreError` 应对齐此模式。

### 6.9 暂停登记表（引擎自建，DSH 无 paused 状态）

**发现**：DSH 的 `Agent.status` 只有 `idle`/`running` 两态（`packages/core/agent/src/runtime-types.ts`），**无 `paused`/`interacting`**。续接管理器的 `ActivationState`（running/waiting/settled）是私有类型，无公开查询。`listChildren` 的 `activity: 'running'|'inactive'` 只表示 live vs cold，不编码 pause。

**结论**：`resumeAllPaused`/`resumeStep` **无法靠查询 DSH 子代理状态枚举「暂停集」**——引擎必须自建「暂停登记表」（`pausedChildIds: Set<string>`），并持久化到 work.json 快照：

- `pauseStep` → `interrupt(childId, { kind: 'ancestor', agent: hostAgent })` + `pausedChildIds.add(childId)` + persist
- `resumeAllSteps` → 遍历 `pausedChildIds` 逐个 `followup(hostAgent, childId, content, { source, signal })` + delete + persist
- 辅助信号（非权威）：`agent.status === 'idle'` + `agent.inbox.hasPending`（排队中也会满足，不能替代登记表）

**补充修正（子代理核实）**：
- **revert 重试**：DSH 无 `revertSession` 原语，改为 `ctx.sessions.fork(childId, turn边界)` + `ctx.agents.create({ seed })` 续跑，产生新 session id，回退粒度是 turn 边界（非任意消息）。
- **读子代理输出**：宿主用 `ctx.sessions.get(childId).events` + `finalAssistantOutput(events)`（`binding()` 是客户端 API）。
- **approval never**：子代理 `approval/policy: never` = 每个提权 ask 确定性「拒绝」（非允许）；普通 sandbox 内文件/shell 正常执行，仅提权被拒。
- **任务注入**：`startContinuable` 的 `request.prompt`（ContentBlock[]）+ `request.persona`（system 段），子代理自动继承 parent preset。

---

## 7. 风险与注意事项

### 7.1 跨 scope 难点（D6，已解决）

> **D6 已收敛**：工作流管理 UI 入口 = `sidebar.footer.action` 按钮 + 展开 WorkflowPanel（设置上方，自包含 client 状态），**不再用 `conversation.view` tab 作为主入口**，因此原先的「root scope（footer.action）↔ session scope（conversation.view 的 setView）」跨 scope 难点**已消除**。讨论面板（sandore-step 节点）走 `conversation.chat.node`（keyed，宿主 Session 的 chat 视图），与管理 UI 分离。

**风险**：面板开关是插件自有 client 状态（参考 ui-cordis 的 footer 按钮 + 展开 CordisPanel），无跨 scope 依赖；正式落包时按 `ui-cordis` 的展开面板实现细节收敛即可。

### 7.2 Step 会话映射

每个 Step 的可续接子代理 Session 与工作流宿主 Session 的映射关系是核心数据结构：
- `executedSteps[].sessionMeta.sessionId` 存储子代理 Session ID
- 崩溃恢复时需通过 `ctx.agents.resume({ resumeSessionId })` 或 `ctx.subagents.followup()` 冷恢复
- 讨论面板需从宿主 Session 的 `sandore/*` 事件派生骨架，从子代理 Session 派生内容

**风险**：子代理 Session 的生命周期管理（创建/恢复/清理）需与引擎的 Step 生命周期严格同步，遗漏清理可能导致资源泄漏。

### 7.3 持久化迁移

从 sandore 的文件式持久化（`work.json` + `chat.json` 文件）迁移到 DSH 的 `ctx.storageDomain`（KV） + Session 事件日志：
- SQLite `harness_workflows` 表 + YAML 定义文件 → `ctx.storageDomain` 的 `sandore` 域 `definitions` 表，key = workflowId
- SQLite `harness_workflow_jobs` 表 + jobs.json 实例索引 → `sandore` 域 `jobs` 表（实例清单从 `state` 表派生）
- `work.json` → `sandore` 域 `state` 表，key = instanceId
- `chat.json` → DSH Session 事件日志，通过 `sandore/*` 自定义事件追加

**风险**：
- `storageDomain` 的 `open(spec)` 要求域名全局唯一，需确保引擎实例间不冲突
- Session 事件日志的 `append` 是追加式，不支持就地更新——讨论面板的「就地合并」语义需在派生层实现
- 跨进程变更推送是已知限制，多进程部署时需额外处理

### 7.4 前端依赖

原 sandore 前端使用 React Flow + Dagre 做 DAG 可视化。DSH 前端依赖里未必包含这些库。

**策略**：首推用 DSH 已有 `ui-primitives` 实现简化版 DAG 视图（节点列表 + 连线示意），避免引入新重依赖。后续按需评估 React Flow 的引入代价。

### 7.5 并发控制

V2.5 已停用 `maxConcurrentAgents` 信号量限制，所有 Step 立即入队执行。但 DSH 的 `ctx.subagents` 可能有自身的并发限制（如 provider 级别的 agent cap）。

**注意**：引擎的 `pendingQueue` 并发模型需与 DSH 的 subagent 并发限制对齐，避免超出 provider 限制。

### 7.6 权限模式（经探索修正）

**DSH 没有 `bypassPermissions`/`acceptEdits`/`permissionMode` 概念**，而是用 `sandbox/mode` + `approval/policy` 折叠成 **permission presets**：

| DSH preset | sandbox/mode | approval/policy | 含义 |
|---|---|---|---|
| `workspace-write`（默认） | workspace-write | ask | 写工作区需审批 |
| `danger-full-access` | full | never | 全权限、不审批 |

**关键约束**：`ctx.subagents.startContinuable()` 的 `ContinuableStartSpec` **无权限字段**——**Step 子代理继承父会话（工作流宿主 Session）的 permission preset，approval 固定 `never`**。因此：

- 原 sandore 的「实例级 permissionMode」在 DSH 中映射为「**工作流宿主 Session 的 permission preset**」，Step 子代理继承它；
- **无法 Step 级单独指定权限**（per-Step 权限差异化是迁移后唯一真实的控制力损失）；
- 不再手写 `buildPermissionRules`/`autoReplyPermission`，权限治理完全交给 DSH permission presets seam；
- shell/fs 的系统级限制仍由 `ctx.shell.get sandboxMode()` 决定，与 approval 是两个正交维度。

---

## 附录 A：源文档索引

| 文档 | 路径 | 说明 |
|------|------|------|
| dsh-workflow.md | [`docs/engine/dsh-workflow.md`](../engine/dsh-workflow.md) | 引擎 v2.6 插件化设计（整体架构、Host/Client 端设计、数据流、挂载集成） |
| dynamic-workflow-engine.md | [`docs/engine/dynamic-workflow-engine.md`](../engine/dynamic-workflow-engine.md) | 引擎 v2.6 技术设计（类型体系、DAG 执行、Step 执行、分支/循环/Finalize、持久化、前端架构） |
| Task 1 设计文档 | [`docs/design/task-1-skeleton/design.md`](task-1-skeleton/design.md) | 骨架：脚手架 + Service Definition + 最小端到端链路 |
| Task 2 设计文档 | [`docs/design/task-2-minimal-engine/design.md`](task-2-minimal-engine/design.md) | 引擎最小可用：类型/YAML/CRUD/持久化/线性执行 |
| Task 3 设计文档 | [`docs/design/task-3-full-dag/design.md`](task-3-full-dag/design.md) | 完整 DAG：agent Step/分支循环/Finalize |
| Task 4 设计文档 | [`docs/design/task-4-lifecycle/design.md`](task-4-lifecycle/design.md) | 生命周期：交互/暂停恢复/重试/崩溃恢复/默认会话 |
| Task 5 设计文档 | [`docs/design/task-5-frontend/design.md`](task-5-frontend/design.md) | 前端+固化：列表/编排器/执行页/挂载 |

## 附录 B：sandore → DSH 文件对照表

| sandore 模块 | DSH 落点 |
|---|---|
| `engine/internal/engine/workflow-engine-v2.ts` | `packages/sandore/workflow/src/workflow-engine-v2.ts` |
| `engine/internal/engine/stage-executor.ts` | 同包 `stage-executor.ts` |
| `engine/internal/engine/workflow-step.ts` | 同包 `workflow-step.ts`（改用 ctx.subagents/ctx.shell/ctx.subprocess） |
| `engine/internal/engine/branch-evaluator.ts` | 同包 `branch-evaluator.ts`（改用 ctx.llm） |
| `engine/internal/engine/workflow-finalize-manager.ts` | 同包 `finalize-manager.ts`（FinalizeAssessor + GateEvaluator） |
| `engine/internal/engine/state-persistence.ts` | 同包 `persistence.ts`（存储域 + Session 事件） |
| `engine/internal/sdk/*`（@codeagent/sdk 封装） | **删除**，改用 ctx.subagents/ctx.llm/ctx.shell/ctx.subprocess/ctx.fs |
| `engine/api/*` + `server/express/*` | `packages/sandore/workflow/`（Remote/RPC） |
| `client/src/*`（React 前端） | `packages/sandore/ui/`（Client 插件） |

## 附录 C：DSH 基础设施 API 速查

| Service（ctx key） | 核心方法 | 用途 |
|---|---|---|
| `ctx.llm` | `stream(options)` / `prepareCall()` / `listProviders()` / `listModels()` / `resolveModelInfo()` | 模型推理（prompt Step + 分支/finalize 临时会话） |
| `ctx.subagents` | `startContinuable(spec)` / `start(name, req)` / `followup(parent, childId, content, options)` / `interrupt(targetSessionId, authority)` / `reportFrom(child, content, options)` / `listChildren()` | 可续接子代理（Step 执行）+ 一次性子代理 |
| `ctx.sessions` | `create(id, {seed})` / `append` / `flush` / `list` / `binding(id)` | Session 事件日志（chat.json 替代）+ 会话绑定 |
| `ctx.sessionPersistence` | `create` / `append` / `load` / `inspect` / `prepare` / `readFrom` / `list` | 会话持久化（崩溃恢复） |
| `ctx.storageDomain` | `open(spec)` → `Domain<S>`（schema 验证 KV）/ `get(name)` / `closeAll()` | work.json 状态快照 |
| `ctx.shell` | `resolve(request)` / `run(spec)` / `start(spec)` / `get sandboxMode()` | Shell 执行（高层 `bash -c`） |
| `ctx.subprocess` | `resolveExecutable()` / `spawn()` / `spawnTerminal()` | 底层进程（stdin 注入/流式/终端） |
| `ctx.fs` | `readText` / `writeText` / `editText` / `listDir` / `stat` / `resolve` / `streamText` | 产物/文件 |
| `ctx.sandbox` | `confine(argv, policy)` | 沙箱约束 |
| `ctx.sessionProjections` | `register(unit)`（event 折叠） | 前端状态推送（`session/projection` 帧） |
| `ctx.agents` | `create()` / `resume({resumeSessionId})` / `get(id)` | 底层 agent 工厂（崩溃恢复用 `resume`） |
| `ctx.slots` | `register(options, component)` / `inject(slotName, factory)` / `entries(slotName)` | Slot 注册（Client UI 注入） |
| `ctx.locale` | `register(namespace, dicts)` / `bind(namespace)` | 国际化 |
| `ctx.theme` | `getTheme()` / `on('theme/change', ...)` | 主题（明暗色自适应） |

---

> **版本**: 1.0 | **状态**: 设计文档 | **最后更新**: 2025-07-21
