## Exploration Result

> 探索范围：`packages/sandore/microflow` 与 `packages/sandore/workflow` 两个包的源码与测试。
> 全部结论均来自实际代码（无 fabricate）。以下按 exploreContent 的 5 点逐项核实。

### (1) `microflow/src/step-runner.ts` 完整现状（改造基线）

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/step-runner.ts`

- **依赖**：仅 `import type` 来自 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`，并 `import type` `CommandConfig, WorkflowStep`（`../../workflow/src/schema.ts`）与 `ShellExecRequest, ShellRunResult`（`../../workflow/src/shell.ts`）。运行时值只 import `BlockAssembler, createUserMessage`（dsh-llm）与 `SandoreError`（`./errors.ts`）。
- **局部类型别名**：`type ShellCommand = Extract<CommandConfig, { type: 'shell' }>`；`type PromptCommand = Extract<CommandConfig, { type: 'prompt' }>`（当前只有这两个别名，无 agent/skill/mcp 别名）。
- **`StepRunnerConfig`**（L2 回退来源）：
  - `defaultTimeoutMs: number`（必填）
  - `defaultProvider?: string`
  - `defaultModel?: string`
- **`PreviousStepOutput`**：`{ name: string; id: string; returnPrompt: string; files: string[] }`（全部 `readonly`）。
- **`StepRunRequest`**：`{ step: WorkflowStep; workdir: string; originalInput: string; previousOutputs: readonly PreviousStepOutput[]; signal?: AbortSignal }`。
- **`StepRunResult`**：`{ output: ContentBlock[] }`。
- **`StepRunner` 构造**：`constructor(private readonly ctx: Context, private readonly config: StepRunnerConfig)`（绑定 ctx 与引擎级 config）。
- **`run()` 分发**：
  ```
  async run(request: StepRunRequest): Promise<StepRunResult>
  ```
  1. `request.step.command === undefined` → 抛 `SandoreError("step '{id}' has no command", 'STEP_EXECUTION')`。
  2. `switch (command.type)`：
     - `'shell'` → `this.runShell(command, request)`
     - `'prompt'` → `this.runPrompt(command, request)`
     - `default`（含 `'agent'|'skill'|'mcp'`）→ 抛 `SandoreError("unsupported step command type '{type}'", 'STEP_EXECUTION')`。
- **shell 分支 `ctx.shell` 调用**（`runShell`）：
  1. 组装 `ShellExecRequest`：`{ command: command.value.command, timeoutMs: this.stepTimeoutMs(request.step), ...(workdir 存在才带 workdir), ...(signal 存在才带 signal) }`。注意：**当前未传 `stdin`/`env`**（虽然 `ShellExecRequest` 类型上可选）。
  2. `const spec = this.ctx.shell.resolve(shellRequest)` → `const result = await this.ctx.shell.run(spec)`。
  3. `toShellResult(result)`：`exitCode === 0 && !timedOut && !aborted` → `{ output: [{ type: 'text', text: result.stdout.text }] }`；`timedOut` → 抛 `STEP_TIMEOUT`（stderr 摘要）；`aborted`/非零退出 → 抛 `STEP_EXECUTION`（stderr 摘要）。
- **`stepTimeoutMs`**：`step.timeout === undefined ? config.defaultTimeoutMs : step.timeout * 60_000`（Step 级 timeout 单位是分钟）。
- **prompt 分支 `runPrompt`**：
  1. `const route = await this.resolveProviderModel(command)`。
  2. `buildPromptText(request.step, command, request.originalInput, request.previousOutputs)` 生成 prompt。
  3. `createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: promptText }] })`。
  4. `GenerateOptions = { provider: route.provider, model: route.model, messages: [message], ...(signal 可选) }`。
  5. `new BlockAssembler()` → `for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)` → `assembler.blocks()` 得输出，`assembler.finish` 判终态。
  6. `finish.kind === 'error'` → 抛 `STEP_EXECUTION`（`finish.failure.message`）；`finish.kind === 'aborted'` → 抛 `STEP_EXECUTION`（同样 message）。成功返回 `{ output }`。
- **`buildPromptText`**（模块级函数，签名 `(step, command: PromptCommand, originalInput, previousOutputs)`）：
  - 主头部 `PROMPT_MAIN_HEADER` 常量（"你是严谨准确的Step执行Agent…"）+ `## 你的任务`（`command.value.promptText`）+ `## 参考信息`（`### 用户原始需求` + originalInput）+ 可选 `## 前置Steps输出与产物`（每个 previous 输出 `### 前置Step: {name} ({id})` + `<{id}>` 内嵌 `<output>`（returnPrompt 按行缩进）与 `<artifacts>`（files 列表）+ `</{id}>`）。
  - 注意：形参 `step` 目前仅传未在函数体内使用（prompt 文本只用到 command/originalInput/previousOutputs）。
- **`resolveProviderModel`**（`private async`，返回 `{ provider: string; model: string }`）三层回退：
  - L1：`command.value.providerId` 与 `modelId` **成对**提供才用。
  - L2：`config.defaultProvider` 与 `config.defaultModel` **成对**配置才用。
  - L3：`this.llm().listProviders()[0]`（同步）→ 取 `provider.id`；再 `await this.llm().listModels(provider.id)` → `models[0]` → `model.id`；无 provider 抛 `'no LLM provider available'`，无 model 抛 `'no LLM model available for provider ...'`（均为 `STEP_EXECUTION`），并 `ctx.logger.warn` 兜底提示。
- **`llm()`**：`private llm(): LlmRuntime { return this.ctx.llm; }`（依赖 `ctx.llm` 目录）。

### (2) `microflow/src/stage-executor.ts` 如何构造 StepRunner 与传参

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/stage-executor.ts`

- **StepRunner 构造**：`StageExecutor` 构造器内 `this.runner = new StepRunner(options.ctx, options.runnerConfig)`（`runnerConfig: StepRunnerConfig` 由 `StageExecutorOptions` 传入）。
- **`StageExecutorOptions`**：`{ ctx, stageDef: WorkflowStage, workflowDef: WorkflowDefinition, input: StageExecutionInput, sharedState: StageSharedState, runnerConfig: StepRunnerConfig, signal?, hooks?, onPersist? }`。
  - **关键**：`workflowDef: WorkflowDefinition` 字段已声明（line 58），但 `execute()` 只解构 `{ stageDef, input, sharedState, signal, hooks }`，**`workflowDef` 当前未被消费**（`workflowDef.skills/mcps/agents` 没有进入任何校验/执行路径）。
- **`workflow.skills/mcps/agents` 数组来源**：
  - schema 定义层 `WorkflowDefinitionSchema`（`workflow/src/schema.ts` lines 172-174）：`skills/mcps/agents` 均为 `z.array(z.string()).default([])`。
  - 数据从 YAML 解析进入（`parseWorkflowYaml` → `WorkflowDefinitionSchema.parse`），Zod 仅校验"字符串数组"形状；`yaml-parser.ts` 的 `validateReferences` **只校验 `next`/`branches`/`loop`/`inputFrom.path` 的节点 ID 引用完整性，不校验 skills/mcps/agents 与 step 命令名称的成员关系**（即 agent/skill/mcp 的 promptText "必须在对应数组中"目前只是 `yaml-parser.spec.ts` lines 211/234/243 的注释意图，无实际校验）。
  - 引擎侧 `workflow-engine.ts` 将 `workflowDef: definition` 整体传给 `StageExecutor`，但如上所述 StageExecutor 不使用它 → **agent/skill/mcp 校验的数据来源（workflowDef.skills/mcps/agents + command 五类型）目前停留在 schema 与 workflowDef 传递链上，尚未被消费**。
- **`previousOutputs` 构建**：
  - `execute()` 开头 `const previousOutputs: PreviousStepOutput[] = []`。
  - 每个 Step 成功后 `previousOutputs.push(toPreviousOutput(executed))`。
  - `toPreviousOutput(step: ExecutedStepDefault)` 返回 `{ name: step.name, id: step.stepId ?? step.id, returnPrompt: textSummary(step.output), files: [] }`（`textSummary` 来自 `./internal.ts`，仅按序拼接 text 块；`files` 恒为空数组）。
  - 传入 runner：`this.runner.run({ step, workdir: sharedState.cwd, originalInput: input.originalInput, previousOutputs, ...(signal 可选) })`。
- **`StepRunResult` 被消费**：
  - `const result = await this.runner.run(...)`；
  - `executed.status = 'completed'; executed.output = result.output`；
  - `previousOutputs.push(toPreviousOutput(executed))`；
  - `hooks?.onStepCompleted(step, childId, result.output)`；
  - `await this.options.onPersist?.(executed)`。
- **`sessionMeta` 回传路径**：
  - `execute()` 内为每个 Step 合成 `childId = synthesizeChildId(step.id)`（`step-{stepId}-{execId 前 8 位}`，`crypto.randomUUID().replace(/-/g,'').slice(0,8)`）。
  - `executed.sessionMeta = { childId, synthetic: true, command: command.type }`（line 180-182，`command.type` 可取值 `'shell'|'prompt'|'agent'|'skill'|'mcp'`）。
  - 该 `executed`（`ExecutedStepDefault`）经 `onPersist` 钩子回传引擎：`workflow-engine.ts` 的 `onPersist` 回调把 `executed` append 到 `active.state.executedSteps` 并 `persistState` → 持久化。
  - 对应 schema：`StepSessionMetaSchema = { childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']) }`（`schema.ts` lines 185-189）。
- **`ExecutedStepDefault` 组装**（`execute()` 内）：`{ type: 'default', id: childId, stepId: step.id, stageId: stageDef.id, name: step.name ?? step.id, status: 'running', command?/inputFrom?/outputTo?/passThroughVars? 按存在复制, sessionMeta?（command 存在时）, visitCount: 1 }`；无 command 的 step 直接置 `failed` + `error`。
- **失败语义**：runner 抛错 → catch 内 `describeError(error)` 写入 `executed.error`，`status='failed'`，`errorDetail=message`，`break` 中止后续 Step。
- **`StageExecutionResult`**：`{ stageContract, executedSteps, passThroughVars, status, errorDetail? }`。引擎侧 `workflow-engine.ts` 消费 `result.passThroughVars`（合并到 state）与 `result.stageContract`（写入 `stageContracts`，交给 `navigator.setStageContract`），并依据 `result.status === 'failed'` 决定 aborted/failed 终态。

### (3) `subagents.ts` 接缝导出形状 与 `shell.ts` SubprocessRuntime 接缝形状

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/subagents.ts`

- **模块级导出（类型/函数）**：
  - `type SessionId = string`；`type MessageId = string`。
  - `AgentOptions { provider?; model?; maxTokens? }`；`AgentStatus = 'idle' | 'running'`。
  - `Session { readonly events: readonly SessionEvent[] }`。
  - **`Agent`**（结构类型）：`{ readonly id: SessionId; readonly options: AgentOptions; readonly session: Session; readonly status: AgentStatus; whenIdle(): Promise<void> }`。
  - `AgentHandle { agent: Agent; dispose(): Promise<void> }`。
  - `CreateAgentOptions { sessionId: SessionId; agentOptions?; signal? }`；`ResumeAgentOptions { resumeSessionId: SessionId; agentOptions?; signal? }`。
  - `AgentRegistry { get(id): Agent | undefined; create(options): Promise<AgentHandle>; resume(options): Promise<AgentHandle> }`。
  - `ToolRestriction { allow?: readonly string[]; deny?: readonly string[] }`。
  - `ContinuableStartRequest { prompt: ContentBlock[]; parent: Agent; agentOptions?; maxDepth?; toolFilter?: ToolRestriction; persona? }`。
  - **`ContinuableStartSpec`**：`{ provider: string; label: string; request: ContinuableStartRequest; signal: AbortSignal }`。
  - **`ContinuableStart`**：`{ childId: SessionId; messageId: MessageId }`。
  - `SubagentFollowupOptions { source: MessageSource; signal: AbortSignal }`。
  - `SubagentInterruptAuthority = { kind: 'user'; parentSessionId: SessionId } | { kind: 'ancestor'; agent: Agent }`。
  - `SubagentStartRequest { label?; prompt; parent: Agent; signal; agentOptions?; maxDepth?; toolFilter?; persona? }`；`SubagentRun { id; localAgent?; result: Promise<SubagentResult>; dispose() }`；`SubagentResult { output: ContentBlock[]; structured?; stopReason }`；`SubagentStopReason = 'completed'|'aborted'|'error'|'max-tokens'|'refusal'`。
  - **`SubagentRuntime`**：`{ startContinuable(spec): Promise<ContinuableStart>; followup(parent, childId, content, options): Promise<MessageId>; interrupt(targetSessionId, authority): void; start(name, request): Promise<SubagentRun> }`。
  - `AssistantMessageData { turn; step; message: AssistantMessage; usage? }`；`AssistantChunkData { turn; step; chunk: StreamChunk }`。
  - **`SessionEvent`**（判别联合）：`{ type: 'assistant/message'; seq; time; data: AssistantMessageData } | { type: 'assistant/chunk'; seq; time; data: AssistantChunkData }`。
  - **`finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined`**：先取最后一条非空 `assistant/message` 的 `message.content`；无候选则累积 `assistant/chunk` 的 `text-delta` 文本返回 `[{ type: 'text', text }]`；都无返回 `undefined`。
  - **模块增强**：`declare module '@deepseek-ai/cordis' { interface Context { subagents: SubagentRuntime; agents: AgentRegistry } }`。

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/shell.ts`

- **`ShellExecutor`**（`ctx.shell`）：`{ resolve(request: ShellExecRequest): ShellExecSpec; run(spec: ShellExecSpec): Promise<ShellRunResult>; start(spec: ShellExecSpec): unknown }`；`declare module cordis { interface Context { shell: ShellExecutor; subprocess: SubprocessRuntime } }`。
- **`ShellExecRequest`**：`{ command: string; workdir?; timeoutMs?; stdoutMaxBytes?; signal?: AbortSignal; stdin?: string; env?: Record<string,string> }`。
- **`ShellExecSpec`**：`{ command; workdir: string; timeoutMs: number; stdoutMaxBytes: number; signal?; stdin?; env? }`（resolve 补全必填）。
- **`ShellRunResult`**：`{ exitCode: number|null; signal: string|null; timedOut: boolean; aborted: boolean; timeoutMs: number; stdout: CollectedOutput; stderr: CollectedOutput }`；`CollectedOutput { text: string; truncated: boolean; spillPath?: string }`。
- **`SubprocessRuntime`**（`ctx.subprocess`）接缝：
  - `{ resolveExecutable(command, env?, signal?): Promise<string>; spawn(spec: SubprocessSpawnSpec): SubprocessHandle }`。
  - `SubprocessSpawnSpec { argv: readonly string[]; cwd: string; stdio: SubprocessStdio; graceMs: number; signal?; env?: Record<string,string> }`。
  - `SubprocessStdio { stdin: SubprocessStdinMode; stdout: SubprocessOutputMode; stderr: SubprocessOutputMode }`；`SubprocessStdinMode = 'ignore' | 'pipe' | { data: string }`；`SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect`；`SubprocessCollect { maxBytes: number; spill?: { maxBytes: number } }`。
  - `SubprocessHandle { readonly pid; readonly collected: SubprocessCollectedOutputs; readonly done: Promise<SubprocessOutcome>; terminate(): void; waitForExit(signal?): Promise<boolean> }`；`SubprocessOutcome { exitCode: number|null; signal: string|null }`；`SubprocessCollectedOutputs { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader }`；`SubprocessOutputReader { readFrom(fromByte): SubprocessOutputRead }`；`SubprocessOutputRead { text; nextOffset; lossy; spillPath? }`。

### (4) `step-runner.spec.ts` 测试范式与 mock 用法

文件：`D:/project-code/llm/sandore/packages/sandore/microflow/src/step-runner.spec.ts`

- **测试框架**：`vitest`（`describe/expect/it`）；`Context`（cordis）+ `ctx.provide(key, value)` 注入 mock。
- **测试桩来源**（均位于 `workflow/tests/mocks/`）：
  - `FakeLlm`（`mocks/llm.ts`）：`providers: LlmProviderInfo[]`、`models: Map<string, LlmModelInfo[]>`、`calls: GenerateOptions[]`（`stream` 每次 push）、`streamHandler` 可注入 `AsyncIterable<StreamChunk>`；实现 `listProviders()/listModels(provider)/stream(options)`。另有 `textChunks(text, reason?)` 生成固定 chunk 流（`block-start`→`text-delta`→`block-end`→`finish`）。
  - `FakeShell`（`mocks/shell.ts`）：`requests: ShellExecRequest[]`、`specs: ShellExecSpec[]`、`resolveHandler`、`runHandler`；实现 `resolve/run/start`；`successResult(spec, stdout?)` 生成 exitCode 0 结果；`defaultResolve` 补全 workdir/timeoutMs/stdoutMaxBytes（默认 `/tmp`/60000/1MiB）。
  - `FakeSubagents`（`mocks/subagents.ts`）：实现 `SubagentRuntime`，`startContinuable` 返回 `{ childId: 'child-{n}', messageId: 'msg-{n}' }`，记录 `continuableStarts/followups/interrupts/startCalls`。
  - `FakeAgent`/`FakeAgentRegistry` + `assistantMessageEvent/assistantChunkEvent`（`mocks/agents.ts`）：`FakeAgent implements Agent`（`whenIdle` 立即 resolve，`session.events` 用 `FakeSession`），`FakeAgentRegistry implements AgentRegistry`（get/create/resume/register）。
  - `FakeSubprocess`/`FakeSubprocessHandle`（`mocks/subprocess.ts`）：实现 `SubprocessRuntime`，`resolveExecutable` 返回 `/usr/bin/{command}`，`spawn` 返回内存句柄。
- **harness 范式**（step-runner.spec）：
  ```
  const ctx = new Context(); const llm = new FakeLlm(); const shell = new FakeShell();
  ctx.provide('llm', llm as unknown as LlmRuntime); ctx.provide('shell', shell);
  return { ctx, llm, shell, runner: new StepRunner(ctx, config) };
  ```
- **定义/请求构建辅助**：`shellStep(command, timeout?)` / `promptStep({providerId?, modelId?})` 组装 `WorkflowStep`；`request(step, overrides?)` 组装 `StepRunRequest`（默认 `workdir: '/tmp', originalInput: 'do the thing', previousOutputs: []`）。
- **覆盖用例**：
  - shell：exitCode 0 包装 stdout.text 为 text ContentBlock；非零退出抛 `STEP_EXECUTION` 且 message 含 stderr；`timedOut` → `STEP_TIMEOUT`；Step `timeout`（分钟）→ timeoutMs（`shell.specs[0]?.timeoutMs === 60`，0.001 分钟 = 60ms）；`aborted` → `STEP_EXECUTION`。
  - prompt：成功聚合为 `[{ type: 'text', text: 'summary' }]`；finish error → `STEP_EXECUTION`（message 含 `failure.message`）；目录空 → `no LLM provider available`；Step 定义 providerId 优先（`llm.calls[0]?.provider/model`）；缺省回退 config provider/model。
- **subagents.spec.ts 补充范式**（`microflow/src/subagents.spec.ts`）：用 `ctx.provide('subagents'|'agents'|'subprocess', ...)` 注入三套桩并断言；`finalAssistantOutput` 的空事件/最后一条非空 message/chunk 累积/后写覆盖/忽略空 message 等用例。

### (5) `CommandConfig` 五类型在 `schema.ts` 的精确字段

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`

- `CommandConfigSchema = z.discriminatedUnion('type', [...])`（判别字段顶层 `type`，变体字段整体嵌套于 `value`）：
  1. **`agent`**：`value: { promptText: z.string(); agentParamsTemplate: z.string().optional(); providerId: z.string().optional(); modelId: z.string().optional() }`。
  2. **`prompt`**：`value: { promptText: z.string(); providerId: z.string().optional(); modelId: z.string().optional() }`。
  3. **`shell`**：`value: { command: z.string() }`。**注意：schema 的 shell 类型没有 `stdin`/`env` 字段**（`stdin`/`env` 仅存在于 `shell.ts` 接缝的 `ShellExecRequest`/`ShellExecSpec` 可选字段，以及 `SubprocessSpawnSpec.env`、`SubprocessStdio.stdin`）。当前 `StepRunner.runShell` 组装请求时也未传 `stdin`/`env`。
  4. **`skill`**：`value: { promptText: z.string(); providerId: z.string().optional() }`。
  5. **`mcp`**：`value: { promptText: z.string() }`。
- 派生类型：`export type CommandConfig = z.infer<typeof CommandConfigSchema>`。
- 相关字段（供 agent/skill/mcp 校验上下文）：
  - `WorkflowStepSchema`：`command: CommandConfigSchema.optional()`；`inputFrom/outputTo/passThroughVars/timeout/next/condition/branches/loop/rules/gates` 均 optional。
  - `WorkflowDefinitionSchema`：`skills/mcps/agents = z.array(z.string()).default([])`（工作流级名称数组）。
  - `StepSessionMetaSchema`：`{ childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']) }`。
  - `ContentBlockSchema = z.looseObject({ type: z.string() })`（仅约束 type 为 string，保留其余字段做 round-trip）。

### 关键交叉结论（服务于 agent/skill/mcp 改造基线的数据事实）

- **当前执行分发只覆盖 shell/prompt**：`StepRunner.run()` 的 `default` 分支对 `agent/skill/mcp` 抛 `STEP_EXECUTION('unsupported step command type ...')`，无任何 agent/skill/mcp 执行分支。
- **数据已就绪但未接通**：
  - `CommandConfig` 五类型 schema 已完整定义（含 agent/skill/mcp 的字段）。
  - `workflowDef.skills/mcps/agents` 数组已从 YAML 解析进 `WorkflowDefinition` 并传递到 `StageExecutorOptions.workflowDef`，但 `StageExecutor.execute()` 未解构/未使用，StepRunner 也不接收该数组 → **agent/skill/mcp 的"名称必须在数组中"校验目前无实现**（`yaml-parser.validateReferences` 不覆盖 skills/mcps/agents 成员关系）。
  - 引擎 `SandoreEngineRuntime.inject` 仅 `['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`（`seam.ts`/`workflow-engine.ts`），**未注入 `agents`、`subprocess`**（`ctx.agents`/`ctx.subprocess` 虽在接缝类型中已声明、mock 已备齐，但宿主/引擎尚未把它们接入运行路径）。
- **sessionMeta 回传已通**：`StageExecutor` 在构造 `ExecutedStepDefault` 时写入 `sessionMeta = { childId, synthetic: true, command: command.type }`，经 `onPersist` 回调逐 Step 持久化到 `state.executedSteps`（`workflow-engine.ts` 的 `onPersist` 闭包）。

## Supplementary Exploration Result

无需补充探索：reference materials 配置（`exploration.reference`）为空，且 exploreContent 全部指向本地代码（`microflow`/`workflow` 两个包的源码与 spec），本地代码已完整覆盖 5 个核实点，Phase 3 结果充分，故未触发 websearch/context7 补充。
