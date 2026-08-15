# Task 2 引擎最小可用 — 仓库材料探索报告

> 探索类型：repository
> 目标仓库：`D:\project-code\llm\sandore`（沙箱 sandore 设计仓库）+ `D:\project-code\llm\deepseek-harness`（DSH 参考源码）
> 任务来源：`docs/design/task-2-minimal-engine/work.md`
> 输出文件：`furina/changes/task-2-minimal-engine/explore-design/repository.md`

---

## 一、需求理解（Phase 2）

### 1. What（要理解什么）

Task 2 是在 Task 1 骨架（`ctx.sandoreEngine` 抽象类 + 13 事件声明 + 4 包）之上，实现**引擎最小可用**：类型体系（Zod Schema + TS 类型）+ YAML 解析（V1/V2 双格式 + Zod 验证）+ 定义/Job/实例 CRUD + 存储域持久化（work.json 状态快照）+ 线性工作流执行（shell/prompt Step）。

产出落在两个包：

1. `packages/sandore/workflow/`：`schema.ts`（全部 Zod Schema + TS 类型）、`yaml-parser.ts`（V1/V2 解析 + Zod 验证）、`remote.ts`（`@Remote` RPC：定义/Job CRUD + 实例生命周期）、`persistence.ts`（`ctx.storageDomain.open(sandoreDomainSpec)` 三表）、`workflow-engine.ts`（`WorkflowEngineV2` Stage 级编排主循环）+ `dag-navigator.ts`（节点索引 + `tryAdvanceStage`）。
2. `packages/sandore/microflow/`：`stage-executor.ts`（Stage 内顺序执行 Step + StageContract 组装）、`step-runner.ts`（shell/prompt 两种类型）。

**不含**分支/循环/agent/skill/mcp/finalize/交互/重试/崩溃恢复。

### 2. Boundaries（探索范围）

- 范围：sandore 仓库当前代码状态（Task 1 骨架实际落地文件）+ `./furina/`（Task 1 归档的历史参考）+ Task 2 权威规格（`design.md`）+ DSH 源码中 Task 2 所需的 `ctx.*` 服务范式（`storageDomain.open`、`shell.run`、`llm.stream`、`subprocess.spawn`、Typert Remote RPC、`yaml` 解析库）。
- 不在范围：分支/循环（BranchEvaluator/LoopManager）、暂停/恢复/重试、崩溃恢复、交互、SSE、前端 UI、agent/skill/mcp Step（Task 3–5）。

### 3. Goal（探索目的）

准确掌握 Task 2 的落点与 DSH API 真实面，回答：

- sandore 仓库 Task 1 骨架落地后的确切状态（哪些类型是 `unknown` 占位待收紧、包依赖缺口）。
- `sandoreDomainSpec` 三表的正确声明方式（`defineDomain`/`domainTable` 用 zod 而非 schemastery）与 `ctx.storageDomain.open()` 生命周期。
- shell Step 的 `ctx.shell.run()` 与 prompt Step 的 `ctx.llm.stream()` 的真实签名与返回结构。
- Host RPC（`TypertRemoteService` + `@Remote`）的声明方式与请求/响应形态。
- YAML 解析库在 DSH 生态中的既有选型。

---

## 二、探索结果（Phase 3）

### 2.1 仓库材料配置

`furina config show exploration.repository` 返回单元素：

```json
[{ "path": "./furina/", "type": "directory", "description": "The location of Furina Artifacts ... archived changes and ongoing changes ..." }]
```

探索 `./furina/` 结果：

- `furina/changes.json`：当前 active change = `task-2-minimal-engine`（`features: 0`、`todo: 0`、`artifacts: []`）；archive = `task-1-skeleton`（closed，2 features，5 个 artifacts）。
- `furina/changes/task-2-minimal-engine/` 目录当前为空（本探索产出目录 `explore-design/` 为新建）。
- `furina/archive/2026-08-15-task-1-skeleton/` 含 Task 1 完整归档：`proposal.md`/`design.md`/`api.yaml`/`plan.json`/`specs/`（4 spec）/`explore-design/`（repository.md、specification.md、codebase.md、memory.md）/`explore-coding/`。

> 历史参考要点（Task 1 已确立、Task 2 沿用）：命名空间 `ctx.sandoreEngine` / `sandore/*` 事件 / `sandore.*` RPC / 4 包；`sandore/*` 是 **Session 事件**（`session.append` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`）；`step-completed.output` 最终落定为 `ContentBlock[]`（`import type { ContentBlock } from '@deepseek-ai/dsh-llm'`）。

### 2.2 sandore 仓库现状（Task 1 骨架已落地）

`packages/sandore/` 已存在 4 个包（Task 1 已实现，非空）：

```
packages/sandore/
├── workflow/
│   ├── package.json          # @deepseek-ai/dsh-sandore-workflow 0.1.0-rc.6
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # SandoreEngine 抽象类 + 13 事件双声明 + SandoreEngineStub
│       ├── types.ts          # 13 个基础类型（深层依赖以 unknown 占位）
│       └── remote.ts         # SandoreRemote extends TypertRemoteService，@Remote('ping')
├── microflow/                # 空占位（package.json + tsconfig.json，无 src）
├── tool/                     # 空占位（package.json + tsconfig.json，无 src）
└── ui/                       # Client 插件（Task 2 不涉及）
    ├── package.json
    └── src/…
```

#### 2.2.1 `workflow/src/index.ts`（Task 2 的承接面）

- `export abstract class SandoreEngine extends Service { constructor(ctx) { super(ctx, 'sandoreEngine') } }`，11 个抽象方法：`startInstance/recoverInstance/abortInstance/replyQuestion/replyPermission/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps/retryStep/getState`。
- 13 个 `sandore/*` 事件双声明：
  - Cordis `Events`（首参 `info: DagRunInfo`）：`step-completed` 已增补 `childId` + `output: ContentBlock[]`；`step-failed/step-paused/step-resumed` 已增补 `childId`。
  - Session `SessionEventMap`（纯数据载荷）：同名 13 事件，载荷与 Task 1 design 一致。
- `SandoreEngineStub`（default export）：`static Config: z<SandoreConfig>`（schemastery：`defaultTimeoutMs: z.natural().default(7200000)`、`maxConcurrentSteps: z.natural().default(0)`，**无 permissionMode**）；`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`。11 方法抛 `not implemented`。

#### 2.2.2 `workflow/src/types.ts`（Task 2 需收紧的占位）

已导出的 13 个基础类型：`DagRunInfo/DagStartRequest/DagRun/DagRunStatus/DagInstanceState/ExecutedStepDefault/StageInfo/StepStatus/StageContract/PendingQuestion/AskUserQuestionPayload/PendingPermission/DagResultInfo`。

**关键占位（Task 2 必须收紧为真实结构）**：以下类型当前为 `unknown` 占位，注释标明「Task 2/3 收紧」：

- `CommandConfig`、`InputFromItem`、`OutputToItem`、`PassThroughVar`、`StepSessionMeta`、`FinalizeMeta`、`BranchMeta`、`SessionMessage`、`RetryRecord`。

`ExecutedStepDefault` 已含完整字段清单（`type:'default'/id/stepId?/stageId/name/status/command?/inputFrom?/outputTo?/passThroughVars?/sessionMeta?/finalizeMeta?/visitCount/branchMeta?/error?/pausedAt?/resumedAt?/resumePrompt?/sessionMessages?/pauseEntryId?/loopIteration?/loopMeta?/retryHistory?/parentSessionId?`），其引用的深层类型即上述占位。

#### 2.2.3 `workflow/src/remote.ts`

`SandoreRemote extends TypertRemoteService { constructor(ctx) { super(ctx, 'sandore') } @Remote('ping') ping(): PingResponse }`。Task 2 需在此扩定义/Job/实例 CRUD 的 `@Remote` 方法。

#### 2.2.4 包版本与依赖缺口（Task 2 实现需注意）

`workflow/package.json`（实测）：

- peerDependencies/devDependencies：`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-session@0.1.0-rc.6`、`@deepseek-ai/dsh-llm@0.1.0-rc.6`、`@deepseek-ai/dsh-typert-protocol@0.1.0-rc.6`、`@deepseek-ai/dsh-agent@0.1.0-rc.6`、`@deepseek-ai/dsh-storage@0.1.0-rc.6`、`@deepseek-ai/schemastery@3.18.1`。

**缺口（Task 2 需新增依赖声明）**：

- `@deepseek-ai/dsh-storage-domain`（`defineDomain`/`domainTable`/`KvTable` 来源）——未声明。
- `zod`（存储域 record schema 用 zod，非 schemastery；DSH 用 `zod@^4.4.3`）——未声明。
- `yaml`（YAML 解析；DSH 用 `yaml@^2.4.2`）——未声明。

根 `package.json`：`packageManager: pnpm@11.7.0`、`engines.node >=22`、`type: module`、scripts `typecheck`（`pnpm -r --if-present run typecheck`）/`build`。`tsconfig.base.json` 关键项：`strict`、`moduleResolution: bundler`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（源码内 import 带 `.ts` 后缀，见 Task 1 代码）。

### 2.3 Task 2 权威规格要点（`docs/design/task-2-minimal-engine/design.md`）

> 该文档已从 `dsh-workflow.md` + `dynamic-workflow-engine.md` 提取重组为自包含规格。以下仅列与实现落点直接相关的要点。

#### 2.3.1 类型体系与数据模型（§2）

- **定义层**（`WorkflowDefinition`）：`id/name/version/description/engine?/skills[]/mcps[]/agents[]/settings{rules?/gates?}` + `stages[]`（`WorkflowStage`：`id/name/rules?/gates?/steps[]/next/defaultExpectation?/condition?/branches[]/loop`）+ 顶级 `steps[]`（交叉引用）。
- **`CommandConfig` 五种类型**：`agent`（`promptText`=Agent 名 + `agentParamsTemplate?` + `providerId?` + `modelId?`）、`prompt`（`promptText` + `providerId?` + `modelId?`）、`shell`（`command`）、`skill`（`promptText`=Skill 名）、`mcp`（`promptText`=MCP 名）。**Task 2 仅实现 shell + prompt**。
- **`DEFAULT_SETTINGS`**：`{ defaultTimeout: 120, maxConcurrentAgents: 4 }`。
- **运行时状态 `WorkflowTaskState`**（写入 `state` 表）：`taskId(=instanceId)/jobId/workflowId/cwd/status('pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused')/originalInput/currentStageId/executedSteps[]/stageInfos[]/pendingQueue[]/visitCounts/passThroughVars/stageContracts/…/createdAt/updatedAt`。（迁移 DSH 后废弃 `permissionMode`/`userChatMessages`/`defaultSessionMeta`。）
- **`StageContract`**：`stageId/stageName/status/artifacts[]/passThroughVars/contractArtifacts/completedAt/errorDetail?`——已在 Task 1 `types.ts` 中落地。
- **Step 状态机**：`blocked → ready → running → (interacting) → completed`，旁路 `failed/paused/aborted`；`StageInfo.status`/`ExecutedStepDefault.status` 共用 `StepStatus`（7 态）。

#### 2.3.2 YAML 解析（§3）

- V1（Stage→Scenario→Task 三级）/ V2（Stage→Step 两级）双格式，自动检测并 `convertLegacyToV2`。
- 解析后经 **Zod schema** 运行时验证；非法 YAML 抛类型化错误（`YAML_PARSE` / `DEFINITION_INVALID`）。
- `commandToPromptType`/`promptToCommandType` 转换函数（Task 2 只需 prompt/shell 映射）。

#### 2.3.3 CRUD + 持久化（§4）

- **D4 三表**（`sandoreDomainSpec`）：`definitions`（key=`workflowId`，value=`WorkflowDefinitionRecord`{YAML 文本 + 元数据}）、`jobs`（key=`jobId`，value=`JobRecord`）、`state`（key=`instanceId`，value=`WorkflowTaskState` 快照）。
- **实例清单从 `state` 表派生**（按 `jobId` 过滤 `entries()`），不再维护 jobs.json。
- **定义/Job CRUD 放 Host RPC 层**（D2）；Service 层（`ctx.sandoreEngine`）只暴露 11 个实例级操作。
- 定义 CRUD：`createWorkflowDef/listWorkflowDefs/getWorkflowDef/updateWorkflowDef/deleteWorkflowDef/getWorkflowYaml/updateWorkflowYaml/importWorkflowFromYaml`。
- Job CRUD：`createJobDef/listJobDefs/getJobDef/updateJobDef/deleteJobDef`。
- 实例生命周期：`listInstances/startInstance/deleteInstance/getInstanceState/abortInstance`；`startInstance` 生成 `YYYYMMDD-HHmmss-xxx` 实例 ID → 解析 YAML → 创建 `WorkflowEngineV2` → `engine.execute()`（异步）→ 写入 `state` 表快照。

#### 2.3.4 线性工作流执行（§5）

- `WorkflowEngineV2.execute()` 主循环 = **Stage 级编排**：入队第一个 Stage → 创建 `StageExecutor` → `stageExecutor.execute()` → 收集 `StageExecutionResult` → `tryAdvanceStage()`（Task 2 仅跟 `Stage.next`，不评估 condition/branches）→ 下一 Stage 或无则 completed。
- `StageExecutor`：Stage 内部顺序执行 Step（Task 2 简化：无 Stage 内 DAG 分支/循环），`buildStageNodeIndex`/`processStageNode`/`resolveStageNextNodes`/`isStageComplete`/`finalizeStageContract`/`resolveCrossStageInput`。
- `WorkflowDagNavigator`：`nodeIndex: Map<string, DagNodeRef>` + `pendingQueue` + `tryAdvanceStage`；`resolveNextNodes` 优先级 Task 2 仅处理 `Next`。
- **Step 执行器映射**（D3，Task 2 范围）：
  - `shell`：简单命令用 `ctx.shell.run()`；需 stdin 注入/流式/终端用 `ctx.subprocess.spawn()`。
  - `prompt`：用 `ctx.llm.stream()`（一次性推理，无需完整会话管理）。
  - agent/skill/mcp 暂不实现。
- **13 事件按序发射**：`start → stage-start → step-start → step-completed → … → end`。

#### 2.3.5 RPC 接口（§6）

Task 2 范围需在 `remote.ts` 实现的 `@Remote` 方法：

- 定义：`listDefinitions/createDefinition/updateDefinition/deleteDefinition/getYaml/updateYaml`。
- Job：`listJobs/createJob/getJob/updateJob/deleteJob`。
- 实例：`listInstances/startInstance/deleteInstance/getInstanceState/abortInstance`。
- （`getDiscussion/addChatMessage/getArtifacts/replyQuestion/replyPermission/pauseStep/…/listProviders/listModels` 为后续 Task。）

#### 2.3.6 验证标准（§7）

1. RPC 创建/列出/删除定义与 Job；`startInstance` 创建实例并写入存储域 `state` 快照（`getInstanceState` 读回）。
2. 执行「shell Step → prompt Step」线性工作流到 `completed`；`sandore/*` 事件按序发射。
3. 持久化：storageDomain 读回 `state` 快照，含完整 `executedSteps` 记录。
4. 类型/YAML：解析 V2 示例 YAML，非法 YAML 抛类型化错误。

### 2.4 关键硬约束（贯穿 Task 2）

1. **纯插件，不改 DSH 源码**；**零外部 Agent SDK**，全用 DSH `ctx.*` 服务。
2. 沿用 Task 1 命名：`ctx.sandoreEngine` / `sandore/*` / `sandore_*`（工具，Task 4）/ `sandore.*`（RPC）/ 4 包。
3. **无 `permissionMode`**：`static Config` 与 `DagStartRequest` 不加该字段；权限由宿主 Session 的 permission preset 决定（Step 子代理继承父级）。
4. 引擎**不直接持有 SQLite 连接**：持久化走 `ctx.storageDomain.open(sandoreDomainSpec)`。

### 2.5 DSH 参考源码范式（逐项源码实证）

> 参考源码根目录：`D:\project-code\llm\deepseek-harness`

#### 2.5.1 storageDomain（Task 2 持久化核心）

**来源**：`packages/storage/storage-domain/src/{spec.ts,index.ts,domain.ts}`；参考用例 `packages/workspace/workspace/src/{spec.ts,index.ts}`、`packages/feedback/message-feedback/src/index.ts`。

**API 面**（实测）：

```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
// record schema 用 zod（zod@^4.4.3），NOT schemastery
import { z } from 'zod'

export const sandoreDomainSpec = defineDomain({
  name: 'sandore',            // 必须匹配 UNIT_NAME_RE
  version: 1,                 // 非负整数
  tables: {
    definitions: domainTable<string, WorkflowDefinitionRecord>(workflowDefinitionRecordSchema),
    jobs: domainTable<string, JobRecord>(jobRecordSchema),
    state: domainTable<string, WorkflowTaskState>(workflowTaskStateSchema),
  },
})
```

- `defineDomain` 在模块加载时校验：域名/表名须匹配 `UNIT_NAME_RE`、`version` 非负整数、global schema 不得接受 `null`（`null` 是「从未写入」哨兵）。
- `ctx.storageDomain.open(spec): Promise<Domain<S>>` —— 拒绝重名打开（`already-open`）、解析 backend 路由、要求 `kv` facet、按 zod schema 校验每条已存记录（`invalid-record` 带 table/key）。**调用方持有句柄并负责 `Domain.close()`**（通常作为 `ctx.effect` disposer）。
- `Domain.table(name): KvTable<K,V>`：`get(key)`（同步，内存）、`put(key,value)`、`update(key,fn)`（原子 read-modify-write，缺失 key 抛 `missing-key`）、`delete(key): Promise<boolean>`、`entries()`/`keys()`/`size`（snapshot 迭代，支持全量列出）。
- 每次写入后发 `domain/changed` 事件（`put`/`deleted` 操作 + 记录值）。

**生命周期范式**（`WorkspaceRegistry` / `MessageFeedbackService` 实测）：

```ts
protected async [Service.init](): Promise<void> {
  const domain = await this.ctx.storageDomain.open(sandoreDomainSpec)
  this.ctx.effect(() => () => domain.close(), 'sandore.domainClose')
  this.table = domain.table('definitions')
}
```

> **关键差异**：`DomainSpec.tables` 的 `valueSchema` 是 **zod**（`ZodType<V>`）；插件 `Config` 才是 **schemastery**。Task 2 的 `persistence.ts` 需同时引入 `zod`（record schema）与现有 schemastery（Config）。当前 `workflow/package.json` 未声明 `zod` 与 `@deepseek-ai/dsh-storage-domain`（见 2.2.4）。

#### 2.5.2 shell（Task 2 shell Step）

**来源**：`packages/shell/shell/src/{index.ts,types.ts}`（`ctx.shell` seam）；`CollectedOutput` 由 `@deepseek-ai/dsh-subprocess` re-export。

**API 面**（实测）：

```ts
// 请求（未填充默认值）
interface ShellExecRequest {
  command: string
  workdir?: string
  timeoutMs?: number        // 实现会 cap
  stdoutMaxBytes?: number
  signal?: AbortSignal
  stdin?: string            // 写入 stdin 后关闭；缺省为空
  env?: Record<string, string>
  dshEnv?: DshEnvironment
  sandboxPolicy?: SandboxExecutionPolicy
}

abstract class ShellExecutor extends Service {
  get sandboxMode(): SandboxMode | undefined
  abstract resolve(request: ShellExecRequest): ShellExecSpec
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>
  abstract start(spec: ShellExecSpec): ShellProcess
}
```

- `ShellRunResult`：`exitCode: number|null`、`signal: NodeJS.Signals|null`、`timedOut: boolean`、`aborted: boolean`、`timeoutMs`、`stdout: CollectedOutput`、`stderr: CollectedOutput`、`sandbox?`。**非零退出/超时/abort 都 resolve 结果而非 reject**（仅基础设施失败 reject）。
- `CollectedOutput`：`{ text: string; truncated: boolean; spillPath?: string }`（`text` 为截断时的尾部）。

> **与设计文档的细微差异（供实现注意）**：`dsh-workflow.md §5.3` 称「`ctx.shell.run()` 无 stdin 注入」，但实测 `ShellExecRequest` **含 `stdin?: string`**（「写入 stdin 后关闭」）。Task 2 仅需简单命令，用 `ctx.shell.resolve(request)` + `ctx.shell.run(spec)` 即可；`ctx.subprocess.spawn()` 仅在需要原始 stdio 流/终端时使用。

#### 2.5.3 llm（Task 2 prompt Step）

**来源**：`packages/llm/llm/src/{index.ts,types.ts}`（`ctx.llm`，包 `@deepseek-ai/dsh-llm`）。

**API 面**（实测）：

```ts
// GenerateOptions（必需 provider/model/messages）
interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: Message[]          // 有序对话消息
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'
}

class LlmRuntime extends Service {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  prepareCall(config: LlmCallConfig, signal?): Promise<PreparedLlmCall>
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
}
```

- `stream()` 返回 `AsyncIterable<StreamChunk>`；`StreamChunk` = `{type:'block-start', index, blockType}` / 增量 delta / `{type:'block-end', index, block: ContentBlock}`。`LlmRuntime.stream()` 把 adapter 失败归一为 terminal outcome（不 reject）。
- prompt Step 需自建 `GenerateOptions`：`provider`/`model` 来自 Step 的 `providerId?`/`modelId?`（缺省需解析默认 provider/model，`ctx.llm.listProviders()/listModels()/resolveModelInfo()`），`messages` 来自结构化提示词构建（`## 你的任务` + `## 参考信息` + `## 前置Steps输出与产物` 等，§5.5 结构化模板）。
- `ContentBlock`/`Message` 从 `@deepseek-ai/dsh-llm` 导入（已在 Task 1 依赖中声明）。

#### 2.5.4 subprocess（shell Step 需 stdin/流式时的备选）

**来源**：`packages/subprocess/subprocess/src/{index.ts,types.ts}`（`ctx.subprocess`）。

**API 面**（实测）：

```ts
abstract class SubprocessRuntime extends Service {
  resolveExecutable(command, env?, signal?): Promise<string>
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  spawnTerminal(spec): Promise<SubprocessTerminalHandle>
}

interface SubprocessSpawnSpec {
  argv: readonly string[]                 // argv[0] 为程序；不 shell 解释
  cwd: string
  stdio: { stdin: 'ignore'|'pipe'|{data:string}; stdout/stderr: 'pipe'|'inherit'|SubprocessCollect }
  graceMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}
```

- `SubprocessHandle`：`pid`、`stdin`（pipe 时）/`stdout`/`stderr`、`collected: {stdout?/stderr?: SubprocessOutputReader}`（offset-based 非消费读）、`done: Promise<SubprocessOutcome{exitCode,signal}>`、`terminate()`（SIGTERM→grace→SIGKILL 树级）、`waitForExit()`。
- Task 2 简单命令**不用**此层；`ctx.shell.run()` 足够。

#### 2.5.5 Typert Remote RPC（Task 2 remote.ts）

**来源**：`packages/typert/protocol/src/{index.ts,types.ts}`；参考 `packages/feedback/message-feedback/src/index.ts`。

**API 面**（实测）：

```ts
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export abstract class TypertRemoteService extends Service {
  // constructor(ctx, serviceKey)：serviceKey 即 wire namespace（默认）
}

// @Remote('method') 或 @Remote('exportName')；要求 public 实例方法 + string 方法名
class SandoreRemote extends TypertRemoteService {
  constructor(ctx) { super(ctx, 'sandore') }   // 端点前缀 sandore/

  @Remote('listDefinitions')
  async listDefinitions(): Promise<...> { }     // 零参方法

  @Remote('createDefinition')
  async createDefinition(request: CreateDefinitionRequest): Promise<...> { }  // 单参（request 对象）
}
```

- 端点 = `<namespace>/<method>`（如 `sandore.listDefinitions`）。方法可为 async、返回 `Promise<Result>`；参数形态为零参或单个 request 对象（message-feedback 的 `@Remote('list')/('put')/('delete')` 均为单参 request + async）。
- `Remote` 装饰器只支持 public 实例方法 + string 方法名；`exportName` 可选。

#### 2.5.6 YAML 解析库

**来源**：`packages/skill/skill-filesystem/src/index.ts`（`import { parse as parseYaml } from 'yaml'`），依赖 `yaml@^2.4.2`。DSH 生态统一用 `yaml`（非 `js-yaml`）。Task 2 的 `yaml-parser.ts` 应声明 `yaml` 依赖（当前 sandore workflow 包未声明）。

### 2.6 关键设计决策汇总（Task 2 相关）

| 编号 | 决策 | 说明 |
|---|---|---|
| D1 | 新引擎 `ctx.sandoreEngine` + `sandore/*` 事件 | 不扩展 `ctx.workflowEngine` |
| D2 | Service 层只暴露 11 个实例级操作 | 定义/Job CRUD + 讨论/产物查询放 Host RPC 层（`remote.ts`） |
| D3 | Step 会话：agent 用 `ctx.subagents.startContinuable()`（Task 3）；Task 2 仅 shell/prompt | shell 用 `ctx.shell.run()`（简单）/`ctx.subprocess.spawn()`（stdin）；prompt 用 `ctx.llm.stream()` |
| D4 | `work.json` → `state` 表（key=instanceId）；SQLite 两表 + YAML 文件 + jobs.json → `definitions`/`jobs` 表 | 引擎不持有 SQLite 连接；实例清单从 `state` 表派生 |
| D5 | 事件/SSE 全用 DSH，零自建 | `sandore/*` 为 Session 事件（`session.append`） |
| D9 | 主代理 = 工作流编排器，身份不切换 | 无 `default-session-mounted` 事件 |
| — | **无 `permissionMode`**（权限修正） | `static Config`/`DagStartRequest` 不加该字段；权限由宿主 Session preset 决定 |

### 2.7 验证标准对应的落点

work.md §验证标准 → 对应 DSH 范式：

- RPC 创建/列出/删除定义与 Job → 2.5.5（`TypertRemoteService` + `@Remote`，单参 request + async）。
- `startInstance` 写 `state` 快照 / `getInstanceState` 读回 → 2.5.1（`defineDomain` 三表 + `domain.table('state').put/get`）。
- 「shell Step → prompt Step」线性工作流到 `completed`，事件按序 → 2.5.2（`ctx.shell.run()`）+ 2.5.3（`ctx.llm.stream()`）+ Task 1 已建的 13 事件双声明。
- 解析 V2 YAML / 非法 YAML 抛类型化错误 → 2.5.6（`yaml` 包 `parse`）+ Zod 校验 + `SandoreError('YAML_PARSE'/'DEFINITION_INVALID')`。

---

## 三、关键结论

1. **Task 1 骨架已落地**：`ctx.sandoreEngine` 抽象类（11 方法）、13 事件双声明、`SandoreEngineStub`（Config/inject 已含 `storageDomain`）、`SandoreRemote@Remote('ping')`、13 基础类型均已存在。Task 2 在既有文件上扩展，不改抽象类签名与 13 事件名。
2. **类型收紧点明确**：`types.ts` 中 `CommandConfig/InputFromItem/OutputToItem/PassThroughVar/StepSessionMeta/FinalizeMeta/BranchMeta/SessionMessage/RetryRecord` 9 个 `unknown` 占位是 Task 2 收紧对象；`schema.ts` 需按 `design.md §2` 建立全部 Zod Schema + TS 类型（`WorkflowDefinition/WorkflowStage/WorkflowStep/WorkflowTaskState` 等）。
3. **持久化三表用 zod 声明**（关键差异）：`defineDomain`/`domainTable` 的 record schema 是 **zod**（`zod@^4.4.3`），插件 `Config` 才是 schemastery。`workflow` 包需新增依赖 `@deepseek-ai/dsh-storage-domain` + `zod`（以及 YAML 解析的 `yaml`）。`open(spec)` 在 `[Service.init]` 内调用，`ctx.effect` 挂 `domain.close()` disposer。
4. **shell/prompt 执行 API 已确认**：shell 用 `ctx.shell.resolve(request)` + `ctx.shell.run(spec)`（`ShellRunResult.exitCode/stdout.text`；非零退出 resolve 而非 reject）；prompt 用 `ctx.llm.stream(GenerateOptions)`（`AsyncIterable<StreamChunk>`，需 provider+model+messages）。
5. **RPC 形态已确认**：`@Remote('method')` 支持零参或单 request 对象、async 返回 Promise；`super(ctx, 'sandore')` 即 `sandore.*` 命名空间。Task 2 的 remote.ts 按 message-feedback 的「单 request 对象 + async + 业务结果」形态扩展定义/Job/实例 CRUD。
6. **小差异提示**：`ctx.shell.run()` 实测支持 `stdin` 字段（与设计文档「无 stdin 注入」表述略有出入），但 Task 2 简单命令场景不依赖此差异；需 stdin 注入时按设计走 `ctx.subprocess.spawn()`。
