## Exploration Result

本次探索基于 `exploration.reference=[]`（无外部参考配置），直接核实项目内真实源码与 node_modules 中 DSH 依赖的类型定义。以下按 exploreContent 六项逐一给出精确形状与文件位置（均为绝对路径下的权威来源）。

---

### (1) DSH `ctx.sessions.fork` 真实签名与 Session 结构

权威来源（`.d.ts` 类型定义，TS 编译依据）：

- `D:/project-code/llm/sandore/node_modules/.pnpm/@deepseek-ai+dsh-session@0._959f4648d9537c86268b5de534a89875/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts`
- `D:/project-code/llm/sandore/node_modules/.pnpm/@deepseek-ai+dsh-session@0._959f4648d9537c86268b5de534a89875/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts`

**上下文键**：`@deepseek-ai/dsh-session` 通过 cordis module augmentation 声明 `interface Context { sessions: SessionStore }`，即 `ctx.sessions` 的类型是 `SessionStore`。

**`fork` 精确签名**（`index.d.ts` L413）：

```ts
fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session
```

- `SessionForkSource = Session | SessionId`（`index.d.ts` L269）：fork 源既可以是**活的 Session 对象**，也可以是**其在 store 中的 SessionId**。
- `boundary?: number`：**闭区间（inclusive）** 的源事件 seq，fork 到该 seq 为止；省略时表示源当前**最后一条事件**；省略且源为空时 fork 出空 child。选中的前缀**允许以 turn 之间事件结尾，但不允许在一个未闭合的 turn 内部结尾**。
- `childSessionId?: SessionId`：可选子会话 id；省略时委托 `SessionStore` 的 id 策略（mint `session-<n>`）。
- 返回：**已进入 store 并已 announce 的活 child Session**（`Session` 类型）。
- 拒绝错误码（`SessionForkErrorCode`，`index.d.ts` L278）：`SESSION_NOT_FOUND`（源 id 不在活 store）、`SESSION_NOT_LIVE`（源对象不是 store 的活实例）、`SESSION_ALREADY_EXISTS`（child id 已占用）、`INVALID_BOUNDARY`（boundary 不是连续存在的 seq）、`OPEN_TURN`（前缀结束于未闭合 turn）。抛 `SessionForkError`（`code` 字段携带以上枚举）。

**`Session` 结构**（`index.d.ts` L106 起，普通 class 非 Service）：

- `id: SessionId`（`Branded<'SessionId'>`，`SessionId(id: string)` 为编译期 brand）
- `header: SessionHeader`（不可变存储元数据，见下）
- `surface: SessionSurface`（有序 surface）
- `firstLiveSeq: number`（本进程第一条追加的 seq，即构造 seed 长度）
- `events: readonly SessionEvent[]`（append-only 不可变快照）
- `seq: number`（下一条事件 seq = log 长度）
- `append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []): SessionEvent<T>`（返回含 `seq`/`time` 的已入日志事件快照；surface 事件必须带 `SurfaceIntent`）
- `deriveMessages(): Message[]`、`deriveEventMessage(event): SessionEvent | null`
- `requestHeader(): EpochHeader | undefined`、`requestContext(): RequestContext | undefined`
- 静态：`Session.create(id, seed?, header?)`（detached）、`Session.fromRestore(id, seed, header)`（detached）

**`SessionHeader`**（`types.d.ts` L40，`create()` 时由 store 填 `version`/`id`/`createdAt`）：

```ts
{ version: number; id: SessionId; createdAt: number;
  cwd?: string; parentSession?: SessionId; seedLength?: number;
  origin?: 'subagent'; delegationDepth?: number; agentPreset?: string }
```

其中 `parentSession`（fork 血缘）与 `seedLength`（通过 seed 继承的前置事件数，即持久化的 fork lineage 边界）是 fork 的直接产物。

**`CreateSessionOptions`**（`types.d.ts` L84，`store.create(id?, options?)` 的入参）：

```ts
{ seed?: readonly SessionEvent[];
  meta?: { cwd?: string; parentSession?: SessionId; createdAt?: number;
           seedLength?: number; origin?: 'subagent';
           delegationDepth?: number; agentPreset?: string } }
```

**`SessionEvent` 形状**（`types.d.ts` L420，对 `type` 的判别联合）：

```ts
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K; seq: number; time: number;   // time 为 Unix epoch ms
    data: SessionEventMap[K];
    ignorable?: true;                      // 读取方可安全跳过的标记
  } & (K extends SurfaceEventType ? {      // 仅 surface 事件携带
    sourceEventSeqs?: number[];
    surfaceOp?: SurfaceOp;                 // 'append' | { op:'replace', start, end }
  } : object)
}[T]
```

**`SessionEventMap` 各事件 data**（`types.d.ts` L223）：

- `turn/start { turn }`、`turn/end { turn, reason: TurnEndReason }`
- `step/start { turn, step }`、`step/end { turn, step }`
- `user/message: UserMessage`（`@deepseek-ai/dsh-llm` 的 `UserMessage`）
- `assistant/chunk { turn, step, chunk: StreamChunk }`
- `assistant/message { turn, step, message: AssistantMessage, usage?: TokenUsage }`
- `tool/call { turn, step, callId: CallId, name: string, arguments: string }`
- `tool/result { turn, step, message: ToolResultMessage, error?: { name, code }, meta?: JsonValue }`
- `todo/write { todos: TodoItem[] }`
- `request/header { header: EpochHeader, reason: 'initial'|'resume'|'change' }`
- `request/context: RequestContext`
- `session/end-seed: Record<string, never>`（构造函数 seed 边界标记）

**`meta` 形状**：`SessionEventMap['tool/result'].meta?: JsonValue` —— 工具私有展示载荷，对核心不透明但**必须可 JSON 序列化**（`Session.append` 用 `isJsonValue` 运行时校验）。`SessionHeader`/`CreateSessionOptions.meta` 的 `meta` 则是存储元数据字段集合（见上）。

**`SessionStore` 其余相关 API**：`create(id?, options?): Session`、`prepare(id?, options?): Session`（不进入 store）、`enter(session): () => void`、`announce(session): void`、`flush(session): Promise<boolean>`、`get(id): Session | undefined`、`list(): Session[]`。

---

### (2) `workflow/src/schema.ts` 精确形状（foundation-01 已建）

来源：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

**`GatesSchema`**（L113-119，`export const`）：

```ts
z.object({
  maxRetries: z.number().optional(),
  maxTokens: z.number().optional(),
  primary: z.object({ enabled: z.boolean() }).optional(),
  secondary: z.object({ enabled: z.boolean(), prompt: z.string().optional() }).optional(),
  need_confirm: z.boolean().optional(),
})
```

派生类型 `export type Gates = z.infer<typeof GatesSchema>`（L386）。注意：`Gates` 仅从 `schema.ts` 导出；`types.ts` 的 re-export 列表**不含** `Gates`（见 (3)）。`GatesSchema` 被 `WorkflowStepSchema`/`WorkflowStageSchema`/`WorkflowDefinitionSchema` 作为 `.optional()` 字段引用（三级门控合并）。

**`AskUserQuestionPayloadSchema`**（L192-203，`export const`）：

```ts
z.object({
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
```

**`FinalizeAssessResultSchema`**（L206-213，`export const`，Assessor 结果）：

```ts
z.object({
  completionType: z.enum(['completed', 'ask']),
  passThroughVars: z.record(z.string(), z.string()),
  askQuestion: AskUserQuestionPayloadSchema.optional(),
  errorDetail: z.string().optional(),
  forkSessionId: z.string(),
  assessmentRaw: z.string(),
})
```

**`GateEvalResultSchema`**（L216-227，`export const`，GateEvaluator 结果）：

```ts
z.object({
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
```

**`FinalizeMetaSchema`**（L230-240，`export const`，挂载在 `ExecutedStepDefaultSchema.finalizeMeta` L282）：

```ts
z.object({
  status: z.enum(['evaluating', 'completed', 'ask']),
  sessionId: z.string().optional(),
  gateSessionId: z.string().optional(),
  directory: z.string().optional(),
  errorDetail: z.string().optional(),
  // Task 3 新增：完成判定与两会话结果
  completionType: z.enum(['completed', 'ask']).optional(),
  assessResult: FinalizeAssessResultSchema.optional(),
  gateResult: GateEvalResultSchema.optional(),
})
```

派生类型（L392-395，均 `export type ... = z.infer<...>`）：`FinalizeMeta`、`FinalizeAssessResult`、`GateEvalResult`、`AskUserQuestionPayload`。

**其余相关派生类型**：`PassThroughVar = z.infer<typeof PassThroughVarSchema>`（L383），`PassThroughVarSchema`（L82-87）为 `{ name: string; value: string; description: string; refresh?: boolean }`。

**包入口**：`workflow/src/index.ts` 有 `export * from './schema.ts'` 与 `export type * from './types.ts'`，因此上述所有 schema 与其派生类型均为包公开导出面。

---

### (3) `types.ts` 精确形状

来源：`D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts`

**从 schema.ts re-export 的类型**（L25-38）：`AskUserQuestionPayload`、`BranchMeta`、`CommandConfig`、`FinalizeAssessResult`、`FinalizeMeta`、`GateEvalResult`、`InputFromItem`、`OutputToItem`、`PassThroughVar`、`RetryRecord`、`SessionMessage`、`StepSessionMeta`。

- 即 `FinalizeAssessResult`/`GateEvalResult`/`FinalizeMeta`/`AskUserQuestionPayload`/`PassThroughVar` 的精确形状等于 (2) 中对应 `z.infer` 结果。
- `PassThroughVar = { name: string; value: string; description: string; refresh?: boolean }`。
- 注意：`types.ts` **未** re-export `Gates`（`Gates` 只在 `schema.ts` 导出）。

**`FinalizeOutcome`**（L155-158，`types.ts` 原生定义，非 schema 派生）：

```ts
export type FinalizeOutcome =
  | { type: 'done'; completionType: 'completed'; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
  | { type: 'ask'; assessResult: FinalizeAssessResult }
  | { type: 'error'; errorDetail: string; assessResult?: FinalizeAssessResult; gateResult?: GateEvalResult }
```

**`StageContract`**（L126-144，`types.ts` 原生 interface；与 `schema.ts` 的 `StageContractSchema` L306-320 形状一致）：

```ts
export interface StageContract {
  stageId: string
  stageName: string
  status: StepStatus          // 'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'
  artifacts: Array<{
    stepId: string
    outputToId: string
    files: string[]
    returnPrompt?: string
  }>
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>
  contractArtifacts: Record<string, string[]>
  completedAt: string
  errorDetail?: string
}
```

---

### (4) `branch-evaluator.ts` 临时会话聚合链与 shell 分支评估范式

来源：`D:/project-code/llm/sandore/packages/sandore/microflow/src/branch-evaluator.ts`

**AI 分支（agent/prompt/skill/mcp）临时会话聚合链**（`startAi` L258-282、`aggregate` L295-307）：

1. `resolveProviderModel(condition.value, config, ctx.llm)`（来自 `internal.ts` L118）做 provider/model 三层回退：L1 定义内成对 `providerId`+`modelId` → L2 引擎默认 `defaultProvider`+`defaultModel` → L3 `llm.listProviders()[0]` + `llm.listModels(provider.id)[0]`。
2. `replacePassThroughVars(promptText, resolvePassThroughVars(...))` 做 `${xxx}` 替换。
3. `buildBranchPrompt(...)` 拼结构化提示词（头 + 任务 + 上下文 + 分支列表 + 返回格式 + 红线规则）。
4. 构造用户消息：`createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] })`。
5. `GenerateOptions = { provider, model, messages: [message], ...(signal? { signal }) }`。
6. `new BlockAssembler()` → `const stream = this.ctx.llm.stream(generateOptions)`（返回 `AsyncIterable<StreamChunk>`）→ `aggregate(stream, assembler)`：`for await (const chunk of stream) assembler.push(chunk)`；随后读 `assembler.finish`（`{ kind: 'error' | 'aborted' | 'max-tokens' | 'stop' }`，error/aborted 抛 `SandoreError`），否则 `textSummary(assembler.blocks())` 得聚合文本。
7. `sessionHandle` 为 `TempSessionHandle = string`，形如 `eval-<8 hex>`（`newSessionHandle` L386-389）；shell 分支为 `null`。

**`createUserMessage` / `BlockAssembler` 精确签名**（来源 `@deepseek-ai/dsh-llm` 的 `lib/index.js`，`dsh-llm@0.1.0-rc.6` 将类型以 JSDoc 打包于 `lib/index.js`，无独立 `.d.ts`）：

- `createUserMessage(input: { source: { kind: 'user' }, content: ContentBlock[] })` → 冻结的 user-role `Message`（`createMessage({ ...input, role: 'user' })`，自动附 `id = MessageId(crypto.randomUUID())`）。兄弟构造器：`createAssistantMessage({ content, source: { provider, model, ... } })`、`createToolResultMessage({ callId, content, isError })`。
- `BlockAssembler`：`push(chunk)` 处理 `block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`；`blocks(): ContentBlock[]`（按 order 组装，`max-tokens` 时过滤 tool-call 块）；`get finish()`（缺省 `{ kind: 'stop' }`）；`get usage()`；`message(source = { kind: 'plugin', plugin: 'dsh-llm/assembler' })`。
- `StreamChunk` 变体（从 `push` 的 switch 与 mock `textChunks` 反推）：`{ type: 'block-start', index, blockType }`、`{ type: 'text-delta'|'reasoning-delta', index, text }`、`{ type: 'tool-call-delta', index, id?, name?, argumentsDelta }`、`{ type: 'block-end', index, block }`、`{ type: 'usage', usage }`、`{ type: 'finish', reason }`。

**shell 分支范式**（`startShell` L284-292、`runShellCommand`/`runShellSimple`/`runShellSubprocess` L309-367）：

- 命令先 `replacePassThroughVars` + `buildShellEnv`（非空透传变量注入 env）。
- 无 stdin/env 注入 → `ctx.shell.resolve(ShellExecRequest{command, timeoutMs, workdir?, signal?})` + `ctx.shell.run(spec)`（简单路径）。
- 有 stdin/env → `ctx.subprocess.resolveExecutable(program, env, signal)` + `ctx.subprocess.spawn(SubprocessSpawnSpec{ argv, cwd, stdio: { stdin: 'ignore'|{data}, stdout:{maxBytes}, stderr:{maxBytes} }, graceMs, env?, signal? })`，从 `handle.done`/`handle.collected.stdout/stderr.readFrom(0)` 取结果。
- `toStdout`（L370-383）：`exitCode === 0 && !timedOut && !aborted` 返回 `stdout.text`；否则抛 `SandoreError`（`STEP_TIMEOUT` / `STEP_EXECUTION`）。

**可复用纯函数/工具**（`branch-evaluator.ts` 导出）：`extractExpectation(raw)`、`extractBreakResult(raw)`、`matchesExpectation(result, expectation)`；`internal.ts` 导出 `textSummary`、`resolveProviderModel`、`resolvePassThroughVars`、`buildShellEnv`、`splitCommand`、`describeError`（`internal.ts` 不进入公开 API，仅供 microflow 包内复用）。

---

### (5) `file-utils.ts` 导出（门禁产物验证与透传变量替换复用）

来源：`D:/project-code/llm/sandore/packages/sandore/microflow/src/file-utils.ts`（`microflow/src/index.ts` 已 `export * from './file-utils.ts'`，故均为公开导出）

- `replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string`（L62-67）：替换 `${name}`；未定义键保留原文。
- `findFilesByGlob(fs: FileSystem, rootDir: string, pattern: string): Promise<string[]>`（L135-141）：`globToRegex(pattern)` → `fs.resolve(rootDir)` → 递归 `collectFiles`（跳过 `.` 与 `node_modules`）→ 过滤相对路径匹配 → 返回进程绝对路径数组。
- `findFilesByRegex(fs: FileSystem, rootDir: string, regex: string): Promise<string[]>`（L144-155）：非法正则抛 `Error("invalid regex '...': ...")`。
- `readOutputJson(fs: FileSystem, dir: string, stepMessageId: string): Promise<StepOutputFile>`（L236-240）：读 `{dir}/{stepMessageId}_output.json` 并逐字段校验解析。
- `writeOutputJson(fs, dir, stepMessageId, data): Promise<string>`（L180-189）：写 `{dir}/{stepMessageId}_output.json`，返回绝对路径。
- `outputJsonFileName(stepMessageId: string): string`（L175-177）：`${stepMessageId}_output.json`。
- 类型：`StepOutputFile = { sessionId: string; output: { returnPrompt: string; artifacts: OutputArtifact[] } }`（L166-172）；`OutputArtifact = { id: string; value: string[] }`（L160-163）。
- 其他导出：`walkDir`、`globToRegex`、`escapeRegexChar`、`isGlobPattern`、`resolvePathSegments`、`resolveFromInputFrom`、`idMatches`、`FsTarget`/`FsDirEntry`/`FsWriteOutcome`/`FileSystem`（`ctx.fs` 结构类型接缝，声明 `Context.fs` 上下文键）。

---

### (6) sessions mock 与测试范式

来源：`D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/sessions.ts`

**`FakeSession`**（L10-17）：

```ts
export class FakeSession {
  readonly events: Array<{ type: string; data: unknown }> = [];
  append(type: string, data: unknown): { type: string; seq: number; time: number; data: unknown } {
    this.events.push({ type, data });
    return { type, seq: this.events.length - 1, time: Date.now(), data };
  }
}
```

**`FakeSessionStore`**（L20-38）：

```ts
export class FakeSessionStore {
  private readonly sessions = new Map<string, FakeSession>();
  private counter = 0;
  create(id?: string): FakeSession;   // 缺省 mint `session-<n>`
  get(id: string): FakeSession | undefined;
  list(): FakeSession[];
}
```

**结论：`FakeSessionStore` 不支持 `fork`**（无 `fork` 方法，也无 `prepare`/`enter`/`announce`/`flush`）；`FakeSession` 仅记录 `append(type, data)`，无 `deriveMessages`/`surface`/`header`/`seq`。若 finalize-manager 依赖 `ctx.sessions.fork(source, boundary?, childSessionId?)`，该 mock 需扩展 `fork`（及子会话/源会话事件）能力，或测试中另建支持 fork 的 store mock。

**测试范式**（来自 `workflow/src/workflow-engine.spec.ts` L142-170 与 `microflow/src/branch-evaluator.spec.ts` L20-35）：

- 用 `import { Context } from '@deepseek-ai/cordis'` 建 `const ctx = new Context()`。
- `ctx.provide('llm', llm as unknown as LlmRuntime)`、`ctx.provide('sessions', sessions as unknown as SessionStore)`、`ctx.provide('shell'|'subprocess'|'fs'|'subagents'|...)` 注入内存 mock（类型用 `as unknown as` 窄化）。
- `FakeLlm`（`workflow/tests/mocks/llm.ts`）：`providers: LlmProviderInfo[]`、`models: Map<string, LlmModelInfo[]>`、`calls: GenerateOptions[]`、`streamHandler: (options) => AsyncIterable<StreamChunk>`；`stream(options)` 记录 calls 并委托 handler。辅助函数 `textChunks(text, reason = { kind: 'stop' })` 生成完整单 text 块 chunk 流（block-start/text-delta/block-end/finish）。
- 测试用 vitest `describe`/`it`/`expect`；每个 describe 内以 `harness()` 函数组装 ctx 与各 mock 并返回被测对象。
- 另有 `workflow/tests/mocks/agents.ts` 的 `FakeSession`（实现 `microflow/src/subagents.ts` 的 `Session` 结构，仅 `events: SessionEvent[]` + `append(event: SessionEvent): void`）与 `FakeAgent`/`FakeAgentRegistry`，供 subagent 相关测试用（与 `ctx.sessions` 的 `sessions.ts` mock 是两套独立 mock）。

---

## Supplementary Exploration Result

`experimental.websearch=true`、`experimental.context7=true`。本次 Phase 3 已直接从权威源码与 DSH 依赖类型定义核实到全部六项精确形状（信息充分，非空），无需 websearch / context7 补充检索，故未触发补充探索。
