## Exploration Result

（`furina config show project.sourcecode codebases` 返回 `project.sourcecode=src/`（不存在）、`codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`。`docs/codebase` 目录为空，`project.sourcecode` 目录 `src/` 亦不存在——sandore 真实源码在 `packages/sandore/*`。codebases 迭代无产出，全部结论来自下方 Supplementary Exploration 的直接源码核实。）

## Supplementary Exploration Result

### 一、需求理解（Phase 2）

- **What**：为 Task 3 的 `artifact-01`（新建 `microflow/src/file-utils.ts`）核实四组真实类型/范式基座：(1) DSH 源码中 `ctx.fs` 服务的真实类型形状（`readText`/`writeText`/`listDir`/`stat`/`resolve` 精确签名，用于文件读写与 `walkDir` 递归实现）；(2) `microflow/src/index.ts` 导出结构与包内工具文件的编码范式（`internal.ts` 的 `describeError`/`textSummary` 等）；(3) `ExecutedStepDefault`/`StageContract`/`OutputToItem`/`InputFromItem` 在 `workflow/src/types.ts` 与 `schema.ts` 中的真实形状（`InputFrom` 就近匹配需读 `executedSteps` 的 `id`/`stepId`/`stageId`/`loopIteration` 字段及产物 artifacts 形状）；(4) 现有测试范式（`microflow/src/step-runner.spec.ts` 的 `ctx.provide` 注入 mock），作为 `file-utils.spec.ts` 编写依据。
- **Boundaries**：DSH 源码 `packages/fs/fs`（`@deepseek-ai/dsh-fs` 服务定义 + 类型词汇）与 `packages/fs/fs-local`（本地后端实现，用于确认 `resolve`/`listDir` 行为）；sandore 的 `packages/sandore/microflow/src/*` 与 `packages/sandore/workflow/src/{types,schema,shell}.ts`、`workflow/tests/mocks/*`。
- **Goal**：为 `file-utils.ts` 与 `file-utils.spec.ts` 提供可编码引用的精确签名与范式，避免以设计文档二次转述或记忆为准。
- **Project Context**：sandore 是 DSH（DeepSeek Harness，源码 `D:/project-code/llm/deepseek-harness`）的能力插件 monorepo（`packages/sandore/*`），硬约束「纯插件、零 DSH 源码修改、全用 DSH `ctx.*` 组件」。引擎接缝 `workflow/src/seam.ts` 已 `inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`，其中 `fs` 即本次核实的 `ctx.fs`。

---

### 二、`ctx.fs` 真实类型形状（DSH 源码）

DSH 源码位置：`D:/project-code/llm/deepseek-harness/packages/fs/fs`（包名 `@deepseek-ai/dsh-fs`）。**关键事实：`ctx.fs` 是「target 导向」而非「path 导向」的 API**——除 `resolve`/`lstat` 外，`readText`/`writeText`/`stat`/`listDir` 全部以 `resolve()` 返回的 `FsTarget` 为入参，不是直接吃字符串路径。

#### 2.1 服务声明（`packages/fs/fs/src/index.ts:44-46, 86-89`）

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    fs: FileSystem
  }
}

export abstract class FileSystem extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }
  // ... 抽象方法见下
}
```

#### 2.2 方法签名（`FileSystem` 抽象类，`index.ts`）

```ts
get sandboxMode(): SandboxMode | undefined                                  // getter，默认 undefined

abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
abstract processPath(target: FsTarget): string                              // 返回后端执行世界的绝对路径
abstract fileUrl(target: FsTarget): string                                  // 返回 file: URI
abstract contains(parent: FsTarget, child: FsTarget): boolean
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>   // 不存在 → undefined
abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
```

#### 2.3 类型词汇（`packages/fs/fs/src/types.ts`）

```ts
export type FsTargetKey = Branded<'FsTargetKey'>        // 不透明 key，勿解析/假设为本地绝对路径
export type FsVersion = Branded<'FsVersion'>            // 不透明新鲜度 token

export interface FsTarget {                             // resolve() 返回
  targetKey: FsTargetKey
  displayPath: string                                    // 面向模型/UI 的展示路径
}

export interface FsInfo {                               // stat() 返回
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}

export interface FsPathInfo {                           // lstat() 返回
  version: FsVersion
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
}

export interface FsDirEntry {                           // listDir() 返回的单个子项
  name: string
  type: 'file' | 'directory' | 'other'
  target: FsTarget                                       // 已 resolve 的子项 target，供后续操作直接使用
  version?: FsVersion
  size?: number
}

export type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }

export interface FsWriteOutcome {
  operation: 'create' | 'update'
  version: FsVersion
  before: string | null                                  // 写前内容（LF 归一化）；新建或后端拒绝基准时为 null
  after: string                                          // 写后内容（LF 归一化）
}

export interface FsEditRequest { oldString: string; newString: string; replaceAll: boolean }
export interface FsEditOutcome { version: FsVersion; before: string; after: string }

export type FsErrorCode =
  | 'FS_NOT_FOUND' | 'FS_NOT_DIRECTORY' | 'FS_NOT_TEXT' | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE' | 'FS_PERMISSION_DENIED' | 'FS_SANDBOX_DENIED' | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION' | 'FS_NOT_OBSERVED' | 'FS_AMBIGUOUS_EDIT' | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

export class FsError extends HarnessError { override readonly code: FsErrorCode }  // (message, code, options?)
```

> 注意：`FsWriteIntent` 缺省（`writeText` 不传 `expected`）表示**无条件 create-or-overwrite**，而非第三联合臂（`types.ts:117-125` 注释明确）。

#### 2.4 本地后端行为关键点（`packages/fs/fs-local/src/index.ts` + `fsio.ts`，用于 walkDir/读写实现依据）

- **`resolve` 对不存在的路径不抛错**：`resolveLocalTarget`（`fsio.ts:146-194`）先 `realpath`，ENOENT 时回退为「realpath 最近存在祖先 + 重新拼接缺失后缀」，返回稳定 targetKey。空路径（`path.trim().length === 0`）抛 `FS_NOT_FOUND`；父段为普通文件抛 `FS_NOT_FOUND`（`ENOTDIR`）。
- **存在性判断依赖 `stat`/`listDir`/`readText`**：`stat` 对不存在 target 返回 `undefined`（`probe` 把 ENOENT/ENOTDIR 归一为 `null`，`index.ts:126-132`）；`listDir` 对缺失/非目录 target 抛 `FS_NOT_FOUND`（`fsio.ts:282` 起）。
- **`listDir` 子项携带 `type: 'file'|'directory'|'other'` 与已 resolve 的 `target`**，且按 name 稳定排序——walkDir 递归可直接判断 `entry.type === 'directory'` 并用 `entry.target` 继续，无需再次 `resolve`/`stat` 探测目录性。
- **`readText` 的语义**：整文件读为 UTF-8 字符串；非 UTF-8/二进制由策略层拒绝（`FS_NOT_TEXT`）；目录/特殊文件在读前被策略层以 `stat` 拒绝（`FS_NOT_DIRECTORY`/`FS_NOT_REGULAR_FILE`）。
- **`writeText` 原子**：默认无条件覆盖；带 `expected` 时按 `FsWriteIntent` 做陈旧保护（`createIfAbsent` 遇已存在抛 `FS_NOT_OBSERVED`，`replaceIfVersion` 版本不符/缺失抛 `FS_STALE_VERSION`）。

#### 2.5 sandore 侧 `ctx.fs` 现状（核实结论）

- sandore 的 `inject` 列表已含 `'fs'`（`workflow/src/seam.ts:128`、`workflow-engine.ts:138`），但 **sandore 包内尚无本地 `fs` 接缝文件**，`ctx.fs` 的 TS 类型当前由 DSH `@deepseek-ai/dsh-fs` 的模块增强提供；sandore 的 `package.json`（microflow/workflow）**均未声明 `@deepseek-ai/dsh-fs` 依赖**。
- sandore 现有「本地结构类型接缝」范式（`workflow/src/shell.ts`、`microflow/src/subagents.ts`）：本地 `interface` 复刻 DSH 公开 API 最小面 + `declare module '@deepseek-ai/cordis' { interface Context { xxx: ... } }`，运行时由宿主注入。`ctx.fs` 若要可编码引用，需按同范式补齐（此为现状陈述，非实现建议）。

---

### 三、`microflow/src/index.ts` 导出结构与编码范式

#### 3.1 导出结构（`microflow/src/index.ts`）

```ts
export * from './errors.ts';
export * from './step-runner.ts';
export * from './stage-executor.ts';
export * from './subagents.ts';
```

- 仅 re-export 公开 API；`internal.ts` **不进入 index.ts**（注释明确「不 re-export，避免泄漏到公开 API」）。
- 依赖方向：workflow → microflow（运行时）；microflow 对 workflow 仅 `import type` 结构类型（如 `../../workflow/src/schema.ts`、`../../workflow/src/types.ts`、`../../workflow/src/shell.ts`）。
- 注：`stage-executor.ts` 内部使用 `internal.ts` 的 `describeError`/`textSummary`（`stage-executor.ts:22`），这即是「内部工具函数文件」的标准位置与用法。

#### 3.2 工具函数编码范式（`microflow/src/internal.ts`）

```ts
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export function textSummary(output: readonly ContentBlock[] | undefined): string {
  if (output === undefined) return ''
  const texts: string[] = []
  for (const block of output) {
    if (block.type === 'text') texts.push(block.text)
  }
  return texts.join('\n')
}
```

- 纯函数、无副作用、JSDoc 注释 `@module @deepseek-ai/dsh-sandore-microflow/src/internal`；`ContentBlock` 从 `@deepseek-ai/dsh-llm` import。
- 每个源文件首部都有 `@module` 注释块说明职责与依赖方向；文件间 import 用显式 `.ts` 后缀（`import { describeError } from './internal.ts'`）。

#### 3.3 错误基座（`microflow/src/errors.ts`，index.ts 导出之一）

- `SandoreErrorCode` 联合已含 Task 3 新码：`FINALIZE_FAILED | GATE_FAILED | SESSION_LOST`（fatal 组），末尾 `PERSISTENCE_FAILED`（non-fatal）。
- `class SandoreError extends HarnessError`（`@deepseek-ai/dsh-llm`），`readonly fatal: boolean`，构造 `(message, code, options?: ErrorOptions & { fatal?: boolean })`，`fatal` 默认 `true`；`isFatalSandoreError(error)` 判断。

#### 3.4 接缝范式（`microflow/src/subagents.ts`，与 file-utils 相邻的最新建仓范式）

- 纯 `interface` + `type` 本地结构类型声明（不 import DSH 包运行时），`declare module '@deepseek-ai/cordis' { interface Context { ... } }` 声明上下文键。
- 无 `export default`；公开面全为命名导出。
- 文件顶部 JSDoc `@module @deepseek-ai/dsh-sandore-microflow/src/subagents`，明确「按 DSH 公开 API 复刻最小结构类型、宿主运行时注入的结构兼容即可、无需包级依赖」。

---

### 四、`ExecutedStepDefault` / `StageContract` / `InputFromItem` / `OutputToItem` 真实形状

#### 4.1 `InputFromItem` / `OutputToItem`（`workflow/src/schema.ts:68-79`，`z.infer` 派生）

```ts
export const InputFromItemSchema = z.object({
  id: z.string(),
  path: z.string().optional(),    // 形如 stg-xxx[.step-xxx[.opt-xxx]]
  regex: z.string().optional(),
})
export type InputFromItem = z.infer<typeof InputFromItemSchema>   // { id: string; path?: string; regex?: string }

export const OutputToItemSchema = z.object({
  id: z.string(),
  path: z.string().optional(),    // 产物文件路径（支持 glob/regex）
  regex: z.string().optional(),
})
export type OutputToItem = z.infer<typeof OutputToItemSchema>     // { id: string; path?: string; regex?: string }
```

#### 4.2 `ExecutedStepDefault`（`workflow/src/types.ts:87-113`，与 `schema.ts:270-296` 的 `ExecutedStepDefaultSchema` 对齐）

```ts
export interface ExecutedStepDefault {
  type: 'default'
  id: string                  // 实际执行条目 id；Task 2 阶段 = childId `step-{stepId}-{execId 前 8 位}`（见 stage-executor.ts:77-81）
  stepId?: string             // 原始 Step 定义 id（无后缀）；loop 内带后缀时二者不同
  stageId: string
  name: string
  status: StepStatus          // 'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'
  command?: CommandConfig
  inputFrom?: InputFromItem[]
  outputTo?: OutputToItem[]
  passThroughVars?: PassThroughVar[]
  sessionMeta?: StepSessionMeta   // { childId: string; synthetic: boolean; command: 'shell'|'prompt'|'agent'|'skill'|'mcp' }
  finalizeMeta?: FinalizeMeta
  visitCount: number
  branchMeta?: BranchMeta
  error?: string
  pausedAt?: string
  resumedAt?: string
  resumePrompt?: string
  sessionMessages?: SessionMessage[]
  pauseEntryId?: string
  loopIteration?: number[]    // 嵌套循环路径，如 [1,2]
  loopMeta?: BranchMeta
  retryHistory?: RetryRecord[]
  parentSessionId?: string
  output?: ContentBlock[]     // import type { ContentBlock } from '@deepseek-ai/dsh-llm'
}
```

**InputFrom 就近匹配直接读的字段**（均已核实存在）：`id`、`stepId`、`stageId`、`loopIteration`。设计 D7（`furina/changes/task-3-full-dag/design.md:88-92`）明确三种 path：`stg-xxx`（Stage 级倒序）/ `stg-xxx.step-xxx`（Step 级从当前往前最近匹配，`idMatches` 支持后缀 `actualId === targetId || actualId.startsWith(targetId + '-')`）/ `stg-xxx.step-xxx.opt-xxx`（OutputTo 级）；无 `inputFrom` 回退前一条（`currentFlatIdx - 1`）。

#### 4.3 `StageContract`（`workflow/src/types.ts:126-144`，`schema.ts:306-320` 的 `StageContractSchema` 对齐）——「artifacts」所在容器

```ts
export interface StageContract {
  stageId: string
  stageName: string
  status: StepStatus
  artifacts: Array<{
    stepId: string
    outputToId: string
    files: string[]          // 产物文件路径列表（Task 2 阶段恒为 []，见 stage-executor.ts:128）
    returnPrompt?: string
  }>
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>
  contractArtifacts: Record<string, string[]>
  completedAt: string
  errorDetail?: string
}
```

- 关键：`ExecutedStepDefault` 本身**没有 `artifacts` 字段**；产物以 `StageContract.artifacts[].files: string[]` 形式存在（`stepId`+`outputToId`+`files`+`returnPrompt?`）。`artifact-01` 的 `{uuid}_output.json` 写入结构 `{ sessionId, output: { returnPrompt, artifacts: [{id, value: string[]}] } }`（spec `artifact-collection/spec.md`）与此词汇对应。
- `stage-executor.ts:113-143` 的 `finalizeStageContract` 展示了 Task 2 现状的组装方式：`artifacts.push({ stepId: step.stepId ?? step.id, outputToId: outputTo.id, files: [], ...(returnPrompt === '' ? {} : { returnPrompt }) })`（`files` 仍为空数组，等待 Task 3 收集）。

---

### 五、测试范式（`ctx.provide` 注入 mock）

#### 5.1 核心范式（`microflow/src/step-runner.spec.ts:53-65`）

```ts
function harness(config: StepRunnerConfig = { defaultTimeoutMs: 60000 }): {
  ctx: Context; llm: FakeLlm; shell: FakeShell; runner: StepRunner
} {
  const ctx = new Context()
  const llm = new FakeLlm()
  const shell = new FakeShell()
  ctx.provide('llm', llm as unknown as LlmRuntime)
  ctx.provide('shell', shell)
  return { ctx, llm, shell, runner: new StepRunner(ctx, config) }
}
```

- 直接 `new Context()`（`@deepseek-ai/cordis`），用 `ctx.provide('服务名', 实例)` 注入 mock；mock 实例类型需对 seam 结构类型做兼容断言（如 `llm as unknown as LlmRuntime`），shell mock 因 `workflow/src/shell.ts` 已 `declare module` 声明 `ctx.shell` 而可直接传。
- 断言风格：`expect(...).resolves.toEqual(...)` / `.rejects.toMatchObject({ code: 'STEP_EXECUTION' })` / `.rejects.toThrow(/boom/)`；mock 记录调用参数（`shell.specs`、`llm.calls`）供断言。
- spec 通过相对路径跨包引用 mock 与类型：`import { textChunks, FakeLlm } from '../../workflow/tests/mocks/llm.ts'`、`import type { WorkflowStep } from '../../workflow/src/schema.ts'`。

#### 5.2 mock 实现范式（`workflow/tests/mocks/*`）

- `shell.ts`：`class FakeShell` 实现 seam `ShellExecutor` 结构（`resolve`/`run`/`start`），记录 `requests`/`specs`，暴露可注入的 `resolveHandler`/`runHandler`，并提供 `successResult(spec, stdout?)` 工厂。
- `storage-domain.ts`：`MemoryKvTable`/`MemoryDomain`/`MemoryStorageDomain` 实现 `@deepseek-ai/dsh-storage-domain` 的 `KvTable`/`Domain` 等价语义，供 `ctx.provide('storageDomain', …)` 注入。
- 统一放在 `workflow/tests/mocks/`（非发布面），文件头 JSDoc 注明「测试专用，非发布面」。
- 测试运行：根 `vitest.config.ts` `include: ['packages/**/*.spec.ts']`、`environment: 'node'`（即 `file-utils.spec.ts` 放在 `microflow/src/` 下即可被自动发现）。

#### 5.3 对 `file-utils.spec.ts` 的既有约定提示（现状陈述）

- `ctx.fs` 在 sandore 侧尚无本地 seam 类型（见 2.5），当前没有现成的 `FakeFileSystem` mock；`workflow/tests/mocks/` 下亦无 `fs.ts` mock。若测试需经 `ctx.provide('fs', …)` 注入，需先有 `ctx.fs` 的结构类型声明（对齐 `shell.ts`/`subagents.ts` 范式）与对应 mock——此为现状核实，非实现建议。

---

### 六、关键核实结论摘要

1. `ctx.fs` = `FileSystem`（`@deepseek-ai/dsh-fs`，源码 `deepseek-harness/packages/fs/fs/src/index.ts`）：**target 导向** API。`resolve(path, opts?)` → `FsTarget`；`readText(target)`、`writeText(target, content, expected?, signal?, sandboxPolicy?)`、`stat(target)`、`listDir(target)` 均以 `FsTarget` 为入参；`listDir` 返回 `FsDirEntry[]`（含 `type`/`target`），`stat` 不存在返回 `undefined`，`resolve` 对缺失路径不抛错（回退最近存在祖先）。
2. `microflow/src/index.ts` 仅 re-export `errors/step-runner/stage-executor/subagents`；`internal.ts` 是「内部纯函数工具」范式（`describeError`/`textSummary`，不进公开 API）。
3. `InputFromItem`/`OutputToItem` = `{ id; path?; regex? }`；`ExecutedStepDefault` 含 `id`（执行 id）/`stepId?`（原始 Step id）/`stageId`/`loopIteration?` 等字段，但**无 `artifacts` 字段**——产物 artifacts 在 `StageContract.artifacts[].files: string[]` 中（`stepId`+`outputToId`+`files`+`returnPrompt?`）。
4. 测试范式：`new Context()` + `ctx.provide('服务名', mock)`；mock 放 `workflow/tests/mocks/` 实现 seam 结构类型并记录调用；`file-utils.spec.ts` 放 `microflow/src/` 下即被 vitest 自动发现。
