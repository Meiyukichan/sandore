## Exploration Result

> 探索类型：reference（本地源码 + `node_modules` 中 `@deepseek-ai/dsh-llm` 的 `.d.ts`/`.js` 实现）
> 探索范围：`packages/sandore/microflow/src/*`、`packages/sandore/workflow/src/*`、`packages/sandore/workflow/tests/mocks/*`、`node_modules/@deepseek-ai/dsh-llm`
> 说明：`furina config show exploration.reference` 返回空数组，故本次直接按 exploreContent 命名的文件定位核实。

### 一、DSH `ctx.llm.stream` 的 `GenerateOptions` 形状与 chunk 聚合（BlockAssembler / createUserMessage）

来源包：`node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm`
（`dsh-llm` 已作为 sandore 运行时依赖安装，`@deepseek-ai/dsh-llm` 是直接 import 源；`ctx.llm` 为 cordis 上下文键，类型为 `LlmRuntime`。）

#### 1. `ctx.llm` 即 `LlmRuntime`（`lib/types/index.d.ts`）

`LlmRuntime extends Service`，与 branch-evaluator 临时会话直接相关的成员：

```ts
class LlmRuntime extends Service {
  constructor(ctx: Context);
  listProviders(): LlmProviderInfo[];                         // 同步
  listModels(provider: string): Promise<LlmModelInfo[]>;      // 异步
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  // 其他：registerAdapter / listConfigurableProviders / resolveModelInfo / prepareCall 等
}
```

- `LlmProviderInfo = { id: string; name: string }`
- `LlmModelInfo = { provider: string; id: string; name: string; description?: string; inputModalities?: readonly ModelModality[] }`
- `Context` 中声明：`interface Context { llm: LlmRuntime }`（cordis module augmentation）。
- `stream` 语义：adapter 选择/派发/迭代失败归一化为终结 `error` 或 `aborted` finish chunk；`llm/stream` 是 waterfall 事件（可拦截）。

#### 2. `GenerateOptions`（`lib/types/types.d.ts`）

```ts
export interface GenerateOptions {
  provider: string;             // 已注册 provider 路由，选择 adapter 实例
  model: string;
  reasoningEffort?: ReasoningEffortId;
  messages: Message[];          // 有序会话消息
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

#### 3. `StreamChunk`（`lib/types/types.d.ts`）

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

`FinishReason`（merge-extensible，按 `kind` 判别）：

```ts
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }   // LlmFailure = { message: string; code: string; status?: number; ... }
  | { kind: 'error'; failure: LlmFailure };
```

`ContentBlock`（merge-extensible，按 `type` 判别）：

```ts
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }
  | { type: 'tool-call'; id: CallId; name: string; arguments: string }
  | { type: 'tool-result'; toolCallId: CallId; content: ContentBlock[]; isError?: boolean };
```

`TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }`。

#### 4. `BlockAssembler`（`lib/types/assembler.d.ts` + `assembler.js` 实现）

```ts
export declare class BlockAssembler {
  push(chunk: StreamChunk): void;
  blocks(): ContentBlock[];
  get usage(): TokenUsage | undefined;
  get finish(): FinishReason;   // 无 finish chunk 时默认 { kind: 'stop' }
  get replayState(): unknown;
  message(source?: MessageSource): Message;
}
```

实现要点（`assembler.js`）：
- `push`：`block-start` 建 partial（记 blockType）；`text-delta`/`reasoning-delta` 累加 `partial.text`；`tool-call-delta` 记 id/name 并累加 `argumentsDelta`；`block-end` 以 chunk.block 覆盖关闭（首个 close 生效，忽略 re-close）；`usage` 存 `_usage`；`finish` 存 `_finish`/`_replayState`。已由 `block-end` 关闭的 index 之后到达的 delta 被忽略（防内存增长）。
- `blocks()`：按 `order`（首次见到的 index 顺序）组装，未关闭 block 从累计 delta 组装（text/reasoning/tool-call 三型；未知类型抛错）；`finish.kind === 'max-tokens'` 时过滤掉 `tool-call` 块。
- `finish`：无 `finish` chunk 时返回 `{ kind: 'stop' }`。

#### 5. `createUserMessage`（`lib/types/message.d.ts`）

```ts
export declare function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'>;
// NewUserMessage = Omit<UserMessage, 'id' | 'role'>
// UserMessage = Message & { role: 'user' }
// Message = { id: MessageId; role: 'system'|'user'|'assistant'; content: ContentBlock[]; source: MessageSource }
```

`MessageSource` 为 merge-extensible（`{ kind: 'user' }` 等）。

#### 6. step-runner 中的实际用法（临时会话复用依据）

`step-runner.ts` 的 `runPrompt` 与 `fillParams`（临时会话）完全一致的聚合范式（`packages/sandore/microflow/src/step-runner.ts:444-533`）：

```ts
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm';

const message = createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text: promptText }],
});
const options: GenerateOptions = {
  provider: route.provider,
  model: route.model,
  messages: [message],
  ...(request.signal === undefined ? {} : { signal: request.signal }),
};
const assembler = new BlockAssembler();
for await (const chunk of this.ctx.llm.stream(options)) {
  assembler.push(chunk);
}
const output = assembler.blocks();
const finish = assembler.finish;
if (finish.kind === 'error')   throw new SandoreError(`...${finish.failure.message}`, 'STEP_EXECUTION');
if (finish.kind === 'aborted') throw new SandoreError(`...${finish.failure.message}`, 'STEP_EXECUTION');
```

`fillParams` 是"临时会话"的现有模板：`resolveProviderModel` → `createUserMessage` → `ctx.llm.stream` → `BlockAssembler.push` → `finish` 判 `error`/`aborted` 回退 → `textSummary(assembler.blocks())`。branch-evaluator 的临时会话可完全照搬此三段式（路由 + stream + 聚合），仅 provider/model 来源与提示词构建不同。

---

### 二、`file-utils.ts` 导出形状（shell 分支三注入的透传替换与产物上下文复用）

来源：`packages/sandore/microflow/src/file-utils.ts`

#### 透传变量替换

```ts
export function replacePassThroughVars(str: string, vars: Readonly<Record<string, string>>): string
```
- 正则 `/\$\{([^}]+)\}/g` 替换 `${xxx}`：已定义替换为值，未定义保留原文（返回 `whole`）。
- 用 `str.replace(regex, fn)` 回调，替换值中的 `$&`/`$1` 不会被解释（有专门测试 `'x$&y$1z'`）。

#### glob / regex 转换与区分

```ts
export function escapeRegexChar(char: string): string
export function globToRegex(glob: string): RegExp     // 锚定 ^...$；*→[^/]*、**→.*（跳过后续 /）、?→[^/]
export function isGlobPattern(pattern: string): boolean // 含 * 或 ? 且无 \\.|\(\? 特征 → glob
```

#### 递归文件搜索（产物上下文复用）

```ts
export async function walkDir(fs: FileSystem, dir: FsTarget): Promise<string[]>                          // 递归全部文件绝对路径，跳过 node_modules
export async function findFilesByGlob(fs: FileSystem, rootDir: string, pattern: string): Promise<string[]>
export async function findFilesByRegex(fs: FileSystem, rootDir: string, regex: string): Promise<string[]>
```
三者返回"进程绝对路径数组"（经 `fs.processPath`）。

#### 文件系统接缝（target 导向两段式协议）

```ts
export interface FsTarget { readonly targetKey: string; readonly displayPath: string }
export interface FsDirEntry { readonly name: string; readonly type: 'file' | 'directory' | 'other'; readonly target: FsTarget }
export interface FsWriteOutcome { readonly operation: 'create' | 'update'; readonly version: string; readonly before: string | null; readonly after: string }
export interface FileSystem {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  processPath(target: FsTarget): string;
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>;
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  writeText(target: FsTarget, content: string): Promise<FsWriteOutcome>;
}
```
`file-utils.ts` 同时 `declare module '@deepseek-ai/cordis' { interface Context { fs: FileSystem } }`。

#### 产物文件读写（`{uuid}_output.json`）

```ts
export interface OutputArtifact { readonly id: string; readonly value: string[] }
export interface StepOutputFile {
  readonly sessionId: string;
  readonly output: { readonly returnPrompt: string; readonly artifacts: OutputArtifact[] };
}
export function outputJsonFileName(stepMessageId: string): string  // `${stepMessageId}_output.json`
export async function writeOutputJson(fs: FileSystem, dir: string, stepMessageId: string, data: StepOutputFile): Promise<string>
export async function readOutputJson(fs: FileSystem, dir: string, stepMessageId: string): Promise<StepOutputFile>
```

#### InputFrom 就近匹配

```ts
export function idMatches(actualId: string, targetId: string): boolean  // 相等或 actualId 以 `targetId-` 开头
export function resolvePathSegments(executedSteps: readonly ExecutedStepDefault[], currentIndex: number, path: string): ExecutedStepDefault[]
export function resolveFromInputFrom(executedSteps: readonly ExecutedStepDefault[], currentIndex: number, inputFromItems: readonly InputFromItem[]): ExecutedStepDefault[]
```

`resolvePathSegments` 支持三档路径：`stageId`（倒序全部）、`stageId.stepId`（就近匹配，支持循环后缀 id）、`stageId.stepId.outputToId`。

---

### 三、`shell.ts` 的 `ShellExecutor` / `SubprocessRuntime` 接缝形状

来源：`packages/sandore/workflow/src/shell.ts`（本地结构类型声明，`@deepseek-ai/dsh-shell` 未安装；`ctx.shell` / `ctx.subprocess` 上下文键在此声明）。

```ts
export interface CollectedOutput { text: string; truncated: boolean; spillPath?: string }

export interface ShellExecRequest {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  signal?: AbortSignal;
  stdin?: string;
  env?: Record<string, string>;
}
export interface ShellExecSpec {
  command: string; workdir: string; timeoutMs: number; stdoutMaxBytes: number;
  signal?: AbortSignal; stdin?: string; env?: Record<string, string>;
}
export interface ShellRunResult {
  exitCode: number | null; signal: string | null;
  timedOut: boolean; aborted: boolean; timeoutMs: number;
  stdout: CollectedOutput; stderr: CollectedOutput;
}
export interface ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec;
  run(spec: ShellExecSpec): Promise<ShellRunResult>;
  start(spec: ShellExecSpec): unknown;
}
```

subprocess 接缝（stdin/env 注入与原始 stdio）：

```ts
export type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string };
export interface SubprocessCollect { maxBytes: number; spill?: { maxBytes: number } }
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect;
export interface SubprocessStdio { stdin: SubprocessStdinMode; stdout: SubprocessOutputMode; stderr: SubprocessOutputMode }
export interface SubprocessSpawnSpec {
  argv: readonly string[]; cwd: string; stdio: SubprocessStdio;
  graceMs: number; signal?: AbortSignal; env?: Record<string, string>;
}
export interface SubprocessOutcome { exitCode: number | null; signal: string | null; timedOut?: boolean }
export interface SubprocessOutputRead { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
export interface SubprocessOutputReader { readFrom(fromByte: number): SubprocessOutputRead }
export interface SubprocessCollectedOutputs { readonly stdout?: SubprocessOutputReader; readonly stderr?: SubprocessOutputReader }
export interface SubprocessHandle {
  readonly pid: number;
  readonly collected: SubprocessCollectedOutputs;
  readonly done: Promise<SubprocessOutcome>;
  terminate(): void;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}
export interface SubprocessRuntime {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
}
```

`ctx.subprocess` 的现有消费范式（`step-runner.ts:386-422`）：`resolveExecutable(program, env, signal)` → `spawn({ argv: [executable, ...args], cwd, stdio: { stdin: { data }, stdout: { maxBytes: 1MB }, stderr: { maxBytes: 1MB } }, graceMs, env?, signal? })` → `handle.done` → `handle.collected.stdout?.readFrom(0)`。

---

### 四、`subagents.ts` 的 `finalAssistantOutput` / `Agent` 结构

来源：`packages/sandore/microflow/src/subagents.ts`（本地结构类型声明 + `finalAssistantOutput` 实现；`@deepseek-ai/dsh-subagent`/`dsh-agent` 未安装，接缝内自带选取逻辑）。

```ts
export type SessionId = string;
export type MessageId = string;
export interface AgentOptions { provider?: string; model?: string; maxTokens?: number }
export type AgentStatus = 'idle' | 'running';
export interface Session { readonly events: readonly SessionEvent[] }
export interface Agent {
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  readonly status: AgentStatus;
  whenIdle(): Promise<void>;
}
```

`SessionEvent`（仅精确建模 assistant 两类事件，`seq`/`time` 为 DSH 追加式日志包络）：

```ts
export type SessionEvent =
  | { readonly type: 'assistant/message'; readonly seq: number; readonly time: number; readonly data: AssistantMessageData }
  | { readonly type: 'assistant/chunk';    readonly seq: number; readonly time: number; readonly data: AssistantChunkData };

export interface AssistantMessageData { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
export interface AssistantChunkData   { turn: number; step: number; chunk: StreamChunk }
```

```ts
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined
```
选取规则（与 DSH 源码一致，与 stop reason 无关）：
1. 取最后一条非空 `assistant/message` 的 `message.content`（后写覆盖，空 content 跳过）；
2. 无候选时累加 `assistant/chunk` 中 `text-delta` 文本，非空返回 `[{ type: 'text', text }]`；
3. 两者皆无返回 `undefined`。

相关注册表 / 运行时接缝：

```ts
export interface AgentRegistry { get(id: SessionId): Agent | undefined; create(options): Promise<AgentHandle>; resume(options): Promise<AgentHandle> }
export interface AgentHandle { agent: Agent; dispose(): Promise<void> }
export interface SubagentRuntime {
  startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
  followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
}
export interface ContinuableStartSpec { readonly provider: string; readonly label: string; readonly request: ContinuableStartRequest; readonly signal: AbortSignal }
export interface ContinuableStartRequest { readonly prompt: ContentBlock[]; readonly parent: Agent; readonly agentOptions?: AgentOptions; readonly maxDepth?: number; readonly toolFilter?: ToolRestriction; readonly persona?: string }
export interface ContinuableStart { readonly childId: SessionId; readonly messageId: MessageId }
```

`ctx.subagents` / `ctx.agents` 上下文键在本文件声明。

---

### 五、`schema.ts` 的 `DagBranch` / `DagLoop` / `BranchMeta` / `CommandConfig` 精确形状

来源：`packages/sandore/workflow/src/schema.ts`（真实 `zod`，类型为 `z.infer` 派生）。

#### `CommandConfig`（五变体 discriminated union，判别字段顶层 `type`，变体字段整体嵌套 `value`）

```ts
export const CommandConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent'), value: z.object({
    promptText: z.string(),
    agentParamsTemplate: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
  })}),
  z.object({ type: z.literal('prompt'), value: z.object({
    promptText: z.string(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
  })}),
  z.object({ type: z.literal('shell'), value: z.object({ command: z.string() }) }),
  z.object({ type: z.literal('skill'), value: z.object({ promptText: z.string(), providerId: z.string().optional() }) }),
  z.object({ type: z.literal('mcp'), value: z.object({ promptText: z.string() }) }),
])
export type CommandConfig = z.infer<typeof CommandConfigSchema>
```

#### `DagBranch` / `DagLoop`

```ts
export const DagBranchSchema = z.object({
  expectation: z.string().optional(),
  next: z.string(),
  label: z.string().optional(),
})
export type DagBranch = z.infer<typeof DagBranchSchema>

export const DagLoopSchema = z.object({
  breakCondition: CommandConfigSchema.optional(),   // 注意：breakCondition 类型就是 CommandConfig
  breakExpectation: z.string().optional(),
  next: z.string().optional(),
  maxIterations: z.number(),
  exitTo: z.string().optional(),
})
export type DagLoop = z.infer<typeof DagLoopSchema>
```

- 分支/循环的判别条件字段：`WorkflowStep.condition: CommandConfigSchema.optional()`、`WorkflowStage.condition: CommandConfigSchema.optional()`（两者均为 `CommandConfig` 类型）；`DagLoop.breakCondition` 同为 `CommandConfig`。
- `WorkflowStep` 另含 `branches: z.array(DagBranchSchema).optional()`、`loop: DagLoopSchema.optional()`。

#### `BranchMeta`（分支/循环评估元数据，被 `ExecutedStepDefault.branchMeta` 与 `loopMeta` 共用）

```ts
export const BranchMetaSchema = z.object({
  result: z.string().optional(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  status: z.enum(['evaluating', 'completed']),
  expectation: z.string().optional(),
})
export type BranchMeta = z.infer<typeof BranchMetaSchema>
```

#### 相关：`ExecutedStepDefault`

`schema.ts` 中 `ExecutedStepDefaultSchema` 定义了 `branchMeta: BranchMetaSchema.optional()`、`loopMeta: BranchMetaSchema.optional()`、`loopIteration: z.array(z.number()).optional()`、`sessionMeta: StepSessionMetaSchema.optional()`、`output: z.array(ContentBlockSchema).optional()`。
注意：`ExecutedStepDefault` 的 TS 类型导出在 `packages/sandore/workflow/src/types.ts`（interface 形式，`branchMeta?: BranchMeta` / `loopMeta?: BranchMeta`），并非 schema.ts 直接导出该类型名（schema.ts 只导出 schema 常量）。`types.ts` 从 schema.ts 收紧了 `BranchMeta` 等 13 个基础类型并 re-export。

---

### 六、`step-runner.ts` 可复用函数与 `StepRunner` 构造、`microflow/index.ts` 导出、测试范式

来源：`packages/sandore/microflow/src/step-runner.ts`、`index.ts`、`stage-executor.ts`、`internal.ts`、`*.spec.ts`、`packages/sandore/workflow/tests/mocks/*`

#### 1. `StepRunner` 构造与公开导出面

```ts
export interface StepRunnerConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly skills?: readonly string[];
  readonly mcps?: readonly string[];
  readonly agents?: readonly string[];
  readonly hostAgent?: Agent;         // 缺省用最小桩 createHostAgentStub()
}
export interface StepRunRequest {
  readonly step: WorkflowStep;
  readonly workdir: string;
  readonly originalInput: string;
  readonly previousOutputs: readonly PreviousStepOutput[];
  readonly signal?: AbortSignal;
  readonly passThroughVars?: Readonly<Record<string, string>>;
  readonly loopTurn?: number;          // 1-based，缺省 0
  readonly loopMaxIterations?: number; // 缺省 0
}
export interface StepRunResult { readonly output: ContentBlock[]; readonly sessionMeta?: StepRunSessionMeta }
export interface StepRunSessionMeta { readonly childId?: string; readonly synthetic: boolean; readonly command: CommandConfig['type'] }
export interface PreviousStepOutput { readonly name: string; readonly id: string; readonly returnPrompt: string; readonly files: string[] }

export class StepRunner {
  constructor(private readonly ctx: Context, private readonly config: StepRunnerConfig) {}
  async run(request: StepRunRequest): Promise<StepRunResult>;  // 按 command.type 分发 5 路径
}
```

构造方式（`stage-executor.ts:155` 现有用法）：`new StepRunner(options.ctx, options.runnerConfig)`，其中 `runnerConfig` 为引擎注入的 `StepRunnerConfig`。

#### 2. 可复用函数（注意可见性）

- `buildPromptText(taskText, originalInput, previousOutputs, paramsText?)` —— **模块私有（未 export）**，组装结构化提示词（主头部 + `## 你的任务` + `## 参考信息` + 可选 `### 当前Step参数` + `## 前置Steps输出与产物`）。
- `buildFillParamsPrompt(...)` / `buildTaskText(...)` / `resolveVars(...)` / `renderPreviousOutputs(...)` —— 均为模块私有。
- `resolveProviderModel(value)` —— **`StepRunner` 私有方法**，三层回退：L1 Step 定义 `providerId`+`modelId` 成对 → L2 config `defaultProvider`+`defaultModel` 成对 → L3 `ctx.llm.listProviders()[0]` + `await ctx.llm.listModels(provider.id)[0]`（`listProviders` 同步、`listModels` 异步）。签名 `Promise<{ provider: string; model: string }>`。
- `llm()` / `resolveParent()` / `stepTimeoutMs()` / `toShellResult()` / `splitCommand()` —— 均私有。
- `textSummary(output)` 在 `internal.ts`，**未从 index.ts re-export**（包内可用）：`textSummary(output: readonly ContentBlock[] | undefined): string`（仅 text 块按序 join `\n`）。

结论：branch-evaluator / loop-manager 若要复用 `buildPromptText` / `resolveProviderModel`，它们当前均为私有（未进入 microflow 公开 API），需自行实现等价逻辑或（在后续任务中）将它们提升导出——本次仅记录现状，不提供方案。

#### 3. `microflow/index.ts` 导出结构

```ts
export * from './errors.ts';       // SandoreError、SandoreErrorCode、isFatalSandoreError
export * from './file-utils.ts';
export * from './step-runner.ts';  // StepRunner + 上述接口
export * from './stage-executor.ts';
export * from './subagents.ts';    // finalAssistantOutput + 接缝类型
```

依赖方向：workflow → microflow（运行时）；microflow 对 workflow 仅 `import type`（`schema.ts`/`types.ts`/`shell.ts` 结构类型）。`internal.ts` 不进入公开 API。

#### 4. 测试范式（branch-evaluator.spec / loop-manager.spec 编写依据）

- 测试框架：`vitest`（`import { describe, expect, it } from 'vitest'`），spec 与源码同目录（`*.spec.ts`）。
- 上下文注入范式：`const ctx = new Context()`（`@deepseek-ai/cordis`）→ `ctx.provide('llm'|'shell'|'subagents'|'agents'|'subprocess', fake)`。参见 `step-runner.spec.ts:103-124` 的 `harness()`。
- 测试桩（`packages/sandore/workflow/tests/mocks/*.ts`，microflow 的 spec 跨包引用）：
  - `FakeLlm`（`llm.ts`）：`providers: LlmProviderInfo[]`、`models: Map<string, LlmModelInfo[]>`、`calls: GenerateOptions[]`、`streamHandler: (options) => AsyncIterable<StreamChunk>`；`stream` 记录调用并委托 handler。辅助 `textChunks(text, reason = { kind: 'stop' })` 生成单 text block chunk 流（`block-start` → `text-delta` → `block-end` → `finish`）。
  - `FakeShell`（`shell.ts`）：`requests`/`specs` 记录 + `resolveHandler`/`runHandler`；辅助 `successResult(spec, stdout)`。
  - `FakeSubprocess`（`subprocess.ts`）：`resolved`/`specs` 记录 + `resolveHandler`（默认 `/usr/bin/${command}`）/`outcomeHandler`；`FakeSubprocessHandle`（`done` 立即 resolve）。
  - `FakeSubagents`（`subagents.ts`）：`continuableStarts` 记录，`startContinuable` 返回 `{ childId: 'child-N', messageId: 'msg-N' }`。
  - `FakeAgent` / `FakeAgentRegistry` / `FakeSession` / `assistantMessageEvent` / `assistantChunkEvent`（`agents.ts`）：`FakeSession.append(event)` 追加事件；`assistantMessageEvent(content)` 用 `createAssistantMessage` 构造事件。
- prompt/临时会话测试范式：注入 `llm.providers.push({ id: 'p', name: 'Provider' })`、`llm.models.set('p', [{ provider: 'p', id: 'm', name: 'Model' }])`、`llm.streamHandler = () => textChunks('summary')`，断言 `result.output` 或 `llm.calls[0].provider/model/messages`（见 `step-runner.spec.ts:316-381`）。
- 纯函数测试范式（对 `finalAssistantOutput` 等）：不建 ctx，直接用 `expect(fn(...)).toBe/toEqual/toBeUndefined`（见 `subagents.spec.ts:31-64`、`file-utils.spec.ts`）。

## Supplementary Exploration Result

`experimental.websearch=true`、`experimental.context7=true`。但本次 exploreContent 全部指向本地源码与已安装的 `@deepseek-ai/dsh-llm` 包，Phase 3 已获取到充分、精确的参考信息，无需补充联网查询（不强制检索）。
