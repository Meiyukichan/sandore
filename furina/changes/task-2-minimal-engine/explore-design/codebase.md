# Task 2 引擎最小可用 — 代码库探索结果

> 探索类型：codebase（代码库材料探索）
> 探索对象：`docs/design/task-2-minimal-engine/work.md` 的内容与要求
> 探索日期：2026-08-15

---

## Exploration Result

（Phase 3：furina-codebase explore）

`furina config show project.sourcecode codebases` 返回：

```
project.sourcecode=src/
codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]
```

- `project.sourcecode` 指向 `src/`，但该目录**不存在**（`find src` 报 `No such file or directory`）。
- 唯一 codebase 元素 `docs/codebase` 为**空目录**（无 `toc.md`、无任何模块/子模块 spec 文档）。
- furina-codebase 的 explore 指令依赖已生成的 code-document tree（`{codebaseDir}/toc.md`）做层级导航；`docs/codebase` 无文档树，因此 **Phase 3 无匹配结果**，转入 Phase 4 手动补充探索。

---

## Supplementary Exploration Result

（Phase 4：手动补充探索 — 目标：Task 2 落点代码现状 + DSH 关键 API 精确签名 + YAML 示例）

### 1. 当前项目代码现状（Task 1 骨架产物）

仓库当前已有 Task 1 的 4 个包 + monorepo 骨架，Task 2 在其上补全。实际代码分布：

```
packages/sandore/
├── workflow/                      # Task 2 主战场（类型/YAML/CRUD/持久化/Stage 编排）
│   ├── package.json
│   ├── tsconfig.json              # rootDir=src, outDir=lib/types, extends 根 tsconfig.base.json
│   └── src/
│       ├── index.ts               # 抽象 SandoreEngine + 13 事件双声明 + 空 Provider 桩
│       ├── types.ts               # 13 个基础类型（深层类型 unknown 占位）
│       └── remote.ts              # SandoreRemote（仅 sandore.ping）
├── microflow/                     # Task 2 建 src/（Stage 内部执行）
│   ├── package.json               # 无 scripts / 无 peerDependencies / 无 src
│   └── tsconfig.json
├── tool/                          # Task 2 不涉及（Task 4）
│   ├── package.json
│   └── tsconfig.json
└── ui/                            # Task 2 不涉及（Task 5）
    ├── package.json
    └── src/...                    # WorkflowButton/WorkflowPanel 占位
```

根目录还有 `package.json`（`pnpm@11.7.0`、`engines node>=22`、scripts `typecheck`/`build`）、`pnpm-workspace.yaml`（`packages: ['packages/sandore/*']`）、`tsconfig.base.json`（strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`）。

#### 1.1 `workflow/src/index.ts`（Task 1 已建，Task 2 沿用并补实现）

关键现状（`D:\project-code\llm\sandore\packages\sandore\workflow\src\index.ts`）：

- `abstract class SandoreEngine extends Service`，`super(ctx, 'sandoreEngine')`；11 个实例级抽象方法已声明：`startInstance` / `recoverInstance` / `abortInstance` / `replyQuestion` / `replyPermission` / `pauseStep` / `resumeStep` / `pauseAllSteps` / `resumeAllSteps` / `retryStep` / `getState`。
- 13 个 `sandore/*` 事件**双声明**已完成：
  - Cordis `Events`（`declare module '@deepseek-ai/cordis'`），首参 `info: DagRunInfo`；
  - Session `SessionEventMap`（`declare module '@deepseek-ai/dsh-session/types'`），纯数据载荷。
- 事件载荷已含 `childId` / `output: ContentBlock[]` 增补（`output` 类型来自 `@deepseek-ai/dsh-llm`）。
- 空 Provider 桩 `export default class SandoreEngineStub extends SandoreEngine`：`static Config: z<SandoreConfig> = z.object({ defaultTimeoutMs: z.natural().default(7200000), maxConcurrentSteps: z.natural().default(0) })`（`z` 来自 `@deepseek-ai/schemastery`）；`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`；11 方法抛 `not implemented`。
- **无 `permissionMode`**（权限修正已落实：`SandoreConfig` 仅 `defaultTimeoutMs`/`maxConcurrentSteps`）。
- **尚无** `emitSandoreEvent` 安全发射 helper（overall-design §6.7 建议对齐 `WorkflowEngine.emitWorkflowEvent` 的 listener 异常捕获模式）。

#### 1.2 `workflow/src/types.ts`（Task 1 已建，Task 2 收紧）

- 已有 13 个基础类型：`DagRunInfo` / `DagStartRequest` / `DagRun` / `DagRunStatus` / `DagInstanceState` / `ExecutedStepDefault` / `StageInfo` / `StepStatus` / `StageContract` / `PendingQuestion` / `AskUserQuestionPayload` / `PendingPermission` / `DagResultInfo`。
- `DagStartRequest` 现状为 `{ workflowId, jobId, originalInput, cwd? }`——**无 `permissionMode`、无 `stagePath`**（注意：design.md §4.6 原文签名含 `stagePath?`/`permissionMode?`，Task 1 实际产物已按权限修正删去；`stagePath` 是否需补由 Task 2 实现确认）。
- 深层依赖类型在 Task 1 以 `unknown` 占位，Task 2 收紧为真实结构：`CommandConfig` / `InputFromItem` / `OutputToItem` / `PassThroughVar` / `StepSessionMeta` / `FinalizeMeta` / `BranchMeta` / `SessionMessage` / `RetryRecord`。
- `ExecutedStepDefault` 已是完整扁平结构（含 `type:'default'`、`stepId?`、`stageId`、`name`、`status`、`command?`、`inputFrom?`、`outputTo?`、`passThroughVars?`、`sessionMeta?`、`finalizeMeta?`、`visitCount`、`branchMeta?`、`error?`、`pausedAt?`、`resumedAt?`、`resumePrompt?`、`sessionMessages?`、`pauseEntryId?`、`loopIteration?`、`loopMeta?`、`retryHistory?`、`parentSessionId?`）。
- `DagInstanceState`（Task 1 已定义）比 design.md §2.2 的 `WorkflowTaskState` 精简——Task 2 需在 `schema.ts` 新建完整 `WorkflowTaskState`（含 `cwd`、`passThroughVars`、`visitCounts`、`stageContracts`、`createdAt/updatedAt` 等）。

#### 1.3 `workflow/src/remote.ts`（Task 2 需替换/扩展）

- 现有 `class SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`（wire namespace = `sandore`）；仅一个 `@Remote('ping')` 端点（`sandore.ping`）。
- 导入范式已确立：`import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'`。
- Task 2 需在同类中新增 `@Remote` 方法（定义/Job/实例 CRUD + 产物 + listProviders/listModels），端点 `sandore.<method>`。

#### 1.4 `microflow` / `tool` 现状

- `microflow/package.json` 仅含 name/version/description/license/type/main/types/exports，**无 `scripts`、无 peerDependencies、无 `src/`**；tsconfig `include: ["src"]` 指向不存在的目录。Task 2 需创建 `microflow/src/`（`stage-executor.ts`、`step-runner.ts`、`index.ts`）并补齐 package.json（`typecheck` script + 依赖）。
- `tool/` 同为占位，Task 2 不涉及。

#### 1.5 依赖缺口（实现 Task 2 前必须补 package.json）

`workflow` 包当前 peerDependencies/devDependencies 实装（`node_modules/@deepseek-ai/` 已安装的包）：
`@deepseek-ai/cordis`、`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-storage`、`dsh-typert-protocol`、`schemastery`。

Task 2 需要的以下依赖**未声明且未安装**：

| 缺失依赖 | 用途 |
|---|---|
| `@deepseek-ai/dsh-storage-domain` | `defineDomain`/`domainTable`/`KvTable`/`Domain`/`ctx.storageDomain`（与 `dsh-storage` 是两个不同包） |
| `zod` | `schema.ts` 的 Zod Schema + storageDomain 的 `valueSchema: ZodType<V>`（DSH 约定：record schema 用 zod，插件 `Config` 用 schemastery） |
| `yaml` 或 `js-yaml` | `yaml-parser.ts`（DSH 两个库都在用：`skill-filesystem` 用 `import { parse } from 'yaml'`，`agent-presets`/`app-boot` 用 `js-yaml`） |

> 版本参考：DSH 源码包 `@deepseek-ai/dsh-storage-domain` 版本 `0.1.0-rc.5`、依赖 `zod`；sandore 各包当前 version 为 `0.1.0-rc.6`。

### 2. Task 2 规格要点（code-level 结论）

（规格细节见同目录 `specification.md`，此处仅列对代码落点有直接约束的结论）

- **产出两包**：`workflow/`（`schema.ts`/`yaml-parser.ts`/`remote.ts`/`persistence.ts`/`workflow-engine.ts`/`dag-navigator.ts`）+ `microflow/`（`stage-executor.ts`/`step-runner.ts`）。
- **D2**：Service 层只暴露 11 个实例级方法（Task 1 已声明）；定义/Job CRUD 走 `workflow` 包的 `@Remote` RPC。
- **D3**：Task 2 仅 shell/prompt——shell 用 `ctx.shell.run()`，prompt 用 `ctx.llm.stream()`（agent 用 `ctx.subagents.startContinuable()` 是 Task 3）。
- **D4**：`work.json` → 存储域 `state` 表（key=instanceId）；SQLite 两张表 + YAML 文件 + jobs.json → `definitions`/`jobs` 表；引擎不持有 SQLite 连接。
- **13 事件沿用 Task 1**（含 `childId`/`output` 增补，无 `default-session-mounted`）；Task 2 需按序触发 `sandore/start` → `stage-start` → `step-start` → `step-completed` → `stage-completed` → … → `end`（失败时 `step-failed`）。
- **CommandConfig 结构**（从 YAML 示例确认，非扁平结构）：`{ type: 'shell'|'prompt'|'agent'|'skill'|'mcp', value: {...} }`；`InputFromItem = { id, path?, regex? }`；`OutputToItem = { id, path?, regex? }`；`PassThroughVar = { name, value, description, refresh? }`。

### 3. DSH 参考源码范式（精确 API 签名，Task 2 直接依赖）

> 来源均为 DSH 仓库 `D:\project-code\llm\deepseek-harness`。以下签名经源码逐行确认。

#### 3.1 `ctx.storageDomain.open` / `defineDomain` / `domainTable` / `KvTable`

来源包 `@deepseek-ai/dsh-storage-domain`（`packages/storage/storage-domain/src/{spec.ts,domain.ts,index.ts}`）。

- `spec.ts` 头部注释明确约定：**「Plugin `Config` stays schemastery; record schemas inside domain specs are zod」**。
- `defineDomain<S extends DomainSpec>(spec: S): S` —— 校验 `name`/`version`/表名匹配 `UNIT_NAME_RE`（= `/^[a-z][a-z0-9_]*$/`），校验 global schema 不接受 `null`。
- `domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>` —— **`K` 是幽灵类型参数（品牌字符串），运行时不存在；value schema 是 zod**。
- `DomainSpec = { name: string; version: number; global?; tables: Record<string, DomainTableSpec> }`；`DomainTableSpec<K,V> = { valueSchema: ZodType<V>; __key?: K }`。

```typescript
// import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const sandoreDomainSpec = defineDomain({
  name: 'sandore',
  version: 1,
  tables: {
    definitions: domainTable<WorkflowId, WorkflowDefinitionRecord>(workflowDefinitionRecordSchema),
    jobs: domainTable<JobId, JobRecord>(jobRecordSchema),
    state: domainTable<InstanceId, WorkflowTaskState>(workflowTaskStateSchema),
  },
})
```

> 注意：design.md §4.3.1 的草图 `definitions: { key: 'string', value: Schema }` 与实际 API 不符——实际是 `domainTable<K, V>(valueSchema)`，key 是幽灵类型，value schema 是 zod。`sandore`/`definitions`/`jobs`/`state` 均满足 `UNIT_NAME_RE`。

`ctx.storageDomain`（`DomainFacility`）与 `Domain`/`KvTable`：

```typescript
// DomainFacility
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>   // 异步；域名全局唯一，重复 open 抛 already-open
get(name: string): DomainImpl | undefined
async closeAll(): Promise<void>

// Domain<S>
readonly name: string
readonly global: DomainGlobalHandleOf<S>
table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S,N>, TableValueOf<S,N>>
close(): Promise<void>

// KvTable<K extends string, V>
get(key: K): V | undefined                       // 同步内存读
entries(): IterableIterator<[K, V]>              // 快照迭代
keys(): IterableIterator<K>
readonly size: number
put(key: K, value: V): Promise<void>             // 全量覆盖，先落盘后改内存再发 domain/changed
delete(key: K): Promise<boolean>                 // 存在才删，返回是否删除
update(key: K, fn: (current: V) => V): Promise<V> // 原子 read-modify-write，缺 key 抛 missing-key
```

生命周期范式（`packages/workspace/workspace/src/index.ts`）：

```typescript
static inject = ['storageDomain', 'sessionPersistence']
protected async [Service.init](): Promise<void> {
  const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
  this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
  this.table = domain.table('workspaces')
  this.global = domain.global
}
```

> 注意：`open` 异步、域名唯一 → 引擎（persistence.ts）与 RPC（remote.ts）必须共享**同一个** domain 句柄；打开时机在 `Service.init`，释放用 `ctx.effect` disposer。`KvTable.put` 全量覆盖（无部分 merge），正好对应 `work.json` 的「全量覆盖」语义。

#### 3.2 `ctx.shell.resolve` / `ctx.shell.run`

来源包 `@deepseek-ai/dsh-shell`（`packages/shell/shell/src/{index.ts,types.ts}`）。

```typescript
abstract class ShellExecutor extends Service {
  constructor(ctx: Context) { super(ctx, 'shell') }
  get sandboxMode(): SandboxMode | undefined
  abstract resolve(request: ShellExecRequest): ShellExecSpec
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>   // 只接受 resolve 后的 spec
  abstract start(spec: ShellExecSpec): ShellProcess
}

interface ShellExecRequest {
  command: string
  workdir?: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  signal?: AbortSignal
  stdin?: string                    // ★ 请求上确有 stdin 字段（供进程内插件注入）
  env?: Record<string, string>
  dshEnv?: DshEnvironment
  sandboxPolicy?: SandboxExecutionPolicy
}

interface ShellRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: CollectedOutput
  stderr: CollectedOutput
  sandbox?: ShellSandboxInfo
}
```

> 关键语义：`run` **只 reject 基础设施故障**——非零退出/timeout/abort 都 resolve 为 `ShellRunResult`。调用顺序必须是 `resolve(request)` → `run(spec)`。
> 设计文档称「`ctx.shell.run()` 无 stdin 注入」——但 `ShellExecRequest` 实际上**有 `stdin` 字段**（进程内插件路径用，模型工具不暴露）。Task 2 简单命令用 `shell.run` 即可；此差异不影响 Task 2，仅作事实记录。

#### 3.3 `ctx.llm.stream` / `GenerateOptions` / `Message` / `ContentBlock` / `StreamChunk`

来源包 `@deepseek-ai/dsh-llm`（`packages/llm/llm/src/{index.ts,types.ts,message.ts,content.ts}`）。

```typescript
// LlmRuntime
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>
listProviders(): LlmProviderInfo[]
listModels(provider: string): Promise<LlmModelInfo[]>
resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>

interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: Message[]          // 必填
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'
}

type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

// ContentBlock（type 可辨识联合）
TextBlock = { type: 'text'; text: string }
ReasoningBlock = { type: 'reasoning'; text: string }
ImageBlock = { type: 'image'; attachment: ImageAttachmentRef }
ToolCallBlock = { type: 'tool-call'; id: CallId; name: string; arguments: string }
ToolResultBlock = { type: 'tool-result'; toolCallId: CallId; content: ContentBlock[]; isError?: boolean }

// Message（不可变）
interface Message { id: MessageId; role: 'system'|'user'|'assistant'; content: ContentBlock[]; source: MessageSource }
createUserMessage(input): UserMessage   // 一次性推理用（crypto.randomUUID() 生成 id）
createMessage(input): Message
```

> prompt Step 的 `ctx.llm.stream()` 需要 `provider` + `model`（来自 CommandConfig.value 的 `providerId?`/`modelId?`；未指定时需引擎从 `ctx.llm.listProviders()/listModels()` 选取默认）。`messages` 必须为 `Message[]`（用 `createUserMessage` 构造），输出从 `block-end`/`text-delta` chunk 聚合为 `ContentBlock[]`（可用 `BlockAssembler` 或手动收集），恰好匹配 `sandore/step-completed` 事件载荷的 `output: ContentBlock[]`。

#### 3.4 `@Remote` / `TypertRemoteService`

来源包 `@deepseek-ai/dsh-typert-protocol`（`packages/typert/protocol/src/index.ts`）。

```typescript
abstract class TypertRemoteService<T = never> extends Service<T> {
  readonly typertRemote: TypertGatewayBinding<this>
  protected constructor(ctx: Context, serviceKey: string, options?: { namespace?: string }) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}

// 装饰器：@Remote('methodName') 标记 public 实例方法为端点（namespace = serviceKey = 'sandore'）
export function Remote(exportName: string): RemoteMethodDecorator
```

> 关键约束：`@Remote` 要求 public 实例方法 + 字符串方法名；方法参数/返回值走 JSON 边界（由 Typert 生成客户端 codec）。Task 1 的 `super(ctx, 'sandore')` 已定 namespace；Task 2 新增方法名即端点 `sandore.<method>`。典型 Provider + RPC 组合参考 `packages/feedback/message-feedback/src/index.ts`（`extends TypertRemoteService` + `static inject` + `static Config` schemastery + `@Remote('list')` 等方法 + `[Service.init]` 打开 domain）。

#### 3.5 `session.append` / `SessionEventMap` / `finalAssistantOutput`

来源包 `@deepseek-ai/dsh-session`（`packages/core/session/src/{index.ts,types.ts}`）与 `@deepseek-ai/dsh-subagent`（`packages/subagent/subagent/src/assistant-output.ts`）。

```typescript
// Session.append —— data 必须 lossless JSON 可序列化
append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts): SessionEvent<T>

// SessionStore（ctx.sessions）
create(id?: SessionId, options?: CreateSessionOptions): Session   // meta.cwd 等
get(id: SessionId): Session | undefined
list(): Session[]

// Session
readonly events: readonly SessionEvent[]   // 追加式日志
readonly header: SessionHeader

// finalAssistantOutput —— 从子代理 Session 事件选最后一条非空 assistant 消息
finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined
```

> Task 2 的 `sandore/*` 事件按 `SessionEventMap`（Task 1 已声明）`session.append` 到「工作流宿主 Session」log。注意：Task 2 的 shell/prompt Step **不创建子代理**（shell 走 `ctx.shell.run`、prompt 走 `ctx.llm.stream`），因此事件载荷里的 `childId`（= 子代理 SessionId）在 Task 2 无对应真实子会话——实现时需决定 shell/prompt Step 的 `childId` 取值（如占位/空串，或 prompt 改用一次性子代理）。`finalAssistantOutput` 是 Task 3 子代理场景才需要；Task 2 prompt Step 的输出直接从 `ctx.llm.stream()` 的 chunk 聚合得到。

#### 3.6 Provider 模式（`static inject` / `static Config` / `Service.init` / 安全事件发射）

来源 `packages/workflow/workflow-worker-thread/src/index.ts` 与 `packages/workflow/workflow/src/index.ts`。

```typescript
class WorkerThreadWorkflowEngine extends WorkflowEngine {
  static inject = ['subagents']
  static Config: z<Config> = z.object({ provider: z.string().default('spawn'), ... })  // schemastery
  constructor(ctx: Context, config: Config) { super(ctx) /* 基类已 super(ctx, 'workflowEngine') */ }
  // ... start() 内 this.emitWorkflowEvent('workflow/start', info)
}
export default WorkerThreadWorkflowEngine
```

```typescript
// WorkflowEngine 基类的安全事件发射（listener 异常捕获）
protected emitWorkflowEvent(name: WorkflowEventName, ...args: unknown[]): void {
  for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
    try {
      const returned = (callback as (...p: unknown[]) => unknown)(...args)
      void Promise.resolve(returned).catch((error) => { this.ctx.logger.warn(...) })
    } catch (error) { this.ctx.logger.warn(...) }
  }
}
```

> Task 2 建议在 `SandoreEngine` 基类补齐 `emitSandoreEvent`（对齐此模式）；Provider 默认导出类、`static inject` + `static Config`（schemastery）+ `super(ctx)` 的注册形态已由 Task 1 桩与 DSH 范式确立。

#### 3.7 `HarnessError`（`SandoreError` 基类）

来源 `packages/llm/llm/src/error.ts`（从 `@deepseek-ai/dsh-llm` 导出）。

```typescript
export class HarnessError extends Error {
  readonly code: string
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
```

> `SandoreError extends HarnessError`（overall-design §4.4）：`constructor(message, code: SandoreErrorCode, options?: ErrorOptions & { fatal?: boolean })`，`fatal` 默认 `true`；错误码含 `YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`PERSISTENCE_FAILED`/`INVALID_OPERATION`/`CANCELLED` 等。

### 4. YAML 示例（V2/V1，`yaml-parser.ts` 的输入规格）

来源 `docs/engine/dynamic-workflow-engine.md` 附录 A（行 5093–5325）。关键结构摘录（V2）：

```yaml
# ── 顶层字段 ──
id: wfl-a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: 全字段代码审查工作流
version: "2.0.0"
description: 覆盖所有 V2 字段的示例工作流
engine: v2
skills: [code-review-skill]
mcps: [filesystem-mcp]
agents: [code-reviewer, code-fixer]
settings: { defaultTimeout: 60, maxConcurrentAgents: 4 }
rules: { chinese-output: "所有输出必须使用中文" }
gates: { maxRetries: 3, primary: { enabled: true }, secondary: { enabled: true, prompt: "..." }, need_confirm: false }

# ── stages[]：Stage 流控 + Stage 级 rules/gates（Task 2 仅用 id/name/steps/next）──
stages:
  - id: stg-11111111-1111-1111-1111-111111111111
    name: 代码分析
    next: stg-22222222-2222-2222-2222-222222222222
    steps:                                   # Stage 内仅 ID + 流控
      - id: step-11111111-1111-1111-1111-111111111111
        next: step-22222222-2222-2222-2222-222222222222

# ── steps[]：顶层完整 Step 定义（与 stages[].steps[] 按 id 交叉引用）──
steps:
  - id: step-11111111-1111-1111-1111-111111111111
    name: 静态分析
    command: { type: shell, value: { command: "npm run lint 2>&1" } }
    inputFrom:
      - { id: ipt-1, path: stg-xxx.step-xxx.opt-xxx }
      - { id: ipt-2, regex: ".*\\.test\\.ts$" }
    outputTo:
      - { id: opt-1, path: "reports/lint.txt" }
      - { id: opt-2, regex: "reports/.*\\.json$" }
    passThroughVars:
      - { name: lintErrorCount, value: "", description: "lint 错误数量", refresh: true }
    timeout: 30
  - id: step-55555555-5555-5555-5555-555555555555
    name: 生成报告
    command: { type: prompt, value: { promptText: "生成最终报告", providerId: provider-xxx, modelId: model-yyy } }
```

V1（三级 `stages > scenarios > tasks`，`prompt: { type: Bash, value: { command } }`）示例见附录 A.2（行 5297–5325）；`convertLegacyToV2()` 将 V1 自动转 V2（旧类型名映射，如 `Bash` → `shell`）。

### 5. 关键结论与缺口（探索汇总）

1. **Task 1 骨架已就位**：`SandoreEngine` 抽象类 + 13 事件双声明 + 13 基础类型 + `sandore.ping` RPC + monorepo 均已在 `packages/sandore/workflow/` 落地；Task 2 是「收紧类型 + 补 schema/yaml/remote/persistence/engine + 建 microflow/src」。
2. **依赖缺口（必补）**：`workflow` 包需新增 peerDependency `@deepseek-ai/dsh-storage-domain`、`zod`、`yaml`（或 `js-yaml`）；`microflow` 包需建 `src/` 并补齐 `scripts` + peerDeps。
3. **zod vs schemastery 分工**：`schema.ts` 的 record schema 与 storageDomain `valueSchema` 用 `zod`（`import { z } from 'zod'`）；Provider 的 `static Config` 用 `@deepseek-ai/schemastery`（默认导入）。两者可共存于不同模块。
4. **storageDomain 域/表 API 与设计草图差异**：实际是 `domainTable<K,V>(valueSchema)`，非 `{ key, value }`；`open` 异步且域名唯一，须在 `Service.init` 打开、`ctx.effect` 关闭、引擎与 RPC 共享同一句柄；`put` 全量覆盖契合 `work.json` 语义。
5. **shell 必须 `resolve` 后再 `run`**；非零退出/timeout/abort 均 resolve 而非 reject；`ShellExecRequest` 实际有 `stdin` 字段（与设计文档「无 stdin 注入」表述有出入，但不影响 Task 2）。
6. **prompt Step 需 `provider`+`model`**（`ctx.llm.stream` 必填），未指定时从 `ctx.llm.listProviders()/listModels()` 选取；输出从 stream chunk 聚合为 `ContentBlock[]` 以填 `sandore/step-completed.output`。
7. **`childId` 张力（注意点）**：Task 2 shell/prompt Step 不创建子代理，但 `sandore/step-start`/`step-completed` 载荷要求 `childId: string`——实现时需确定 shell/prompt 的 `childId` 取值。
8. **`DagStartRequest` 与 design.md §4.6 差异**：Task 1 实际产物为 `{ workflowId, jobId, originalInput, cwd? }`（无 `stagePath?`/`permissionMode?`）；`permissionMode` 按权限修正删除是**正确**的，`stagePath` 是否补由实现按需决定。
9. **`microflow → workflow` 仅 `import type`**（编译期擦除打破循环依赖）；运行时单向 `workflow → microflow`（workflow 调 StageExecutor）。
