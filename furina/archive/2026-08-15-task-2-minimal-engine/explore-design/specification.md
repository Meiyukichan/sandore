# Task 2 引擎最小可用 — 规格探索结果

> 探索类型：specification（规格材料探索）
> 探索对象：`docs/design/task-2-minimal-engine/work.md` 及其引用的规格文档
> 探索日期：2026-08-15

---

## 一、需求理解（Phase 2）

### What — 要做什么

在 Task 1 骨架（`ctx.sandoreEngine` 抽象类 + 13 个 `sandore/*` 事件声明 + 4 包目录）之上，实现「引擎最小可用」：类型体系（Zod Schema + TS 类型）、YAML 解析（V1/V2 双格式 + Zod 验证 + 自动 `convertLegacyToV2`）、定义/Job/实例 CRUD、存储域持久化（`sandore` 域三表）、以及线性工作流执行（shell/prompt Step 的 Stage 编排）。

### Boundaries — 范围边界

- **产出两包**：`packages/sandore/workflow/`（类型 + YAML + CRUD + 持久化 + Stage 编排引擎）与 `packages/sandore/microflow/`（Stage 内部执行 + Step 执行器）。
- **明确不包含**（后续 Task）：分支/循环（BranchEvaluator/LoopManager）、agent/skill/mcp Step、finalize（Assessor/GateEvaluator）、交互（问答/权限）、暂停/恢复/重试、崩溃恢复、SSE 事件流、前端 UI。
- **硬约束**：纯插件不改任何 DSH 源码；零外部 Agent SDK，全用 DSH `ctx.*` 服务。

### Goal — 探索目标

准确理解 Task 2 的规格（类型、YAML、CRUD、持久化、线性执行、验证标准），为后续规划/实现提供权威依据，特别是确认 DSH 关键 API（`ctx.storageDomain.open`、`ctx.shell.run`、`ctx.llm.stream`、`@Remote` RPC）的精确签名。

---

## 二、规格探索结果（Phase 3）

> `furina config show exploration.specification` 返回 `[]`（空配置）。因此按 exploreContent 直接探索 work.md 点名的规格文档：`docs/design/task-2-minimal-engine/design.md`（权威规格）、`docs/engine/dsh-workflow.md`、`docs/design/overall-design.md`、`docs/engine/dynamic-workflow-engine.md`（附录 YAML 示例）、DSH 源码 `D:\project-code\llm\deepseek-harness`（API 签名核实）。

### 2.1 命名空间与关键决策（沿用 Task 1）

| 维度 | 约定 |
|------|------|
| 引擎 Service | `ctx.sandoreEngine`（`SandoreEngine extends Service`） |
| 事件前缀 | `sandore/*`（Session 事件，`session.append` + `SessionEventMap` 声明合并） |
| RPC 前缀 | `sandore.`（`TypertRemoteService`，`super(ctx,'sandore')`） |
| 包名 | `@deepseek-ai/dsh-sandore-workflow` / `-microflow` / `-tool` / `dsh-client-ui-sandore` |
| 存储域 | `sandore` 域，三表 `definitions`/`jobs`/`state` |

关键决策（对 Task 2 有直接约束）：
- **D2**：Service 层只暴露 11 个实例级操作；定义/Job CRUD 放 `workflow`（Host RPC 层）。
- **D3**：Task 2 仅 shell/prompt——shell 用 `ctx.shell.run()`（简单命令）/ `ctx.subprocess.spawn()`（需 stdin 注入），prompt 用 `ctx.llm.stream()`。
- **D4**：`work.json` → `state` 表（key=instanceId）；SQLite 两张表 + YAML 文件 + jobs.json → `definitions`/`jobs` 表；引擎不持有 SQLite 连接。
- **权限修正**：**无 `permissionMode`**——`static Config` 与 `DagStartRequest` 不加该字段；权限由宿主 Session 的 permission preset 决定。
- **13 事件**：沿用 Task 1 的 13 个 `sandore/*` 事件（含 `childId`/`output` 增补，无 `default-session-mounted`）。

### 2.2 产出文件清单（`workflow` + `microflow`）

`workflow` 包（`packages/sandore/workflow/src/`）：
- `schema.ts`：全部 Zod Schema + TS 类型（WorkflowDefinition/WorkflowStage/WorkflowStep/WorkflowTaskState 等）
- `yaml-parser.ts`：V1/V2 双格式解析 + Zod 验证（V1 自动 `convertLegacyToV2`）
- `remote.ts`：`@Remote` RPC（定义/Job/实例 CRUD，见 §2.6）
- `persistence.ts`：`ctx.storageDomain.open(sandoreDomainSpec)` 三表
- `workflow-engine.ts`：`WorkflowEngineV2`（Stage 级编排主循环）
- `dag-navigator.ts`：节点索引 + `tryAdvanceStage`

`microflow` 包（`packages/sandore/microflow/src/`，当前只有 package.json+tsconfig.json，无 src）：
- `stage-executor.ts`：Stage 内部顺序执行 Step + StageContract 组装
- `step-runner.ts`：shell（`ctx.shell.run()`）/ prompt（`ctx.llm.stream()`）

### 2.3 类型体系要点（design.md §2）

**CommandConfig 五种类型**（`{ type, value: { ... } }`），Task 2 仅实现 shell/prompt：

| 类型 | value 字段 |
|------|-----------|
| `shell` | `command` |
| `prompt` | `promptText` + `providerId?` + `modelId?` |
| `agent` | `promptText`(Agent 名) + `agentParamsTemplate?` + `providerId?` + `modelId?`（Task 3） |
| `skill` | `promptText`(Skill 名)（Task 3） |
| `mcp` | `promptText`(MCP 名)（Task 3） |

**WorkflowDefinition**（V2）：`id, name, version, description, engine?, skills[], mcps[], agents[], settings{defaultTimeout=120, maxConcurrentAgents=4}, rules?, gates?, stages[], steps[]?`（顶层 steps 与 stages[].steps 通过 ID 交叉引用）。

**WorkflowStage**：`id, name, rules?, gates?, steps[]`（Stage 内 Step 仅含 id + 流控字段 next/defaultExpectation/condition/branches/loop，Task 2 仅 next），`next, defaultExpectation?, condition?, branches[], loop`（Stage 级 DAG，Task 2 仅 next）。

**WorkflowStep**：`id, name, command?, inputFrom[], outputTo[], passThroughVars[], timeout, next, defaultExpectation?, condition?, branches[], loop, rules?, gates?`。

**WorkflowTaskState**（持久化到 state 表）：`taskId(=instanceId), jobId, workflowId, cwd, status(7 态), originalInput, currentStageId, executedSteps[](扁平 ExecutedStepDefault), stageInfos[], pendingInteractions[], pendingQueue[], visitCounts, passThroughVars, activeLoopIterationStack, activeLoopNodeId, activeLoopStack[], pausedStepIds[], userChatMessages[], stageContracts(Record<stageId, StageContract>), defaultSessionMeta?, createdAt, updatedAt`。

> 迁移到 DSH 后废弃字段：`permissionMode`（权限由宿主 Session preset 决定）、`defaultSessionMeta`（宿主 Session 自然延续）、`userChatMessages`（用户消息由宿主 Session log 承载）。Task 1 的 `types.ts` 已定义基础词汇（DagRunInfo/DagStartRequest/DagRun/DagInstanceState/ExecutedStepDefault/StageInfo/StageContract/PendingQuestion/PendingPermission/DagResultInfo），深层依赖类型（`CommandConfig`/`InputFromItem`/`OutputToItem`/`PassThroughVar` 等）在 Task 1 以 `unknown` 占位，Task 2 收紧为真实 Zod Schema + 类型。

**DEFAULT_SETTINGS**：`{ defaultTimeout: 120, maxConcurrentAgents: 4 }`（maxConcurrentAgents 已停用）。

**DagNodeRef**（统一节点视图）：`{ kind: 'stage'|'step', stage, step?, id, name, next?, condition?, branches?, loop? }`——Stage 与 Step 在 DAG 调度层统一。

**StageContract**（Task 1 已定义）：`{ stageId, stageName, status, artifacts[], passThroughVars, contractArtifacts, completedAt, errorDetail? }`。

**错误体系**（overall-design §4.4）：`SandoreError extends HarnessError`，`fatal` 标志；错误码含 `YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`PERSISTENCE_FAILED`/`INVALID_OPERATION`/`CANCELLED` 等。

### 2.4 YAML 解析要点（design.md §3 + dynamic-workflow-engine 附录 A）

- **V2 格式**（`stages[].steps[]` 仅流控 + 顶层 `steps[]` 完整定义，交叉引用）示例见 dynamic-workflow-engine.md 附录 A.1（行 5099–5295）。
- **V1 格式**（`stages > scenarios > tasks`，task 用 `prompt: { type: Bash, value: { command } }`，scenario 级 `next`）示例见附录 A.2（行 5297–5325）。
- 解析器 `convertLegacyToV2()` 自动将 V1 转换为 V2 内部模型（映射旧版类型名，如 `Bash` → `shell`）。
- 类型转换函数：`commandToPromptType()` / `promptToCommandType()`。
- 所有类型经 Zod Schema 运行时验证；非法 YAML 抛类型化错误。

### 2.5 持久化要点（design.md §4 + dsh-workflow §5.4）

三表映射：

| 表 | key | value |
|----|-----|-------|
| `definitions` | `workflowId`（`wfl-{uuid}`） | `WorkflowDefinitionRecord`（yaml 文本 + name/version/engine/skills/mcps/agents/rules/gates/createdAt/updatedAt） |
| `jobs` | `jobId`（uuid） | `JobRecord`（name/workflowId/cwd/enabled/createdAt/...） |
| `state` | `instanceId`（如 `YYYYMMDD-HHmmss-xxx`） | `WorkflowTaskState`（完整快照，全量覆盖） |

- 实例清单从 `state` 表 `entries()` 按 jobId 过滤派生（不再维护 jobs.json）。
- `chat.json` 语义由宿主 Session 事件日志承载（Task 2 主要验证 state 快照读写）。
- YAML 文本作为 JSON string 存 `definitions` 表 value，建议 Zod `z.string().max(N)` 设上限。

**DSH storageDomain API（经探索 DSH 源码确认，精确签名）**：

- 来源包 `@deepseek-ai/dsh-storage-domain`（与 `@deepseek-ai/dsh-storage` 是两个不同包；`ctx.storageDomain`、`defineDomain`、`domainTable`、`KvTable`、`Domain` 类型均来自 storage-domain 包）。
- `defineDomain<S>(spec): S`；`domainTable<K extends string, V>(schema: ZodType<V>)`。
- **域 record schema 用 `zod`（`import { z } from 'zod'`），插件 `Config` 用 schemastery**——这是 DSH 的明确约定（storage-domain src/spec.ts 头部注释）。
- `ctx.storageDomain.open(spec: DomainSpec): Promise<Domain<S>>`——异步，域名全局唯一（重复 open 抛 `already-open`）。
- `Domain<S>`：`name`、`table(name)` → `KvTable<K,V>`、`close()`。
- `KvTable<K,V>`：`get(key)`（同步）、`entries()`、`keys()`、`size`、`put(key,value): Promise<void>`、`delete(key): Promise<boolean>`、`update(key, fn): Promise<V>`。
- 生命周期范式（参考 `message-feedback`）：`protected async [Service.init]()` 内 `open` + `ctx.effect(() => async () => { await domain.close() })` disposer；`this.table = domain.table('xxx')`。
- 域/表名必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`——`sandore`/`definitions`/`jobs`/`state` 均合法。

**缺口（实现需处理）**：当前 `packages/sandore/workflow/package.json` 的 peerDependencies 只有 `@deepseek-ai/dsh-storage`，**缺 `@deepseek-ai/dsh-storage-domain` 与 `zod`**（`dsh-storage-domain` 自身依赖 `zod ^4.4.3`）。Task 2 的 `schema.ts`/`persistence.ts` 需直接 import `zod` 和 `@deepseek-ai/dsh-storage-domain`，须补充 peerDependency 声明。

### 2.6 RPC 接口（design.md §6 + work.md）

`workflow` 包注册 `TypertRemoteService`（`super(ctx,'sandore')`）+ `@Remote('method')`，端点 `sandore.<method>`。

Task 2 范围：
- 定义 CRUD：`listDefinitions` / `createDefinition` / `updateDefinition` / `deleteDefinition` / `getYaml` / `updateYaml`
- Job CRUD：`listJobs` / `createJob` / `getJob` / `updateJob` / `deleteJob`
- 实例生命周期：`listInstances` / `startInstance` / `deleteInstance` / `getInstanceState` / `abortInstance`
- 产物：`getArtifacts`
- `listProviders` / `listModels`（直接复用 `ctx.llm.listProviders()/listModels()`）

> 后续 Task 才补：`getDiscussion`/`addChatMessage`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`。Task 1 的 `remote.ts` 现仅有 `ping`，Task 2 需替换/扩展。

Service 层（`ctx.sandoreEngine`）11 个实例级方法（Task 1 已声明）：`startInstance/recoverInstance/abortInstance/replyQuestion/replyPermission/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps/retryStep/getState`。

### 2.7 线性执行（design.md §5）

**Stage 编排主循环**（`WorkflowEngineV2.execute()`，Task 2 简化）：
1. 状态 → running；入队第一个 Stage
2. 循环：创建 `StageExecutor` → `stageExecutor.execute()` → 收集 `StageExecutionResult` → 存 `stageContracts` → 发射 `stage-completed` → `tryAdvanceStage()`（仅跟 `Stage.next`）→ 有下一 Stage 入队，无则完成
3. 全部完成 → status = completed → 持久化 + `sandore/end` 事件

**StageExecutor**（Stage 内部）：构建本 Stage nodeIndex → 入队第一个 Step → 顺序执行 Step → `resolveStageNextNodes`（Task 2 仅 Next）→ `isStageComplete` → `finalizeStageContract` 组装 StageContract。

**resolveNextNodes 优先级**（Task 2 仅 Next）：Loop → Branches → Next → 无（`tryAdvanceStage` 处理）。

**Step 执行器**（step-runner，Task 2 两种）：
- shell：`ctx.shell.resolve(request)` + `ctx.shell.run(spec)`（`bash -c`，返回 `ShellRunResult`）。需 stdin 注入时用 `ctx.subprocess.spawn()`（Task 2 简单命令用 shell.run）。
- prompt：`ctx.llm.stream(options)` 一次性推理；结构化提示词构建逻辑（主头部 + `## 你的任务` + `## 参考信息` + `## 前置Steps输出与产物` + `## 任务规则`）保留。

### 2.8 事件（13 个，Task 2 触发 7 个）

Task 2 需按序发射：`sandore/start` → `sandore/stage-start` → `sandore/step-start`（childId）→ `sandore/step-completed`（childId, output）→ `sandore/stage-completed` → … → `sandore/end`；失败时 `sandore/step-failed`。

- 这些是 **Session 事件**（`session.append('sandore/…', data)` 写入宿主 Session log，`SessionEventMap` 声明合并），非纯 `ctx.emit`。
- Task 1 的 `index.ts` 已声明全部 13 个事件的 Cordis `Events` + `SessionEventMap` 双声明。
- 建议：`SandoreEngine` 基类继承 `WorkflowEngine.emitWorkflowEvent()` 的「listener 异常捕获」模式（overall-design §6.7）。

### 2.9 关键 DSH API 精确签名（经 DSH 源码核实）

| API | 精确签名 |
|-----|---------|
| `ctx.shell.resolve` | `(request: ShellExecRequest): ShellExecSpec`（`ShellExecRequest = { command, workdir?, timeoutMs?, stdoutMaxBytes?, signal?, stdin?, env?, dshEnv?, sandboxPolicy? }`） |
| `ctx.shell.run` | `(spec: ShellExecSpec): Promise<ShellRunResult>`——**必须先 `resolve`，不接受裸 request**；非零退出/timeout/abort 均 resolve 为结果而非 reject |
| `ShellRunResult` | `{ exitCode: number\|null, signal, timedOut, aborted, timeoutMs, stdout: CollectedOutput, stderr: CollectedOutput, sandbox? }` |
| `ctx.llm.stream` | `(options: GenerateOptions): AsyncIterable<StreamChunk>` |
| `GenerateOptions` | `{ provider, model, messages: Message[], system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }` |
| `ctx.llm.prepareCall` | `(config: LlmCallConfig, signal?): Promise<PreparedLlmCall>` |
| `ctx.llm.listProviders/listModels` | `(): LlmProviderInfo[]` / `(provider): Promise<LlmModelInfo[]>` |
| `StreamChunk` | `block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish` 联合类型 |
| `ctx.storageDomain.open` | `(spec): Promise<Domain<S>>`（见 §2.5） |
| `TypertRemoteService` | `@Remote('method')` + `super(ctx, 'sandore')` → `sandore.method` |

### 2.10 验证标准（Task 2 完成门槛）

1. 能 RPC 创建/列出/删除定义与 Job；`startInstance` 创建实例并写入存储域 `state` 快照（`getInstanceState` 读回）。
2. 能执行「shell Step → prompt Step」线性工作流到 `completed`；`sandore/*` 事件按序发射（start → stage-start → step-start → step-completed → … → end）。
3. 持久化：storageDomain 读回 `state` 快照，含完整 `executedSteps` 记录。
4. 类型/YAML：能解析 V2 示例 YAML，非法 YAML 抛类型化错误。

---

## 三、探索发现的关键注意点

1. **`storage-domain` 依赖缺口**：`workflow` 包需新增 peerDependency `@deepseek-ai/dsh-storage-domain`（提供 `defineDomain`/`domainTable`/`KvTable`/`ctx.storageDomain`）与 `zod`（record schema 用 zod 而非 schemastery）。
2. **shell 必须 resolve 后再 run**：`ctx.shell.run()` 接受 `ShellExecSpec`（`resolve(request)` 产物），非裸 request；失败语义是 resolve 结果而非 reject。
3. **`[Service.init]` 生命周期**：storageDomain 的 `open` 是异步，应在 `protected async [Service.init]()` 中执行，并用 `ctx.effect` disposer 关闭 domain。
4. **域/表名约束**：`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`，`sandore`/`definitions`/`jobs`/`state` 合法。
5. **无 permissionMode**：Task 2 的 `DagStartRequest` 与 `static Config` 均不加 `permissionMode` 字段。
6. **`maxConcurrentAgents` 已停用**：所有 Step 立即入队执行，无信号量限制（`static Config.maxConcurrentSteps` 默认 0 = 不限）。
7. **`microflow` 包目前无 `src/`、无 `scripts`、无 peerDependencies**：Task 2 需补齐（含 `typecheck` script 与 DSH peerDeps）。
