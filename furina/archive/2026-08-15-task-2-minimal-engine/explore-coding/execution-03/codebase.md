# execution-03 探索结果（codebase.md）

> 探索任务：execution-03（线性工作流执行）实现所需的当前项目状态与 DSH 参考范式/
> 精确 API 签名。涉及 4 个待建文件：`microflow/step-runner.ts`、
> `microflow/stage-executor.ts`、`workflow/dag-navigator.ts`、`workflow/workflow-engine.ts`。
> 语言：中文。本文件仅记录现状与事实，不含实现方案或代码。

---

## Exploration Result

### Phase 1 获取 codebases list

```bash
furina config show project.sourcecode codebases
```

结果：

- `project.sourcecode=src/`
- `codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`

### Phase 3 结论（codebases list 探索）

- `docs/codebase` 目录为空（无文件）。
- `src/` 目录不存在/为空。
- 因此 codebases list 本身无可探索内容，全部有效信息通过 Phase 4 补充探索获得（见下）。

---

## Supplementary Exploration Result

### 1. 需求理解（Phase 2）

- **What**：在 `packages/sandore/` 内实现 Task 2 的 execution-03（线性工作流执行）：
  1. `microflow/step-runner.ts`：两种 Step 执行器——shell 用 `ctx.shell.resolve(request)` →
     `ctx.shell.run(spec)`（返回 `ShellRunResult`）；prompt 用
     `ctx.llm.stream(GenerateOptions)`（聚合 `StreamChunk` 的 `block-end` 为
     `ContentBlock[]`，`finish.reason.kind === 'error'` 为终端失败）。
  2. `microflow/stage-executor.ts`：Stage 内顺序执行 Step + 组装 `StageContract`。
  3. `workflow/dag-navigator.ts`：`nodeIndex` + `tryAdvanceStage`（跟随 `Stage.next`）。
  4. `workflow/workflow-engine.ts`：`SandoreEngineRuntime`（Stage 级线性主循环、
     `sandore/*` 事件 `ctx.emit` + `session.append` 双发、`persistState`、
     `childId = step-{stepId}-{execId}` 合成 `sessionMeta = { childId, synthetic: true, command }`）。
- **Boundaries**：`packages/sandore/workflow/` 与 `packages/sandore/microflow/`；参考源码在
  `D:\project-code\llm\deepseek-harness`（DSH）。
- **Goal**：摸清当前 Task 2 已落地的代码（schema/CRUD/持久化/测试 mock）+ 拿到 DSH 侧
  shell/llm/sessions/cordis 的精确 API 签名与事件发射范式、AbortSignal 传递方式，作为
  execution-03 的实现依据。
- **Project Context**：sandore 是 DSH 插件 monorepo（pnpm workspace，`packages/sandore/*`
  四包）。execution-03 落在「Stage 级编排引擎 + Stage 内 Step 执行」架构层，依赖
  `@deepseek-ai/cordis`（Service/emit/on）、`@deepseek-ai/dsh-shell`（shell）、
  `@deepseek-ai/dsh-llm`（llm/Message/ContentBlock）、`@deepseek-ai/dsh-session`
  （Session.append/SessionEventMap）、`@deepseek-ai/dsh-storage-domain`（persistState）。

---

### 2. 当前项目状态（Task 2 execution-03 起点，已存在代码）

根目录：`D:\project-code\llm\sandore`
- `package.json`：`"test": "vitest run"`（已就绪）。
- `vitest.config.ts`：`include: ['packages/**/*.spec.ts']`，并含 `standardDecoratorPlugin`
  （把 `@Remote` 等标准装饰器经 `typescript.transpileModule` 转为 `__esDecorate`）。
- `tsconfig.base.json`：`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、
  `noImplicitOverride`、`allowImportingTsExtensions`、`rewriteRelativeImportExtensions`。
- `pnpm-workspace.yaml`：`packages: - packages/sandore/*`。

已存在的 `workflow` 包文件（`D:\project-code\llm\sandore\packages\sandore\workflow\src\`）：

| 文件 | 现状（与 execution-03 相关的事实） |
|---|---|
| `index.ts` | `abstract class SandoreEngine extends Service`（11 个实例级方法：startInstance/recoverInstance/abortInstance/replyQuestion/replyPermission/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps/retryStep/getState）+ 13 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`）+ `SandoreEngineStub`（默认导出）。`SandoreEngineStub.static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`。 |
| `types.ts` | `DagRunInfo`/`DagStartRequest`/`DagRun`/`DagRunStatus`/`DagInstanceState`/`ExecutedStepDefault`/`StageInfo`/`StepStatus`/`StageContract`/`PendingQuestion`/`PendingPermission`/`DagResultInfo` 等 browser-safe 类型。**`ExecutedStepDefault` 已含 `output?: ContentBlock[]`**。 |
| `schema.ts` | 三层 Zod Schema + `sandoreDomainSpec` 全部就绪；`ExecutedStepDefaultSchema` 已含 `output: z.array(ContentBlockSchema).optional()`。 |
| `errors.ts` | `SandoreError extends HarnessError`（稳定 `code` + `fatal` 标志）。已有 code：`YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`CANCELLED`/`PERSISTENCE_FAILED`。 |
| `yaml-parser.ts` | `parseWorkflowYaml`/`serializeWorkflowYaml`（V1/V2 + Zod + 引用完整性校验）。 |
| `persistence.ts` | `SandorePersistence`（`ctx.sandorePersistence`）：`[Service.init]` 打开 `sandore` 域三表，暴露 `definitions`/`jobs`/`state` 三个 `KvTable` getter + `saveWorkflowState(state)`（= `state.put(taskId, state)` 全量覆盖）。 |
| `remote.ts` | `SandoreRemote extends TypertRemoteService`（`super(ctx, 'sandore')`），已实现定义/Job/实例 CRUD + `getArtifacts` + `listProviders`/`listModels`。`startInstance` 转发 `ctx.sandoreEngine.startInstance(request)`；`getInstanceState` 读 `ctx.sandorePersistence.state.get(instanceId)`。 |
| `schema.spec.ts` / `yaml-parser.spec.ts` / `persistence.spec.ts` / `remote.spec.ts` | 已有单元测试。 |

**尚未创建（execution-03 产出）**：
- `workflow/src/dag-navigator.ts`、`workflow/src/workflow-engine.ts`。
- `microflow/src/`（整个目录为空，只有 `package.json` + `tsconfig.json`）。

**`microflow` 包现状**（`D:\project-code\llm\sandore\packages\sandore\microflow\`）：
- `package.json`：`name: "@deepseek-ai/dsh-sandore-microflow"`、`type: module`、
  `main: lib/index.js`、`exports` 含 `.`/`./src/*`/`./package.json`；**当前无任何
  `dependencies`/`peerDependencies`/`scripts`**。
- `tsconfig.json`：`extends ../../../tsconfig.base.json`、`rootDir: "src"`、
  `outDir: "lib/types"`、`include: ["src"]`。
- 因此 execution-03 要在 `microflow/src/` 新建 `step-runner.ts` 与 `stage-executor.ts`
  （及入口），并需为类型依赖（cordis/dsh-shell/dsh-llm/dsh-session/dsh-storage-domain）补齐
  package.json 声明——此为实现事实，非方案。

**已有关键 schema（execution-03 直接复用，原文见 `schema.ts`）**：

`StepSessionMetaSchema`（`schema.ts` L185-189，即 execution-03 要写入的 `sessionMeta` 形状）：

```typescript
export const StepSessionMetaSchema = z.object({
  childId: z.string(),
  synthetic: z.boolean(),
  command: z.enum(['shell', 'prompt', 'agent', 'skill', 'mcp']),
})
```

`ContentBlockSchema`（`schema.ts` L24，merge-extensible，只约束 `type: string`）：

```typescript
const ContentBlockSchema = z.looseObject({ type: z.string() })
```

`ExecutedStepDefaultSchema`（`schema.ts` L228-254）已含 `output: z.array(ContentBlockSchema).optional()`
与 `sessionMeta: StepSessionMetaSchema.optional()`。

**测试 mock 现状**（`D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\storage-domain.ts`）：
- 已有 `MemoryKvTable`（Map 实现 `KvTable` 等价语义）、`MemoryDomain`（`table()`/`close()`/`closed`）、
  `MemoryStorageDomain`（`open(spec)` 拒绝重复打开、`get(name)` 诊断）。
- `persistence.spec.ts`/`remote.spec.ts` 的 harness 范式：
  `new Context()` → `ctx.provide('storageDomain', new MemoryStorageDomain())` →
  `await ctx.plugin(SandorePersistence)` → `ctx.provide('llm'|'shell'|'sandoreEngine', mock)`。
- `remote.spec.ts` 的 fake llm 仅提供 `listProviders()`/`listModels(provider)`；fake 引擎仅提供
  `startInstance`/`abortInstance`。execution-03 的集成测试需要更完整的 fake（`stream` 返回
  固定 chunks + `registerAdapter`）与 mock shell（`resolve`/`run` 返回固定 stdout）。

---

### 3. DSH 参考 API 精确签名（`D:\project-code\llm\deepseek-harness`）

#### 3.1 `ctx.shell`（包 `@deepseek-ai/dsh-shell`）

文件：`D:\project-code\llm\deepseek-harness\packages\shell\shell\src\index.ts` 与 `src\types.ts`

```typescript
// Service Definition（abstract），注册为 ctx.shell
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) { super(ctx, 'shell') }
  get sandboxMode(): SandboxMode | undefined          // 默认 undefined（不沙箱）
  abstract resolve(request: ShellExecRequest): ShellExecSpec
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>
  abstract start(spec: ShellExecSpec): ShellProcess   // 后台进程（Task 2 不用）
}

export interface ShellExecRequest {   // 传给 resolve()
  command: string
  workdir?: string | undefined          // 缺省由实现配置填
  timeoutMs?: number | undefined        // 缺省由实现配置填（实现会 cap）
  stdoutMaxBytes?: number | undefined   // 前台 stdout 捕获字节上限；缺省用执行器默认 cap
  signal?: AbortSignal | undefined      // 中止信号 —— 触发即 kill 命令
  stdin?: string | undefined            // 写入 stdin 后关闭；缺省 stdin 关闭/空
  env?: Record<string, string> | undefined
  dshEnv?: DshEnvironment | undefined
  sandboxPolicy?: SandboxExecutionPolicy | undefined
}

export interface ShellExecSpec {       // resolve() 填满并 cap 必填字段
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
  exitCode: number | null                // 信号致死时为 null
  signal: NodeJS.Signals | null          // 终止信号；正常退出为 null
  timedOut: boolean                      // 执行器自身超时是「第一个」截断原因（与 aborted 互斥）
  aborted: boolean                       // 调用方 AbortSignal 是「第一个」kill 原因（与 timedOut 互斥）
  timeoutMs: number                      // 本次生效的超时（默认/上限后）
  stdout: CollectedOutput
  stderr: CollectedOutput
  sandbox?: ShellSandboxInfo             // 无沙箱执行器时缺省
}

// CollectedOutput 由 @deepseek-ai/dsh-subprocess 定义并 re-export：
// 文件：D:\project-code\llm\deepseek-harness\packages\subprocess\subprocess\src\types.ts
export interface CollectedOutput {
  text: string           // 被截断时保留的是「尾部」
  truncated: boolean     // 是否丢掉了 text 之外的部分
  spillPath?: string     // 完整流 spill 文件（截断且可用时）
}
```

关键语义（`index.ts` 注释）：`run` **只在基础设施故障时 reject**；非零退出、超时 kill、
abort kill 都 **resolve** 为 `ShellRunResult`。所以 step-runner 应读 `result.exitCode`/
`result.timedOut`/`result.aborted` 判定成功/失败，而不是 try/catch 判断命令失败。

#### 3.2 `ctx.llm`（包 `@deepseek-ai/dsh-llm`）

文件：`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\index.ts`、`src\types.ts`、
`src\message.ts`、`src\assembler.ts`

```typescript
// Service Definition（非 abstract，具体实现），注册为 ctx.llm
export class LlmRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>   // 核心推理入口
  async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>
  listProviders(): LlmProviderInfo[]                             // 同步，{ id, name }[]
  async listModels(provider: string): Promise<LlmModelInfo[]>
  async resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle  // 测试 fake adapter 入口
}

export interface GenerateOptions {
  provider: string              // 必填：注册的 provider route（选 adapter）
  model: string                 // 必填：模型 id
  reasoningEffort?: ReasoningEffortId
  messages: Message[]           // 必填：按 provider 看到的顺序（system 之外）
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal          // 取消信号
  sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'
}

// 原始流协议（types.ts）
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }        // 携带已组装块（权威）
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }  // 终态

// 内容块（merge-extensible，switch type 后 fall through 未知类型）
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }
  | { type: 'tool-call'; id: CallId; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: CallId; content: ContentBlock[]; isError?: boolean }

// 结束原因（merge-extensible）
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }
```

**终端失败语义（关键）**：`LlmRuntime.stream()` 会把 adapter 抛错 / 迭代失败规范化为一个
**终态 `finish` chunk**（见 `index.ts` 的 `adapterFailureChunk`）：

```typescript
function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason: signal?.aborted || failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}
```

即：`finish.reason.kind === 'error'` 为终端失败；`'aborted'` 为中止（同样终态）。
step-runner 应在流结束后以 `finish.reason.kind` 判定。

**聚合块（`BlockAssembler`，DSH 权威组装器，`@deepseek-ai/dsh-llm` 导出）**：

```typescript
export class BlockAssembler {
  push(chunk: StreamChunk): void   // block-end 权威并冻结 partial；block-start/text-delta 建部分块
  blocks(): ContentBlock[]         // 按流序返回全部块（max-tokens 时丢弃 tool-call）
  get usage(): TokenUsage | undefined
  get finish(): FinishReason       // 流结束无 finish 时返回 { kind: 'stop' }
  get replayState(): unknown
  message(source?: MessageSource): Message
}
```

step-runner 可直接用 `BlockAssembler`（喂 chunks → 读 `blocks()` + `finish`），或手写
「收集 `block-end` 的 `block`」聚合（exploreContent 描述的是后者）。

**`Message` 与 `createUserMessage`（`src\message.ts`）**：

```typescript
export interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource            // { kind:'user' } | { kind:'plugin'; plugin; ... } | { kind:'model'; ... } | { kind:'tool'; ... }
}

export function createMessage<T extends NewMessage>(input: T & { readonly id?: never }): T & Pick<Message, 'id'>
export function createUserMessage<T extends NewUserMessage>(input: T & { readonly id?: never; readonly role?: never }): T & Pick<UserMessage, 'id' | 'role'>
export function createAssistantMessage(input): AssistantMessage
export function createToolResultMessage(input): ToolResultMessage
export function freezeMessage<T extends Message>(message: T): T
```

- `createUserMessage` 内部 `createMessage({ ...input, role: 'user' })` → `freezeMessage`
  （`structuredClone` + deepFreeze），并 `id = MessageId(crypto.randomUUID())`。
- `input` 需提供 `content: ContentBlock[]` 与 `source`（`source.kind = 'user'` 或
  `'plugin'`）；`id`/`role` 由工厂补。
- 结果 message 是**深冻结**的（不可变）。

#### 3.3 `ctx.sessions` / `Session`（包 `@deepseek-ai/dsh-session`）

文件：`D:\project-code\llm\deepseek-harness\packages\core\session\src\index.ts` 与 `src\types.ts`

```typescript
// Session 是普通 class（非 Service）；ctx.sessions 是 SessionStore（Service）
export class Session {
  get id(): SessionId
  get events(): readonly SessionEvent[]          // 深冻结快照
  get seq(): number
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []   // 非 surface 事件无 opts
  ): SessionEvent<T>
  deriveMessages(): Message[]
}

export class SessionStore extends Service {
  constructor(ctx: Context) { super(ctx, 'sessions') }
  create(id?: SessionId, options?: CreateSessionOptions): Session   // 返回已进入 store 并 announce 的 live session
  prepare(id?, options?): Session
  enter(session): () => void
  announce(session): void
  get(id: SessionId): Session | undefined
  list(): Session[]
  async flush(session: Session): Promise<boolean>
  fork(source, boundary?, childSessionId?): Session
}

export type SessionId = Branded<'SessionId'>
export function SessionId(id: string): SessionId    // 纯编译期 cast，无运行时成本
```

关键事实：
- `SessionEventMap` 通过 **声明合并** 扩展：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { ... } }`。
  sandore 的 13 个 `sandore/*` 已在 `workflow/src/index.ts` 按此方式声明（Session 载荷为扁平对象）。
- **非 surface 事件**（`surfaceOp` 只在 `'user/message'|'assistant/message'|'tool/result'` 上必需）
  直接 `session.append('sandore/step-start', payload)` 即可，**不需要 opts**（编译期已排除）。
- `append` 校验 `data` 必须 **lossless-JSON-serializable**（BigInt/function/symbol/undefined/
  `-0`/非有限数/循环引用/稀疏数组/Map/Set/Date/class 实例都会在 append 点抛错）——所以
  `session.append` 的载荷（含 `ContentBlock[]`）必须是纯 JSON 可序列化形状。
- `childId` 在 Task 2 是合成占位普通 string（`StepSessionMetaSchema` 已定义为 `z.string()`），
  无需 `SessionId()` 品牌化（Task 3 agent 才用真实 SessionId）。

#### 3.4 Cordis `ctx.emit` / `ctx.on` / `Service`（包 `@deepseek-ai/cordis`）

文件：`D:\project-code\llm\sandore\node_modules\.pnpm\@deepseek-ai+cordis@4.0.1\node_modules\@deepseek-ai\cordis\src\events.ts` 与 `src\service.ts`

```typescript
// 混入 ctx 的事件方法
emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void       // 同步、不 await、不 contain
on<K extends keyof Events>(name: K, listener: Events[K], options?): () => boolean  // fiber 自动 dispose
once<K extends keyof Events>(name: K, listener: Events[K], options?): () => boolean
parallel / serial / bail / waterfall(...)

// Service 基类
export abstract class Service<out T = never> {
  static readonly init: unique symbol   // 写 [Service.init] 生命周期方法
  constructor(protected ctx: Context, name: string)   // 立即 ctx.reflect.provide(name, this)
}
```

关键：`ctx.emit` 是**同步** dispatch 且**不 contain** 监听器 throw（一个 throw 会传播并饿死后续
listener）。DSH 惯例（见下 §4）是用 `this.ctx.events.dispatch('emit', [name, ...args])` +
每监听器 try/catch 包一层。

---

### 4. 事件发射范式（D5 双发 + childId 占位）

#### 4.1 DSH `emitWorkflowEvent`（contain-and-log 范式）

文件：`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`（L175-186）

```typescript
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
```

要点：先 `dispatch('emit', ...)` 解析并过滤 listener（含 scope filter），再逐监听器
try/catch + `ctx.logger.warn`，异步 reject 也 contain。这是 sandore `emitSandoreEvent`
里 `ctx.emit` 一侧应复用的包裹范式（而 `session.append` 侧直接 `hostSession.append(...)`）。

#### 4.2 DSH `tool-workflow` 的双发范式（引擎 emit → 工具 on → 工具 session.append）

文件：`D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\index.ts`（L73-131）
与 `src\types.ts`（L41-64）

- `tool-workflow` 在 `types.ts` 里 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'tool-workflow/run-start': ...; ... } }` 声明 4 个 log-only 事件。
- 引擎侧只 `ctx.emit('workflow/*', info, …)`（Cordis 进程内触发源）。
- 工具侧 `ctx.on('workflow/agent-start', (info, agent) => { session.append('tool-workflow/agent-start', data) })`
  把引擎事件转写为**父 Session 的 log-only 事件**。
- `session.append` 用 `append.bind(session)` 收窄为非 surface 签名后调用（因为 4 个事件都是 log-only，
  opts 元组为空），并 try/catch contain（失败仅 `ctx.logger.warn` 并放弃记录）。

sandore 的差异点（design.md §5.1A）：sandore 引擎**自己**承担双发——同一个
`emitSandoreEvent(type, info, payload)` 辅助函数里同时 `ctx.emit('sandore/…', info, …)`
（首参 `DagRunInfo`，多参数）与 `hostSession.append('sandore/…', payload)`（扁平可序列化
对象），而非像 tool-workflow 那样拆成「引擎 emit + 独立工具 on 再 append」。

#### 4.3 `sandore/*` 事件载荷与 childId 占位（design.md §5.1A / index.ts 已声明）

Cordis `Events`（首参 `DagRunInfo`，多参数）与 Session `SessionEventMap`（扁平对象）的对照已在
`workflow/src/index.ts` 声明。execution-03 要发的 13 事件（含载荷要点）：

| 事件 | Cordis（多参数） | Session（扁平载荷） |
|---|---|---|
| `sandore/start` | `(info: DagRunInfo)` | `{ taskId, workflowId, jobId }` |
| `sandore/stage-start` | `(info, stageId)` | `{ taskId, stageId }` |
| `sandore/stage-completed` | `(info, stageId, contract: StageContract)` | `{ taskId, stageId, stageContract }` |
| `sandore/step-start` | `(info, stepId, childId)` | `{ stepId, childId }` |
| `sandore/step-completed` | `(info, stepId, childId, output: ContentBlock[])` | `{ stepId, childId, output }` |
| `sandore/step-failed` | `(info, stepId, childId, error: string)` | `{ stepId, childId, error }` |
| `sandore/step-paused` | `(info, stepId, childId)` | `{ stepId, childId }` |
| `sandore/step-resumed` | `(info, stepId, childId, resumePrompt?)` | `{ stepId, childId, resumePrompt? }` |
| `sandore/step-retried` | `(info, stepId, mode)` | `{ stepId, mode }` |
| `sandore/question` | `(info, question)` | `{ question }` |
| `sandore/permission` | `(info, permission)` | `{ permission }` |
| `sandore/end` | `(info, result: DagResultInfo)` | `{ taskId, jobId, result }` |
| `sandore/aborted` | `(info)` | `{ taskId }` |

childId 占位规则（design.md §5.1A）：`childId = step-{stepId}-{execId}`，`execId` 为本次执行
唯一短 id（如 `randomUUID().slice(0, 8)`），并写入 `executedSteps[].sessionMeta =
{ childId, synthetic: true, command: 'shell' | 'prompt' }`。`synthetic: true` 供 Task 5 前端
区分占位 childId（点击不跳转子对话页）。

---

### 5. 线性执行相关设计规格（design.md §5，execution-03 直接依据）

文件：`D:\project-code\llm\sandore\docs\design\task-2-minimal-engine\design.md`

#### 5.1 StageExecutor（§5.3）

```typescript
interface StageExecutorOptions {
  stageDef: WorkflowStage
  workflowDef: WorkflowDefinition
  input: StageExecutionInput
  sharedState: StageSharedState
  engine: WorkflowEngineV2
}
interface StageExecutionInput {
  originalInput: string
  contractArtifacts: Record<string, string[]>
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>
  userChatMessages?: Array<{ id: string; stageId: string; message: string }>
  entryStepId?: string
}
interface StageSharedState { cwd: string; instanceDir: string; jobId: string; taskId: string }
interface StageExecutionResult {
  stageContract: StageContract
  executedSteps: ExecutedStepDefault[]
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>
  status: StepStatus
  errorDetail?: string
}
```

- 方法：`execute()`（主入口）、`buildStageNodeIndex`、`processStageNode`、
  `resolveStageNextNodes`、`isStageComplete`、`finalizeStageContract`、
  `resolveCrossStageInput`。
- **Task 2 简化**：Stage 内**顺序执行**（无 Loop/Branch），`resolveStageNextNodes` 仅跟
  `Step.next`；`execute()` 结束前 `finalizeStageContract()` 组装 `StageContract`
  （stageId/stageName/status/artifacts/passThroughVars/contractArtifacts/completedAt）。

#### 5.2 WorkflowDagNavigator（§5.4）

字段：`nodeIndex: Map<string, DagNodeRef>`、`pendingQueue: string[]`、
`visitCounts`、`currentStageId`、`nodeExecutionOptions`、`stageContracts: Map<string, StageContract>`、
`stageExecutorRef`。

方法：`buildNodeIndex(definition)`、`processNode(nodeId)`、`resolveNextNodes(node)`、
`enqueueNode(nodeId, options?)`、`consumeNodeExecutionOptions(nodeId)`、`enqueueStage(stageId)`、
`enqueueTargetNode(targetId)`、`evaluateBranches`（Task 2 不实现）、`isStageAllDone(stageId)`、
**`tryAdvanceStage(): Promise<boolean>`**、`finalizeStageContract(stageId)`、
`resolveCrossStageInput(path)`、`getStageContract(stageId)`。

- `DagNodeRef = { kind: 'stage'|'step'; stage: WorkflowStage; step?; id; name; next?; condition?; branches?; loop? }`。
- **`resolveNextNodes` 优先级（Task 2 仅 Next）**：Loop（不实现）→ Branches（不实现）→ Next → 无。
- **`tryAdvanceStage` 流程（§5.4，Task 2 简化）**：
  1. `isStageAllDone(currentStageId)` false → 返回 false；
  2. `finalizeStageContract(currentStageId)` → 存入 `stageContracts`；
  3. （V2.6）发射 `workflow.stage_contract_created`——sandore 侧对应 `sandore/stage-completed`；
  4. 评估 Stage 级 condition/branches（**Task 2 简化：仅跟 `Stage.next`**）；
  5. 跟随 `Stage.next` 或推断下一 Stage；
  6. 入队下一 Stage 第一个 Step → 返回 true。

#### 5.3 引擎主循环（§5.6，Stage 级编排）

```
execute():
  1. status → running
  2. 入队第一个 Stage
  3. Stage 编排循环:
     a. 取出当前 Stage → 创建 StageExecutor
     b. stageExecutor.execute() → 等待 Stage 内部执行完成
     c. 收集 StageExecutionResult → 存入 dagNavigator.stageContracts
     d. 发射 stage-completed 事件
     e. tryAdvanceStage() → 跟 Stage.next
     f. 有下一 Stage → 入队；无 → 完成
  4. 所有 Stage 完成 → status = completed
  5. 持久化 + 事件
```

- `SandoreEngineRuntime extends SandoreEngine`，`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`（design.md §6.4；
  Task 1 的 `SandoreEngineStub` 已用同一份 inject）。
- `Config`（schemastery）：`defaultTimeoutMs: z.natural().default(7200000)`、
  `maxConcurrentSteps: z.natural().default(0)`、`defaultProvider?: string`、
  `defaultModel?: string`（prompt Step 缺省模型三层回退的 L2）。**无 `permissionMode`**。
- 已存在 `SandorePersistence`（`ctx.sandorePersistence`）封装了 `storageDomain` 三表与
  `saveWorkflowState`；`SandoreEngineRuntime` 可注入 `storageDomain`（design 声明）或
  `sandorePersistence`（已存在的包装服务）——二者均为事实存在，如何接线为实现细节。

#### 5.4 provider/model 三层回退（§6.2 / design.md §5.2）

- L1：Step 定义 `providerId`+`modelId` **成对提供才用**（缺一整体视为缺省）。
- L2：引擎 Config `defaultProvider`/`defaultModel`（成对配置才用）。
- L3：`ctx.llm.listProviders()[0]` + `await ctx.llm.listModels(provider)[0]`（记 warn）。
- 解析结果拼成 `GenerateOptions.provider` / `GenerateOptions.model`（`LlmRuntime` 无自动默认
  模型，`resolveCallFor` 要求 `config.model` 必需）。

---

### 6. AbortSignal 传递路径

- **shell**：`ShellExecRequest.signal?: AbortSignal` → `resolve(request)` 后进入
  `ShellExecSpec.signal` → `run(spec)`；实现侧 signal 触发即 kill 命令，结果里
  `aborted: true`（`timedOut` 与之互斥）。
- **llm**：`GenerateOptions.signal?: AbortSignal` → `stream(options)`；`LlmRuntime.stream` 把
  signal 用于 `adapterFailureChunk` 的终态分类（`signal.aborted` → `finish.reason.kind='aborted'`），
  且 `resolveCallFor` 也透传 `options.signal`。
- **上层引擎**：`SandoreEngine.abortInstance(instanceId)` 需要持有每实例的 `AbortController`
  （引擎内部字段），把同一 signal 桥接给 shell 与 prompt 执行——这是 design §6.3 abort 语义
  在 execution-03 的落点（事实推断自 `ShellExecRequest.signal`/`GenerateOptions.signal` 均存在）。

---

### 7. 测试 mock 范式（execution-03 集成测试需要）

- 已有 `MemoryStorageDomain`（`workflow/tests/mocks/storage-domain.ts`）覆盖持久化侧。
- **fake llm adapter**：DSH `LlmAdapter` 抽象类（`stream` 是唯一必实现方法，
  `listModels`/`resolveModel`/`providerInfo` 有默认实现）。测试用
  `ctx.llm.registerAdapter(['provider'], fakeAdapter)`，fakeAdapter.stream 返回固定
  `[{ type: 'block-start', ... }, { type: 'text-delta', ... }, { type: 'block-end', index, block: { type:'text', text:'…' } }, { type: 'finish', reason: { kind: 'stop' } }]`
  的 async generator；或直接把 `ctx.llm` 整体 mock 成一个 `{ stream: async function*(){...}, listProviders, listModels }` 对象（`ctx.provide('llm', mock)`）。
- **mock shell**：mock `ctx.shell = { resolve(req){ return { command, workdir, timeoutMs, stdoutMaxBytes, ... } }, run(spec){ return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs, stdout: { text: '…', truncated: false }, stderr: { text: '', truncated: false } } } }`，`ctx.provide('shell', mock)`。
- 现有测试 harness 范式（`persistence.spec.ts`/`remote.spec.ts`）：`new Context()` +
  `ctx.provide(...)` + `await ctx.plugin(...)`；vitest `include: ['packages/**/*.spec.ts']`。
- design.md §7.1 约定：根 `package.json` 已有 `"test": "vitest run"`；不引入 test-support 重量级
  集成测试；纯单元（零 mock）+ 轻量集成（内存 mock DSH 服务）两层。

---

### 8. 实现依据小结（事实，非方案）

1. **`StepSessionMetaSchema` 已存在**（`childId/synthetic/command`），execution-03 只需
   按 `{ childId: step-{stepId}-{execId}, synthetic: true, command: 'shell'|'prompt' }` 填充。
2. **`ExecutedStepDefaultSchema` 已含 `output` 与 `sessionMeta`**，`WorkflowTaskStateSchema` 已含
   `stageContracts/pendingQueue/executedSteps` 等全部字段，`persistState` 可直接全量
   `state.put(taskId, state)`（`SandorePersistence.saveWorkflowState` 已封装）。
3. **shell 精确签名**：`ctx.shell.resolve(ShellExecRequest) → ShellExecSpec`；
   `ctx.shell.run(spec) → Promise<ShellRunResult>`；`ShellRunResult` 含 `exitCode`（number|null）、
   `signal`、`timedOut`、`aborted`、`timeoutMs`、`stdout/stderr: CollectedOutput{ text, truncated, spillPath? }`；
   `run` 只在基础设施故障 reject，非零退出/超时/中止都 resolve。
4. **llm 精确签名**：`ctx.llm.stream(GenerateOptions{ provider, model, messages: Message[], signal?, ... }) → AsyncIterable<StreamChunk>`；
   `block-end` 携带组装块；终态 `finish.reason.kind`（`'error'` 失败 / `'aborted'` 中止 /
   `'stop'`/`'max-tokens'`/`'tool-calls'`）；`BlockAssembler` 是 DSH 权威聚合器。
5. **Message 构造**：`createUserMessage({ content, source })` 返回深冻结 `{ id, role:'user', content, source }`，
   `id = MessageId(crypto.randomUUID())`；prompt Step 用 `messages: Message[]`（`role`/`content`/`source` 齐备）。
6. **Session 事件**：`hostSession.append('sandore/…', payload)`（非 surface 事件无需 opts）；
   `SessionEventMap` 经 `declare module '@deepseek-ai/dsh-session/types'` 合并（sandore 已在 `index.ts` 声明）；
   `ctx.sessions.create(id?, options?)` 返回 live `Session`；载荷必须 lossless-JSON-serializable。
7. **事件双发**：`ctx.emit` 同步且不 contain，DSH 惯例用
   `this.ctx.events.dispatch('emit', [name, ...args])` + 逐监听器 try/catch + `ctx.logger.warn`；
   `session.append` 侧直接写 log（tool-workflow 的双发范式为「引擎 emit + 监听者 append」，
   sandore 合并进 `emitSandoreEvent` 一个辅助函数）。
8. **AbortSignal**：shell 走 `ShellExecRequest.signal`，llm 走 `GenerateOptions.signal`；
   引擎 abort 需自建 `AbortController` 桥接。
9. **provider/model 三层回退**：`ctx.llm.listProviders()`（同步）与
   `await ctx.llm.listModels(provider)` 是 L3 兜底的精确签名。
10. **microflow 包**当前无任何依赖声明，`src/` 为空，`tsconfig` 已配置 `rootDir: src`；
    需新建 `src/` 并补类型依赖（cordis/dsh-shell/dsh-llm/dsh-session/dsh-storage-domain）。
