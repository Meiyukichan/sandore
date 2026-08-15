## Exploration Result

Phase 1 获取的 `codebases list` 仅一个元素：`{"path":"docs/codebase","description":"codebase dir of current project, ..."}`。经核实 `D:/project-code/llm/sandore/docs/codebase` 为空目录；真实源码位于 monorepo 的 `packages/sandore/{microflow,workflow,tool,ui}` 下（`furina config show project.sourcecode` 返回 `src/`，但仓库根目录并无 `src/`，实际源码在 `packages/`）。故 Phase 3（furina-codebase 探索 docs/codebase）无结果，以下全部为 Phase 4 手工补充探索结果。

> 依赖版本锚点：`@deepseek-ai/dsh-llm` 实际安装版本 `0.1.0-rc.6`（microflow 与 workflow 的 peer/devDependency 一致）。

---

## Supplementary Exploration Result

### 1. DSH 源码 `ctx.llm.stream` 的 GenerateOptions 形状与 chunk 聚合

源码位置：`node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-.../node_modules/@deepseek-ai/dsh-llm/lib/types/`（`.d.ts`）。

**`ctx.llm` 类型**（`lib/types/index.d.ts`）：经 `declare module '@deepseek-ai/cordis' { interface Context { llm: LlmRuntime } }` 增强，`LlmRuntime` 为 `@deepseek-ai/dsh-llm` 默认导出。核心方法：

```ts
stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
listProviders(): LlmProviderInfo[];                 // 同步
listModels(provider: string): Promise<LlmModelInfo[]>; // 异步
```

**`GenerateOptions` 精确形状**（`lib/types/types.d.ts`，第 312–348 行）：

```ts
export interface GenerateOptions {
  provider: string;                       // 必填：注册的 provider 路由
  model: string;                          // 必填
  reasoningEffort?: ReasoningEffortId;
  messages: Message[];                    // 必填：有序会话消息
  system?: string;
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  sessionId?: Branded<'SessionId'>;
  purpose?: 'compaction' | 'session-title';
}
```

**`StreamChunk` 联合**（同文件 267–297 行）：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish` 七变体。`finish` 携带 `reason: FinishReason`；`FinishReason` 的 `kind` 为 `'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'`（`aborted`/`error` 各带 `failure: LlmFailure`）。

**`BlockAssembler`**（`lib/types/assembler.d.ts`，从包根导出）：
- `push(chunk: StreamChunk): void`
- `blocks(): ContentBlock[]`（按序聚合；max-token 截断丢弃无法安全执行的 tool call）
- `get usage(): TokenUsage | undefined`
- `get finish(): FinishReason`（流无 finish 时返回 `{kind:'stop'}`）
- `get replayState(): unknown`
- `message(source?: MessageSource): Message`

**消息构造助手**（`lib/types/message.d.ts`，均从包根导出）：
- `createUserMessage<T>(input): T & Pick<UserMessage,'id'|'role'>`（冻结 + 新 id）
- `createMessage` / `createAssistantMessage` / `createToolResultMessage` / `freezeMessage` / `isTokenDelta`
- `Message` 接口：`{ id; role: 'system'|'user'|'assistant'; content: ContentBlock[]; source: MessageSource }`
- `ContentBlock` 联合：`text` / `reasoning` / `image` / `tool-call` / `tool-result`（`{ type:'text'; text:string }` 为最小可用形状）

**step-runner.ts 中的现有复用范式（branch-evaluator 临时会话复用依据）**：
- `runPrompt`（第 444–471 行）与 `fillParams`（第 504–533 行）完全采用同一条「临时会话」路径：
  1. `createUserMessage({ source:{kind:'user'}, content:[{type:'text', text: promptText}] })`
  2. `const options: GenerateOptions = { provider, model, messages:[message], ...(signal?{signal}) }`
  3. `const assembler = new BlockAssembler(); for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);`
  4. 读 `assembler.blocks()` + `assembler.finish`；`finish.kind==='error'|'aborted'` 分支处理（prompt 抛 `STEP_EXECUTION`，fillParams 回退模板原文并 `ctx.logger.warn`）。
- `BlockAssembler`、`createUserMessage` 是直接从 `@deepseek-ai/dsh-llm` import 的真实依赖（非本地接缝），branch-evaluator 可直接同样 import。

---

### 2. `file-utils.ts` 导出形状（shell 分支三注入的透传替换与产物上下文复用）

源码：`packages/sandore/microflow/src/file-utils.ts`。

- `replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string` —— 正则 `/\$\{([^}]+)\}/g`，已定义替换为值，未定义保留原文（`$&`/`$1` 不会被解释）。shell 分支三注入第 1 步直接复用。
- `globToRegex(glob: string): RegExp` —— 锚定（`^…$`）：`*`→`[^/]*`、`**`→`.*`（跳过后续 `/`）、`?`→`[^/]`，其余 `escapeRegexChar`。
- `escapeRegexChar(char: string): string` —— 转义 `[.*+?^${}()|[\]\\]`。
- `isGlobPattern(pattern: string): boolean` —— 含 `*`/`?` 且无 `\.`/`(?` 时判为 glob。
- `findFilesByGlob(fs: FileSystem, rootDir: string, pattern: string): Promise<string[]>` —— 递归遍历（跳过 `.` 与 `node_modules`），按相对路径匹配，返回**进程绝对路径数组**。
- `findFilesByRegex(fs, rootDir, regex): Promise<string[]>`；`walkDir(fs, dir: FsTarget): Promise<string[]>`。
- `writeOutputJson(fs, dir, stepMessageId, data: StepOutputFile): Promise<string>` / `readOutputJson(...)` / `outputJsonFileName(stepMessageId)`（`{uuid}_output.json`）。
- `idMatches(actualId, targetId)`（精确或 `targetId-` 后缀）、`resolvePathSegments`、`resolveFromInputFrom`。
- 结构类型：`FsTarget{targetKey,displayPath}`、`FsDirEntry{name,type,target}`、`FsWriteOutcome{operation,version,before,after}`、`FileSystem{resolve,processPath,listDir,readText,writeText}`、`OutputArtifact{id,value:string[]}`、`StepOutputFile{sessionId,output:{returnPrompt,artifacts}}`；经 `declare module '@deepseek-ai/cordis' { interface Context { fs: FileSystem } }` 声明 `ctx.fs`。

---

### 3. `shell.ts` 的 ShellExecutor / SubprocessRuntime 接缝形状

源码：`packages/sandore/workflow/src/shell.ts`（workflow 包以 `export type * from './shell.ts'` 仅类型导出）。

**`ShellExecutor`**：
```ts
export interface ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec;
  run(spec: ShellExecSpec): Promise<ShellRunResult>;
  start(spec: ShellExecSpec): unknown;
}
```
- `ShellExecRequest`：`command`（必填）+ 可选 `workdir` / `timeoutMs` / `stdoutMaxBytes` / `signal` / `stdin` / `env`。
- `ShellExecSpec`：`command` / `workdir` / `timeoutMs` / `stdoutMaxBytes` 必填 + 可选 `signal` / `stdin` / `env`。
- `ShellRunResult`：`{ exitCode: number|null; signal: string|null; timedOut: boolean; aborted: boolean; timeoutMs: number; stdout: CollectedOutput; stderr: CollectedOutput }`；`CollectedOutput = { text: string; truncated: boolean; spillPath?: string }`。

**`SubprocessRuntime`**：
```ts
export interface SubprocessRuntime {
  resolveExecutable(command: string, env?: Readonly<Record<string,string>>, signal?: AbortSignal): Promise<string>;
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}
```
- `SubprocessSpawnSpec`：`{ argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number; signal?: AbortSignal; env?: Record<string,string> }`。
- `SubprocessStdio`：`{ stdin: SubprocessStdinMode; stdout: SubprocessOutputMode; stderr: SubprocessOutputMode }`；`SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }`；`SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect`；`SubprocessCollect = { maxBytes: number; spill?: { maxBytes: number } }`。
- `SubprocessHandle`：`{ pid: number; collected: SubprocessCollectedOutputs; done: Promise<SubprocessOutcome>; terminate(): void; waitForExit(signal?): Promise<boolean> }`。
- `SubprocessOutcome`：`{ exitCode: number|null; signal: string|null; timedOut?: boolean }`。
- `SubprocessOutputReader.readFrom(fromByte: number): SubprocessOutputRead`；`SubprocessOutputRead = { text; nextOffset; lossy; spillPath? }`。
- 经模块增强声明 `ctx.shell` 与 `ctx.subprocess`。

**step-runner 中已存在的「三注入」范式（`runShell`/`runShellSubprocess`，第 364–422 行）**：透传替换 → `resolveShellStdin`（inputFrom 命中前置输出时 `JSON.stringify(matched)`）→ `buildShellEnv`（非空透传变量 + `in-loop-turn`/`all-loop-turn`）；无 stdin 且无 env 走 `ctx.shell.resolve/run`，否则 `splitCommand` 分词 → `ctx.subprocess.resolveExecutable` → `ctx.subprocess.spawn`（`stdio.stdin: { data }` / `stdout.stderr: { maxBytes: 1MB }`）→ `handle.done` → `handle.collected.stdout?.readFrom(0)`。

---

### 4. `subagents.ts` 的 finalAssistantOutput / Agent 结构

源码：`packages/sandore/microflow/src/subagents.ts`。

- `finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined` —— ① 最后一条非空 `assistant/message` 的 `message.content`；② 回退累计 `assistant/chunk` 的 `text-delta` 文本 → `[{type:'text',text}]`；③ 皆无返回 `undefined`。与 stop reason 无关。
- `Agent`：`{ readonly id: SessionId; readonly options: AgentOptions; readonly session: Session; readonly status: AgentStatus; whenIdle(): Promise<void> }`。
- `AgentOptions`：`{ provider?; model?; maxTokens? }`；`AgentStatus = 'idle' | 'running'`。
- `Session`：`{ readonly events: readonly SessionEvent[] }`。
- `SessionEvent` 联合（仅精确建模两类）：
  - `{ type:'assistant/message'; seq; time; data: { turn; step; message: AssistantMessage; usage? } }`
  - `{ type:'assistant/chunk'; seq; time; data: { turn; step; chunk: StreamChunk } }`
- `AgentRegistry`：`get(id): Agent | undefined`、`create(options): Promise<AgentHandle>`、`resume(options): Promise<AgentHandle>`。
- `SubagentRuntime`：`startContinuable(spec): Promise<ContinuableStart>`、`followup(parent, childId, content, options): Promise<MessageId>`、`interrupt(targetSessionId, authority): void`、`start(name, request): Promise<SubagentRun>`。
- `ContinuableStartSpec = { provider; label; request: ContinuableStartRequest; signal }`；`ContinuableStart = { childId; messageId }`。
- `SessionId = string`、`MessageId = string`（结构化兼容 DSH 品牌字符串）。
- 经模块增强声明 `ctx.subagents` 与 `ctx.agents`。

评估会话输出读取路径（step-runner `runSubagent`，第 473–501 行）：`ctx.subagents.startContinuable(...)` → `ctx.agents.get(started.childId)` → `await child.whenIdle()` → `finalAssistantOutput(child.session.events)`。

---

### 5. `schema.ts` 的 DagBranch / DagLoop / BranchMeta / CommandConfig 精确形状

源码：`packages/sandore/workflow/src/schema.ts`（Zod v4 `z.discriminatedUnion`，派生类型经 `z.infer` 导出；`types.ts` 同步 re-export `BranchMeta`/`CommandConfig` 等）。

**`CommandConfigSchema`（五类型 discriminated union，判别字段为顶层 `type`，变体字段整体嵌套于 `value`）**：

| type | value 字段 |
|---|---|
| `agent` | `{ promptText: string; agentParamsTemplate?: string; providerId?: string; modelId?: string }` |
| `prompt` | `{ promptText: string; providerId?: string; modelId?: string }` |
| `shell` | `{ command: string }` |
| `skill` | `{ promptText: string; providerId?: string }` |
| `mcp` | `{ promptText: string }` |

**`DagBranch`**（`DagBranchSchema`）：
```ts
{ expectation?: string; next: string; label?: string }
```

**`DagLoop`**（`DagLoopSchema`）：
```ts
{
  breakCondition?: CommandConfig;   // loop-manager checkLoopBreak 的 breakCondition 类型
  breakExpectation?: string;
  next?: string;
  maxIterations: number;
  exitTo?: string;
}
```

**`BranchMeta`**（`BranchMetaSchema`）：
```ts
{
  result?: string;
  sessionId?: string;
  directory?: string;
  status: 'evaluating' | 'completed';
  expectation?: string;
}
```

**承载点**：
- `WorkflowStepSchema` 与 `WorkflowStageSchema` 均含 `condition: CommandConfigSchema.optional()`、`branches: z.array(DagBranchSchema).optional()`、`loop: DagLoopSchema.optional()`（branch-evaluator 的 condition 类型即 `CommandConfig`）。
- `ExecutedStepDefaultSchema` 含 `branchMeta?: BranchMeta`、`loopMeta?: BranchMeta`、`loopIteration?: number[]`（对应 `types.ts` 的 `ExecutedStepDefault` 接口同名可选字段）。
- `WorkflowTaskStateSchema` 含 `activeLoopStack: string[]`、`activeLoopIterationStack: number[]`、`activeLoopNodeId: string|null`、`visitCounts: Record<string, number>`（loop-manager 活跃循环栈/迭代路径栈/硬上限计数的持久化字段）。
- `WorkflowStepSchema` 另含 `timeout?: number`（分钟，StepRunner 内部 `* 60_000` 转毫秒）、`defaultExpectation?: string`。

---

### 6. step-runner.ts 可复用函数 / StepRunner 构造 + microflow/index.ts 导出 + 测试范式

源码：`packages/sandore/microflow/src/step-runner.ts`、`src/index.ts`。

**可复用函数可见性（关键结论：全部 private，未导出）**：
- `buildPromptText(taskText, originalInput, previousOutputs, paramsText?)`、`buildFillParamsPrompt(...)`、`buildTaskText(...)`、`resolveVars(request)`（含 `in-loop-turn`/`all-loop-turn` 注入）、`renderPreviousOutputs(...)`、`prefixIfAllowed(...)`、`resolveShellStdin(...)`、`buildShellEnv(...)`、`splitCommand(command)`、`resolveProviderModel(value)`（私有方法）——均为模块内私有，**未从 step-runner.ts 导出**；branch-evaluator 复用需重新实现或依赖 `BlockAssembler`/`createUserMessage`（来自 dsh-llm）自行组装临时会话。
- 从 step-runner.ts **导出的仅有**：`class StepRunner`、`interface StepRunnerConfig`、`interface PreviousStepOutput`、`interface StepRunRequest`、`interface StepRunSessionMeta`、`interface StepRunResult`。

**StepRunner 构造与关键签名**：
- `new StepRunner(ctx: Context, config: StepRunnerConfig)`。
- `StepRunnerConfig = { defaultTimeoutMs: number; defaultProvider?; defaultModel?; skills?: readonly string[]; mcps?: readonly string[]; agents?: readonly string[]; hostAgent?: Agent }`。
- `run(request: StepRunRequest): Promise<StepRunResult>`，按 `command.type` 分发 shell/prompt/agent/skill/mcp；`StepRunResult = { output: ContentBlock[]; sessionMeta? }`。
- `resolveProviderModel(value)` 三层回退：L1 Step `providerId`+`modelId` 成对；L2 Config `defaultProvider`+`defaultModel` 成对；L3 `ctx.llm.listProviders()[0]` + `listModels()[0]`。

**microflow/index.ts 导出结构**：
```ts
export * from './errors.ts';      // SandoreError / isFatalSandoreError
export * from './file-utils.ts';  // 见 item 2
export * from './step-runner.ts'; // StepRunner 等
export * from './stage-executor.ts'; // StageExecutor
export * from './subagents.ts';   // 见 item 4
```

**测试范式（branch-evaluator.spec / loop-manager.spec 编写依据）**：
- 框架 vitest（`describe/expect/it`），`vitest.config.ts` include `packages/**/*.spec.ts`、`environment: 'node'`。
- 统一 harness 模式（见 `step-runner.spec.ts` 第 103–124 行）：`new Context()` + `ctx.provide('llm'|'shell'|'subagents'|'agents'|'subprocess', mock)`，再 `new StepRunner(ctx, config)`。
- 测试桩位于 `packages/sandore/workflow/tests/mocks/`：
  - `llm.ts`：`FakeLlm`（记录 `calls: GenerateOptions[]`、可注入 `streamHandler`）+ `textChunks(text, reason)`（产出 block-start + text-delta + block-end + finish）。
  - `shell.ts`：`FakeShell`（`requests`/`specs` 记录 + `resolveHandler`/`runHandler`）+ `successResult(spec, stdout?)`。
  - `subagents.ts`：`FakeSubagents`（记录 `continuableStarts` 等，`startContinuable` 返回 `{childId:'child-N', messageId:'msg-N'}`）。
  - `agents.ts`：`FakeAgent`/`FakeAgentRegistry` + `assistantMessageEvent(content)` / `assistantChunkEvent(text)`（构造 `SessionEvent`，内部用 `createAssistantMessage`）。
  - `subprocess.ts`：`FakeSubprocess`（`resolved`/`specs` 记录，`resolveExecutable` 返回 `/usr/bin/{command}`，`outcomeHandler` 决定 `done`）+ `successOutcome()`。
  - `sessions.ts`：`FakeSessionStore`；`storage-domain.ts`：`MemoryStorageDomain`/`MemoryDomain`/`MemoryKvTable`。
- 断言习惯：`expect(...).toEqual(...)`、`.rejects.toMatchObject({ code })`、`.rejects.toThrow(/.../)`、`textOf(block)` 提取文本。

**依赖方向与包归属**：运行时依赖 workflow → microflow（workflow `import` microflow 的 `StageExecutor`/`StepRunner`），microflow 对 workflow 仅 `import type`（`schema.ts`/`types.ts`/`shell.ts`）。microflow 的真实运行时依赖为 `@deepseek-ai/dsh-llm`（`BlockAssembler`/`createUserMessage`/类型）；`shell`/`subprocess`/`subagents`/`agents`/`fs` 均为本地结构类型接缝（未安装对应 DSH 运行时包）。
