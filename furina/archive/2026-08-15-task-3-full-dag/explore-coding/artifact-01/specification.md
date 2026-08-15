# Furina Explore — Exploration Results（specification）

> 探索类型：specification
> 语言：中文
> 探索内容：精确核实 (1) DSH 源码中 `ctx.fs` 的真实类型形状；(2) microflow 包导出结构与内部工具编码范式；(3) `ExecutedStepDefault`/`StageContract`/`OutputToItem`/`InputFromItem` 真实形状；(4) 现有测试范式（`ctx.provide` 注入 mock）。

---

## 1. `ctx.fs` 的真实类型形状（DSH 源码）

### 1.1 源码位置（关键结论）

`ctx.fs` 的**真实类型形状不在此仓库的 `node_modules` 中**（`node_modules` 里只装入了 `@deepseek-ai/dsh-code-runtime`、`@deepseek-ai/dsh-cordis-host-runner` 等已发布包，未装入 `dsh-fs` 包本身）。真实定义位于 DSH 源码仓库：

- 服务抽象（Service Definition）：`D:/project-code/llm/deepseek-harness/packages/fs/fs/src/index.ts`
- 词汇类型（`FsTarget`/`FsInfo`/`FsDirEntry`/`FsWriteOutcome` 等）：`D:/project-code/llm/deepseek-harness/packages/fs/fs/src/types.ts`

包名与模块注释中明确写明：`@module @deepseek-ai/dsh-fs`，`declare module '@deepseek-ai/cordis' { interface Context { fs: FileSystem } }`——即 `ctx.fs` 是 `FileSystem`（`abstract class FileSystem extends Service`，`super(ctx, 'fs')`）。

> 佐证：本仓库设计文档 `docs/engine/dsh-workflow.md:1028`、`docs/design/overall-design.md:608`、`docs/design/task-3-full-dag/design.md:189` 均记录 `ctx.fs` 方法清单为 `readText / writeText / editText / listDir / stat / resolve / streamText`；Task 3 的 `work.md:9` 明确指明 DSH 源码参考路径为 `D:\project-code\llm\deepseek-harness`。

### 1.2 `FileSystem` 抽象类的方法签名（index.ts，逐字）

```typescript
export abstract class FileSystem extends Service {
  constructor(ctx: Context) { super(ctx, 'fs') }
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

  abstract writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome>

  abstract editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome>
}
```

**要点（对 file-utils 的文件读写与 walkDir 至关重要）**：

1. `resolve(path, opts?)` 返回 `Promise<FsTarget>`，其中 `opts.cwd` 决定相对路径的解析基准；`FsTarget` 由后端不透明键 `targetKey` + 展示路径 `displayPath` 组成。
2. **所有读/写/列目录操作都收 `FsTarget` 而非原始路径**——即「先 `resolve` 得到 target，再拿 target 调 `readText`/`writeText`/`listDir`/`stat`」是强制的两段式协议。
3. `readText` 返回 `Promise<string>`（整个 UTF-8 文本）；`stat` 返回 `Promise<FsInfo | undefined>`（`undefined` = 目标不存在）。
4. `listDir` 返回 `Promise<FsDirEntry[]>`，每个条目含 `name`/`type`/`target`（可继续 `resolve` 后递归）。
5. `writeText` 前两个参数必填（`target, content`），`expected`（写意图，`createIfAbsent` 或 `replaceIfVersion`）/`signal`/`sandboxPolicy` 可选。
6. 目录遍历依赖 `stat` 的 `type: 'file' | 'directory' | 'other'` 判定 + `listDir` 递归——没有提供现成的 `walkDir`/`findFilesByGlob`，需要 file-utils 自己实现。

### 1.3 关键词汇类型（types.ts，逐字形状）

```typescript
export type FsTargetKey = Branded<'FsTargetKey'>       // 不透明键，禁止解析为本地路径
export type FsVersion = Branded<'FsVersion'>           // 不透明新鲜度 token

export interface FsTarget {
  targetKey: FsTargetKey
  displayPath: string                                  // 面向模型/UI 的路径
}

export interface FsInfo {                              // stat 返回
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}

export interface FsDirEntry {                          // listDir 单项
  name: string
  type: 'file' | 'directory' | 'other'
  target: FsTarget
  version?: FsVersion
  size?: number
}

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

export interface FsEditOutcome { version: FsVersion; before: string; after: string }

export type FsErrorCode =
  | 'FS_NOT_FOUND' | 'FS_NOT_DIRECTORY' | 'FS_NOT_TEXT' | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE' | 'FS_PERMISSION_DENIED' | 'FS_SANDBOX_DENIED' | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION' | 'FS_NOT_OBSERVED' | 'FS_AMBIGUOUS_EDIT' | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'

export class FsError extends HarnessError { override readonly code: FsErrorCode } // extends HarnessError
```

### 1.4 sandbox 侧佐证

`node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/types/sandbox.d.ts` 的模块注释说明：动态包 sandbox 把 `require`/`fetch`/定时器等 Node API 拦截后，「steer filesystem … work to `ctx.fs`」，并给出 `inject: ['fs']` 的用法（`ctx.get('fs')`）。这印证 `ctx.fs` 是 Cordis 服务，注入键名为 `'fs'`。

---

## 2. microflow 包导出结构与内部工具编码范式

### 2.1 `microflow/src/index.ts` 导出结构（逐字）

```typescript
export * from './errors.ts';
export * from './step-runner.ts';
export * from './stage-executor.ts';
export * from './subagents.ts';
```

- 只 re-export 4 个文件，**不 re-export `internal.ts`**（内部工具刻意不进公开 API）。
- 注释明确依赖方向：`workflow → microflow`；microflow 对 workflow 仅 `import type` 结构类型。
- 包导出面：`package.json` 的 `exports` 为 `.`（types + default）与 `./src/*`、`./package.json`。

### 2.2 `internal.ts` 的编码范式（逐字，两个函数）

```typescript
/** 渲染任意抛出值为可读消息（诊断用，永不按消息路由）。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 提取 ContentBlock[] 的纯文本摘要（仅 text 块，按序拼接）。 */
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

**范式要点**：
- 纯函数、无状态、`import type { ContentBlock } from '@deepseek-ai/dsh-llm'` 单依赖。
- 文件头 JSDoc 注明「不进入公开 API」「仅供本包内部模块复用」。
- 命名语义化：`describeError`（错误 → 字符串）、`textSummary`（ContentBlock[] → 文本）。

### 2.3 microflow 其它文件的结构范式（供 file-utils.ts 对齐）

- **`errors.ts`**：`SandoreError extends HarnessError`（`@deepseek-ai/dsh-llm`），带 `readonly fatal` + `code: SandoreErrorCode`（字符串联合），`isFatalSandoreError(error)` 守卫。错误码用字符串联合类型而非 enum。
- **`subagents.ts` / workflow `shell.ts`**：本地「结构类型接缝」范式——因 `@deepseek-ai/dsh-subagent`/`dsh-shell` 等未作为运行时依赖安装，就在本包按 DSH 公开 API 复刻最小结构类型（interface + `declare module '@deepseek-ai/cordis' { interface Context { xxx: ... } }`），宿主运行时注入的真实服务结构兼容即可。**file-utils.ts 若要用 `ctx.fs`，同样应遵循此范式：本地声明最小 `FileSystem` 接缝结构 + `Context.fs` 增强，而不是新增包依赖。**
- 每个源文件都有 `@module @deepseek-ai/dsh-sandore-microflow/src/<name>` 头注释 + 中文说明。

---

## 3. `ExecutedStepDefault` / `StageContract` / `OutputToItem` / `InputFromItem` 真实形状

### 3.1 权威定义位置

- `packages/sandore/workflow/src/types.ts`：`ExecutedStepDefault`、`StageContract` 等 13 个基础类型的**接口**声明（browser-safe，纯 type，无运行时依赖）。
- `packages/sandore/workflow/src/schema.ts`：同名**Zod schema**（`ExecutedStepDefaultSchema`/`StageContractSchema`/`InputFromItemSchema`/`OutputToItemSchema`）+ `z.infer` 派生的 `InputFromItem`/`OutputToItem` 等类型。types.ts 顶部从 schema.ts `import type` 这些派生类型再 `export type` 转发。

### 3.2 `ExecutedStepDefault`（types.ts 接口，逐字）

```typescript
export interface ExecutedStepDefault {
  type: 'default'
  id: string              // 运行时 childId（step-{stepId}-{execId 前 8 位}）
  stepId?: string         // 定义层 step id（Task 3 输入就近匹配的关键字段）
  stageId: string         // 所属 stage id
  name: string
  status: StepStatus      // 'blocked'|'ready'|'interacting'|'running'|'completed'|'failed'|'paused'
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
  loopIteration?: number[]          // 循环迭代路径（嵌套为数组）
  loopMeta?: BranchMeta
  retryHistory?: RetryRecord[]
  parentSessionId?: string
  output?: ContentBlock[]           // 执行产物（ContentBlock[]）
}
```

**InputFrom 就近匹配需读取的字段**（已确认存在）：
- `id`（运行时 childId）、`stepId`（定义 id，可选）、`stageId`（必填）、`loopIteration`（`number[]`，可选）。
- **注意 `output?: ContentBlock[]` 是输出文本块，不是 `artifacts` 文件路径数组**；`artifacts` 形状只出现在 `StageContract.artifacts` 与 `OutputToItem` 产物收集结果里，`ExecutedStepDefault` 自身没有 `artifacts` 字段。产物文件路径（`files: string[]`）现阶段在 `StageContract.artifacts[].files` 中。
- schema.ts 中对应 `ExecutedStepDefaultSchema` 字段一一对应（`output: z.array(ContentBlockSchema).optional()`，`loopIteration: z.array(z.number()).optional()` 等）。

### 3.3 `StageContract`（types.ts 接口，逐字）

```typescript
export interface StageContract {
  stageId: string
  stageName: string
  status: StepStatus
  artifacts: Array<{
    stepId: string
    outputToId: string
    files: string[]           // 产物文件路径数组（Task 3 产物收集写入点）
    returnPrompt?: string
  }>
  passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>
  contractArtifacts: Record<string, string[]>
  completedAt: string
  errorDetail?: string
}
```

### 3.4 `OutputToItem` / `InputFromItem`（schema.ts 逐字）

```typescript
/** Step 输入绑定项：`path` 为 `stageId.stepId[.outputToId]` 引用，`regex` 为文件路径匹配。 */
export const InputFromItemSchema = z.object({
  id: z.string(),
  path: z.string().optional(),
  regex: z.string().optional(),
})

/** Step 输出绑定项：`path`/`regex` 为产物文件路径（支持 glob/regex）。 */
export const OutputToItemSchema = z.object({
  id: z.string(),
  path: z.string().optional(),
  regex: z.string().optional(),
})

export type InputFromItem = z.infer<typeof InputFromItemSchema>  // { id: string; path?: string; regex?: string }
export type OutputToItem = z.infer<typeof OutputToItemSchema>   // { id: string; path?: string; regex?: string }
```

**关键点**：`InputFromItem`/`OutputToItem` 两者形状相同——都是 `{ id, path?, regex? }`。InputFrom 的 `path` 语义是 `stageId.stepId[.outputToId]`（按 `.` 分割逐级定位，见 design.md §4.1/§4.2），`regex` 是文件路径匹配；OutputTo 的 `path`/`regex` 是产物文件路径（glob/regex）。

### 3.5 其它被 microflow 复用的 schema 派生类型（节选）

- `CommandConfig`（五变体 discriminated union：`agent`/`prompt`/`shell`/`skill`/`mcp`，判别字段顶层 `type`，变体字段整体嵌套在 `value`）。
- `WorkflowStep`（`id` 必填，`command`/`inputFrom`/`outputTo`/`passThroughVars`/`timeout`/`next`/`branches`/`loop` 等可选）。
- `WorkflowTaskState`（运行时层：含 `executedSteps: ExecutedStepDefault[]`、`stageContracts`、`passThroughVars`、`activeLoopStack` 等）。
- `PassThroughVar`（`{ name; value; description; refresh? }`）。

---

## 4. 现有测试范式（`ctx.provide` 注入 mock）

### 4.1 `microflow/src/step-runner.spec.ts` 范式

harness 组装方式（逐字核心）：

```typescript
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

**范式要点**：
- `import { Context } from '@deepseek-ai/cordis'`，`const ctx = new Context()`，用 `ctx.provide(name, mock)` 注入 mock 服务。
- mock 类来自 `packages/sandore/workflow/tests/mocks/*.ts`（`FakeLlm`/`FakeShell`），用 `as unknown as XxxRuntime` 强转以满足结构类型。
- mock 类范式：记录调用（`calls`/`specs` 数组）+ 可注入行为的 `xxxHandler` 字段 + `textChunks()`/`successResult()` 等辅助工厂函数。
- 断言范式：`expect(...).rejects.toMatchObject({ code: 'STEP_EXECUTION' })` 与 `.rejects.toThrow(/regex/)`。

### 4.2 `microflow/src/subagents.spec.ts` 范式

`ctx.provide` 直接注入 `FakeSubagents`/`FakeAgentRegistry`/`FakeSubprocess`（无需 `as unknown` 强转，因这些 mock 直接满足本地结构类型）：

```typescript
const ctx = new Context();
const subagents = new FakeSubagents();
ctx.provide('subagents', subagents);
const started = await ctx.subagents.startContinuable(continuableSpec(new FakeAgent('parent-1')));
```

### 4.3 `workflow/src/workflow-engine.spec.ts` 集成 harness 中 fs 的当前注入方式

```typescript
ctx.provide('llm', llm as unknown as LlmRuntime);
ctx.provide('shell', shell as unknown as ShellExecutor);
ctx.provide('sessions', sessions as unknown as SessionStore);
ctx.provide('sessionPersistence', {});
ctx.provide('subagents', {});
ctx.provide('fs', {});          // 目前仅注入空对象占位（引擎尚未实际调用 fs）
```

> **结论**：`fs` 目前只在引擎 `static inject` 里声明（`['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`，见 `workflow-engine.ts:138` 与 `seam.ts:128`），尚未被实际调用。`tests/mocks/` 目录下**尚无 `fs` 的 mock 文件**（现有：`agents.ts`/`llm.ts`/`sessions.ts`/`shell.ts`/`storage-domain.ts`/`subagents.ts`/`subprocess.ts`）。

### 4.4 DSH 官方 `FakeFs` 参考（file-utils.spec.ts 编写依据）

DSH 源码 `D:/project-code/llm/deepseek-harness/packages/fs/tool-fs/tests/tools.spec.ts:38-99` 提供了权威的 `FakeFs extends FileSystem` 内存 mock 范式（节选）：

```typescript
class FakeFs extends FileSystem {
  files = new Map<string, string>()          // targetKey → 内容
  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(`key:${path}`), displayPath: `/abs/${path}` }
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(target.targetKey)
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async readText(target: FsTarget): Promise<string> {
    return this.files.get(target.targetKey) ?? ''
  }
  override async listDir(_target: FsTarget): Promise<FsDirEntry[]> { return [] }
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    const before = this.files.get(target.targetKey) ?? null
    this.files.set(target.targetKey, content)
    return { operation: before !== null ? 'update' : 'create', version: FsVersion('v2'), before, after: content }
  }
}
```

- 注册方式：`await ctx.plugin(FakeFs)`，取回 `ctx.fs as FakeFs`。
- 但 sandore 的 file-utils.spec.ts 按本仓库惯例应走 `ctx.provide('fs', fakeFs)` 注入（本仓库 microflow/workflow 测试全部用 `ctx.provide`，而非 `ctx.plugin`）。

---

## 附：与本次 file-utils 直接相关的设计目标（非实现，仅既有文档记录）

`docs/design/task-3-full-dag/design.md:361-366` 与 `docs/engine/dynamic-workflow-engine.md:2510-2533` 记录了 file-utils 的目标函数清单（设计规格，非现状）：

```typescript
findFilesByGlob(rootDir, pattern, cwd): string[]  // glob 模式文件搜索
findFilesByRegex(rootDir, regex, cwd): string[]    // 正则文件搜索
walkDir(dir, regex, results, cwd): void            // 递归目录遍历（跳过 `.` 和 `node_modules`）
globToRegex(glob): RegExp                          // glob→RegExp 转换（private）
escapeRegexChar(ch): string                        // 单字符正则转义（private）
replaceVars(str, passThroughVars): string          // 替换 ${xxx} 透传变量，未解析的保留原样
```

glob→regex 转换规则（design.md §5.3）：`*` → `[^/]*`、`**` → `.*`、`?` → `[^/]`、其它字符正则转义。
