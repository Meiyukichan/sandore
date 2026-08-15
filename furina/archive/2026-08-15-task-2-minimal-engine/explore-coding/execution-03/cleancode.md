Furina CleanCode Exploration Result
# Explore Content
实现 execution-03（线性工作流执行）：microflow 包 step-runner.ts / stage-executor.ts，workflow 包 dag-navigator.ts / workflow-engine.ts，集成 DSH shell/llm/sessions 与 sandore 存储域，含 Cordis Provider、Zod 派生类型、异步流式消费、事件双发、KvTable 读写、vitest mock。
# Explore Type
cleancode
# Exploration Result

# sandore 执行层（execution-03）TypeScript 编码规范

## 1. Scope

- **需求摘要**：在 `packages/sandore/microflow` 与 `packages/sandore/workflow` 新增 4 个 TS 源文件，实现 Stage 级线性主循环 + Stage 内顺序执行 Step，集成 DSH shell/llm/sessions 与 sandore 存储域（纯插件实现，不改 DSH 源码）。
- **涉及代码特征**：Cordis Service/Provider（static inject / static Config / super / Service.init）、Zod `z.infer` 派生类型、抽象类 `SandoreEngine` 实现类、`for await` 消费 `AsyncIterable<StreamChunk>` + BlockAssembler 聚合 `ContentBlock`、事件双发（`ctx.emit` + `Session.append`）、`KvTable` 读写、JSDoc 文档、vitest 内存 mock。

## 2. Guidelines

### 2.1 异常处理与失败传播（核心正确性）

##### LF.54 实例化异常使用 new Error() [Required][High]

**描述**：实例化异常时始终使用 `new Error()`，而不仅仅是调用 `Error()`。两种形式都创建一个新的 `Error` 实例，但使用 `new` 与其他对象的实例化方式更一致。

**合规示例**：

```
throw new Error('Foo is not a valid bar.');
```

##### LF.55 只抛出 Error 及其子类 [Required][High]

**描述**：JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。相反，只抛出（的子类）`Error`。

**合规示例**：

```
throw new Error('oh noes!');
// ... or subtypes of Error.
class MyError extends Error {}
throw new MyError('my oh noes!');
// For promises
new Promise((resolve) => resolve()); // No reject is OK.
new Promise((resolve, reject) => void reject(new Error('oh noes!')));
Promise.reject(new Error('oh noes!'));
```

##### LF.56 捕获和重新抛出 [Required][High]

**描述**：捕获错误时，代码**应该**假设所有抛出的错误都是 `Error` 的实例。

**合规示例**：

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

##### LF.57 空 catch 块必须解释 [Required][High]

**描述**：很少有情况下在响应捕获的异常时什么都不做是正确。当确实适合在 catch 块中完全不采取行动时，应在注释中解释这是正当的理由。

**合规示例**：

```
  try {
    return handleNumericResponse(response);
  } catch (e: unknown) {
    // Response is not numeric. Continue to handle as text.
  }
  return handleTextResponse(response);
```

##### LF.60 类型断言与非空断言不安全 [Required][High]

**描述**：类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。

**合规示例**：

```
// assuming Foo is a class.
if (x instanceof Foo) {
  x.foo();
}

if (y) {
  y.bar();
}
```

### 2.2 类与 Provider（Cordis Service）

- **LF.12 类声明禁止分号结尾 [Required]**：`class Foo {}` 结尾不加分号；类表达式语句结尾才加分号。
- **LF.13 类方法声明禁止分号 [Required]**：方法间不加分号；方法之间用单个空行分隔。
- **LF.20 禁止 #private 字段 [Required]**：用 TypeScript 可见性注解（`private`/`protected`/`public`）。
- **LF.21 使用 readonly [Required]**：构造函数外不再赋值的属性加 `readonly`。
- **LF.22 参数属性 [Required]**：用 `constructor(private readonly x: T) {}`，不要显式初始化器重复赋值。
- **LF.23 字段初始化器 [Required]**：非参数成员在声明处初始化（`private readonly userList: string[] = []`）。
- **LF.25 getter/setter [Required]**：getter 必须是纯函数（结果一致且无副作用）；至少一个访问器必须非平凡。
- **LF.27 可见性 [Required]**：尽可能限制可见性；默认 public，不加 `public` 修饰符（除非声明非只读 public 参数属性）。
- **LF.15 避免私有静态方法 [Required]**：优先用模块本地函数替代私有静态方法。
- **LF.18 构造函数必须用括号 [Required]**：`new Foo()`，即使无参。
- **LF.19 不必要的构造函数 [Required]**：空构造或仅 `super(...)` 委托可省略；有参数属性/装饰器时保留。
- **CORE.08 文件行数 [Recommended]**：普通业务文件 300–500 行；大型模块（如 workflow-engine.ts）≤800 行，超出需有充分理由。

### 2.3 类型系统与 Schema（z.infer）

- **TS.01 类型推断 [Recommended]**：简单类型（string/number/boolean）可省略注解；复杂表达式加注解。
- **TS.02 返回类型 [Recommended]**：项目可要求始终写返回类型（本仓库既有代码普遍标注）。
- **TS.04 可空别名禁止 [Required]**：类型别名不含 `|null`/`|undefined`，在实际使用处添加；应就近处理空值。
- **TS.05 优先可选参数 [Required]**：用 `?` 而非 `|undefined`。
- **TS.06 结构化类型 [Required]**：在声明处显式指定类型以获得更好错误报告。
- **TS.07 接口优于类型别名 [Required]**：声明对象类型用 `interface` 而非 `type = { ... }`。
- **TS.08 Array<T> 类型 [Required]**：简单类型用 `T[]`/`readonly T[]`，复杂类型用 `Array<T>`（如 `Array<{n: number, s: string}>`、`Array<string|number>`）。
- **TS.09 索引签名 [Recommended]**：关联数组用 `{[key: string]: T}` 并提供有意义键名；考虑用 `Map`/`Set` 替代。
- **TS.10 映射/条件类型 [Recommended]**：始终用最简单的类型构造；重复/冗长优于复杂类型表达式。
- **TS.11 any 类型 [Required]**：避免使用 `any`，优先更具体类型、`unknown`，或抑制 lint 并注释原因。
- **TS.12 用 unknown 而非 any [Recommended]**：只需表达"类型未知"时用 `unknown`，用类型守卫缩小后再用。
- **TS.14 空类型 {} [Required]**：不用 `{}`，用 `unknown` / `Record<string, T>` / `object`。

### 2.4 函数与异步流式消费

- **LF.29 命名函数优先声明 [Required]**：命名函数用 `function foo() {}`，而非 `const foo = () => 42`。
- **LF.31 禁止函数表达式 [Required]**：用箭头函数替代 `function() {}`。
- **LF.32 箭头函数体 [Required]**：仅当返回值被使用时才用简洁体；返回值不用时用块体。
- **LF.34 优先箭头回调 [Required]**：显式转发参数（`(n) => parseInt(n)`），避免直接传命名回调导致意外参数。
- **LF.30 嵌套函数 [Recommended]**：方法体内优先箭头函数（可访问外部 `this`）。
- **LF.33/40 this 限制 [Required]**：仅在类构造/方法、显式 this 类型函数、箭头函数中使用 `this`；禁止函数表达式/声明中隐式重绑定 `this`。
- **LF.37 默认参数 [Required]**：初始化器禁止可观察副作用，保持简单；多可选参数优先解构。
- **LF.39 函数格式 [Required]**：函数体首尾禁空行；生成器 `function*` / `yield*`；`...` 后不加空格。

### 2.5 控制结构与相等性

- **LF.50 控制流大括号 [Required]**：`if`/`for`/`while` 等总用大括号；单行 `if (x) x.doFoo();` 可省略。
- **LF.52 遍历容器 [Required]**：优先 `for (... of someArr)`；异步流用 `for await (const chunk of stream)`；`for-in` 仅用于字典对象并加 `hasOwnProperty` 过滤。
- **LF.58 switch 必须有 default [Required]**：`default` 组放最后；非空 case 组禁止 fall-through（用 `break`/`return`/抛异常）。
- **LF.59 严格相等 [Required]**：始终 `===`/`!==`；与字面量 `null` 比较可用 `==`/`!=` 同时覆盖 null/undefined。
- **LF.53 分组括号 [Recommended]**：仅当无误解风险时省略可选括号。

### 2.6 命名规范

- **NAM.01 标识符 ASCII [Required]**：只用 ASCII 字母/数字/下划线/美元符。
- **NAM.02 命名风格 [Required]**：名称不装饰类型信息；禁 `_` 前后缀、`opt_` 前缀；不特别标记接口。
- **NAM.03 描述性名称 [Required]**：禁模糊缩写；10 行以内局部变量可用单字母。
- **NAM.04 camel case [Required]**：缩写整词处理（`loadHttpUrl`）。
- **NAM.06 大小写表 [Required]**：类/接口/类型/枚举/装饰器/类型参数 UpperCamelCase；变量/参数/函数/方法/属性/模块别名 lowerCamelCase；全局常量与枚举值 CONSTANT_CASE。
- **NAM.11 常量 [Required]**：`CONSTANT_CASE` 表示意图不变；`static readonly` 属性也是常量；仅模块级符号可用 CONSTANT_CASE。
- **NAM.08 测试名 [Recommended]**：xUnit 风格可用 `testX_whenY_doesZ()`。
- **NAM.12 别名 [Required]**：局部别名用 `const`/`readonly` 且大小写与源一致。

### 2.7 模块、导入导出与源文件

- **SFS.08 命名导出 [Required]**：全用命名导出，禁止默认导出。
- **SFS.09 导出可见性 [Required]**：只导出模块外使用的符号，最小化导出 API。
- **SFS.10 可变导出 [Required]**：禁止 `export let`；可变绑定用显式 getter。
- **SFS.12 import type / export type [Required]**：仅作类型的导入用 `import type`，类型再导出用 `export type`。
- **SFS.13 禁 namespace/require [Required]**：必须 ES6 `import`/`export`；禁止 `<reference>`、`import x = require()`。
- **SFS.05 导入路径 [Required]**：同项目用相对导入，限制 `../../../`；本仓库约定 `.ts` 后缀显式导入（`from './schema.ts'`），与既有文件一致。
- **SFS.06 具名 vs 命名空间导入 [Required]**：频繁/名称清晰符号用具名导入；大型 API 多用命名空间导入。
- **CORE.02 导入 [Recommended]**：第三方库或多导出模块用命名空间导入；Node 内置模块必须默认导入。
- **SFS.01 文件顺序 [Required]**：版权（若有）→ @fileoverview JSDoc → 导入 → 实现，各部分间恰好一个空行。

### 2.8 注释与文档（JSDoc）

- **CD.01 JSDoc vs 注释 [Required]**：文档化用 `/** JSDoc */`，实现注释用 `//`。
- **CD.02 多行注释 [Required]**：多行实现注释用多个 `//`，不用 `/* */`，不用星号画框。
- **CD.03 JSDoc 形式 [Required]**：格式良好；单行溢出即用多行 `/**`、`*/` 单独成行。
- **CD.04 Markdown [Required]**：JSDoc 用 Markdown，列表用 Markdown 列表语法。
- **CD.07 文档化顶层导出 [Required]**：模块所有顶层导出必须文档化；类注释说明如何用及额外考虑；方法描述以第三人称动词短语开头。
- **CD.08 类注释 / CD.09 方法注释 [Required]**：类注释含使用信息；方法名/类型自明时可省略描述。
- **CD.10 参数属性注释 [Required]**：参数属性用 `@param` 文档化。
- **CD.11 JSDoc 类型禁 [Required]**：JSDoc 中不重复 TS 类型（`@param`/`@return` 不写类型）。
- **CD.12 实际信息 [Required]**：注释提供实际信息，不重复名称/类型；`@param`/`@return` 仅在添加信息时写。
- **CD.13 调用参数名注释 [Recommended]**：参数含义不清晰时 `/* name= */ value`。
- **CORE.07 文件头 [Required]**：文件头部声明用 JSDoc；本仓库惯例顶部块注释 + `@module <完整包路径>`。

### 2.9 工具链、一致性与其他

- **TC.01/TC.02 [Required]**：必须通过类型检查；禁止 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`。
- **POL.01 一致性 [Required]**：规范未明者与同文件/同目录一致；**新文件必须用 Google 风格**（含显式分号 LF.67、单引号 LF.41、2 空格缩进 CORE.06），既有文件无分号属历史遗留，新文件按 Google 风格补分号。
- **CORE.05 禁 console.log [Required]**：日志走 logger，不用 console.log。
- **LF.65 装饰器 [Required]**：不定义新装饰器，只用框架提供（Cordis 的 `Service.init` 等）；JSDoc 放装饰器之前。
- **LF.41/LF.43 字符串 [Required]**：单引号；复杂拼接用模板字面量。
- **LF.45 类型强制转换 [Required]**：用 `String()`/`Boolean()`/`!!`；枚举值禁转布尔，用比较。
- **LF.47 Number() 解析 [Required]**：用 `Number()` 解析数值并显式检查 `NaN`。
- **LF.64 try 精简 [Required]**：限制 try 块内代码量，非抛出行移出。

## 3. Security & production notes

- **LF.54/LF.55/LF.56**：执行层所有失败路径（`finish.reason.kind === 'error'`、shell 非零 `exitCode`、超时/中止）必须抛 `SandoreError`（继承 `HarnessError` 的子类），catch 中用 `assertIsError` 或 `isFatalSandoreError` 收窄，严禁 throw 字符串/plain object，否则 `ctx.emit('sandore/*')` 与 `session.append` 收到无堆栈的失败且组合子无法路由。
- **LF.57**：吞掉 catch 而不记录/传播会破坏"终端失败"语义；确需空 catch 时必须注释理由（如"恢复性错误已降级为 null"）。
- **LF.60/TS.11/TS.12**：与 DSH 宿主 API 边界（`StreamChunk`、`ContentBlock`、`ShellRunResult`）交互时禁止 `as any`/`y!` 静音编译器——用 `z.infer` 派生类型 + 运行时守卫（`instanceof`/`in`/`!== undefined`）收窄，避免 BlockAssembler 聚合时对不存在字段崩溃。
- **CORE.05**：工作流引擎日志必须走 logger（Cordis ctx 提供的日志），不落 `console.log`，避免污染 CLI 输出与测试断言。
- **TC.02/TS.11**：DSH 公开 API 类型不完整时，用带注释的窄范围断言或 `unknown` + 守卫，而非 `@ts-ignore` 全量抑制。
- **POL.01**：四个新文件与既有 `schema.ts`/`types.ts`/`errors.ts`/`persistence.ts` 同目录，保持 `.ts` 后缀导入、`@module` JSDoc、命名导出、`declare module '@deepseek-ai/cordis'` 增强 Context 等既有约定；仅分号按"新文件必须 Google 风格"补齐。

# 备注（非规范正文）
- 分号冲突：`typescript-core-style.md`（CORE.04）与 LF.67 要求显式分号，但既有文件（types.ts/errors.ts/persistence.ts/schema.ts）全部无分号。依据 POL.01「新文件必须使用 Google 风格」，4 个新文件建议补分号；若团队决定与既有文件保持一致，须在代码评审中明确统一口径。
- `@module` 标签与本仓库 JSDoc 头为仓库既有惯例（非 Google 规范原文），作为一致性要求并入 CD.07/CORE.07。
