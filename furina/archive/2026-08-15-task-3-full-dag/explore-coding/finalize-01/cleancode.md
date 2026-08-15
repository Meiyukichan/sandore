# Furina CleanCode Exploration Result

## Explore Content

为工作流引擎实现 finalize-manager（收尾管理器），包括 FinalizeAssessor（fork 会话做完成判定/提问）与 GateEvaluator（门禁评估）两个临时会话流程，以及 finalize-manager.spec 单元测试。

## Explore Type

cleancode

## Exploration Result

### 1. Scope

- **Requirement summary**: 实现 finalize-manager 的 `FinalizeAssessor`（fork 临时会话做完成判定/提问）与 `GateEvaluator`（门禁评估），并编写 `finalize-manager.spec.ts` 单元测试。
- **Code features affected**: 类定义与 readonly 字段、Cordis `ctx` 依赖注入（`sessions.fork`/`llm.stream`）、临时会话聚合（`BlockAssembler`/`createUserMessage`）、Zod v4 派生类型、外部 LLM JSON 输出解析（`unknown` 收窄）、异常处理（`SandoreError(code)`）、vitest mock/harness、中文 JSDoc、`.ts` 后缀导入。

### 2. Guidelines

#### 异常处理与结构化错误

##### 只抛出 Error（及其子类）[Required]

只抛出（的子类）`Error`，不抛裸字符串或任意值（否则无堆栈跟踪）。

##### 使用 new 实例化 Error [Required]

实例化异常时始终使用 `new Error()`，而不仅仅是调用 `Error()`。

##### 类型断言与非空断言优先运行时检查 [Recommended]

类型断言（`x as SomeType`）和非空断言（`y!`）不安全，只让编译器静音。应编写显式运行时检查（`instanceof`、truthiness 判断）代替断言。

##### unknown 优于 any / 避免 any [Required]

`any` 掩盖编程错误、破坏静态类型价值。表示"类型未知"用 `unknown`（不允许任意属性解引用），用类型守卫收窄后再安全使用。

#### 类与字段

##### 类声明与方法声明 [Required]（摘要）

类声明禁止以分号结尾；类方法声明禁止用分号分隔；方法间用单个空行分隔。构造器调用必须带括号（`new Foo()`）。类内用 TypeScript 可见性注解替代 `#private` 字段。

##### 使用 readonly [Recommended]（摘要）

用 `readonly` 修饰符标记在构造函数外部从不重新赋值的属性。

##### 参数属性 [Recommended]（摘要）

通过 `constructor(private readonly x: X)` 参数属性声明并初始化类成员，而非在构造器中显式 `this.x = x`；需要文档化时用 `@param` JSDoc。

##### 字段初始化器 [Recommended]（摘要）

非参数类成员在声明处初始化（`private readonly userList: string[] = [];`），可完全省略空构造器。

##### 可见性 [Recommended]（摘要）

尽可能限制符号可见性；TypeScript 符号默认 public，除非声明非只读 public 参数属性，否则不要写 `public` 修饰符。

##### 禁静态 this / 静态上下文 [Required]（摘要）

代码禁止在静态上下文中使用 `this`；优先用模块本地函数替代私有静态方法。

#### 函数与异步

##### 命名函数用函数声明 / 禁止函数表达式 [Recommended]（摘要）

定义命名函数优先用函数声明（`function foo()`）而非箭头函数或函数表达式；方法体内嵌套函数优先用箭头函数（可访问外层 `this`）。

##### 箭头函数体 [Recommended]（摘要）

返回值实际被使用时用简洁体，否则用块体（块体保证返回 `void` 防止副作用泄漏）；可用 `void` 运算符确保表达式体返回 `undefined`。

##### 回调与 this [Recommended]（摘要）

优先传递箭头函数作为回调（显式转发参数，避免 `map(parseInt)` 类隐式参数错误）；禁止在函数中重绑定 `this`，优先箭头函数而非 `f.bind(this)`。

##### 参数初始化器 [Recommended]（摘要）

可选参数默认值禁止有任何可观察副作用，应保持简单。

#### 类型系统

##### 类型推断与返回类型 [Recommended]（摘要）

简单类型（`string`/`number`/`boolean`/`RegExp` 字面量/`new` 表达式）省略类型注解；复杂表达式加注解提高可读性。返回类型注解由作者决定，审查者可要求澄清复杂返回类型。

##### 可选优于 |undefined / 禁止可空别名 [Recommended]（摘要）

类型别名禁止在联合中包含 `|null`/`|undefined`，应仅在实际使用别名处添加；用可选字段/参数（`?`）而非 `|undefined`。

##### 结构类型 / 接口优于 type 字面量别名 [Recommended]（摘要）

声明对象类型时用接口而非对象字面量 type 别名；在符号声明处显式指定类型以获得精确错误报告。

##### Array 语法糖 [Recommended]（摘要）

简单类型用 `T[]`/`readonly T[]`（含嵌套简单类型），复杂类型用 `Array<T>`/`ReadonlyArray<T>`。

##### 索引签名 / {} 类型 [Recommended]（摘要）

对象作关联数组用索引签名（键用有意义标签如 `[userName: string]`）；优先用 `unknown`、`Record<string, T>`、`object` 而非空接口 `{}`。

##### 包装器类型 [Required]（摘要）

禁止使用 `String`/`Boolean`/`Number` 包装器类型，始终用小写原始类型；禁止 `new` 调用包装器构造。

#### 命名

##### 大小写规则 [Required]（摘要）

类/接口/类型/枚举/类型参数用 `UpperCamelCase`；变量/函数/方法/属性用 `lowerCamelCase`；全局常量与枚举值用 `CONSTANT_CASE`。缩写视为整词（`loadHttpUrl` 而非 `loadHTTPURL`）。

##### 描述性名称 [Required]（摘要）

名称必须描述性、不用模糊缩写；类型信息不应出现在名称中（禁匈牙利前缀）；禁止 `_` 前缀/后缀标识符；单字母变量仅限 10 行内局部作用域。

##### 测试命名 [Recommended]（摘要）

测试方法名可用 `_` 分隔结构（`testX_whenY_doesZ`）。

#### 导入与导出

##### 命名导出 / 禁止默认导出 [Required]（摘要）

所有代码用命名导出（`export class Foo`/`export function`/`export const`）；禁止默认导出以确保导入模式统一。（注：`workflow/src/index.ts` 与 `workflow-engine.ts` 是既有特例，沿用现状即可。）

##### import type / export type [Recommended]（摘要）

仅作类型使用的导入用 `import type {...}`；重导出类型用 `export type {...}`。

##### 相对导入 / 禁 namespace 与 require [Required]（摘要）

引用同一项目文件优先相对导入（`./foo`），限制过深 `../../../`；禁止 `namespace` 关键字与 `import x = require(...)`，必须用 ES6 模块语法。

##### 导出可见性 / 容器类 [Recommended]（摘要）

只导出模块外使用的符号；不要创建带静态成员的容器类作命名空间，导出单个常量和函数。

#### 注释与文档

##### JSDoc 与普通注释 [Required]（摘要）

文档化注释用 `/** JSDoc */`，实现注释用 `//`；多行注释必须用 `//` 风格而非 `/* */` 块注释。

##### JSDoc 格式与标签 [Required]（摘要）

JSDoc 用 Markdown 编写（列表用 `- ` 语法）；标签（如 `@param`）必须独占一行；包裹描述缩进四个空格；`@param`/`@return` 仅在增加信息时才需要。

##### 顶层导出文档化 / 方法注释 [Recommended]（摘要）

模块所有顶层导出必须文档化；类注释说明如何使用；方法描述以第三人称动词短语开头；参数属性用 `@param` 文档化；禁止在 `@param`/`@return` 中重复 TypeScript 类型注解。

#### 工具链与测试

##### 禁 @ts-ignore / @ts-expect-error / @ts-nocheck [Required]（摘要）

不要使用这些指令；单元测试中可用 `@ts-expect-error` 但通常不应该，应改用带注释的类型转换或将错误抑制限制在单个表达式。

#### 核心风格

##### 引号 / 分号 / 缩进 / 日志 [Required]（摘要）

使用单引号（`'`）；显式使用分号（不依赖 ASI）；2 空格缩进；禁止 `console.log`，通过 logger 输出日志；推荐 Node.js ES 模块。

##### 文件行数 [Recommended]（摘要）

组件/类文件 200-300 行（保持职责单一、易测试）；普通业务文件 300-500 行；工具/配置文件 100-200 行；大型模块不超过 800 行。

### 3. Security & production notes

- **解析 LLM JSON 输出必须运行时收窄（关联「类型断言优先运行时检查」+「unknown 优于 any」）**：`FinalizeAssessor`/`GateEvaluator` 从临时会话流聚合的原始文本中解析 `completionType`/`gatesPassed` 等字段，应沿用 `branch-evaluator.ts` 的 `parseJsonObject` 范式——`JSON.parse` 返回 `unknown`，逐字段 `typeof` 收窄后再读取，禁止 `as` 强转断言。异常形状回退到 `raw.trim()` 后仍以 `FinalizeAssessResultSchema`/`GateEvalResultSchema`（Zod）二次校验。
- **错误码必须用已声明的 `SandoreErrorCode`（关联「只抛 Error 子类」+「new 实例化」）**：`errors.ts` 已声明 `FINALIZE_FAILED`/`GATE_FAILED`/`SESSION_LOST`（fatal）。收尾失败、门禁未通过、fork 会话丢失应分别 `throw new SandoreError(msg, 'FINALIZE_FAILED')` 等，禁止抛出裸字符串或 `Error(msg)`，路由逻辑只按 `code` 判断。
- **fork 会话事件读取（关联「unknown 优于 any」+「空 catch 注释」）**：`ctx.sessions.fork(source, boundary?, childSessionId?)` 返回的 `Session.events` 为外部运行时注入，事件 `data` 需按 `subagents.ts` 的 `SessionEvent` 判别联合（`type` 字段收窄）访问，聚合时沿用「最后非空 assistant/message → 累计 text-delta」规则。
- **一致性（关联策略「一致性」）**：新文件沿用 `branch-evaluator.ts` 的既有范式——`.ts` 后缀相对导入（`./errors.ts`）、中文 JSDoc（含 `@module`）、类顶部 `constructor(private readonly ctx: Context, ...)`、`/** ... */` 顶层导出文档化、`export class` 命名导出；测试沿用 `harness()` + `ctx.provide(...)` 注入 mock，用 `rejects.toMatchObject({ code: 'FINALIZE_FAILED' })` 断言错误码。
