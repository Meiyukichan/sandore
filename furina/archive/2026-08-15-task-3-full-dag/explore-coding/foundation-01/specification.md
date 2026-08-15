# Foundation-01 结构接缝与类型基座核实

> 本文件为 foundation-01 实现的结构接缝与类型基座的精确依据，全部结论来自对 DSH 源码
> （`D:\project-code\llm\deepseek-harness`）与 sandore 项目（`D:\project-code\llm\sandore`）
> 的实读核实。DSH 编译产物位于 sandore 的 `node_modules/.pnpm/@deepseek-ai+dsh-*`。

## 需求理解

- **What**：核实 DSH 运行时五个能力接缝（`ctx.subagents` / `ctx.agents` / `Agent` /
  `finalAssistantOutput` / `ctx.subprocess`）的真实类型形状，以及 sandore 现有
  microflow / workflow 两包的类型基座现状，作为 foundation-01（agent/shell/skill/mcp
  Step 与分支评估的执行层）落地的精确依据。
- **Boundaries**：DSH 侧只核实上述五个接缝的类型与签名；sandore 侧只核实
  microflow 的 `errors.ts`、workflow 的 `schema.ts`（`FinalizeMetaSchema`）/`types.ts`/
  `shell.ts`、两个 `package.json`、`workflow/tests/mocks/` 的现状。
- **Goal**：拿到「结构接缝 + 类型基座」的精确事实，供实现时对齐，不产出方案。

---

## 1. `ctx.subagents`（startContinuable 签名与 ContinuableStart / ContinuableStartSpec）

来源包：`@deepseek-ai/dsh-subagent`
- 源码：`packages/subagent/subagent/src/index.ts`（Service Definition）、
  `src/continuation.ts`（continuable 管理器）、`src/types.ts`（请求/结果词汇）。
- sandore 编译产物：`node_modules/.pnpm/@deepseek-ai+dsh-subagent@*/.../lib/types/*.d.ts`。

### Context 增强
```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }
}
```

### SubagentRuntime（`ctx.subagents`，`extends Service`）关键方法
```ts
startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>
interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void
reportFrom(child: Agent, content: ContentBlock[], options: SubagentReportOptions): Promise<MessageId>
start(name: string, request: SubagentStartRequest): Promise<SubagentRun>          // 一次性子代理
listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>
listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>
registerProvider(provider: SubagentProvider): () => void
getProvider(name: string): SubagentProvider | undefined
list(): string[]
```

### ContinuableStartSpec（`src/continuation.ts` 第 112 行起，源与 .d.ts 一致）
```ts
export interface ContinuableStartSpec {
  /** ctx.subagents 提供方（continuable 创建能力由此建立 child）。 */
  readonly provider: string
  /** 初始委派的短 description，持久化为 child 的创建 label。 */
  readonly label: string
  /** 委派请求。管理器保留稳定 childId、解析持久 descriptor、自行组合 child。 */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
  /** 调用方取消信号，仅持有操作到 inbox 接受为止。 */
  readonly signal: AbortSignal
}
```

### ContinuableStart（`src/continuation.ts` 第 127 行起）
```ts
export interface ContinuableStart {
  /** 持久 child 会话 id，跨激活稳定。 */
  readonly childId: SessionId
  /** 已接受的首条提示词的 inbox message id。 */
  readonly messageId: MessageId
}
```

### SubagentStartRequest（`src/types.ts`，用于理解 `request` 剔除后剩余字段）
```ts
export interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]          // 必填：child 的 user message
  readonly parent: Agent                   // 必填：委派方 Agent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: ObjectJsonSchema // 被 ContinuableStartSpec.request 剔除
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
}
```
> 推论：`ContinuableStartSpec.request` 至少必须含 `prompt` 与 `parent`，可选
> `agentOptions` / `maxDepth` / `toolFilter` / `persona`；`label`/`signal`/`outputSchema`
> 由外层 `ContinuableStartSpec` 承载或不可用。

### 关键结构事实（对实现负载）
- `startContinuable()` 返回 `{ childId, messageId }`，**不返回 Agent**；随后需
  `ctx.agents.get(childId)` 取到活的 child `Agent`（裸 `Agent`，非 `AgentHandle`）才能
  `whenIdle()` / 读 `session.events`。设计文档（task-3-full-dag/design.md:176）强调
  「hold 住 child 引用」，因为叶子子代理 settle 后会被 dispose。

---

## 2. `ctx.agents`（get / create / resume 与 AgentHandle）

来源包：`@deepseek-ai/dsh-agent`
- 源码：`packages/core/agent/src/index.ts`（AgentRegistry）、`src/runtime-types.ts`（Agent）。
- sandore 编译产物：`node_modules/.pnpm/@deepseek-ai+dsh-agent@*/.../lib/types/index.d.ts`。

### Context 增强
```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
    agent?: Agent   // Agent.ctx 上安装的关联，普通 context 为 undefined
  }
}
```

### AgentRegistry（`ctx.agents`，`extends Service`）关键方法
```ts
create(options: CreateAgentOptions): Promise<AgentHandle>
resume(options: ResumeAgentOptions): Promise<AgentHandle>
get(id: SessionId): Agent | undefined
list(): Agent[]
roots(): Agent[]
isOwnedBy(id: SessionId, owner: Agent): boolean
register(agent: Agent): () => void
currentInitiator(): Agent | undefined
requireInitiator(): Agent
withInitiator<T>(agent: Agent, operation: () => T): T
withoutInitiator<T>(operation: () => T): T
setFactory(factory: AgentFactory): () => void
```

### AgentHandle（index.d.ts 第 155 行起）
```ts
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>   // 能力：只有持有者可拆除该 agent
}
```

### CreateAgentOptions / ResumeAgentOptions / AgentOptions
```ts
export interface AgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}

export interface CreateAgentOptions {
  readonly sessionId: SessionId
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  readonly seed?: readonly SessionEvent[]
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup
}

export interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup
}
```
> 冷恢复可续接子代理用 `ctx.agents.resume({ resumeSessionId })`（设计决策 D3 记录）。

---

## 3. Agent（whenIdle / session.events / status）

来源包：`@deepseek-ai/dsh-agent` 的 `runtime-types.ts`。

### Agent 接口（关键成员）
```ts
export interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: Inbox
  readonly status: AgentStatus          // 'idle' | 'running'
  readonly ctx: Context
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>             // 当前整个 agent 活动达到 quiescence 后 resolve
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}

export type AgentStatus = 'idle' | 'running'
export interface CancelOptions { keepInbox?: boolean | undefined }
```
- `agent/status` 事件载荷：`{ agent: Agent; status: AgentStatus }`。

### `session.events`（dsh-session 的 `Session` 类）
- `Session` 定义于 `@deepseek-ai/dsh-session`（源码 `packages/core/session/src/*`；编译产物
  `lib/types/index.d.ts` 第 106 行 `export declare class Session`）。
```ts
class Session {
  get id(): SessionId
  readonly header: SessionHeader
  readonly firstLiveSeq: number
  get events(): readonly SessionEvent[]   // 不可变快照，深冻结，追加前复用
  get seq(): number
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...): SessionEvent<T>
}
```
> 因此 `child.session.events` 是 `readonly SessionEvent[]`，可直接喂给
> `finalAssistantOutput`。

---

## 4. `finalAssistantOutput`（assistant-output.ts 的选取规则）

来源包：`@deepseek-ai/dsh-subagent`，源码 `packages/subagent/subagent/src/assistant-output.ts`。

### 签名
```ts
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined
```

### 选取规则（`AssistantOutputFold`，源码实读）
1. 顺序遍历所有事件：
   - 事件类型 `assistant/message`：读 `event.data.message.content`（`ContentBlock[]`）；
     若 `content.length > 0`，则把该 content 设为当前候选（**后出现的非空 assistant message 覆盖前一个**）。
   - 事件类型 `assistant/chunk` 且 `chunk.type === 'text-delta'`：把 `chunk.text` 追加到流式兜底文本。
   - 其余事件不贡献。
2. `collect()` 选取：
   - 若有候选 message（最后一条非空 assistant message），返回它；
   - 否则把累积的 text-delta 文本 join，非空则返回 `[{ type: 'text', text }]`；
   - 两者皆无则返回 `undefined`。
3. 选取与 run 的 stop reason 无关（空 content 的 usage-only message 不会覆盖更早的输出）。

### 相关事件形状（dsh-session `SessionEventMap`）
```ts
'assistant/message': { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
// AssistantMessage.content: ContentBlock[]（dsh-llm message.d.ts 第 126 行）
'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
// StreamChunk 的 text-delta 变体携带 .text
```

---

## 5. `ctx.subprocess`（spawn / resolveExecutable 签名）

来源包：`@deepseek-ai/dsh-subprocess`
- 源码：`packages/subprocess/subprocess/src/index.ts`（Service Definition）、`src/types.ts`（词汇）。
- **未安装进 sandore 的 node_modules**（`pnpm-lock.yaml` 无 `dsh-subprocess`）；设计文档
  （task-3-full-dag/design.md:145）明确：sandore 以软依赖 `ctx.get('subprocess')` 获取，
  **不是新建类型声明**。

### Context 增强
```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessRuntime
  }
}
```

### SubprocessRuntime（`extends Service`）签名（index.ts 第 102 行起）
```ts
abstract class SubprocessRuntime extends Service {
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle

  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}
```

### 关键类型（types.ts）
```ts
interface SubprocessSpawnSpec {
  argv: readonly string[]           // argv[0] 为程序；此处从不做 shell 解释
  cwd: string
  stdio: SubprocessStdio
  graceMs: number
  signal?: AbortSignal | undefined
  env?: NodeJS.ProcessEnv | undefined
}

type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
interface SubprocessCollect {
  maxBytes: number
  spill?: { maxBytes: number }
}
interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}

interface SubprocessHandle {
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs      // stdout?/stderr? 各为 SubprocessOutputReader
  readonly done: Promise<SubprocessOutcome>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

interface SubprocessOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

interface SubprocessOutputReader {
  readFrom(fromByte: number): SubprocessOutputRead   // { text, nextOffset, lossy, spillPath? }
}
```
> 与 `ctx.shell` 的差异：`spawn` 返回 `SubprocessHandle`（原始 stdio + 收集 reader + 进程树
> 终止），用于 stdin 注入 / 流式 / 终端；`resolveExecutable` 解析可执行路径。`graceMs` 为
> SIGTERM→SIGKILL 升级与 drain 的宽限期。sandore 现有 `workflow/src/shell.ts` 的
> `ShellExecutor` 是高层 `bash -c` 接缝（无 stdin 注入），与 `ctx.subprocess` 互补。

---

## 6. 现有 `microflow/src/errors.ts`（现状）

路径：`packages/sandore/microflow/src/errors.ts`。

- `SandoreError extends HarnessError`（dsh-llm 的 `HarnessError`：
  `readonly code: string; constructor(message: string, code: string, options?: ErrorOptions)`）。
- 新增 `readonly fatal: boolean`（默认 `true`），构造
  `constructor(message, code, options?: ErrorOptions & { fatal?: boolean })`。
- `SandoreErrorCode` 联合：
  `'YAML_PARSE' | 'DEFINITION_INVALID' | 'NODE_NOT_FOUND' | 'CYCLE_DETECTED'
   | 'STEP_TIMEOUT' | 'STEP_EXECUTION' | 'INVALID_OPERATION' | 'CANCELLED'
   | 'PERSISTENCE_FAILED'`。
- `isFatalSandoreError(error: unknown): boolean`。
- workflow 包经 `workflow/src/errors.ts` re-export（`SandoreError`/`isFatalSandoreError` +
  `type SandoreErrorCode`），依赖方向 workflow → microflow。

microflow 现状（结构上下文，仅与接缝相关）：
- `index.ts` re-export `errors.ts` / `step-runner.ts` / `stage-executor.ts`。
- `step-runner.ts` 当前只实现 shell（`ctx.shell.resolve` → `ctx.shell.run`）与 prompt
  （`ctx.llm.stream`）两条路径，`run()` 的 `switch` 对其它 command type 抛 `STEP_EXECUTION`
  —— agent/skill/mcp 尚无实现（即 foundation-01 的落点）。
- `internal.ts` 提供 `describeError` / `textSummary`（包内私有）。

---

## 7. 现有 `workflow/src/schema.ts`（FinalizeMetaSchema，现状）

路径：`packages/sandore/workflow/src/schema.ts`。

- `FinalizeMetaSchema`（第 192 行）：
  ```ts
  z.object({
    status: z.enum(['evaluating', 'completed', 'ask']),
    sessionId: z.string().optional(),
    gateSessionId: z.string().optional(),
    directory: z.string().optional(),
    errorDetail: z.string().optional(),
  })
  ```
  派生 `export type FinalizeMeta = z.infer<typeof FinalizeMetaSchema>`。
- 相邻相关：`StepSessionMetaSchema`（第 185 行）=
  `{ childId: string; synthetic: boolean; command: z.enum(['shell','prompt','agent','skill','mcp']) }`；
  `ContentBlockSchema = z.looseObject({ type: z.string() })`。
- `ExecutedStepDefaultSchema` 含 `finalizeMeta?: FinalizeMetaSchema.optional()`、
  `sessionMeta?: StepSessionMetaSchema.optional()`、`output?: z.array(ContentBlockSchema).optional()`。

---

## 8. 现有 `workflow/src/types.ts`（现状）

路径：`packages/sandore/workflow/src/types.ts`。

- 顶部从 `./schema.ts` 收紧并 re-export：`BranchMeta` / `CommandConfig` / `FinalizeMeta` /
  `InputFromItem` / `OutputToItem` / `PassThroughVar` / `RetryRecord` / `SessionMessage` /
  `StepSessionMeta`。
- 浏览器安全基础词汇（仅 type，无运行时依赖）：
  `DagRunInfo`、`DagStartRequest`、`DagRun`、`DagRunStatus`（7 态）、`DagInstanceState`、
  `ExecutedStepDefault`（含 `finalizeMeta?` / `output?: ContentBlock[]`）、`StageInfo`、
  `StepStatus`（7 态）、`StageContract`、`PendingQuestion`、`AskUserQuestionPayload`、
  `PendingPermission`、`DagResultInfo`。

---

## 9. 现有 `workflow/src/shell.ts`（现状）

路径：`packages/sandore/workflow/src/shell.ts`。

- 本地结构类型复刻 `ctx.shell`（`@deepseek-ai/dsh-shell` 未作为 sandore 运行时依赖安装）：
  - `CollectedOutput`（text / truncated / spillPath?）
  - `ShellExecRequest`（command / workdir? / timeoutMs? / stdoutMaxBytes? / signal? / stdin? / env?）
  - `ShellExecSpec`（command / workdir / timeoutMs / stdoutMaxBytes / signal? / stdin? / env?）
  - `ShellRunResult`（exitCode / signal / timedOut / aborted / timeoutMs / stdout / stderr）
  - `ShellExecutor`：`resolve(request) → ShellExecSpec`、`run(spec) → Promise<ShellRunResult>`、
    `start(spec) → unknown`。
- 声明 `declare module '@deepseek-ai/cordis' { interface Context { shell: ShellExecutor } }`。
- 该文件是「不引入包级依赖、用本地结构类型声明接缝」的现成范式模板。

---

## 10. 两个 package.json（现状）

### `packages/sandore/workflow/package.json`
- name `@deepseek-ai/dsh-sandore-workflow`，`version 0.1.0-rc.6`，`type module`。
- dependencies：`yaml ^2.9.0`、`zod ^4.4.3`。
- peerDependencies（= devDependencies 同版）：`@deepseek-ai/cordis 4.0.1`、
  `@deepseek-ai/dsh-sandore-microflow workspace:*`、`@deepseek-ai/dsh-session 0.1.0-rc.6`、
  `@deepseek-ai/dsh-llm 0.1.0-rc.6`、`@deepseek-ai/dsh-typert-protocol 0.1.0-rc.6`、
  `@deepseek-ai/dsh-agent 0.1.0-rc.6`、`@deepseek-ai/dsh-storage 0.1.0-rc.6`、
  `@deepseek-ai/dsh-storage-domain 0.1.0-rc.6`、`@deepseek-ai/schemastery 3.18.1`。

### `packages/sandore/microflow/package.json`
- name `@deepseek-ai/dsh-sandore-microflow`，`version 0.1.0-rc.6`，`type module`。
- 无 dependencies；peerDependencies（= devDependencies 同版）：
  `@deepseek-ai/cordis 4.0.1`、`@deepseek-ai/dsh-llm 0.1.0-rc.6`。

> 注意：两个 package.json 均**未**声明 `dsh-subagent` / `dsh-subprocess` / `dsh-shell` /
> `dsh-sandbox` / `dsh-tools` 依赖。subagent/subprocess 的真实类型只存在于 DSH 源码
> （deepseek-harness）与其编译产物里；sandore 侧当前通过 `shell.ts` 本地复刻模式 + 运行时
> 软依赖（`ctx.get(...)`）使用。`ctx.subagents` / `ctx.agents` 虽无显式包依赖，但其类型来自
> `dsh-agent`（已列为 peerDep）与 `dsh-subagent`（未列）。

---

## 11. 现有 `workflow/tests/mocks/`（现状）

目录：`packages/sandore/workflow/tests/mocks/`，四个文件，均「测试专用、非发布面」。

- `llm.ts`：`FakeLlm`（`listProviders` / `listModels` / `stream`，`stream` 记录调用并委托
  `streamHandler`）+ `textChunks(text, reason)` 辅助。类型取自 `@deepseek-ai/dsh-llm`
  （`LlmProviderInfo` / `LlmModelInfo` / `GenerateOptions` / `StreamChunk` / `FinishReason`）。
  注入方式：`ctx.provide('llm', …)`。
- `sessions.ts`：`FakeSession`（`events: Array<{ type: string; data: unknown }>` +
  `append(type, data)`）；`FakeSessionStore`（`create` / `get` / `list`）。注入
  `ctx.provide('sessions', …)`。注意其 `events` 是「type + data」最小形状，非 DSH
  `SessionEvent` 的完整 `{ type, seq, time, data }` 快照。
- `shell.ts`：`FakeShell`（`resolve` / `run` / `start`，`resolveHandler` / `runHandler` 可注入）+
  `successResult(spec, stdout?)` 辅助。类型取自 `../../src/shell.ts`。注入
  `ctx.provide('shell', …)`。
- `storage-domain.ts`：`MemoryKvTable`（`implements KvTable`，读同步/写 await/`update` 缺 key
  抛 `missing-key`）、`MemoryDomain`、`MemoryStorageDomain`（`open(spec)` / `get(name)`）。
  类型取自 `@deepseek-ai/dsh-storage-domain`。注入 `ctx.provide('storageDomain', …)`。

> 现状：mocks 中**尚无** `ctx.subagents` / `ctx.agents` / `Agent` / `ctx.subprocess` /
> `finalAssistantOutput` 的等价 mock。
