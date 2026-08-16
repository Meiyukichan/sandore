## Exploration Result

> 参考材料配置（`furina config show exploration.reference`）返回空数组 `[]`，无外部参考目录/skill/url 需要遍历。以下结果直接依据 exploreContent 列出的本地权威源码路径逐项核实（sandore 工作区 + `D:\project-code\llm\deepseek-harness` 源码 + pnpm 虚拟存储）。

### ① `packages/sandore/tool` 包现状（空占位，无 src）

路径 `D:/project-code/llm/sandore/packages/sandore/tool/` 下仅两个文件，**无 `src/` 目录、无任何 `.ts` 源码、无 `scripts`/`dependencies`/`peerDependencies`**：

- `package.json`（全文要点）：
  - `"name": "@deepseek-ai/dsh-sandore-tool"`
  - `"version": "0.1.0-rc.6"`
  - `"description": "sandore workflow engine model tools (placeholder)"`
  - `"type": "module"`、`"main": "lib/index.js"`、`"types": "lib/types/index.d.ts"`
  - `exports`：`"."` → `./lib/types/index.d.ts` / `./lib/index.js`；`"./src/*"` → `./src/*`；`"./package.json"`。
  - **无 `scripts`（缺 `typecheck`/`build`）、无 `files` 字段、无任何依赖声明**（对比 microflow/workflow 均有 `scripts.typecheck` 与 `files`）。
- `tsconfig.json`：
  ```json
  {
    "extends": "../../../tsconfig.base.json",
    "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
    "include": ["src"]
  }
  ```
  - 注意：tool 的 `rootDir` 是 `"src"`，而 microflow/workflow 的 `rootDir` 是 `".."`（见下⑤）。`rootDir: "src"` 下若按 microflow/workflow 范式跨包相对导入 `../../workflow/src/...` 会被 tsc 拒绝（源文件落在 rootDir 之外）。
- 根 `tsconfig.base.json` 关键编译选项：`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noImplicitOverride`、`allowImportingTsExtensions: true`、`rewriteRelativeImportExtensions: true`、`declaration`/`sourceMap`/`declarationMap`。
- `pnpm-workspace.yaml`：`packages: [packages/sandore/*]`（tool/microflow/workflow/ui 四包同层）。

### ② DSH 权威 `defineTool` / `ToolDefinition` 真实形状 与 `tools.register` 签名

权威来源：`D:\project-code\llm\deepseek-harness\packages\core\tools\src\index.ts` 与 `src\schema.ts`、`packages\llm\llm\src\types.ts`。

**（a）`ToolSchema`（`ToolDefinition` 继承的基础面，`packages/llm/llm/src/types.ts:312`）**：
```ts
export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}
```

**（b）`ToolDefinition`（`packages/core/tools/src/index.ts:222`，`extends ToolSchema`）**：
```ts
export interface ToolDefinition extends ToolSchema {
  /** 强制的规范输出声明 */
  readonly output: ToolOutputDefinition
  /** execute(args, exec) => 规范 lossless-JSON value */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```
其中 `ToolOutputDefinition`（index.ts:212）：
```ts
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: JsonValue): ContentBlock[]
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}
```
要点：`output`（含 `schema` + `render`）是**必填**字段，`register` 在运行时校验 `output.schema`/`output.render` 存在，否则 `TypeError("tool ... must declare output { schema, render, presentationMeta? }")`。

**（c）`defineTool`（`packages/core/tools/src/schema.ts:545`）签名**：
```ts
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition
```
`DefineToolOptions<S, O>`（schema.ts:483）核心字段：
```ts
{
  readonly name: string
  readonly description: string
  readonly parameters: S            // 每属性带 required: true 标注的隐式 open object
  readonly output: {
    readonly schema: O              // ValueSchemaSpec（type: 'string'|'object'|... 或 oneOf）
    render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    presentationMeta?(args, value): JsonValue
  }
  readonly timeoutMs?: number
  isConcurrencySafe?(args: InferArgs<S>): boolean
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  finalizeContent?(...): ContentBlock[] | undefined
  presentCall?(...): ToolCallView | undefined
  presentResult?(...): ToolResultView | undefined
}
```
`defineTool` 内部把 `parameters` 编译成 JSON Schema（`parameterSchemaSpecToJsonSchema`）、把 `output.schema` 编译成 JSON Schema（`valueSchemaSpecToJsonSchema`），并在 `execute` 包装里先 `validateArgs`（非法参数抛 `ToolArgsError`，code `'INVALID_ARGS'`）再调用户 `execute`。

**（d）`tools.register` 签名（`ToolRuntime.register`，index.ts:1037）**：
```ts
register(definition: ToolDefinition): () => void   // 返回注销该工具的 disposer
```
运行时校验：`output` 缺失/`render` 非函数 → `TypeError`；`timeoutMs` 非正 → `TypeError`；name 为保留名 `run_code`（`RUN_CODE_NAME`）→ `Error`。注册进 `ctx` 所在 scope 层；全局注册在普通 `ctx`，**per-agent 注册经 `agent.ctx.tools.register(...)`**（scoped，可 shadow 全局，同 scope 重名抛 `already registered in this scope`）。

**（e）`ctx.tools` / `agent.ctx` 的类型来源**：
- `packages/core/tools/src/index.ts:137` 声明 `declare module '@deepseek-ai/cordis' { interface Context { tools: ToolRuntime } }`，即 `ctx.tools` 是 `ToolRuntime`。
- DSH `Agent`（`packages/core/agent/src/runtime-types.ts:64`）含 `readonly ctx: Context`，所以 `agent.ctx.tools.register(definition)` 即 scoped 注册。
- `@deepseek-ai/dsh-tools@0.1.0-rc.6` 已存在于 sandore 的 pnpm 虚拟存储（`node_modules/.pnpm/@deepseek-ai+dsh-tools@0.1._d489cb013f2a8725198f1fce9da6f626/...`，当前仅作为传递依赖），其 `package.json` 声明 `dependencies: { "@deepseek-ai/schemastery": "^3.18.1" }` 与一组 `peerDependencies`（cordis `^4.0.1`、dsh-llm/dsh-agent/dsh-session 等 `^0.1.0-rc.6`）。`defineTool`/`ToolDefinition`/`ToolRuntime` 从包根 `.` 导出。

**（f）完整定义范例**（`packages/fs/tool-str-replace-editor/src/index.ts:422`，注册 `ctx.tools.register(defineTool({...}))`）：
```ts
ctx.tools.register(defineTool({
  name: 'str_replace_editor',
  description: config.description,
  parameters: {
    command: { type: 'string', required: true, enum: ['view', 'create', 'str_replace', 'insert'], description: '...' },
    path: { type: 'string', required: true, description: '...' },
    // ...
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    switch (args.command) { /* ... */ }
  },
  presentCall: presentEditorCall,
}))
```
scoped 注册范例（`packages/core/tools/tests/scoped.spec.ts:75` 等）：`scope.ctx.tools.register(tool('mine'))`；内联结构对象（不走 `defineTool`）注册范例（`packages/subagent/tool-subagent-report/tests/tool-subagent-report.spec.ts:102`）：`child.ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`。

**（g）sandore 仓库内已固化的落点文档**（`docs/engine/dsh-workflow.md:349-382`）：明确「`sandore_*` 工具不能写进 agent preset 的 `cordis.yml`（standing mount，无法绑定不同 instanceId），正确做法是 `ctx.agents.create({ setup(agentCtx) })` 的 setup 回调里 `agentCtx.tools.register(defineTool({...}))`，闭包捕获 instanceId」。该文档示例是**草图**——`defineTool({ name, description, parameters: {}, async execute })` 缺了必填的 `output` 字段，真实类型以（b）为准。

### ③ `SandoreEngine` 抽象类的 8 个实例级方法签名 与返回值类型

文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`（`SandoreEngine extends Service`，构造 `super(ctx, 'sandoreEngine')`）。抽象类**共 11 个 abstract 方法**（8 个生命周期 + `recoverInstance`/`replyQuestion`/`replyPermission`）；exploreContent 列出的 8 个（= 8 个 `sandore_*` 工具的转调目标）签名如下：

```ts
abstract startInstance(request: DagStartRequest): DagRun;                                    // 同步，非 Promise
abstract abortInstance(instanceId: string): Promise<void>;
abstract pauseStep(instanceId: string, stepId: string): Promise<void>;
abstract resumeStep(instanceId: string, stepId: string, resumePrompt?: string): Promise<void>;
abstract pauseAllSteps(instanceId: string): Promise<void>;
abstract resumeAllSteps(instanceId: string, resumePrompt?: string): Promise<void>;
abstract retryStep(instanceId: string, stepId: string, mode: 'continue' | 'revert' | 'fork', message: string): Promise<void>;
abstract getState(instanceId: string): DagInstanceState;                                     // 同步，非 Promise
```

（另 3 个：`recoverInstance(instanceId: string): Promise<DagRun>`、`replyQuestion(instanceId, requestId, answers: unknown): Promise<void>`、`replyPermission(instanceId, requestId, reply: 'once'|'always'|'reject'): Promise<void>`。）

关键差异点：`startInstance` 与 `getState` 是**同步**方法，其余 6 个返回 `Promise<void>`；`retryStep` 的 `mode` 是字面量联合 `'continue' | 'revert' | 'fork'`。

返回值类型（`workflow/src/types.ts`）：

- `DagStartRequest`（types.ts:51）：`{ workflowId: string; jobId: string; originalInput: string; cwd?: string }`。
- `DagRun`（types.ts:63）：`{ instanceId: string; status: DagRunStatus }`。
- `DagRunStatus`（types.ts:69）：`'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'`。
- `DagInstanceState`（types.ts:72，`getState` 返回）：
  ```ts
  {
    taskId: string
    jobId: string
    workflowId: string
    status: DagRunStatus            // 注意：实例级状态用 DagRunStatus
    originalInput: string
    currentStageId: string
    executedSteps: ExecutedStepDefault[]
    stageInfos: StageInfo[]
    pendingQueue: string[]
    createdAt: string
    updatedAt: string
  }
  ```
- `ExecutedStepDefault`（types.ts:87）：`{ type: 'default'; id; stepId?; stageId; name; status: StepStatus; command?; inputFrom?; outputTo?; passThroughVars?; sessionMeta?; finalizeMeta?; visitCount; branchMeta?; error?; pausedAt?; resumedAt?; resumePrompt?; sessionMessages?; pauseEntryId?; loopIteration?; loopMeta?; retryHistory?; parentSessionId?; output?: ContentBlock[] }`。
- `StageInfo`（types.ts:116）：`{ id: string; name: string; status: StepStatus }`。
- `StepStatus`（types.ts:123）：`'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`。
- 其它 seam 相关：`StageContract`（types.ts:126）、`PendingQuestion`（types.ts:150，含 `id/stageId/stepId/sessionId/requestId/questions/status/answer?`）、`PendingPermission`（types.ts:168）、`DagResultInfo`（types.ts:183）。

补充：真实运行时 `SandoreEngineRuntime`（`workflow/src/workflow-engine.ts:131`）目前仅实现 `startInstance`/`getState`/`abortInstance`，其余 8 个抛 `SandoreError('... not implemented', 'INVALID_OPERATION')`；`getState` 内部经 `toDagInstanceState(state: WorkflowTaskState)`（workflow-engine.ts:107）把持久化 `WorkflowTaskState` 投影为 `DagInstanceState`（仅字段子集 + `executedSteps` 结构兼容断言）。`SandoreEngineStub`（seam.ts:134）11 个方法抛普通 `Error('... is not implemented')`，`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain','agents','userQuestions']`，`static Config` schema 含 `defaultTimeoutMs/defaultModel` 等。

### ④ microflow 的 `SandoreError` 形状 与 code/message 提取

权威实现：`D:/project-code/llm/sandore/packages/sandore/microflow/src/errors.ts`（`workflow/src/errors.ts` 仅 re-export）。

```ts
export type SandoreErrorCode =
  | 'YAML_PARSE' | 'DEFINITION_INVALID' | 'NODE_NOT_FOUND' | 'CYCLE_DETECTED'
  | 'STEP_TIMEOUT' | 'STEP_EXECUTION' | 'INVALID_OPERATION' | 'CANCELLED'
  | 'FINALIZE_FAILED' | 'GATE_FAILED' | 'SESSION_LOST'
  | 'PERSISTENCE_FAILED';          // 唯一标记为 non-fatal 的恢复性错误

export class SandoreError extends HarnessError {
  readonly fatal: boolean;
  constructor(message: string, code: SandoreErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options);
    this.name = 'SandoreError';
    this.fatal = options?.fatal ?? true;   // 默认 fatal=true
  }
}
export function isFatalSandoreError(error: unknown): boolean {
  return error instanceof SandoreError && error.fatal;
}
```

`HarnessError`（`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\error.ts:13`）：
```ts
export class HarnessError extends Error {
  readonly code: string                 // 稳定机器可路由码；注释明示「route on this, never by parsing message」
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
```

因此 `SandoreError` 实例同时具备：`.code`（`SandoreErrorCode`）、`.message`（继承自 `Error`）、`.name`（`'SandoreError'`）、`.fatal`（boolean）。

**捕获/提取 code/message 摘要的既有范式**：
- code 提取（`workflow/src/remote.spec.ts:76`、`89`）：`return err instanceof SandoreError ? err.code : undefined`。
- 通用可读 message 摘要（`workflow/src/workflow-engine.ts:54`）：`function renderError(error: unknown): string { return error instanceof Error ? error.message : String(error) }`。
- fatal 判定（用于组合子决定 re-throw 还是映射为 null）：`isFatalSandoreError(error)`。
- 业务侧抛出范式（`workflow/src/remote.ts:226` 等）：`throw new SandoreError(\`workflow '...' does not exist\`, 'INVALID_OPERATION')`。

对 tools-01 的落点意义（来自 `furina/changes/task-4-lifecycle/specs/orchestrator-tools/spec.md` 的「工具错误透传」场景）：工具 `execute` 内捕获 engine 抛出的 `SandoreError` 后返回 `{ code: err.code, message: err.message }` 摘要（或 `renderError` 风格的字符串），而非裸抛，使主代理可向用户解释。

### ⑤ 包间 import 依赖关系与 peerDependencies 范式

**源码级 import 关系（sandore 四包间，全部用相对路径源码导入，非包名导入）**：
- workflow → microflow（运行时值 + type）：`workflow/src/errors.ts` `export { SandoreError, isFatalSandoreError } from '../../microflow/src/errors.ts'`；`workflow/src/dag-navigator.ts`、`workflow/src/workflow-engine.ts`、`workflow/src/seam.ts` 分别 `import ... from '../../microflow/src/*.ts'`。
- microflow → workflow（**仅 `import type`**，无运行时值反向依赖）：`microflow/src/*.ts` 大量 `import type { ... } from '../../workflow/src/types.ts' / schema.ts / shell.ts / dag-navigator.ts'`。microflow 包入口注释明确「运行时依赖方向为 workflow → microflow；microflow 对 workflow 仅 import type 结构类型」。
- 测试用 mock：`workflow/tests/mocks/*.ts` 被 microflow spec 经 `../../workflow/tests/mocks/*.ts` 相对导入。
- 无一处在源码里 `import ... from '@deepseek-ai/dsh-sandore-*'` 或 `import ... from '@deepseek-ai/dsh-tools'`（`@deepseek-ai/dsh-tools` 仅出现在 pnpm-lock 的传递依赖里，未在任何包 package.json 声明）。

**peerDependencies 范式（三个包对比）**：

- `microflow/package.json`：无 `dependencies`；`peerDependencies` 全部为精确版本 `"4.0.1"`（cordis）或 `"0.1.0-rc.6"`（dsh-llm / dsh-subagent / dsh-agent / dsh-session）；`devDependencies` 与 peerDependencies 完全一致（本地类型解析用）；`scripts` 仅 `"typecheck": "tsc --noEmit"`；含 `files` 字段；`exports` 含 `"./src/*"` 与 `"./package.json"`。
- `workflow/package.json`：有 `dependencies`（`yaml ^2.9.0`、`zod ^4.4.3`）；`peerDependencies` 中 cordis 用精确 `"4.0.1"`、schemastery 用精确 `"3.18.1"`、其余 dsh-* 用 `"0.1.0-rc.6"`，且**内部包用 `"@deepseek-ai/dsh-sandore-microflow": "workspace:*"`**；`devDependencies` 与 peerDependencies 完全一致；`exports` 额外有 `"./types"` 子路径。
- `tool/package.json`：**两者都无**（无 `dependencies`/`peerDependencies`/`devDependencies`/`scripts`/`files`）——这是 tools-01 落地时需要按上述范式补齐的部分。

**tsconfig 差异（影响跨包导入范式）**：microflow/workflow 的 `rootDir: ".."`（允许 `../../microflow/src/*` 跨包源码导入）；tool 目前 `rootDir: "src"`（若沿用跨包相对导入需调整，见①）。

**sandore 对 DSH 外部包的依赖均为 peerDependencies（由宿主 DSH host 运行时注入），无一作为 `dependencies`**；sandore 自身可 `import` 的权威外部类型/运行时的来源包名即这些 peer 名（如 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-agent` 等）。

## Supplementary Exploration Result

无需补充探索。`experimental.websearch=true`、`experimental.context7=true` 仅当 Phase 3 结果为空或不足以参考时启用；本次 Phase 3 已从本地权威源码（sandore 工作区、`D:\project-code\llm\deepseek-harness\packages\core\tools`、`packages\llm\llm`、pnpm 虚拟存储中的 `@deepseek-ai/dsh-tools@0.1.0-rc.6`）完整取得全部 5 项事实（工具包现状、defineTool/ToolDefinition/register 签名与范例、seam 8 方法签名与返回值类型、SandoreError 形状与提取范式、包间依赖与 peerDependencies 范式），信息充分，故未触发 websearch/context7。
