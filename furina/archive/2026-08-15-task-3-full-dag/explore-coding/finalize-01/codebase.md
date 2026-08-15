## Exploration Result

Phase 3（furina-codebase）无结果：`docs/codebase` 目录为空，且 `furina config show project.sourcecode codebases` 仅返回 `docs/codebase` 一项，未产出可读内容。以下全部为 Phase 4 补充探索结果。

## Supplementary Exploration Result

### 0. 结论要点（先读）

- sandore 使用的 `ctx.sessions` 是 **`@deepseek-ai/dsh-session` 的服务端内存存储 `SessionStore`**（`declare module '@deepseek-ai/cordis' { interface Context { sessions: SessionStore } }`），**不是** client-runtime 的 `ISessions`。证据：`workflow-engine.ts` 从 `@deepseek-ai/dsh-session` 导入 `Session`/`SessionId` 并调用 `this.ctx.sessions.create(SessionId(instanceId), { meta: { cwd } })`，且 `session.append(...)` 与 dsh-session 的 `Session.append` 一致。
- 因此 exploreContent 第 (1) 项描述的“source 参数、boundary 语义、childSessionId、返回 Session 类型”精确对应 **`SessionStore.fork(source, boundary?, childSessionId?): Session`**（见 §1.1），与 finalize-management spec 中 `ctx.sessions.fork(stepSessionId)`（boundary 省略取源最后一条事件）的用法一致。
- `workflow/tests/mocks/sessions.ts` 的 `FakeSessionStore` **没有 fork 方法**（仅 `create/get/list`），编写 finalize-manager.spec 涉及 fork 时该 mock 需要扩展（本次仅记录事实，不提议方案）。

---

### 1. DSH `ctx.sessions.fork` 真实签名与 Session 结构

来源：`node_modules/@deepseek-ai/dsh-session`（`lib/types/index.d.ts` + `lib/index.js`）。

#### 1.1 `SessionStore.fork`（sandore 实际使用的 `ctx.sessions`）

```ts
// lib/types/index.d.ts
export type SessionForkSource = Session | SessionId;

export declare class SessionStore extends Service {
  create(id?: SessionId, options?: CreateSessionOptions): Session;
  get(id: SessionId): Session | undefined;
  list(): Session[];
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session;
}
```

三个参数的精确语义（来自 d.ts 注释 + `lib/index.js` 实现）：

| 参数 | 类型 | 语义 |
|---|---|---|
| `source` | `SessionForkSource = Session \| SessionId` | 必须是 store 的**活**源会话（对象或 id） |
| `boundary` | `number`（可选） | **包含式（inclusive）** 源事件 seq，fork 到该事件为止（`events.slice(0, boundary + 1)`）；省略 = 源当前最后一条事件；**空源省略 = fork 空子会话（`_forkSeed` 返回 `[]`）** |
| `childSessionId` | `SessionId`（可选） | 可选子会话 id；省略委托给 `SessionStore` 的 id 策略（mint `session-<n>`） |
| 返回 | `Session` | 创建出的活子会话（`create` 内部会 `enter`+`announce`） |

`fork` 实现（`lib/index.js` 1840-1852）：

```js
fork(source, boundary, childSessionId) {
  if (childSessionId !== void 0 && this.get(childSessionId) !== void 0)
    throw new SessionForkError(`session "${childSessionId}" already exists`, "SESSION_ALREADY_EXISTS");
  const liveSource = this._resolveForkSource(source);
  const seed = this._forkSeed(liveSource, boundary);
  return this.create(childSessionId, {
    seed,
    meta: {
      ...(liveSource.header.cwd !== void 0 ? { cwd: liveSource.header.cwd } : {}),
      parentSession: liveSource.id,
      seedLength: seed.length,
    },
  });
}
```

子会话 `meta`（写入 `SessionHeader`）：`cwd`（继承源 header.cwd，若存在）、`parentSession = 源 id`、`seedLength = seed 事件数`。

`SessionForkErrorCode`（5 种，均抛出 `SessionForkError`，带 `code` 字段）：

```ts
export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'     // 源 id 不在 store 中（对象源也要求 get(source.id) 命中）
  | 'SESSION_NOT_LIVE'      // 源对象不是 store 的活实例（get(source.id) !== source）
  | 'SESSION_ALREADY_EXISTS'// childSessionId 已被占用
  | 'INVALID_BOUNDARY'      // 非安全整数/负数；boundary >= events.length；events[boundary].seq !== boundary（不连续）
  | 'OPEN_TURN';            // boundary 前最后一次 turn/start|turn/end 是 turn/start（落在开放 turn 内）
```

`_forkSeed` 边界校验（`lib/index.js` 1853-1872）：boundary 省略且空源返回 `[]`；`boundary` 非负安全整数；`boundary < events.length`（`>=` 抛 INVALID_BOUNDARY）；`events[boundary].seq === boundary`；`events.slice(0, boundary+1)` 中最后一个 `turn/start`/`turn/end` 为 `turn/start` 时抛 `OPEN_TURN`。

#### 1.2 `Session` 结构（dsh-session）

```ts
export declare class Session {
  readonly header: SessionHeader;      // 不可变存储元数据（非事件日志）
  get id(): SessionId;                 // 派生自 header
  readonly firstLiveSeq: number;       // 本进程第一次 append 的 seq（seed 长度）
  get events(): readonly SessionEvent[]; // 不可变事件日志快照
  get seq(): number;                   // 下一条事件 seq = 日志长度
  get surface(): SessionSurface;       // 有序 surface
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []): SessionEvent<T>;
  deriveMessages(): Message[];
  deriveEventMessage(event: SessionEvent): Message | null;
  static create(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader): Session;
  static fromRestore(id: SessionId, seed: readonly SessionEvent[], header: SessionHeader): Session;
}
```

`SessionHeader`：

```ts
interface SessionHeader {
  readonly version: number;            // SESSION_FORMAT_VERSION = 0
  readonly id: SessionId;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: SessionId;  // fork 血缘
  readonly seedLength?: number;        // 继承的前导事件数
  readonly origin?: 'subagent';
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}
```

`CreateSessionOptions`（`SessionStore.create` 第二参，也是 fork 内部复用）：

```ts
interface CreateSessionOptions {
  readonly seed?: readonly SessionEvent[];   // replay/fork 历史
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly createdAt?: number;
    readonly seedLength?: number;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
}
```

`SessionId`：`Branded<'SessionId'>`（编译期品牌，无运行时成本），构造函数 `SessionId(id: string): SessionId`。

#### 1.3 `SessionEvent` / `meta` 形状

`SessionEvent<T>` 是对 `type` 的判别联合（switch `event.type` 收窄 `event.data`）：

```ts
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K;
    seq: number;         // 会话内单调递增
    time: number;        // Unix epoch 毫秒
    data: SessionEventMap[K];
    ignorable?: true;    // 未识别 type 且无此标记 → 必须拒绝重建
  } & (K extends SurfaceEventType ? {
    sourceEventSeqs?: number[];  // 引用更早事件 seq
    surfaceOp?: SurfaceOp;       // 如何进入 surface
  } : object);
}[T];

type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result';
type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number };
```

`SessionEventMap`（事件类型 → 载荷）：

- `'turn/start'`: `{ turn: number }`
- `'turn/end'`: `{ turn: number; reason: TurnEndReason }`
- `'step/start'`: `{ turn: number; step: number }`
- `'step/end'`: `{ turn: number; step: number }`
- `'user/message'`: `UserMessage`
- `'assistant/chunk'`: `{ turn: number; step: number; chunk: StreamChunk }`
- `'assistant/message'`: `{ turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }`
- `'tool/call'`: `{ turn: number; step: number; callId: CallId; name: string; arguments: string }`
- `'tool/result'`: `{ turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string }; meta?: JsonValue }`
- `'todo/write'`: `{ todos: TodoItem[] }`
- `'request/header'`: `{ header: EpochHeader; reason: RequestHeaderReason }`
- `'request/context'`: `RequestContext`
- `'session/end-seed'`: `Record<string, never>`（seed 结束标记，空载荷）

`meta` 形状：仅在 `tool/result` 事件上出现，类型 `meta?: JsonValue`（JSON 可序列化、工具私有），`Session.append` 会以 `isJsonValue` 运行时校验。

#### 1.4 备注：client-runtime 的 `ISessions.fork`（非 sandore 使用，仅供区分）

`@deepseek-ai/dsh-client-runtime` 的 `ISessions.fork` 是**客户端**对象层接口，形状完全不同：

```ts
fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>;
```

其 `atSeq` 语义是“first turn/end at or after it”，返回 `Promise<SessionId>`。sandore 的 `ctx.sessions` 是 dsh-session 的 `SessionStore`，**与它无关**，勿混用。

---

### 2. workflow/src/schema.ts 精确形状

文件：`packages/sandore/workflow/src/schema.ts`（foundation-01 已建，全部 `export const`，派生 `z.infer` 类型均 `export type`）。

#### 2.1 `GatesSchema` / `Gates`

```ts
export const GatesSchema = z.object({
  maxRetries: z.number().optional(),
  maxTokens: z.number().optional(),
  primary: z.object({ enabled: z.boolean() }).optional(),
  secondary: z.object({ enabled: z.boolean(), prompt: z.string().optional() }).optional(),
  need_confirm: z.boolean().optional(),
});
export type Gates = z.infer<typeof GatesSchema>;
// { maxRetries?: number; maxTokens?: number;
//   primary?: { enabled: boolean };
//   secondary?: { enabled: boolean; prompt?: string };
//   need_confirm?: boolean }
```

注意：`secondary.prompt` 是可选字段；`primary` 无 prompt。

#### 2.2 `FinalizeMetaSchema` / `FinalizeMeta`

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
});
export type FinalizeMeta = z.infer<typeof FinalizeMetaSchema>;
```

#### 2.3 `AskUserQuestionPayloadSchema` / `AskUserQuestionPayload`

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
});
export type AskUserQuestionPayload = z.infer<typeof AskUserQuestionPayloadSchema>;
```

#### 2.4 `FinalizeAssessResultSchema` / `FinalizeAssessResult`

```ts
export const FinalizeAssessResultSchema = z.object({
  completionType: z.enum(['completed', 'ask']),
  passThroughVars: z.record(z.string(), z.string()),
  askQuestion: AskUserQuestionPayloadSchema.optional(),
  errorDetail: z.string().optional(),
  forkSessionId: z.string(),
  assessmentRaw: z.string(),
});
export type FinalizeAssessResult = z.infer<typeof FinalizeAssessResultSchema>;
```

#### 2.5 `GateEvalResultSchema` / `GateEvalResult`

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
});
export type GateEvalResult = z.infer<typeof GateEvalResultSchema>;
```

#### 2.6 其他相关导出（读写 finalize 时涉及）

- `ExecutedStepDefaultSchema` 含 `finalizeMeta: FinalizeMetaSchema.optional()`、`sessionMeta: StepSessionMetaSchema.optional()`、`parentSessionId: z.string().optional()`、`output: z.array(ContentBlockSchema).optional()`。
- `StepSessionMetaSchema`: `{ childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']) }`。
- `PassThroughVarSchema`（Step 定义层透传变量）: `{ name; value; description; refresh?: boolean }`。
- `PassThroughVarValueSchema`（运行时/Stage 契约共用）: `{ value; description; refresh?: boolean }`。
- `WorkflowTaskStateSchema.passThroughVars`: `z.record(z.string(), PassThroughVarValueSchema)`。

---

### 3. workflow/src/types.ts 精确形状

文件：`packages/sandore/workflow/src/types.ts`。`FinalizeAssessResult`/`GateEvalResult`/`AskUserQuestionPayload`/`PassThroughVar` 从 schema.ts re-export（`export type`），本文件原生定义 `StageContract` 与 `FinalizeOutcome`。

#### 3.1 `PassThroughVar`（re-export，定义见 schema.ts）

```ts
{ name: string; value: string; description: string; refresh?: boolean }
```

#### 3.2 `StageContract`（原生 interface）

```ts
export interface StageContract {
  stageId: string;
  stageName: string;
  status: StepStatus;   // StepStatus = 'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'
  artifacts: Array<{
    stepId: string;
    outputToId: string;
    files: string[];
    returnPrompt?: string;
  }>;
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>;
  contractArtifacts: Record<string, string[]>;
  completedAt: string;
  errorDetail?: string;
}
```

#### 3.3 `FinalizeOutcome`（原生 type）

```ts
export type FinalizeOutcome =
  | { type: 'done'; completionType: 'completed'; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
  | { type: 'ask'; assessResult: FinalizeAssessResult }
  | { type: 'error'; errorDetail: string; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult };
```

#### 3.4 `ExecutedStepDefault`（原生 interface，finalize 读写载体）

```ts
export interface ExecutedStepDefault {
  type: 'default';
  id: string;
  stepId?: string;
  stageId: string;
  name: string;
  status: StepStatus;
  command?: CommandConfig;
  inputFrom?: InputFromItem[];
  outputTo?: OutputToItem[];
  passThroughVars?: PassThroughVar[];
  sessionMeta?: StepSessionMeta;
  finalizeMeta?: FinalizeMeta;    // ← finalize-manager 回写目标
  visitCount: number;
  branchMeta?: BranchMeta;
  error?: string;
  pausedAt?: string;
  resumedAt?: string;
  resumePrompt?: string;
  sessionMessages?: SessionMessage[];
  pauseEntryId?: string;
  loopIteration?: number[];
  loopMeta?: BranchMeta;
  retryHistory?: RetryRecord[];
  parentSessionId?: string;
  output?: ContentBlock[];        // ContentBlock 来自 @deepseek-ai/dsh-llm
}
```

---

### 4. branch-evaluator.ts 临时会话聚合链与 shell 分支范式

文件：`packages/sandore/microflow/src/branch-evaluator.ts`。这是 Assessor/GateEvaluator 临时会话复用的现成范式。

#### 4.1 AI 临时会话聚合链（`startAi`）

调用顺序（branch-evaluator.ts 258-282）：

1. `resolveProviderModel(condition.value)` → `internal.resolveProviderModel` 三层回退（L1 `providerId`+`modelId` → L2 引擎默认 → L3 `llm.listProviders()/listModels()`）返回 `{ provider, model }`。
2. `replacePassThroughVars(condition.value.promptText, resolvePassThroughVars(options.passThroughVars, loopTurn, loopMaxIterations))` —— `${xxx}` 替换（`in-loop-turn`/`all-loop-turn` 自动注入）。
3. `buildBranchPrompt(taskText, contextMessage, branches)` 组装结构化提示词（主头部 + 任务 + 上下文 + 候选分支 + JSON 返回格式 + 红线规则）。
4. `createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] })`。
5. `const sessionHandle = this.newSessionHandle()` —— `TempSessionHandle = string`，值为 `eval-${randomUUID().replace(/-/g,'').slice(0,8)}`。
6. `new BlockAssembler()`；`GenerateOptions { provider, model, messages: [message], signal? }`。
7. `const stream = this.ctx.llm.stream(generateOptions)`；`outputPromise = this.aggregate(stream, assembler)`。

`aggregate`（295-307）：

```ts
for await (const chunk of stream) assembler.push(chunk);
const finish = assembler.finish;
if (finish.kind === 'error') throw new SandoreError(..., 'STEP_EXECUTION');
if (finish.kind === 'aborted') throw new SandoreError(..., 'STEP_EXECUTION');
return textSummary(assembler.blocks());
```

#### 4.2 dsh-llm 依赖精确签名

`BlockAssembler`（`@deepseek-ai/dsh-llm/assembler`）：

```ts
class BlockAssembler {
  push(chunk: StreamChunk): void;
  blocks(): ContentBlock[];
  get usage(): TokenUsage | undefined;
  get finish(): FinishReason;     // 无 finish chunk 时默认 { kind: 'stop' }
  get replayState(): unknown;
  message(source?: MessageSource): Message;
}
```

`FinishReason`（判别联合）：

```ts
{ kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }
| { kind: 'aborted'; failure: LlmFailure } | { kind: 'error'; failure: LlmFailure };
// LlmFailure = { message: string; code: string; status?: number; providerRetryAfterMs?: number; requestId?: ProviderRequestId }
```

`createUserMessage`（`@deepseek-ai/dsh-llm/message`）：

```ts
function createUserMessage<T extends NewUserMessage>(
  input: T & { id?: never; role?: never }
): T & Pick<UserMessage, 'id' | 'role'>;
// NewUserMessage = Omit<UserMessage, 'id' | 'role'>，即 { content: ContentBlock[]; source: MessageSource }
```

`GenerateOptions`（`@deepseek-ai/dsh-llm`）：`{ provider; model; reasoningEffort?; messages: Message[]; system?; tools?; temperature?; maxTokens?; stop?; signal?; sessionId?; purpose? }`。

`textSummary`（`microflow/src/internal.ts`）：提取 `ContentBlock[]` 中 `type === 'text'` 块的 `text`，按序 `\n` 拼接；`undefined` 返回 `''`。

#### 4.3 shell 分支范式（`startShell`，sessionHandle = null）

- 简单命令（无 stdin、无 env）：`ctx.shell.resolve(request)` → `ctx.shell.run(spec)`（`ShellExecRequest { command, timeoutMs, workdir?, signal? }`）。
- 注入命令（有 stdin 或 env）：`splitCommand` → `ctx.subprocess.resolveExecutable(program, env, signal)` → `ctx.subprocess.spawn(spec)`（`SubprocessSpawnSpec { argv, cwd, stdio: { stdin: 'ignore'|{data}, stdout:{maxBytes}, stderr:{maxBytes} }, graceMs, env?, signal? }`）。
- 输出 = stdout 文本；非零退出/超时/中止映射 `SandoreError`（`STEP_TIMEOUT`/`STEP_EXECUTION`）。
- `sessionHandle = null`，`outputPromise = Promise.resolve(output)`。

`BranchEvalResult`/`BranchEvalPartial`（可参考的两阶段形态）：

```ts
interface BranchEvalResult { readonly output: string; readonly sessionHandle: TempSessionHandle | null; }
interface BranchEvalPartial { readonly sessionHandle: TempSessionHandle | null; readonly outputPromise: Promise<string>; }
```

---

### 5. file-utils.ts 导出（门禁产物验证与透传变量替换）

文件：`packages/sandore/microflow/src/file-utils.ts`（microflow 包入口 `index.ts` 已 `export * from './file-utils.ts'`）。

| 导出 | 签名 | 说明 |
|---|---|---|
| `replacePassThroughVars` | `(str: string, vars: Readonly<Record<string,string>>): string` | 替换 `${xxx}`；未定义保留原文 |
| `findFilesByGlob` | `(fs: FileSystem, rootDir: string, pattern: string): Promise<string[]>` | glob→regex 递归匹配相对路径，返回进程绝对路径数组 |
| `findFilesByRegex` | `(fs: FileSystem, rootDir: string, regex: string): Promise<string[]>` | 非法正则抛 `Error('invalid regex ...')` |
| `readOutputJson` | `(fs: FileSystem, dir: string, stepMessageId: string): Promise<StepOutputFile>` | 读 `{stepMessageId}_output.json` 并逐字段校验 |
| `writeOutputJson` | `(fs, dir, stepMessageId, data: StepOutputFile): Promise<string>` | 写产物文件 |
| `outputJsonFileName` | `(stepMessageId: string): string` | `{stepMessageId}_output.json` |
| `walkDir` | `(fs: FileSystem, dir: FsTarget): Promise<string[]>` | 递归遍历全部文件绝对路径 |
| `globToRegex` / `escapeRegexChar` / `isGlobPattern` | 纯函数 | glob↔regex 转换 |
| `idMatches` / `resolvePathSegments` / `resolveFromInputFrom` | 纯函数 | InputFrom 就近匹配 |

`StepOutputFile` / `OutputArtifact`（`readOutputJson` 返回形状）：

```ts
interface OutputArtifact { readonly id: string; readonly value: string[]; }
interface StepOutputFile {
  readonly sessionId: string;
  readonly output: { readonly returnPrompt: string; readonly artifacts: OutputArtifact[] };
}
```

`FileSystem` 结构接缝（target 导向两段式协议，函数以 `fs` 结构类型入参、不绑 `ctx`）：

```ts
interface FileSystem {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  writeText(target: FsTarget, content: string): Promise<FsWriteOutcome>;
}
```

`collectFiles` 递归时跳过 `.` 与 `node_modules`；glob/regex 匹配的是**相对 rootDir 的路径**。

---

### 6. sessions mock 与测试范式

文件：`packages/sandore/workflow/tests/mocks/sessions.ts`。

```ts
export class FakeSession {
  readonly events: Array<{ type: string; data: unknown }> = [];
  append(type: string, data: unknown): { type: string; seq: number; time: number; data: unknown } {
    this.events.push({ type, data });
    return { type, seq: this.events.length - 1, time: Date.now(), data };
  }
}

export class FakeSessionStore {
  private readonly sessions = new Map<string, FakeSession>();
  private counter = 0;
  create(id?: string): FakeSession { ... }   // 省略 id mint `session-<n>`
  get(id: string): FakeSession | undefined { ... }
  list(): FakeSession[] { ... }
}
```

事实核对：**`FakeSessionStore` 不支持 `fork`**（只有 `create`/`get`/`list`）；`FakeSession` 只有 `events` + `append`，无 `header`/`id`/`events` 之外的 dsh-session `Session` 面。

测试范式（`workflow-engine.spec.ts` harness 与 `branch-evaluator.spec.ts` harness 一致）：

```ts
const ctx = new Context();
ctx.provide('sessions', sessions as unknown as SessionStore);
ctx.provide('llm', llm as unknown as LlmRuntime);
ctx.provide('shell', shell as unknown as ShellExecutor);
ctx.provide('subprocess', subprocess);
// 引擎测试额外: ctx.provide('storageDomain', storageDomain as unknown as DomainFacility);
//               ctx.provide('sessionPersistence', {}); ctx.provide('subagents', {}); ctx.provide('fs', {});
//               await ctx.plugin(SandorePersistence); await ctx.plugin(SandoreEngineRuntime, config);
```

`FakeLlm`（`tests/mocks/llm.ts`）：`listProviders()/listModels()/stream()`，`stream` 记录 `calls` 并委托可注入的 `streamHandler`；`textChunks(text, reason)` 产出固定 chunk 流（`block-start`/`text-delta`/`block-end`/`finish`）。单元测试用 `vitest` 的 `describe/it/expect`。

---

### 附：与 finalize-manager 直接相关的既有事实（仅陈述现状，不含方案）

- `SandoreErrorCode`（`microflow/src/errors.ts`）已含 `'FINALIZE_FAILED' | 'GATE_FAILED' | 'SESSION_LOST'`（fatal 语义）；workflow `errors.ts` re-export。
- `SandoreEngineRuntime.inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`，`ctx.sessions` 即 `SessionStore`。
- `workflow-engine.ts` 尚无任何 `fork` 调用；`finalize`/`Assessor`/`GateEvaluator` 尚未在 `packages` 下实现（grep 仅在 schema.ts/types.ts/yaml-parser.spec.ts/subagents.spec.ts/stage-executor.ts 命中 finalize 字样）。
- `StageExecutor` 目前仅线性执行 Step，无 finalize 编排；`ExecutedStepDefault.finalizeMeta`/`sessionMeta` 已在 schema/types 中预留。
