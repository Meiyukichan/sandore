# Furina CleanCode Exploration Result

# Explore Content

为 sandore 工作流引擎 Task 4 生命周期能力（pause/resume/retry/question/permission）的 capability seam 扩展与 schema 迁移检索 TypeScript 编码规范。涉及文件：packages/sandore/microflow/src/subagents.ts（DSH agent/subagent 结构类型复刻面）、packages/sandore/workflow/src/{seam,schema,types,workflow-engine}.ts、workflow/tests/mocks/{agents,subagents,sessions}.ts 桩。涉及代码特征：结构类型接口（readonly 字段）、抽象 Service 类与参数属性、Zod discriminated union/looseObject/z.infer 派生、declare module 接口合并（Cordis Context/Events、SessionEventMap）、import type/export type、错误处理（SandoreError code 路由）、异步主循环（while/for-of）、vitest mock 注入（ctx.provide）。

# Explore Type

cleancode

# Exploration Result

# Clean-TypeScript 编码规范 — sandore 工作流引擎 Task 4 生命周期能力

## 1. Scope

- **Requirement summary**: 为 sandore 工作流引擎 Task 4 生命周期能力（pause/resume/retry/question/permission）扩展 capability seam（抽象 SandoreEngine）、迁移三层 Zod schema（CommandConfigSchema discriminated union、ContentBlockSchema z.looseObject、WorkflowTaskStateSchema）并派生 z.infer 类型，同时保持 browser-safe 联合类型（PendingQuestion/PendingPermission/FinalizeOutcome）与 vitest mock 桩一致。
- **Code features affected**: 结构类型接口（readonly 字段）、抽象 Service 类与参数属性、Zod discriminated union / looseObject / derive z.infer、declare module 接口合并（Cordis Context/Events、SessionEventMap）、import type/export type、错误处理（SandoreError code 路由）、异步主循环（while/for-of）、vitest mock 注入（ctx.provide）。

## 2. Guidelines

### 错误处理与 SandoreError code 路由

##### LF.48 Only throw errors [Required/High]

**[Description]**

JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。

**[Compliant]**

```
// Throw only Errors
throw new Error('oh noes!');
// ... or subtypes of Error.
class MyError extends Error {}
throw new MyError('my oh noes!');
// For promises
new Promise((resolve) => resolve()); // No reject is OK.
new Promise((resolve, reject) => void reject(new Error('oh noes!')));
Promise.reject(new Error('oh noes!'));
```

##### LF.49 Catching and rethrowing [Required/High]

**[Description]**

捕获错误时，代码**应该**假设所有抛出的错误都是 `Error` 的实例。除非被调用的 API 确定知道会抛出非 `Error` 来违反上述规则，否则异常处理程序**禁止**防御性地处理非 `Error` 类型。在这种情况下，应包含注释以特别识别非 `Error` 的来源。

**[Compliant]**

```
function assertIsError(e: unknown): asserts e is Error {
  if (!(e instanceof Error)) throw new Error("e is not an Error");
}

try {
  doSomething();
} catch (e: unknown) {
  // All thrown errors must be Error subtypes. Do not handle
  // other possible values unless you know they are thrown.
  assertIsError(e);
  displayError(e.message);
  // or rethrow:
  throw e;
}
```

##### LF.50 Empty catch blocks [Required/High]

**[Description]**

很少有情况下在响应捕获的异常时什么都不做是正确。当确实适合在 catch 块中完全不采取行动时，应在注释中解释这是正当的理由。

**[Compliant]**

```
  try {
    return handleNumericResponse(response);
  } catch (e: unknown) {
    // Response is not numeric. Continue to handle as text.
  }
  return handleTextResponse(response);
```

##### LF.51 Switch statements [Required/High]

**[Description]**

所有 `switch` 语句**必须**包含一个 `default` 语句组，即使它不包含代码。`default` 语句组必须放在最后。在 switch 块中，每个语句组要么通过 `break`、`return` 语句或抛出异常突然终止。非空语句组（`case ...`）**禁止** fall through（由编译器强制）。空的语句组允许 fall through。

**[Compliant]**

```
switch (x) {
  case Y:
    doSomethingElse();
    break;
  default:
    // nothing to do.
}
```

```
switch (x) {
  case X:
  case Y:
    doSomething();
    break;
  default: // nothing to do.
}
```

##### LF.52 Equality checks [Required/High]

**[Description]**

始终使用严格相等（`===`）和不等于（`!==`）。双等运算符会导致容易出错的类型强制转换，难以理解，且对 JavaScript 虚拟机实现起来更慢。**异常**：与字面量 `null` 值的比较**可以**使用 `==` 和 `!=` 运算符来同时覆盖 `null` 和 `undefined` 值。

**[Compliant]**

```
if (foo === 'bar' || baz !== bam) {
  // All good here.
}
```

```
if (foo == null) {
  // Will trigger when foo is null or undefined.
}
```

### 类型断言与 schema 迁移

##### LF.53 Type and non-nullability assertions [Required/High]

**[Description]**

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。有时由于代码的某些局部属性，你可以确定断言形式是安全的。在那些情况下，你应该添加说明来解释为什么你可以接受不安全的行为。如果类型或非空断言背后的推理是显而易见的，注释**可以**不是必需的。

**[Compliant]**

```
// assuming Foo is a class.
if (x instanceof Foo) {
  x.foo();
}

if (y) {
  y.bar();
}
```

```
// x is a Foo, because ...
(x as Foo).foo();

// y cannot be null, because ...
y!.bar();
```

##### LF.55 Double assertions [Required/High]

**[Description]**

TypeScript 只允许类型断言转换为更具体或更不具体的类型版本。添加不满足此条件的类型断言将给出错误。如果你确定断言是安全的，可以执行*双重断言*。这涉及通过 `unknown` 转换，因为它比所有类型都不具体。使用 `unknown`（而不是 `any` 或 `{}`）作为中间类型。

**[Compliant]**

```
// x is a Foo here, because...
(x as unknown as Foo).fooMethod();
```

##### LF.56 Type assertions and object literals [Required/High]

**[Description]**

使用类型注解（`: Foo`）而不是类型断言（`as Foo`）来指定对象字面量的类型。这允许在接口字段随时间变化时检测重构错误。

**[Compliant]**

```
interface Foo {
  bar: number;
  baz?: string;
}

const foo: Foo = {
  bar: 123,
  bam: 'abc',  // complains about "bam" not being defined on Foo.
};

function func(): Foo {
  return {
    bar: 123,
    bam: 'abc',   // complains about "bam" not being defined on Foo.
  };
}
```

### 类型安全（schema 派生与存储域）

##### TS.11 `any` Type [Required/High]

**[Description]**

TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型；使用 `unknown`；抑制 lint 警告并记录原因。

**[Compliant]**

```
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

```
// This test only needs a partial implementation of BookService, and if
// we overlooked something the test will fail in an obvious way.
// This is an intentionally unsafe partial mock
// tslint:disable-next-line:no-any
const mockBookService = ({get() { return mockBook; }} as any) as BookService;
// Shopping cart is not used in this test
// tslint:disable-next-line:no-any
const component = new MyComponent(mockBookService, /* unused ShoppingCart */ null as any);
```

### 工具链

##### TOOL.02 @ts-ignore / @ts-expect-error / @ts-nocheck [Required/High]

**[Description]**

不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。它们表面上似乎是"修复"编译器错误的简单方法，但实际上，特定的编译器错误通常是由更大的问题引起的，可以更直接地修复。例如，如果你使用 `@ts-ignore` 抑制类型错误，很难预测周围代码最终会看到什么类型。在单元测试中可以使用 `@ts-expect-error`，但通常**不应该**。`@ts-expect-error` 抑制所有错误。很容易意外地过度匹配并抑制更严重的错误。考虑以下之一：当测试需要处理运行时未检查值的 API 时，添加强制转换为预期类型或 `any`，并添加说明性注释。这将错误抑制限制在单个表达式上；抑制 lint 警告并记录原因，类似于抑制 `any` lint 警告。

（原文无 Compliant 示例，故不提供。）

### 模块与导入导出

##### CORE.02 命名空间导入 [Recommended/Medium] — 第三方库或多导出模块使用命名空间导入（`import * as ns from '...'`）。
##### CORE.03 Node 内置模块默认导入 [Required/Medium] — Node.js 内置模块必须默认导入（`import fs from 'fs'`）。
##### SRC.06 命名导出 [Required/Medium] — 所有代码使用命名导出，禁止默认导出。
##### SRC.07 导出可见性 [Recommended/Medium] — 只导出模块外部使用的符号，最小化导出 API 表面。
##### SRC.10 Import type [Recommended/Medium] — 仅作类型使用的导入用 `import type {...}` 或 `import {type Foo, Bar}`。
##### SRC.11 Export type [Recommended/Medium] — 重新导出类型用 `export type {...} from '...'`。
##### SRC.12 使用模块而非命名空间 [Required/Medium] — 禁止 `namespace Foo {}` 与 `require`/`import x = require()`；`declare module` 接口合并仅在与第三方库（如 cordis）接口时允许。

### 结构类型接口、抽象类与参数属性

##### TS.06 结构类型 [Recommended/Medium] — 结构类型在声明处显式标注类型，以便在声明点（而非调用点）得到错误报告。
##### TS.07 接口优于类型字面量别名 [Recommended/Medium] — 声明对象类型用 `interface` 而非 `type Foo = {...}`（联合/元组/原始类型别名除外）。
##### TS.08 Array 类型 [Recommended/Medium] — 简单类型用 `T[]`/`readonly T[]`，复杂类型用 `Array<T>`。
##### LF.17 构造函数 [Required/Medium] — 构造函数调用必须带括号；空构造函数或仅委托 super 的构造函数应省略（有参数属性/装饰器者除外）。
##### LF.18 参数属性 [Recommended/Medium] — 用 `constructor(private readonly x: X)` 参数属性替代显式成员初始化器。
##### LF.23 可见性 [Recommended/Medium] — 尽可能限制可见性；禁止多余 `public`（非只读 public 参数属性除外）；用 `readonly` 标记不在构造函数外重新赋值的属性。
##### DOC.10 参数属性注释 [Recommended/Medium] — 参数属性用 JSDoc `@param` 注解文档化。

### 类型系统：Zod union / z.infer / 存储域

##### TS.01 类型推断 [Recommended/Medium] — 简单类型（string/number/boolean/RegExp/new 表达式）省略注解；复杂表达式加注解。
##### TS.02 返回类型 [Recommended/Medium] — 复杂返回类型应添加注解，审查者可要求澄清。
##### TS.04 可空类型别名 [Required/Medium] — 类型别名禁止包含 `|null`/`|undefined`，应在实际使用时添加。
##### TS.05 优先可选参数 [Recommended/Medium] — 用 `?` 可选字段/参数而非 `|undefined`。
##### TS.09 索引签名 [Recommended/Medium] — 关联数组用索引签名 `{[key: string]: T}` 且键取有意义标签；考虑用 `Map`/`Set`/`Record`。
##### TS.10 映射与条件类型 [Recommended/Medium] — `z.infer` 等派生类型使用最简单的类型构造；一点重复比复杂类型表达式成本低。
##### TS.12 `{}` 空类型 [Recommended/Medium] — 避免 `{}`，优先 `unknown`/`Record<string, T>`/`object`。
##### TS.14 包装器类型 [Required/Medium] — 禁止 `String`/`Boolean`/`Number` 包装器类型，始终用小写原始类型。

### 异步主循环与控制流

##### LF.43 控制流大括号 [Required/Medium] — 控制流语句（if/else/for/do/while）始终使用大括号；可放一行的 if 可省略。
##### LF.45 遍历容器 [Recommended/Medium] — 优先 `for-of` 遍历数组；`for-in` 仅用于字典对象且需 `hasOwnProperty` 过滤。
##### LF.57 精简 try 块 [Recommended/Medium] — 限制 try 块内代码量；循环内的 try 可扩大覆盖整个循环。
##### LF.47 用 new 实例化错误 [Required/Medium] — 实例化异常始终用 `new Error()`。

### 函数与 this

##### LF.25 优先函数声明 [Recommended/Medium] — 命名函数优先用函数声明而非箭头函数常量。
##### LF.27 禁止函数表达式 [Recommended/Medium] — 用箭头函数替代 `function` 表达式（需重新绑定 this 时除外）。
##### LF.28 箭头函数体 [Recommended/Medium] — 返回值被使用时用简洁体，否则用块体；可用 `void` 运算符防泄漏返回值。
##### LF.36 this 使用 [Required/Medium] — 只在类构造/方法、显式 this 类型函数或箭头函数中使用 this。

### 命名

##### NAM.02 命名风格 [Recommended/Medium] — 类型信息不入名称；禁止下划线前后缀与 `opt_`；不特别标记接口（如 `I...`）；Observable 用 `$` 后缀。
##### NAM.03 描述性名称 [Required/Medium] — 名称必须描述性；禁用不熟悉缩写；≤10 行局部作用域可用短名。
##### NAM.04 Camel case [Required/Medium] — 缩写视为整词（`loadHttpUrl`、`customerId`），禁止 `customerID`/`loadHTTPURL`。
##### NAM.06 标识符大小写 [Required/Medium] — class/interface/type/enum/type 参数用 UpperCamelCase；变量/函数/方法/属性用 lowerCamelCase；全局常量用 CONSTANT_CASE。
##### NAM.11 常量 [Recommended/Medium] — 模块级常量与 `static readonly` 属性可用 CONSTANT_CASE；局部变量用 lowerCamelCase。

### 注释与文档

##### DOC.02 多行注释 [Required/Medium] — 多行注释用多个 `//` 单行注释，禁止 `/* */` 块注释风格。
##### DOC.07 文档化顶层导出 [Recommended/Medium] — 模块所有顶层导出必须 JSDoc 文档化。
##### DOC.11 JSDoc 类型注解 [Required/Medium] — JSDoc 类型注解在 TS 源码冗余，禁止在 `@param`/`@return` 声明类型。
##### DOC.12 注释提供实际信息 [Recommended/Medium] — 避免仅重复参数名/类型；`@param`/`@return` 仅在添加信息时保留。

### 核心风格、工具链与策略

##### CORE.04 单引号 [Required/Medium] — 普通字符串字面量使用单引号。
##### CORE.05 显式分号 [Required/Medium] — 显式使用分号结束语句，不依赖 ASI。
##### CORE.06 禁止 console.log [Required/Medium] — 通过 logger 输出日志，禁止 console.log。
##### CORE.07 缩进 [Required/Medium] — TypeScript 缩进必须采用 2 空格。
##### CORE.09 文档注释 [Required/Medium] — 类、export 方法及重要方法必须 JSDoc；常量用行前 `//` 注释。
##### CORE.10 文件行数 [Recommended/Medium] — 业务文件 300-500 行；组件/类文件 200-300 行；工具 100-200 行；大型模块 ≤800 行。
##### TOOL.01 类型检查 [Required/Medium] — 所有 TypeScript 文件必须通过标准工具链类型检查。
##### POL.01 一致性 [Recommended/Medium] — 规范未明确处与同文件现有代码保持一致；新文件必须用 Google 风格。

## 3. Security & production notes

- **SandoreError code 路由（LF.48/49/50/51/52）**：生命周期错误（pause/resume/retry 失败、question/permission 超时）应抛出携带 `code` 的 `SandoreError extends Error`；`catch (e: unknown)` 处先 `assertIsError(e)` 再按 `e.code` 路由；路由 `switch` 必须含 `default`（未知 code 走兜底分支）；比较 `code` 用 `===`（与 `null` 比较可用 `==`）。
- **schema 迁移与 z.infer 派生（LF.53/55/56）**：从 `CommandConfigSchema`/`WorkflowTaskStateSchema` 派生类型应直接 `z.infer<typeof ...>`，避免 `as` 断言；确需断言时经 `unknown` 双重断言并注释原因；对象字面量用 `: T` 注解而非 `as T`。运行时用 Zod `parse`/`safeParse` 校验外部数据而非断言。
- **domainTable/defineDomain 存储域（TS.11/12）**：存储域值避免 `any` 与 `{}`，用 `Record<string, T>`、`unknown` 或具体类型；vitest mock（`ctx.provide` 注入）中确需 `as any` 时加 `// tslint:disable-next-line:no-any` 注释说明原因。
- **类型检查完整性（TOOL.02）**：禁止用 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` 掩盖 schema 迁移类型错误；测试中确需时改用带注释的强制转换。
