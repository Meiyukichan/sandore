# 探索结果：agent/skill/mcp Step 执行的改造基线

> 探索类型：specification（精确核实现状，作为改造基线）
> 语言：中文
> 项目路径：D:/project-code/llm/sandore
> 说明：specification materials 配置为空（`furina config show exploration.specification` → `[]`），
> 无外部/目录/skill/url 材料；以下全部结论均来自对实际源码的逐一核实。

实际源码根目录为 `packages/sandore`（`D:\project-code\llm\sandore\packages\sandore`），
而非顶层 `microflow/` 与 `workflow/`。

---

## 一、microflow/src/step-runner.ts 完整现状（改造基线）

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.ts`
模块：`@deepseek-ai/dsh-sandore-microflow/src/step-runner`

### 1. 依赖与类型收窄

- 运行时依赖：`@deepseek-ai/cordis`（`Context`）、`@deepseek-ai/dsh-llm`（`BlockAssembler`、`createUserMessage`）。
- 类型依赖：`@deepseek-ai/dsh-llm`（`ContentBlock`、`GenerateOptions`、`LlmRuntime`）、
  `./errors.ts`（`SandoreError`）、`../../workflow/src/schema.ts`（`CommandConfig`、`WorkflowStep`，均为 `import type`）、
  `../../workflow/src/shell.ts`（`ShellExecRequest`、`ShellRunResult`，均为 `import type`）。
- 局部收窄：
  ```ts
  type ShellCommand = Extract<CommandConfig, { type: 'shell' }>;
  type PromptCommand = Extract<CommandConfig, { type: 'prompt' }>;
  ```
  当前**只有** shell / prompt 两个变体有收窄类型；agent / skill / mcp 未定义。

### 2. 导出类型

- `StepRunnerConfig`：引擎级配置（provider/model 三层回退的 L2 来源）。
  ```ts
  { readonly defaultTimeoutMs: number; readonly defaultProvider?: string; readonly defaultModel?: string }
  ```
- `PreviousStepOutput`：前置 Step 输出摘要。
  ```ts
  { readonly name: string; readonly id: string; readonly returnPrompt: string; readonly files: string[] }
  ```
- `StepRunRequest`：
  ```ts
  { readonly step: WorkflowStep; readonly workdir: string; readonly originalInput: string;
    readonly previousOutputs: readonly PreviousStepOutput[]; readonly signal?: AbortSignal }
  ```
- `StepRunResult`：`{ readonly output: ContentBlock[] }`（成功时聚合的输出块）。

### 3. StepRunner 构造

```ts
constructor(private readonly ctx: Context, private readonly config: StepRunnerConfig) {}
```
构造时仅绑定 `ctx` 与 `config`，不绑定 workflow 定义。

### 4. run() 分发

```ts
async run(request: StepRunRequest): Promise<StepRunResult>
```
- `request.step.command === undefined` → 抛 `SandoreError("step '<id>' has no command", 'STEP_EXECUTION')`。
- `switch (command.type)`：
  - `'shell'` → `runShell(command, request)`
  - `'prompt'` → `runPrompt(command, request)`
  - `default` → 抛 `SandoreError("unsupported step command type '<type>'", 'STEP_EXECUTION')`
- **现状关键点**：`agent` / `skill` / `mcp` 三个类型会落入 `default` 分支，
  抛 `unsupported step command type`。这是改造要接续的位置。

### 5. shell 分支（ctx.shell 调用）

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
- `toShellResult`：`exitCode === 0 && !timedOut && !aborted` → `{ output: [{ type: 'text', text: result.stdout.text }] }`；
  否则取 stderr 摘要（空为 `(no stderr)`）：
  - `timedOut` → `SandoreError(..., 'STEP_TIMEOUT')`
  - `aborted` 或非零退出（`exitCode === null` 记 `'signal'`）→ `SandoreError(..., 'STEP_EXECUTION')`
- `stepTimeoutMs`：`step.timeout === undefined ? config.defaultTimeoutMs : step.timeout * 60_000`（分钟 → 毫秒）。
- **注意**：shell 请求只组装 `command`/`timeoutMs`/`workdir`/`signal`，**未使用** `stdin`/`env`/`stdoutMaxBytes`，
  这些字段存在于 shell.ts 接缝（见第四节），但当前 shell Step 执行路径未注入。

### 6. prompt 分支（buildPromptText / resolveProviderModel / BlockAssembler）

- `buildPromptText(step, command: PromptCommand, originalInput, previousOutputs)`：拼接结构化提示词，
  段序：`PROMPT_MAIN_HEADER`（常量，角色声明）→ `## 你的任务`（`command.value.promptText`）→
  `## 参考信息` / `### 用户原始需求`（`originalInput`）→ 有前置输出时追加 `## 前置Steps输出与产物`，
  每个 `previous` 渲染为 `<id>` 包裹的 `<output>`（`returnPrompt` 逐行缩进 4 空格）与
  `<artifacts>`（`files` 列表项）。
- `resolveProviderModel(command: PromptCommand)`：三层回退，返回 `{ provider, model }`：
  1. **L1**：`command.value.providerId` 与 `command.value.modelId` 成对提供才用；
  2. **L2**：`config.defaultProvider` 与 `config.defaultModel` 成对配置才用；
  3. **L3**：`ctx.llm.listProviders()[0]`（同步）→ 无 provider 抛 `'no LLM provider available'`；
     `ctx.llm.listModels(provider.id)`（异步）取 `[0]` → 无 model 抛 `'no LLM model available for provider ...'`；
     命中 L3 时 `ctx.logger.warn` 记录目录兜底。
- `runPrompt` 主流程：`createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] })`
  → 组装 `GenerateOptions { provider, model, messages: [message], signal? }`
  → `const assembler = new BlockAssembler(); for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);`
  → `output = assembler.blocks()`，`finish = assembler.finish`；
  `finish.kind === 'error'` 或 `'aborted'` → `SandoreError('prompt step failed/aborted: ' + finish.failure.message, 'STEP_EXECUTION')`；
  否则返回 `{ output }`。
- `llm()` 私有助手：`return this.ctx.llm`（类型 `LlmRuntime`）。

### 7. 错误码（microflow/src/errors.ts）

`SandoreErrorCode` 全集：`YAML_PARSE | DEFINITION_INVALID | NODE_NOT_FOUND | CYCLE_DETECTED | STEP_TIMEOUT | STEP_EXECUTION | INVALID_OPERATION | CANCELLED | FINALIZE_FAILED | GATE_FAILED | SESSION_LOST | PERSISTENCE_FAILED`。
`SandoreError extends HarnessError`（`code` 稳定路由，`fatal` 默认 true）。
workflow 包的 `errors.ts` 只是 re-export microflow 的实现。

---

## 二、microflow/src/stage-executor.ts 如何构造 StepRunner 与传参

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\stage-executor.ts`
模块：`@deepseek-ai/dsh-sandore-microflow/src/stage-executor`

### 1. 构造

```ts
export class StageExecutor {
  private readonly runner: StepRunner;
  constructor(private readonly options: StageExecutorOptions) {
    this.runner = new StepRunner(options.ctx, options.runnerConfig);
  }
}
```

`StageExecutorOptions` 字段：
```ts
{
  ctx: Context;
  stageDef: WorkflowStage;
  workflowDef: WorkflowDefinition;        // ← 传入但 execute() 内未读取
  input: StageExecutionInput;             // { originalInput, contractArtifacts, passThroughVars }
  sharedState: StageSharedState;          // { cwd, jobId, taskId }
  runnerConfig: StepRunnerConfig;
  signal?: AbortSignal;
  hooks?: StageStepHooks;                 // onStepStart/onStepCompleted/onStepFailed
  onPersist?: (executedStep: ExecutedStepDefault) => Promise<void> | void;
}
```

### 2. workflow.skills/mcps/agents 数组从何处来

- `WorkflowDefinition`（schema.ts）顶层定义（均默认空数组）：
  ```ts
  skills: z.array(z.string()).default([]),
  mcps: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  ```
- 数据来源链：YAML 文本 → `parseWorkflowYaml`（yaml-parser.ts，Zod `WorkflowDefinitionSchema.parse`）→
  `definition.skills/mcps/agents` → 引擎 `SandoreEngineRuntime.runInstance` 中
  `new StageExecutor({ ..., workflowDef: definition, ... })`。
- **现状关键点**：`workflowDef` 被 `StageExecutorOptions` 接收并存入 `options`，
  但 `execute()` 只解构了 `{ stageDef, input, sharedState, signal, hooks }`，**从未读取 `workflowDef.skills/mcps/agents`**。
  即当前 agent/skill/mcp Step 的「名称必须在对应数组中」的校验**尚无任何实现**；
  校验的候选数据源（workflow 级数组）已经存在于 `WorkflowDefinition` 且已传入 `StageExecutorOptions`，只是未消费。

### 3. previousOutputs 如何构建

- `execute()` 内维护局部数组 `const previousOutputs: PreviousStepOutput[] = []`。
- 每个 Step 成功后 `previousOutputs.push(toPreviousOutput(executed))`。
- `toPreviousOutput(step: ExecutedStepDefault): PreviousStepOutput`：
  ```ts
  { name: step.name, id: step.stepId ?? step.id, returnPrompt: textSummary(step.output), files: [] }
  ```
  `textSummary`（internal.ts）仅按序拼接 `ContentBlock[]` 中 `type === 'text'` 块的文本；`files` 恒为 `[]`。
- 传给 StepRunner：`this.runner.run({ step, workdir: sharedState.cwd, originalInput: input.originalInput, previousOutputs, ...(signal===undefined?{}:{signal}) })`。

### 4. StepRunResult 如何被消费

- 成功：`executed.status = 'completed'; executed.output = result.output;`（`result.output` 是 `ContentBlock[]`）。
- `toPreviousOutput` 又用 `textSummary(executed.output)` 得到 `returnPrompt`，作为下一个 Step 的 prompt 参考信息。
- 失败：catch 中 `describeError(error)`（`error.message` 或 `String(error)`）写入 `executed.error`，置 `status='failed'`，`break` 中止。

### 5. sessionMeta 回传路径

- 在 `execute()` 内每个 Step 开始时构造 `ExecutedStepDefault`，其中（仅当 `command` 存在时）：
  ```ts
  sessionMeta: { childId, synthetic: true, command: command.type }
  ```
  对应 schema 的 `StepSessionMetaSchema`：
  ```ts
  { childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']) }
  ```
- `childId` 由 `synthesizeChildId(stepId)` 合成：`step-{stepId}-{execId 前 8 位}`（`crypto.randomUUID()` 去连字符取前 8）。
- 回传链路：`executed` 经 `onPersist` 钩子（引擎注入）逐 Step 追加到 `state.executedSteps` 并持久化；
  引擎 `workflow-engine.ts` 的 `onPersist` 将 `executed` 以 `as unknown as WorkflowTaskState['executedSteps'][number]` 追加。
- `ExecutedStepDefault`（types.ts / schema.ts 的 `ExecutedStepDefaultSchema`）还有 `parentSessionId?: string` 字段（当前未使用）。
- **现状关键点**：`sessionMeta.command` 已允许 `'agent'|'skill'|'mcp'`（schema 枚举已含五类），
  但 agent/skill/mcp 尚无线程执行路径会生成这类 `sessionMeta`（因 StepRunner 只支持 shell/prompt）。

### 6. 引擎侧构造（workflow-engine.ts，供会话/数据源参照）

- `SandoreEngineRuntime` 的 `static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`
  （与 `seam.ts` 的 `SandoreEngineStub` 相同；注意 `agents` 与 `subprocess` **未**列入 inject）。
- `SandoreConfig`：`{ defaultTimeoutMs?: number; maxConcurrentSteps?: number; defaultProvider?: string; defaultModel?: string }`；
  `runnerConfig()` 把 `defaultTimeoutMs ?? 7200000` 与成对 defaultProvider/defaultModel 映射为 `StepRunnerConfig`。
- 引擎测试 harness（workflow-engine.spec.ts）注入：`ctx.provide('llm', ...)`、`ctx.provide('shell', ...)`、
  `ctx.provide('sessions', ...)`、`ctx.provide('sessionPersistence', {})`、`ctx.provide('subagents', {})`、`ctx.provide('fs', {})`。
  **未注入** `agents` 与 `subprocess`。

---

## 三、subagents.ts 与 shell.ts 接缝的精确导出形状

### 1. microflow/src/subagents.ts（foundation-01 已建）

模块：`@deepseek-ai/dsh-sandore-microflow/src/subagents`；纯 `import type`，无运行时依赖 DSH 包。

- 品牌类型：`SessionId = string`、`MessageId = string`。
- `AgentOptions`：`{ provider?: string; model?: string; maxTokens?: number }`。
- `AgentStatus = 'idle' | 'running'`。
- `Session`：`{ readonly events: readonly SessionEvent[] }`。
- `Agent`（`ctx.agents.get` 返回的裸 Agent）：
  ```ts
  { readonly id: SessionId; readonly options: AgentOptions; readonly session: Session;
    readonly status: AgentStatus; whenIdle(): Promise<void> }
  ```
- `AgentHandle`：`{ agent: Agent; dispose(): Promise<void> }`。
- `CreateAgentOptions`：`{ sessionId: SessionId; agentOptions?: AgentOptions; signal?: AbortSignal }`。
- `ResumeAgentOptions`：`{ resumeSessionId: SessionId; agentOptions?: AgentOptions; signal?: AbortSignal }`。
- `AgentRegistry`：`{ get(id): Agent | undefined; create(options): Promise<AgentHandle>; resume(options): Promise<AgentHandle> }`。
- `ToolRestriction`：`{ allow?: readonly string[]; deny?: readonly string[] }`。
- `ContinuableStartRequest`（startContinuable 的委派请求，扣除 label/signal/outputSchema 后）：
  `{ prompt: ContentBlock[]; parent: Agent; agentOptions?: AgentOptions; maxDepth?: number; toolFilter?: ToolRestriction; persona?: string }`。
- `ContinuableStartSpec`（startContinuable 入参）：
  `{ provider: string; label: string; request: ContinuableStartRequest; signal: AbortSignal }`。
- `ContinuableStart`（返回）：`{ childId: SessionId; messageId: MessageId }`。
- `SubagentFollowupOptions`：`{ source: MessageSource; signal: AbortSignal }`。
- `SubagentInterruptAuthority`：
  `{ kind: 'user'; parentSessionId: SessionId } | { kind: 'ancestor'; agent: Agent }`。
- `SubagentStartRequest`（一次性启动）：`{ label?; prompt: ContentBlock[]; parent: Agent; signal: AbortSignal; agentOptions?; maxDepth?; toolFilter?; persona? }`。
- `SubagentRun`：`{ id: SessionId; localAgent: Agent | undefined; result: Promise<SubagentResult>; dispose(): Promise<void> }`。
- `SubagentResult`：`{ output: ContentBlock[]; structured?: unknown; stopReason: SubagentStopReason }`。
- `SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'`。
- `SubagentRuntime`（`ctx.subagents` 接缝）：
  ```ts
  {
    startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
    followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>;
    interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void;
    start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
  }
  ```
- 事件类型：
  - `AssistantMessageData`：`{ turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }`。
  - `AssistantChunkData`：`{ turn: number; step: number; chunk: StreamChunk }`。
  - `SessionEvent`（最小建模，仅两类）：
    `{ type: 'assistant/message'; seq: number; time: number; data: AssistantMessageData }`
    `| { type: 'assistant/chunk'; seq: number; time: number; data: AssistantChunkData }`。
- `finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined`：
  规则（与 DSH 源码一致）：取最后一条非空 `assistant/message` 的 `message.content`；
  无候选时累积 `assistant/chunk` 中 `text-delta` 文本，非空返回 `[{ type:'text', text }]`；两者皆无返回 `undefined`。
- `declare module '@deepseek-ai/cordis'`：`Context { subagents: SubagentRuntime; agents: AgentRegistry }`。

### 2. workflow/src/shell.ts 接缝（SubprocessRuntime 等）

模块：`@deepseek-ai/dsh-sandore-workflow/src/shell`；纯类型声明，无运行时依赖。

- `CollectedOutput`：`{ text: string; truncated: boolean; spillPath?: string }`。
- `ShellExecRequest`（resolve 入参）：`{ command: string; workdir?: string; timeoutMs?: number; stdoutMaxBytes?: number; signal?: AbortSignal; stdin?: string; env?: Record<string,string> }`。
- `ShellExecSpec`（resolve 产物）：`{ command; workdir: string; timeoutMs: number; stdoutMaxBytes: number; signal?; stdin?; env? }`。
- `ShellRunResult`：`{ exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; timeoutMs: number; stdout: CollectedOutput; stderr: CollectedOutput }`。
- `ShellExecutor`（`ctx.shell`）：`{ resolve(request): ShellExecSpec; run(spec): Promise<ShellRunResult>; start(spec): unknown }`。
- **subprocess 接缝**（stdin/env 注入与原始 stdio）：
  - `SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }`。
  - `SubprocessCollect`：`{ maxBytes: number; spill?: { maxBytes: number } }`。
  - `SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect`。
  - `SubprocessStdio`：`{ stdin: SubprocessStdinMode; stdout: SubprocessOutputMode; stderr: SubprocessOutputMode }`（全显式）。
  - `SubprocessSpawnSpec`：`{ argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number; signal?: AbortSignal; env?: Record<string,string> }`。
  - `SubprocessOutcome`：`{ exitCode: number | null; signal: string | null }`。
  - `SubprocessOutputRead`：`{ text; nextOffset; lossy; spillPath? }`；`SubprocessOutputReader.readFrom(fromByte)`。
  - `SubprocessCollectedOutputs`：`{ stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader }`。
  - `SubprocessHandle`：`{ pid: number; collected: SubprocessCollectedOutputs; done: Promise<SubprocessOutcome>; terminate(): void; waitForExit(signal?): Promise<boolean> }`。
  - `SubprocessRuntime`（`ctx.subprocess`）：
    `{ resolveExecutable(command, env?, signal?): Promise<string>; spawn(spec: SubprocessSpawnSpec): SubprocessHandle }`。
- `declare module '@deepseek-ai/cordis'`：`Context { shell: ShellExecutor; subprocess: SubprocessRuntime }`。

---

## 四、step-runner.spec.ts 的测试范式与 mock 用法

文件：`D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.spec.ts`
框架：`vitest`（`describe` / `expect` / `it`），`Context` 来自 `@deepseek-ai/cordis`。

### 1. 测试组装范式

- 定义组装助手：`shellStep(command, timeout?)` / `promptStep({ providerId?, modelId? })` 返回 `WorkflowStep`；
  `request(step, overrides?)` 返回 `StepRunRequest`（默认 `workdir:'/tmp'`、`originalInput:'do the thing'`、`previousOutputs:[]`）。
- `harness(config: StepRunnerConfig = { defaultTimeoutMs: 60000 })`：
  ```ts
  const ctx = new Context();
  const llm = new FakeLlm(); const shell = new FakeShell();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  return { ctx, llm, shell, runner: new StepRunner(ctx, config) };
  ```
- 断言范式：
  - shell 成功：`await expect(runner.run(...)).resolves.toEqual({ output: [{ type:'text', text:'hello' }] })`；
  - 失败：`rejects.toMatchObject({ code: 'STEP_EXECUTION' })` / `rejects.toThrow(/boom/)`；
  - 超时：`rejects.toMatchObject({ code: 'STEP_TIMEOUT' })`；
  - prompt 回退：`expect(llm.calls[0]?.provider).toBe('a')` / `expect(llm.calls[0]?.model).toBe('a-model')`。

### 2. mock 桩（workflow/tests/mocks/）

- **FakeLlm**（llm.ts）：`providers: LlmProviderInfo[]`、`models = new Map<string, LlmModelInfo[]>()`、
  `calls: GenerateOptions[]`、`streamHandler: (options) => AsyncIterable<StreamChunk>`（默认 `textChunks('')`）。
  `listProviders()` 复制返回、`listModels(provider)` 复制返回、`stream(options)` 记录 `calls` 并委托 `streamHandler`。
  辅助 `textChunks(text, reason = { kind:'stop' })`：生成 `block-start` → `text-delta` → `block-end` → `finish` 四段流。
- **FakeShell**（shell.ts）：`requests: ShellExecRequest[]`、`specs: ShellExecSpec[]`、
  `resolveHandler` / `runHandler` 可注入；`resolve` 记录并委托，`run` 记录并委托，`start` 抛 not implemented。
  辅助 `successResult(spec, stdout='')` 生成 exitCode 0 结果；`defaultResolve` 补全 `workdir/timeoutMs/stdoutMaxBytes`（含 stdin/env 透传）。
- **FakeSubagents**（subagents.ts，implements `SubagentRuntime`）：记录 `continuableStarts`、`followups`、`interrupts`、`startCalls`；
  `startContinuable` 返回 `{ childId: 'child-<n>', messageId: 'msg-<n>' }`；`start` 返回空 `SubagentResult` 的 `SubagentRun`。
- **FakeAgent / FakeAgentRegistry / FakeSession**（agents.ts）：`FakeSession` 持有 `events: SessionEvent[]` 并 `append`；
  `assistantMessageEvent(content, seq, time)` 用 `createAssistantMessage`（dsh-llm）构造 `assistant/message`；
  `assistantChunkEvent(text, seq, time)` 构造 `assistant/chunk`（text-delta）；
  `FakeAgent implements Agent`（`whenIdle` 立即 resolve）；`FakeAgentRegistry implements AgentRegistry`（get/create/resume + register）。
- **FakeSubprocess / FakeSubprocessHandle**（subprocess.ts，implements `SubprocessRuntime`）：`successOutcome()` 生成 exitCode 0；
  `FakeSubprocessHandle`（`done` 由 `outcomeHandler` 决定，`terminate` 置 `terminated=true`，`waitForExit` 返回 true，`collected={}`）；
  `FakeSubprocess` 记录 `resolved`/`specs`，`resolveExecutable` 返回 `/usr/bin/<command>`，`spawn` 返回新句柄。
- 另有两个引擎集成测试用桩：**FakeSessionStore**（sessions.ts）、**MemoryStorageDomain**（storage-domain.ts）。

### 3. 相关既有 spec 范式

- `subagents.spec.ts`（microflow/src）：测试 `finalAssistantOutput` 的选取规则（空事件、最后非空消息、text-delta 累积、偏好后写、忽略空消息），
  以及 `ctx.provide('subagents'|'agents'|'subprocess', ...)` 注入后调用 `startContinuable` / `create/get/resume` / `resolveExecutable/spawn`。
- `workflow-engine.spec.ts`：集成测试范式，`recordSandoreEvents`（`ctx.on` 注册 `sandore/*`）、
  `waitForEnd`/`waitForAborted`/`waitForStepStart`（`ctx.once`）；对 `childId/sessionMeta` 的断言为
  `sessionMeta?.childId` 匹配 `/^step-step-abc-[0-9a-f]{8}$/`、`synthetic === true`、`command === 'shell'/'prompt'`。
  harness 中 `ctx.provide('subagents', {})`（空对象，因为线性执行不触发 subagents）。

---

## 五、CommandConfig 五类型在 schema.ts 的精确字段

文件：`D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`
`CommandConfigSchema = z.discriminatedUnion('type', [...])`，判别字段为顶层 `type`，变体字段整体嵌套于 `value`：

| type | value 字段 | 说明 |
|------|-----------|------|
| `agent` | `{ promptText: z.string(); agentParamsTemplate?: z.string(); providerId?: z.string(); modelId?: z.string() }` | promptText 存 Agent 名称；agentParamsTemplate 存参数模板；providerId/modelId 可选 |
| `prompt` | `{ promptText: z.string(); providerId?: z.string(); modelId?: z.string() }` | 纯提示词；providerId/modelId 可选 |
| `shell` | `{ command: z.string() }` | **仅 command 一个字段**；无 stdin/env 字段 |
| `skill` | `{ promptText: z.string(); providerId?: z.string() }` | promptText 存 Skill 名称；providerId 可选 |
| `mcp` | `{ promptText: z.string() }` | promptText 存 MCP 名称；仅此一个字段 |

派生类型：`CommandConfig = z.infer<typeof CommandConfigSchema>`。

**关键澄清（针对任务中「shell 的 stdin/env」）**：`CommandConfig` 的 shell 变体在 schema 层**没有** `stdin`/`env` 字段；
`stdin`/`env` 只存在于运行时接缝 `ShellExecRequest` / `ShellExecSpec`（workflow/src/shell.ts）与
`SubprocessSpawnSpec` 上。当前 `step-runner.ts` 的 `runShell` 也未向 `ShellExecRequest` 注入 stdin/env。

### 相关相邻 schema（改造直接关联）

- `WorkflowStepSchema` 字段：`id`、`name?`、`command?`、`inputFrom?`、`outputTo?`、`passThroughVars?`、
  `timeout?`、`next?`、`defaultExpectation?`、`condition?`、`branches?`、`loop?`、`rules?`、`gates?`。
  （`command` 为可选；`stages[].steps[]` 仅含 id + 流控字段，完整 command 定义在顶层 `steps[]`，
  二者按 id 交叉引用。）
- `StepSessionMetaSchema`：`{ childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']) }`。
- `ExecutedStepDefaultSchema` 额外含 `parentSessionId?: z.string()`、`output?: z.array(ContentBlockSchema)` 等字段。
- `WorkflowDefinitionSchema` 顶层：`skills/mcps/agents` 均为 `z.array(z.string()).default([])`；
  `settings` 为 `{ defaultTimeout (分钟, 默认120), maxConcurrentAgents (默认4) }`。
- `ContentBlockSchema = z.looseObject({ type: z.string() })`（存储域宽松形状，round-trip 对齐 DSH apiproxy）。

---

## 六、现状基线小结（仅供理解，不含方案）

1. `StepRunner.run()` 目前只分发 shell / prompt；agent / skill / mcp 落入 `default` 抛
   `unsupported step command type`（`STEP_EXECUTION`）。
2. agent/skill/mcp 的校验数据源（`workflowDef.skills/mcps/agents`）已在 schema 定义、由 YAML 解析、
   并经 `StageExecutorOptions.workflowDef` 传入，但 `StageExecutor.execute()` 尚未读取。
3. `ctx.subagents` / `ctx.agents` / `ctx.subprocess` 的接缝类型已就绪（subagents.ts / shell.ts），
   `finalAssistantOutput` 已实现；但引擎 `static inject` 未列入 `agents` 与 `subprocess`。
4. `sessionMeta.command` 枚举已含五类，`synthetic: true` 占位 + `parentSessionId` 字段已预留。
5. 测试范式：`vitest` + `Context.provide` 注入 `FakeLlm`/`FakeShell`/`FakeSubagents`/`FakeAgentRegistry`/`FakeSubprocess`，
   断言 `resolves/rejects.toMatchObject({ code })` / `toThrow(/.../)` / `llm.calls[0]` / `shell.specs[0]`。
