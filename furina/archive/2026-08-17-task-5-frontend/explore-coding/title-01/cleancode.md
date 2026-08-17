### 1. Scope

- **需求概述**：为 sandore 工作流引擎补设宿主会话标题——新增 `@deepseek-ai/dsh-session-title` 依赖，在 `startInstance` 创建并读回宿主 Session 后经 `ctx.sessionTitle.rename(session, title)` 补设标题，并处理 `SessionTitleInvalidError` 输入校验失败与「session 非 live」错误。
- **涉及的代码特性**：新增依赖与包导入（具名导入 / `import type` / `declare module` 模块增强）、Cordis 上下文与 `static inject` 声明、引擎方法实现（rename 调用 + 异常处理/外部输入校验）、类型声明（接口/可选字段）、测试桩与断言、JSDoc 文档注释。

### 2. Guidelines

#### 依赖声明与模块导入

##### 具名导入 vs 命名空间导入 [建议]
仅导入 `SessionTitleService`、`SessionTitleInvalidError` 等少量名称清晰的符号时，使用具名导入；当使用大型 API 的众多不同符号时才用命名空间导入。

##### import type [建议]
仅作类型使用的导入（如 `SessionTitleService`）用 `import type`；作值使用的导入（如用于 `instanceof` 判定的 `SessionTitleInvalidError`）用常规导入。

##### 使用模块而非命名空间 [必须]
禁止使用 `namespace Foo { ... }` 结构，必须用 ES6 `import`/`export` 组织代码；对第三方（含 Cordis 上下文）的类型补充使用 `declare module '...'` 模块增强而非 namespace。

##### 命名导出、禁止默认导出 [必须]
所有代码使用命名导出，禁止默认导出，确保导入遵循统一模式。

##### 导出可见性最小化 [应该]
只导出在模块外部使用的符号，最小化模块导出 API 表面。

#### Cordis 上下文与 static inject 声明

##### 类声明/方法声明禁止分号 [必须]
类声明与类方法声明禁止以分号结尾；`static inject = [...]` 为静态字段初始化，无分号问题。

##### readonly 修饰符 [应该]
用 `readonly` 标记构造后从不重新赋值的属性；`static inject` 数组为 Cordis 约定的可变依赖名列表，遵循现有代码风格即可。

##### 描述性名称 / lowerCamelCase [必须/应该]
方法/属性名用 `lowerCamelCase`（如 `renameSessionTitle`），类/接口用 `UpperCamelCase`，名称必须描述性、不使用模糊缩写；类型信息不应出现在名称中。

#### 宿主会话标题补设方法（rename 调用与错误处理）

##### 用 new 实例化异常 [必须]
实例化异常时始终使用 `new Error()`，而不仅仅是调用 `Error()`。两种形式都创建一个新的 `Error` 实例，但使用 `new` 与其他对象的实例化方式更一致。

```
throw new Error('Foo is not a valid bar.');
```

##### 只抛出 Error 子类 [必须]
JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。

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

##### 捕获与重抛：假设抛出值是 Error 实例 [应该]
捕获错误时，代码**应该**假设所有抛出的错误都是 `Error` 的实例。

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

除非被调用的 API 确定知道会抛出非 `Error` 来违反上述规则，否则异常处理程序**禁止**防御性地处理非 `Error` 类型。在这种情况下，应包含注释以特别识别非 `Error` 的来源。

> 应用到本需求：用 `e instanceof SessionTitleInvalidError` 收窄翻译为 `SandoreError(..., 'title-invalid')`，其余（session 非 live / 服务已 dispose）保持原 `Error` 语义向上抛出。

##### 空 catch 块需解释 [应该]
很少有情况下在响应捕获的异常时什么都不做是正确。当确实适合在 catch 块中完全不采取行动时，应在注释中解释这是正当的理由。

##### 保持 try 块精简 [应该]
在不损害可读性的情况下，限制 try 块内的代码量；仅将 `rename` 这类可能抛出的调用留在 try 内，非抛出行移出。

##### 严格相等 === [必须]
始终使用 `===` 和 `!==`；与字面量 `null` 比较时可使用 `==`/`!=` 以同时覆盖 `null`/`undefined`。

##### 控制流语句用大括号 [必须]
`if`/`for`/`while` 等控制流语句始终使用大括号包裹，即使体只含单条语句；能放一行的 `if` 语句可省略大括号。

##### 类型断言用 as / 双重断言经 unknown [必须]
类型断言必须使用 `as` 语法（而非尖括号语法）；必要时的双重断言经 `unknown` 作为中间类型（`x as unknown as Foo`），不要用 `any` 或 `{}`。

#### 类型声明

##### 对象类型优先用接口 [建议]
声明对象类型时使用接口（`interface`）而非对象字面量类型别名；`SessionTitleSource`/`SessionTitleSnapshot` 等来自 dsh-session-title 的类型直接用其导出，无需本地复刻。

##### 可选字段/参数优先于 |undefined [应该]
使用可选字段（`title?`）和可选参数而非 `|undefined` 联合类型；避免在类型别名中包含 `|null`/`|undefined`。

##### 避免 any，用 unknown/更具体类型 [应该]
`any` 危险且破坏静态类型价值；优先提供更具体类型或使用 `unknown`。

##### 返回类型注解 [作者决定]
复杂返回类型应注解以提高可读性；审查者可要求对难以理解的返回类型加注解。

##### 结构类型显式注解 [应该]
TypeScript 为结构化类型系统；在符号声明处显式包含类型以获得更精确的类型检查和错误报告。

#### 测试桩与断言

##### 测试 mock 的 any 抑制需注释 [应该]
在测试中构造 mock 对象使用 `any`/`as unknown as` 时，添加注释说明「intentionally unsafe partial mock」，将错误抑制限制在单个表达式上。

##### 描述性名称（测试） [必须]
测试方法名可用 `_` 分隔结构（如 `it('renames host session title ...')`）；变量命名仍遵循 lowerCamelCase，禁止 `_` 前缀/后缀。

#### 文档注释

##### JSDoc vs 普通注释 [应该]
用 `/** JSDoc */` 做文档化注释，用 `//` 行注释做实现注释。

##### 多行注释用 // 风格 [必须]
多行注释必须使用多个单行 `//` 注释，禁止 `/* */` 块注释风格；不用星号或字符绘制包围盒。

##### 文档化所有顶层导出 [应该]
模块所有顶层导出（类、公开方法、常量）用 JSDoc 文档化；类注释应提供足够信息说明如何使用。

##### 方法描述第三人称动词短语 [应该]
方法 JSDoc 描述以描述方法作用的动词短语开头（第三人称），例如「补设宿主会话的标题」。

##### JSDoc 类型注解冗余，禁止 [必须]
JSDoc 中不得重复声明类型（`@param`/`@return` 不写类型），也不得写 `@implements`/`@private`/`@override` 等冗余标签。

##### 注释提供实际信息 [应该]
`@param`/`@return` 仅在添加信息时保留，避免只重复参数名和类型。

#### 核心风格

##### 单引号 / 显式分号 / 2 空格缩进 / 禁 console.log [必须]
字符串用单引号；所有语句显式以分号结尾；TypeScript 缩进 2 空格；禁止 `console.log`，经 `this.ctx.logger` 输出日志。Node.js 内置模块用默认导入，第三方多导出模块可用命名空间导入，ES 模块优先。

### 3. Security & production notes

- **标题注入安全**：`SessionTitleService.rename` 在接收标题前执行 `normalizeSessionTitle`（剥离 ANSI OSC/CSI/ESC 控制序列、方向控制字符，折叠空白并做 UTF-8 截断）——引擎必须把用户原始标题原样传给 `rename`，不得自行预归一化或绕过服务，以规避终端转义注入。翻译失败的机制见第 2 节「只抛出 Error 子类」「捕获与重抛」（`SessionTitleInvalidError` → `SandoreError 'title-invalid'`）。
- **会话活性校验**：`rename` 内部校验 `ctx.sessions.get(session.id) !== session` 即抛错——必须传入经 `ctx.sessions.get(SessionId(instanceId))` 读回的 **live 宿主 Session**，不得传入 detach/自建副本。
- **自动标题语义**：`rename` 的 `user` source 会 `supersede` 中断 in-flight 自动生成并钉住标题，后续用户消息不再调度 fallback——补设应在宿主 Session 发布后（`ctx.sessions.get` 成功）立即执行，确保在 fallback 自动标题被调度前完成 pin。
