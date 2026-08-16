# Furina CleanCode Exploration Result

# Explore Content

在 sandore 仓库（TypeScript monorepo）中为 Task 4 lifecycle-01（单步/全局暂停与恢复 pauseStep/resumeStep/pauseAllSteps/resumeAllSteps）探索参考实现与落点：新建 packages/sandore/workflow/src/lifecycle-manager.ts。涉及文件：workflow/src/workflow-engine.ts（ActiveInstance、instances Map、persistState、emitContained/safeAppend 双发、runnerConfig、runInstance 主循环、abortInstance）、microflow/src/subagents.ts（SubagentRuntime.interrupt/followup、Agent.status/inbox、SubagentInterruptAuthority）、microflow/src/stage-executor.ts/step-runner.ts（executedSteps 的 sessionMeta.childId、StepStatus 枚举）、workflow/src/schema.ts（WorkflowTaskStateSchema.pausedChildIds、ExecutedStepDefaultSchema.pausedAt/resumedAt/resumePrompt）、workflow/src/types.ts（ExecutedStepDefault/StepStatus/DagRunStatus）、测试 mock（FakeSubagents/FakeAgent）、workflow-engine.spec.ts 对 abortInstance 的断言。需要了解 pause/resume 实现应遵循的 TypeScript 编码规范（纯 type-only 文件、事件双发、持久化、错误处理等）。

# Explore Type

cleancode

# Exploration Result

# Clean-TypeScript 编码规范 — sandore 工作流引擎 Task 4 lifecycle-01（单步/全局暂停与恢复）

## 1. Scope

- **Requirement summary**: 为 sandore 工作流引擎 Task 4 lifecycle-01 新建 lifecycle-manager.ts，实现 pauseStep/resumeStep/pauseAllSteps/resumeAllSteps：经 executedSteps[].sessionMeta.childId 反查子代理 SessionId，调 ctx.subagents.interrupt(childId, {kind:'ancestor', agent:hostAgent}) 挂起子代理，维护「暂停登记表」pausedChildIds（内存 Set 与 WorkflowTaskState.pausedChildIds 数组同步、单一权威），置 Step 状态 paused（pausedAt）、resume 时 followup 后置 running（resumedAt/resumePrompt），每次状态变化 persistState 并双发 sandore/step-paused、sandore/step-resumed 事件；非法/终态/非登记 Step 抛 SandoreError。
- **Code features affected**: 类定义（LifecycleManager）与字段初始化（pausedChildIds Set）、异步方法、结构类型接口（Agent/Session/SubagentInterruptAuthority 判别联合 readonly 字段）、SandoreError 错误处理与 code 路由、类型断言（executedSteps as unknown as、childId 反查）、Zod 派生类型（WorkflowTaskState/ExecutedStepDefault 的可选 pause 字段）、事件双发（emitContained/safeAppend）、import type/export type、vitest mock（FakeSubagents.interrupt 记录 / FakeAgent）。

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

##### LF.52 Equality checks [Required/High]

**[Description]**

始终使用严格相等（`===`）和不等于（`!==`）。双等运算符会导致容易出错的类型强制转换，难以理解，且对 JavaScript 虚拟机实现起来更慢。另请参阅 JavaScript 相等表。**异常**：与字面量 `null` 值的比较**可以**使用 `==` 和 `!=` 运算符来同时覆盖 `null` 和 `undefined` 值。

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

### 类型断言与 executedSteps/childId 收窄

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

### 类型安全（Agent.ctx / mock 桩）

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

##### CORE.01 ES 模块 [Recommended/Medium] — 推荐使用 Node.js ES 模块。
##### CORE.02 命名空间导入 [Recommended/Medium] — 第三方库或多导出模块使用命名空间导入（`import * as ns from '...'`）。
##### CORE.03 Node 内置模块默认导入 [Required/Medium] — Node.js 内置模块必须默认导入（`import fs from 'fs'`）。
##### SRC.01 文件顺序 [Required/Medium] — 文件按 版权信息（如有）→ 带 `@fileoverview` 的 JSDoc（如有）→ 导入语句 → 文件实现 依次排列，各部分之间恰好一个空行。
##### SRC.06 命名导出 [Required/Medium] — 所有代码使用命名导出，禁止默认导出。
##### SRC.07 导出可见性 [Recommended/Medium] — 只导出模块外部使用的符号，最小化导出 API 表面。
##### SRC.10 Import type [Recommended/Medium] — 仅作类型使用的导入用 `import type {...}` 或 `import {type Foo, Bar}`。
##### SRC.11 Export type [Recommended/Medium] — 重新导出类型用 `export type {...} from '...'`。
##### SRC.12 使用模块而非命名空间 [Required/Medium] — 禁止 `namespace Foo {}` 与 `require`/`import x = require()`；`declare module` 接口合并仅在与第三方库（如 cordis）接口时允许。

### 结构类型接口、类与参数属性

##### TS.06 结构类型 [Recommended/Medium] — 结构类型在声明处显式标注类型，以便在声明点（而非调用点）得到错误报告。
##### TS.07 接口优于类型字面量别名 [Recommended/Medium] — 声明对象类型用 `interface` 而非 `type Foo = {...}`（联合/元组/原始类型别名除外）。
##### TS.08 Array 类型 [Recommended/Medium] — 简单类型用 `T[]`/`readonly T[]`，复杂类型用 `Array<T>`。
##### LF.01 const/let [Required/Medium] — 始终用 `const`/`let` 声明变量，默认 `const`，禁止 `var`。
##### LF.17 构造函数 [Required/Medium] — 构造函数调用必须带括号；空构造函数或仅委托 super 的构造函数应省略（有参数属性/装饰器者除外）。
##### LF.18 参数属性 [Recommended/Medium] — 用 `constructor(private readonly x: X)` 参数属性替代显式成员初始化器。
##### LF.19 字段初始化 [Recommended/Medium] — 类成员非参数时在声明处初始化（如 `private readonly pausedChildIds = new Set<string>()`）。
##### LF.23 可见性 [Recommended/Medium] — 尽可能限制可见性；禁止多余 `public`（非只读 public 参数属性除外）；用 `readonly` 标记不在构造函数外重新赋值的属性。
##### DOC.10 参数属性注释 [Recommended/Medium] — 参数属性用 JSDoc `@param` 注解文档化。

### 类型系统：Zod 派生与可选 pause 字段

##### TS.01 类型推断 [Recommended/Medium] — 简单类型（string/number/boolean/RegExp/new 表达式）省略注解；复杂表达式加注解。
##### TS.02 返回类型 [Recommended/Medium] — 复杂返回类型应添加注解，审查者可要求澄清。
##### TS.04 可空类型别名 [Required/Medium] — 类型别名禁止包含 `|null`/`|undefined`，应在实际使用时添加。
##### TS.05 优先可选参数 [Recommended/Medium] — 用 `?` 可选字段/参数而非 `|undefined`（`pausedAt?`/`resumedAt?`/`resumePrompt?`）。
##### TS.09 索引签名 [Recommended/Medium] — 关联数组用索引签名 `{[key: string]: T}` 且键取有意义标签；考虑用 `Map`/`Set`/`Record`。
##### TS.10 映射与条件类型 [Recommended/Medium] — `z.infer` 等派生类型使用最简单的类型构造；一点重复比复杂类型表达式成本低。
##### TS.12 `{}` 空类型 [Recommended/Medium] — 避免 `{}`，优先 `unknown`/`Record<string, T>`/`object`。
##### TS.14 包装器类型 [Required/Medium] — 禁止 `String`/`Boolean`/`Number` 包装器类型，始终用小写原始类型。

### 异步方法、遍历与控制流

##### LF.43 控制流大括号 [Required/Medium] — 控制流语句（if/else/for/do/while）始终使用大括号；可放一行的 if 可省略。
##### LF.45 遍历容器 [Recommended/Medium] — 优先 `for-of` 遍历数组/Set；`for-in` 仅用于字典对象且需 `hasOwnProperty` 过滤。
##### LF.47 用 new 实例化错误 [Required/Medium] — 实例化异常始终用 `new Error()`。
##### LF.51 Switch statements [Required/Medium] — 所有 `switch` 必须含 `default` 且放最后；非空 case 禁止 fall through（空的允许）。
##### LF.54 Type assertion syntax [Required/Medium] — 类型断言必须用 `as` 语法（而非尖括号语法）。
##### LF.57 精简 try 块 [Recommended/Medium] — 限制 try 块内代码量；循环内的 try 可扩大覆盖整个循环。

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
##### CORE.08 文件头部声明样式 [Required/Medium] — 新文件顶部用 `/** Brief description ... @author ... @copyright {当前年份} ... */` JSDoc 头部。
##### CORE.09 文档注释 [Required/Medium] — 类、export 方法及重要方法必须 JSDoc；常量用行前 `//` 注释。
##### CORE.10 文件行数 [Recommended/Medium] — 业务文件 300-500 行；组件/类文件 200-300 行；工具 100-200 行；大型模块 ≤800 行。
##### TOOL.01 类型检查 [Required/Medium] — 所有 TypeScript 文件必须通过标准工具链类型检查。
##### POL.01 一致性 [Recommended/Medium] — 规范未明确处与同文件现有代码保持一致；新文件必须用 Google 风格。

## 3. Security & production notes

- **SandoreError 抛出与 code（LF.48/49/50/47）**：lifecycle-01 的 pauseStep/resumeStep/pauseAllSteps/resumeAllSteps 对不存在实例、终态 Step、非登记 Step 应 `throw new SandoreError(message, code)`（code ∈ `NODE_NOT_FOUND`/`INVALID_OPERATION`，`SandoreError extends Error`）；`persistState` 与 `emitContained`/`safeAppend` 的 `catch (error)` 吞错必须 warn（非空 catch 且附说明），不得静默失败；`Promise.reject`/`void Promise.resolve().catch()` 仅接受 `Error`。
- **暂停登记表单一权威（LF.52/53/55）**：`pausedChildIds`（内存 `Set` 与 `WorkflowTaskState.pausedChildIds` 数组同步）是「暂停集」唯一权威，SHALL NOT 以 `Agent.status`（仅 `idle|running`）查询替代；`Set.has(childId)` 与 `status === 'running'`/`=== 'paused'` 判定用严格相等（与 `null` 比较可用 `==`），禁止对枚举状态做 `Boolean()`/`!!` 强制转换。
- **子代理 interrupt/followup 边界（LF.53/55/56/TS.11/12）**：`ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: hostAgent })` 的 `SubagentInterruptAuthority` 判别联合按字面量构造；`Agent.ctx: unknown` 需类型守卫收窄后再用，勿 `any`；`resumeStep` 的 followup content 用 `: ContentBlock[]` 对象字面量注解（`[{ type: 'text', text: resumePrompt ?? 默认恢复提示 }]`）而非 `as` 断言。
- **executedSteps 反查与快照替换（LF.53/55/56）**：按 `sessionMeta.childId` 反查 executedSteps 时，引擎既有 `entry as unknown as WorkflowTaskState['executedSteps'][number]` 经 `unknown` 双重断言并注释原因；暂停/恢复状态整体替换 `active.state = { ...active.state, pausedChildIds: [...], executedSteps: [...], updatedAt: now() }` 用 `: WorkflowTaskState` 注解而非断言。
- **事件双发与新增事件（LF.48/49/50）**：`sandore/step-paused`、`sandore/step-resumed`（seam.ts 已声明）沿用 `emitContained('sandore/xxx', [args])` + `safeAppend(() => session.append('sandore/xxx', payload))` 双发范式，监听器异常与 session.append 异常均吞掉并 `warn`；`resumePrompt` 作为可选载荷透传。
- **类型检查完整性（TOOL.02）**：禁止用 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` 掩盖 lifecycle-manager 的类型收窄错误；vitest mock（`FakeSubagents.interrupt` 记录 + `FakeAgent` 桩）确需部分 mock 时用带注释的 `as any` 强制转换替代。
