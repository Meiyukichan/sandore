### 1. Scope

- **Requirement summary**: 在 `packages/sandore/workflow/src/remote.ts` 补 7 个生命周期 RPC（replyQuestion / replyPermission / pauseStep / resumeStep / pauseAll / resumeAll / retryStep），以 `@Remote` 装饰器 + zod 入参校验 + `SandoreError(code)` 透传转调 `ctx.sandoreEngine`；在 `remote.spec.ts` 扩展 mock 引擎与 vitest 用例。
- **Code features affected**: `@Remote` 装饰器类方法、zod（`import { z } from 'zod'`）对象 schema + `z.infer` 类型推导、async 方法、`SandoreError(code)` 错误透传、vitest `describe`/`it`/`expect`、harness() mock 组装（MemoryStorageDomain + SandorePersistence + mock llm + mock sandoreEngine）、`catchCode`/`catchCodeAsync` 错误码断言、`import type`/`export type`、单引号 + 分号 + 2 空格缩进。

### 2. Guidelines

#### @Remote 装饰器方法与 JSDoc

##### LF-DEC Decorators [Required]

**[Description]**

装饰器是带有 `@` 前缀的语法，如 `@MyDecorator`。

不要定义新的装饰器。只使用框架定义的装饰器：
- Angular（例如 `@Component`、`@NgModule` 等）
- Polymer（例如 `@property`）

**为什么？**

我们通常要避免装饰器，因为它们是实验性功能，已偏离 TC39 提案，并且有已知不会修复的错误。

使用装饰器时，装饰器**必须**紧跟在其装饰的符号前面，两者之间没有空行。

##### CD-JSDOC-DEC Place documentation prior to decorators [Required]

**[Description]**

当类、方法或属性同时有装饰器（如 `@Component`）和 JSDoc 时，请确保在装饰器之前编写 JSDoc。
- 不要在装饰器和被装饰语句之间写 JSDoc。
- 在装饰器之前写 JSDoc 块。

#### 错误透传（SandoreError）

##### LF-ERR-NEW Instantiate errors using `new` [Required]

**[Description]**

实例化异常时始终使用 `new Error()`，而不仅仅是调用 `Error()`。两种形式都创建一个新的 `Error` 实例，但使用 `new` 与其他对象的实例化方式更一致。

##### LF-ERR-ONLY Only throw errors [Required]

**[Description]**

JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。

相反，只抛出（的子类）`Error`。

#### zod 入参校验与类型推导

##### LF-ASSERT Type and non-nullability assertions [Required]

**[Description]**

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。

因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。

当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。

类型断言**必须**使用 `as` 语法（而不是尖括号语法）。这会在访问成员时强制在断言周围添加括号。

TypeScript 只允许类型断言转换为更具体或更不具体的类型版本。添加不满足此条件的类型断言将给出错误："类型 'X' 到类型 'Y' 的转换可能是错误的，因为两种类型都不足以重叠。" 如果你确定断言是安全的，可以执行*双重断言*。这涉及通过 `unknown` 转换，因为它比所有类型都不具体。使用 `unknown`（而不是 `any` 或 `{}`）作为中间类型。

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
// z must be Foo because ...
const x = (z as Foo).length;
```

```
// x is a Foo here, because...
(x as unknown as Foo).fooMethod();
```

##### TS-ANY `any` Type [Required]

**[Description]**

TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。

**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：
- 提供更具体的类型
- 使用 `unknown`
- 抑制 lint 警告并记录原因

`any` 类型允许赋值到任何其他类型并取消引用其上的任何属性。通常这种行为不是必要或期望的，代码只需要表达类型是未知的。在那种情况下使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。

有时使用 `any` 是合理的，例如在测试中构造模拟对象。在这种情况下，添加一个注释来抑制 lint 警告，并记录为什么它是合理的。

**[Compliant]**

```
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

#### 类型检查门槛

##### TR-TSIGNORE @ts-ignore [Required]

**[Description]**

不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。

**为什么？**

它们表面上似乎是"修复"编译器错误的简单方法，但实际上，特定的编译器错误通常是由更大的问题引起的，可以更直接地修复。

例如，如果你使用 `@ts-ignore` 抑制类型错误，很难预测周围代码最终会看到什么类型。对于许多类型错误，如何最好地使用 `any` 的建议很有用。

在单元测试中可以使用 `@ts-expect-error`，但通常**不应该**。`@ts-expect-error` 抑制所有错误。很容易意外地过度匹配并抑制更严重的错误。考虑以下之一：
- 当测试需要处理运行时未检查值的 API 时，添加强制转换为预期类型或 `any`，并添加说明性注释。这将错误抑制限制在单个表达式上。
- 抑制 lint 警告并记录原因，类似于抑制 `any` lint 警告。

#### 核心风格与源文件基础

##### CS-QUOTE 单引号 [Required]

普通字符串字面量用单引号（`'`）而非双引号（`"`）分隔；若字符串含单引号，考虑模板字符串以避免转义。

##### CS-SEMI 显式分号 [Required]

显式以分号结束所有语句，不得依赖自动分号插入（ASI）。

##### CS-INDENT 2 空格缩进 [Required]

TypeScript 缩进风格必须采用 2 个空格缩进。

##### CS-JSDOC 文档注释 [Recommended]

类、main 方法、`export` 方法及确实重要的方法必须要有 JSDoc 注释，常量则使用行前 `//` 注释。

##### SFB-UNICODE 非 ASCII 字符 [Required]

非 ASCII 字符使用实际的 Unicode 字符（如中文注释直接书写，不写 `\u` 转义）。

#### 导入与导出

##### SFS-IMPORTTYPE Import type / Export type [Recommended]

仅作类型使用的导入用 `import type {...}`；类型重导出用 `export type {AnInterface} from './foo'`。

##### SFS-NAMEDEXPORT 命名导出 [Required]

使用命名导出，禁止默认导出。现有 `remote.ts` 同时存在 `export class SandoreRemote` 与 `export default SandoreRemote`；新增代码沿用既有约定、不新增默认导出。

##### SFS-VISIBILITY 导出可见性 [Recommended]

只导出在模块外部使用的符号，最小化模块的导出 API 表面。

#### 命名与常量

##### NAM-STYLE 命名风格 [Required]

名称不应以类型信息装饰：禁止 `_` 前缀/后缀、`opt_` 前缀，不特别标记接口（如 `IMyInterface`）。

##### NAM-DESC 描述性名称 [Required]

名称必须具有描述性，不使用含义模糊的缩写、不删除单词内部字母缩写。

##### NAM-CASE 按标识符类型命名 [Required]

类/接口/类型/枚举/装饰器使用 UpperCamelCase；变量/函数/方法/参数使用 lowerCamelCase；全局常量使用 CONSTANT_CASE。

##### NAM-CONST 常量 [Required]

CONSTANT_CASE 表示值意图不修改（如 `TERMINAL_STATUSES`）；`static readonly` 属性也是常量。

#### 函数与类型系统

##### LF-CONST 使用 const 和 let [Required]

默认使用 `const`，除非变量需要重新赋值；禁止使用 `var`；每个局部变量声明只声明一个变量。

##### LF-FN 优先函数声明 [Recommended]

命名函数优先使用函数声明而非箭头函数（测试辅助函数如 `catchCode`/`makeState` 采用函数声明）；方法体内的嵌套函数优先箭头函数以访问外层 `this`。

##### LF-ARROW 箭头函数体 [Recommended]

返回值未使用时用块体（避免返回泄漏）；优先传递箭头函数作为回调（显式转发参数）。

##### LF-STRING 字符串字面量 [Required]

单引号、禁止行延续（反斜杠续行）；复杂字符串拼接使用模板字面量。

##### LF-CONTROL 控制结构大括号 [Required]

控制流语句（`if`/`for`/`while` 等）总是使用大括号，即使体只含单条语句。

##### LF-EQ 相等性检查 [Required]

必须使用严格相等 `===`/`!==`；与字面量 `null` 比较时可使用 `==`/`!=` 以同时覆盖 `null` 和 `undefined`。

##### TS-RETURN 返回类型 [Recommended]

async 方法保留显式 `Promise<...>` 返回类型（项目惯例，RPC 方法均带返回类型）。

##### TS-OPTIONAL 可选参数优于 |undefined [Recommended]

使用 `?` 可选参数（如 `resumePrompt?: string`）而非 `|undefined` 联合。

##### TS-INTERFACE 接口优于类型字面量别名 [Recommended]

对象类型声明用 `interface` 而非 `type X = {...}`；`z.infer` 需要类型别名时除外。

##### TS-ARRAY Array<T> Type [Required]

简单类型使用 `T[]`/`readonly T[]` 语法糖；复杂类型使用 `Array<T>`。

##### TS-WRAPPER 包装器类型 [Required]

禁止使用 `String`/`Boolean`/`Number` 包装器类型，始终使用小写原始类型。

#### 注释与文档

##### CD-JSDOCVSCOMMENT JSDoc 与普通注释 [Required]

文档化使用 `/** JSDoc */`；实现注释使用 `//`；多行注释必须用多个 `//` 单行注释而非 `/* */`。

##### CD-TOPEXPORT 文档化顶层导出 [Required]

模块的所有顶层导出必须文档化（`export interface`/`export type` 均带 JSDoc）。

##### CD-METHOD 方法注释 [Recommended]

方法描述以第三人称动词短语开头（如"回复待处理问答"）；`@param`/`@return` 仅在添加信息时才需要。

##### TR-TSC TypeScript 编译器 [Required]

所有 TypeScript 文件必须通过标准工具链类型检查（`tsc --noEmit`）。

##### POL-CONSISTENT 一致性 [Required]

风格问题与同一文件已有代码保持一致；新代码不得违反风格指南。zod 三步范式（schema 常量 → `z.infer` 导出类型 → 方法首行 `parse`）沿用 `remote.ts` 既有约定。

### 3. Security & production notes

- **zod 入参校验（对应 LF-ASSERT）**：7 个 RPC 的入参来自不可信客户端，必须先经 `z.object({...}).parse(input)` 运行时校验（LF-ASSERT 的"显式运行时检查"），校验失败抛 `ZodError`；对象入参建 schema 常量，标量入参（`instanceId`/`stepId` 等）依赖 `require*` 守卫。
- **SandoreError 透传（对应 LF-ERR-NEW / LF-ERR-ONLY）**：RPC 层不 try/catch，`SandoreError`（继承 `HarnessError`，即 `Error` 子类）直接向上抛，Typert 映射 `code`/`message`；永远按 `code` 路由、不解析 `message`。
- **mock 部分实现的类型收窄（对应 TS-ANY / LF-ASSERT / TR-TSIGNORE）**：`remote.spec.ts` 的 mock 引擎为部分实现，用 `engine as unknown as SandoreEngine` 双重断言（中间类型用 `unknown`），并加注释说明是"intentionally unsafe partial mock"，禁止 `@ts-expect-error` 整段抑制。
