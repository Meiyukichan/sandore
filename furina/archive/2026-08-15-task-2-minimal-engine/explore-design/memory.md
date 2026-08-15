# 记忆探索结果（memory）

## 一、需求理解（Phase 2）

- **What（要理解什么）**：`docs/design/task-2-minimal-engine/work.md` 要求在 Task 1 骨架（`ctx.sandoreEngine` 抽象类 + 13 事件声明 + 4 包）之上实现「引擎最小可用」——类型体系（全部 Zod Schema + TS 类型）+ YAML 解析（V1/V2 双格式 + Zod 验证）+ 定义/Job/实例 CRUD + 存储域持久化（`sandore` 域三表）+ 线性工作流执行（shell/prompt Step）。本探索梳理项目内与 Task 2 直接相关的「设计决策记忆」与已核实的 DSH 源码范式落点。
- **Boundaries（范围）**：仅 Task 2 引擎最小可用。**不含**分支/循环（BranchEvaluator/WorkflowLoopManager）、agent/skill/mcp Step、finalize（Assessor/GateEvaluator）、交互管理、暂停/恢复/重试、崩溃恢复、SSE 事件流、前端 UI。核心记忆来源是 `docs/design/task-2-minimal-engine/design.md`（权威规格）、`docs/engine/dsh-workflow.md`（§5.2/§5.3/§5.4/§5.6/§7.2）、`docs/design/overall-design.md`（§4.3.1/§7.3/D1–D9）三份设计文档 + DSH 源码 `D:\project-code\llm\deepseek-harness`。
- **Goal（目标）**：为 Task 2 的实现/设计提供事实依据——明确产出文件清单、类型体系、YAML 解析、三表持久化、线性执行链路、RPC 清单，以及它们在 DSH 源码中的既有范式落点（Service/Provider、storageDomain.open、shell.run、llm.stream、@Remote）。
- **Project Context**：Task 1 已完成并归档（`furina/archive/2026-08-15-task-1-skeleton/`）。`packages/sandore/` 已存在 4 个包：`workflow`（已有 `index.ts`/`types.ts`/`remote.ts`）、`microflow`（空占位，仅 package.json + tsconfig.json）、`tool`（空占位）、`ui`（Client 插件）。Task 2 在 `workflow` + `microflow` 两包内产出，`tool`/`ui` 本 Task 不涉及。

## 二、项目现状（当前状态事实）

| 位置 | 现状 |
|---|---|
| `packages/sandore/workflow/src/index.ts` | `SandoreEngine extends Service` 抽象类（11 实例级方法）+ 13 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`）+ `SandoreEngineStub`（`static Config` = schemastery、`static inject` = 7 项、11 方法抛 not implemented） |
| `packages/sandore/workflow/src/types.ts` | 13 个基础 browser-safe 类型：`DagRunInfo`/`DagStartRequest`/`DagRun`/`DagRunStatus`/`DagInstanceState`/`ExecutedStepDefault`/`StageInfo`/`StepStatus`/`StageContract`/`PendingQuestion`/`AskUserQuestionPayload`/`PendingPermission`/`DagResultInfo`。深依赖类型（`CommandConfig`/`InputFromItem`/`OutputToItem`/`PassThroughVar`/`StepSessionMeta`/`FinalizeMeta`/`BranchMeta`/`SessionMessage`/`RetryRecord`）为 `unknown` 占位，Task 2 收紧为具体结构 |
| `packages/sandore/workflow/src/remote.ts` | `SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`，仅有 `@Remote('ping')` 往返桩 |
| `packages/sandore/workflow/package.json` | name `@deepseek-ai/dsh-sandore-workflow`，peerDependencies 含 `@deepseek-ai/schemastery: 3.18.1`、`@deepseek-ai/dsh-storage: 0.1.0-rc.6`，**未列 `zod`**（见 §十一 注意点） |
| `packages/sandore/microflow/` | 空占位（package.json + tsconfig.json，无 src）；name `@deepseek-ai/dsh-sandore-microflow` |
| `packages/sandore/tool/` | 空占位（package.json + tsconfig.json，无 src） |
| `docs/design/task-2-minimal-engine/design.md` | Task 2 权威规格（1422 行，类型/YAML/CRUD/持久化/线性执行/验证标准） |
| `docs/design/overall-design.md` | 总体设计（D1–D9 决策、5 Task 边界、§4.3.1 三表、§6.3 storageDomain schema 写法） |
| `docs/engine/dsh-workflow.md` | 插件化核心设计（§5.2 移植映射、§5.3 Step 执行器、§5.4 持久化、§5.6/§7.2 RPC、附录 A/B） |
| 根 `package.json` / `tsconfig.base.json` | pnpm workspace（`packages/sandore/*`）；TS strict + `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（源文件用 `.ts` 后缀导入）；`typecheck`/`build` 脚本 |

## 三、核心硬约束（不可违反）

1. **纯插件，不改任何 DSH 源码**；**零外部 Agent SDK**，全用 DSH `ctx.*` 服务（原 `@codeagent/sdk` 封装层 `engine/internal/sdk/*` 整体删除）。
2. **沿用 Task 1 命名**：`ctx.sandoreEngine` / `sandore/*`（事件）/ `sandore_*`（工具）/ `sandore.*`（RPC）/ 4 包。
3. **无 `permissionMode`**：`static Config` 与 `DagStartRequest` 不加该字段；权限由宿主 Session 的 permission preset 决定（Step 子代理继承父级，approval 固定 `never`）。
4. **13 事件**：沿用 Task 1 的 13 个 `sandore/*` 事件（含 `childId`/`output` 增补，无 `default-session-mounted`）；`sandore/*` 是 **Session 事件**（`session.append` + SessionEventMap），不是纯 Cordis 事件。

## 四、命名空间决策（D1，沿用 Task 1）

| 概念 | 命名 |
|---|---|
| Service key | `ctx.sandoreEngine`（`abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`） |
| 事件前缀 | `sandore/*`（Session 事件，`session.append('sandore/…', data)` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`） |
| RPC 方法 | `sandore.*`（`super(ctx, 'sandore')` + `@Remote('method')`） |
| 存储域 | `sandore`（`ctx.storageDomain.open(sandoreDomainSpec)`，definitions/jobs/state 三表） |
| ID 前缀 | `wfl-{uuid}`（workflowId）/ `stg-{uuid}`（stageId）/ `step-{uuid}`（stepId）/ `opt-{uuid}`（outputToId） |

## 五、类型体系与数据模型（产出 `schema.ts`）

Task 2 产出文件 `packages/sandore/workflow/src/schema.ts`：全部 Zod Schema + TS 类型（`WorkflowDefinition`/`WorkflowStage`/`WorkflowStep`/`WorkflowTaskState` 等）。**注意区分**：`schema.ts` 用 **Zod**（`z.infer`），而 Provider 的 `static Config` 用 **schemastery**（沿用 Task 1 `index.ts` 的写法）——两者是不同库（见 §十一）。

### 定义层 `WorkflowDefinition`

```
WorkflowDefinition
  ├── id, name, version, description
  ├── engine?, skills[], mcps[], agents[]      ← V2 扩展字段
  ├── settings: WorkflowSettings { defaultTimeout: number(默认120分钟), maxConcurrentAgents: number(默认4) }
  ├── rules?: Record<string, string>
  ├── gates?: Gates
  ├── stages[]: WorkflowStage
  │     ├── id, name
  │     ├── rules?[], gates?
  │     ├── steps[]: WorkflowStep
  │     │     ├── id, name
  │     │     ├── command?: CommandConfig
  │     │     ├── inputFrom[]: InputFromItem
  │     │     ├── outputTo[]: OutputToItem
  │     │     ├── passThroughVars[]: PassThroughVar
  │     │     ├── timeout, next, defaultExpectation?
  │     │     ├── condition?, branches[]?, loop?
  │     │     └── rules?[], gates?
  │     └── next, defaultExpectation?, condition?, branches[]?, loop?
  └── steps[]?                                ← V2 顶级 Step 定义（与 stages 交叉引用）
```

**CommandConfig 五种类型（V2）**——`agent`（promptText=Agent 名 + agentParamsTemplate? + providerId? + modelId?）、`prompt`（promptText + providerId? + modelId?）、`shell`（command）、`skill`（promptText=技能名）、`mcp`（promptText=MCP 名）。**Task 2 仅实现 `shell` + `prompt` 两种**，agent/skill/mcp 为 Task 3。

### 运行时状态 `WorkflowTaskState`

持久化到 `state` 表（key=instanceId）的完整状态快照：`taskId(=instanceId), jobId, workflowId, cwd, status(7 态), originalInput, currentStageId, executedSteps[]: ExecutedStepDefault, stageInfos[]: StageInfo, pendingQueue[]: string, visitCounts, passThroughVars, stageContracts: Record<string, StageContract>, createdAt, updatedAt`（设计文档还含 pendingInteractions/activeLoopStack 等，Task 2 仅用线性相关子集；迁移后 `permissionMode` 废弃、`pausedStepIds` 改名 `pausedChildIds`）。

### 其他关键类型

- `ExecutedStepDefault`（Task 1 已声明于 `types.ts`，深字段本 Task 收紧）：`{ type:'default', id, stepId?, stageId, name, status, command?, inputFrom?, outputTo?, passThroughVars?, sessionMeta?, finalizeMeta?, visitCount, branchMeta?, error?, pausedAt?, resumedAt?, resumePrompt?, sessionMessages?, pauseEntryId?, loopIteration?, loopMeta?, retryHistory?, parentSessionId? }`。
- `StageContract`（Task 1 已声明）：`{ stageId, stageName, status, artifacts[]: { stepId, outputToId, files, returnPrompt? }, passThroughVars, contractArtifacts, completedAt, errorDetail? }`。
- `StepStatus` / `StageInfo.status` = `'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`。
- `DagNodeRef`：`{ kind:'stage'|'step', stage, step?, id, name, next?, condition?, branches?, loop? }`——Stage 与 Step 在 DAG 调度层统一视图。
- `SandoreError extends HarnessError`（对齐 `WorkflowError`）：`{ fatal: boolean }`；错误码含 `YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`CANCELLED` 等（见 overall-design §4.4）。

## 六、YAML 解析（产出 `yaml-parser.ts`）

- `packages/sandore/workflow/src/yaml-parser.ts`：V1/V2 双格式解析 + Zod 验证。
- V1（三级：Stage→Scenario→Task）/ V2（两级：Stage→Step），解析器自动检测格式并转换；V1 自动调用 `convertLegacyToV2`（work.md 命名）。
- 解析后 `WorkflowDefinition` 经 Zod schema 校验；非法 YAML 抛类型化错误（`YAML_PARSE`/`DEFINITION_INVALID`）。
- 类型转换函数：`commandToPromptType(cmd)`（prompt→PromptTemplate、shell→Bash、agent→AgentTemplate、skill→SkillTemplate、mcp→McpTemplate）/ `promptToCommandType(prompt)`（反向）。
- DSH 的 YAML 库：`yaml@^2.9.0`，`import { parseDocument } from 'yaml'`，`parseDocument(text, { prettyErrors: true })`（见 DSH `packages/settings/settings-file/src/index.ts`）。

## 七、定义/Job/实例 CRUD + 持久化（决策 D4）

### 存储域三表（`persistence.ts`）

`ctx.storageDomain.open(sandoreDomainSpec)` 打开一个 `sandore` 域，三表（**经探索确认：一个 domain 可含多表，KvTable 有 `entries()`/`keys()`/`size`**）：

| Table | Key | Value | 说明 |
|---|---|---|---|
| `definitions` | `workflowId`（`wfl-{uuid}`） | `WorkflowDefinitionRecordSchema`（YAML 文本 + 元数据） | `entries()` 列全部定义；YAML 作为 JSON string 存 value |
| `jobs` | `jobId`（uuid） | `JobRecordSchema`（name/workflowId/cwd/enabled/…） | `entries()` 列全部 Job |
| `state` | `instanceId` | `WorkflowTaskStateSchema` | 每实例一条，全量覆盖写入（原 work.json） |

- **决策 D4**：`work.json`（引擎运行时状态）写入 `state` 表（key=instanceId）；SQLite 两张表 + YAML 定义文件 + jobs.json 实例索引一并迁入 `definitions`/`jobs` 表；`chat.json` 用 DSH Session 事件日志（Task 2 不涉及）；`Database` 单例（node:sqlite）/Workflow Mapper/Logger（winston）删除，**引擎不持有 SQLite 连接**。
- **实例清单派生**：某 Job 的实例清单从 `state` 表 `entries()` 按 `jobId` 过滤派生（不维护 jobs.json 索引文件）。

### CRUD 语义（放 `workflow` Host RPC 层，D2）

- 定义 CRUD：`createDefinition`/`listDefinitions`/`updateDefinition`/`deleteDefinition`/`getYaml`/`updateYaml`（输入校验 `CreateWorkflowDefSchema`/`UpdateWorkflowDefSchema`）。
- Job CRUD：`createJob`（自动生成 UUID，校验 workflowId 存在）/`listJobs`（可选按 workflowId 过滤）/`getJob`/`updateJob`/`deleteJob`（校验 `CreateJobSchema`/`UpdateJobSchema`）。
- 实例生命周期：`startInstance`/`listInstances`/`getInstanceState`/`deleteInstance`/`abortInstance`。

### `startInstance` 流程（design.md §4.6）

1. 生成时间戳实例 ID（`YYYYMMDD-HHmmss-xxx`）；2. 读取并解析 Workflow YAML → `WorkflowDefinition`（从 `definitions` 表读 YAML 文本）；3. 创建 `WorkflowEngineV2(definition, originalInput, { jobId, instanceId, cwd })`；4. 注册到内存活跃引擎表；5. `engine.execute()`（异步 fire-and-forget）；6. 返回实例元数据 + 初始引擎状态。**`getInstanceState` 三层回退**：内存活跃引擎 → `state` 表读快照 → legacy 兜底。

## 八、线性工作流执行（产出 workflow 引擎 + microflow 执行器）

### `workflow` 包：Stage 级编排

- `workflow-engine.ts`：`WorkflowEngineV2` 主循环（Stage 级编排）。`execute()`：状态→running → 入队第一个 Stage → Stage 编排循环（取当前 Stage → 创建 `StageExecutor` → `stageExecutor.execute()` 等待完成 → 收集 `StageExecutionResult` 存入 `dagNavigator.stageContracts` → 发射 `sandore/stage-completed` → `tryAdvanceStage()` → 有下一 Stage 入队，无则完成）→ 所有 Stage 完成 → status=completed → 持久化 + `sandore/end`。**Task 2 简化**：Stage 间流转仅跟 `Stage.next`，不评估 condition/branches。
- `dag-navigator.ts`：DAG 导航（`nodeIndex: Map<string, DagNodeRef>` + `pendingQueue` + `stageContracts`）。核心方法：`buildNodeIndex`/`processNode`/`resolveNextNodes`（Loop→Branch→Next→无，**Task 2 仅 Next**）/`enqueueNode`/`enqueueStage`/`isStageAllDone`/`tryAdvanceStage`/`finalizeStageContract`/`resolveCrossStageInput`/`getStageContract`。
- `tryAdvanceStage` 流程：`isStageAllDone(currentStageId)` false 则返回 false → `finalizeStageContract` 生成 StageContract 存入 stageContracts → 发射 `sandore/stage-completed` → 跟 Stage.next 或推断下一 Stage → 入队下一 Stage 第一个 Step。

### `microflow` 包：Stage 内部执行

- `stage-executor.ts`：`StageExecutor`（Stage 内部独立执行器）。输入 `StageExecutorOptions { stageDef, workflowDef, input: StageExecutionInput, sharedState: StageSharedState, engine }`；`StageExecutionInput { originalInput, contractArtifacts, passThroughVars, userChatMessages?, entryStepId? }`；`StageSharedState { cwd, instanceDir, jobId, taskId }`（无 permissionMode）。`execute()`：构建 Stage 内 nodeIndex → 入队起始 Step → Stage 内循环（启动 pendingQueue 节点 → processStageNode → resolveStageNextNodes → persistState → 队列空退出）→ `isStageComplete` → `finalizeStageContract`（聚合 outputTo 产物 + 透传变量）→ 返回 `StageExecutionResult { stageContract, executedSteps, passThroughVars, status, errorDetail? }`。
- `step-runner.ts`：Step 执行器，**Task 2 仅两种类型**：
  - **shell**：`ctx.shell.resolve(request)` + `ctx.shell.run(spec)`（高层 `bash -c`，返回 stdout/stderr 文本）；需 stdin 注入/流式/终端时用 `ctx.subprocess.spawn()`（软依赖）。
  - **prompt**：`ctx.llm.stream(options)`（一次性推理，无需完整会话管理；结构化提示词构建逻辑保留）。

### 13 事件发射顺序（Task 2 触发子集）

Task 2 触发：`sandore/start` → `sandore/stage-start` → `sandore/step-start` → `sandore/step-completed` → `sandore/stage-completed` → `sandore/end`（`step-failed` 在失败时）。Task 4 才触发：`question`/`permission`/`step-paused`/`step-resumed`/`step-retried`/`aborted`。事件发射沿用 Task 1 的 Session `session.append('sandore/…', data)`（必要）+ 可选 Cordis `ctx.emit` 同名事件（不能替代）。

## 九、RPC 接口（决策 D2）

- **Service 层（`ctx.sandoreEngine`）**：仅 11 个实例级操作（Task 1 已声明，Task 2 填充执行逻辑）——`startInstance`/`recoverInstance`/`abortInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`/`getState`。
- **Host RPC（`remote.ts`，`TypertRemoteService` + `@Remote`）**：Task 2 范围 = 定义 CRUD（`listDefinitions`/`createDefinition`/`updateDefinition`/`deleteDefinition`/`getYaml`/`updateYaml`）+ Job CRUD（`listJobs`/`createJob`/`getJob`/`updateJob`/`deleteJob`）+ 实例生命周期（`listInstances`/`startInstance`/`deleteInstance`/`getInstanceState`/`abortInstance`）+ `getArtifacts`（产物查询）+ `listProviders`/`listModels`（复用 `ctx.llm`）。暂停/恢复/重试/交互/讨论为后续 Task。
- 前端通过 `host.call('sandore.listDefinitions', {})` 等 Package-private RPC 调用。

## 十、关键设计决策汇总（本 Task 直接相关）

| 编号 | 决策 | Task 2 落实 |
|---|---|---|
| D1 | `ctx.sandoreEngine` + `sandore/*`，不扩展 `ctx.workflowEngine` | 沿用 |
| D2 | Service 层只暴露 11 实例级操作；定义/Job CRUD 放 `workflow`（Host RPC） | `remote.ts` 实现定义/Job CRUD + 实例生命周期 RPC |
| D3 | Step 会话用 `ctx.subagents.startContinuable()`；临时推理用 `ctx.llm.stream()` | **Task 2 仅 shell/prompt**：shell 用 `ctx.shell.run()`（简单）/`ctx.subprocess.spawn()`（stdin 注入），prompt 用 `ctx.llm.stream()`；agent 类型 Step 用 startContinuable 是 Task 3 才用 |
| D4 | `work.json` 用 storageDomain `state` 表；chat.json 用 Session 事件；SQLite/YAML/jobs.json 迁入 `definitions`/`jobs` 表 | `persistence.ts` 定义 `sandoreDomainSpec` 三表 |
| D5 | 事件/SSE 全用 DSH 零自建 | `sandore/*` Session 事件（`session.append`） |
| 权限修正 | 无 permissionMode；权限由宿主 Session preset 决定 | `static Config` 与 `DagStartRequest` 不加 permissionMode 字段 |

## 十一、DSH 源码范式落点（已核实的参考实现）

以下范式来自 DSH 源码 `D:\project-code\llm\deepseek-harness`，是 design.md 代码块的事实依据：

1. **Service Definition 范式**：`packages/workflow/workflow/src/index.ts`。`import { Context, Service } from '@deepseek-ai/cordis'`；`declare module '@deepseek-ai/cordis' { interface Context { workflowEngine } interface Events { … } }`；`export abstract class WorkflowEngine extends Service { constructor(ctx) { super(ctx, 'workflowEngine') } protected emitWorkflowEvent(name, ...args) }`；`emitWorkflowEvent` 内含 listener 异常捕获（try/catch + `Promise.resolve().catch()`），`SandoreEngine` 继承此安全发射模式（overall-design §6.7）；`WorkflowError extends HarnessError` 带 `fatal` 标志（overall-design §6.8）。

2. **`ctx.storageDomain.open(spec)` 签名（已核实）**：`packages/storage/storage-domain/src/index.ts` 的 `DomainFacility.open<S extends DomainSpec>(spec: S): Promise<Domain<S>>`——域名全局唯一（`already-open` 错误）、调用方持有句柄并用 `Domain.close()` 释放（通常作为 `ctx.effect` disposer）、每次写入后触发 `domain/changed` 事件。`spec` 由 `defineDomain({ name, version, tables })` 声明，表用 `domainTable<K, V>(zodSchema)`；**value schema 是 zod（`ZodType`/`z.infer`），不是 schemastery**（spec.ts 注释明确「Plugin `Config` stays schemastery」）。`Domain.table(name)` 返回 `KvTable`：`get(key)/put(key, value)/delete(key)/update(key, fn)/entries()/keys()/size`（`packages/storage/storage-domain/src/domain.ts`）。

3. **`ctx.shell.run(spec)` 签名（已核实）**：`packages/shell/shell/src/index.ts` 的 `ShellExecutor`——`resolve(request: ShellExecRequest): ShellExecSpec`（先 resolve 填默认值/cap）→ `run(spec: ShellExecSpec): Promise<ShellRunResult>`。`ShellExecRequest { command, workdir?, timeoutMs?, stdoutMaxBytes?, signal?, stdin?, env?, dshEnv?, sandboxPolicy? }`；`ShellRunResult { exitCode, signal, timedOut, aborted, timeoutMs, stdout: CollectedOutput, stderr: CollectedOutput, sandbox? }`（`packages/shell/shell/src/types.ts`）。非零退出/超时/中止**resolve 而非 reject**（仅基础设施故障才 reject）。

4. **`ctx.llm.stream(options)` 签名（已核实）**：`packages/llm/llm/src/index.ts` 的 `LlmRuntime.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；`GenerateOptions { provider, model, messages: Message[], system?, tools?, temperature?, maxTokens?, stop?, signal?, reasoningEffort?, sessionId?, purpose? }`（`packages/llm/llm/src/types.ts`）；另有 `listProviders(): LlmProviderInfo[]`、`listModels(provider): Promise<LlmModelInfo[]>`。

5. **`@Remote` RPC 范式（已核实）**：`packages/typert/protocol/src/index.ts` 的 `TypertRemoteService`（`protected constructor(ctx, serviceKey)` → `super(ctx, serviceKey)` + `bindTypertRemote(this, this.name)`）与 `Remote(exportName)` 方法装饰器（wire namespace = serviceKey，方法名 = export name）。Task 1 的 `remote.ts` 已正确使用（`super(ctx, 'sandore')` + `@Remote('ping')`）。

6. **YAML 库**：DSH 用 `yaml@^2.9.0`，`import { Document, parseDocument } from 'yaml'`，`parseDocument(text, { prettyErrors: true })`（`packages/settings/settings-file/src/index.ts`）。

7. **依赖注意点（已核实）**：DSH `packages/storage/storage-domain/package.json` 用 `zod@^4.4.3`；sandore 的 `workflow/package.json` 当前 peerDependencies 仅有 `@deepseek-ai/schemastery: 3.18.1`，**未列 `zod`**——`schema.ts` 用 Zod 时需将 `zod` 加入依赖声明。schemastery 用于 Provider `static Config`（沿用 Task 1）。

## 十二、Task 2 验证标准（完成门槛）

1. **定义/Job CRUD**：RPC 能创建/列出/删除定义与 Job；`startInstance` 创建实例并写入存储域 `state` 快照（`getInstanceState` 读回）。
2. **线性执行**：能执行「shell Step → prompt Step」线性工作流到 `completed`；`sandore/*` 事件按序发射（start → stage-start → step-start → step-completed → … → end）。
3. **持久化**：storageDomain 读回 `state` 快照，含完整 `executedSteps` 记录。
4. **类型/YAML**：能解析 V2 示例 YAML，非法 YAML 抛类型化错误。

> 设计文档 §7 具体验证路径：创建含两个 Stage 的工作流定义（Stage 1 = shell Step，Stage 2 = prompt Step）→ YAML 解析 + Zod 验证 → 创建 Job 关联 → `startInstance` → shell 完成 → Stage 推进 → prompt LLM 推理完成 → Stage 推进 → status=completed → `getInstanceState` 确认 status=completed 且 executedSteps 含两个已完成 Step → storageDomain 读回快照确认完整记录。
