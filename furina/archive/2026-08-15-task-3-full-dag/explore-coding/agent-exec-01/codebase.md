## Exploration Result

本次探索基于实际代码，聚焦五个改造基线面的精确现状。所有结论均出自以下文件的真实内容，未做任何实现推断。涉及的源码根路径（monorepo `packages/sandore/*` 结构，`microflow` 包与 `workflow` 包之间以 `import type` 结构类型单向依赖：workflow → microflow）。

### (1) `step-runner.ts` 完整现状（改造基线）

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/step-runner.ts`

**构造与字段**

```ts
export interface StepRunnerConfig {
  readonly defaultTimeoutMs: number;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
}

export class StepRunner {
  constructor(
    private readonly ctx: Context,
    private readonly config: StepRunnerConfig,
  ) {}
}
```

- 构造时绑定 `ctx`（来自 `@deepseek-ai/cordis`）与引擎级配置。无其它字段。
- 顶部局部类型：`type ShellCommand = Extract<CommandConfig, { type: 'shell' }>`、`type PromptCommand = Extract<CommandConfig, { type: 'prompt' }>`。
- 导入：`BlockAssembler, createUserMessage`（`@deepseek-ai/dsh-llm` 值导入）、`ContentBlock, GenerateOptions, LlmRuntime`（`dsh-llm` 类型）、`SandoreError`（`./errors.ts`）、`CommandConfig, WorkflowStep`（`../../workflow/src/schema.ts`）、`ShellExecRequest, ShellRunResult`（`../../workflow/src/shell.ts`）。

**三个请求/结果类型（精确形状）**

```ts
export interface PreviousStepOutput {
  readonly name: string;
  readonly id: string;
  readonly returnPrompt: string;
  readonly files: string[];
}

export interface StepRunRequest {
  readonly step: WorkflowStep;
  readonly workdir: string;
  readonly originalInput: string;
  readonly previousOutputs: readonly PreviousStepOutput[];
  readonly signal?: AbortSignal;
}

export interface StepRunResult {
  readonly output: ContentBlock[];
}
```

注意：`StepRunResult` 只含 `output`（`ContentBlock[]`），**没有** `sessionMeta`/`childId`/`files` 等字段；`sessionMeta` 回传不经过 `StepRunResult`（见 (2)）。

**`run()` 分发**

```ts
async run(request: StepRunRequest): Promise<StepRunResult> {
  const command = request.step.command;
  if (command === undefined) {
    throw new SandoreError(`step '${request.step.id}' has no command`, 'STEP_EXECUTION');
  }
  switch (command.type) {
    case 'shell': return await this.runShell(command, request);
    case 'prompt': return await this.runPrompt(command, request);
    default:
      throw new SandoreError(`unsupported step command type '${command.type}'`, 'STEP_EXECUTION');
  }
}
```

- 目前**仅分发 `shell` 与 `prompt`**；`agent`/`skill`/`mcp` 走 `default` 分支抛 `STEP_EXECUTION`（`unsupported step command type`）。这是改造基线的最关键事实：agent/skill/mcp 三个命令类型在 StepRunner 中完全没有执行路径。

**shell 分支的 `ctx.shell` 调用**

```ts
private async runShell(command: ShellCommand, request: StepRunRequest): Promise<StepRunResult> {
  const shellRequest: ShellExecRequest = {
    command: command.value.command,
    timeoutMs: this.stepTimeoutMs(request.step),
    ...(request.workdir === undefined ? {} : { workdir: request.workdir }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
  const spec = this.ctx.shell.resolve(shellRequest);
  const result = await this.ctx.shell.run(spec);
  return this.toShellResult(result);
}
```

- 调用链：`this.ctx.shell.resolve(shellRequest)` → `this.ctx.shell.run(spec)` → `toShellResult`。
- `ShellExecRequest` 只填了 `command`、`timeoutMs`、`workdir?`、`signal?` 四个字段；**未填 `stdin`/`env`**（尽管 `ShellExecRequest`/`ShellExecSpec` 在 `shell.ts` 中声明了 `stdin?: string`、`env?: Record<string, string>`，当前 StepRunner 未接线）。
- `toShellResult(result)`：`exitCode === 0 && !timedOut && !aborted` → `{ output: [{ type: 'text', text: result.stdout.text }] }`；`timedOut` → 抛 `STEP_TIMEOUT`；`aborted`/其它 → 抛 `STEP_EXECUTION`（stderr trim 为空时用 `'(no stderr)'`）。
- `stepTimeoutMs(step)`：`step.timeout === undefined ? config.defaultTimeoutMs : step.timeout * 60_000`（分钟 → 毫秒）。

**prompt 分支与 `buildPromptText`**

- `runPrompt`：`resolveProviderModel(command)` → `buildPromptText(...)` → `createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] })` → `GenerateOptions { provider, model, messages: [message], signal? }` → `ctx.llm.stream(options)` 循环 `assembler.push(chunk)` → `assembler.blocks()` 作为 `output`；`assembler.finish.kind === 'error'` 或 `'aborted'` → 抛 `STEP_EXECUTION`（携带 `finish.failure.message`）。
- `buildPromptText(step, command, originalInput, previousOutputs)` 结构（`sections.join('\n')`）：
  1. `PROMPT_MAIN_HEADER`（常量："你是严谨准确的Step执行Agent…"）；
  2. `## 你的任务` + `command.value.promptText`；
  3. `## 参考信息` + `### 用户原始需求` + `originalInput`；
  4. 仅当 `previousOutputs.length > 0`：`## 前置Steps输出与产物`，每个 `previous` 输出 `### 前置Step: {name} ({id})` + `<{id}>` 包裹 `<output>`（`returnPrompt` 逐行缩进 4 空格）与 `<artifacts>`（`- {file}`）`</{id}>`。
- `BlockAssembler`：直接 import 自 `@deepseek-ai/dsh-llm`，`new BlockAssembler()` 后 `push(chunk)`、`blocks()`、`finish`（含 `kind: 'stop' | 'error' | 'aborted' | ...`）。

**`resolveProviderModel` 三层回退**

```ts
private async resolveProviderModel(command: PromptCommand): Promise<{ provider: string; model: string }> {
  const { providerId, modelId } = command.value;
  // L1：Step 定义 providerId + modelId 成对提供才用
  if (providerId !== undefined && modelId !== undefined) return { provider: providerId, model: modelId };
  // L2：引擎 Config defaultProvider + defaultModel 成对配置才用
  if (this.config.defaultProvider !== undefined && this.config.defaultModel !== undefined) {
    return { provider: this.config.defaultProvider, model: this.config.defaultModel };
  }
  // L3：ctx.llm 目录兜底
  const provider = this.llm().listProviders()[0];          // 同步
  if (provider === undefined) throw new SandoreError('no LLM provider available', 'STEP_EXECUTION');
  const models = await this.llm().listModels(provider.id); // 异步
  const model = models[0];
  if (model === undefined) throw new SandoreError(`no LLM model available for provider '${provider.id}'`, 'STEP_EXECUTION');
  this.ctx.logger.warn(`sandore: prompt step falls back to directory provider '${provider.id}' model '${model.id}'`);
  return { provider: provider.id, model: model.id };
}
```

- 注意 L1 需要 `providerId` 与 `modelId` **成对**出现才生效；单一出现会落到下一层。`private llm(): LlmRuntime { return this.ctx.llm; }`。

### (2) `stage-executor.ts` 如何构造 StepRunner 与传参

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`

**构造**

```ts
export class StageExecutor {
  private readonly runner: StepRunner;
  constructor(private readonly options: StageExecutorOptions) {
    this.runner = new StepRunner(options.ctx, options.runnerConfig);
  }
}
```

- `StageExecutorOptions` 字段：`ctx`、`stageDef`、`workflowDef`、`input`（`StageExecutionInput`）、`sharedState`（`StageSharedState`）、`runnerConfig`（`StepRunnerConfig`）、`signal?`、`hooks?`（`StageStepHooks`）、`onPersist?`。
- `StageExecutionInput = { originalInput: string; contractArtifacts: Record<string, string[]>; passThroughVars: WorkflowTaskState['passThroughVars'] }`。
- `StageSharedState = { cwd: string; jobId: string; taskId: string }`。

**`workflow.skills/mcps/agents` 数组从何处来 / 是否被消费**

- 来源：`WorkflowDefinition`（`workflow/src/schema.ts` 中 `WorkflowDefinitionSchema` 字段 `skills: z.array(z.string()).default([])`、`mcps: z.array(z.string()).default([])`、`agents: z.array(z.string()).default([])`），由 `parseWorkflowYaml`（`yaml-parser.ts`）从 YAML 解析得到。
- **关键现状**：`workflowDef` 被传入 `StageExecutorOptions`，但 `execute()` 中 `const { stageDef, input, sharedState, signal, hooks } = this.options;` **没有解构/使用 `workflowDef`**（grep 确认仅第 58 行定义处出现）。因此 `skills`/`mcps`/`agents` 三个数组当前**在运行时完全没有被消费**，也**不存在** agent/skill/mcp 名称是否在对应数组中的交叉校验代码（`yaml-parser.spec.ts` 注释里的 "必须在 agents/skills/mcps 数组中" 只是期望语义，未实现）。
- 校验数据来源（若要校验）只能是 `workflowDef.skills/mcps/agents`（即 `StageExecutorOptions.workflowDef`），而引擎侧（`workflow-engine.ts`）已持有完整 `definition`（`ActiveInstance.definition`），并把 `workflowDef: definition` 传入 StageExecutor。

**`previousOutputs` 如何构建**

```ts
const previousOutputs: PreviousStepOutput[] = [];
// 每个 Step 成功后：
previousOutputs.push(toPreviousOutput(executed));
```

`toPreviousOutput(step: ExecutedStepDefault): PreviousStepOutput`：

```ts
{
  name: step.name,
  id: step.stepId ?? step.id,
  returnPrompt: textSummary(step.output),   // internal.ts：仅 text 块按序 '\n' join
  files: [],                                // 恒为空数组
}
```

- `previousOutputs` 只在本 Stage 执行循环内累积（线性执行），传递给下一次 `runner.run({ step, workdir: sharedState.cwd, originalInput: input.originalInput, previousOutputs, signal? })`。

**`StepRunResult` 如何被消费 / `sessionMeta` 回传路径**

- 每个 Step 执行前先构造 `executed: ExecutedStepDefault`，其中 `sessionMeta` **在 run 之前** 就写入：

```ts
const childId = synthesizeChildId(step.id);   // `step-{stepId}-{execId前8位}`
const executed: ExecutedStepDefault = {
  type: 'default', id: childId, stepId: step.id, stageId: stageDef.id,
  name: step.name ?? step.id, status: 'running',
  ...(command === undefined ? {} : { command }),
  ...(step.inputFrom === undefined ? {} : { inputFrom: step.inputFrom }),
  ...(step.outputTo === undefined ? {} : { outputTo: step.outputTo }),
  ...(step.passThroughVars === undefined ? {} : { passThroughVars: step.passThroughVars }),
  ...(command === undefined ? {} : { sessionMeta: { childId, synthetic: true, command: command.type } }),
  visitCount: 1,
};
```

- `StepRunResult` 的消费：`const result = await this.runner.run({...})` 后 `executed.status = 'completed'; executed.output = result.output;` —— 即 **只有 `result.output`（`ContentBlock[]`）写回 `ExecutedStepDefault.output`**，`StepRunResult` 对象本身不落盘，也**不回传 `sessionMeta`**。
- `sessionMeta` 回传路径是：`synthesizeChildId(step.id)` 生成的 `childId` 在 run 之前写入 `executed.sessionMeta = { childId, synthetic: true, command: command.type }`，随后经 `onPersist(executed)` 钩子由引擎（`workflow-engine.ts` 的 `onPersist` 回调）追加进 `state.executedSteps` 并 `persistState` 持久化。`StepSessionMetaSchema.command` 为 `z.enum(['shell', 'prompt', 'agent', 'skill', 'mcp'])`（已含五类型）。
- 失败路径：catch 中 `describeError(error)`（`internal.ts`：`error instanceof Error ? error.message : String(error)`）→ `executed.error` + `status='failed'`，`hooks?.onStepFailed` + `onPersist`，`status='failed'`，`break`。
- `StageContract` 组装（`finalizeStageContract`）：`artifacts` 从 `step.outputTo` 逐条生成（`files: []` 恒空，`returnPrompt` 非空才带）；`passThroughVars` 由 `collectPassThroughVars(stageDef)` 从全部 step 的 `passThroughVars` 收集；`contractArtifacts: {}` 恒空。
- 引擎侧（`workflow-engine.ts` `runInstance`）构造 `StageExecutor` 的入参：`input.contractArtifacts = navigator.getContractArtifacts()`、`input.passThroughVars = active.state.passThroughVars`、`sharedState = { cwd, jobId, taskId }`、`runnerConfig = this.runnerConfig()`（`{ defaultTimeoutMs: config.defaultTimeoutMs ?? 7200000, defaultProvider?, defaultModel? }`）、`onPersist` 逐 Step 追加到 `state.executedSteps` 并持久化。

### (3) `subagents.ts` 接缝与 `shell.ts` 接缝形状

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.ts`

**导出形状（foundation-01 已建，全部为类型 + 一个纯函数）**

- `SessionId = string`；`MessageId = string`。
- `AgentOptions { provider?: string; model?: string; maxTokens?: number }`。
- `AgentStatus = 'idle' | 'running'`。
- `Session { readonly events: readonly SessionEvent[] }`。
- `Agent { readonly id: SessionId; readonly options: AgentOptions; readonly session: Session; readonly status: AgentStatus; whenIdle(): Promise<void> }`。
- `AgentHandle { agent: Agent; dispose(): Promise<void> }`。
- `CreateAgentOptions { sessionId: SessionId; agentOptions?: AgentOptions; signal?: AbortSignal }`；`ResumeAgentOptions { resumeSessionId: SessionId; agentOptions?: AgentOptions; signal?: AbortSignal }`。
- `AgentRegistry { get(id: SessionId): Agent | undefined; create(options): Promise<AgentHandle>; resume(options): Promise<AgentHandle> }`。
- `ToolRestriction { allow?: readonly string[]; deny?: readonly string[] }`。
- `ContinuableStartRequest { prompt: ContentBlock[]; parent: Agent; agentOptions?; maxDepth?; toolFilter?; persona? }`。
- `ContinuableStartSpec { provider: string; label: string; request: ContinuableStartRequest; signal: AbortSignal }`。
- `ContinuableStart { childId: SessionId; messageId: MessageId }`。
- `SubagentFollowupOptions { source: MessageSource; signal: AbortSignal }`。
- `SubagentInterruptAuthority = { kind: 'user'; parentSessionId: SessionId } | { kind: 'ancestor'; agent: Agent }`。
- `SubagentStartRequest { label?; prompt: ContentBlock[]; parent: Agent; signal: AbortSignal; agentOptions?; maxDepth?; toolFilter?; persona? }`。
- `SubagentRun { id: SessionId; localAgent: Agent | undefined; result: Promise<SubagentResult>; dispose(): Promise<void> }`。
- `SubagentResult { output: ContentBlock[]; structured?: unknown; stopReason: SubagentStopReason }`；`SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'`。
- `SubagentRuntime { startContinuable(spec): Promise<ContinuableStart>; followup(parent, childId, content, options): Promise<MessageId>; interrupt(targetSessionId, authority): void; start(name, request): Promise<SubagentRun> }`。
- 事件建模：`SessionEvent = { type: 'assistant/message'; seq; time; data: AssistantMessageData } | { type: 'assistant/chunk'; seq; time; data: AssistantChunkData }`；`AssistantMessageData { turn; step; message: AssistantMessage; usage?: TokenUsage }`；`AssistantChunkData { turn; step; chunk: StreamChunk }`。
- `finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined`：1) 取最后一条非空 `assistant/message` 的 `message.content`（后写覆盖）；2) 无候选时累积 `assistant/chunk` 中 `text-delta` 文本，非空返回 `[{ type: 'text', text }]`；3) 皆无返回 `undefined`。
- `declare module '@deepseek-ai/cordis'` 声明 `Context.subagents: SubagentRuntime` 与 `Context.agents: AgentRegistry`。

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/shell.ts`（`SubprocessRuntime` 接缝）

- `CollectedOutput { text: string; truncated: boolean; spillPath?: string }`。
- `ShellExecRequest { command: string; workdir?; timeoutMs?; stdoutMaxBytes?; signal?; stdin?; env? }`。
- `ShellExecSpec { command: string; workdir: string; timeoutMs: number; stdoutMaxBytes: number; signal?; stdin?; env? }`。
- `ShellRunResult { exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; timeoutMs: number; stdout: CollectedOutput; stderr: CollectedOutput }`。
- `ShellExecutor { resolve(request): ShellExecSpec; run(spec): Promise<ShellRunResult>; start(spec): unknown }`。
- subprocess 接缝：`SubprocessStdinMode = 'ignore' | 'pipe' | { data: string }`；`SubprocessCollect { maxBytes; spill?: { maxBytes } }`；`SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect`；`SubprocessStdio { stdin; stdout; stderr }`；`SubprocessSpawnSpec { argv; cwd; stdio; graceMs; signal?; env? }`；`SubprocessOutcome { exitCode; signal }`；`SubprocessOutputRead`/`SubprocessOutputReader`/`SubprocessCollectedOutputs`；`SubprocessHandle { pid; collected; done: Promise<SubprocessOutcome>; terminate(); waitForExit(signal?): Promise<boolean> }`。
- `SubprocessRuntime { resolveExecutable(command, env?, signal?): Promise<string>; spawn(spec): SubprocessHandle }`。
- `declare module '@deepseek-ai/cordis'` 声明 `Context.shell: ShellExecutor` 与 `Context.subprocess: SubprocessRuntime`。

引擎注入清单（`workflow-engine.ts` 与 `seam.ts` 均一致）：`static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`。**注意 `agents` 与 `subprocess` 不在 inject 列表**（`agents` 仅在 microflow 测试里用 `ctx.provide('agents', ...)` 直接注入）。

### (4) `step-runner.spec.ts` 测试范式与 mock 用法

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/step-runner.spec.ts`

- 测试框架：`vitest` 的 `describe/it/expect`；`import { Context } from '@deepseek-ai/cordis'`；`import type { LlmRuntime } from '@deepseek-ai/dsh-llm'`。
- **harness 范式**（核心）：

```ts
function harness(config: StepRunnerConfig = { defaultTimeoutMs: 60000 }): {
  ctx: Context; llm: FakeLlm; shell: FakeShell; runner: StepRunner;
} {
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  return { ctx, llm, shell, runner: new StepRunner(ctx, config) };
}
```

- Step 组装助手：`shellStep(command, timeout?)`、`promptStep({ providerId?, modelId? })`（`command` 用 `{ type, value }` 嵌套形状）；`request(step, overrides?)` 组默认 `{ step, workdir: '/tmp', originalInput: 'do the thing', previousOutputs: [], ...overrides }`。
- shell 用例：`shell.runHandler = async spec => ({ exitCode, signal, timedOut, aborted, timeoutMs: spec.timeoutMs, stdout: { text, truncated }, stderr: { text, truncated } })`；断言 `resolves.toEqual({ output: [{ type: 'text', text: 'hello' }] })` 或 `rejects.toMatchObject({ code: 'STEP_EXECUTION' | 'STEP_TIMEOUT' })` / `rejects.toThrow(/boom/)`；用 `shell.specs[0]?.timeoutMs` 断言解析后的超时（Step 分钟 → 毫秒）。
- prompt 用例：`llm.providers.push({ id, name })` + `llm.models.set(providerId, [{ provider, id, name }])` + `llm.streamHandler = () => textChunks('...')`（或 `textChunks('', { kind: 'error', failure: { message, code } })`）；断言 `llm.calls[0]?.provider/model` 验证三层回退优先级。

**mock 桩（`workflow/tests/mocks/`）**

- `llm.ts`：`textChunks(text, reason = { kind: 'stop' })` 生成含 `block-start`/`text-delta`/`block-end`/`finish` 的 chunk 流；`FakeLlm { providers: LlmProviderInfo[]; models: Map<string, LlmModelInfo[]>; calls: GenerateOptions[]; streamHandler; listProviders(); listModels(provider); stream(options) }`（`stream` 记录 `calls` 并委托 `streamHandler`）。
- `shell.ts`：`successResult(spec, stdout)`；`FakeShell { requests: ShellExecRequest[]; specs: ShellExecSpec[]; resolveHandler; runHandler; resolve(); run(); start() throws }`；`defaultResolve` 补全 `workdir/timeoutMs/stdoutMaxBytes` 并透传 `signal/stdin/env`。
- `subagents.ts`：`FakeSubagents implements SubagentRuntime`，记录 `continuableStarts`/`followups`/`interrupts`/`startCalls`；`startContinuable` 返回 `{ childId: 'child-{n}', messageId: 'msg-{n}' }`；`followup` 返回 `msg-{n}`；`start` 返回 `{ id: 'run-{n}', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose }`。
- `agents.ts`：`FakeSession implements Session`（`events` 数组 + `append`）；`assistantMessageEvent(content, seq, time)` / `assistantChunkEvent(text, seq, time)` 事件构造助手（用 `createAssistantMessage`）；`FakeAgent implements Agent`（`whenIdle` 立即 resolve）；`FakeAgentRegistry implements AgentRegistry`（`get/create/resume/register`）。
- `subprocess.ts`：`successOutcome()`；`FakeSubprocessHandle implements SubprocessHandle`（`collected = {}`，`done = Promise.resolve(outcomeHandler())`，`terminate()` 置 `terminated=true`，`waitForExit()` 返回 true）；`FakeSubprocess implements SubprocessRuntime`（`resolved: string[]`、`specs: SubprocessSpawnSpec[]`、`resolveHandler`（默认 `/usr/bin/{command}`）、`outcomeHandler`、`resolveExecutable`、`spawn`）。

- `subagents.spec.ts`（`microflow/src/subagents.spec.ts`）示范了如何用 `ctx.provide('subagents', ...)`/`ctx.provide('agents', ...)`/`ctx.provide('subprocess', ...)` 注入三根桩并断言 `startContinuable`/`create`/`resume`/`resolveExecutable`/`spawn` 行为，可作为扩展 spec 的注入范式。

### (5) `schema.ts` CommandConfig 五类型精确字段

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

`CommandConfigSchema = z.discriminatedUnion('type', [...])`，判别字段为顶层 `type`，变体字段整体嵌套于 `value`：

```ts
// agent
{ type: z.literal('agent'), value: z.object({
    promptText: z.string(),
    agentParamsTemplate: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
  }) }
// prompt
{ type: z.literal('prompt'), value: z.object({
    promptText: z.string(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
  }) }
// shell
{ type: z.literal('shell'), value: z.object({ command: z.string() }) }
// skill
{ type: z.literal('skill'), value: z.object({
    promptText: z.string(),
    providerId: z.string().optional(),
  }) }
// mcp
{ type: z.literal('mcp'), value: z.object({ promptText: z.string() }) }
```

- **agent** 四个字段：`promptText`（必填，语义为 Agent 名称）、`agentParamsTemplate?`、`providerId?`、`modelId?`。
- **skill** 两个字段：`promptText`（必填，语义为 Skill 名称）、`providerId?`。
- **mcp** 一个字段：`promptText`（必填，语义为 MCP 名称）。
- **shell** 仅 `command` 一个字段。**`stdin`/`env` 不在 `CommandConfig`（schema 层）**；它们存在于 `workflow/src/shell.ts` 的 `ShellExecRequest`/`ShellExecSpec`（`stdin?: string`、`env?: Record<string, string>`）以及 `SubprocessSpawnSpec`（`env?`）中。当前 `step-runner.ts` 的 `runShell` 也未向 shell 请求填 `stdin`/`env`。
- 相关派生类型：`export type CommandConfig = z.infer<typeof CommandConfigSchema>`；`WorkflowStepSchema.command?: CommandConfigSchema`；`WorkflowStepSchema.condition?: CommandConfigSchema`（分支/循环 breakCondition 也复用 CommandConfig）。
- `StepSessionMetaSchema = z.object({ childId: z.string(), synthetic: z.boolean(), command: z.enum(['shell', 'prompt', 'agent', 'skill', 'mcp']) })` —— 命令枚举已含五类型。

## Supplementary Exploration Result

（补充核实：`skills/mcps/agents` 的消费现状与 YAML 数据形状）

- `grep` 全 `packages/**/*.ts` 确认：`skills`/`mcps`/`agents` 作为**定义字段**只出现在 `schema.ts`（`WorkflowDefinitionSchema`）与 `yaml-parser.spec.ts`（测试 YAML 与断言）；运行时（`workflow-engine.ts`/`stage-executor.ts`/`step-runner.ts`）**没有任何对 `.skills/.mcps/.agents` 的读取或交叉校验**。
- YAML 顶层形状（`yaml-parser.spec.ts` 的 `v2Yaml`/`appendixA1V2Yaml`）：`skills: [code-review-skill]`、`mcps: [filesystem-mcp]`、`agents: [code-reviewer]`；agent/skill/mcp Step 的 `value.promptText` 分别存名称，注释标注 "必须在 agents/skills/mcps 数组中"（期望语义，未实现校验）。
- `microflow/src/index.ts` 导出：`errors.ts`、`file-utils.ts`、`step-runner.ts`、`stage-executor.ts`、`subagents.ts`（`export *`）；`workflow/src/index.ts` 导出 `types.ts`（type-only）、`errors.ts`、`schema.ts`、`yaml-parser.ts`、`shell.ts`（type-only）、`seam.ts`、`dag-navigator.ts`，默认导出 `SandoreEngineRuntime`。
- `internal.ts`（microflow 内部，不进公开 API）：`describeError`、`textSummary`（仅 text 块按序 `\n` join，空/undefined 返回 `''`）。
- `errors.ts`：`SandoreError extends HarnessError`（`@deepseek-ai/dsh-llm`），`code: SandoreErrorCode`，`fatal`（默认 true）；`isFatalSandoreError(error)`。当前 StepRunner 抛的错误码仅 `STEP_TIMEOUT`/`STEP_EXECUTION`。
