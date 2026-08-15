## Exploration Result

> 说明：`furina config show exploration.reference` 返回空数组 `[]`（无配置的参考目录/技能/URL）。本次探索依据 `exploreContent` 直接核实两部分真实源码：(A) DSH 源码（`D:\project-code\llm\deepseek-harness`，DSH = DeepSeek Harness，dsh-workflow.md §3 明确其源码位于该仓库 `packages/`）；(B) 本仓库 sandore 现有包源码（`D:\project-code\llm\sandore\packages\sandore\`）。以下均为从实际代码逐字段摘录，非推断。

---

### A. DSH 源码真实类型形状

#### A1. `ctx.subagents`（SubagentRuntime）— startContinuable 签名与 ContinuableStart/ContinuableStartSpec

来源：
- `D:\project-code\llm\deepseek-harness\packages\subagent\subagent\src\index.ts`（Service Definition，`ctx.subagents: SubagentRuntime`）
- `D:\project-code\llm\deepseek-harness\packages\subagent\subagent\src\continuation.ts`（`ContinuableStartSpec`/`ContinuableStart` 定义处）
- `D:\project-code\llm\deepseek-harness\packages\subagent\subagent\src\types.ts`（`SubagentStartRequest` 等）

`startContinuable` 签名（index.ts:212）：

```ts
async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>
```

`ContinuableStartSpec`（continuation.ts:112-124）：

```ts
export interface ContinuableStartSpec {
  /** The `ctx.subagents` provider whose continuable-creation capability establishes the child. */
  readonly provider: string
  /** The initial delegation's short `description`, persisted as the child's creation label. */
  readonly label: string
  /** The delegation request. The manager reserves the stable child id, resolves
   *  the durable descriptor, and composes the child itself. */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}
```

`ContinuableStart`（continuation.ts:127-132）：

```ts
export interface ContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: MessageId
}
```

`SubagentStartRequest`（types.ts:100-149，`request` 字段扣除 `label`/`signal`/`outputSchema` 后即 `ContinuableStartSpec.request` 的真实形状）：

```ts
export interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]       // 首条提示词（ContentBlock[] 而非 string）
  readonly parent: Agent                // 委托方（工作流宿主 Agent）
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: ObjectJsonSchema
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
}
```

因此 `ContinuableStartSpec.request` 实际字段为：`{ prompt: ContentBlock[]; parent: Agent; agentOptions?; maxDepth?; toolFilter?; persona? }`。注意：**无 `sessionId`、无 `meta`、无权限字段**（权限由子代理继承父级，见 dsh-workflow.md §5.3A 的既有结论，此处源码印证 `ContinuableStartSpec` 不含权限字段）。

`ctx.subagents` 其余相关方法（index.ts）：
- `start(name: string, request: SubagentStartRequest): Promise<SubagentRun>` — 一次性子代理
- `followup(parent: Agent, childId: SessionId, content: ContentBlock[], options: SubagentFollowupOptions): Promise<MessageId>` — 续发消息
- `interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void` — 中断（同步 fire-and-return）
- `reportFrom(child: Agent, content: ContentBlock[], options: SubagentReportOptions): Promise<MessageId>` — 子代理上报父级
- `listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>`
- `listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>`
- `registerProvider(provider: SubagentProvider): () => void`
- `registerContinuableSetup(contribution: ContinuableSetupContribution): () => void`
- `drainContinuableDescendants(parents: readonly Agent[]): Promise<void>`

关键辅助类型（continuation.ts）：
```ts
export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }

export interface SubagentFollowupOptions {
  readonly source: MessageSource
  readonly signal: AbortSignal
}

export interface SubagentReportOptions {
  readonly delivery: SubagentReportDelivery  // 'quiet' | 'wakeup'
  readonly signal: AbortSignal
}
```

`SubagentResult`（types.ts:219-238，`SubagentRun.result` 的终态）：
```ts
export interface SubagentResult {
  readonly output: ContentBlock[]   // 最后一条非空 assistant message 内容
  readonly structured?: unknown
  readonly stopReason: SubagentStopReason  // 'completed'|'aborted'|'error'|'max-tokens'|'refusal'
}
```

`ContentBlock` 来自 `@deepseek-ai/dsh-llm`；`SessionId`/`MessageId` 来自 `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-llm`。

---

#### A2. `ctx.agents`（AgentRegistry）— get/create/resume 与 AgentHandle

来源：`D:\project-code\llm\deepseek-harness\packages\core\agent\src\index.ts`

`ctx.agents: AgentRegistry`（index.ts:37, 256）。核心方法真实签名：

```ts
// 查询（同步）
get(id: SessionId): Agent | undefined

// 创建
async create(options: CreateAgentOptions): Promise<AgentHandle>

// 从持久化会话恢复
async resume(options: ResumeAgentOptions): Promise<AgentHandle>
```

`CreateAgentOptions`（index.ts:80-133）：
```ts
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
```

`ResumeAgentOptions`（index.ts:139-156）：
```ts
export interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup
}
```

`AgentHandle`（index.ts:172-175）：
```ts
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}
```

`AgentSetup`（index.ts:69-71，`setup` 回调形状）：
```ts
export type AgentSetup = (
  agentCtx: Context,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void
```

`AgentOptions`（runtime-types.ts:24-31）：
```ts
export interface AgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
}
```

`AgentRegistry` 其余成员：`currentInitiator()`/`requireInitiator()`/`withInitiator()`/`withoutInitiator()`/`setFactory(factory)`/`register(agent)`/`enter(agent, owner)`/`announce(agent)`/`isOwnedBy(id, owner)`/`list()`/`roots()`。

---

#### A3. `Agent`（whenIdle / session.events / status）

来源：`D:\project-code\llm\deepseek-harness\packages\core\agent\src\runtime-types.ts`（`Agent` 接口，64-144 行）；`Session` 类与 `SessionEvent` 在 `D:\project-code\llm\deepseek-harness\packages\core\session\src\index.ts` 与 `types.ts`。

`Agent` 接口关键字段/方法：
```ts
export interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session           // session.events 见下
  readonly inbox: Inbox
  readonly status: AgentStatus        // 'idle' | 'running'
  readonly ctx: Context
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>           // 解析于当前整代理活动进入静止态后
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}
```

`AgentStatus`（runtime-types.ts:50）：
```ts
export type AgentStatus = 'idle' | 'running'
```
（无 `paused`/`interacting` 态 —— 印证 dsh-workflow.md §5.1A 关于「DSH Agent 只有 idle/running 两态」的既有结论。）

`AgentCancelCause`（session/src/types.ts:143-147）：
```ts
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }
```

`Session`（session/src/index.ts:425 起）关键形状：
```ts
export class Session {
  readonly header: SessionHeader
  get id(): SessionId
  readonly firstLiveSeq: number
  get events(): readonly SessionEvent[]   // 追加式日志的不可变快照
  get seq(): number
  get surface(): SessionSurface
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...): SessionEvent<T>
}
```

`SessionHeader`（session/src/types.ts:61-99）：
```ts
export interface SessionHeader {
  readonly version: number
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId
  readonly seedLength?: number
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}
```

`SessionEvent<T>`（session/src/types.ts:404-436）——泛型判别联合：
```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: number
    time: number
    data: SessionEventMap[K]
    ignorable?: true
  } & (K extends SurfaceEventType ? {
    sourceEventSeqs?: number[]
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

对 `finalAssistantOutput` 有关的事件类型（`SessionEventMap`，session/src/types.ts:236-333）：
- `'assistant/message'`: `{ turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }` → `event.data.message.content` 为 `ContentBlock[]`
- `'assistant/chunk'`: `{ turn: number; step: number; chunk: StreamChunk }` → `chunk.type === 'text-delta'` 时 `chunk.text`

---

#### A4. `finalAssistantOutput`（assistant-output.ts 的选取规则）

来源：`D:\project-code\llm\deepseek-harness\packages\subagent\subagent\src\assistant-output.ts`（并从 `subagent/src/index.ts:72` re-export）。

```ts
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined
```

选取规则（该文件头部注释 + 实现）：
1. 遍历全部事件；`assistant/message` 事件若 `event.data.message.content.length > 0`，则该 content **整体成为候选最终答案**（后出现的非空消息覆盖先前的 —— 即「最后一条非空 assistant 消息」）。
2. `assistant/chunk` 事件若 `event.data.chunk.type === 'text-delta'`，则把 `chunk.text` 追加到流式文本回退缓冲（仅当没有任何非空 assistant message 时才用）。
3. `collect()` 返回值：有非空 assistant message → 返回该 `ContentBlock[]`；否则若累积文本非空 → 返回 `[{ type: 'text', text }]`；都没有 → `undefined`。
4. 选取与 run 的 stop reason 无关（不因 `max-tokens`/`error` 等改变规则）。

实现细节（`AssistantOutputFold` 类）：
```ts
push(event: SessionEvent): void {
  if (event.type === 'assistant/message') {
    const content = event.data.message.content
    if (content.length > 0) this.message = content
  } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
    this.pushText(event.data.chunk.text)
  }
}
collect(): ContentBlock[] | undefined {
  if (this.message !== undefined) return this.message
  const text = this.partial.join('')
  return text.length > 0 ? [{ type: 'text', text }] : undefined
}
```

---

#### A5. `ctx.subprocess`（spawn / resolveExecutable 签名）

来源：`D:\project-code\llm\deepseek-harness\packages\subprocess\subprocess\src\index.ts`（Service Definition）+ `types.ts`（spec/handle 类型）。

`ctx.subprocess: SubprocessRuntime`（抽象 Service，index.ts:102）。核心方法：

```ts
abstract resolveExecutable(
  command: string,
  env?: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<string>

abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle

abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
```

`SubprocessSpawnSpec`（types.ts:75-104）：
```ts
export interface SubprocessSpawnSpec {
  argv: readonly string[]        // argv[0] 为程序，绝不 shell 解释
  cwd: string
  stdio: SubprocessStdio
  graceMs: number                // SIGTERM→SIGKILL 升级宽限（毫秒）
  signal?: AbortSignal | undefined
  env?: NodeJS.ProcessEnv | undefined
}
```

`SubprocessStdio` / `SubprocessStdinMode` / `SubprocessOutputMode` / `SubprocessCollect`（types.ts:36-66）：
```ts
export type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
export type SubprocessOutputMode = 'pipe' | 'inherit' | SubprocessCollect
export interface SubprocessCollect { maxBytes: number; spill?: { maxBytes: number } }
export interface SubprocessStdio {
  stdin: SubprocessStdinMode
  stdout: SubprocessOutputMode
  stderr: SubprocessOutputMode
}
```
（注：`stdin: { data: string }` 即 v2.4.2 的 stdin 注入 batch 形状。）

`SubprocessHandle`（types.ts:167-194）：
```ts
export interface SubprocessHandle {
  readonly pid: number
  readonly stdin: Writable | undefined       // stdin: 'pipe' 时存在
  readonly stdout: Readable | undefined      // stdout: 'pipe' 时存在
  readonly stderr: Readable | undefined      // stderr: 'pipe' 时存在
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
```

`SubprocessOutcome`（types.ts:113-118）：`{ exitCode: number | null; signal: NodeJS.Signals | null }`。

`resolveExecutable` 语义：绝对路径校验；裸名用 provider 的 scrubbed PATH + 显式 env 覆盖；含分隔符的相对路径被拒绝（fail loud）。`spawn` 语义：从完整 spec 启动受管子进程树，立即返回句柄；`done` 在进程关闭时解析（仅 spawn 级失败才 reject）。

---

### B. sandore 现有包现状（结构接缝）

#### B1. `microflow/src/errors.ts`

路径：`D:\project-code\llm\sandore\packages\sandore\microflow\src\errors.ts`

现状：
- `SandoreErrorCode`：字符串字面量联合，含定义/解析错误 `'YAML_PARSE' | 'DEFINITION_INVALID' | 'NODE_NOT_FOUND' | 'CYCLE_DETECTED'`、运行时错误 `'STEP_TIMEOUT' | 'STEP_EXECUTION' | 'INVALID_OPERATION' | 'CANCELLED'`、恢复性错误 `'PERSISTENCE_FAILED'`。
- `class SandoreError extends HarnessError`（`HarnessError` 来自 `@deepseek-ai/dsh-llm`），带 `readonly fatal: boolean`（构造 `options.fatal` 默认 `true`）；构造函数 `(message: string, code: SandoreErrorCode, options?: ErrorOptions & { fatal?: boolean })`。
- `isFatalSandoreError(error: unknown): boolean` → `error instanceof SandoreError && error.fatal`。
- 注释明确「依赖方向统一为 workflow → microflow；workflow 通过 re-export 保持对外 API 不变」。

#### B2. `workflow/src/schema.ts`（FinalizeMetaSchema）

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`

`FinalizeMetaSchema`（schema.ts:192-198）：
```ts
export const FinalizeMetaSchema = z.object({
  status: z.enum(['evaluating', 'completed', 'ask']),
  sessionId: z.string().optional(),
  gateSessionId: z.string().optional(),
  directory: z.string().optional(),
  errorDetail: z.string().optional(),
})
```
派生类型 `export type FinalizeMeta = z.infer<typeof FinalizeMetaSchema>`（schema.ts:350）。

相关：同文件还有 `BranchMetaSchema`（`{ result?, sessionId?, directory?, status: 'evaluating'|'completed', expectation? }`）、`StepSessionMetaSchema`（`{ childId: string; synthetic: boolean; command: 'shell'|'prompt'|'agent'|'skill'|'mcp' }`）、`SessionMessageSchema`、`RetryRecordSchema`、`ExecutedStepDefaultSchema`（含 `finalizeMeta: FinalizeMetaSchema.optional()`、`sessionMeta`、`output: ContentBlockSchema[]`）、`WorkflowTaskStateSchema`（state 表 value）、`sandoreDomainSpec`（`defineDomain`，三表 `definitions`/`jobs`/`state`）。`CommandConfigSchema` 为五类型 discriminated union（`agent`/`prompt`/`shell`/`skill`/`mcp`，判别字段顶层 `type`，变体嵌套于 `value`）。

#### B3. `workflow/src/types.ts`

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`

现状：纯 `type`/`interface`（无运行时值），从 `schema.ts` 收紧深层依赖类型并 re-export 13 个基础类型（`BranchMeta`/`CommandConfig`/`FinalizeMeta`/`InputFromItem`/`OutputToItem`/`PassThroughVar`/`RetryRecord`/`SessionMessage`/`StepSessionMeta` 等）。定义：
- `DagRunInfo { taskId; workflowId; jobId }`
- `DagStartRequest { workflowId; jobId; originalInput; cwd? }`
- `DagRun { instanceId; status: DagRunStatus }`
- `DagRunStatus = 'pending'|'running'|'interacting'|'completed'|'failed'|'aborted'|'paused'`
- `DagInstanceState { taskId; jobId; workflowId; status; originalInput; currentStageId; executedSteps; stageInfos; pendingQueue; createdAt; updatedAt }`
- `ExecutedStepDefault`（含 `sessionMeta?`、`finalizeMeta?`、`output?: ContentBlock[]`、`parentSessionId?`、`loopIteration?`、`retryHistory?` 等）
- `StageInfo { id; name; status }`、`StepStatus = 'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'`
- `StageContract`（`artifacts`、`passThroughVars`、`contractArtifacts` 等）
- `PendingQuestion { stepId; sessionId; requestId; questions: AskUserQuestionPayload }`
- `AskUserQuestionPayload { questions: Array<{ id; question; header?; options?; multi_select? }> }`
- `PendingPermission { stepId; sessionId; requestId; permission; patterns?; metadata?; tool? }`
- `DagResultInfo { taskId; jobId; status; error? }`

#### B4. `workflow/src/shell.ts`

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\shell.ts`

现状：本地**结构类型**复刻 `ctx.shell` 最小接缝（注释说明 `@deepseek-ai/dsh-shell` 未作为 sandore 运行时依赖）。定义：
- `CollectedOutput { text; truncated; spillPath? }`
- `ShellExecRequest { command; workdir?; timeoutMs?; stdoutMaxBytes?; signal?; stdin?; env? }`
- `ShellExecSpec { command; workdir; timeoutMs; stdoutMaxBytes; signal?; stdin?; env? }`
- `ShellRunResult { exitCode; signal; timedOut; aborted; timeoutMs; stdout: CollectedOutput; stderr: CollectedOutput }`
- `ShellExecutor { resolve(request): ShellExecSpec; run(spec): Promise<ShellRunResult>; start(spec): unknown }`
- 通过 `declare module '@deepseek-ai/cordis' { interface Context { shell: ShellExecutor } }` 声明 `ctx.shell`。

#### B5. 两个 package.json

`D:\project-code\llm\sandore\packages\sandore\workflow\package.json`：
- name `@deepseek-ai/dsh-sandore-workflow`，version `0.1.0-rc.6`，`type: module`。
- dependencies：`yaml ^2.9.0`、`zod ^4.4.3`。
- peerDependencies/devDependencies（版本一致）：`@deepseek-ai/cordis 4.0.1`、`@deepseek-ai/dsh-sandore-microflow workspace:*`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-storage`、`@deepseek-ai/dsh-storage-domain`（均 `0.1.0-rc.6`）、`@deepseek-ai/schemastery 3.18.1`。
- scripts：`typecheck: tsc --noEmit`。
- exports：`.`、`./types`、`./src/*`、`./package.json`。

`D:\project-code\llm\sandore\packages\sandore\microflow\package.json`：
- name `@deepseek-ai/dsh-sandore-microflow`，version `0.1.0-rc.6`，`type: module`。
- 无 dependencies。
- peerDependencies/devDependencies：`@deepseek-ai/cordis 4.0.1`、`@deepseek-ai/dsh-llm 0.1.0-rc.6`（仅此二者，无 session/subagent 依赖）。
- scripts：`typecheck: tsc --noEmit`。
- exports：`.`、`./src/*`、`./package.json`。

#### B6. `workflow/tests/mocks/`（4 个文件现状）

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\`

- `llm.ts`：`FakeLlm` 类（`listProviders()`/`listModels(provider)`/`stream(options)`，`stream` 记录 `calls` 并委托可注入的 `streamHandler`）+ `textChunks(text, reason)` 生成固定 chunk 流（`block-start`/`text-delta`/`block-end`/`finish`）。依赖 `@deepseek-ai/dsh-llm` 的类型（`GenerateOptions`/`StreamChunk`/`FinishReason` 等）。
- `sessions.ts`：`FakeSession`（`events: Array<{ type; data }>`，`append(type, data)` 返回 `{ type, seq, time, data }`）+ `FakeSessionStore`（`create(id?)`/`get(id)`/`list()`）。
- `shell.ts`：`FakeShell`（`resolve` 记录 `requests` 并委托 `resolveHandler`，`run` 记录 `specs` 并委托 `runHandler`，`start` 抛「未实现」）+ `successResult(spec, stdout)`。类型从 `../../src/shell.ts` 导入。`defaultResolve` 补全 `workdir`（默认 `/tmp`）/`timeoutMs`（60000）/`stdoutMaxBytes`（1MB）。
- `storage-domain.ts`：`MemoryKvTable`（实现 `KvTable<K,V>`，`get`/`entries`/`keys`/`size`/`put`/`delete`/`update`，`update` 缺 key 抛 `DomainError('missing-key')`）+ `MemoryDomain`（`table(name)`/`close()`/`closed`）+ `MemoryStorageDomain`（`open(spec)` 拒绝重复打开，`get(name)`）。依赖 `@deepseek-ai/dsh-storage-domain`（`DomainError`/`Domain`/`DomainSpec`/`KvTable`）。

> 现状要点：`workflow/tests/mocks/` 目前只有 `llm`/`sessions`/`shell`/`storage-domain` 四份 mock，**尚无 `subagents`/`agents`/`subprocess` 的 mock**；`FakeSession` 的 `events` 元素形状是简化的 `{ type; data }`（无 DSH `SessionEvent` 的 `seq`/`time` 包络），与真实 `finalAssistantOutput(events: readonly SessionEvent[])` 的入参（需要 `seq`/`time`/`data`）不直接兼容。

---

## Supplementary Exploration Result

`experimental.websearch=true`、`experimental.context7=true`，但 Phase 3 已从 DSH 源码与 sandore 现有源码中获取到全部所需信息，无需补充网络检索（本探索为源码核实型，非第三方库用法查询；所涉 `@deepseek-ai/*` 均为仓库内/workspace 包，不属公开 npm 文档可查范围）。
