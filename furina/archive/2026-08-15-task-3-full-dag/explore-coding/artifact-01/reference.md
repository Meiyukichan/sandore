## Exploration Result

> 探索范围严格限定在 exploreContent 的 4 项：`ctx.fs` 类型形状、microflow 导出结构与编码范式、workflow 类型形状、测试范式。以下结论均来自真实源码，逐条标注源文件绝对路径。

---

### 1. DSH 源码中 `ctx.fs` 的真实类型形状

#### 1.1 源码位置与包信息

- Service Definition（抽象类 + Context 增强）：`D:/project-code/llm/deepseek-harness/packages/fs/fs/src/index.ts`
- 词汇类型（FsTarget / FsInfo / FsDirEntry / FsWriteIntent / FsError 等）：`D:/project-code/llm/deepseek-harness/packages/fs/fs/src/types.ts`
- 本地后端实现（真实行为参考）：`D:/project-code/llm/deepseek-harness/packages/fs/fs-local/src/index.ts`（`@deepseek-ai/dsh-fs-local`）
- 模型侧工具层消费示例：`D:/project-code/llm/deepseek-harness/packages/fs/tool-fs/src/read.ts`、`write.ts`
- 沙箱策略类型：`D:/project-code/llm/deepseek-harness/packages/sandbox/sandbox/src/index.ts`（`@deepseek-ai/dsh-sandbox`）
- 包名：`@deepseek-ai/dsh-fs`，版本 `0.1.0-rc.5`（源仓库 `D:/project-code/llm/deepseek-harness` 整体版本 `0.1.0-rc.5`）

**关键版本/依赖事实**：`@deepseek-ai/dsh-fs` **不在 sandore 的 node_modules 中**，也不在 `packages/sandore/workflow/package.json` 的 peerDependencies 里（其 peerDeps 为 cordis / dsh-sandore-microflow / dsh-session / dsh-llm / dsh-typert-protocol / dsh-agent / dsh-storage / dsh-storage-domain / dsh-subagent / dsh-subprocess / schemastery）。当前 `workflow-engine.ts` 与 `seam.ts` 仅以字符串 `'fs'` 写入 `static inject`，测试中以 `ctx.provide('fs', {})` 空对象占位（`workflow-engine.spec.ts:165`）。sandore 对「未安装 DSH 服务」的既定范式见 `workflow/src/shell.ts`：本地复刻最小结构类型 + `declare module '@deepseek-ai/cordis' { interface Context { shell: ShellExecutor } }`。file-utils 访问 `ctx.fs` 时应沿用同一范式（本地 `FileSystem` 形状接缝 + Context 增强），而非引入 `@deepseek-ai/dsh-fs` 包级依赖（除非显式新增 peerDependency）。

#### 1.2 Context 键与事件

`packages/fs/fs/src/index.ts` 中：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FileSystem
  }
  interface Events {
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>   // waterfall
    'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>   // waterfall
    'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void   // emit
  }
}
```

`FileSystem` 抽象类 `extends Service`，构造为 `super(ctx, 'fs')`。

#### 1.3 FileSystem 全部方法签名（精确）

```ts
export abstract class FileSystem extends Service {
  get sandboxMode(): SandboxMode | undefined

  abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  abstract processPath(target: FsTarget): string
  abstract fileUrl(target: FsTarget): string
  abstract contains(parent: FsTarget, child: FsTarget): boolean

  abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>

  abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>

  abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
  abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
}
```

**对 file-utils 的硬约束（与 exploreContent 假设的差异）**：

1. **`resolve` 返回 `FsTarget`，不是字符串路径**。`FsTarget = { targetKey: FsTargetKey; displayPath: string }`，`targetKey` 是 `Branded<'FsTargetKey'>` 的不透明标识（文档明确「消费者不得解析它，不得假设是本地绝对路径」）。取「可展示/可拼接的路径」应使用 `target.displayPath`；取「进程可打开的绝对路径」应使用 `processPath(target)`（本地后端 `processPath(target) = String(target.targetKey)`，即 realpath）。
2. **`readText`/`listDir`/`stat` 的入参是 `FsTarget`（先 `resolve` 得到），不是 `string` 路径**。签名顺序是 `(target, signal?)`。
3. **没有 `walkDir` 方法**。`listDir` 只列一层（README 明确「Twelve primitives only — no delete/rename/copy/watch；`listDir` is single-level，recursion/globbing/pagination/search 不在范围内」）。walkDir 必须在 file-utils 内部用 `resolve` + `listDir` 递归实现：对 `listDir` 返回的每个 `FsDirEntry`，当 `entry.type === 'directory'` 时用 `entry.target` 递归。
4. **`writeText` 是原子写入**，返回 `FsWriteOutcome`（非 void）；`expected?: FsWriteIntent` 用于「读后写」守卫（stale 保护），省略即无条件覆盖。
5. **`stat` 返回 `FsInfo | undefined`**（`undefined` 表示目标不存在），`FsInfo.type` 为 `'file' | 'directory' | 'other'`。
6. **`lstat` 是路径形态**（`lstat(path, opts?, signal?)`），`FsPathInfo.type` 多一个 `'symlink'`，供信任边界前拒绝符号链接。

#### 1.4 关键词汇类型（`packages/fs/fs/src/types.ts`）

```ts
export type FsTargetKey = Branded<'FsTargetKey'>
export type FsVersion = Branded<'FsVersion'>

export interface FsTarget {
  targetKey: FsTargetKey
  displayPath: string
}

export interface FsInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}

export interface FsPathInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
}

export interface FsDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: FsTarget
  version?: FsVersion
  size?: number
}

export type FsObservation =
  | { readonly kind: 'present'; readonly version: FsVersion }
  | { readonly kind: 'absent' }

export type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }

export interface FsWriteOutcome {
  operation: 'create' | 'update'
  version: FsVersion
  before: string | null
  after: string
}

export interface FsEditRequest {
  oldString: string
  newString: string
  replaceAll: boolean
}

export interface FsEditOutcome {
  version: FsVersion
  before: string
  after: string
}

export type FsErrorCode =
  | 'FS_NOT_FOUND' | 'FS_NOT_DIRECTORY' | 'FS_NOT_TEXT' | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE' | 'FS_PERMISSION_DENIED' | 'FS_SANDBOX_DENIED' | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION' | 'FS_NOT_OBSERVED' | 'FS_AMBIGUOUS_EDIT' | 'FS_EDIT_NOT_FOUND' | 'FS_ABORTED'

export class FsError extends HarnessError {
  override readonly code: FsErrorCode
}
```

#### 1.5 沙箱策略（`writeText`/`editText` 第 5 参）

`packages/sandbox/sandbox/src/index.ts`：

```ts
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  sessionId?: SessionId
}
```

#### 1.6 真实消费范式（tool-fs，供 file-utils 对齐）

`read.ts`（`ctx.fs.readText` 用法）：

```ts
const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)  // 内部 = ctx.fs.resolve + ctx.fs.stat
const chunks = info.size === undefined || info.size >= caps.streamMinSize
  ? await ctx.fs.streamText(target, exec.signal)
  : [await ctx.fs.readText(target, exec.signal)]
ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
```

`write.ts`（`ctx.fs.writeText` 用法）：

```ts
const target = await ctx.fs.resolve(input.filePath, { cwd })
const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
const outcome = await ctx.fs.writeText(target, input.content, intent, exec.signal, sandboxPolicy)
ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
```

要点：`resolve` 相对路径基于 `opts.cwd`（本地后端缺省 `process.cwd()`）；`readText` 前先 `stat` 分型（目录/特殊文件要拒绝）；写前 `waterfall('fs/write-intent', …)` 拿守卫意图。

---

### 2. microflow 包导出结构与编码范式

#### 2.1 导出结构（`D:/project-code/llm/sandore/packages/sandore/microflow/src/index.ts`）

```ts
export * from './errors.ts';
export * from './step-runner.ts';
export * from './stage-executor.ts';
export * from './subagents.ts';
```

- `internal.ts` **不进入公开 API**（文件头注释明确「`describeError`/`textSummary` 仅供本包内部模块 `stage-executor.ts` 复用，不从 `index.ts` re-export」）。file-utils 若作为 microflow 内部工具，同 `internal.ts` 一样不导出；若要公开则须在 `index.ts` 显式 `export *`。

#### 2.2 internal.ts 编码范式（`D:/project-code/llm/sandore/packages/sandore/microflow/src/internal.ts`）

```ts
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function textSummary(output: readonly ContentBlock[] | undefined): string {
  if (output === undefined) {
    return '';
  }
  const texts: string[] = [];
  for (const block of output) {
    if (block.type === 'text') {
      texts.push(block.text);
    }
  }
  return texts.join('\n');
}
```

范式要点：
- 模块级**普通函数**（非类），中文 JSDoc `@module` 头 + 每个函数一行中文说明。
- `textSummary` 是 `readonly ContentBlock[] | undefined` 入参，只取 `type === 'text'` 块按 `\n` 拼接，`undefined` → `''`。
- `describeError` 与 `workflow-engine.ts` 内部私有 `renderError` 逻辑完全一致（但那里是私有函数，这里下沉为 microflow 内部工具）。

#### 2.3 errors.ts（`D:/project-code/llm/sandore/packages/sandore/microflow/src/errors.ts`）

- `SandoreError extends HarnessError`，带 `readonly fatal: boolean`（默认 `true`）。
- `SandoreErrorCode` 联合类型 12 项：`YAML_PARSE | DEFINITION_INVALID | NODE_NOT_FOUND | CYCLE_DETECTED | STEP_TIMEOUT | STEP_EXECUTION | INVALID_OPERATION | CANCELLED | FINALIZE_FAILED | GATE_FAILED | SESSION_LOST | PERSISTENCE_FAILED`（末项为 non-fatal）。
- `isFatalSandoreError(error): boolean`。

#### 2.4 跨包访问范式（microflow → workflow）

- microflow 对 workflow 仅 `import type` 结构类型，绝不运行时跨包导入（`index.ts` 注释 + `stage-executor.ts`/`step-runner.ts` 实测）：`import type { … } from '../../workflow/src/types.ts'`、`import type { … } from '../../workflow/src/schema.ts'`、`import type { ShellExecRequest, ShellRunResult } from '../../workflow/src/shell.ts'`。
- 依赖方向统一 workflow → microflow（workflow 通过 `import { StageExecutor } from '../../microflow/src/stage-executor.ts'` 直接引用源码文件，非包名）。
- `ctx` 访问为直接属性（依赖 cordis Context 增强）：`this.ctx.shell.resolve/run`、`this.ctx.llm.stream/listProviders/listModels`、`this.ctx.logger.warn`。

---

### 3. workflow 中 ExecutedStepDefault / StageContract / OutputToItem / InputFromItem 的真实形状

#### 3.1 `ExecutedStepDefault`（`D:/project-code/llm/sandore/packages/sandore/workflow/src/types.ts:87-113`）

```ts
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
```

对应 schema `ExecutedStepDefaultSchema`（`schema.ts:270-296`）字段一一对应，其中 `output: z.array(ContentBlockSchema).optional()`（`ContentBlockSchema = z.looseObject({ type: z.string() })`，宽松 round-trip）、`loopIteration: z.array(z.number()).optional()`、`stepId: z.string().optional()`。

**关键差异（重要）**：`ExecutedStepDefault` **没有 `artifacts` 字段**。design.md §8.5 伪代码里的 `artifacts` 并非真实字段。当前产物信息由以下字段承载：
- `output?: ContentBlock[]` — Step 的 LLM/shell 输出文本块（`stage-executor.ts:209` 写入 `executed.output = result.output`）。
- `outputTo?: OutputToItem[]` — Step 定义里声明的产物绑定项（`stage-executor.ts:178` 原样拷贝自 `step.outputTo`）。
- 真正的产物文件列表在 `StageContract.artifacts` 与 `StageContract.contractArtifacts`（见下）。

**InputFrom 就近匹配实际可读字段**：`id`、`stepId?`、`stageId`、`loopIteration?: number[]`、`output?: ContentBlock[]`、`outputTo?: OutputToItem[]`、`name`、`status`、`visitCount`、`branchMeta?`/`loopMeta?`。**没有 `artifacts`**。

**`id` 与 `stepId` 的语义差异（就近匹配必须注意）**：`stage-executor.ts:167-184` 中 `id` 被赋值为 `childId = step-{stepId}-{execId 前 8 位}`（`synthesizeChildId`），`stepId` 才保存原始 step id（`step.id`）。因此 `id !== stepId`；按原始 ID 就近匹配应匹配 `stepId`，或对 `id` 做后缀匹配（design.md §4.2 的 `idMatches`：`actualId === targetId || actualId.startsWith(targetId + '-')`）。

#### 3.2 `StageContract`（`types.ts:126-144`）

```ts
export interface StageContract {
  stageId: string
  stageName: string
  status: StepStatus
  artifacts: Array<{
    stepId: string
    outputToId: string
    files: string[]
    returnPrompt?: string
  }>
  passThroughVars: Record<string, {
    value: string
    description: string
    refresh?: boolean
  }>
  contractArtifacts: Record<string, string[]>
  completedAt: string
  errorDetail?: string
}
```

对应 `StageContractSchema`（`schema.ts:306-320`）字段一致。当前 `stage-executor.ts:113-143` 的 `finalizeStageContract` 只填充 `artifacts`（`files: []` 恒为空，`contractArtifacts: {}` 恒为空）——产物文件收集（glob/regex 匹配 + walkDir）正是 Task 3 file-utils 待补的缺口。

#### 3.3 `InputFromItem` / `OutputToItem`（`schema.ts` 派生，`types.ts` re-export）

```ts
export const InputFromItemSchema = z.object({
  id: z.string(),
  path: z.string().optional(),
  regex: z.string().optional(),
})
export const OutputToItemSchema = z.object({
  id: z.string(),
  path: z.string().optional(),
  regex: z.string().optional(),
})
```

派生类型 `InputFromItem` / `OutputToItem` 均为 `{ id: string; path?: string; regex?: string }`。二者形状完全一致，仅语义不同（InputFrom.path 为 `stageId.stepId[.outputToId]` 引用；OutputTo.path 为产物文件 glob/regex）。

#### 3.4 `WorkflowTaskState`（`schema.ts:323-344`，就近匹配的数据来源）

```ts
export const WorkflowTaskStateSchema = z.object({
  taskId: z.string(),
  jobId: z.string(),
  workflowId: z.string(),
  cwd: z.string(),
  status: DagRunStatusSchema,
  originalInput: z.string(),
  currentStageId: z.string(),
  executedSteps: z.array(ExecutedStepDefaultSchema),
  stageInfos: z.array(StageInfoSchema),
  pendingInteractions: z.array(z.unknown()),
  pendingQueue: z.array(z.string()),
  visitCounts: z.record(z.string(), z.number()),
  passThroughVars: z.record(z.string(), PassThroughVarValueSchema),
  activeLoopIterationStack: z.array(z.number()),
  activeLoopNodeId: z.string().nullable(),
  activeLoopStack: z.array(z.string()),
  pausedStepIds: z.array(z.string()),
  stageContracts: z.record(z.string(), StageContractSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})
```

`executedSteps` 元素即为 `ExecutedStepDefault`（扁平数组，循环迭代直接扁平化，用 `loopIteration: number[]` 表示嵌套路径，无「循环容器」类型）。

---

### 4. 测试范式（作为 file-utils.spec.ts 编写依据）

#### 4.1 mock 注入范式（`D:/project-code/llm/sandore/packages/sandore/microflow/src/step-runner.spec.ts`）

```ts
import { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

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

- `new Context()` 后逐个 `ctx.provide(key, mock)`；mock 类型以 `as unknown as Xxx` 或直接传入（结构兼容）。
- 断言用 `rejects.toMatchObject({ code: 'STEP_EXECUTION' })`、`rejects.toThrow(/boom/)`、`resolves.toEqual({ output: [{ type: 'text', text: 'hello' }] })`。

#### 4.2 引擎集成测试 harness（`D:/project-code/llm/sandore/packages/sandore/workflow/src/workflow-engine.spec.ts:143-170`）

```ts
const ctx = new Context();
ctx.provide('storageDomain', storageDomain as unknown as DomainFacility);
await ctx.plugin(SandorePersistence);
const persistence = ctx.sandorePersistence;
ctx.provide('llm', llm as unknown as LlmRuntime);
ctx.provide('shell', shell as unknown as ShellExecutor);
ctx.provide('sessions', sessions as unknown as SessionStore);
ctx.provide('sessionPersistence', {});
ctx.provide('subagents', {});
ctx.provide('fs', {});
await ctx.plugin(SandoreEngineRuntime, config);
const engine = ctx.sandoreEngine;
```

**file-utils.spec.ts 直接依据**：`ctx.provide('fs', fakeFs)` 注入一个实现 FileSystem 形状的 mock（当前引擎测试以空对象 `{}` 占位；file-utils 测试需要真实现 `resolve/readText/writeText/listDir/stat` 语义的 `FakeFs`，否则读写/遍历会报「not a function」）。

#### 4.3 mock 类编码范式（`D:/project-code/llm/sandore/packages/sandore/workflow/tests/mocks/*.ts`）

- `FakeShell`（`tests/mocks/shell.ts`）：`readonly requests: ShellExecRequest[]` / `readonly specs: ShellExecSpec[]` 记录调用；`resolveHandler`/`runHandler` 可注入字段（默认实现委托）；构造后测试里覆盖 `shell.runHandler = async spec => …`。另导出纯函数工厂 `successResult(spec, stdout)`。
- `FakeLlm`（`tests/mocks/llm.ts`）：`readonly providers/models/calls` + `streamHandler` 字段；导出 `textChunks(text, reason)` 生成固定 chunk 流。
- 范式：普通 class（非继承真实 Service），`readonly` 记录数组 + 可覆写 handler 字段 + 缺省行为；注入时 `as unknown as Xxx` 抹平类型。
- mock 位置：`workflow/tests/mocks/`（被 workflow 与 microflow 两个包的 spec 共享——microflow spec 通过 `import { FakeLlm } from '../../workflow/tests/mocks/llm.ts'` 引用）。

#### 4.4 测试文件位置与 glob

- 测试与源码同目录：`packages/sandore/workflow/src/*.spec.ts`、`packages/sandore/microflow/src/*.spec.ts`。
- vitest include：`packages/**/*.spec.ts`（`D:/project-code/llm/sandore/vitest.config.ts:34`），`environment: 'node'`。
- 现有 spec 名例：`step-runner.spec.ts`、`subagents.spec.ts`、`workflow-engine.spec.ts`、`schema.spec.ts`、`persistence.spec.ts`、`remote.spec.ts`、`yaml-parser.spec.ts`。

---

### 关键结论汇总（供 file-utils / walkDir / InputFrom 就近匹配落地）

1. `ctx.fs` = `FileSystem` 抽象服务（`@deepseek-ai/dsh-fs`，sandore 未安装，须按 `shell.ts` 接缝范式本地声明 Context 增强）。
2. `readText/writeText/listDir/stat/resolve/streamText/editText/lstat/readBytes/processPath/fileUrl/contains` 均存在；**无 `walkDir`、无 delete/rename/copy**——walkDir 须用 `resolve` + `listDir` 递归（`FsDirEntry.type === 'directory'` → 用 `entry.target` 递归）。
3. 所有读/列/写均先 `resolve(path, { cwd? })` 得 `FsTarget`；路径展示用 `displayPath`，进程路径用 `processPath`；`stat` 返回 `FsInfo | undefined`。
4. `ExecutedStepDefault` **无 `artifacts` 字段**；`id` 是带 8 位 hex 后缀的 childId，`stepId` 才是原始 ID；`loopIteration?: number[]`。产物在 `StageContract.artifacts`（`{ stepId, outputToId, files, returnPrompt? }[]`）与 `StageContract.contractArtifacts`（`Record<string, string[]>`）。
5. `InputFromItem` / `OutputToItem` 均为 `{ id: string; path?: string; regex?: string }`。
6. file-utils.spec.ts 依 `step-runner.spec.ts` 范式：`new Context()` + `ctx.provide('fs', fakeFs)` + 覆盖 handler 字段的 FakeFs class（可放 `workflow/tests/mocks/fs.ts`）。

## Supplementary Exploration Result

补充探索配置：`experimental.websearch=true`、`experimental.context7=true`。由于 Phase 3 已从 DSH 源码仓库（`D:/project-code/llm/deepseek-harness`）与 sandore 本地源码获得完整且自洽的结论（`ctx.fs` 的 Service Definition + 类型 + 本地后端 + 模型侧消费四层证据，以及 sandore 现有类型/范式），无需 websearch / context7 补充，未执行。
