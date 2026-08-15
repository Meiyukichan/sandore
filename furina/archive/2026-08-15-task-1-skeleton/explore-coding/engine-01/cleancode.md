# Sandore 工作流引擎 DSH 插件骨架 — TypeScript (clean-ts) 编码规范

### 1. Scope

- **Requirement summary**: 为 sandore 工作流引擎 DSH 插件骨架（新建 `packages/sandore/` 四个包 workflow/microflow/tool/ui 与根 monorepo 配置）梳理 TypeScript（clean-ts）编码规范，供后续 TDD 编码实现遵循。
- **Code features affected**: 抽象类（`extends Service`、abstract 方法、`super(ctx, ...)`、`static Config`/`static inject`）、`declare module` 接口合并（`Context`/`Events`/`SessionEventMap`）、装饰器（`@Remote`）、13 个接口/类型声明（`import type`）、`import type`/`export type`/命名导出、错误抛出（`new Error`/`TypeError`）、schemastery Config（readonly 字段）、monorepo `package.json`/`tsconfig`。

### 2. Guidelines

#### 类型安全（Type safety & assertions）

##### TC-01 禁止 @ts-ignore/@ts-expect-error/@ts-nocheck [Required]

**[Description]**
不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。它们表面上似乎是"修复"编译器错误的简单方法，但实际上，特定的编译器错误通常是由更大的问题引起的，可以更直接地修复。例如，如果你使用 `@ts-ignore` 抑制类型错误，很难预测周围代码最终会看到什么类型。对于许多类型错误，如何最好地使用 `any` 的建议很有用。在单元测试中可以使用 `@ts-expect-error`，但通常**不应该**。`@ts-expect-error` 抑制所有错误。很容易意外地过度匹配并抑制更严重的错误。考虑以下之一：当测试需要处理运行时未检查值的 API 时，添加强制转换为预期类型或 `any`，并添加说明性注释。这将错误抑制限制在单个表达式上。抑制 lint 警告并记录原因，类似于抑制 `any` lint 警告。

##### LF-AS-01 类型断言必须使用 as 语法 [Required]

**[Description]**
类型断言**必须**使用 `as` 语法（而不是尖括号语法）。这会在访问成员时强制在断言周围添加括号。

**[Compliant]**

```ts
// z must be Foo because ...
const x = (z as Foo).length;
```

##### LF-AS-02 避免类型/非空断言 [Recommended]

**[Description]**
类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。有时由于代码的某些局部属性，你可以确定断言形式是安全的。在那些情况下，你应该添加说明来解释为什么你可以接受不安全的行为。

##### LF-AS-03 类型断言与对象字面量使用类型注解 [Required]

**[Description]**
使用类型注解（`: Foo`）而不是类型断言（`as Foo`）来指定对象字面量的类型。这允许在接口字段随时间变化时检测重构错误。

#### 错误处理（Exception handling）

##### LF-EX-01 只抛出 Error 对象 [Required]

**[Description]**
JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。相反，只抛出（的子类）`Error`：

**[Compliant]**

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

##### LF-EX-03 捕获错误应假设 Error 实例 [Recommended]

**[Description]**
捕获错误时，代码**应该**假设所有抛出的错误都是 `Error` 的实例。除非被调用的 API 确定知道会抛出非 `Error` 来违反上述规则，否则异常处理程序**禁止**防御性地处理非 `Error` 类型。在这种情况下，应包含注释以特别识别非 `Error` 的来源。

#### 类型系统（Type system）

##### TS-ANY-01 any 类型 [Recommended]

**[Description]**
TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型；使用 `unknown`；抑制 lint 警告并记录原因。

##### TS-NULL-01 可空类型别名与可选字段 [Required]

**[Description]**
类型别名**禁止**在联合类型中包含 `|null` 或 `|undefined`。可空别名通常表示空值正在通过太多应用程序层传递，这模糊了导致 `null` 的原始问题的来源。它们还使类或接口上的特定值何时可能缺失变得不清楚。相反，代码**必须**只在实际使用别名时添加 `|null` 或 `|undefined`。代码**应该**在值出现的附近处理空值。此外，TypeScript 支持使用 `?` 的可选参数和字段的特殊构造，可选参数在其类型中隐式包含 `|undefined`，使用可选字段（在接口或类上）和参数而不是 `|undefined` 类型。

**[Compliant]**

```ts
interface CoffeeOrder {
  sugarCubes: number;
  milk?: Whole|LowFat|HalfHalf;
}

function pourCoffee(volume?: Milliliter) { ... }
```

#### 模块与导入导出（Modules & exports）

##### SFS-EXP-01 命名导出，禁止默认导出 [Required]

**[Description]**
所有代码中使用命名导出；不要使用默认导出，这确保所有导入遵循统一的模式。默认导出没有规范名称，使得集中维护变得困难，且容易引入难以调试的意外（`import Foo from './bar'` 与 `import Bar from './bar'` 均合法）。

（上下文冲突，见 Section 3）

##### SFS-EXP-02 导出可见性 [Recommended]

**[Description]**
只导出在模块外部使用的符号，最小化模块的导出 API 表面。

##### SFS-EXP-03 禁止 export let [Required]

**[Description]**
可变导出产生难以理解和调试的代码，禁止 `export let`；需要外部可变绑定时改用显式 getter 函数。

##### SFS-TYPE-01 import type / export type [Recommended]

**[Description]**
仅将导入符号用作类型时使用 `import type {...}`；重导出类型时使用 `export type`。值使用常规导入。

##### SFS-MOD-01 使用模块而非命名空间 [Required]

**[Description]**
代码**禁止**使用 `namespace Foo { ... }` 结构和 `/// <reference>`、`require()`。必须使用 ES6 `import`/`export`。`declare module '@deepseek-ai/cordis'` 属于合法的模块增强（合并第三方接口），不是被禁止的 namespace。

##### SFS-IMP-01 相对导入路径 [Recommended]

**[Description]**
引用同一（逻辑）项目内文件时**应该**使用相对导入（`./foo`）而非绝对导入；考虑限制 `../../../` 父目录层级。

#### 类（Classes）

##### LF-CLS-01 类/方法声明禁止分号，方法间空行分隔 [Required]

**[Description]**
类声明禁止以分号结尾；类方法声明禁止分号分隔；方法声明应该用单个空行与周围代码分隔。

##### LF-CLS-02 构造函数必须使用括号 [Required]

**[Description]**
构造函数调用**必须**使用括号（`new Foo()`），即使无参数。

##### LF-CLS-03 使用 readonly 修饰符 [Recommended]

**[Description]**
用 `readonly` 标记在构造函数外部从不重新赋值的属性（不必深度不可变）。

##### LF-CLS-04 禁止 #private 字段，用 TS 可见性注解 [Required]

**[Description]**
不要使用私有字段 `#ident`，使用 TypeScript 可见性注解（`private`/`protected`/`public`）。

##### LF-CLS-05 禁止静态上下文使用 this [Required]

**[Description]**
代码**禁止**在静态上下文中使用 `this`；静态方法只应在其定义的基类本身上调用，不应依赖静态方法的动态分派。

##### LF-CLS-06 可见性限制，非必要不加 public [Recommended]

**[Description]**
尽可能限制符号可见性；TypeScript 符号默认 public，除非声明非只读 public 参数属性，否则不要使用 `public` 修饰符。

##### LF-CLS-07 参数属性与字段初始化器 [Recommended]

**[Description]**
不要通过类成员显式初始化器引入，而使用 parameter property（`constructor(private readonly x) {}`）；非参数成员在声明处初始化。

##### LF-CLS-08 getter 必须是纯函数 [Required]

**[Description]**
getter 方法**必须**是纯函数：结果一致且无副作用，禁止改变可观察状态。

#### 装饰器（Decorators）

##### LF-DEC-01 只使用框架提供的装饰器 [Required]

**[Description]**
不要定义新的装饰器，只使用框架定义的装饰器（本上下文中的 `@Remote` 属框架装饰器，符合）。

##### LF-DEC-02 装饰器紧跟符号，无空行 [Required]

**[Description]**
装饰器**必须**紧跟在其装饰的符号前面，两者之间没有空行。

##### COM-DEC-01 JSDoc 写在装饰器之前 [Required]

**[Description]**
当类/方法/属性同时有装饰器和 JSDoc 时，在装饰器之前写 JSDoc；不要在装饰器和被装饰语句之间写 JSDoc。

#### 命名（Naming）

##### NAM-01 命名大小写 [Required]

**[Description]**
类/接口/类型/枚举/装饰器/类型参数用 `UpperCamelCase`；变量/参数/函数/方法/属性/模块别名用 `lowerCamelCase`；全局常量值（含枚举值、`static readonly` 属性）用 `CONSTANT_CASE`。

##### NAM-02 描述性名称 [Required]

**[Description]**
名称**必须**具有描述性，不使用读者不熟悉的缩写，不删除单词内部字母缩写；局部 10 行以内的短变量可例外。

##### NAM-03 缩写视为整词 [Required]

**[Description]**
名称中的缩写视为整词，如 `loadHttpUrl` 而非 `loadHTTPURL`；标识符禁止 `_` 前缀/后缀。

#### 注释与文档（Comments & JSDoc）

##### COM-01 文档化所有顶层导出 [Required]

**[Description]**
模块的所有顶层导出必须用 `/** JSDoc */` 文档化；避免仅重复属性/参数名称。13 个接口/类型与 Provider 桩类均需 JSDoc。

##### COM-02 类注释 [Required]

**[Description]**
类的 JSDoc 应为读者提供足够信息了解如何使用类及正确使用的额外考虑；方法描述以第三人称动词短语开头。

##### COM-04 JSDoc 类型注解冗余 [Required]

**[Description]**
JSDoc 类型注解在 TypeScript 源代码中冗余，禁止在 `@param`/`@return` 块中声明类型。

##### COM-05 多行注释用 // 风格 [Required]

**[Description]**
多行注释**必须**使用多个单行注释（`//` 风格），而非块注释（`/* */`）。

#### 核心风格与工具链（Core style & toolchain）

##### CORE-01 ES 模块 / 引号 / 分号 / 缩进 / 日志 [Required]

**[Description]**
推荐使用 Node.js ES 模块（`"type":"module"`）；使用单引号；显式使用分号；禁止 `console.log`，通过 logger 输出日志；TypeScript 缩进**必须**采用 2 个空格。

##### CORE-02 文件行数限制 [Recommended]

**[Description]**
普通业务文件 300-500 行；组件/类文件 200-300 行；工具/配置文件 100-200 行；大型模块不超过 800 行。

##### CORE-03 文件头部 JSDoc [Recommended]

**[Description]**
文件头部声明采用 `@author`/`@copyright` 样式的 JSDoc；类、`export` 方法及重要方法必须有 JSDoc。

##### POL-01 一致性 [Required]

**[Description]**
未明确解决的风格问题与同一文件/目录现有代码保持一致；新文件必须使用 Google 风格。

##### SFB-01 文件编码 UTF-8 [Required]

**[Description]**
源文件使用 UTF-8 编码；字符串字面量中除换行外的其他空白字符必须转义。

##### TS-IF-01 接口优于类型别名 [Recommended]

**[Description]**
声明对象类型时使用接口而非对象字面量类型的类型别名。

##### TS-STR-01 结构化类型在声明处显式指定类型 [Recommended]

**[Description]**
在符号声明处显式包含类型（`const foo: Foo = {...}`），以获得更精确的类型检查和错误报告。

##### TS-INF-01 类型推断 [Recommended]

**[Description]**
可依赖编译器推断简单类型（string/number/boolean/new 表达式）；复杂表达式应加注解提高可读性；空数组/Map/Set 需显式泛型参数防止推断为 `unknown`。

##### TS-ARR-01 T[] 与 Array<T> [Recommended]

**[Description]**
简单类型用 `T[]`/`readonly T[]` 语法糖；复杂类型用 `Array<T>`；多维非 readonly 数组用 `T[][]`。

##### TS-WRP-01 包装器类型使用小写 [Required]

**[Description]**
禁止使用 `String`/`Boolean`/`Number` 包装器类型，始终使用小写原始类型 `string`/`boolean`/`number`。

##### TS-EMP-01 空类型 {} [Recommended]

**[Description]**
避免使用 `{}` 类型，优先 `unknown`、`Record<string, T>` 或 `object`。

##### LF-EX-02 使用 new 实例化错误 [Required]

**[Description]**
实例化异常时始终使用 `new Error()`，而非直接调用 `Error()`。

### 3. Security & production notes

- **SFS-EXP-01（默认导出冲突）**：上下文要求 `export default` Provider 桩类，与 clean-ts「禁止默认导出」直接冲突。DSH/Cordis 插件加载器可能约定默认导出；若必须遵循框架约定，应在团队内明确并在全仓保持一致（POL-01），否则 Provider 类改用命名导出。
- **TS-ANY-01（RPC/schemastery 边界）**：`TypertRemoteService` 泛型与 `s.object` 推断处不要用 `any`，优先 `unknown` 或具体接口，避免掩盖类型错误。
- **LF-AS-03（schemastery Config）**：`static Config: s<Config>` 与 `export interface Config` 之间不要用 `as` 断言绕过；接口字段变更应被编译器捕获。
- **LF-EX-01（事件发射）**：`emitWorkflowEvent`/`session.append` 路径抛出的错误必须是 `Error` 子类（`TypeError` 可），确保事件发射失败时有堆栈跟踪。
- **SFS-MOD-01（declare module）**：`declare module '@deepseek-ai/cordis'` 合并 `Context`/`Events`、`declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap` 是合法模块增强，禁止改用 `namespace` 或 `require`。
- **TC-01（模块合并/泛型 RPC）**：若 `declare module` 合并或泛型 RPC 类型不匹配，不要用 `@ts-ignore` 压制，应修正类型声明本身。
