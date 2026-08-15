# 探索结果：branch-evaluator / loop-manager 的精确接缝与复用基线

> 探索类型：specification（精确核实现状，作为分支评估/循环管理改造基线）
> 语言：中文
> 项目路径：D:/project-code/llm/sandore
> 说明：specification materials 配置为空（`furina config show exploration.specification` → `[]`），
> 无外部/目录/skill/url 材料；以下全部结论均来自对实际源码与 DSH 依赖包声明文件的逐一核实。

实际源码根目录为 `packages/sandore`（`D:\project-code\llm\sandore\packages\sandore`）。
DSH 运行/类型来源为 pnpm 安装的 `@deepseek-ai/dsh-llm@0.1.0-rc.6`（仅 `.d.ts`/`.js`，无 `.ts` 源码），
路径前缀：
`node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/`

---

## 一、DSH `ctx.llm.stream` 的 `GenerateOptions` 形状与 chunk 聚合（branch-evaluator 临时会话复用依据）

### 1. `ctx.llm` 与 `stream` 的精确签名

来源：`lib/types/index.d.ts`（`LlmRuntime` 类）与 `lib/types/types.d.ts`（`StreamChunk`）。

```ts
// cordis Context 增强（index.d.ts declare module '@deepseek-ai/cordis'）
interface Context { llm: LlmRuntime }

class LlmRuntime extends Service {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  listProviders(): LlmProviderInfo[];               // 同步
  listModels(provider: string): Promise<LlmModelInfo[]>; // 异步
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>;
  // ...（registerAdapter / listConfigurableProviders / resolveCallConfig 等）
}
```

关键点：`ctx.llm.stream(options)` 返回 `AsyncIterable<StreamChunk>`，逐 chunk 迭代，
不是一次性返回消息。消息需由调用方用 `BlockAssembler` 聚合。

### 2. `GenerateOptions` 精确形状（`lib/types/types.d.ts`）

```ts
export interface GenerateOptions {
  provider: string;                       // 必填：注册的 provider 路由，选 adapter
  model: string;                          // 必填
  reasoningEffort?: ReasoningEffortId;    // Branded 字符串
  messages: Message[];                    // 必填：有序对话消息（system 槽之后，provider 所见顺序）
  system?: string;                        // 系统提示词文本
  tools?: ToolSchema[];                   // { name; description; parameters: Record<string, unknown> }
  temperature?: number;
  maxTokens?: number;
  stop?: string[];                        // 停用序列
  signal?: AbortSignal;                   // 取消通道
  sessionId?: Branded<'SessionId'>;       // 会话身份（loop 打标；replay 用）
  purpose?: 'compaction' | 'session-title'; // 辅助调用分类；普通会话请求不设
}
```

### 3. `StreamChunk` 精确形状（7 变体 discriminated union）

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown };
```

`FinishReason`（`kind` 判别，merge-extensible）：
`{kind:'stop'}` | `{kind:'tool-calls'}` | `{kind:'max-tokens'}` | `{kind:'aborted'; failure:LlmFailure}` | `{kind:'error'; failure:LlmFailure}`。
`ContentBlock` = `TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock`。

### 4. `BlockAssembler`（`lib/types/assembler.d.ts`，从 `@deepseek-ai/dsh-llm` 主入口导出）

```ts
export declare class BlockAssembler {
  push(chunk: StreamChunk): void;      // 按流顺序喂入 chunk
  blocks(): ContentBlock[];            // 按 stream order 聚合的块（截断丢弃不可安全执行的 tool call）
  get usage(): TokenUsage | undefined;
  get finish(): FinishReason;          // 流结束无 finish chunk 时返回 { kind: 'stop' }
  get replayState(): unknown;
  message(source?: MessageSource): Message; // 组装冻结 assistant 消息
}
```

### 5. `createUserMessage`（`lib/types/message.d.ts`，从 `@deepseek-ai/dsh-llm` 主入口导出）

```ts
export declare function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never }
): T & Pick<UserMessage, 'id' | 'role'>;
// 调用示例：createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
```

`Message` 基础形状（`role: 'system'|'user'|'assistant'`；`id` 品牌字符串；`content: ContentBlock[]`；`source: MessageSource`）。
`MessageSourceMap`：`user:{kind:'user'}` | `plugin:{kind:'plugin';plugin:string}` | `model:ModelMessageSource`（含 provider/model/replayState） | `tool:ToolMessageSource`。

### 6. step-runner.ts 中的既有用法（临时会话复用模板）

文件：`packages/sandore/microflow/src/step-runner.ts`，两处临时会话：

- `runPrompt`（第 444–471 行）：
  1. `createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] })`；
  2. `const options: GenerateOptions = { provider: route.provider, model: route.model, messages: [message], ...(signal 存在则附 signal) }`；
  3. `const assembler = new BlockAssembler(); for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);`；
  4. `const output = assembler.blocks(); const finish = assembler.finish;`；
  5. `finish.kind === 'error'` → 抛 `STEP_EXECUTION`；`'aborted'` → 抛 `STEP_EXECUTION`；否则 `return { output }`。
- `fillParams`（第 504–533 行，临时会话 + 失败回退）：同样的 createUserMessage + stream + BlockAssembler，
  但 error/aborted/抛错均 `ctx.logger.warn` 后回退模板原文；成功用 `textSummary(assembler.blocks())` 取文本，空串回退模板。

> 复用结论：branch-evaluator 的临时会话可直接复刻「`createUserMessage` → `GenerateOptions`（仅 provider/model/messages/signal）→
> `new BlockAssembler()` 循环 `push` → `assembler.blocks()` + `assembler.finish`」这条链，无需自写聚合。
> `BlockAssembler`、`createUserMessage`、`GenerateOptions`、`ContentBlock`、`FinishReason` 均从 `@deepseek-ai/dsh-llm` 主入口 import。

---

## 二、file-utils.ts 导出形状（透传替换与产物上下文复用）

文件：`packages/sandore/microflow/src/file-utils.ts`（模块 `@deepseek-ai/dsh-sandore-microflow/src/file-utils`）

### 精确签名

```ts
// 透传变量替换（含 ${in-loop-turn}/${all-loop-turn}）
export function replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string
// 未定义变量保留原文 ${xxx}，已定义替换为值

// glob → 锚定正则（*→[^/]*，**→.*，?→[^/]；其余转义）
export function globToRegex(glob: string): RegExp
export function escapeRegexChar(char: string): string
export function isGlobPattern(pattern: string): boolean

// 递归文件搜索（入参显式传 fs，不硬绑 ctx）
export async function walkDir(fs: FileSystem, dir: FsTarget): Promise<string[]>
export async function findFilesByGlob(fs: FileSystem, rootDir: string, pattern: string): Promise<string[]>
export async function findFilesByRegex(fs: FileSystem, rootDir: string, regex: string): Promise<string[]>

// {uuid}_output.json 读写
export function outputJsonFileName(stepMessageId: string): string  // `${stepMessageId}_output.json`
export async function writeOutputJson(fs, dir, stepMessageId, data: StepOutputFile): Promise<string>
export async function readOutputJson(fs, dir, stepMessageId): Promise<StepOutputFile>

// InputFrom 就近匹配
export function idMatches(actualId: string, targetId: string): boolean  // === 或 `${targetId}-` 前缀
export function resolvePathSegments(executedSteps, currentIndex, path): ExecutedStepDefault[]
export function resolveFromInputFrom(executedSteps, currentIndex, inputFromItems): ExecutedStepDefault[]
```

### 相关结构类型

```ts
export interface FileSystem {   // 两段式 target 协议：先 resolve 得 FsTarget，再以 target 读写
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  writeText(target: FsTarget, content: string): Promise<FsWriteOutcome>;
}
export interface FsTarget { readonly targetKey: string; readonly displayPath: string }
export interface FsDirEntry { readonly name: string; readonly type: 'file'|'directory'|'other'; readonly target: FsTarget }
export interface FsWriteOutcome { readonly operation: 'create'|'update'; readonly version: string; readonly before: string|null; readonly after: string }
export interface OutputArtifact { readonly id: string; readonly value: string[] }
export interface StepOutputFile { readonly sessionId: string; readonly output: { readonly returnPrompt: string; readonly artifacts: OutputArtifact[] } }
```

并 `declare module '@deepseek-ai/cordis' { interface Context { fs: FileSystem } }`（`ctx.fs` 上下文键）。

> 复用结论：`findFilesByGlob`/`globToRegex`/`replacePassThroughVars` 均为已导出纯函数（file-utils.ts 全量从
> `microflow/src/index.ts` re-export）。`findFilesByGlob` 内部用 `globToRegex(pattern)` 后递归 `collectFiles`
> （跳过 `.` 与 `node_modules`）过滤 `relativePath`，返回 `fs.processPath` 的进程绝对路径数组。
> 注意：其返回值是「进程绝对路径」而非 `FsTarget`；如需产物上下文按 glob 收集，直接复用该函数即可。

---

## 三、shell.ts 的 ShellExecutor / SubprocessRuntime 接缝形状

文件：`packages/sandore/workflow/src/shell.ts`（模块 `@deepseek-ai/dsh-sandore-workflow/src/shell`）

### ShellExecutor 侧

```ts
export interface ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec;
  run(spec: ShellExecSpec): Promise<ShellRunResult>;
  start(spec: ShellExecSpec): unknown;
}
export interface ShellExecRequest {
  command: string; workdir?: string; timeoutMs?: number; stdoutMaxBytes?: number;
  signal?: AbortSignal; stdin?: string; env?: Record<string, string>;
}
export interface ShellExecSpec {
  command: string; workdir: string; timeoutMs: number; stdoutMaxBytes: number;
  signal?: AbortSignal; stdin?: string; env?: Record<string, string>;
}
export interface ShellRunResult {
  exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean;
  timeoutMs: number; stdout: CollectedOutput; stderr: CollectedOutput;
}
export interface CollectedOutput { text: string; truncated: boolean; spillPath?: string }
```

### SubprocessRuntime 侧（stdin/env 注入依据）

```ts
export interface SubprocessRuntime {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}
export interface SubprocessSpawnSpec {
  argv: readonly string[];    // argv[0] 为程序，从不 shell 解释
  cwd: string;
  stdio: SubprocessStdio;
  graceMs: number;            // SIGTERM→SIGKILL 升级宽限（毫秒）
  signal?: AbortSignal;
  env?: Record<string, string>;
}
export interface SubprocessStdio {
  stdin: SubprocessStdinMode;   // 'ignore' | 'pipe' | { readonly data: string }
  stdout: SubprocessOutputMode; // 'pipe' | 'inherit' | SubprocessCollect({ maxBytes; spill? })
  stderr: SubprocessOutputMode;
}
export interface SubprocessOutcome { exitCode: number | null; signal: string | null; timedOut?: boolean }
export interface SubprocessOutputRead { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
export interface SubprocessOutputReader { readFrom(fromByte: number): SubprocessOutputRead }
export interface SubprocessCollectedOutputs { readonly stdout?: SubprocessOutputReader; readonly stderr?: SubprocessOutputReader }
export interface SubprocessHandle {
  readonly pid: number; readonly collected: SubprocessCollectedOutputs;
  readonly done: Promise<SubprocessOutcome>;
  terminate(): void; waitForExit(signal?: AbortSignal): Promise<boolean>;
}
```

并 `declare module '@deepseek-ai/cordis' { interface Context { shell: ShellExecutor; subprocess: SubprocessRuntime } }`。

> 复用结论：shell 分支三（shell 分支评估）如需走 `ctx.shell`，按 `resolve(request) → run(spec)` 两段调用；
> 需要 stdin/env 注入时改走 `ctx.subprocess.resolveExecutable(program, env, signal)` + `ctx.subprocess.spawn(spec)`，
> stdin 用 `stdio.stdin = { data: string }` 写 JSON、env 合并透传变量。step-runner.ts 的 `runShell`/`runShellSimple`/
> `runShellSubprocess`（第 364–422 行）已给出两种接缝的完整调用范式。

---

## 四、subagents.ts 的 finalAssistantOutput / Agent 结构

文件：`packages/sandore/microflow/src/subagents.ts`（模块 `@deepseek-ai/dsh-sandore-microflow/src/subagents`）

### `finalAssistantOutput`（精确签名，接缝内自带实现）

```ts
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined
```

选取规则（与 DSH 源码一致，与 stop reason 无关）：
1. 取最后一条非空 `assistant/message` 的 `message.content`（后写覆盖）；
2. 无候选时累积 `assistant/chunk` 中 `text-delta` 文本，非空返回 `[{ type: 'text', text }]`；
3. 两者皆无返回 `undefined`。

### `Agent` 结构

```ts
export interface Agent {
  readonly id: SessionId;                 // = string
  readonly options: AgentOptions;         // { provider?: string; model?: string; maxTokens?: number }
  readonly session: Session;              // { readonly events: readonly SessionEvent[] }
  readonly status: AgentStatus;           // 'idle' | 'running'
  whenIdle(): Promise<void>;
}
export interface AgentRegistry { get(id): Agent|undefined; create(opts): Promise<AgentHandle>; resume(opts): Promise<AgentHandle> }
```

### `SessionEvent` 建模（仅两类，包络字段 seq/time）

```ts
export type SessionEvent =
  | { readonly type: 'assistant/message'; readonly seq: number; readonly time: number; readonly data: AssistantMessageData }
  | { readonly type: 'assistant/chunk'; readonly seq: number; readonly time: number; readonly data: AssistantChunkData };
export interface AssistantMessageData { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
export interface AssistantChunkData { turn: number; step: number; chunk: StreamChunk }
```

### `SubagentRuntime`（ctx.subagents）

```ts
export interface SubagentRuntime {
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>; // { provider; label; request; signal }
  followup(parent, childId, content, options): Promise<MessageId>;
  interrupt(targetSessionId, authority): void;
  start(name, request: SubagentStartRequest): Promise<SubagentRun>;
}
// ContinuableStartRequest = { prompt: ContentBlock[]; parent: Agent; agentOptions?; maxDepth?; toolFilter?; persona? }
// ContinuableStart = { childId: SessionId; messageId: MessageId }
```

并 `declare module '@deepseek-ai/cordis' { interface Context { subagents: SubagentRuntime; agents: AgentRegistry } }`。

> 复用结论：评估会话若走可续接子代理，读取输出用 `finalAssistantOutput(child.session.events)`，
> 返回 `ContentBlock[] | undefined`（undefined 即「无 assistant 输出」，需上层处理）。
> 也可复刻 step-runner 的 prompt 临时会话（见第一节），避免引入子代理注册。

---

## 五、schema.ts 的 DagBranch / DagLoop / BranchMeta / CommandConfig 精确形状

文件：`packages/sandore/workflow/src/schema.ts`（模块 `@deepseek-ai/dsh-sandore-workflow/src/schema`）

### CommandConfig（五变体 discriminated union，判别字段顶层 `type`，变体字段嵌套于 `value`）

```ts
export const CommandConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent'),  value: z.object({ promptText: z.string(), agentParamsTemplate: z.string().optional(), providerId: z.string().optional(), modelId: z.string().optional() }) }),
  z.object({ type: z.literal('prompt'), value: z.object({ promptText: z.string(), providerId: z.string().optional(), modelId: z.string().optional() }) }),
  z.object({ type: z.literal('shell'),  value: z.object({ command: z.string() }) }),
  z.object({ type: z.literal('skill'),  value: z.object({ promptText: z.string(), providerId: z.string().optional() }) }),
  z.object({ type: z.literal('mcp'),    value: z.object({ promptText: z.string() }) }),
])
export type CommandConfig = z.infer<typeof CommandConfigSchema>
```

注意：`skill` 变体**只有** `providerId`（无 `modelId`），`mcp` 变体两者皆无。schema 层 shell 命令只有字符串 `command`（无 argv）。

### DagBranch

```ts
export const DagBranchSchema = z.object({
  expectation: z.string().optional(),   // 省略表示并行分支
  next: z.string(),
  label: z.string().optional(),
})
export type DagBranch = z.infer<typeof DagBranchSchema>
```

### DagLoop（checkLoopBreak 的 breakCondition 类型 = CommandConfig）

```ts
export const DagLoopSchema = z.object({
  breakCondition: CommandConfigSchema.optional(),  // 循环退出判定命令（类型即 CommandConfig）
  breakExpectation: z.string().optional(),
  next: z.string().optional(),
  maxIterations: z.number(),                        // 必填
  exitTo: z.string().optional(),
})
export type DagLoop = z.infer<typeof DagLoopSchema>
```

> 关键：**不存在独立的 `BreakCondition` 类型**；`DagLoop.breakCondition` 就是 `CommandConfig | undefined`（五变体联合）。
> `WorkflowStep.condition`（第 144 行）与 `WorkflowStage.condition`（第 160 行）同样是 `CommandConfigSchema.optional()`，
> 即 branch-evaluator 的 `condition` 类型 = `CommandConfig`。

### BranchMeta

```ts
export const BranchMetaSchema = z.object({
  result: z.string().optional(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  status: z.enum(['evaluating', 'completed']),   // 必填
  expectation: z.string().optional(),
})
export type BranchMeta = z.infer<typeof BranchMetaSchema>
```

`ExecutedStepDefaultSchema` 中 `branchMeta: BranchMetaSchema.optional()`（第 284 行）与 `loopMeta: BranchMetaSchema.optional()`（第 292 行）共用同一形状。

### 相关承载字段（WorkflowStepSchema 第 134–149 行）

```ts
export const WorkflowStepSchema = z.object({
  id: z.string(), name: z.string().optional(),
  command: CommandConfigSchema.optional(),
  inputFrom: z.array(InputFromItemSchema).optional(),
  outputTo: z.array(OutputToItemSchema).optional(),
  passThroughVars: z.array(PassThroughVarSchema).optional(),
  timeout: z.number().optional(),            // 单位分钟（step-runner 乘 60_000）
  next: z.string().optional(),
  defaultExpectation: z.string().optional(),
  condition: CommandConfigSchema.optional(),
  branches: z.array(DagBranchSchema).optional(),
  loop: DagLoopSchema.optional(),
  rules: z.array(z.string()).optional(),
  gates: GatesSchema.optional(),
})
```

---

## 六、step-runner.ts 可复用函数 / StepRunner 构造，microflow/index.ts 导出，测试范式

### 1. step-runner.ts 的导出面与可复用点

文件：`packages/sandore/microflow/src/step-runner.ts`

**公开导出**：
- 类 `StepRunner`（构造 `constructor(private readonly ctx: Context, private readonly config: StepRunnerConfig)`）
- `StepRunnerConfig`（`{ defaultTimeoutMs; defaultProvider?; defaultModel?; skills?; mcps?; agents?; hostAgent?: Agent }`）
- `PreviousStepOutput`（`{ name; id; returnPrompt; files }`）
- `StepRunRequest`（`{ step; workdir; originalInput; previousOutputs; signal?; passThroughVars?; loopTurn?; loopMaxIterations? }`）
- `StepRunSessionMeta`（`{ childId?; synthetic; command }`）
- `StepRunResult`（`{ output: ContentBlock[]; sessionMeta? }`）

**关键结论（不可直接复用，均未 export）**：
- `buildPromptText(taskText, originalInput, previousOutputs, paramsText)` —— **模块内私有函数**（第 186 行，无 `export`）。
  签名：`function buildPromptText(taskText: string, originalInput: string, previousOutputs: readonly PreviousStepOutput[], paramsText: string | undefined): string`。
- `resolveProviderModel(value: ModelRoutedValue): Promise<{ provider: string; model: string }>` —— **StepRunner 私有方法**（第 535 行，`private async`）。
  三层回退：L1 Step 定义 providerId+modelId 成对 → L2 config.defaultProvider+defaultModel 成对 → L3 `ctx.llm.listProviders()[0]` + `listModels`。
- `BlockAssembler` —— 不是本模块定义，从 `@deepseek-ai/dsh-llm` import（见第一节）。
- 其它模块内私有：`buildTaskText` / `buildFillParamsPrompt` / `resolveVars` / `renderPreviousOutputs` / `resolveShellStdin` / `buildShellEnv` / `splitCommand` / `toShellResult` / `stepIdFromPath` / `prefixIfAllowed` / `createHostAgentStub`；常量 `PROMPT_MAIN_HEADER` / `FILL_PARAMS_TASK` / `FILL_PARAMS_RED_LINES`。

> 复用结论：branch-evaluator 若需 `buildPromptText` / `resolveProviderModel`，当前**不能跨模块 import**
> （二者未从 step-runner.ts 或 microflow/index.ts 导出），需在模块内复刻等价逻辑，或（非本次探索范畴）调整导出面。

### 2. microflow/index.ts 导出结构

文件：`packages/sandore/microflow/src/index.ts`

```ts
export * from './errors.ts';        // SandoreError、SandoreErrorCode、isFatalSandoreError
export * from './file-utils.ts';    // 第二节全部函数与结构类型
export * from './step-runner.ts';   // StepRunner + 5 个接口/类型
export * from './stage-executor.ts';// StageExecutor + StageExecution* 类型
export * from './subagents.ts';     // 第四节全部（finalAssistantOutput、Agent、接缝类型）
```

`internal.ts`（`textSummary`/`describeError`）**不进入公开 API**，仅供本包内部模块复用。

### 3. 测试范式（branch-evaluator.spec / loop-manager.spec 编写依据）

- 运行器：vitest。配置 `vitest.config.ts`：`test.include: ['packages/**/*.spec.ts']`、`environment: 'node'`，含标准装饰器转译插件。
- 语法：`import { describe, expect, it } from 'vitest'`；测试文件与被测模块同目录（`.spec.ts` 后缀），
  例如 `microflow/src/step-runner.spec.ts`、`microflow/src/file-utils.spec.ts`、`microflow/src/subagents.spec.ts`。
- 依赖注入：`import { Context } from '@deepseek-ai/cordis'`，`const ctx = new Context()`，
  `ctx.provide('llm', fake)` / `ctx.provide('shell', fake)` / `ctx.provide('subagents', fake)` /
  `ctx.provide('agents', fake)` / `ctx.provide('subprocess', fake)`。
- 测试桩（全部在 `packages/sandore/workflow/tests/mocks/`）：
  - `llm.ts`：`FakeLlm`（`providers`/`models` Map、`calls: GenerateOptions[]`、可注入 `streamHandler`）+ `textChunks(text, reason?)` 固定 chunk 流。
  - `shell.ts`：`FakeShell`（`resolveHandler`/`runHandler` 可注入）+ `successResult(spec, stdout)`。
  - `subprocess.ts`：`FakeSubprocess`（`resolveHandler`/`outcomeHandler` 可注入）+ `FakeSubprocessHandle`。
  - `subagents.ts`：`FakeSubagents`（记录 `continuableStarts` 等）。
  - `agents.ts`：`FakeAgent`/`FakeAgentRegistry` + 事件助手 `assistantMessageEvent(content, seq?, time?)`、`assistantChunkEvent(text, seq?, time?)`。
- 组装范式：`harness()` 构造 `Context` + 各 fake + 被测实例；单测用 `expect(...).resolves/rejects.toEqual/toMatchObject/toThrow`。
- 步骤定义组装：内联 `WorkflowStep` 对象（如 `{ id:'step-p', command:{ type:'prompt', value:{ promptText } } }`）。

---

## 附：与本次探索直接相关的文件路径清单

- `D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.ts`
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\file-utils.ts`
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\subagents.ts`
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\internal.ts`（textSummary/describeError，包内私有）
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\index.ts`
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\errors.ts`
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\stage-executor.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\shell.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\dag-navigator.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\index.ts`
- `D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\{llm,shell,subprocess,subagents,agents,sessions}.ts`
- DSH 依赖（仅声明文件，无 TS 源码）：`node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/types/{types,index,assembler,message,content,call-config}.d.ts`
