## Exploration Result

Phase 3（furina-codebase 遍历 `codebases` 列表）：`furina config show project.sourcecode codebases` 返回
`project.sourcecode=src/`、`codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`。
经核实 `D:\project-code\llm\sandore\docs\codebase` 为**空目录**（无任何文件），故本轮 codebases 遍历无返回结果，全部发现来自 Phase 4 补充探索。

## Supplementary Exploration Result

> 说明：`project.sourcecode = src/` 但当前仓库 `src/` 目录不存在，实际源码位于 `packages/sandore/{microflow,workflow,tool,ui}`。下文所有路径为绝对路径。

### 需求理解（Phase 2）

- **What**：Task 4 `tools-01` 需在 sandore 新增/落地 `packages/sandore/tool` 包——用 DSH `defineTool` 形状导出 8 个 `sandore_*` 编排器工具工厂 `createSandoreTools({ instanceId, engine })`，经宿主主代理的 `setup(agentCtx)` 回调内 `agentCtx.tools.register` 逐个注册，每个工具的 `execute` 转调 `SandoreEngine` 对应实例级方法并闭包捕获 `instanceId`。
- **Boundaries**：探索范围限定为 sandore 仓内 `tool` 包现状、`workflow/src/seam.ts` 的 8 个实例级方法签名、`workflow/src/types.ts` 返回值类型、`microflow/src/errors.ts` 的 `SandoreError` 形状、三个包的 import/peerDependencies 范式；以及 DSH 参考源码 `deepseek-harness/packages/core/tools`（`defineTool`/`ToolDefinition`/`ctx.tools.register` 权威形状）与 `packages/llm/llm/src/error.ts`（`HarnessError`）。
- **Goal**：查明「工具定义/注册 API 的真实形状」与「工具落点（tool 包 → workflow 引擎 → agent setup 注册）」，为 tools-01 提供事实依据（仅探索，不做实现）。
- **Project Context**：tool 包是 sandore 的第 3 个包（现已有 `microflow`/`workflow`/`ui`）。运行时依赖方向已统一为 workflow → microflow（workflow 通过 re-export 保持对外 API，microflow 对 workflow 仅 `import type`）。tool 包预期作为新叶子包，被 workflow 引擎（host-agent 场景）引用，经 `agents.create/resume({ setup })` 把工具注册到 per-instance 主代理。

---

### 一、`packages/sandore/tool` 包现状（①）

路径：`D:\project-code\llm\sandore\packages\sandore\tool`

该包当前为**占位骨架**：仅有 `package.json` 与 `tsconfig.json` 两个文件，**无 `src/`、无 `lib/`、无 `node_modules/`、无 `tests/`**。

**`tool/package.json`（共 17 行，全文）**：
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
注意：**无 `dependencies`/`peerDependencies`/`devDependencies`/`scripts`/`files`** 字段（与 microflow/workflow 的成熟 package.json 不同，见第五节）。

**`tool/tsconfig.json`（共 8 行，全文）**：
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
关键差异：`tool` 的 `rootDir` 为 **`"src"`**，而 `microflow`/`workflow` 的 `rootDir` 为 **`".."`**（`D:\project-code\llm\sandore\packages\sandore\microflow\tsconfig.json`、`workflow\tsconfig.json` 均为 144 字节，`rootDir: ".."`）。后者之所以用 `".."`，是因为 microflow 存在跨包源码 import（`../../workflow/src/schema.ts`）需要把根目录上抬到 `packages/sandore`。tool 包若需跨包 `import type` workflow 的 `SandoreEngine`/`DagInstanceState` 等类型，同样需要把 `rootDir` 上抬为 `".."`（这是事实观察，不构成实现建议）。

根 `tsconfig.base.json`（`D:\project-code\llm\sandore\tsconfig.base.json`）关键编译项：`target: es2024`、`module: esnext`、`moduleResolution: bundler`、`strict: true`、`exactOptionalPropertyTypes: true`、`noUncheckedIndexedAccess: true`、`noImplicitOverride: true`、`allowImportingTsExtensions: true`、`rewriteRelativeImportExtensions: true`、`declaration: true`。根 `package.json` 的 `packageManager: pnpm@11.7.0`，`pnpm-workspace.yaml` 的 workspaces 为 `packages/sandore/*`。

---

### 二、DSH 的 `defineTool` / `ToolDefinition` 真实形状与 `ctx.tools.register` 签名（②）

参考仓库根：`D:\project-code\llm\deepseek-harness`。工具定义/注册的权威实现位于 `packages/core/tools`（包名 `@deepseek-ai/dsh-tools`，`version 0.1.0-rc.5`，`D:\project-code\llm\deepseek-harness\packages\core\tools\package.json`）。

#### 2.1 `ToolSchema`（`defineTool` 返回值的基础层，来自 `@deepseek-ai/dsh-llm`）

`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\types.ts:312-317`：
```ts
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}
```

#### 2.2 `ToolDefinition`（注册时传给 `register` 的完整形状）

`D:\project-code\llm\deepseek-harness\packages\core\tools\src\index.ts:222-288`：
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
其中 `ToolOutputDefinition`（`index.ts:212-219`）：
```ts
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: JsonValue): ContentBlock[]
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}
```

#### 2.3 `defineTool` 与 `DefineToolOptions`（权威定义）

`D:\project-code\llm\deepseek-harness\packages\core\tools\src\schema.ts:545-547`：
```ts
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition
```

`DefineToolOptions<S, O>`（`schema.ts:483-536`）字段全集：
```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  readonly name: string
  readonly description: string
  readonly parameters: S                       // 按属性声明的参数 schema，编译为隐式 open object 根
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
要点：`execute` 的入参 `args` 是**按 `parameters` 推断出的强类型对象**；返回值必须匹配 `output.schema`；`output.render` 是把校验后的 canonical value 投影为 `ContentBlock[]` 的**纯函数**（必填）。

`ParameterSchemaSpec`（`schema.ts:103-106`）：
```ts
export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}
```
`ParameterPropertySpec = ValueSchemaSpec & { required?: true }`（`schema.ts:97`）。

`ValueSchemaSpec`（`schema.ts:85-94`）是判别联合：`StringValueSchemaSpec | NumberValueSchemaSpec | IntegerValueSchemaSpec | BooleanValueSchemaSpec | NullValueSchemaSpec | ArrayValueSchemaSpec | ObjectValueSchemaSpec | JsonValueSchemaSpec | OneOfValueSchemaSpec`（`string`/`number`/`integer`/`boolean`/`null`/`array`/`object`/`json`/`oneOf`，各带 `description?/title?/default?/examples?` 注解，标量另带 `enum`/`const`）。

`InferArgs<S>`（`schema.ts:175`）/`InferValue<S>`（`schema.ts:172`）：按 schema 推断 TS 类型（最多 16 层容器深度后回退 `JsonValue`）。

#### 2.4 `ctx.tools.register` 签名与 `tools` 服务

`D:\project-code\llm\deepseek-harness\packages\core\tools\src\index.ts`：
- 服务声明（`index.ts:138-139`）：`declare module '@deepseek-ai/cordis' { interface Context { tools: ToolRuntime } }`。
- `ToolRuntime extends Service`，构造 `super(ctx, 'tools')`（`index.ts:787`、`index.ts:827`）。
- **`register` 方法（`index.ts:1037-1062`）签名**：
  ```ts
  register(definition: ToolDefinition): () => void
  ```
  语义：全局或「调用者 agent 作用域」内注册；作用域内注册会遮蔽全局同名工具；返回**精确 disposer**（取消注册用）。运行时会校验 `output { schema, render, presentationMeta? }` 必须存在且 `render`/`presentationMeta` 为函数，`timeoutMs` 必须为正有限数，`run_code` 为保留名。

#### 2.5 权威范例（`ctx.tools.register(defineTool({...}))` 真实用法）

`D:\project-code\llm\deepseek-harness\packages\goal\tool-goal\src\index.ts:195-232`（`get_goal`/`create_goal` 注册片段）：
```ts
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'get_goal',
    description: GET_DESCRIPTION,
    parameters: {},
    output: GOAL_OUTPUT,
    execute(_args, exec) {
      const execution = goalToolExecution(ctx, exec)
      return Promise.resolve(goalValue(ctx.goals.get(execution.agent)))
    },
    presentCall: () => present('Read current goal', 'read'),
  }))
  ctx.tools.register(defineTool({
    name: 'create_goal',
    description: CREATE_DESCRIPTION,
    parameters: {
      objective: { type: 'string', required: true, description: '...' },
      max_goal_rounds: { type: 'number', description: '...' },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) { /* ... */ },
    presentCall: args => present('Create goal', 'other', args.objective),
  }))
}
```

#### 2.6 「agentCtx.tools.register」术语对应关系

DSH 源码中无名为 `agentCtx.tools.register` 的**内置** API；「agentCtx」是 agent factory 的 `setup(agentCtx: Context)` 回调入参（`export type AgentSetup = (agentCtx: Context) => ...`，见 `tool-cordis/src/api-catalog.ts:2642` 与 `packages/core/agent`）。该 `agentCtx` 是作用域化 Context，其上 `agentCtx.tools.register(definition)` 即 `ToolRuntime.register`（作用域内注册）。sandore 侧已在 `microflow/src/subagents.ts` 复刻了它的最小结构面（见第四节「落点」）。

---

### 三、`workflow/src/seam.ts` 的 `SandoreEngine` 8 个实例级方法签名与 `types.ts` 返回类型（③）

路径：`D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`（共 187 行）

`SandoreEngine` 抽象类（`extends Service`，构造 `super(ctx, 'sandoreEngine')`）共 **11 个抽象实例级方法**。tools-01 关注的 8 个方法（转调目标）精确签名如下：

| 方法 | 签名（seam.ts 行号） |
|---|---|
| `getState` | `abstract getState(instanceId: string): DagInstanceState;`（第 101 行） |
| `startInstance` | `abstract startInstance(request: DagStartRequest): DagRun;`（第 78 行） |
| `abortInstance` | `abstract abortInstance(instanceId: string): Promise<void>;`（第 82 行） |
| `pauseStep` | `abstract pauseStep(instanceId: string, stepId: string): Promise<void>;`（第 90 行） |
| `resumeStep` | `abstract resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>;`（第 92 行） |
| `pauseAllSteps` | `abstract pauseAllSteps(instanceId: string): Promise<void>;`（第 94 行） |
| `resumeAllSteps` | `abstract resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>;`（第 96 行） |
| `retryStep` | `abstract retryStep(instanceId: string, stepId: string, mode: 'continue' \| 'revert' \| 'fork', message: string): Promise<void>;`（第 98 行） |

（其余 3 个方法：`recoverInstance(instanceId): Promise<DagRun>`、`replyQuestion(instanceId, requestId, answers: unknown): Promise<void>`、`replyPermission(instanceId, requestId, reply: 'once'|'always'|'reject'): Promise<void>`。）

`SandoreEngineStub.static inject`（第 142 行）当前为 **9 项**：
`['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain', 'agents', 'userQuestions']`。
`declare module '@deepseek-ai/cordis' { interface Context { sandoreEngine: SandoreEngine; userQuestions: UserQuestions } }`（第 25-29 行）。seam.ts 顶部还有 `import type { Agent } from '../../microflow/src/subagents.ts';`（第 13 行）。

**`workflow/src/types.ts` 相关返回值类型**（`D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts`，共 189 行）：

- `DagRun`（第 63-66 行）：`{ instanceId: string; status: DagRunStatus }` —— `startInstance` 返回。
- `DagRunStatus`（第 69 行）：`'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'`（7 态）。
- `DagStartRequest`（第 51-60 行）：`{ workflowId: string; jobId: string; originalInput: string; cwd?: string }`。
- `DagInstanceState`（第 72-84 行）—— `getState` 返回：
  ```ts
  interface DagInstanceState {
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
  ```
  （browser-safe 投影，**不含** `pendingInteractions`/`pausedChildIds`；`taskId` 即实例 ID。）
- `StepStatus`（第 123 行）：`'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`。
- `StageInfo`（第 116-120 行）：`{ id: string; name: string; status: StepStatus }`。
- `ExecutedStepDefault`（第 87-113 行）：含 `type:'default'`、`id`、`stepId?`、`stageId`、`name`、`status: StepStatus`、`command?`、`inputFrom?`、`outputTo?`、`passThroughVars?`、`sessionMeta?`、`finalizeMeta?`、`visitCount`、`branchMeta?`、`error?`、`pausedAt?`、`resumedAt?`、`resumePrompt?`、`sessionMessages?`、`pauseEntryId?`、`loopIteration?`、`loopMeta?`、`retryHistory?`、`parentSessionId?`、`output?: ContentBlock[]`。

---

### 四、microflow 的 `SandoreError` 形状与 code/message 提取（④）

实现：`D:\project-code\llm\sandore\packages\sandore\microflow\src\errors.ts`（共 63 行）。
Re-export：`D:\project-code\llm\sandore\packages\sandore\workflow\src\errors.ts`（仅 `export { SandoreError, isFatalSandoreError } from '../../microflow/src/errors.ts'; export type { SandoreErrorCode } ...`，保持 workflow 对外 API 不变）。

**`SandoreErrorCode`（errors.ts:20-36，共 13 个码）**：
```ts
type SandoreErrorCode =
  | 'YAML_PARSE' | 'DEFINITION_INVALID' | 'NODE_NOT_FOUND' | 'CYCLE_DETECTED'   // 定义/解析（fatal）
  | 'STEP_TIMEOUT' | 'STEP_EXECUTION' | 'INVALID_OPERATION' | 'CANCELLED'       // 运行时（fatal）
  | 'FINALIZE_FAILED' | 'GATE_FAILED' | 'SESSION_LOST'                          // 收尾/门禁/会话（fatal）
  | 'PERSISTENCE_FAILED'                                                        // 恢复性（non-fatal）
```

**`SandoreError` 类（errors.ts:45-54）**：
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

**`HarnessError` 基类（DSH）**：`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\error.ts:13-22`：
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

**捕获并提取 code/message 摘要的事实**：
- `SandoreError` 实例暴露 `code`（`SandoreErrorCode`）、`message`（`string`）、`name`（`'SandoreError'`）、`fatal`（`boolean`，默认 `true`），并继承 `Error.stack` 与 `ErrorOptions.cause`（若传入）。
- 判定方式：`error instanceof SandoreError`（等价命中 `instanceof HarnessError`）；「路由只按 `code`、永不按 `message`」是 DSH 约定（`HarnessError.code` 注释明确）。
- 现有可复用摘要助手：`D:\project-code\llm\sandore\packages\sandore\microflow\src\internal.ts:15-17` 的 `describeError(error: unknown): string` 仅返回 `error instanceof Error ? error.message : String(error)`，**不提取 `code`**（该函数不 re-export，属包内私有）。
- 工具侧错误透传需求（spec `orchestrator-tools`）：engine 抛出的 `SandoreError` 摘要应转为结构化错误结果返回给主代理。

---

### 五、tool 包与其他包的 import 依赖关系与 peerDependencies 范式（⑤）

#### 5.1 现有跨包 import 关系（事实）

- **workflow → microflow（运行时）**：
  - `workflow/src/errors.ts`：`import { ... } from '../../microflow/src/errors.ts'`（re-export）。
  - `workflow/src/seam.ts:13`：`import type { Agent } from '../../microflow/src/subagents.ts';`。
- **microflow → workflow（仅 type）**：
  - `microflow/src/step-runner.ts:31-32`：`import type { CommandConfig, WorkflowStep } from '../../workflow/src/schema.ts';`、`import type { ShellExecRequest, ShellRunResult, SubprocessSpawnSpec } from '../../workflow/src/shell.ts';`。
  - 依赖方向注释（microflow `index.ts`）：运行时方向统一为 workflow → microflow；microflow 对 workflow 仅 `import type` 结构类型。
- **tool 包**：当前无任何源码、无任何 import，也**未被任何包引用**（grep `sandore-tool` 在 `packages/sandore` 的 `.ts` 文件中无命中）。

#### 5.2 peerDependencies 写法范式（参考 microflow/workflow）

`D:\project-code\llm\sandore\packages\sandore\microflow\package.json`（共 39 行）：
```jsonc
"scripts": { "typecheck": "tsc --noEmit" },
"peerDependencies": {
  "@deepseek-ai/cordis": "4.0.1",
  "@deepseek-ai/dsh-llm": "0.1.0-rc.6",
  "@deepseek-ai/dsh-subagent": "0.1.0-rc.6",
  "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
  "@deepseek-ai/dsh-session": "0.1.0-rc.6"
},
"devDependencies": { /* 与 peerDependencies 完全同 key 同 value */ }
```

`D:\project-code\llm\sandore\packages\sandore\workflow\package.json`（共 59 行）：
```jsonc
"dependencies": { "yaml": "^2.9.0", "zod": "^4.4.3" },
"peerDependencies": {
  "@deepseek-ai/cordis": "4.0.1",
  "@deepseek-ai/dsh-sandore-microflow": "workspace:*",   // ← 同仓跨包用 workspace:*
  "@deepseek-ai/dsh-session": "0.1.0-rc.6",
  "@deepseek-ai/dsh-llm": "0.1.0-rc.6",
  "@deepseek-ai/dsh-typert-protocol": "0.1.0-rc.6",
  "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
  "@deepseek-ai/dsh-storage": "0.1.0-rc.6",
  "@deepseek-ai/dsh-storage-domain": "0.1.0-rc.6",
  "@deepseek-ai/dsh-subagent": "0.1.0-rc.6",
  "@deepseek-ai/dsh-subprocess": "0.1.0-rc.6",
  "@deepseek-ai/schemastery": "3.18.1"
},
"devDependencies": { /* 同 key 同 value */ }
```
范式要点：`peerDependencies` 与 `devDependencies` **同 key 同 value 成对声明**；同仓内包用 `workspace:*`；DSH 外部包用精确 `x.y.z-rc.N`；`cordis` 固定 `4.0.1`、`schemastery` 固定 `3.18.1`；`files` 字段列出 `lib/index.js` 与 `lib/types/**/*.{js,d.ts}`；`type: "module"`、`main: lib/index.js`、`types: lib/types/index.d.ts`。

#### 5.3 tool 包的目标依赖事实（仅现状陈述）

- `@deepseek-ai/dsh-tools`（`defineTool`/`ToolDefinition` 所在包）版本 `0.1.0-rc.6` **已存在于 sandore 的 `pnpm-lock.yaml`**（第 588、2419 行等 9 处，作为已安装 DSH 包如 `dsh-agent`/`dsh-credentials` 的 peerDependency 传递解析进来）。因此工作区内 `@deepseek-ai/dsh-tools` 可用。
- tool 包当前 `package.json` **尚无** `peerDependencies`/`devDependencies`（见第一节），`tsconfig.json` 的 `rootDir` 为 `"src"`（与 microflow/workflow 的 `".."` 不同）。

#### 5.4 工具注册落点（sandore 侧最小结构面）

`D:\project-code\llm\sandore\packages\sandore\microflow\src\subagents.ts` 已复刻「agentCtx 最小面」（第 59-68 行）：
```ts
export interface AgentSetupContext {
  readonly tools: { register(tool: unknown): void };        // ← 当前入参为 unknown，spec 期望 defineTool 形状
  readonly systemPrompt: { section(content: string): void };
}
export type AgentSetup = (
  agentCtx: AgentSetupContext,
) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void;
```
且 `CreateAgentOptions.setup?: AgentSetup`（第 84 行）与 `ResumeAgentOptions.setup?: AgentSetup`（第 92 行）已存在。spec `orchestrator-tools`/`host-agent` 明确：8 个 `sandore_*` 工具经宿主主代理 `agents.create({ setup })`/`agents.resume({ setup })` 的 `setup(agentCtx)` → `agentCtx.tools.register` 注册（per-instance 闭包），不进行全局 `ctx.tools` standing 注册。当前 `step-runner.ts` 的 `runSubagent`（`step-runner.ts:431-465`）走 `ctx.subagents.startContinuable` 且**未传 `setup`**（`ContinuableStartSpec` 无 setup 字段），工具注册不发生在 Step 子代理路径上。
