## Exploration Result

（`furina config show project.sourcecode codebases` 返回 `project.sourcecode=src/`（不存在）、`codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`。`docs/codebase` 目录为空，`furina.json` 中 `project.codebase.enable=false`，故 codebases 迭代无产出。全部结论来自下方 Supplementary Exploration 的直接源码核实。）

## Supplementary Exploration Result

### 一、需求理解（Phase 2）

- **What**：核实 DSH（DeepSeek Harness，本机源码位于 `D:/project-code/llm/deepseek-harness`）中 sandore 引擎将复用的五组公开扩展点的**真实类型形状**：`ctx.subagents`、`ctx.agents`、`Agent`、`finalAssistantOutput`、`ctx.subprocess`；并同步核实 sandore 现有 `microflow`/`workflow` 包中相关文件的现状。
- **Boundaries**：DSH 的 `packages/subagent/subagent`、`packages/core/agent`、`packages/core/session`、`packages/llm/llm`、`packages/subprocess/subprocess` 五个包；sandore 的 `packages/sandore/microflow` 与 `packages/sandore/workflow`。
- **Goal**：为 foundation-01 的实现提供可编码引用的精确类型基座，避免以设计文档的二次转述或记忆为准。
- **Project Context**：sandore 是 DSH 的能力插件 monorepo（`packages/sandore/*`），硬约束为「纯插件、零 DSH 源码修改、全用 DSH `ctx.*` 组件」。引擎的 `SandoreEngineStub.inject` 已声明依赖 `['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`（`workflow/src/seam.ts`），其中 `subagents`/`shell`/`sessions`/`llm` 即本次接缝核实对象。

---

### 二、DSH 源码真实类型形状

#### 2.1 `ctx.subagents`（`SubagentRuntime`）

声明：`packages/subagent/subagent/src/index.ts`（`declare module '@deepseek-ai/cordis' { interface Context { subagents: SubagentRuntime } }`）。

`startContinuable` 公开签名（`index.ts:212`，内部委托 `continuation.ts:403` 同签名）：

```ts
class SubagentRuntime extends Service {
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
}
```

`ContinuableStartSpec` / `ContinuableStart`（`packages/subagent/subagent/src/continuation.ts:112`、`:127`）：

```ts
export interface ContinuableStartSpec {
  /** 提供 continuable-creation 能力的 ctx.subagents provider 名。 */
  readonly provider: string
  /** 初始委托的短 description，持久化为子代理创建 label。 */
  readonly label: string
  /** 委托请求。管理器保留稳定 childId、解析持久描述符并自行组合子代理。 */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
  /** 调用方取消，仅持有到 inbox 接受初始提示为止。 */
  readonly signal: AbortSignal
}

export interface ContinuableStart {
  /** 持久子会话 id，跨激活稳定。 */
  readonly childId: SessionId
  /** 被接受初始提示的 inbox 消息 id。 */
  readonly messageId: MessageId
}
```

`SubagentStartRequest`（`packages/subagent/subagent/src/types.ts:100`）——`request` 字段去掉 `label`/`signal`/`outputSchema` 后**必填** `prompt` + `parent`，可选 `agentOptions`/`maxDepth`/`toolFilter`/`persona`：

```ts
export interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]        // 子代理的用户消息内容
  readonly parent: Agent                 // 派生 workspace/lineage/depth 的父代理
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: ObjectJsonSchema
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
}
```

`SubagentRuntime` 其余公开方法（同文件）：`followup(parent, childId, content: ContentBlock[], options): Promise<MessageId>`、`interrupt(targetSessionId, authority): void`、`reportFrom(child, content, options): Promise<MessageId>`、`registerContinuableSetup(contribution): () => void`、`drainContinuableDescendants(parents): Promise<void>`、`listChildren(parentSessionId, signal?): Promise<SubagentListEntry[]>`、`listDescendants(rootSessionId, signal?): Promise<SubagentDescendantListEntry[]>`、`registerProvider(provider): () => void`、`getProvider(name): SubagentProvider | undefined`、`list(): string[]`、`start(name, request): Promise<SubagentRun>`。

`SubagentResult`（`types.ts:219`）：`{ readonly output: ContentBlock[]; readonly structured?: unknown; readonly stopReason: SubagentStopReason }`；`SubagentStopReason` 已知值：`'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'`。

#### 2.2 `ctx.agents`（`AgentRegistry`）

声明：`packages/core/agent/src/index.ts`（`interface Context { agents: AgentRegistry; agent?: Agent }`）。

```ts
class AgentRegistry extends Service {
  async create(options: CreateAgentOptions): Promise<AgentHandle>
  async resume(options: ResumeAgentOptions): Promise<AgentHandle>
  get(id: SessionId): Agent | undefined
  // 另有：register / list / roots / isOwnedBy / currentInitiator / requireInitiator / withInitiator / withoutInitiator / setFactory
}
```

`AgentHandle`（`index.ts:172`）：

```ts
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>   // 停 loop、await 退出、注销 agent、移除 session、展开 scoped world
}
```

`CreateAgentOptions`（`index.ts:80`）：`{ readonly sessionId: SessionId; readonly meta?: { cwd?; parentSession?; seedLength?; origin?: 'subagent'; delegationDepth?; agentPreset? }; readonly seed?: readonly SessionEvent[]; readonly agentOptions?: AgentOptions; readonly signal?: AbortSignal; readonly setup?: AgentSetup }`。

`ResumeAgentOptions`（`index.ts:139`）：`{ readonly resumeSessionId: SessionId; readonly agentOptions?: AgentOptions; readonly signal?: AbortSignal; readonly setup?: AgentSetup }`。

> 注意：`create` 必填 `sessionId`（由调用方提供 live id），`resume` 必填 `resumeSessionId`（从持久化 session 加载）。`create`/`resume` 均经注册的 `AgentFactory`（`dsh-agent-loop` 提供）转发；factory 未注册时抛 `'no agent factory registered (load an agent-loop plugin)'`。

#### 2.3 `Agent`（`packages/core/agent/src/runtime-types.ts:64`）

```ts
export interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions            // { provider?: string; model?: string; maxTokens?: number }
  readonly session: Session
  readonly inbox: Inbox
  readonly status: AgentStatus              // 'idle' | 'running'（无 paused 态）
  readonly ctx: Context
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>                 // 当前整体活动到达 quiescence 后 resolve
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}

export type AgentStatus = 'idle' | 'running'
```

- `agent.status` 语义：`idle` 无驱动活动；`running` 自唤醒输入开始、直至 drain/关闭/checkpoint 完成。**没有 `paused`/`interacting` 状态**（与 `docs/engine/dsh-workflow.md` §5.5 记录一致）。
- `agent.session.events`（`packages/core/session/src/index.ts:559`）：`get events(): readonly SessionEvent[]` —— 深冻结快照；`Session` 另有 `id`、`header`、`surface`、`firstLiveSeq`、`seq` 访问器。
- `SessionEvent`（`packages/core/session/src/types.ts:404`）为 `type` 判别的联合：`{ type: K; seq: number; time: number; data: SessionEventMap[K]; ignorable?: true; sourceEventSeqs?: number[]; surfaceOp?: SurfaceOp }`。关键事件载荷：`'assistant/message': { turn; step; message: AssistantMessage; usage? }`、`'assistant/chunk': { turn; step; chunk: StreamChunk }`、`'user/message': UserMessage`、`'tool/result': { turn; step; message: ToolResultMessage; error?; meta? }`。

#### 2.4 `finalAssistantOutput`（`packages/subagent/subagent/src/assistant-output.ts:66`）

```ts
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined
```

选取规则（源码文档 + `AssistantOutputFold` 实现，与 stop reason 无关）：
1. 取**最后一条非空 `assistant/message`** 的 `message.content`（`content.length > 0` 才覆盖候选）。空内容消息仅记 usage，不覆盖更早输出。
2. 若无任何非空 assistant message，则回退为**累积的 `assistant/chunk` 中 `text-delta` 文本**（`pushText` 拼接），非空时返回 `[{ type: 'text', text }]`。
3. 两者皆无则返回 `undefined`。

`AssistantOutputFold`（同类文件）：`push(event)`（识别 `assistant/message` 与 `assistant/chunk` 的 `text-delta`）、`pushText(text)`（`text.length > 0` 才累积）、`collect()`。`SubagentResult.output`、`subagent/end.lastAssistantMessage` 与 in-process-driver 均复用此规则。

#### 2.5 `ctx.subprocess`（`SubprocessRuntime`）

声明：`packages/subprocess/subprocess/src/index.ts`（`interface Context { subprocess: SubprocessRuntime }`）；类型在 `packages/subprocess/subprocess/src/types.ts`。

```ts
abstract class SubprocessRuntime extends Service {
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}
```

`SubprocessSpawnSpec`（`types.ts:75`）——**无默认值、全显式**：

```ts
export interface SubprocessSpawnSpec {
  argv: readonly string[]                    // argv[0] 为程序
  cwd: string
  stdio: SubprocessStdio                     // { stdin: SubprocessStdinMode; stdout: SubprocessOutputMode; stderr: SubprocessOutputMode }
  graceMs: number                            // terminate 升级 SIGTERM→grace→SIGKILL
  signal?: AbortSignal | undefined
  env?: NodeJS.ProcessEnv | undefined
}
```

- `SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }`；`SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect`（`SubprocessCollect = { maxBytes: number; spill?: { maxBytes: number } }`）。
- `SubprocessHandle`（`types.ts:167`）：`{ readonly pid: number; readonly stdin?: Writable; readonly stdout?: Readable; readonly stderr?: Readable; readonly collected: SubprocessCollectedOutputs; readonly done: Promise<SubprocessOutcome>; terminate(): void; waitForExit(signal?: AbortSignal): Promise<boolean> }`；`SubprocessOutcome = { exitCode: number | null; signal: NodeJS.Signals | null }`。

#### 2.6 相关基础类型（`dsh-llm` / `dsh-session`）

- `HarnessError`（`packages/llm/llm/src/error.ts:13`）：`class HarnessError extends Error { readonly code: string; constructor(message: string, code: string, options?: ErrorOptions) }`。
- `ContentBlock`（`packages/llm/llm/src/types.ts:110`）：`ContentBlockMap` 的联合（`'text'` → `{ type: 'text'; text: string }`、`'reasoning'`、`'image'`、`'tool-call'`、`'tool-result'`）。
- `MessageId = Branded<'MessageId'>`（`packages/llm/llm/src/brand.ts:16`）；`SessionId = Branded<'SessionId'>`（`packages/core/session/src/types.ts:22`）。
- `UserMessage`/`AssistantMessage`（`packages/llm/llm/src/message.ts:141/146`）均 `extends Message { id; role; content: ContentBlock[]; source: MessageSource }`。

---

### 三、sandore 现有文件现状

#### 3.1 `microflow/src/errors.ts`

- `SandoreErrorCode`（type union）：`'YAML_PARSE' | 'DEFINITION_INVALID' | 'NODE_NOT_FOUND' | 'CYCLE_DETECTED' | 'STEP_TIMEOUT' | 'STEP_EXECUTION' | 'INVALID_OPERATION' | 'CANCELLED' | 'PERSISTENCE_FAILED'`（`PERSISTENCE_FAILED` 注释标注 non-fatal）。
- `class SandoreError extends HarnessError`，新增 `readonly fatal: boolean`，构造 `(message, code, options?: ErrorOptions & { fatal?: boolean })`，`fatal` 默认 `true`。
- `isFatalSandoreError(error: unknown): boolean`（`instanceof SandoreError && error.fatal`）。
- 依赖方向：workflow → microflow；`workflow/src/errors.ts` 仅 re-export（`export { SandoreError, isFatalSandoreError } from '../../microflow/src/errors.ts'` + `export type { SandoreErrorCode }`），保持 workflow 对外 API 不变。

#### 3.2 `workflow/src/schema.ts`（`FinalizeMetaSchema` 等）

`FinalizeMetaSchema`（`:192`）：

```ts
export const FinalizeMetaSchema = z.object({
  status: z.enum(['evaluating', 'completed', 'ask']),
  sessionId: z.string().optional(),
  gateSessionId: z.string().optional(),
  directory: z.string().optional(),
  errorDetail: z.string().optional(),
})
```

相关：`StepSessionMetaSchema = { childId: z.string(); synthetic: z.boolean(); command: z.enum(['shell','prompt','agent','skill','mcp']) }`；`BranchMetaSchema = { result?; sessionId?; directory?; status: z.enum(['evaluating','completed']); expectation? }`。存储域 `sandoreDomainSpec` 三表：`definitions`（`WorkflowDefinitionRecord`）、`jobs`（`JobRecord`）、`state`（`WorkflowTaskState`）。派生类型以 `z.infer` 导出（`FinalizeMeta`、`CommandConfig` 等）。

#### 3.3 `workflow/src/types.ts`

仅含类型（无运行时）：re-export schema 派生类型（`CommandConfig`/`FinalizeMeta`/`InputFromItem`/`OutputToItem`/`PassThroughVar`/`RetryRecord`/`SessionMessage`/`StepSessionMeta`/`BranchMeta`），并定义 `DagRunInfo`、`DagStartRequest`、`DagRun`、`DagRunStatus`、`DagInstanceState`、`ExecutedStepDefault`、`StageInfo`、`StepStatus`、`StageContract`、`PendingQuestion`、`PendingPermission`、`AskUserQuestionPayload`、`DagResultInfo`。`ExecutedStepDefault.output?: ContentBlock[]`（import `ContentBlock` from `@deepseek-ai/dsh-llm`）。

#### 3.4 `workflow/src/shell.ts`

本地结构类型声明的 `ctx.shell` 接缝（注释明确 `@deepseek-ai/dsh-shell` 未作为运行时依赖，本文件按 DSH 公开 API 复刻最小结构）：
- `CollectedOutput { text; truncated; spillPath? }`
- `ShellExecRequest { command; workdir?; timeoutMs?; stdoutMaxBytes?; signal?; stdin?; env? }`
- `ShellExecSpec`（`resolve` 补全后：`command/workdir/timeoutMs/stdoutMaxBytes` 必填）
- `ShellRunResult { exitCode; signal; timedOut; aborted; timeoutMs; stdout: CollectedOutput; stderr: CollectedOutput }`
- `interface ShellExecutor { resolve(request): ShellExecSpec; run(spec): Promise<ShellRunResult>; start(spec): unknown }`，并 `declare module '@deepseek-ai/cordis' { interface Context { shell: ShellExecutor } }`。

#### 3.5 两个 `package.json`

- `workflow/package.json`：`@deepseek-ai/dsh-sandore-workflow@0.1.0-rc.6`；dependencies `yaml@^2.9.0`、`zod@^4.4.3`；peerDependencies：`@deepseek-ai/cordis@4.0.1`、`dsh-sandore-microflow: workspace:*`、`dsh-session`/`dsh-llm`/`dsh-typert-protocol`/`dsh-agent`/`dsh-storage`/`dsh-storage-domain` 均 `0.1.0-rc.6`、`schemastery@3.18.1`（devDependencies 同集合，microflow 用 workspace:*）。
- `microflow/package.json`：`@deepseek-ai/dsh-sandore-microflow@0.1.0-rc.6`；仅 peerDependencies `cordis@4.0.1` + `dsh-llm@0.1.0-rc.6`。

#### 3.6 `workflow/tests/mocks/`

- `llm.ts`：`textChunks(text, reason?)` 生成固定 `StreamChunk` 流（`block-start`/`text-delta`/`block-end`/`finish`）；`class FakeLlm` 提供 `listProviders`/`listModels`/`stream(options: GenerateOptions)`（记录调用 + 可注入 `streamHandler`）。
- `sessions.ts`：`class FakeSession { events: Array<{ type; data }>; append(type, data) }`；`class FakeSessionStore { create(id?); get(id); list() }`。
- `shell.ts`：`successResult(spec, stdout?)`；`class FakeShell { resolve(request); run(spec); start(spec) }`，含 `defaultResolve`（补全 `workdir='/tmp'`、`timeoutMs=60000`、`stdoutMaxBytes=1MB`）。
- `storage-domain.ts`：`MemoryKvTable<K,V>`（实现 `KvTable`，`update` 缺 key 抛 `DomainError('missing-key')`）、`MemoryDomain`、`MemoryStorageDomain`（`open(spec)`/`get(name)`，`DomainFacility` 形状）。

---

### 四、关键接缝结论（核实结果摘要）

1. 可续接子代理用 `ctx.subagents.startContinuable({ provider, label, request, signal })`，返回 `{ childId, messageId }`；`request` 只需 `prompt`（`ContentBlock[]`）+ `parent`（`Agent`）。
2. 冷恢复用 `ctx.agents.resume({ resumeSessionId })` 返回 `AgentHandle { agent, dispose() }`；`ctx.agents.get(id)` 返回裸 `Agent`。
3. `Agent` 仅两态 `idle`/`running`，无 `paused`；`agent.whenIdle()` 为 quiescence 信号，`agent.session.events` 为深冻结 `readonly SessionEvent[]`。
4. `finalAssistantOutput(events)` = 最后一条非空 `assistant/message.content`，否则累积 `text-delta`，否则 `undefined`。
5. `ctx.subprocess.spawn(spec)` 需要显式 `argv/cwd/stdio/graceMs`，`resolveExecutable(command, env?, signal?)` 返回规范路径。
6. sandore 现有 `microflow/src/errors.ts` 的 `SandoreError extends HarnessError`（`code` + `fatal`）是引擎错误基座；`FinalizeMetaSchema` 已含 `status: 'evaluating'|'completed'|'ask'` + 可选 `sessionId`/`gateSessionId`/`directory`/`errorDetail`。
