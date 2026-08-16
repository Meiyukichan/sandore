# Furina CleanCode Exploration Result

# Explore Content

Task 4 host-agent-01：新建 packages/sandore/workflow/src/host-agent.ts（createHostAgentSetup 工厂，注册 8 个 sandore_* 工具 + systemPrompt.section 注入编排器说明），改造 workflow-engine.ts 的 startInstance（ctx.sessions.create → ctx.agents.create）、ActiveInstance 增 hostAgent 字段、runnerConfig 注入 StepRunnerConfig.hostAgent；并配套 host-agent.spec.ts / workflow-engine.spec.ts（vitest + FakeAgentRegistry/FakeAgent mock）。依赖 seam-01 的 AgentRegistry/AgentSetup/AgentSetupContext/AgentHandle 与 tools-01 的 createSandoreTools。

# Explore Type

cleancode

# Exploration Result

## 1. Scope

- **Requirement summary**: 新建宿主主代理工厂 createHostAgentSetup（返回 AgentSetup 回调），改造 workflow-engine.ts 使 startInstance 创建真 Agent、ActiveInstance 增 hostAgent、runnerConfig 注入 hostAgent；含 vitest 测试与 mock。
- **Code features affected**: 模块导入/导出、工厂函数与回调、类（SandoreEngineRuntime）与接口（ActiveInstance/StepRunnerConfig）、严格类型与断言、错误处理（SandoreError）、异步与 fire-and-forget、JSDoc 中文文档、vitest 测试与 mock。

## 2. Guidelines

### 模块组织与导入导出

- **文件顺序 [Required]**：文件依次由 版权信息（如有）→ 带 `@fileoverview` 的 JSDoc（如有）→ 导入语句 → 文件实现 组成，各部分之间恰好一个空行。
- **导入路径（相对导入）[Recommended]**：同一（逻辑）项目内文件用相对导入（`./foo`），避免 `../../../` 过深；项目约定 ESM 相对导入带 `.ts` 扩展名。
- **命名空间 vs 具名导入 [Recommended]**：频繁/名称清晰的符号（如 `describe`/`it`/`expect`）用具名导入；大型 API 多符号用命名空间导入（`import * as foo from './foo'`）。
- **导出（仅命名导出）[Required]**：所有代码使用命名导出，禁止默认导出（`export default`）。
- **导出可见性 [Recommended]**：只导出模块外部使用的符号，最小化模块导出 API 表面。
- **可变导出 [Required]**：禁止 `export let`；需要外部可变绑定时改用显式 getter 函数。
- **容器类 [Required]**：不要创建含静态成员作命名空间手段的容器类，应导出单个常量/函数。
- **import/export type [Recommended]**：仅作类型使用的导入用 `import type {...}`（或 `import {type Foo, Bar}`）；类型再导出用 `export type {AnInterface}`。
- **禁止 namespace/require [Required]**：禁止 `namespace Foo {...}`、`/// <reference>`、`import x = require(...)`，必须用 ES6 `import`/`export`。

### 命名

- **标识符与命名风格 [Required]**：标识符只用 ASCII 字母/数字/下划线/（极少）`$`；不用下划线前后缀、不用 `opt_` 前缀、不特别标记接口（禁止 `IMyInterface`）。
- **描述性名称 [Required]**：名称必须描述清晰，不用不熟悉缩写、不删单词内字母；仅局部 ≤10 行作用域可用短名。
- **Camel case [Required]**：缩写视为整词：`loadHttpUrl` 而非 `loadHTTPURL`（平台名如 `XMLHttpRequest` 除外）。
- **常量 CONSTANT_CASE [Required]**：意图不可变的模块级常量、模块级类的 `static readonly` 属性、枚举值用 `CONSTANT_CASE`；函数内局部常量用 `lowerCamelCase`。
- **测试方法名 [Recommended]**：xUnit 风格测试名可用 `_` 分隔结构，如 `testX_whenY_doesZ()`（适用于 vitest 的 `it` 描述）。

### 类与接口

- **类声明与方法声明 [Required]**：类声明禁止以分号结尾；类方法间禁止用分号分隔；方法声明用单个空行与周围代码分隔；构造函数必须用括号（`new Foo()`）。
- **禁止 #private 字段 [Required]**：不用 `#ident` 私有字段，改用 TypeScript 可见性注解（`private ident = 1`）。
- **readonly 与参数属性 [Recommended]**：构造函数外从不重新赋值的属性加 `readonly`；优先用参数属性 `constructor(private readonly foo: Foo) {}`；字段优先在声明处初始化。
- **可见性 [Recommended]**：尽可能限制符号可见性；默认 public，除非声明非只读 public 参数属性否则不用 `public` 修饰符；禁止 `obj['foo']` 绕过可见性。
- **getter 必须是纯函数 [Required]**：getter 必须无副作用、结果一致；禁止仅为隐藏属性定义"直通"访问器。
- **接口优于类型别名 [Required]**：声明对象结构类型时用 `interface`（如 `interface ActiveInstance {...}`）而非 `type X = {...}` 字面量别名。
- **结构类型声明处显式注解 [Recommended]**：在符号声明处显式包含类型（`const foo: Foo = {...}`）。
- **可选字段优先于 |undefined [Required]**：可选字段/参数用 `?`（`milk?: Whole|LowFat`），类型别名禁止在联合中内嵌 `|null`/`|undefined`，应在使用处就近添加并就近处理空值。
- **Array<T> 语法糖 [Required]**：简单类型用 `T[]`/`readonly T[]`，复杂类型用 `Array<T>`。
- **索引签名 / Record [Recommended]**：对象作字典用索引签名 `{[key: string]: T}`，或考虑 `Map`/`Set`/`Record<Keys, V>`。
- **映射与条件类型 [Recommended]**：始终用能表达代码的最简单类型构造。
- **包装器类型 [Required]**：禁止 `String`/`Boolean`/`Number` 包装器类型，始终用小写原始类型 `string`/`boolean`/`number`。

### 函数与异步

- **命名函数优先用函数声明 [Recommended]**：定义命名函数（如 `createHostAgentSetup`）优先用 `function` 声明而非箭头函数；方法体内嵌套回调优先箭头函数。
- **不用函数表达式 [Required]**：不用 `function() {...}` 表达式，用箭头函数代替；仅在必须动态重绑定 `this` 或生成器时例外。
- **箭头函数体（简洁体 vs 块体）[Required]**：仅当返回值被使用时用简洁体；返回值未使用时用块体（或 `void` 运算符）确保返回类型为 `void`。
- **函数中的 this [Required]**：只在类构造/方法、显式声明 `this` 类型的函数或箭头函数中使用 `this`；优先传递箭头函数作回调并显式转发参数。
- **箭头函数作为属性 [Recommended]**：类通常不应含初始化为箭头函数的属性；用 `const handler = (x) => { this.listener(x); }` 调用实例方法。
- **参数初始化器 [Required]**：默认初始化器禁止可观察副作用、保持简单；多于少数无自然顺序的可选参数优先用解构创建可读 API。
- **函数格式化 [Recommended]**：函数体开头/结尾不允许空行；可用单个空行做逻辑分组；单参数箭头函数括号可省略。

### 严格类型与断言（High 规则）

- **类型与非空断言 [Required]**：类型断言（`x as SomeType`）和非空断言（`y!`）不安全——只让编译器静音、不插入运行时检查，可能导致运行时崩溃；没有明显或明确原因时**不应**使用。合规写法：

  ```ts
  // assuming Foo is a class.
  if (x instanceof Foo) {
    x.foo();
  }
  if (y) {
    y.bar();
  }
  ```

  当可确定断言安全时添加说明性注释；类型断言必须用 `as` 语法（而非尖括号）；双重断言通过 `unknown`（而非 `any`/`{}`）作中间类型；对象字面量用类型注解（`: Foo`）而非断言（`as Foo`）以捕获重构错误：

  ```ts
  // z must be Foo because ...
  const x = (z as Foo).length;
  // x is a Foo here, because...
  (x as unknown as Foo).fooMethod();
  const foo: Foo = {
    bar: 123,
    bam: 'abc',  // complains about "bam" not being defined on Foo.
  };
  ```

- **禁止 any（优先 unknown/更具体类型）[Recommended]**：`any` 危险会掩盖编程错误；改用更具体类型、`unknown`（需类型守卫缩小后才可安全使用），或在测试构造 mock 时用 `as any` 并加注释说明理由。
- **禁止空类型 {} [Recommended]**：不用 `{}` 表示任意非空值；优先 `unknown`、`Record<string, T>`、`object`。
- **类型推断与返回类型 [Recommended]**：简单类型（string/number/boolean/new 表达式）可省略注解；复杂表达式可加注解；返回类型注解由作者/审查者决定。

### 错误处理（SandoreError，High 规则）

- **仅抛出 Error（含 Promise 拒绝）[Required]**：JS/TS 允许抛出或拒绝任意值，但非 `Error` 值不填充堆栈信息，调试困难；该约束延伸到 `Promise` 拒绝值。只抛出（的子类）`Error`。合规写法：

  ```ts
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

- **使用 new 实例化异常 [Required]**：实例化异常时始终用 `new Error()`，而非仅 `Error()`。合规写法：

  ```ts
  throw new Error('Foo is not a valid bar.');
  ```

- **捕获与重抛 [Required]**：捕获错误时**应**假设所有抛出的错误都是 `Error` 的实例；除非被调用的 API 确定会抛非 `Error`，异常处理程序**禁止**防御性处理非 `Error` 类型（此时加注释说明来源）。避免过度防御性编程。合规写法：

  ```ts
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

- **空 catch 块需注释 [Required]**：适合在 catch 块中完全不做动作时，应在注释中解释正当理由。合规写法：

  ```ts
  try {
    return handleNumericResponse(response);
  } catch (e: unknown) {
    // Response is not numeric. Continue to handle as text.
  }
  return handleTextResponse(response);
  ```

- **保持 try 块精简 [Recommended]**：限制 try 块内代码量，将非抛出行移出 try/catch；循环内可扩大 try 覆盖整个循环。

### 注释与 JSDoc

- **JSDoc vs 普通注释 [Required]**：文档化用 `/** JSDoc */`，实现注释用 `//`；多行注释必须用多个单行 `//` 而非 `/* */` 块注释。
- **JSDoc 格式与 Markdown [Required]**：JSDoc 必须格式良好，用 Markdown 编写；单行溢出到多行时 `/**` 和 `*/` 单独成行。
- **JSDoc 标签与行包裹 [Required]**：标签必须各占一行（`@param`/`@return` 分行）；块标签包裹缩进四个空格。
- **文档化顶层导出/类/方法 [Required]**：模块所有顶层导出必须文档化；类注释提供足够信息说明用法；方法描述以第三人称动词短语开头（隐含"此方法…"）；参数属性用 `@param` 文档化。
- **JSDoc 类型注解冗余 [Required]**：禁止在 `@param`/`@return` 块重复声明 TypeScript 类型，禁止写 `@implements`/`@enum`/`@private`。
- **注释需提供实际信息 [Required]**：避免仅重复参数名/类型的注释；调用时参数含义不清用 `/* name= */ value` 注释置于参数值之前。
- **文件头 JSDoc 样式 [Required]**：

  ```ts
  /**
   * Brief description of this file
   * @author {author} {author email}
   * @copyright {当前年份} {author}
   */
  ```

### 工具链与测试

- **禁止 @ts-ignore/@ts-expect-error/@ts-nocheck [Required]**：它们表面上"修复"编译器错误，实际特定编译器错误通常由更大问题引起，可更直接修复；`@ts-expect-error` 抑制所有错误，容易过度匹配。当测试需处理运行时未检查值的 API 时，改用带注释的类型转换（`as` 或 `any`）把抑制限制在单个表达式上，或抑制 lint 警告并记录原因。
- **TypeScript 编译器与一致性 [Required]**：所有 TS 文件必须通过标准工具链类型检查（含 strict/exactOptionalPropertyTypes/noUncheckedIndexedAccess 编译期约束）。
- **策略 · 一致性 [Required]**：规范未覆盖的风格问题与同文件/同目录现有代码保持一致；新文件必须用 Google 风格，重大改动应同时重新格式化现有代码，避免机会主义风格修复。
- **策略 · 弃用 [Required]**：弃用方法/类/接口用 `@deprecated` JSDoc 标记，并给出清晰修复指引。

### 文件与格式

- **UTF-8 与非 ASCII 字符 [Required]**：源文件 UTF-8；中文等非 ASCII 字符用实际 Unicode 字符（勿用数字转义）。
- **格式约束 [Required]**：推荐 Node.js ES 模块；第三方库/多导出模块用命名空间导入；Node 内置模块必须默认导入；单引号；显式分号；禁止 `console.log`（用 logger 输出）；2 空格缩进。
- **文件行数 [Recommended]**：普通业务文件 300-500 行、组件/类文件 200-300 行、工具/配置 100-200 行、大型模块 ≤800 行。

## 3. Security & production notes

- **SandoreError(message, code) 必须继承 Error 并用 `new` 抛出**（对应「仅抛出 Error」+「使用 new 实例化异常」）：自定义异常类应 `class SandoreError extends Error {}`，构造时 `throw new SandoreError(message, code)`，保证堆栈信息完整、可被 `assertIsError` 正确识别。
- **fire-and-forget 异步**（对应「箭头函数体」+「仅抛出 Error」+「空 catch 块」）：发起不等待的异步调用时，返回值未使用须用块体或 `void` 运算符；`Promise.reject` 必须 reject `Error`；吞掉错误必须加注释说明理由。
- **strict + exactOptionalPropertyTypes**（对应「工具链」+「可选字段优先」）：`ActiveInstance.hostAgent?: AgentHandle` 这类可选字段赋值时禁止显式赋 `undefined`，应省略键或先 `if` 判断；`noUncheckedIndexedAccess` 下索引访问可能为 `undefined`，用运行时检查而非 `!`。
- **测试 mock**（对应「禁止 any」+「禁止 @ts-ignore」）：FakeAgentRegistry/FakeAgent 桩若需 `as any` 部分 mock，加注释说明理由；避免 `@ts-expect-error`，改用带注释的类型转换。
