# Furina CleanCode Exploration Result

## Explore Content

Precise verification of the sandore microflow/workflow engine step-execution codebase as the refactoring baseline. Scope: packages/sandore/microflow/src/ (step-runner.ts, stage-executor.ts, subagents.ts, errors.ts, internal.ts, index.ts, *.spec.ts), packages/sandore/workflow/src/ (schema.ts, shell.ts, types.ts, workflow-engine.ts, seam.ts, yaml-parser.ts), packages/sandore/workflow/tests/mocks/ (llm.ts, shell.ts, subagents.ts, agents.ts, subprocess.ts). Constructs involved: TypeScript classes (StepRunner, StageExecutor), structural interface seams (ShellExecutor/SubprocessRuntime/SubagentRuntime/AgentRegistry), zod discriminated union CommandConfig (agent/prompt/shell/skill/mcp), Cordis Context module augmentation (ctx.shell/ctx.subprocess/ctx.subagents/ctx.agents), vitest mock-based test harness (FakeLlm/FakeShell/FakeSubagents/FakeAgentRegistry/FakeSubprocess). Goal: establish exact types, dispatch logic, seams and test patterns as verified facts for a subsequent agent/skill/mcp step-execution transformation.

## Explore Type

cleancode

## Exploration Result

### 1. Scope

- **Requirement summary**: 建立 sandore microflow/workflow 引擎 Step 执行代码库的精确类型、分发逻辑、接缝与测试模式基线，为后续 agent/skill/mcp Step 执行改造提供编码规范。
- **Code features affected**: TypeScript 类（StepRunner/StageExecutor）、结构接口接缝（ShellExecutor/SubprocessRuntime/SubagentRuntime/AgentRegistry）、zod 判别联合 CommandConfig（agent/prompt/shell/skill/mcp）、Cordis Context 模块增强（ctx.shell/subprocess/subagents/agents）、vitest mock 测试基座（FakeLlm/FakeShell/FakeSubagents/FakeAgentRegistry/FakeSubprocess）、异常处理（SandoreError）、异步流式执行。

### 2. Guidelines

#### 类型系统与外部数据校验（zod / CommandConfig）

##### TS.09 any 类型 / 使用 unknown 而非 any [Required]

TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型；使用 `unknown`；抑制 lint 警告并记录原因。`any` 类型允许赋值到任何其他类型并取消引用其上的任何属性。通常这种行为不是必要或期望的，代码只需要表达类型是未知的。在那种情况下使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。要安全地使用 `unknown` 值，使用类型守卫缩小类型。

```ts
// Use declared interfaces to represent server-side JSON.
declare interface MyUserJson {
  name: string;
  email: string
}

// Use type aliases for types that are repetitive to write.
type MyType = number|string;

// Or use inline object types for complex returns.
function getTwoThings(): {something: number, other: string} {
  // ...
  return {something, other};
}
```

```ts
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

```ts
// This test only needs a partial implementation of BookService, and if
// we overlooked something the test will fail in an obvious way.
// This is an intentionally unsafe partial mock
// tslint:disable-next-line:no-any
const mockBookService = ({get() { return mockBook; }} as any) as BookService;
```

##### TS.01 类型推断 [Recommended]
可依赖编译器类型推断；简单类型（string/number/boolean/RegExp/new 表达式）省略注解，复杂表达式可加注解提升可读性。

##### TS.02 可空别名禁含 null/undefined [Required]
类型别名禁止在联合中包含 `|null`/`|undefined`；应仅在别名实际使用处添加，并在值出现附近处理空值。

##### TS.03 可选参数优于 |undefined [Recommended]
使用 `?` 可选字段/参数而非 `|undefined` 联合；可选参数类型已隐式含 undefined。

##### TS.04 结构类型 [Recommended]
TypeScript 为结构化类型系统；结构实现应在符号声明处显式标注类型，以获得更精确检查与错误报告。

##### TS.05 接口优于类型字面量别名 [Recommended]
声明对象类型用接口而非对象字面量类型别名；联合/元组/原始类型才用类型别名。

##### TS.06 Array<T> 语法糖 [Recommended]
简单类型用 `T[]`/`readonly T[]`；仅复杂情形用 `Array<T>`（如 `Array<{n:number; s:string}>`）。

##### TS.07 索引签名 / Record / Map [Recommended]
对象作关联数组用 `{ [key: T]: V }`，键给有意义标签；优先考虑 `Map`/`Set`；键静态已知时用 `Record<Keys, ValueType>`。

##### TS.08 映射与条件类型从简 [Recommended]
映射/条件类型（含 `Extract`/`Pick`）使代码更难读、工具支持差；始终用可表达意图的最简单类型构造，重复比复杂表达式成本低。

##### TS.10 空类型 {} [Required]
`{}` 表示任意非空值，多数场景不合适；优先 `unknown`（任意值）、`Record<string, T>`（字典）、`object`（非原始类型）。

##### TS.11 包装类型小写 [Required]
禁止使用 `String`/`Boolean`/`Number` 包装类型，始终用小写原始类型；`Object` 与 `{}`/`object` 语义不同，避免用作构造函数。

#### 错误处理（SandoreError / 异常）

##### LANG.28 只抛出 Error [Required]

JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。

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

##### LANG.29 捕获与重抛 [Required]

捕获错误时，代码**应该**假设所有抛出的错误都是 `Error` 的实例。除非被调用的 API 确定知道会抛出非 `Error` 来违反上述规则，否则异常处理程序**禁止**防御性地处理非 `Error` 类型。在这种情况下，应包含注释以特别识别非 `Error` 的来源。

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

```ts
try {
  badApiThrowingStrings();
} catch (e: unknown) {
  // Note: bad API throws strings instead of errors.
  if (typeof e === 'string') { ... }
}
```

##### LANG.27 用 new 实例化错误 [Required]
实例化异常必须用 `new Error()` 而非直接调用 `Error()`，与其它对象实例化方式一致。

##### LANG.30 空 catch 块需注释 [Required]
在 catch 中什么都不做的情况极少；确需如此时必须在注释中说明正当理由。

##### LANG.34 精简 try 块 [Recommended]
限制 try 块内代码量，将非抛出行移出 try/catch，帮助读者定位抛出点。

#### 分发逻辑（CommandConfig 判别联合 / switch）

##### LANG.31 switch 必须含 default [Required]

所有 `switch` 语句**必须**包含一个 `default` 语句组，即使它不包含代码。`default` 语句组必须放在最后。在 switch 块中，每个语句组要么通过 `break`、`return` 语句或抛出异常突然终止，要么通过抛出一个异常。非空语句组（`case ...`）**禁止** fall through（由编译器强制）。空的语句组允许 fall through。

```ts
switch (x) {
  case Y:
    doSomethingElse();
    break;
  default:
    // nothing to do.
}
```

```ts
switch (x) {
  case X:
  case Y:
    doSomething();
    break;
  default: // nothing to do.
}
```

##### LANG.25 控制流大括号 [Required]
`if/else/for/do/while` 等控制流语句必须用大括号包裹，即使体只有单条语句；单行 `if` 可省略大括号。

##### LANG.26 for-of 遍历 [Recommended]
遍历数组优先 `for (... of someArr)`；`for-in` 仅用于字典对象并配 hasOwnProperty 过滤。

##### LANG.24 隐式布尔转换 [Required]
`if/for/while` 条件中不要使用显式布尔转换（`!!`）；枚举/联合值禁止隐式转布尔，须用比较运算符显式比较。

##### LANG.25 赋值与控制语句 [Required]
避免在控制语句中赋值（易与相等比较混淆）；确需时用额外括号表明意图。

#### 类型断言（as / 接缝边界）

##### LANG.33 类型与非空断言不安全 [Required]

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。有时由于代码的某些局部属性，你可以确定断言形式是安全的。在那些情况下，你应该添加说明来解释为什么你可以接受不安全的行为。类型断言**必须**使用 `as` 语法（而不是尖括号语法）。

```ts
// assuming Foo is a class.
if (x instanceof Foo) {
  x.foo();
}

if (y) {
  y.bar();
}
```

```ts
// x is a Foo, because ...
(x as Foo).foo();

// y cannot be null, because ...
y!.bar();
```

```ts
// z must be Foo because ...
const x = (z as Foo).length;
```

#### 类与可见性（StepRunner / StageExecutor）

##### LANG.05 类声明不加分号 [Required]
类声明禁止以分号结尾；类表达式语句必须加分号。

##### LANG.06 类方法不分号 [Required]
类方法声明间禁止用分号分隔；方法间用单个空行分隔。

##### LANG.07 静态方法限制 [Required]
优先模块本地函数而非私有静态方法；不得依赖静态方法动态分派；禁止在静态上下文中使用 `this`。

##### LANG.08 构造器 [Required]
构造器调用必须用括号（`new Foo()`）；含参数属性/可见性修饰符/参数装饰器的构造器不可省略空构造器体。

##### LANG.09 禁 #private 字段 [Required]
使用 TypeScript 可见性注解（`private`）而非 `#` 私有字段。

##### LANG.10 readonly 修饰 [Recommended]
对构造器外从不重新赋值的属性加 `readonly`（无需深不可变）。

##### LANG.11 参数属性 [Recommended]
用参数属性（`constructor(private readonly x: X)`）而非显式成员+赋值；需文档时用 `@param`。

##### LANG.14 可见性最小化 [Recommended]
尽可能限制符号可见性；TS 默认 public，除声明非只读 public 参数属性外不要写 `public` 修饰符。

#### 函数与异步（async/await / for-await-of）

##### LANG.15 具名函数用函数声明 [Recommended]
定义具名函数优先用函数声明而非箭头/函数表达式；箭头函数可在需显式类型注解时使用。

##### LANG.16 禁函数表达式 [Required]
不要用函数表达式，用箭头函数替代（例外：需动态重绑 this，或生成器函数）。

##### LANG.17 箭头函数体 [Recommended]
返回值被使用时用简洁体；返回值未使用时用块体确保 `void`。

##### LANG.18 this 使用限制 [Required]
仅类构造器/方法、显式声明 this 类型的函数、或作用域可用的箭头函数中使用 `this`。

##### LANG.19 回调优先箭头函数 [Recommended]
避免把命名回调传给高阶函数（参数可能意外传入）；优先显式转发参数的箭头函数。

##### LANG.01 const/let [Required]
始终 `const`/`let`，默认 `const`，禁 `var`；变量禁止在声明前使用。

##### LANG.02 每行单变量 [Required]
每个局部变量声明只声明一个变量（禁 `let a = 1, b = 2;`）。

##### LANG.04 展开必须匹配 [Required]
展开值必须与创建内容匹配：建数组只展开可迭代对象，建对象只展开对象；禁展开原始类型/数组/类实例。

#### 字面量与类型转换

##### LANG.21 单引号 [Required]
普通字符串用单引号 `'`；含单引号时考虑模板字符串。

##### LANG.22 模板字面量 [Recommended]
复杂字符串连接（多字面量/多行）用模板字面量而非 `+` 拼接。

##### LANG.23 类型转换 [Required]
用 `String()`/`Boolean()`/`Number()` 或 `!!` 转换；枚举/联合值禁止转布尔；`Number()` 须显式检查 NaN；禁止一元 `+`、`parseInt`/`parseFloat`（radix≠10 除外）。

##### SFB.01 非 ASCII 字符 [Required]
非 ASCII 字符使用实际 Unicode 字符（如中文），不可打印字符才用转义并附注释。

#### 导入导出与模块（接缝 / declare module）

##### SFS.01 文件顺序 [Required]
文件按 版权信息 → @fileoverview/@module JSDoc → 导入 → 实现 依次排列，各部分间恰一空行。

##### SFS.02 命名导出 / 禁默认导出 [Required]
所有代码用命名导出；禁止默认导出，保证导入统一且导入未声明成员时报错。

##### SFS.03 import type / export type [Recommended]
仅作类型使用的导入用 `import type`；重导出类型用 `export type`。

##### SFS.04 模块而非 namespace [Required]
禁止 `namespace` 关键字，必须用 ES6 import/export；`declare module '...' { interface ... }` 模块增强不受此限。

##### SFS.05 禁 export let [Required]
可变导出产生难调试代码；需要外部可变绑定时改用显式 getter 函数。

##### SFS.06 容器类 [Required]
不要用带静态方法/属性的容器类作命名空间；导出单个常量和函数。

##### SFS.07 导出可见性 [Recommended]
只导出模块外部使用的符号，最小化模块导出 API 表面。

#### 命名

##### NAM.01 标识符大小写 [Required]
class/interface/type/enum/类型参数用 UpperCamelCase；变量/函数/方法/属性/模块别名用 lowerCamelCase；全局常量（含 enum 值）用 CONSTANT_CASE。

##### NAM.02 描述性名称 [Required]
名称必须描述性、清晰；不用不熟悉缩写、不删字母缩写；≤10 行作用域内的变量可用单字母。

##### NAM.03 缩写整词 [Required]
缩写视为整词，如 `loadHttpUrl` 而非 `loadHTTPURL`；`Id` 而非 `ID`。

##### NAM.04 常量 CONSTANT_CASE [Required]
CONSTANT_CASE 表示值意图不变；仅模块级符号/模块级类静态字段/enum 值可用；局部多次实例化值用 lowerCamelCase。

##### NAM.05 名称不含类型信息 [Required]
不在名称中重复类型信息；不用下划线前/后缀、`opt_` 前缀；不特别标记接口。

#### 注释与文档（JSDoc）

##### CMD.01 JSDoc vs // 注释 [Required]
文档化用 `/** JSDoc */`，实现注释用 `//`。

##### CMD.02 多行 // 风格 [Required]
多行普通注释必须用多个 `//` 单行注释，不用 `/* */` 块注释。

##### CMD.03 JSDoc 标签独占行 [Required]
`@param`/`@return` 等标签必须独占一行，不可合并。

##### CMD.04 文档化顶层导出 [Recommended]
模块所有顶层导出应文档化；用途不明显时属性/方法也应文档化（工具消费符号除外）。

##### CMD.05 类注释 [Recommended]
类 JSDoc 提供足够信息说明用法与额外注意事项；构造器文本描述可省略。

##### CMD.06 方法注释 [Recommended]
方法描述以第三人称动词短语开头；仅当名称/类型不清晰时需 @param/@return。

##### CMD.07 参数属性注释 [Recommended]
参数属性用 `@param` 注解文档化。

##### CMD.08 禁冗余 JSDoc 类型 [Required]
JSDoc 类型注解在 TS 中冗余，禁止重复声明（禁 @implements/@enum/@private/@override 等）。

##### CMD.09 注释有信息量 [Recommended]
注释须提供实际信息，避免仅重复参数名和类型。

#### 测试（vitest mock 基座）

##### TOOL.01 禁 @ts-ignore/@ts-expect-error [Required]
禁 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`；测试中可用 `@ts-expect-error` 但通常不应——优先转为目标类型并附注释，将错误抑制限定到单个表达式。

#### 一致性与核心风格

##### POL.01 一致性 [Required]
未解决的风格问题与同文件/同目录现有代码一致；新文件必须用 Google 风格。

##### POL.02 重新格式化 [Recommended]
重大更改时同步格式化该文件；避免机会主义风格修复；新代码不得违反风格指南。

##### CS.01 核心风格 [Required]
2 空格缩进；单引号；显式分号；禁 `console.log`（用 logger 输出）；推荐 Node.js ES 模块；第三方库/多导出模块用命名空间导入；Node.js 内置模块必须默认导入（`import fs from 'fs'`）。

### 3. Security & production notes

- **外部输入校验（zod）**：`yaml-parser.ts` 的 `parseWorkflowYaml` 对不可信 YAML 执行 `WorkflowDefinitionSchema.parse`（失败抛 `DEFINITION_INVALID` 且 `cause` 挂原始 ZodError）。这要求 TS.09——解析边界值以 `unknown` 进入（`document.toJS()`），经 `isRecord` 类型守卫收窄后再落类型；禁止直接 `any`。
- **错误路由依赖 Error 实例**：`SandoreError extends HarnessError`（`errors.ts`），路由仅按稳定 `code`、永不解析 message；`describeError`/`renderError` 依赖 `instanceof Error`。违反 LANG.28/LANG.29（抛非 Error 或防御性处理非 Error）会破坏 fatal 传播与诊断。
- **分发 switch 的穷尽性**：`step-runner.ts` 的 `run()` 以 `switch (command.type)` 分发 shell/prompt，`default` 抛 `STEP_EXECUTION`（`step-runner.ts:117-125`）。新增 agent/skill/mcp 分支必须保持 default 兜底（LANG.31），否则未知命令类型被静默吞掉。
- **接缝边界的类型断言**：`workflow-engine.ts:116`（`executedSteps as unknown as ...`）与 `workflow-engine.ts:311`（`onPersist` 的 `executed as unknown as ...`）及测试注入 `llm as unknown as LlmRuntime`（`step-runner.spec.ts:62`）均属不安全断言。LANG.33 要求此类断言附"为何安全"注释或改用运行时收窄；改造新增接缝时同样须克制。
- **默认导出例外**：`workflow-engine.ts:130` 的 `export default class SandoreEngineRuntime` 违反 SFS.02（禁默认导出）；作为既有事实保留，改造新代码一律命名导出，勿新增 default export。
- **测试抑制手段**：现有测试用 `as unknown as` + 注释而非 `@ts-ignore` 注入 mock（TOOL.01）；新测试应沿用该模式，禁止引入 `@ts-ignore`。
