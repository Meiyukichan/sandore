# Furina CleanCode Exploration Result

## Explore Content

精确核实 sandore 引擎 flow-eval-01（分支两阶段评估 + 循环管理）代码形状：DSH ctx.llm.stream 的 GenerateOptions 与 BlockAssembler/createUserMessage chunk 聚合；file-utils.ts 的 replacePassThroughVars/findFilesByGlob/globToRegex 导出；shell.ts 的 ShellExecutor/SubprocessRuntime 接缝；subagents.ts 的 finalAssistantOutput/Agent；schema.ts 的 DagBranch/DagLoop/BranchMeta/CommandConfig；step-runner.ts 的 buildPromptText/resolveProviderModel/StepRunner 构造；microflow/index.ts 导出与 vitest mock 测试范式（branch-evaluator.spec/loop-manager.spec 编写依据）。

## Explore Type

cleancode

## Exploration Result

### 1. Scope

- **Requirement summary**: 精确核实 sandore 引擎 flow-eval-01（分支两阶段评估 + 循环管理）相关模块代码形状，作为 `branch-evaluator.spec` / `loop-manager.spec` 的编写依据。
- **Code features affected**: Zod schema 与派生类型（`schema.ts` 的 `DagBranch`/`DagLoop`/`BranchMeta`/`CommandConfig`）；结构类型接缝（`shell.ts` 的 `ShellExecutor`/`SubprocessRuntime`，`subagents.ts` 的 `Agent`/`finalAssistantOutput`，`file-utils.ts` 的 `FileSystem`）；异步流式 chunk 聚合（`step-runner.ts` 的 `ctx.llm.stream` + `BlockAssembler`/`createUserMessage`/`GenerateOptions`）；模块导出（`file-utils.ts` 的 `replacePassThroughVars`/`findFilesByGlob`/`globToRegex`，`microflow/index.ts` 通配导出）；类构造（`StepRunner` 构造 + `buildPromptText`/`resolveProviderModel` 私有方法）；异常处理（`SandoreError`、`new Error`、`fillParams` try/catch 回退）；外部 JSON 形状校验（`parseOutputJson` 的 `unknown` + 字段校验 + 类型断言）；vitest mock 测试范式（Fake 类 + `ctx.provide` + `describe/it/expect`）。

### 2. Guidelines

#### 类型断言与外部数据形状校验

##### High-1 类型与非空断言 [Required]

**[Description]**

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。

因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。

不要使用以下形式：

```ts bad
(x as Foo).foo();

y!.bar();
```

当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。

```ts good
// assuming Foo is a class.
if (x instanceof Foo) {
  x.foo();
}

if (y) {
  y.bar();
}
```

有时由于代码的某些局部属性，你可以确定断言形式是安全的。在那些情况下，你应该添加说明来解释为什么你可以接受不安全的行为：

```ts good
// x is a Foo, because ...
(x as Foo).foo();

// y cannot be null, because ...
y!.bar();
```

如果类型或非空断言背后的推理是显而易见的，注释**可以**不是必需的。例如，生成的 proto 代码总是可空的，但可能在代码上下文中众所周知某些字段总是由后端提供。根据你的判断。

类型断言**必须**使用 `as` 语法（而不是尖括号语法）。这会在访问成员时强制在断言周围添加括号。

```ts bad
const x = (<Foo>z).length;
const y = <Foo>z.length;
```

```ts good
// z must be Foo because ...
const x = (z as Foo).length;
```

如果你确定断言是安全的，可以执行*双重断言*。这涉及通过 `unknown` 转换，因为它比所有类型都不具体。使用 `unknown`（而不是 `any` 或 `{}`）作为中间类型。

```ts good
// x is a Foo here, because...
(x as unknown as Foo).fooMethod();
```

**[Level]** Required

##### High-2 只抛 Error [Required]

**[Description]**

JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。

相反，只抛出（的子类）`Error`：

```ts good
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

**[Level]** Required

##### High-3 使用 unknown 而非 any [Required]

**[Description]**

`any` 类型允许赋值到任何其他类型并取消引用其上的任何属性。通常这种行为不是必要或期望的，代码只需要表达类型是未知的。在那种情况下使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。

```ts good
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

要安全地使用 `unknown` 值，使用类型守卫缩小类型。

**[Level]** Required

#### 模块与导出（file-utils.ts / microflow/index.ts）

##### SFS.01 命名导出，禁止默认导出 [Required]
所有代码使用命名导出，不使用默认导出；命名导出在导入未声明的成员时会报错，便于集中维护。

##### SFS.02 导出可见性 [Required]
只导出在模块外部使用的符号，最小化模块的导出 API 表面。

##### SFS.03 禁止 `export let` [Required]
可变导出产生难以理解和调试的代码；需要外部可变绑定时改用显式 getter 函数。

##### SFS.04 禁止容器类 [Required]
不要创建带静态方法/属性的容器类作为命名空间，应导出单个常量和函数。

##### SFS.05 `import type` / `export type` [Required]
仅作为类型使用的导入用 `import type {...}`；重新导出类型用 `export type`。

##### SFS.06 使用模块而非 namespace [Required]
代码必须使用 ES6 `import`/`export` 形式组织，禁止 `namespace` 关键字与 `require`。

##### SFS.07 相对导入路径 [Recommended]
同一逻辑项目内引用文件应使用相对导入（`./foo`），限制过多父目录层级 `../../../`。

##### SFS.08 命名空间导入 vs 具名导入 [Recommended]
频繁使用或名称清晰的符号用具名导入；使用大型 API 的众多符号时用命名空间导入。

#### 结构类型接缝（shell.ts / subagents.ts / file-utils.ts）

##### TS.04 使用结构类型（接口而非类） [Required]
在提供基于结构的实现时，在符号声明处显式包含类型（如 `const foo: Foo = {...}`），以获得更精确的类型检查；用接口定义结构类型而非类。

##### TS.05 接口优于类型字面量别名 [Recommended]
声明对象类型时使用 `interface` 而非 `type X = {...}`。

##### TS.06 `T[]` 数组语法糖 [Required]
简单类型使用 `T[]`/`readonly T[]`；复杂类型（联合、对象字面量）才用 `Array<T>`。

##### TS.07 索引签名 / `Record` [Recommended]
对象作为关联数组时用索引签名 `{[key: string]: T}`（键提供有意义标签）；静态键集合考虑 `Record<Keys, T>`；否则考虑 `Map`/`Set`。

##### TS.03 禁止可空类型别名、可选优于 `|undefined` [Required]
类型别名禁止在联合中包含 `|null`/`|undefined`，应只在实际使用时添加；优先用 `?` 可选参数/字段而非 `|undefined`。

##### TS.02 返回类型 [Recommended]
是否为函数/方法添加返回类型由作者决定，审查者可要求为复杂返回类型添加注解。

#### Zod schema 与派生类型（schema.ts）

##### TS.01 类型推断 [Recommended]
可依赖编译器推断；对初始化即为 `string`/`number`/`boolean`/`RegExp`/`new` 的变量省略注解；复杂表达式可加注解提升可读性。

##### TS.08 映射与条件类型取最简单 [Recommended]
始终使用能表达代码的最简单类型构造；少量重复通常比复杂类型表达式更便宜（`z.infer` 派生类型是既定范式）。

##### TS.12 禁止包装器类型 [Required]
禁止使用 `String`/`Boolean`/`Number` 包装器类型，始终用小写原始类型。

#### 类构造（step-runner.ts 的 StepRunner）

##### LF.04 类声明与方法声明分号 [Required]
类声明禁止以分号结尾；类方法声明之间禁止用分号分隔。

##### LF.05 禁止 `#private` 字段 [Required]
不使用私有标识符 `#ident`，改用 TypeScript 可见性注解（`private`）。

##### LF.06 使用 `readonly` [Recommended]
在构造函数外部从不重新赋值的属性加 `readonly` 修饰符。

##### LF.07 参数属性 [Recommended]
用 `constructor(private readonly barService: BarService) {}` 代替手动赋值字段。

##### LF.08 字段初始化器 [Recommended]
非参数类成员在声明处初始化（可省略构造函数）；可选字段显式初始化为 `undefined` 防 shape 变化。

##### LF.09 可见性 [Required]
尽可能限制符号可见性；默认 public，不要写不必要的 `public` 修饰符。

##### LF.11 避免私有静态方法 [Recommended]
优先用模块局部函数而非私有静态方法。

##### LF.13 构造函数必须用括号 [Required]
构造函数调用必须使用括号（`new Foo()`）；具有参数属性/可见性修饰符的构造函数不应省略。

#### 函数（buildPromptText / resolveProviderModel / replacePassThroughVars / globToRegex / finalAssistantOutput）

##### LF.14 命名函数用函数声明 [Required]
定义命名函数优先使用函数声明而非箭头函数/函数表达式。

##### LF.15 不用函数表达式 [Required]
不用 `function() {...}` 表达式，改用箭头函数（仅动态重绑定 `this` 或生成器除外）。

##### LF.16 箭头函数体 [Recommended]
返回值被使用时用简洁体，返回值未使用时用块体。

##### LF.17 函数中禁止 `this` [Required]
除专门为重新绑定 `this` 而存在的函数外，函数表达式/函数声明中禁止使用 `this`。

#### 异步流式聚合与控制流（ctx.llm.stream for-await / switch 分发）

##### LF.20 控制流大括号与 switch [Required]
控制流语句（`if`/`for`/`while`）始终使用大括号（可放一行的 `if` 除外）；所有 `switch` 必须含 `default` 分支且置最后；非空 `case` 组禁止 fall through；优先 `for (... of ...)` 遍历。

##### LF.21 严格相等 [Required]
必须使用 `===`/`!==`；与字面量 `null` 比较时可用 `==`/`!=`。

##### LF.19 单引号与模板字面量 [Required]
普通字符串字面量用单引号 `'`；禁止行延续；复杂字符串连接用模板字面量（反引号）。

#### 异常处理（SandoreError / new Error / fillParams 回退）

##### LF.25 异常处理约束 [Required]
实例化异常始终用 `new Error()`；只抛 `Error` 及其子类；捕获错误时假设所有抛出的值都是 `Error` 实例；空 catch 块必须有解释注释；在不损害可读性时精简 try 块内的代码量。

#### 命名（标识符 / 常量 / 测试名）

##### NAM.01 ASCII 标识符 [Required]
标识符只使用 ASCII 字母、数字、下划线与（罕见的）`$`。

##### NAM.02 大小写风格 [Required]
class/interface/type/enum 用 UpperCamelCase；变量/参数/函数/方法/属性/模块别名用 lowerCamelCase；全局常量（含 enum 值）用 CONSTANT_CASE。

##### NAM.03 名称不含类型信息 [Required]
名称不应装饰类型信息；禁尾部/前导下划线、`opt_` 前缀；不特别标记接口。

##### NAM.04 描述性名称 [Required]
名称必须描述性；不用含义模糊的缩写、不删词内字母；10 行以内局部作用域的短名（单字母）可用。

##### NAM.05 CamelCase 缩写 [Required]
缩写视为整词，如 `loadHttpUrl` 而非 `loadHTTPURL`。

##### NAM.06 常量 [Required]
CONSTANT_CASE 表示值意图不可变；只有模块级符号/模块级类静态字段/模块级枚举值可用 CONSTANT_CASE，函数内局部值用 lowerCamelCase。

##### NAM.07 测试名 [Recommended]
xUnit 风格测试方法名可用 `_` 分隔结构，如 `testX_whenY_doesZ()`。

#### 注释与文档（@fileoverview / JSDoc）

##### CD.01 JSDoc 与多行注释 [Required]
文档化用 `/** JSDoc */`，实现注释用 `//`；多行注释必须用多个 `//` 单行注释，不用 `/* */` 块注释。

##### CD.02 JSDoc 格式 [Required]
JSDoc 必须格式良好；单行注释溢出多行时 `/**` 与 `*/` 单独成行；用 Markdown 编写（列表用 Markdown 列表语法）。

##### CD.05 顶层导出全部文档化 [Required]
模块的所有顶层导出必须用 JSDoc 文档化。

##### CD.06 类注释 [Recommended]
类的 JSDoc 应说明如何使用类及正确使用的额外考虑。

##### CD.07 方法/函数注释 [Recommended]
方法描述以第三人称动词短语开头（如「此方法 …」）。

##### CD.08 参数属性注释 [Recommended]
参数属性用 `@param` JSDoc 注解文档化。

##### CD.09 JSDoc 类型注解冗余 [Required]
禁止在 `@param`/`@return` 中重复声明类型，禁止写 `@implements`/`@enum`/`@private`/`@override` 等冗余标签。

##### CD.10 注释需有信息量 [Recommended]
注释避免仅重复参数名/类型；`@param`/`@return` 仅在添加信息时使用。

#### 工具链与测试（vitest mock 范式）

##### TC.01 类型检查 [Required]
所有 TypeScript 文件必须通过标准工具链类型检查。

##### TC.02 禁 `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` [Required]
不使用这些抑制；单元测试中可用 `@ts-expect-error` 但通常不应，优先强制转换为预期类型或 `any` 并加说明性注释，将抑制限制在单个表达式上。

#### 核心风格与文件基础

##### CS.01 ES 模块 [Required]
推荐 Node.js ES 模块。

##### CS.02 命名空间导入 [Required]
第三方库或多导出模块用命名空间导入。

##### CS.03 Node 内置模块默认导入 [Required]
Node.js 内置模块必须使用默认导入，如 `import fs from 'fs'`。

##### CS.04 单引号 / CS.05 分号 [Required]
使用单引号；显式使用分号，不依赖 ASI。

##### CS.06 禁 console.log [Required]
禁止使用 `console.log`，通过 logger 输出日志。

##### CS.07 2 空格缩进 [Required]
TypeScript 缩进必须采用 2 个空格。

##### CS.08 文件行数 [Recommended]
普通业务文件 300–500 行；组件/类文件 200–300 行；工具/配置文件 100–200 行；大型模块不超过 800 行。

##### SFB.01 UTF-8 / SFB.02 非 ASCII / SFB.03 特殊转义 [Required]
源文件 UTF-8 编码；非 ASCII 字符用实际 Unicode 字符（不可打印字符用十六进制/Unicode 转义加注释）；有特殊转义序列的字符必须用该序列而非数字转义。

##### POL.01 一致性 [Required]
未明确规定的风格问题与同一文件/目录现有代码保持一致；新文件必须使用 Google 风格。

### 3. Security & production notes

- **High-1 类型与非空断言**：`file-utils.ts` 的 `parseOutputJson` 对 `JSON.parse` 结果用 `(raw as {...})` 断言后逐字段校验、测试中用 `llm as unknown as LlmRuntime` 注入 mock，都属「局部属性保证安全」的断言，需保留说明性注释；`branch-evaluator.spec`/`loop-manager.spec` 中 mock 注入必须经 `unknown` 中间类型双重断言，禁用裸 `as` 或 `!`。
- **High-2 只抛 Error**：`StepRunner` 抛出的 `SandoreError`（`STEP_TIMEOUT`/`STEP_EXECUTION`）是 `Error` 子类；新写的 `branch-evaluator`/`loop-manager` 评估逻辑应继续用 `new SandoreError(...)` 而非字符串或裸对象，否则测试的 `rejects.toMatchObject({ code })` 会失效。
- **High-3 unknown 而非 any**：分支两阶段评估若涉及解析 LLM 返回 JSON（类比 `parseOutputJson`），必须从 `unknown` 起步逐字段窄化，禁止直接 `as any`。
- **TC.02 类型抑制**：`ctx.provide('llm', llm as unknown as LlmRuntime)` 已在现有 `step-runner.spec.ts` 中确立范式，测试内避免 `@ts-expect-error`，改用单表达式转换 + 注释。
