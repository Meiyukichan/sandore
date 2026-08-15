# 探索结果：FinalizeAssessor / GateEvaluator / finalize-manager 前置依据

- Explore Type: specification
- 项目路径: D:/project-code/llm/sandore
- 输出目录: D:/project-code/llm/sandore/furina/changes/task-3-full-dag/explore-coding/finalize-01
- 说明: 本探索仅核实当前代码现状（精确签名/形状），不含任何实现方案或建议。

## 需求理解

- **What**: 精确核实 6 类既有代码事实，作为 FinalizeAssessor（fork 会话）、GateEvaluator、finalize-manager（schema/types 读写）以及 finalize-manager.spec（测试范式）的复用依据。
- **Boundaries**: 仅限 (1) DSH `@deepseek-ai/dsh-session` 源码中 `SessionStore.fork`/`Session`/`SessionEvent`/`meta`；(2) `packages/sandore/workflow/src/schema.ts` 中 Gates/Finalize 相关 schema；(3) `packages/sandore/workflow/src/types.ts` 中相关类型；(4) `packages/sandore/microflow/src/branch-evaluator.ts` 临时会话聚合链与 shell 分支范式；(5) `packages/sandore/microflow/src/file-utils.ts` 导出；(6) `packages/sandore/workflow/tests/mocks/sessions.ts` 与测试范式。
- **Goal**: 为 finalize-manager 的读写与测试提供精确的形状/签名依据，避免臆造。

---

## (1) DSH `ctx.sessions.fork` 真实签名与 Session 结构

来源: `node_modules/.pnpm/@deepseek-ai+dsh-session@0._959f4648d9537c86268b5de534a89875/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts` 与 `lib/index.js`（编译产物，含实现细节）。

### 1.1 `SessionStore`（`ctx.sessions`，`Service`，key `'sessions'`）关键方法

```ts
create(id?: SessionId, options?: CreateSessionOptions): Session
prepare(id?: SessionId, options?: PrepareSessionOptions): Session
enter(session: Session): () => void
announce(session: Session): void
flush(session: Session): Promise<boolean>
get(id: SessionId): Session | undefined
list(): Session[]
fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session
```

- `export type SessionForkSource = Session | SessionId;`
- `SessionId = Branded<'SessionId'>`，`SessionId(id: string): SessionId`（运行时就是原字符串，仅编译期 brand）。
- `SessionStore` 是内存 store；持久化由插件订阅 `session/event` + `session/flush` 完成，store 本身不落盘。

### 1.2 `fork` 三参数与边界语义（`_forkSeed` / `_resolveForkSource` 实现）

签名：`fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session`

- **source 参数**：
  - 传 `SessionId`（字符串）：`this.get(source)` 查找，未命中抛 `SessionForkError('SESSION_NOT_FOUND')`。
  - 传 `Session` 对象：先 `this.get(source.id)` 查找；未命中抛 `SESSION_NOT_FOUND`；命中但 `live !== source`（非 store 内的 live 实例）抛 `SESSION_NOT_LIVE`。
- **boundary 参数（含边界，inclusive source event seq）**：
  - 省略：fork 到 source 当前最后一条事件（`lastEvent.seq`）；source 为空则 fork 空子会话（返回 `[]` seed）。
  - 显式：必须是「非负安全整数」（否则 `INVALID_BOUNDARY`）。
  - 必须存在且连续：`boundary < events.length` 且 `events[boundary].seq === boundary`（否则 `INVALID_BOUNDARY`）。
  - 前缀不得结束在未闭合 turn 内：`events.slice(0, boundary+1)` 中最后一条 `turn/start`/`turn/end` 若为 `turn/start`，抛 `OPEN_TURN`。
- **childSessionId 参数**：
  - 若已存在（`get(childSessionId) !== undefined`），抛 `SESSION_ALREADY_EXISTS`。
  - 省略：委托 `SessionStore` 的 id 策略（`prepare` 中 mint `session-<counter>`）。
- **返回值**：创建的 live 子会话（经 `create` → `prepare` + `enter` + `announce`，已进入 store 并已发 `session/created`）。
- **子会话 header meta 继承**（`fork` 内构造 `create` 的 `meta`）：
  - `cwd`：仅当 source header 有 `cwd` 时拷贝。
  - `parentSession: liveSource.id`。
  - `seedLength: seed.length`（`seed = events.slice(0, boundary + 1)`）。

### 1.3 `Session` 结构（plain class，非 Service）

来源 `lib/types/index.d.ts`：

```ts
export declare class Session {
  get surface(): SessionSurface
  readonly header: SessionHeader
  get id(): SessionId
  readonly firstLiveSeq: number
  get events(): readonly SessionEvent[]
  get seq(): number
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []): SessionEvent<T>
  deriveMessages(): Message[]
  requestHeader(): EpochHeader | undefined
  requestContext(): RequestContext | undefined
  deriveEventMessage(event: SessionEvent): Message | null
  static create(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader): Session
  static fromRestore(id: SessionId, seed: readonly SessionEvent[], header: SessionHeader): Session
}
```

- `Session.id` 来自 `header.id`。
- `Session.header`（`SessionHeader`）字段（全部可选字段非必填）：
  - `version: number`（当前 `SESSION_FORMAT_VERSION = 0`）
  - `id: SessionId`
  - `createdAt: number`（非负安全整数 Unix ms）
  - `cwd?: string`（须为绝对路径）
  - `parentSession?: SessionId`
  - `seedLength?: number`
  - `origin?: 'subagent'`
  - `delegationDepth?: number`
  - `agentPreset?: string`
- `Session.append` 重要约束：
  - `data` 必须是无损 JSON 可序列化（BigInt/function/symbol/undefined/-0/非有限数/循环引用/sparse array/Map/Set/Date/class 实例都会被拒绝）。
  - 对三类 surface 事件（`SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'`），`append` 必须携带 `SurfaceIntent`（`{ surfaceOp, sourceEventSeqs? }`），`surfaceOp` 必填（`'append'` 或 `{op:'replace',start,end}`）。
  - 非 surface 事件（如 `turn/start`、`sandore/*`）不得携带 `surfaceOp`/`sourceEventSeqs`，否则运行时抛错。

### 1.4 `SessionEvent` / `SessionEventMap` / `meta` 形状

- `SessionEvent<T>` 是「按 `type` 判别的 discriminated union」，统一 envelope：
  - `{ type: K; seq: number; time: number; data: SessionEventMap[K]; ignorable?: true }`
  - 仅 `K extends SurfaceEventType` 时额外有 `sourceEventSeqs?: number[]` 与 `surfaceOp?: SurfaceOp`。
- 核心 `SessionEventMap`（本包声明的基础词汇，插件可经 module augmentation 扩展）：
  - `'turn/start'`: `{ turn: number }`
  - `'turn/end'`: `{ turn: number; reason: TurnEndReason }`
  - `'step/start'`: `{ turn: number; step: number }`
  - `'step/end'`: `{ turn: number; step: number }`
  - `'user/message'`: `UserMessage`（surface）
  - `'assistant/chunk'`: `{ turn; step; chunk: StreamChunk }`
  - `'assistant/message'`: `{ turn; step; message: AssistantMessage; usage?: TokenUsage }`（surface）
  - `'tool/call'`: `{ turn; step; callId: CallId; name: string; arguments: string }`
  - `'tool/result'`: `{ turn; step; message: ToolResultMessage; error?: {name,code}; meta?: JsonValue }`（surface）
  - `'todo/write'`: `{ todos: TodoItem[] }`
  - `'request/header'`: `{ header: EpochHeader; reason: RequestHeaderReason }`
  - `'request/context'`: `RequestContext`
  - `'session/end-seed'`: `Record<string, never>`（log-only，构造 seed 边界标记）
- `CreateSessionOptions`（`create`/`prepare` 的 `options`）：
  - `seed?: readonly SessionEvent[]`（构造期 replay/fork 历史；`Session` 构造时要求 seed 从 seq 0 连续）。
  - `meta?: { cwd?: string; parentSession?: SessionId; createdAt?: number; seedLength?: number; origin?: 'subagent'; delegationDepth?: number; agentPreset?: string }`。

### 1.5 sandore 侧的 `SessionEventMap` 扩展（`seam.ts` 已声明）

`packages/sandore/workflow/src/seam.ts` 通过 `declare module '@deepseek-ai/dsh-session/types'` 扩展了 `SessionEventMap`，新增 `sandore/*` 事件的 data 形状，`workflow-engine.ts` 用 `session.append('sandore/xxx', data)` 双发（`ctx.emit` + session append），且均不带 `surfaceOp`（因为不是 surface 事件）：

- `'sandore/start'`: `{ taskId; workflowId; jobId }`
- `'sandore/stage-start'`: `{ taskId; stageId }`
- `'sandore/stage-completed'`: `{ taskId; stageId; stageContract: StageContract }`
- `'sandore/step-start'`: `{ stepId; childId }`
- `'sandore/step-completed'`: `{ stepId; childId; output: ContentBlock[] }`
- `'sandore/step-failed'`: `{ stepId; childId; error: string }`
- `'sandore/step-paused'`: `{ stepId; childId }`
- `'sandore/step-resumed'`: `{ stepId; childId; resumePrompt? }`
- `'sandore/step-retried'`: `{ stepId; mode }`
- `'sandore/question'`: `{ question: PendingQuestion }`
- `'sandore/permission'`: `{ permission: PendingPermission }`
- `'sandore/end'`: `{ taskId; jobId; result: DagResultInfo }`
- `'sandore/aborted'`: `{ taskId }`

---

## (2) `schema.ts` 中 Gates / Finalize 相关 schema 精确形状

来源: `D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`（`zod`，`z.infer` 派生类型；经 `index.ts` 的 `export * from './schema.ts'` 全量导出）。

### 2.1 `GatesSchema` / `Gates`

```ts
export const GatesSchema = z.object({
  maxRetries: z.number().optional(),
  maxTokens: z.number().optional(),
  primary: z.object({ enabled: z.boolean() }).optional(),
  secondary: z.object({ enabled: z.boolean(), prompt: z.string().optional() }).optional(),
  need_confirm: z.boolean().optional(),
})
export type Gates = z.infer<typeof GatesSchema>
```

即 Gates 形状：`{ maxRetries?: number; maxTokens?: number; primary?: { enabled: boolean }; secondary?: { enabled: boolean; prompt?: string }; need_confirm?: boolean }`。`Gates` 挂载点：`WorkflowDefinitionSchema.gates`、`WorkflowStageSchema.gates`、`WorkflowStepSchema.gates`（三级均为 optional）。

### 2.2 `FinalizeAssessResultSchema`（foundation-01 已建）

```ts
export const FinalizeAssessResultSchema = z.object({
  completionType: z.enum(['completed', 'ask']),
  passThroughVars: z.record(z.string(), z.string()),
  askQuestion: AskUserQuestionPayloadSchema.optional(),
  errorDetail: z.string().optional(),
  forkSessionId: z.string(),
  assessmentRaw: z.string(),
})
export type FinalizeAssessResult = z.infer<typeof FinalizeAssessResultSchema>
```

### 2.3 `GateEvalResultSchema`（foundation-01 已建）

```ts
export const GateEvalResultSchema = z.object({
  gatesPassed: z.boolean(),
  primaryPassed: z.boolean(),
  secondaryPassed: z.boolean().optional(),
  gateDetails: z.object({
    primary: z.object({ enabled: z.boolean(), passed: z.boolean() }),
    secondary: z.object({ enabled: z.boolean(), passed: z.boolean(), prompt: z.string().optional() }),
  }).optional(),
  errorDetail: z.string().optional(),
  gateSessionId: z.string(),
  assessmentRaw: z.string(),
})
export type GateEvalResult = z.infer<typeof GateEvalResultSchema>
```

### 2.4 `FinalizeMetaSchema`（foundation-01 已建，Step 收尾状态元数据）

```ts
export const FinalizeMetaSchema = z.object({
  status: z.enum(['evaluating', 'completed', 'ask']),
  sessionId: z.string().optional(),
  gateSessionId: z.string().optional(),
  directory: z.string().optional(),
  errorDetail: z.string().optional(),
  completionType: z.enum(['completed', 'ask']).optional(),
  assessResult: FinalizeAssessResultSchema.optional(),
  gateResult: GateEvalResultSchema.optional(),
})
export type FinalizeMeta = z.infer<typeof FinalizeMetaSchema>
```

### 2.5 `AskUserQuestionPayloadSchema`（foundation-01 已建）

```ts
export const AskUserQuestionPayloadSchema = z.object({
  questions: z.array(z.object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    options: z.array(z.object({
      label: z.string(),
      description: z.string().optional(),
    })).optional(),
    multi_select: z.boolean().optional(),
  })),
})
export type AskUserQuestionPayload = z.infer<typeof AskUserQuestionPayloadSchema>
```

> 注意：`FinalizeAssessResultSchema` 中 `passThroughVars` 为 `z.record(string, string)`（值域为 string），与运行时 `WorkflowTaskState.passThroughVars` 的 `PassThroughVarValueSchema`（`{ value; description; refresh? }`）不同。

---

## (3) `types.ts` 中相关类型精确形状

来源: `D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`。

- `FinalizeAssessResult` / `GateEvalResult` / `AskUserQuestionPayload` / `PassThroughVar` 均是从 `schema.ts` **re-export 的类型**（`export type { ... } from './schema.ts'`），其形状即为上方 `z.infer` 结果：
  - `PassThroughVar`（`PassThroughVarSchema`）：`{ name: string; value: string; description: string; refresh?: boolean }`
  - `AskUserQuestionPayload`：`{ questions: Array<{ id: string; question: string; header?: string; options?: Array<{ label: string; description?: string }>; multi_select?: boolean }> }`
  - `FinalizeAssessResult`：`{ completionType: 'completed' | 'ask'; passThroughVars: Record<string, string>; askQuestion?: AskUserQuestionPayload; errorDetail?: string; forkSessionId: string; assessmentRaw: string }`
  - `GateEvalResult`：`{ gatesPassed: boolean; primaryPassed: boolean; secondaryPassed?: boolean; gateDetails?: { primary: { enabled: boolean; passed: boolean }; secondary: { enabled: boolean; passed: boolean; prompt?: string } }; errorDetail?: string; gateSessionId: string; assessmentRaw: string }`
- `FinalizeOutcome`（types.ts 内直接定义，收尾最终结果三态联合）：

```ts
export type FinalizeOutcome =
  | { type: 'done'; completionType: 'completed'; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
  | { type: 'ask'; assessResult: FinalizeAssessResult }
  | { type: 'error'; errorDetail: string; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
```

- `StageContract`（types.ts 内 interface，与 `schema.ts` 的 `StageContractSchema` 对齐）：

```ts
export interface StageContract {
  stageId: string
  stageName: string
  status: StepStatus
  artifacts: Array<{ stepId: string; outputToId: string; files: string[]; returnPrompt?: string }>
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>
  contractArtifacts: Record<string, string[]>
  completedAt: string
  errorDetail?: string
}
```

---

## (4) `branch-evaluator.ts` 的 `ctx.llm.stream` 临时会话聚合链与 shell 分支范式

来源: `D:/project-code/llm/sandore/packages/sandore/microflow/src/branch-evaluator.ts`。

### 4.1 AI 临时会话聚合链（`startAi` → `aggregate`）

- import：`BlockAssembler, createUserMessage` 与类型 `GenerateOptions, StreamChunk` 来自 `@deepseek-ai/dsh-llm`。
- 链路：
  1. `resolveProviderModel(condition.value)`（三层回退：定义 `providerId`+`modelId` 成对 → 引擎默认 → `ctx.llm` 目录兜底），返回 `{ provider, model }`。
  2. `replacePassThroughVars(condition.value.promptText, resolvePassThroughVars(options.passThroughVars, loopTurn, loopMaxIterations))`。
  3. `buildBranchPrompt(taskText, contextMessage, branches)` 生成结构化评估提示词。
  4. `createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] })` 构造 user message。
  5. `newSessionHandle()` 生成 `eval-<8位hex>`（`TempSessionHandle = string`）—— 注意这是**合成句柄字符串，不是 DSH `Session` 对象**。
  6. 组装 `GenerateOptions = { provider, model, messages: [message], signal? }`。
  7. `new BlockAssembler()` + `this.ctx.llm.stream(generateOptions)` 得到 `AsyncIterable<StreamChunk>`。
  8. `aggregate(stream, assembler)`：`for await (const chunk of stream) assembler.push(chunk)`；读取 `assembler.finish`，`kind === 'error'` 或 `'aborted'` 时抛 `SandoreError('STEP_EXECUTION')`；成功返回 `textSummary(assembler.blocks())`（`textSummary` 来自 `internal.ts`，仅拼接 text 块）。
- 结论：branch-evaluator 的「临时会话」是「合成 sessionHandle + `ctx.llm.stream` 流聚合」，并未通过 `ctx.sessions.create/fork` 创建真实 `Session`。这与 FinalizeAssessor 需 `ctx.sessions.fork` 创建真实子会话是不同的复用点。

### 4.2 shell 分支评估范式

- 简单命令（无 stdin、无 env 注入）：`ctx.shell.resolve(request)` → `ctx.shell.run(spec)` → `toStdout`（`ShellExecRequest`/`ShellRunResult`）。
- 复杂命令（有 stdin/env）：`splitCommand` → `ctx.subprocess.resolveExecutable` → `ctx.subprocess.spawn(spec)`（`SubprocessSpawnSpec`，含 `stdio.stdin = { data }`、`stdout/stderr.maxBytes`、`env`）→ 读 `handle.done`/`handle.collected` → 组装 `ShellRunResult` → `toStdout`。
- 两种 shell 分支的 `sessionHandle` 均为 `null`。
- 失败语义：`toStdout` 对非零退出/超时/中止抛 `SandoreError`（`STEP_TIMEOUT` / `STEP_EXECUTION`）。

---

## (5) `file-utils.ts` 导出（门禁产物验证与透传变量替换复用）

来源: `D:/project-code/llm/sandore/packages/sandore/microflow/src/file-utils.ts`（经 `microflow/src/index.ts` 的 `export * from './file-utils.ts'` 全量导出）。

关键导出签名：

```ts
export function replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string
export async function findFilesByGlob(fs: FileSystem, rootDir: string, pattern: string): Promise<string[]>
export async function findFilesByRegex(fs: FileSystem, rootDir: string, regex: string): Promise<string[]>
export async function walkDir(fs: FileSystem, dir: FsTarget): Promise<string[]>
export async function readOutputJson(fs: FileSystem, dir: string, stepMessageId: string): Promise<StepOutputFile>
export async function writeOutputJson(fs: FileSystem, dir: string, stepMessageId: string, data: StepOutputFile): Promise<string>
export function outputJsonFileName(stepMessageId: string): string  // `${stepMessageId}_output.json`
export function globToRegex(glob: string): RegExp
export function isGlobPattern(pattern: string): boolean
export function escapeRegexChar(char: string): string
export function resolvePathSegments(executedSteps, currentIndex, path): ExecutedStepDefault[]
export function resolveFromInputFrom(executedSteps, currentIndex, inputFromItems): ExecutedStepDefault[]
export function idMatches(actualId: string, targetId: string): boolean
```

相关结构类型：

```ts
export interface FileSystem {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  processPath(target: FsTarget): string
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(target: FsTarget, content: string): Promise<FsWriteOutcome>
}
export interface FsTarget { readonly targetKey: string; readonly displayPath: string }
export interface FsDirEntry { readonly name: string; readonly type: 'file' | 'directory' | 'other'; readonly target: FsTarget }
export interface OutputArtifact { readonly id: string; readonly value: string[] }
export interface StepOutputFile {
  readonly sessionId: string
  readonly output: { readonly returnPrompt: string; readonly artifacts: OutputArtifact[] }
}
```

要点：
- `findFilesByGlob`：`globToRegex` 转锚定正则，递归 `collectFiles`（跳过 `.` 与 `node_modules`），按 `relativePath` 匹配，返回进程绝对路径。
- `findFilesByRegex`：`new RegExp(regex)`，非法 regex 抛 `Error('invalid regex ...')`。
- `replacePassThroughVars`：`${xxx}` 已定义则替换，未定义保留原文。
- `readOutputJson`：读 `${dir}/${stepMessageId}_output.json`，逐字段校验 `StepOutputFile` 形状（`sessionId`、`output.returnPrompt`、`output.artifacts`），畸形时抛 `Error('malformed output json: ...')`。
- `FileSystem` 是结构类型接缝（`ctx.fs` 上下文键已在 `file-utils.ts` 中 `declare module '@deepseek-ai/cordis'` 声明为 `fs: FileSystem`）。

---

## (6) sessions mock 与测试范式

来源: `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/sessions.ts`。

### 6.1 `FakeSession` / `FakeSessionStore`（是否支持 fork：**不支持**）

```ts
export class FakeSession {
  readonly events: Array<{ type: string; data: unknown }> = []
  append(type: string, data: unknown): { type: string; seq: number; time: number; data: unknown } {
    this.events.push({ type, data })
    return { type, seq: this.events.length - 1, time: Date.now(), data }
  }
}

export class FakeSessionStore {
  private readonly sessions = new Map<string, FakeSession>()
  private counter = 0
  create(id?: string): FakeSession { /* 新 FakeSession 并登记 */ }
  get(id: string): FakeSession | undefined
  list(): FakeSession[]
}
```

- `FakeSessionStore` 只有 `create`/`get`/`list`，**没有 `fork`**（也没有 `prepare`/`enter`/`announce`/`flush`）。若 finalize-manager 依赖 `ctx.sessions.fork`，现有 mock 无法直接覆盖该路径。
- `FakeSession.append` 的返回形状为 `{ type, seq, time, data }`（与 DSH `Session.append` 的 `SessionEvent` envelope 对齐，但不校验 JSON 可序列化、不校验 surface metadata）。

### 6.2 测试范式（vitest + cordis `ctx.provide` 注入内存 mock）

来源: `packages/sandore/workflow/src/workflow-engine.spec.ts` 与 `packages/sandore/microflow/src/branch-evaluator.spec.ts`。

- `new Context()`（来自 `@deepseek-ai/cordis`）作为根 context。
- 用 `ctx.provide(key, mock as unknown as 目标类型)` 注入各 DSH 服务：`'llm'`（`FakeLlm`）、`'shell'`（`FakeShell`）、`'subprocess'`（`FakeSubprocess`）、`'sessions'`（`FakeSessionStore`）、`'storageDomain'`（`MemoryStorageDomain`）、以及桩 `'sessionPersistence'`/`'subagents'`/`'fs'`（`{}`）。
- 需要持久化时 `await ctx.plugin(SandorePersistence)` 后取 `ctx.sandorePersistence`；引擎 `await ctx.plugin(SandoreEngineRuntime, config)` 后取 `ctx.sandoreEngine`。
- 断言用 vitest `describe`/`it`/`expect`；异步收尾用 `ctx.once('sandore/end' ...)` / `ctx.once('sandore/aborted' ...)` 包成 `waitForEnd`/`waitForAborted` promise；事件记录用 `ctx.on('sandore/*', ...)` 收集。
- 相关 mock 文件：
  - `tests/mocks/llm.ts`：`FakeLlm`（`listProviders`/`listModels`/`stream`，`calls: GenerateOptions[]` 记录，`streamHandler` 可注入）、`textChunks(text, reason?)` 生成含 `block-start`/`text-delta`/`block-end`/`finish` 的固定 `AsyncIterable<StreamChunk>`。
  - `tests/mocks/shell.ts`：`FakeShell`（`resolve`/`run`，`requests`/`specs` 记录，`resolveHandler`/`runHandler` 可注入）、`successResult(spec, stdout?)`。
  - `tests/mocks/subprocess.ts`：`FakeSubprocess`（`resolveExecutable`/`spawn`，`resolved`/`specs` 记录，`resolveHandler`/`outcomeHandler` 可注入）、`FakeSubprocessHandle`、`successOutcome()`。

---

## 附：关键文件绝对路径

- DSH session 类型: `D:/project-code/llm/sandore/node_modules/.pnpm/@deepseek-ai+dsh-session@0._959f4648d9537c86268b5de534a89875/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts`
- DSH session 类型（event/header）: 同目录 `lib/types/types.d.ts`
- DSH session 编译实现（fork 细节）: 同目录 `lib/index.js`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/index.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/branch-evaluator.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/file-utils.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/internal.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/index.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/sessions.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/llm.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/shell.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/subprocess.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts`
- `D:/project-code/llm/sandore/packages/sandore/microflow/src/branch-evaluator.spec.ts`
