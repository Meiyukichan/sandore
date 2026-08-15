# Furina CleanCode 探索结果 — schema-01（类型体系与 YAML 解析）

> Explore Type: cleancode | 目标语言: TypeScript（clean-ts）| 语言: 中文

## 1. Scope

在 `packages/sandore/workflow/src/` 新增三个文件，实现 Task 2 引擎最小可用的「类型体系 + YAML 解析」子任务：

- `errors.ts`：`SandoreError`（对齐 DSH `HarnessError`/`WorkflowError` 的 `code` + `fatal` 标志）+ `isFatalSandoreError` 判型函数
- `schema.ts`：三层 Zod Schema（`CommandConfig` 五类型 discriminated union、`WorkflowTaskState`、`sandoreDomainSpec` 用 `defineDomain`/`domainTable<K,V>`）
- `yaml-parser.ts`：V1 三级 Stage→Scenario→Task 自动 `convertLegacyToV2` 转 V2 两级 Stage→Step

涉及的代码特性：类定义（继承 Error、readonly 字段）、异常处理（抛错/捕获/判型）、Zod schema 与类型推导（`z.discriminatedUnion`、`z.infer`、泛型 `domainTable<K,V>`）、YAML 解析（外部数据校验）、模块导入/导出、全量 JSDoc、命名、工具链约束。

## 2. Coding Guidelines

### 2.1 异常处理与错误类（errors.ts / yaml-parser.ts）

#### LF-EXC-2 只抛出 Error [High]

只抛出（的子类）`Error`，不要 `throw` 或 `Promise.reject` 非 Error 值；`SandoreError` 必须继承 `Error`（或 `HarnessError`），保证堆栈跟踪与 fatal 标志在异步/跨层传播中不丢失。

```ts
class SandoreError extends Error {}
throw new SandoreError('oh noes', 'INVALID_YAML')
```

#### LF-EXC-3 捕获与重抛 [High]

捕获错误时假设所有抛出的值都是 `Error` 实例；`catch (e: unknown)` 后用 `assertIsError` 收窄，不要防御性处理非 Error 类型。yaml-parser 中解析/校验抛出的错误，收窄后统一转换为 `SandoreError`（携带 code + fatal）。

```ts
function assertIsError(e: unknown): asserts e is Error {
  if (!(e instanceof Error)) throw new Error('e is not an Error')
}
try {
  doSomething()
} catch (e: unknown) {
  assertIsError(e)
  throw e
}
```

#### LF-EXC-1 使用 new 实例化异常 [Medium]

始终 `new Error()` / `new SandoreError()`，禁止直接调用 `Error()`。

#### LF-EXC-4 保持 try 块精简 [Medium]

限制 try 块内代码量，把不抛出的代码移出 try/catch。

#### LF-EXC-5 空 catch 块必须加注释 [Medium]

空 catch 块必须用注释解释正当理由。

### 2.2 类型安全与 unknown（schema.ts / yaml-parser.ts）

#### TS-ANY-1 使用 unknown 而非 any [High]

`z.infer` 推导结果与解析返回值不得退化为 `any`；YAML 解析原始结果与 `convertLegacyToV2` 中间态用 `unknown` + 类型守卫/Zod 校验收窄，不用 `as` 断言。

#### LF-ASSERT-1 类型断言不安全，优先运行时检查 [Medium]

优先显式运行时检查（`instanceof`、真值检查）；对 schema 解析结果优先用 Zod 校验本身收窄。

#### LF-ASSERT-2 类型断言必须用 as 语法 [Medium]

禁止尖括号断言 `<Foo>bar`。

#### LF-ASSERT-3 对象字面量用类型注解而非断言 [Medium]

对象字面量指定类型用 `: Foo` 而非 `as Foo`。

#### TS-INF-1 类型推断 / TS-RET-1 返回类型注解 [Medium]

简单类型可省略注解；复杂返回类型（如 `convertLegacyToV2` 返回 `WorkflowDefinition`）建议显式标注。

### 2.3 类定义（SandoreError）

#### LF-CLS-1 类声明不以分号结尾 [Medium]

方法声明之间以单个空行分隔，不用分号。

#### LF-CLS-2 使用 readonly [Medium]

构造函数外不重新赋值的属性用 `readonly` 标记（`readonly code: string`、`readonly fatal: boolean`）。

#### LF-CLS-3 禁止 #private 字段 [Medium]

使用 TypeScript 可见性注解（`private`），禁止 `#ident`。

#### LF-CLS-4 可见性 [Medium]

除非声明非只读 public 参数属性，否则不用 `public` 修饰符。

#### LF-CLS-5 构造函数必须用括号 [Medium]

`new Foo()` 而非 `new Foo`。

#### LF-CLS-7 参数属性 [Medium]

类成员依赖通过 TS 参数属性引入（`constructor(private readonly barService: BarService) {}`），需要文档时用 `@param` JSDoc。

### 2.4 函数定义（isFatalSandoreError / convertLegacyToV2）

#### LF-FN-1 命名函数优先用函数声明 [Medium]

`function isFatalSandoreError() {}` 而非箭头函数赋值。

#### LF-FN-2 禁止函数表达式 [Medium]

用箭头函数替代 `function() {...}`。

#### LF-FN-3 回调优先传箭头函数 [Medium]

#### LF-FN-4 函数体格式化 [Medium]

函数体开头/结尾无空行；判型函数保持纯函数、无副作用。

### 2.5 类型声明（schema.ts — z.infer / domainTable<K,V>）

#### TS-OPT-1 优先可选字段而非 |undefined [Medium]

用 `foo?: string` 而非 `foo: string | undefined`。

#### TS-NULL-1 类型别名禁止含 |null/|undefined [Medium]

类型别名联合中不混入 `|null`/`|undefined`；空值在值出现附近处理（如 Zod 用 `.nullable()`/`.optional()` 而非在 TS 别名里写）。

#### TS-ARR-1 数组语法糖 T[] [Medium]

简单类型用 `T[]` / `readonly T[]`，复杂类型才用 `Array<T>`。

#### TS-IDX-1 索引签名 / Record [Medium]

zod record schema 用 `z.record(keySchema, valueSchema)` 或 `Record<K, V>`；为键提供有意义标签（如 `Record<stageId, ...>`）。

#### TS-MAP-1 映射与条件类型 [Medium]

使用最简单类型构造，一点重复比复杂类型表达式长期成本更低。

#### NAM-TP-1 类型参数 [Medium]

`domainTable<K, V>` 的 `K`/`V` 用单个大写字符或 UpperCamelCase。

#### TS-GEN-1 仅返回类型的泛型 [Medium]

使用仅返回类型的泛型时显式指定泛型参数（如 `domainTable<WorkflowId, WorkflowDefinitionRecord>(...)`）。

#### TS-IFACE-1 接口优于类型字面量别名 [Medium]

声明对象类型用接口；但 Zod 派生类型 `export type X = z.infer<typeof XSchema>` 作为 schema 单一来源是约定俗成的例外。

### 2.6 模块组织（导入/导出）

#### SFS-EXP-1 命名导出，禁止默认导出 [Medium]

所有代码用命名导出（`export class SandoreError` / `export function isFatalSandoreError`），禁止 `export default`。

#### SFS-EXP-2 导出可见性 [Medium]

只导出模块外部使用的符号，最小化导出 API 表面。

#### SFS-EXP-3 禁止 export let [Medium]

#### SFS-TYPE-1 import type / export type [Medium]

仅作为类型使用的导入用 `import type`；`export type X = z.infer<typeof XSchema>` 中 `XSchema` 是值导出、`X` 是类型导出的区分点。

#### SFS-MOD-1 使用模块而非命名空间 [Medium]

#### SFS-IMP-1 具名 vs 命名空间导入 [Medium]

zod 用具名导入 `import { z } from 'zod'`（DSH 约定）。

#### SFS-IMP-2 相对导入路径 [Medium]

同项目内用相对导入（`./types.ts`）。

#### CORE-IMP-1 Node.js 内置模块默认导入 [Medium]

Node.js 内置模块用默认导入（yaml-parser 若读文件需遵循）。

### 2.7 命名规范

#### NAM-1 标识符大小写 [Medium]

类/接口/类型/枚举/类型参数用 UpperCamelCase；变量/参数/函数/方法/属性用 lowerCamelCase；全局常量用 CONSTANT_CASE。

#### NAM-2 描述性名称 / NAM-3 缩写 camelCase / NAM-4 命名风格 [Medium]

名称描述性、不删单词内部字母、不装饰类型已含信息（禁止 `ISandoreError` 式标记）。

#### NAM-5 常量 CONSTANT_CASE [Medium]

模块级常量（如错误 code 常量 `INVALID_YAML`、`DEFAULT_SETTINGS`）用 CONSTANT_CASE。

### 2.8 注释与文档（全量 JSDoc）

#### DOC-1 JSDoc vs 普通注释 [Medium]

`/** JSDoc */` 做文档化注释，`//` 做实现注释；多行注释用多个单行 `//`。

#### DOC-2 文档化模块所有顶层导出 [Medium]

所有顶层导出必须 JSDoc（对齐 DSH 全量 JSDoc 约定）。

#### DOC-3 类注释 / DOC-4 方法与函数注释 [Medium]

类 JSDoc 说明用法与正确使用所需考虑；方法描述以第三人称动词短语开头，从名称和类型已显而易见时可省略。

#### DOC-5 JSDoc 类型注解冗余 / DOC-6 注释提供实际信息 [Medium]

禁止在 `@param`/`@return` 重复声明 TS 已有类型；注释须提供实际信息，不重复参数名。

#### CORE-DOC-1 文件头 JSDoc [Medium]

文件头部用 `/** 简要描述 / @module ... */` 风格（对齐 DSH 包，如 `@module @deepseek-ai/dsh-sandore-workflow/src/schema`）。

### 2.9 字符串与字面量

#### LF-STR-1 单引号 [Medium]

普通字符串用单引号 `'`。

#### LF-STR-2 模板字面量 [Medium]

复杂拼接用反引号模板字面量。

#### LF-STR-3 禁止行延续 [Medium]

### 2.10 变量与控制结构

#### LF-VAR-1 const/let [Medium]

默认 `const`，需要重赋值才用 `let`，禁止 `var`。

#### LF-VAR-2 每行一个变量 [Medium]

#### LF-CTRL-1 switch 必须有 default [Medium]

switch 必须含 default（放最后）；非空 case 禁止 fall through。`convertLegacyToV2` 按版本分支时遵循。

#### LF-CTRL-2 严格相等 [Medium]

用 `===`/`!==`；仅与 `null` 比较可用 `==`/`!=` 同时覆盖 null 和 undefined。

### 2.11 工具链与策略

#### TC-1 禁止 @ts-ignore [Medium]

禁止 `@ts-ignore`、`@ts-expect-error`、`@ts-nocheck`（测试中谨慎用 `@ts-expect-error`）。

#### POL-1 一致性 [Medium]

未明确问题与同目录现有代码保持一致；新文件遵循 DSH/Google 风格。

#### CORE-1 Node.js ES 模块 [Medium]

#### CORE-2 代码风格 [Medium]

单引号、显式分号、2 空格缩进；禁止 `console.log`，通过 logger 输出日志。

#### CORE-3 文件行数 [Medium]

普通业务文件 300-500 行，工具/配置文件 100-200 行，大型模块不超过 800 行（schema.ts 三层 schema 体量较大，注意拆分边界）。

## 3. Security & Production Notes

- **外部数据校验（yaml-parser.ts）**：`yaml` 包 `parseDocument` 输入属不可信外部数据，解析结果必须经 `schema.ts` 的 Zod schema 校验后才进入业务层；解析/校验抛错按 LF-EXC-3 以 `catch (e: unknown)` + `assertIsError` 收窄后转换为 `SandoreError`（携带 code + fatal）。
- **错误对象一致性（errors.ts）**：`SandoreError` 及判型函数只涉及 `Error` 子类（LF-EXC-2），确保 fatal 标志与堆栈跟踪在异步/跨层传播中不丢失。
- **禁止 any（schema.ts）**：`z.infer` 推导与解析返回值不得退化为 `any`（TS-ANY-1）；`convertLegacyToV2` 中间态用 `unknown` 收窄而非 `as` 断言。
- **日志**：模块内统一 logger 输出，禁止 `console.log`（CORE-2）。
