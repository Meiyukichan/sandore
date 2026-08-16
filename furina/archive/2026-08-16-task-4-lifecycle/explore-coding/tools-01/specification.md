# Task 4 tools-01 参考实现与落点探索

> 探索类型：specification
> 探索日期：2026-08-16
> 当前项目：D:\project-code\llm\sandore
> 参考实现：D:\project-code\llm\deepseek-harness

## 需求理解（Phase 2）

1. **What**：Task 4 tools-01 要为 sandore 工作流引擎暴露 8 个「生命周期工具」——通过 DSH 工具定义/注册机制（`defineTool` + `ctx.tools.register` / `agentCtx.tools.register`）把 `SandoreEngine` 的 8 个实例级方法（`getState`/`startInstance`/`abortInstance`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`）注册为模型可调用的 tool。
2. **Boundaries**：`packages/sandore/tool`（落点包）、`packages/sandore/workflow`（`seam.ts`/`types.ts`）、`packages/sandore/microflow`（`SandoreError`/`subagents.ts` 接缝）；参考实现范围为 deepseek-harness 的 `packages/core/tools`、`packages/core/agent`、`packages/llm/llm`（`ToolSchema`/`HarnessError`）。
3. **Goal**：拿到 tool 包现状、DSH 权威工具定义/注册类型、SandoreEngine 8 个方法的确切签名与返回值类型、SandoreError 的捕获/摘要范式、以及 peerDependencies 写法范式，为后续实现提供确切落点。

---

## ① `packages/sandore/tool` 包现状

- 目录：`D:\project-code\llm\sandore\packages\sandore\tool\`
- **无 `src/` 目录**（纯占位包，尚无任何源码）。

`package.json`（完整）：
```json
{
  "name": "@deepseek-ai/dsh-sandore-tool",
  "version": "0.1.0-rc.6",
  "description": "sandore workflow engine model tools (placeholder)",
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  }
}
```
要点：
- **无 `dependencies` / `peerDependencies` / `devDependencies` / `scripts`**（与 microflow/workflow 包相比是空壳）。
- `main`/`types`/`exports` 范式与其他包一致：产物入口 `lib/index.js`，类型入口 `lib/types/index.d.ts`。

`tsconfig.json`（完整）：
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": ["src"]
}
```
要点：`outDir` 为 `lib/types`（types-first 构建，与 microflow/workflow 一致）；`rootDir`/`include` 指向 `src`（尚不存在）。

根 `tsconfig.base.json` 关键项（`D:\project-code\llm\sandore\tsconfig.base.json`）：
`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`allowImportingTsExtensions`、`rewriteRelativeImportExtensions`、`declaration`、`declarationMap`、`module: esnext`、`moduleResolution: bundler`。
→ 这是「跨包用相对路径 + `.ts` 扩展名 import」的根因。

工作区（`pnpm-workspace.yaml`）：`packages: [packages/sandore/*]`（tool 已在工作区内）。

---

## ② DSH 的 `defineTool` / `ToolDefinition` / `agentCtx.tools.register` 权威形状

参考源码：`D:\project-code\llm\deepseek-harness\packages\core\tools\src\index.ts` 与 `schema.ts`（包名 `@deepseek-ai/dsh-tools`，版本 `0.1.0-rc.6`）。

### 基础类型（来自 `@deepseek-ai/dsh-llm`）

`ToolSchema`（`packages/llm/llm/src/types.ts:312`）：
```ts
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}
```

### `ToolDefinition`（`core/tools/src/index.ts:222`）

```ts
/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition extends ToolSchema {
  /** Mandatory canonical output declaration. */
  readonly output: ToolOutputDefinition
  /** Run one accepted call and return only its canonical lossless-JSON value. */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  /** Synchronous last-mile transform for model-facing content. */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /** Cooperative tool-call timeout budget in milliseconds. Omit for no deadline. */
  timeoutMs?: number
  /** Pure synchronous classifier for overlap with sibling tool calls. */
  isConcurrencySafe?(args: unknown): boolean
  /** Optional pending-state presentation. */
  presentCall?(args: unknown): ToolCallView | undefined
  /** Optional completed-state presentation. */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

`ToolOutputDefinition`（`index.ts:212`）：
```ts
export interface ToolOutputDefinition {
  /** Raw supported JSON Schema enforced against every successful canonical value. */
  readonly schema: JsonSchemaNode
  /** Pure projection from validated arguments and value to Native/model content. */
  render(args: unknown, value: JsonValue): ContentBlock[]
  /** Pure replayable presentation projection, computed only for top-level calls. */
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}
```

### `defineTool`（`core/tools/src/schema.ts:545`）

```ts
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition
```

`DefineToolOptions<S, O>`（`schema.ts:483`）关键字段：
```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  readonly name: string
  readonly description: string
  /** Per-property parameter schema compiled to an implicit open object root. */
  readonly parameters: S
  readonly output: {
    readonly schema: O
    render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue
  }
  readonly timeoutMs?: number
  isConcurrencySafe?(args: InferArgs<S>): boolean
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
}
```

参数/输出 schema 规范（`schema.ts`）：
- `ParameterSchemaSpec = { [key: string]: ParameterPropertySpec; [key: symbol]: never }`
- `ParameterPropertySpec = ValueSchemaSpec & { required?: true }`
- `ValueSchemaSpec` 为判别联合：`{ type: 'string' | 'number' | 'integer' | 'boolean' | 'null' }`、`{ type: 'array'; items? }`、`{ type: 'object'; properties?; additionalProperties: boolean }`、`{ type: 'json' }`、`{ oneOf: [...] }`，并支持注解 `description/title/default/examples`。
- 参数根是「隐式 open object」，required 由每个属性的 `required: true` 注解决定（无顶层 `type: 'object'`）。

### 注册签名：`ctx.tools.register`

`Context` 上通过 Cordis module augmentation 声明 `tools: ToolRuntime`（`index.ts:137-139`）。

`ToolRuntime.register`（`index.ts:1037`）：
```ts
register(definition: ToolDefinition): () => void
```
- **返回值为精确的 disposer**（`() => void`），用于反注册/HMR 清理。
- 校验：`output` 必须声明 `{ schema, render, presentationMeta? }`；`output.schema` 必须是受支持的 JSON Schema（`assertSupportedJsonSchema`）；`timeoutMs` 若给必须为正有限数；名字 `run_code` 为保留名，禁止注册/遮蔽。
- 作用域语义：全局注册，或在「调用方 agent 作用域」注册（scoped tools 遮蔽 global；同层重复名抛错）。注释明确指出「for a per-agent variant, register through that agent's `agent.ctx` instead」（`index.ts:727`）。

### `agentCtx.tools.register`（agent 作用域注册）

- `Agent`（`packages/core/agent/src/runtime-types.ts:64`）含 `readonly ctx: Context`（agent-scoped context，其贡献为 agent-local，disposal 时自动卸载）。
- 受支持的调用点：`AgentSetup = (agentCtx: Context) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void`（`CreateAgentOptions.setup`/`ResumeAgentOptions.setup`，`packages/core/agent/src/index.ts:69`）。setup 里通过 `agentCtx.tools.register(...)` 注册 scoped tool，注册在 `session/created`/`agent/created` 等公告之前完成。
- **sandore 侧本地接缝**：`microflow/src/subagents.ts:60-63` 已声明最小结构面（未引入 dsh-agent 运行时依赖）：
```ts
export interface AgentSetupContext {
  readonly tools: { register(tool: unknown): void };
  readonly systemPrompt: { section(content: string): void };
}
```
并被 `subagents.spec.ts:116` 以 `agentCtx.tools.register({ name: 'sandore_getState' })` 验证——这就是 sandore tool 包注册工具的直接落点接口。

### 权威范例（`packages/jobs/tool-jobs/src/index.ts:302-360`）

```ts
ctx.tools.register(defineTool({
  name: 'job_output',
  description: '...',
  parameters: {
    job_id: { type: 'string', required: true, description: '...' },
    wait: { type: 'boolean', description: '...' },
    timeout_ms: { type: 'number', description: '...' },
  },
  finalizeContent: finalizeTaskContent,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', required: true },
        job: { ...PUBLIC_TASK_SCHEMA, required: true },
      },
    },
    render: (_args, value) => [/* ContentBlock[] */],
  },
  async execute(args, exec) { /* ... 使用 exec.agent / exec.signal ... */ },
  presentCall: args => /* ToolCallView */,
}))
```
`ToolRunContext`/`ToolExecution` 关键运行字段：`callId`、`name`、`arguments`、`agent?`、`signal: AbortSignal`、`parent?`（嵌套/Code Mode）、以及 context deferral 能力。

---

## ③ `SandoreEngine` 8 个实例级方法签名 + 返回值类型

来源：`D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`、`types.ts`。

### 抽象类签名（`seam.ts:72-102`）

`SandoreEngine extends Service`（cordis），构造函数 `super(ctx, 'sandoreEngine')`。实例级方法共 **11** 个（8 个生命周期 + `recoverInstance`/`replyQuestion`/`replyPermission`），目标 8 个的确切签名：

```ts
/** 启动一个新的工作流实例。 */
abstract startInstance(request: DagStartRequest): DagRun
/** 中止一个运行中的工作流实例。 */
abstract abortInstance(instanceId: string): Promise<void>
/** 暂停单个 Step。 */
abstract pauseStep(instanceId: string, stepId: string): Promise<void>
/** 恢复单个 Step（可选附带恢复提示词）。 */
abstract resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>
/** 暂停实例内所有 Step。 */
abstract pauseAllSteps(instanceId: string): Promise<void>
/** 恢复实例内所有 Step（可选附带恢复提示词）。 */
abstract resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>
/** 重试单个 Step。 */
abstract retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void>
/** 查询实例的当前状态快照。 */
abstract getState(instanceId: string): DagInstanceState
```
其余 3 个（一并记录）：`recoverInstance(instanceId): Promise<DagRun>`、`replyQuestion(instanceId, requestId, answers: unknown): Promise<void>`、`replyPermission(instanceId, requestId, reply: 'once'|'always'|'reject'): Promise<void>`。

### 运行时现状（`workflow-engine.ts:131-227`）

`SandoreEngineRuntime`（workflow 默认导出）已实现 `startInstance`/`getState`/`abortInstance`；**其余 8 个**（`recoverInstance`/`replyQuestion`/`replyPermission`/`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`/`retryStep`）当前均抛：
```ts
throw new SandoreError('SandoreEngineRuntime.xxx is not implemented', 'INVALID_OPERATION')
```

### 返回值类型（`types.ts`）

```ts
export interface DagRun { instanceId: string; status: DagRunStatus }
export type DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'

export interface DagStartRequest {
  workflowId: string
  jobId: string
  originalInput: string
  cwd?: string
}

export interface DagInstanceState {
  taskId: string
  jobId: string
  workflowId: string
  status: DagRunStatus
  originalInput: string
  currentStageId: string
  executedSteps: ExecutedStepDefault[]
  stageInfos: StageInfo[]
  pendingQueue: string[]
  createdAt: string
  updatedAt: string
}

export interface ExecutedStepDefault {
  type: 'default'
  id: string
  stepId?: string
  stageId: string
  name: string
  status: StepStatus
  command?: CommandConfig
  inputFrom?: InputFromItem[]
  outputTo?: OutputToItem[]
  passThroughVars?: PassThroughVar[]
  sessionMeta?: StepSessionMeta
  finalizeMeta?: FinalizeMeta
  visitCount: number
  branchMeta?: BranchMeta
  error?: string
  pausedAt?: string
  resumedAt?: string
  resumePrompt?: string
  sessionMessages?: SessionMessage[]
  pauseEntryId?: string
  loopIteration?: number[]
  loopMeta?: BranchMeta
  retryHistory?: RetryRecord[]
  parentSessionId?: string
  output?: ContentBlock[]
}

export interface StageInfo { id: string; name: string; status: StepStatus }

/** 单个 Step 或 Stage 的执行状态。 */
export type StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'
```

其他相关类型：`DagRunInfo`、`StageContract`、`PendingQuestion`、`PendingPermission`、`FinalizeOutcome`、`DagResultInfo`（均在 `types.ts`）。

### 事件接缝（`seam.ts:31-45`）

13 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`），生命周期相关：`sandore/start`、`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`、`sandore/end`、`sandore/aborted` 等。`SandoreEngineStub.inject`（`seam.ts:142`）：`['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions']`；运行时 `SandoreEngineRuntime.inject`（`workflow-engine.ts:139`）：`['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`。

---

## ④ `SandoreError` 形状与捕获/摘要范式

来源：`D:\project-code\llm\sandore\packages\sandore\microflow\src\errors.ts`（workflow 通过 `workflow/src/errors.ts` re-export，保持对外 API 不变）。

### 错误码（`SandoreErrorCode`，13 个）

```ts
export type SandoreErrorCode =
  | 'YAML_PARSE' | 'DEFINITION_INVALID' | 'NODE_NOT_FOUND' | 'CYCLE_DETECTED'   // 定义/解析（fatal）
  | 'STEP_TIMEOUT' | 'STEP_EXECUTION' | 'INVALID_OPERATION' | 'CANCELLED'        // 运行时（fatal）
  | 'FINALIZE_FAILED' | 'GATE_FAILED' | 'SESSION_LOST'                           // 收尾/门禁/会话（fatal）
  | 'PERSISTENCE_FAILED'                                                          // 恢复性（non-fatal）
```

### 类形状

```ts
export class SandoreError extends HarnessError {
  readonly fatal: boolean
  constructor(message: string, code: SandoreErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'SandoreError'
    this.fatal = options?.fatal ?? true
  }
}
export function isFatalSandoreError(error: unknown): boolean {
  return error instanceof SandoreError && error.fatal
}
```

`HarnessError`（`deepseek-harness/packages/llm/llm/src/error.ts:13`）：
```ts
export class HarnessError extends Error {
  readonly code: string
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
```
→ `SandoreError` 实例携带：`code`（稳定、机器可路由）、`message`（人类可读）、`name`（'SandoreError'）、`fatal`（布尔，默认 true）、`cause`（标准 ErrorOptions 链）。

### 捕获与提取 code/message 摘要范式

- **只按 `code` 路由，永不解析 `message`**（errors.ts 注释明确）。
- 提取 code：`err instanceof SandoreError ? err.code : undefined`（见 `workflow/src/remote.spec.ts:76`、`89` 的实际用法）。
- 提取 message：`err.message`（`instanceof Error` 保证存在）。
- fatal 判定：`isFatalSandoreError(error)`；DSH 侧还有 `isHarnessError(value): value is HarnessError`（`dsh-llm/error.ts:161`）与 `errorChain(value): string`（`dsh-llm/error.ts:114`）用于渲染带 cause 链的诊断文本（UI 展示，非路由）。
- 抛错范例：`new SandoreError(\`instance '${instanceId}' not found\`, 'NODE_NOT_FOUND')`；non-fatal 覆盖：`new SandoreError('persist retry', 'PERSISTENCE_FAILED', { fatal: false })`（`schema.spec.ts:30`）。

---

## ⑤ import 依赖关系与 peerDependencies 范式

### 跨包 import 方式

1. **sandore 内部跨包 import 用「相对路径 + `.ts` 扩展名」**（由 `tsconfig.base.json` 的 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` 支撑）：
   - `workflow/src/errors.ts:10` → `export { SandoreError, isFatalSandoreError } from '../../microflow/src/errors.ts'`
   - `workflow/src/seam.ts:13` → `import type { Agent } from '../../microflow/src/subagents.ts'`
2. **外部 DSH 包用包名 import**：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-session`（type-only）、`@deepseek-ai/dsh-storage`、`@deepseek-ai/dsh-subagent` 等。
3. microflow 对 `dsh-subagent`/`dsh-agent` **只声明 peerDeps 不运行时 import**：其 `subagents.ts` 按 DSH 公开 API 复刻最小结构类型（`Agent`/`AgentRegistry`/`SubagentRuntime`/`AgentSetupContext` 等）并声明 `ctx.subagents`/`ctx.agents`/`ctx.subprocess` 上下文键。

### peerDependencies 范式（微流/工作流包）

共性：**外部 DSH 包在 `peerDependencies` 与 `devDependencies` 中成对出现且版本一致**（`@deepseek-ai/dsh-*` 为 `0.1.0-rc.6`，`@deepseek-ai/cordis` 为 `4.0.1`，`@deepseek-ai/schemastery` 为 `3.18.1`）；sandore 内部跨包依赖用 `workspace:*`。

- `microflow/package.json` peerDependencies：
  ```
  @deepseek-ai/cordis: 4.0.1
  @deepseek-ai/dsh-llm: 0.1.0-rc.6
  @deepseek-ai/dsh-subagent: 0.1.0-rc.6
  @deepseek-ai/dsh-agent: 0.1.0-rc.6
  @deepseek-ai/dsh-session: 0.1.0-rc.6
  ```
- `workflow/package.json`：
  - `dependencies`：`yaml: ^2.9.0`、`zod: ^4.4.3`
  - `peerDependencies`：cordis 4.0.1、`@deepseek-ai/dsh-sandore-microflow: workspace:*`、dsh-session / dsh-llm / dsh-typert-protocol / dsh-agent / dsh-storage / dsh-storage-domain / dsh-subagent / dsh-subprocess（0.1.0-rc.6）、schemastery 3.18.1
  - `devDependencies` 与 peerDependencies 镜像一致（含 `workspace:*`）。

### tool 包依赖现状与落点

- `@deepseek-ai/dsh-tools@0.1.0-rc.6` 已存在于 pnpm store（`node_modules/.pnpm/@deepseek-ai+dsh-tools@0.1._d489...`），但**未**在顶层 `node_modules/@deepseek-ai/` 建立符号链接、也**未**被任何包声明为依赖（当前 sandore 根为 private，仅含 tsdown/tsx/vitest/typescript 等 devDeps）。tool 包若要 `import { defineTool } from '@deepseek-ai/dsh-tools'`，需按上述范式在 `peerDependencies` + `devDependencies` 中声明 `@deepseek-ai/dsh-tools: 0.1.0-rc.6`（若需访问 `ctx.sandoreEngine` 还需 workflow 包的 `workspace:*` 依赖或相对路径 import）。
- tool 包当前 package.json 无任何依赖字段，是唯一需要补齐 peerDeps 的空壳。

### 工具注册的最终落点（sandore 内）

- 工具通过 subagent 的 `AgentSetupContext.tools.register(tool)` 接缝（`microflow/src/subagents.ts:60-63`）挂入子代理作用域，`subagents.spec.ts:116` 已验证该接口（`agentCtx.tools.register({ name: 'sandore_getState' })`）。
- 工具体内部调用 `ctx.sandoreEngine`（`seam.ts` 声明的 `SandoreEngine`，注入键见 `SandoreEngineStub.inject`）的 8 个生命周期方法；目前除 `startInstance`/`getState`/`abortInstance` 外其余均抛 `INVALID_OPERATION`（`workflow-engine.ts`），即工具包落地时需依赖 workflow 引擎后续实现这些方法。
