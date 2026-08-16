## Exploration Result

探索目标：DSH（deepseek-harness）参考源码 `packages/core/agent/src` 中 `agents.create`/`agents.resume` 的 `AgentHandle` 返回、`setup` 语义、`meta.cwd` 必填约束，以及 `systemPrompt.section` 与 `tools.register` 的真实签名。以下结论全部来自实际源码（附文件绝对路径与行号）。

### 1. `agents.create` / `agents.resume` 的返回类型 `AgentHandle`

定义文件：`D:\project-code\llm\deepseek-harness\packages\core\agent\src\index.ts`

- `AgentRegistry.create(options: CreateAgentOptions): Promise<AgentHandle>`（第 405 行）与 `AgentRegistry.resume(options: ResumeAgentOptions): Promise<AgentHandle>`（第 424 行）均返回 `Promise<AgentHandle>`，二者内部都通过 `Reflect.apply(target.createAgent / target.resume, receiver, [ownerCtx, options])` 委托给已注册的 `AgentFactory`。
- `AgentHandle` 真实定义为（第 172–175 行）：

```ts
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}
```

  语义要点：
  - `agent` 是发布的活体 `Agent`（`id` / `options` / `session` / `inbox` / `status` / `ctx` 等，见 `runtime-types.ts` 第 64–144 行）。
  - `dispose()` 是一个**能力（capability）**：只有创建/持有该 handle 的消费者能拆除该 agent。它会 `stop` 驱动循环、`await` 其退出、注销 agent、从 store 移除其 session、最后解卷其 scoped world。
  - `ctx.agents.get(id)` 只返回裸 `Agent`，不会返回 handle。
- `AgentFactory` 接口（第 183–214 行）声明了 `createAgent(ownerCtx, options): Promise<AgentHandle>` 与 `resume(ownerCtx, options): Promise<AgentHandle>`。

### 2. `setup` 语义

定义文件：`D:\project-code\llm\deepseek-harness\packages\core\agent\src\index.ts`

- `AgentSetup` 真实签名为（第 69–71 行）：

```ts
export type AgentSetup = (
  agentCtx: Context,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void
```

  其中 `AgentSetupCommit`（第 56–62 行）：

```ts
export interface AgentSetupCommit {
  commit(): void
}
```

- `CreateAgentOptions.setup?: AgentSetup`（第 132 行），`ResumeAgentOptions.setup?: AgentSetup`（第 155 行）。注意 `resume` 选项里**没有** `meta` / `seed`，只有 `resumeSessionId` / `agentOptions` / `signal` / `setup`（第 139–156 行）；`meta` 只存在于 `CreateAgentOptions`（第 94–101 行）。
- 实际执行点在 `dsh-agent-loop` 的 `setupAndPublish`（`D:\project-code\llm\deepseek-harness\packages\core\agent-loop\src\index.ts` 第 625–645 行）：

```ts
const setupCommit = await raceAbort(setup?.(prepared.agent.ctx), prepared.signal, id)
setupCommit?.commit()
return prepared.publish(source)
```

  语义要点：
  - `setup` 接收的是 `prepared.agent.ctx`（该 agent 的 scoped context，**不是**外层调用上下文）。
  - `setup` 会被 `await`；若返回 `AgentSetupCommit`，则在**发布（publish）前一刻**同步调用其 `commit()`。
  - **setup 只组合、不驱动**（compose, never drive）：在 agent/session 被插入、announce（`session/created`、`agent/created`）、`agent/session-start` 之前完成；setup 抛错/拒绝、commit 抛错或 owner 被销毁，会整体回滚且不发布任何 id。
  - 通过 `agentCtx` 注册的一切（scoped tools、prompt sections/variables、`restrict()`、listeners、awaited 子插件）在 `session/created`、`agent/created`、`agent/session-start` 以及首次 prompt 组装之前都已就绪。
  - 驱动 agent 只能在 create 解析之后（通过 `handle.agent.followup(...)` 等）。

### 3. `meta.cwd` 必填约束

类型定义：`D:\project-code\llm\deepseek-harness\packages\core\agent\src\index.ts` 第 94–101 行（`CreateAgentOptions.meta`），其中 `cwd?: string`。

关键事实：
- 在 `CreateAgentOptions.meta` 中 `cwd` 是**可选字段**，但它被 JSDoc 描述为 "validated absolute `cwd`"；真正的“必填（绝对路径）约束”落在两层校验：
  1. **session 存储边界**（`D:\project-code\llm\deepseek-harness\packages\core\session\src\index.ts`）：
     - `validateSessionHeader`（第 112–117 行）：

       ```ts
       if (record.cwd !== undefined) {
         if (typeof record.cwd !== 'string') throw new Error('session header cwd must be a string')
         if (!isAbsolute(record.cwd)) {
           throw new Error(`session header cwd must be an absolute path, got "${record.cwd}"`)
         }
       }
       ```

     - `SessionStore.prepare` / `create` 的 JSDoc 也写明 `@throws ... or meta.cwd is a non-absolute path`（第 827、860 行附近）。
  2. **ACP bridge（host 消费端）边界**（`D:\project-code\llm\deepseek-harness\packages\acp\acp\src\index.ts`）：
     - `validateSessionParams`（第 430–431 行）：`if (!isAbsolute(params.cwd)) throw invalidParams('cwd must be an absolute path: ...')`。
     - `newSession`（第 259–263 行）调用 `agents.create({ sessionId, meta: { cwd: params.cwd }, agentOptions: agentOptions(config) })`，其中 `params.cwd` 来自 ACP 协议的 `NewSessionRequest`（`cwd` 为必填字符串），即 host 创建会话时 `meta.cwd` 始终被提供、且必须是绝对路径。
- 结论：对 `agents.create` 而言 `meta.cwd` 类型上可选，但任何提供非绝对路径的 `cwd` 都会在 session 层被拒；ACP host 入口处 `cwd` 是必填且被强制要求为绝对路径。

### 4. `systemPrompt.section` 真实签名

定义文件：`D:\project-code\llm\deepseek-harness\packages\core\system-prompt\src\index.ts`

- 服务入口：`ctx.systemPrompt: SystemPrompt`（第 13–16 行）。
- 方法签名（第 381–390 行）：

```ts
section(section: PromptSection): () => void
```

  其中入参 `PromptSection`（第 52–75 行）：

```ts
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly complete?: boolean
}
```

  语义要点：
  - 在**调用上下文的作用域**注册一个有序 prompt section（scoped section 会 shadow 同名 global section；同层重名、非有限 `order` 会抛错）。
  - `order` 升序拼接；约定：`-100` = harness 身份、`0` = 部署 persona、工具指引用 100–199。
  - `text` 可为静态字符串或 `(context) => string` 提供者（每次组装时求值），可引用 `{{variable}}`。
  - `complete` 为 `true` 表示该 section 是完整 system prompt（多于一个有效 complete section 会导致组装失败）。
  - 返回**精确的 Cordis effect disposer**（`() => void`），用于有序卸载。
  - 相关姊妹方法：`context(context: PromptContext): () => void`（第 398 行）、`variable(name, provider): () => void`（第 446 行）、`tools(provider): () => void`（第 430 行，注册 tool-schema provider，与 `dsh-tools` 的 `tools.register` 是不同层面）。

### 5. `tools.register` 真实签名

定义文件：`D:\project-code\llm\deepseek-harness\packages\core\tools\src\index.ts`

- 服务入口：`ctx.tools: ToolRuntime`（第 137–140 行）。
- 方法签名（第 1037–1062 行）：

```ts
register(definition: ToolDefinition): () => void
```

  其中 `ToolDefinition`（第 222–288 行）：

```ts
export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

  其中 `ToolOutputDefinition`（第 212–219 行）：

```ts
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: JsonValue): ContentBlock[]
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}
```

  （`ToolSchema` 即 `{ name, description, parameters }`，来自 `@deepseek-ai/dsh-llm`。）
  语义要点：
  - `register` 校验：`output` 必须为对象且含 `render` 函数（`presentationMeta` 若提供必须是函数）；`output.schema` 必须是受支持的 JSON Schema；`timeoutMs` 若提供必须为正有限数；保留名 `run_code` 不可注册/不可 shadow（第 1039–1056 行）。
  - 在调用上下文的作用域注册（scoped 注册 shadow global；同层重名抛错），返回精确的 Cordis effect disposer。
  - 常用构造入口是 `defineTool<const S, const O>(options: DefineToolOptions<S, O>): ToolDefinition`（`D:\project-code\llm\deepseek-harness\packages\core\tools\src\schema.ts` 第 545 行），其 `DefineToolOptions`（第 483–513 行）提供 `name` / `description` / `parameters` / `output.schema` / `output.render` / `output.presentationMeta?` / `execute` / 以及可选的 `timeoutMs`、`isConcurrencySafe`、`finalizeContent`、`presentCall`、`presentResult`。
  - 姊妹方法：`restrict(filter: ToolRestriction): () => void`（第 1071 行，仅限 scoped context）、`guard(guard): () => void`（第 1110 行）、`get(name, scope?)`（第 1204 行）、`presentAs(mode): () => void`（第 946 行，仅限 scoped context）。

### 关键文件索引

- `D:\project-code\llm\deepseek-harness\packages\core\agent\src\index.ts` — `AgentRegistry.create/resume`、`AgentHandle`、`AgentSetup`、`AgentSetupCommit`、`CreateAgentOptions`、`ResumeAgentOptions`。
- `D:\project-code\llm\deepseek-harness\packages\core\agent\src\runtime-types.ts` — `Agent`、`AgentOptions` 公共类型与事件。
- `D:\project-code\llm\deepseek-harness\packages\core\agent-loop\src\index.ts` — `AgentFactory` 的 `AgentLoop` 实现（`createAgent`/`resume`/`setupAndPublish`），即 setup 执行与 publish 的真实时序。
- `D:\project-code\llm\deepseek-harness\packages\core\agent-loop\src\agent.ts` — `ReactLoopAgent` 驱动实现。
- `D:\project-code\llm\deepseek-harness\packages\core\session\src\index.ts` — `validateSessionHeader`（`cwd` 绝对路径校验）、`SessionStore.prepare/create`。
- `D:\project-code\llm\deepseek-harness\packages\core\session\src\types.ts` — `SessionHeader.cwd`、`CreateSessionOptions.meta`。
- `D:\project-code\llm\deepseek-harness\packages\core\system-prompt\src\index.ts` — `SystemPrompt.section` 与 `PromptSection`。
- `D:\project-code\llm\deepseek-harness\packages\core\tools\src\index.ts` — `ToolRuntime.register` 与 `ToolDefinition`。
- `D:\project-code\llm\deepseek-harness\packages\core\tools\src\schema.ts` — `defineTool` / `DefineToolOptions`。
- `D:\project-code\llm\deepseek-harness\packages\acp\acp\src\index.ts` — ACP bridge 消费 `agents.create` 的真实调用（含 `meta.cwd` 与 `cwd` 绝对路径校验）。

## Supplementary Exploration Result

参考材料配置 `exploration.reference` 为空，探索内容明确指定本地目录 `D:\project-code\llm\deepseek-harness`，因此 Phase 3 全部基于该目录源码完成，未使用 websearch/context7（无需补充在线材料）。
