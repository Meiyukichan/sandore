# Furina CleanCode Exploration Result

# Explore Content

精确核实 (1) DSH 源码中 `ctx.fs` 的真实类型形状（`readText`/`writeText`/`listDir`/`stat`/`resolve` 签名，用于 file-utils 的文件读写与 walkDir 实现依据）；(2) 现有 microflow/src/index.ts 导出结构与 microflow 包内其它工具文件的编码范式（如 internal.ts 的 `describeError`/`textSummary`）；(3) 现有 `ExecutedStepDefault`/`StageContract`/`OutputToItem`/`InputFromItem` 类型在 workflow/src/types.ts 与 schema.ts 中的真实形状（InputFrom 就近匹配需要读取 executedSteps 的 `id`/`stepId`/`loopIteration`/`stageId`/`artifacts` 字段）；(4) 现有测试范式（microflow/src/step-runner.spec.ts 如何用 `ctx.provide` 注入 mock），作为 file-utils.spec.ts 的编写依据。

# Explore Type

cleancode

# 关键实现依据核实结论（源码已逐一确认）

## 1. DSH `ctx.fs`（FileSystem 服务）真实签名

来源：`D:\project-code\llm\deepseek-harness\packages\fs\fs\src\index.ts`（`abstract class FileSystem extends Service`，注册键 `'fs'`）。类型词汇在 `packages\fs\fs\src\types.ts`。

所有方法都是 **async abstract**（`Promise`），且**读写必须先 `resolve` 出 `FsTarget`**，不能直接传路径字符串：

- `resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>`
  - `FsTarget = { targetKey: FsTargetKey; displayPath: string }`（`targetKey` 为 opaque 品牌字符串，消费者不得解析）
- `stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>`
  - `FsInfo = { version: FsVersion; type: 'file' | 'directory' | 'other'; size?: number }`（`undefined` 表示 target 不存在）
- `readText(target: FsTarget, signal?: AbortSignal): Promise<string>`
- `writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>`
  - `FsWriteIntent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }`（省略 expected 即无条件 create-or-overwrite）
  - `FsWriteOutcome = { operation: 'create' | 'update'; version: FsVersion; before: string | null; after: string }`
- `listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>`
  - `FsDirEntry = { name: string; type: 'file' | 'directory' | 'other'; target: FsTarget; version?: FsVersion; size?: number }`（递归 `walkDir` 依赖 entry 自带 `target`，且 listDir 只返回 metadata，不读内容）
- `processPath(target: FsTarget): string`（**执行世界**的规范绝对路径，产物文件绝对路径应取此值）
- 其它方法：`lstat`/`streamText`/`readBytes`/`contains`/`fileUrl`/`editText`，以及 `get sandboxMode(): SandboxMode | undefined`

`ctx.fs` 通过 `declare module '@deepseek-ai/cordis' { interface Context { fs: FileSystem } }` 模块增强注入。sandore 侧若要本地结构类型接缝（对齐 `shell.ts`/`subagents.ts` 范式），需注意：`@deepseek-ai/dsh-fs` **未作为 sandore 运行时依赖安装**（sandore workflow package.json 的 peer/deps 中无 dsh-fs），故 file-utils 需自行声明最小结构类型或复用 DSH 类型。

## 2. microflow `index.ts` 导出结构与 internal.ts 范式

来源：`D:\project-code\llm\sandore\packages\sandore\microflow\src\index.ts` 与 `internal.ts`。

- `index.ts` 导出结构（纯 re-export，命名导出）：
  - `export * from './errors.ts';`
  - `export * from './step-runner.ts';`
  - `export * from './stage-executor.ts';`
  - `export * from './subagents.ts';`
  - → file-utils 需在 index.ts 追加 `export * from './file-utils.ts';`
- `internal.ts` 范式：包内工具不进公开 API（不从 index.ts re-export），函数为纯函数 + `import type`：
  - `export function describeError(error: unknown): string` → `error instanceof Error ? error.message : String(error)`
  - `export function textSummary(output: readonly ContentBlock[] | undefined): string` → 仅取 `type === 'text'` 块按序 join `'\n'`
- 文件头范式：`/** @module @deepseek-ai/dsh-sandore-microflow/src/internal */` JSDoc 块，说明模块职责与「不进入公开 API」边界。
- `step-runner.ts` 内也有一个范式参考：`private` 方法按 `runShell`/`runPrompt` 分发，`switch` 有 `default` 分支抛 `SandoreError`；顶层 `const PROMPT_MAIN_HEADER` 用 CONSTANT_CASE。

## 3. workflow `types.ts` / `schema.ts` 真实形状

来源：`D:\project-code\llm\sandore\packages\sandore\workflow\src\types.ts` 与 `schema.ts`。

- `schema.ts` 是权威来源：用 `zod` 定义 schema，再 `z.infer` 派生 TS 类型（`types.ts` 纯类型仅 re-export，含 `import type { ContentBlock } from '@deepseek-ai/dsh-llm'`）。
- `InputFromItemSchema` / `OutputToItemSchema`（两者形状一致）：
  - `{ id: string; path?: string; regex?: string }`
  - 派生：`InputFromItem` / `OutputToItem`
- `ExecutedStepDefaultSchema`（types.ts 的 `ExecutedStepDefault` 接口与其逐字段对应）：
  - 必填：`type: 'default'`、`id: string`、`stageId: string`、`name: string`、`status: StepStatus`、`visitCount: number`
  - 可选：`stepId?: string`、`command?`、`inputFrom?: InputFromItem[]`、`outputTo?: OutputToItem[]`、`passThroughVars?`、`sessionMeta?`、`finalizeMeta?`、`branchMeta?`、`error?`、`pausedAt?`、`resumedAt?`、`resumePrompt?`、`sessionMessages?`、`pauseEntryId?`、`loopIteration?: number[]`、`loopMeta?`、`retryHistory?`、`parentSessionId?`、`output?: ContentBlock[]`
  - **InputFrom 就近匹配关键字段**：`id`（childId，形如 `step-{stepId}-{execId8}`）、`stepId?`（定义层 Step id，循环迭代时可能带后缀）、`loopIteration?: number[]`、`stageId`；产物在 `StageContract.artifacts` 内
- `StageContractSchema`（types.ts `StageContract` 接口对应）：
  - `stageId: string`、`stageName: string`、`status: StepStatus`
  - `artifacts: Array<{ stepId: string; outputToId: string; files: string[]; returnPrompt?: string }>`
  - `passThroughVars: Record<string, { value: string; description: string; refresh?: boolean }>`
  - `contractArtifacts: Record<string, string[]>`、`completedAt: string`、`errorDetail?: string`
- `StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`（Step 与 Stage 共用）
- `types.ts` 中 `ExecutedStepDefault.stepId` 与 `StageContract.artifacts[].stepId` 均用 `string`；现有 `stage-executor.ts` 取 id 时用 `step.stepId ?? step.id` 的兜底范式。

## 4. 测试范式（`step-runner.spec.ts` 的 `ctx.provide`）

来源：`D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.spec.ts` 与 `D:\project-code\llm\sandore\packages\sandore\workflow\tests\mocks\`。

- 用 `@deepseek-ai/cordis` 的 `Context` + `ctx.provide(key, mock)` 注入：
  ```ts
  const ctx = new Context();
  const llm = new FakeLlm();
  const shell = new FakeShell();
  ctx.provide('llm', llm as unknown as LlmRuntime);
  ctx.provide('shell', shell);
  return { ctx, llm, shell, runner: new StepRunner(ctx, config) };
  ```
  → file-utils.spec.ts 应 `ctx.provide('fs', fakeFs)`（必要时 `as unknown as` 转换）。
- mock 桩范式（`tests/mocks/shell.ts`、`tests/mocks/llm.ts`）：内存 Fake 类，记录调用（`readonly specs: ShellExecSpec[] = []`），暴露 `xxxHandler` 回调让测试注入行为；`resolveHandler`/`runHandler` 默认实现委托。`shell` 用 `ctx.provide('shell', shell)` 直接注入（无 as），`llm` 因实现差距用 `as unknown as LlmRuntime`。
- 测试用 `vitest`：`import { describe, expect, it } from 'vitest';`，`await expect(...).resolves.toEqual(...)` / `.rejects.toMatchObject({ code: '...' })` / `.rejects.toThrow(/regex/)`。
- 跨包 import 用相对路径：`import type { WorkflowStep } from '../../workflow/src/schema.ts';`、`import { FakeShell } from '../../workflow/tests/mocks/shell.ts';`。

---

# Exploration Result

## 1. Scope

- **Requirement summary**：在 microflow 包新建 file-utils.ts（透传变量替换 `replacePassThroughVars`/`replaceVars`、glob→regex 转换 `globToRegex`/`escapeRegexChar`、产物搜索 `findFilesByGlob`/`findFilesByRegex`/`walkDir`、`{uuid}_output.json` 读写，经 DSH `ctx.fs` 与 workflow 类型实现），并配 file-utils.spec.ts（`ctx.provide` 注入 mock）。
- **Code features affected**：命名函数、接口与类型声明（`ctx.fs` 本地结构类型接缝）、导入/导出（index.ts、`import type`）、异常处理（fs 错误、JSON.parse）、字符串/正则处理、单元测试 mock。

## 2. Guidelines

### 模块与导出

##### SFS-1 命名导出（禁止默认导出）[Required]
所有代码使用命名导出（`export * from './file-utils.ts'`）；禁止默认导出，确保 import 不存在成员时编译器报错。

##### SFS-2 导出可见性 [Recommended]
只导出模块外部真正使用的符号，最小化 API 表面（对齐 internal.ts：`describeError`/`textSummary` 不进公开 API）。

##### SFS-3 import type / export type [Recommended]
仅作类型使用的导入用 `import type`，类型重导出用 `export type`。

##### SFS-4 使用模块而非命名空间 [Required]
禁止 `namespace`，用 ES6 import/export 组织；`declare module '@deepseek-ai/cordis'` 属合法的模块增强。

##### SFS-5 容器类 [Required]
不要用带静态方法的容器类作命名空间，直接导出单个常量与函数（file-utils 为纯函数模块）。

##### SFS-6 相对导入 [Recommended]
同项目内引用用相对导入（如 `../../workflow/src/schema.ts`），限制过深父目录层级。

### 函数与遍历

##### LF-1 函数声明优先 [Recommended]
命名函数优先用 `function foo() {}` 声明，不用 `const foo = () => ...`。

##### LF-2 箭头函数体 [Recommended]
返回值被使用时用简洁体，否则用块体（保证返回 `void`）。

##### LF-4 控制流大括号 [Required]
`if`/`for`/`while` 等必须使用大括号，即使体只有单条语句。

##### LF-5 for-of 遍历 [Recommended]
优先 `for (const x of arr)` 遍历数组（walkDir 迭代 `listDir` 结果）。

##### LF-6 严格相等 [Required]
使用 `===`/`!==`；仅与字面量 `null` 比较可用 `== null`。

### 字符串与类型转换

##### LF-13 模板字面量 [Recommended]
复杂字符串拼接用模板字面量。

##### LF-15 类型强制转换 [Required]
用 `String()`/`Boolean()`/`!!` 转换；禁止 `parseInt`/`parseFloat`（非十进制除外）与一元 `+`；`Number()` 解析须检查 NaN。

### 异常处理

##### LF-7 实例化异常用 new [Required]
实例化异常始终用 `new Error()`，不只调用 `Error()`。

##### LF-8 只抛 Error [Required]
只抛 Error 及其子类，保持堆栈信息（fs 错误传播同理）。

##### LF-9 空 catch 块注释 [Required]
catch 块确实不处理时，必须加解释注释（walkDir 跳过不可读条目）。

##### LF-10 keep try focused [Recommended]
限制 try 块内代码量，非抛出行移出 try/catch。

### 类型系统

##### LF-11 类型断言与非空断言 [Required / Recommended]（High）

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。

**[Compliant]**

```ts
// assuming Foo is a class.
if (x instanceof Foo) {
  x.foo();
}

if (y) {
  y.bar();
}
```

类型断言**必须**使用 `as` 语法（而不是尖括号语法）：

```ts
// z must be Foo because ...
const x = (z as Foo).length;
```

##### TS-1 类型推断 [Recommended]
简单类型（string/number/boolean/RegExp/new 表达式）省略注解；复杂表达式加注解提升可读性。

##### TS-2 接口优于类型别名 [Recommended]
声明对象类型用 `interface` 而非 `type X = { ... }`（ctx.fs 接缝用 interface）。

##### TS-3 Array<T> 语法糖 [Recommended]
简单类型用 `T[]`/`readonly T[]`，复杂类型用 `Array<T>`。

##### TS-4 可选字段优先于 |undefined [Recommended]
用 `?` 可选字段/参数而非 `| undefined`（对齐 exactOptionalPropertyTypes，展开时用 `...(x === undefined ? {} : { x })`）。

##### TS-5 any → unknown [Recommended]
`any` 危险；优先 `unknown` + 类型守卫收窄（JSON.parse 返回 any，须声明 unknown 后校验）。

##### TS-6 空类型 {} → unknown/Record/object [Recommended]
用 `unknown`、`Record<string, T>` 或 `object` 而非空接口 `{}`。

##### TS-7 可空类型别名禁止 [Required]
类型别名禁止含 `|null`/`|undefined`，应在实际使用处添加。

##### TS-8 索引签名 / Record [Recommended]
关联数组用 `{[key: string]: T}` 或 `Record`；键名应有意义（如 `{[varName: string]: ...}`）。

### 命名

##### NAM-1 描述性名称 [Required]
名称必须描述性，不用不熟悉的缩写、不删词内字母（10 行内局部变量可单字母）。

##### NAM-2 camelCase 缩写整词 [Required]
缩写视为整词（`loadHttpUrl` 而非 `loadHTTPURL`）。

##### NAM-3 常量 CONSTANT_CASE [Required]
模块级不可变值用 CONSTANT_CASE（如既有 `PROMPT_MAIN_HEADER`）。

### 注释与文档

##### CD-1 顶层导出 JSDoc [Required]
模块所有顶层导出用 `/** JSDoc */` 文档化。

##### CD-2 @param/@return 仅在加信息时 [Recommended]
`@param`/`@return` 仅当提供名称+类型之外的信息时书写，避免重复名称类型。

##### CD-3 JSDoc Markdown [Required]
JSDoc 用 Markdown，列表用 `-` 列表语法。

##### CD-4 多行注释 // 风格 [Required]
多行实现注释用多个 `//`，不用 `/* */`。

### 工具链与风格

##### TC-1 禁止 @ts-ignore/@ts-expect-error/@ts-nocheck [Required]
不用这些抑制指令；测试 mock 用 `as unknown as X` 转换代替（对齐 step-runner.spec.ts）。

##### POL-1 一致性 [Required]
新文件必须用 Google 风格，与包内现有文件（step-runner.ts/internal.ts/subagents.ts）保持一致。

##### CS-1 2 空格缩进 [Required]
TypeScript 缩进必须 2 空格。

##### CS-2 单引号、显式分号 [Required]
字符串字面量单引号；语句显式分号结尾。

##### CS-3 禁止 console.log，用 logger [Required]
不用 `console.log`，经 `ctx.logger` 输出日志。

##### CS-4 Node 内置模块默认导入 [Required]
Node 内置模块必须默认导入（`import fs from 'fs'`）；文件读写优先走 `ctx.fs`。

##### CS-5 工具文件行数 [Recommended]
工具/配置文件 100-200 行为理想范围。

## 3. Security & production notes

- **LF-11 / TS-5 / TS-6**：读取 `{uuid}_output.json` 时 `JSON.parse` 返回 `any`，须声明为 `unknown` 并运行时校验形状后再取字段，禁止直接 `as` 断言。
- **LF-15 / glob→regex**：`outputTo.path`/`outputTo.regex` 来自工作流定义，`escapeRegexChar` 必须转义全部正则元字符避免意外匹配；用户 regex 应避免灾难性回溯。
- **{uuid}_output.json 写入**：用 `ctx.fs.resolve` + `writeText`（原子、受沙箱约束），文件名取自内部 `stepMessageId`，非用户输入。
- **replacePassThroughVars**：替换 `${xxx}` 用 replacer 函数而非把拼接串作为 replacement，避免 `$&`/`$1`/`$'` 被解释。
