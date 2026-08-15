# execution-03（线性工作流执行）探索结果

## 一、需求理解（What / Boundaries / Goal）

- **What**：实现 sandore 引擎最小可用（Task 2）的「线性工作流执行」部分。产出 4 个文件：
  - `microflow` 包 `step-runner.ts`：单 Step 执行器（shell / prompt 两种类型）。
  - `microflow` 包 `stage-executor.ts`：Stage 内部顺序执行 Step + 组装 StageContract。
  - `workflow` 包 `dag-navigator.ts`：nodeIndex + `tryAdvanceStage`（跟随 `Stage.next`）。
  - `workflow` 包 `workflow-engine.ts`：`SandoreEngineRuntime`（Stage 级线性主循环、`sandore/*` 事件双发、`persistState`、childId 占位合成 sessionMeta）。
- **Boundaries**：仅 `microflow` + `workflow` 两包内的执行层；不含分支/循环/agent/skill/mcp/finalize/交互/重试/崩溃恢复（后续 Task）。底层全部走 DSH `ctx.*` 服务。
- **Goal**：精确获取 DSH 源码中 `ctx.shell` / `ctx.llm` / `ctx.sessions` 的 API 签名、`createUserMessage` 构造、`sandore/*` 事件发射范式、AbortSignal 传递方式，以及 Task 1 骨架已声明的类型/事件/存储接口，供实现时准确对齐。

> 注：`furina config show exploration.specification` 返回空数组 `[]`（无本地/技能/URL 规格材料配置），故按 exploreContent 的显式指向，直接探索 DSH 源码（`D:\project-code\llm\deepseek-harness`）与 sandore 现有骨架（Task 1）。

---

## 二、Task 1 骨架现状（`packages/sandore/workflow` 已存在）

execution-03 需与以下已存在文件衔接（均为绝对路径）：

### 2.1 seam 与事件双声明 — `workflow/src/index.ts`

- 抽象类 `SandoreEngine extends Service`（`super(ctx, 'sandoreEngine')`），11 个实例级方法：
  `startInstance(request): DagRun`（同步返回）、`recoverInstance`、`abortInstance`、`replyQuestion`、`replyPermission`、`pauseStep`、`resumeStep`、`pauseAllSteps`、`resumeAllSteps`、`retryStep`、`getState(instanceId): DagInstanceState`。
- 13 个 `sandore/*` 事件已在两处 declaration-merge 声明：
  - Cordis `Events`（`ctx.emit` 用，多参数、首参 `DagRunInfo`）：
    `'sandore/start'(info)`、`'sandore/stage-start'(info, stageId)`、`'sandore/stage-completed'(info, stageId, contract: StageContract)`、`'sandore/step-start'(info, stepId, childId)`、`'sandore/step-completed'(info, stepId, childId, output: ContentBlock[])`、`'sandore/step-failed'(info, stepId, childId, error: string)`、`'sandore/step-paused'(info, stepId, childId)`、`'sandore/step-resumed'(info, stepId, childId, resumePrompt?)`、`'sandore/step-retried'(info, stepId, mode)`、`'sandore/question'(info, question)`、`'sandore/permission'(info, permission)`、`'sandore/end'(info, result: DagResultInfo)`、`'sandore/aborted'(info)`。
  - Session `SessionEventMap`（`session.append` 用，扁平可序列化对象）：
    例如 `'sandore/step-start': { stepId: string; childId: string }`、`'sandore/step-completed': { stepId; childId; output: ContentBlock[] }`、`'sandore/end': { taskId; jobId; result: DagResultInfo }` 等（见 `index.ts` 51–67 行）。
- 当前默认导出是 `SandoreEngineStub`（11 个方法全部 `throw not implemented`），`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`，`static Config`（schemastery）= `{ defaultTimeoutMs: z.natural().default(7200000), maxConcurrentSteps: z.natural().default(0) }`。
  **execution-03 将用 `SandoreEngineRuntime` 替换该 Stub 作为默认导出**（须补齐 `defaultProvider`/`defaultModel` 可选字段用于 prompt 缺省模型兜底，见 work.md 关键决策）。

### 2.2 类型 — `workflow/src/types.ts`

- `DagRunInfo { taskId; workflowId; jobId }`；`DagStartRequest { workflowId; jobId; originalInput; cwd? }`；`DagRun { instanceId; status: DagRunStatus }`。
- `DagRunStatus = 'pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused'`。
- `DagInstanceState { taskId; jobId; workflowId; status; originalInput; currentStageId; executedSteps: ExecutedStepDefault[]; stageInfos: StageInfo[]; pendingQueue: string[]; createdAt; updatedAt }`。
- `ExecutedStepDefault` 含 `type:'default'`、`id`、`stepId?`、`stageId`、`name`、`status: StepStatus`、`command?`、`inputFrom?`、`outputTo?`、`passThroughVars?`、`sessionMeta?: StepSessionMeta`、`finalizeMeta?`、`visitCount: number`、`error?`、`output?: ContentBlock[]` 等。
- `StepStatus = 'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'`。
- `StageContract { stageId; stageName; status; artifacts: Array<{stepId; outputToId; files; returnPrompt?}>; passThroughVars; contractArtifacts: Record<string,string[]>; completedAt; errorDetail? }`。
- `DagResultInfo { taskId; jobId; status: 'completed'|'failed'|'aborted'; error? }`。

### 2.3 Schema — `workflow/src/schema.ts`

- `CommandConfigSchema` 是 discriminated union（判别字段 `type`，变体字段嵌套在 `value`）：
  `{ type:'shell', value:{ command: string } }`、`{ type:'prompt', value:{ promptText; providerId?; modelId? } }`、`{ type:'agent', value:{ promptText; agentParamsTemplate?; providerId?; modelId? } }`、`{ type:'skill', ... }`、`{ type:'mcp', ... }`。
- `WorkflowDefinitionSchema`（`stages: WorkflowStage[]`、`steps?: WorkflowStep[]`、`settings`、`rules?`、`gates?`、`skills/mcps/agents`）。
- `WorkflowStageSchema`（`id; name; steps: WorkflowStep[]; next?; condition?; branches?; loop?; rules?; gates?`）。
- `WorkflowStepSchema`（`id; name?; command?; inputFrom?; outputTo?; passThroughVars?; timeout?; next?; ...`）。
- `StepSessionMetaSchema = { childId: string; synthetic: boolean; command: z.enum(['shell','prompt','agent','skill','mcp']) }` —— 已为 childId 占位准备（execution-03 填 `{ childId: 'step-{stepId}-{execId}', synthetic: true, command: 'shell'|'prompt' }`）。
- `WorkflowTaskStateSchema`（存储域 `state` 表 value）：`taskId; jobId; workflowId; cwd; status; originalInput; currentStageId; executedSteps; stageInfos; pendingInteractions; pendingQueue; visitCounts; passThroughVars; activeLoopIterationStack; activeLoopNodeId; activeLoopStack; pausedStepIds; stageContracts: Record<string, StageContract>; createdAt; updatedAt`。
- `sandoreDomainSpec = defineDomain({ name:'sandore', version:1, tables:{ definitions, jobs, state } })`。
- 派生 TS 类型：`WorkflowDefinition`/`WorkflowStage`/`WorkflowStep`/`CommandConfig`/`WorkflowTaskState`/`StepSessionMeta` 等。

### 2.4 持久化 — `workflow/src/persistence.ts`

- `SandorePersistence`（`ctx.sandorePersistence`，`static inject = ['storageDomain']`）在 `[Service.init]` 中 `await this.ctx.storageDomain.open(sandoreDomainSpec)`，`ctx.effect(() => () => domain.close())`，暴露 `get state(): KvTable<string, WorkflowTaskState>` 与 `async saveWorkflowState(state: WorkflowTaskState)`（`state.put(state.taskId, state)` 全量覆盖）。
- **`persistState()` 即调用 `ctx.sandorePersistence.saveWorkflowState(快照)`**。

### 2.5 RPC — `workflow/src/remote.ts`

- `SandoreRemote`（`@Remote`），`startInstance(input)` 解析 Job 后调 `this.ctx.sandoreEngine.startInstance(request)` 并**同步返回 `DagRun`**——故 `SandoreEngineRuntime.startInstance` 必须是同步签名（内部异步 fire-and-forget）。
- `getInstanceState` 直接读 `ctx.sandorePersistence.state.get(instanceId)`（不存在的抛 `SandoreError('NODE_NOT_FOUND')`）。

### 2.6 错误 — `workflow/src/errors.ts`

- `SandoreError extends HarnessError`，`code: SandoreErrorCode`，默认 `fatal: true`。
- 相关 code：`STEP_TIMEOUT`、`STEP_EXECUTION`、`CANCELLED`、`INVALID_OPERATION`、`NODE_NOT_FOUND`、`CYCLE_DETECTED`、`PERSISTENCE_FAILED`（`fatal:false`）。

### 2.7 YAML — `workflow/src/yaml-parser.ts`

- `parseWorkflowYaml(text: string): WorkflowDefinition`（YAML 语法错误 → `SandoreError('YAML_PARSE')`；Zod/引用失败 → `SandoreError('DEFINITION_INVALID', { cause })`）。

### 2.8 microflow 包骨架

- `packages/sandore/microflow/package.json`：目前**无任何 dependencies/peerDependencies**，无 `src/`（仅占位）。
- `packages/sandore/microflow/tsconfig.json`：`rootDir: 'src'`，`outDir: 'lib/types'`。
- 依赖方向约定（design.md §4.2）：运行时 `workflow → microflow`；`microflow → workflow` 仅 `import type`。

### 2.9 测试基建

- 根 `package.json` 已含 `"test": "vitest run"` + devDependency `vitest`。
- 根 `vitest.config.ts`：`include: ['packages/**/*.spec.ts']`，`environment: 'node'`，含标准装饰器转译插件。
- 已有内存 mock：`workflow/tests/mocks/storage-domain.ts` 提供 `MemoryStorageDomain` / `MemoryDomain` / `MemoryKvTable`（`get` 同步、`put/delete/update` await、`open(spec)`）。
- 测试范式见 `persistence.spec.ts`：`new Context()` + `ctx.provide('storageDomain', ...)` + `await ctx.plugin(Plugin)`；`makeState()` 用 `WorkflowTaskStateSchema` 字段全集构造快照。

---

## 三、DSH `ctx.shell` 精确 API（`packages/shell/shell/src/index.ts` + `types.ts`）

包名：`@deepseek-ai/dsh-shell`。

### 3.1 Service 签名

```ts
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) { super(ctx, 'shell') }
  get sandboxMode(): SandboxMode | undefined   // 默认 undefined
  abstract resolve(request: ShellExecRequest): ShellExecSpec
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>
  abstract start(spec: ShellExecSpec): ShellProcess
}
```

- **`run()` 语义**（关键）：仅基础设施故障才 reject；非零退出、超时 kill、中止 kill 都**resolve** 一个 `ShellRunResult`。
- 调用顺序：`const spec = ctx.shell.resolve(request)` → `const result = await ctx.shell.run(spec)`。

### 3.2 请求 / 规格

```ts
interface ShellExecRequest {
  command: string
  workdir?: string | undefined
  timeoutMs?: number | undefined          // 实现层封顶
  stdoutMaxBytes?: number | undefined     // 前台 stdout 捕获预算
  signal?: AbortSignal | undefined        // 触发即 kill 命令
  stdin?: string | undefined              // 写入后关闭
  env?: Record<string, string> | undefined
  dshEnv?: DshEnvironment | undefined
  sandboxPolicy?: SandboxExecutionPolicy | undefined
}

interface ShellExecSpec {                 // resolve 后必填字段已补齐/封顶
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
  dshEnv?: DshEnvironment | undefined
  sandboxPolicy: SandboxExecutionPolicy | undefined
}
```

### 3.3 结果类型（execution-03 直接消费）

```ts
interface ShellRunResult {
  exitCode: number | null                 // 信号致死时 null
  signal: NodeJS.Signals | null
  timedOut: boolean                       // 执行器超时是最先终止原因
  aborted: boolean                        // 调用方 AbortSignal 是最先终止原因（与 timedOut 互斥）
  timeoutMs: number                       // 生效超时（默认/封顶后）
  stdout: CollectedOutput
  stderr: CollectedOutput
  sandbox?: ShellSandboxInfo
}
```

`CollectedOutput`（`@deepseek-ai/dsh-subprocess` 定义，shell 包 re-export）：

```ts
interface CollectedOutput {
  text: string          // 截断时保留尾部
  truncated: boolean
  spillPath?: string    // 完整流文件（截断且可用时）
}
```

---

## 四、DSH `ctx.llm` 精确 API（`packages/llm/llm/src/index.ts` + `types.ts` + `message.ts` + `assembler.ts`）

包名：`@deepseek-ai/dsh-llm`。

### 4.1 Service 签名

```ts
export class LlmRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  listProviders(): LlmProviderInfo[]                    // 同步
  listModels(provider: string): Promise<LlmModelInfo[]> // 异步
  // resolveModelInfo / prepareCall / resolveCallConfig / registerAdapter ...
}
```

- `LlmProviderInfo { id: string; name: string }`。
- `LlmModelInfo { provider: string; id: string; name: string; description?; inputModalities? }`（`id` 即 `GenerateOptions.model`）。
- **三层回退 L3**：`ctx.llm.listProviders()[0]` + `await ctx.llm.listModels(provider)[0]`。

### 4.2 GenerateOptions

```ts
interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'
}
```

- `provider`/`model` **必填**（`resolveCallFor` 要求 `config.model` 必需，DSH 无 SDK 默认模型）。

### 4.3 StreamChunk 聚合为 ContentBlock[]

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }   // 已组装完成的块
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }
```

- **聚合方式**：使用 DSH 官方 `BlockAssembler`（`@deepseek-ai/dsh-llm` 导出）：
  ```ts
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const blocks: ContentBlock[] = assembler.blocks()   // 按流序组装
  const finish: FinishReason = assembler.finish       // 流无 finish 时默认 { kind: 'stop' }
  ```
- `ContentBlock` 派生自 `ContentBlockMap`：`{type:'text',text}` | `{type:'reasoning',text}` | `{type:'image',attachment}` | `{type:'tool-call',id,name,arguments}` | `{type:'tool-result',toolCallId,content,isError?}`（merge-extensible）。

### 4.4 finish reason（终端失败判定）

```ts
type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }   // signal 中止 / ABORTED
  | { kind: 'error'; failure: LlmFailure }     // 终端失败
```

- **`finish.reason.kind === 'error'` 为终端失败**（`aborted` 亦为终止）。`LlmFailure { message; code; status?; providerRetryAfterMs?; requestId? }`。
- `LlmRuntime.adapterStream` 把适配器抛错归一化为终端 finish 块：`signal?.aborted || failure.code === 'ABORTED'` → `{kind:'aborted'}`, 否则 `{kind:'error'}`。

### 4.5 Message / createUserMessage

```ts
interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}
// MessageSource.kind: 'user' | 'plugin' | 'model' | 'tool'
```

构造 helper（`@deepseek-ai/dsh-llm` 导出）：

```ts
function createMessage<T>(input: T & { id?: never }): T & Pick<Message, 'id'>
function createUserMessage<T>(input: T & { id?: never; role?: never }): T & Pick<UserMessage, 'id'|'role'>
function createAssistantMessage(input): AssistantMessage
function createToolResultMessage(input): ToolResultMessage
```

- **prompt Step 用户消息**：`createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] })`（`role: 'user'` 由 helper 固定，id 自动 `crypto.randomUUID()` 并 deep-freeze）。
- `Message[]` 即 `GenerateOptions.messages`。

---

## 五、DSH `ctx.sessions` 精确 API（`packages/core/session/src/index.ts` + `types.ts`）

包名：`@deepseek-ai/dsh-session`（`SessionEventMap` 类型面在 `@deepseek-ai/dsh-session/types`）。

### 5.1 Service 签名

```ts
export class SessionStore extends Service {
  constructor(ctx: Context) { super(ctx, 'sessions') }
  create(id?: SessionId, options?: CreateSessionOptions): Session
  get(id: SessionId): Session | undefined
  list(): Session[]
  fork(source, boundary?, childSessionId?): Session
  prepare(id?, options?): Session
  enter(session): () => void
  announce(session): void
  flush(session): Promise<boolean>
}
```

- `SessionId` 是 branded type（`SessionId(id)` 编译期 cast）。
- `CreateSessionOptions { seed?: readonly SessionEvent[]; meta?: { cwd?; parentSession?; createdAt?; seedLength?; origin?: 'subagent'; delegationDepth?; agentPreset? } }`。

### 5.2 Session.append（事件写入宿主 log 的唯一入口）

```ts
class Session {
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T>
}
```

- `SessionEvent { type; seq; time; data }`；`SessionEventMap` merge-extensible（sandore 已在 `index.ts` 声明 `sandore/*`）。
- **关键**：`sandore/*` 事件是 log-only（非 `user/message`/`assistant/message`/`tool/result` 三类 surface 事件），故 append 时**不需要**第 3 个 `surfaceOpts` 参数——`hostSession.append('sandore/step-start', { stepId, childId })` 即可。
- `data` 必须 lossless-JSON 可序列化（`undefined`/BigInt/循环引用/Map/Set/Date 会抛错）。
- 参考 DSH 同范式（`tool-workflow`）：`session.append.bind(session)` 后窄化泛型签名调用，包一层 try/catch 记录失败并 `ctx.logger.warn`。

---

## 六、事件发射范式（`ctx.emit` + `session.append` 双发）

### 6.1 `ctx.emit` 签名（Cordis）

```ts
emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
```

- observe-only 同步发射（不 await 异步 listener），`@mode emit`。
- sandore `Events` 声明首参为 `DagRunInfo`：例如 `ctx.emit('sandore/step-start', info, stepId, childId)`。
- 参考实现（DSH `WorkflowEngine.emitWorkflowEvent`，`packages/workflow/workflow/src/index.ts`）：`this.ctx.events.dispatch('emit', [name, ...args])` 遍历 listener 逐个 try/catch 包含失败（同步 throw 与异步 rejection 都 `logger.warn`）。

### 6.2 双发封装（design.md D5 / work.md 关键决策）

统一 `emitSandoreEvent(type, info, payload)` 辅助函数：
1. `ctx.emit(type, info, ...)` —— Cordis 进程内，供引擎内部 `ctx.on('sandore/*')`（多参数、首参 `DagRunInfo`）。
2. `hostSession.append(type, payload)` —— Session 事件（扁平可序列化对象，写宿主 log，驱动前端折叠 + apiproxy 透传）。

> 范式出处：`packages/workflow/tool-workflow/src/index.ts` 的 `createWorkflowRecorder` —— 引擎侧 `ctx.emit('workflow/*', info, ...)` 作触发源，consumer 侧 `session.append('tool-workflow/*', data)` 写 log。sandore 的 `ctx.emit` 与 `session.append` 是**同一发射点各写一遍**（不是一侧监听另一侧）。

### 6.3 childId 占位与 sessionMeta

- Task 2 的 shell（`ctx.shell.run`）/ prompt（`ctx.llm.stream`）无子代理 Session，但 `step-start`/`step-completed`/`step-failed` 的 `childId` 为必填 string。
- 规则：`childId = 'step-' + stepId + '-' + execId`，`execId` 为本次执行的唯一短 id（如 `randomUUID().slice(0, 8)`）。
- 写入 `executedSteps[].sessionMeta = { childId, synthetic: true, command: 'shell' | 'prompt' }`（对齐 `StepSessionMetaSchema`）。

---

## 七、AbortSignal 传递

- **shell**：`ShellExecRequest.signal?: AbortSignal` → `resolve(request)` 后进入 `ShellExecSpec.signal`；实现层在 signal 触发时 kill 命令；结果用 `ShellRunResult.aborted`（与 `timedOut` 互斥，first-cause 分类）报告。
- **llm**：`GenerateOptions.signal?: AbortSignal`；适配器必须 honor；`LlmRuntime` 把中止归一化为终态 `finish` 块 `{ kind:'aborted', failure }`（`signal?.aborted || failure.code === 'ABORTED'`），否则 `{ kind:'error', failure }`。所以 prompt Step 可检查 `finish.kind === 'aborted'` 与 `'error'`。
- 引擎实例级 `abortInstance` 通常持有一个 `AbortController`，其 `signal` 同时传入 shell request 与 llm options。

---

## 八、engine 需要参考的 provider/model 三层回退（work.md 关键决策）

prompt Step 缺省模型时（DSH 无 SDK 默认模型，引擎需自兜底）：
- **L1**：Step 定义 `providerId` + `modelId` **成对提供才用**（缺一个整体视为缺省）。
- **L2**：引擎 `static Config` 增加 `defaultProvider`/`defaultModel`（成对配置才用）。
- **L3**：`ctx.llm.listProviders()[0]` + `await ctx.llm.listModels(provider)[0]`（记 warn）。
- 解析结果拼入 `GenerateOptions.provider` / `GenerateOptions.model` 传给 `ctx.llm.stream()`。

---

## 九、Stage/Step 执行相关设计锚点（design.md §5，供实现对齐）

- **Stage 级线性主循环**（Task 2 简化）：入队第一个 Stage → `StageExecutor.execute()` 等待 Stage 内完成 → 收 `StageExecutionResult`（含 `stageContract`、`executedSteps`、`status`、`errorDetail?`）→ 发射 `sandore/stage-completed` → `tryAdvanceStage()` 跟随 `Stage.next` → 有下一 Stage 则入队，无则 `status = completed` → 持久化 + `sandore/end`。
- **StageExecutor**（`microflow`）：`buildStageNodeIndex(stageDef, workflowDef)`、`execute()` 内顺序处理本 Stage 的 Step、`finalizeStageContract()` 组装 `StageContract`（聚合 outputTo 产物 + 透传变量 + `contractArtifacts`）。
- **dag-navigator**（`workflow`）：`nodeIndex: Map<string, DagNodeRef>`（DagNodeRef = `{ kind:'stage'|'step'; stage; step?; id; name; next?; condition?; branches?; loop? }`）、`pendingQueue`、`tryAdvanceStage(): Promise<boolean>`（`isStageAllDone(currentStageId)` → false 返回 false；否则 `finalizeStageContract` 存入 `stageContracts` → 跟随 `Stage.next` 入队下一 Stage 首 Step → 返回 true）。
- **事件顺序**（验证标准）：`sandore/start → sandore/stage-start → sandore/step-start → sandore/step-completed → … → sandore/end`。

---

## 十、关键文件清单（绝对路径）

**sandore 骨架（需衔接）**
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\index.ts`（seam + 13 事件 + Stub）
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\persistence.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\remote.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\errors.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\yaml-parser.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\storage-domain.ts`
- `D:\project-code\llm\sandore\vitest.config.ts`

**DSH API 参考（精确签名出处）**
- `D:\project-code\llm\deepseek-harness\packages\shell\shell\src\index.ts` + `types.ts`（`ShellExecutor` / `ShellRunResult` / `CollectedOutput`）
- `D:\project-code\llm\deepseek-harness\packages\subprocess\subprocess\src\types.ts`（`CollectedOutput` 原始定义）
- `D:\project-code\llm\deepseek-harness\packages\llm\llm\src\index.ts`（`LlmRuntime.stream/listProviders/listModels`）
- `D:\project-code\llm\deepseek-harness\packages\llm\llm\src\types.ts`（`GenerateOptions` / `StreamChunk` / `ContentBlock` / `FinishReason`）
- `D:\project-code\llm\deepseek-harness\packages\llm\llm\src\message.ts`（`Message` / `createUserMessage`）
- `D:\project-code\llm\deepseek-harness\packages\llm\llm\src\assembler.ts`（`BlockAssembler` 聚合 StreamChunk → ContentBlock[]）
- `D:\project-code\llm\deepseek-harness\packages\core\session\src\index.ts` + `types.ts`（`SessionStore` / `Session.append` / `SessionEventMap`）
- `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`（`emitWorkflowEvent` 发射范式）
- `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\index.ts`（`ctx.on` + `session.append` 双发范式）
- `D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\domain.ts`（`KvTable` / `Domain` 接口）
