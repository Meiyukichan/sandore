# Exploration Result

## Exploration Result

> 说明：`furina config show exploration.reference` 返回空数组 `[]`，故「reference materials configuration」无元素可遍历。但 exploreContent 明确指向两处真实参照物：① `docs/design/task-2-minimal-engine/work.md`（权威规格）+ `docs/design/task-2-minimal-engine/design.md`；② DSH 源码 `D:\project-code\llm\deepseek-harness` 中 shell/llm/sessions 的精确 API。以下按 exploreContent 直接/紧密相关的范围，逐项记录精确签名与范式。

### 一、`ctx.shell` 精确 API（shell Step 用 `resolve(request)→run(spec)`）

源码：`D:\project-code\llm\deepseek-harness\packages\shell\shell\src\index.ts`

```ts
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) { super(ctx, 'shell') }
  get sandboxMode(): SandboxMode | undefined { return undefined }
  abstract resolve(request: ShellExecRequest): ShellExecSpec
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>
  abstract start(spec: ShellExecSpec): ShellProcess
}
```

关键语义（文件头注释）：`run()` 仅在基础设施失败时 reject；非零退出码、超时杀死、abort 杀死都 **resolve** 出一个 `ShellRunResult`（不 reject）。调用约定：`run` 只接 `resolve` 出来的 spec，绝不接原始 request。

源码：`D:\project-code\llm\deepseek-harness\packages\shell\shell\src\types.ts`

```ts
export interface ShellExecRequest {
  command: string
  workdir?: string | undefined
  timeoutMs?: number | undefined
  stdoutMaxBytes?: number | undefined
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  env?: Record<string, string> | undefined
  dshEnv?: DshEnvironment | undefined
  sandboxPolicy?: SandboxExecutionPolicy | undefined
}

export interface ShellExecSpec {
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

export interface ShellRunResult {
  exitCode: number | null            // 进程被信号杀死时为 null
  signal: NodeJS.Signals | null
  timedOut: boolean                  // 执行器超时为「首因」
  aborted: boolean                   // 调用方 AbortSignal 为「首因」（与 timedOut 互斥）
  timeoutMs: number                  // 生效的超时（defaulting/capping 之后）
  stdout: CollectedOutput
  stderr: CollectedOutput
  sandbox?: ShellSandboxInfo
}
```

`CollectedOutput` 来自 subprocess 包（shell 包 re-export），源码 `D:\project-code\llm\deepseek-harness\packages\subprocess\subprocess\src\types.ts`：

```ts
export interface CollectedOutput {
  text: string        // 被截断时保留的是「尾部」
  truncated: boolean  // 是否有字节被丢弃
  spillPath?: string  // 完整流的溢出文件路径（截断且可用时）
}
```

### 二、`ctx.llm` 精确 API（prompt Step 用 `stream(GenerateOptions)`）

源码：`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\index.ts`

```ts
export class LlmRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>   // 经 ctx.waterfall('llm/stream', ...)
  listProviders(): LlmProviderInfo[]                              // 同步
  listModels(provider: string): Promise<LlmModelInfo[]>           // 异步
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle  // 测试 fake adapter 注入点
}
// LlmProviderInfo { id: string; name: string }
// LlmModelInfo { provider: string; id: string; name: string; description?; inputModalities? }
```

`stream()` 的契约（`adapterStream`/`adapterFailureChunk`，index.ts 尾部）：adapter 选择、派发、迭代失败都归一为**终结的 finish chunk**——`finish.reason` 为 `{ kind:'aborted', failure }`（signal 已 aborted 或失败 code 为 `ABORTED`）或 `{ kind:'error', failure }`。`options.signal` 传入并贯穿到 adapter（`resolveCallFor(registration, options, options.signal)`）。

源码：`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\types.ts`

```ts
export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: Message[]           // 按 provider 所见顺序；system 槽之外的对话
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}
export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

export interface ContentBlockMap {
  'text': TextBlock        // { type:'text'; text:string }
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}
export type ContentBlock = ContentBlockMap[ContentBlockType]
```

**聚合范式**（exploreContent 明确要求「StreamChunk 聚合 block-end 为 ContentBlock[]」）：DSH 提供官方 `BlockAssembler`（源码 `D:\project-code\llm\deepseek-harness\packages\llm\llm\src\assembler.ts`，从 `@deepseek-ai/dsh-llm` 导出）。把每个 chunk `push()` 进去，流结束后 `blocks()` 返回按 stream 顺序的 `ContentBlock[]`，`finish` 返回 `FinishReason`（无 finish chunk 时默认 `{kind:'stop'}`）。终端失败判定即 `finish.kind === 'error'`（或 `'aborted'`）。

### 三、`Message` 与 `createUserMessage` 构造

源码：`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\message.ts`（经 `export * from './message.ts'` 从 `@deepseek-ai/dsh-llm` 导出）

```ts
export interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource   // user: {kind:'user'} | plugin | model | tool
}
export interface UserMessage extends Message { readonly role: 'user' }

export function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'>   // 内部 createMessage 补 id（randomUUID）+ role:'user'，deepFreeze
export function createMessage<T extends NewMessage>(input): ...
export function freezeMessage<T extends Message>(message: T): T
```

构造 prompt Step 输入消息的最小用法：`createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })`（消息会被 deep-freeze，不可变）。

### 四、`ctx.sessions` 精确 API（`session.append` 双发通道）

源码：`D:\project-code\llm\deepseek-harness\packages\core\session\src\index.ts`

```ts
export class SessionStore extends Service {
  constructor(ctx: Context) { super(ctx, 'sessions') }
  create(id?: SessionId, options?: CreateSessionOptions): Session   // 缺省 id 时 mint 'session-<n>'
  get(id: SessionId): Session | undefined
  list(): Session[]
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session
  flush(session: Session): Promise<boolean>
}

export class Session {
  readonly header: SessionHeader
  get id(): SessionId
  get events(): readonly SessionEvent[]   // 不可变快照
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T>
}
```

关键点：
- `session.append` 是 `Session` 实例方法（不是 `SessionStore` 的）。`sandore/*` 已在 Task 1 通过 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { … } }` 声明合并为 **log-only 事件**（非 `SurfaceEventType`：`user/message`/`assistant/message`/`tool/result`），因此调用形态是 `session.append('sandore/start', {…})` **不带** surface opts。
- `data` 必须 lossless-JSON 可序列化（BigInt/function/undefined/Map/循环引用等会在 append 处抛错）。
- `SessionStore.create` 返回「已 enter + announce」的 live Session（`session/created` 事件会发出）。Task 2 的「工作流宿主 Session」用 `ctx.sessions.create(hostSessionId, …)` 创建。

### 五、事件发射范式（`ctx.emit` + `session.append` 双发）

Cordis 事件总线签名（源码 `D:\project-code\llm\deepseek-harness\vendor\cordis\src\events.ts`）：

```ts
emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void   // 同步派发，忽略返回值
on<K extends keyof Events>(name: K, listener: Events[K], options?): () => boolean
waterfall<K>(name: K, ...args): ReturnType<Events[K]>
parallel<K>(name: K, ...args): Promise<void>
```

DSH 官方的「安全发射 + 双发」两个范本：

1. `WorkflowEngine.emitWorkflowEvent`（源码 `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`，第 175–186 行）：用 `this.ctx.events.dispatch('emit', [name, ...args])` 逐 listener try/catch 包容，防止单个 listener 故障影响引擎。
2. `tool-workflow` 双发范式（源码 `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\index.ts`）：`ctx.on('workflow/agent-start', …)` 作进程内触发源 → `session.append('tool-workflow/agent-start', data)` 写宿主 Session log。对 log-only 事件，用 `session.append.bind(session)` 窄化泛型以消掉 surface opts。

设计文档要求（`work.md` 关键决策 / `design.md` §5.1A）：封装 `emitSandoreEvent(type, info, payload)` 统一双发——`ctx.emit('sandore/…', info, …)`（Cordis 进程内，首参 `DagRunInfo`）+ `hostSession.append('sandore/…', payload)`（Session 事件，写宿主 log）。`sandore/*` 的 13 个事件签名已在 Task 1 的 `packages/sandore/workflow/src/index.ts` 里双声明（Cordis `Events` + Session `SessionEventMap`），执行侧无需再 declare，直接 `ctx.emit`/`hostSession.append` 即可。

### 六、AbortSignal 传递路径

- shell：`ShellExecRequest.signal` → `resolve` 保留到 `ShellExecSpec.signal` → `run` 在 signal fire 时 kill 命令（`ShellRunResult.aborted = true`）。
- llm：`GenerateOptions.signal` → `stream` 贯穿到 adapter；signal aborted 时归一为 `finish.reason = { kind: 'aborted', failure }`。
- 引擎级：`SandoreEngine.abortInstance(instanceId)` 需桥接 AbortController/AbortSignal 到 Step 执行（Task 2 的 shell/prompt 各 Step 持有一个 signal，abort 时触发）。

### 七、当前 sandore 仓库执行落点（Task 1 已建，execution-03 的直接上下文）

- `D:\project-code\llm\sandore\packages\sandore\workflow\src\index.ts`：13 个 `sandore/*` 事件双声明 + `SandoreEngine` 抽象类（`startInstance(request: DagStartRequest): DagRun` 等 11 个实例级方法）+ 默认导出 `SandoreEngineStub`（`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`，`static Config` 仅 `defaultTimeoutMs`/`maxConcurrentSteps`）。
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`：`DagRunInfo{taskId,workflowId,jobId}`、`DagStartRequest{workflowId,jobId,originalInput,cwd?}`、`DagRun{instanceId,status}`、`DagRunStatus`、`DagInstanceState`、`ExecutedStepDefault`（含 `sessionMeta?`、`output?: ContentBlock[]`）、`StageInfo`、`StageContract`、`DagResultInfo`、`PendingQuestion`/`PendingPermission`。
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`：Zod 全量——`WorkflowDefinitionSchema`/`WorkflowStageSchema`/`WorkflowStepSchema`/`CommandConfigSchema`（五类型 discriminatedUnion，`{ type, value }` 形状）/`WorkflowTaskStateSchema`/`StepSessionMetaSchema{childId,synthetic,command:enum}`/`StageContractSchema`/`sandoreDomainSpec`（definitions/jobs/state 三表）。
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\persistence.ts`：`SandorePersistence`（注册为 `ctx.sandorePersistence`）在 `[Service.init]` 打开 `sandore` 域，暴露 `definitions`/`jobs`/`state` 三个 `KvTable` 句柄 + `saveWorkflowState(state)`（`state.put(taskId, state)` 全量覆盖）。
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\remote.ts`：`SandoreRemote.startInstance` 解析 job 后转发 `ctx.sandoreEngine.startInstance(request)`（同步返回 `DagRun`）。
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\yaml-parser.ts`：`parseWorkflowYaml(text): WorkflowDefinition`（V1 自动转 V2 + Zod + next 引用校验）。
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\errors.ts`：`SandoreError`（`HarnessError` 子类 + `fatal` 标志），code 含 `STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`CANCELLED` 等。
- `D:\project-code\llm\sandore\packages\sandore\microflow\`：**只有 `package.json` + `tsconfig.json`，无 `src/`**（execution-03 要新建 `step-runner.ts` 与 `stage-executor.ts`）。
- 测试基建：根 `vitest.config.ts`（`include: ['packages/**/*.spec.ts']` + 标准装饰器转译插件）；`workflow/tests/mocks/storage-domain.ts` 提供 `MemoryStorageDomain`/`MemoryKvTable`（`ctx.provide('storageDomain', …)` 注入范式，`persistence.spec.ts` 已示范）。shell/llm 的 mock 同样走 `ctx.provide('shell'|'llm', fake)`。

### 八、execution-03 要实现的目标（对 exploreContent 的需求转述）

1. **microflow/step-runner.ts**：shell Step 用 `ctx.shell.resolve(request)` → `run(spec)`，读 `ShellRunResult{exitCode, stdout: CollectedOutput{text,truncated}, stderr, timedOut, aborted}`；prompt Step 用 `ctx.llm.stream(GenerateOptions{provider, model, messages: Message[]})`，用 `BlockAssembler`（或等价逻辑）把 `block-end` 聚合为 `ContentBlock[]`，`finish.reason.kind === 'error'`（或 `'aborted'`）为终端失败。
2. **microflow/stage-executor.ts**：Stage 内顺序执行 Step（Task 2 无分支/循环，仅线性 `next`），收集产物组装 `StageContract`。
3. **workflow/dag-navigator.ts**：`nodeIndex`（`Map<string, DagNodeRef>`）+ `tryAdvanceStage()` 跟随 `Stage.next`。
4. **workflow/workflow-engine.ts**：`SandoreEngineRuntime`（替换/承载 `SandoreEngineStub`）——Stage 级线性主循环、`emitSandoreEvent` 双发（`ctx.emit` + `hostSession.append`）、`persistState`（复用 `ctx.sandorePersistence.saveWorkflowState`，不可再 `open` 同名 `sandore` 域——会抛 `already-open`）、`childId = step-{stepId}-{execId}` 合成 `sessionMeta = { childId, synthetic: true, command: 'shell' | 'prompt' }`。

## Supplementary Exploration Result

`furina config show experimental.websearch experimental.context7` 返回：`experimental.websearch=true`、`experimental.context7=true`。

但 Phase 3 的本地探索（DSH 源码 + 三份设计文档）已覆盖 exploreContent 所需的全部精确 API 签名、`createUserMessage` 构造、事件发射范式与 AbortSignal 传递路径，信息充分，**无需**再发起 websearch / context7 补充查询。
