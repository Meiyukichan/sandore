# Furina CleanCode Exploration Result

# Explore Content
核实 DSH 工作流引擎相关运行时能力接缝（`ctx.subagents`/`ctx.agents`/`Agent`/`finalAssistantOutput`/`ctx.subprocess` 及 shell 接缝）与 sandore 引擎（microflow/workflow）既有代码的类型形状，作为 foundation-01 的结构接缝与类型基座依据。

# Explore Type
cleancode

# Exploration Result

## 1. Scope

- **Requirement summary**：为 foundation-01 核实 DSH 工作流引擎运行时能力接缝与 sandore 引擎（microflow/workflow）既有代码的类型形状，产出结构接缝、类型签名与编码规范基座。
- **Code features affected**：`.d.ts` 声明文件与 `declare module` 模块增强；Cordis Service/Context 接缝（`abstract class extends Service`、`interface Context`/`interface Events`）；结构类型接缝（本地 `ShellExecutor` 与宿主结构兼容）；Branded/联合类型别名（`DagRunStatus`/`StepStatus`）；merge-extensible 事件映射（`SessionEventMap`）；Zod/Schemastery schema（`z.object`/`z.natural()`）；`import type`/`export type`。

## 2. Guidelines

### 结构类型接缝与声明合并（核心）

#### TS.TYPE.05 使用结构类型 [Recommended]

**[Description]**

TypeScript 的类型系统是结构化的，不是名义上的。也就是说，如果值至少具有类型要求的所有属性，并且属性的类型匹配（递归地），则值匹配类型。

在提供基于结构的实现时，在符号的声明处显式包含类型（这允许更精确的类型检查和错误报告）。

使用接口定义结构类型，而不是类。

**[Compliant]**

```ts
interface Foo {
  a: number;
  b: string;
}

const foo: Foo = {
  a: 123,
  b: 'abc',
}
```

#### TS.TYPE.06 接口优于类型字面量别名 [Recommended]

**[Description]**

TypeScript 支持为类型表达式命名提供类型别名。这可用于命名原始类型、联合、元组和任何其他类型。

但是，声明对象的类型时，使用接口而不是对象字面量表达式的类型别名。

**为什么？** 这些形式几乎相同，所以根据从两种形式中选择一种以防止变化的原则，我们应该选择一种。此外，也有有趣的技术原因倾向于接口。

**[Compliant]**

```ts
interface User {
  firstName: string;
  lastName: string;
}
```

#### TS.TYPE.10 any 类型 [Recommended]

**[Description]**

TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。

**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：

- 提供更具体的类型
- 使用 `unknown`
- 抑制 lint 警告并记录原因

`any` 类型允许赋值到任何其他类型并取消引用其上的任何属性。通常这种行为不是必要或期望的，代码只需要表达类型是未知的。在那种情况下使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。要安全地使用 `unknown` 值，使用类型守卫缩小类型。

**[Compliant]**

```ts
// Use declared interfaces to represent server-side JSON.
declare interface MyUserJson {
  name: string;
  email: string
}

// Use type aliases for types that are repetitive to write.
type MyType = number|string;
```

```ts
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

#### TS.TYPE.11 {} 类型 [Recommended]

**[Description]**

`{}` 类型，也称为*空接口*类型，表示没有属性的接口。空接口类型没有指定属性，因此任何非空值都可以赋值给它。

Google3 代码**不应该**将 `{}` 用于大多数用例。`{}` 代表任何非空原始类型或对象类型，这很少是合适的。优先选择以下更描述性的类型之一：

- `unknown` 可以保存任何值，包括 `null` 或 `undefined`，对于不透明值通常更合适。
- `Record<string, T>` 用于类似字典的对象，并通过对包含值的类型 `T`（它本身可能是 `unknown`）更明确来提供更好的类型安全。
- `object` 也排除原始类型，只留下非空函数和对象，但不对可能可用的属性做出任何其他假设。

（原文无 compliant 示例，故不附代码示例。）

#### TS.SRC.11 Import type / Export type [Recommended]

**[Description]**

当仅将导入的符号用作类型时，可以使用 `import type {...}`。对值使用常规导入。**为什么？** TypeScript 编译器自动处理区别，不插入类型引用的运行时加载。编译器可以以两种模式运行：开发模式下转译为 JavaScript 而无需完整类型信息，更快，但某些情况下需要 `import type`；生产模式下编译器类型检查一切并确保正确使用 `import type`。注意：如果需要强制加载副作用，请使用 `import '...';`。

重新导出类型时使用 `export type`。**为什么？** `export type` 对于文件转译中的类型重新导出很有用，也可能有助于避免为 API 导出值符号。然而它不能提供保证：下游代码可能通过不同路径导入 API。分割和保证 API 类型与值用法的好方法是实际将符号拆分为例如 `UserService` 和 `AjaxUserService`，这更不容易出错，也更好地传达意图。

**[Compliant]**

```ts
import type {Foo} from './foo';
import {Bar} from './foo';

import {type Foo, Bar} from './foo';
```

```ts
export type {AnInterface} from './foo';
```

### 类型声明风格（Medium）

#### TS.TYPE.01 类型推断 [Recommended]
代码可以依赖 TypeScript 推断；简单的 `string`/`number`/`boolean`/`RegExp`/`new` 表达式可省略注解，复杂表达式应加注解以提高可读性。

#### TS.TYPE.02 返回类型 [Recommended]
是否写返回类型注解由作者决定；审查者可要求为复杂返回类型补充注解。

#### TS.TYPE.03 可空类型别名 [Required]
类型别名禁止在联合中包含 `|null`/`|undefined`；只在具体使用处添加，并在值出现附近处理空值。

#### TS.TYPE.04 优先可选而非 `|undefined` [Required]
用 `?` 可选字段/参数而非 `|undefined`；可选参数在其类型中隐式含 `|undefined`，但可省略。

#### TS.TYPE.07 `Array<T>` [Required]
简单类型用 `T[]`/`readonly T[]` 语法糖；复杂情形（联合、对象字面量）用 `Array<T>`/`ReadonlyArray<T>`。

#### TS.TYPE.08 索引签名 [Recommended]
对象作字典用 `{[key: string]: T}` 并为键取有意义标签；优先考虑 ES6 `Map`/`Set`；`Record<Keys, T>` 用于静态已知键集。

#### TS.TYPE.09 映射/条件类型 [Recommended]
始终使用最简单类型构造；映射/条件类型求值模型未完全规定且随编译器版本变化，简单接口扩展通常比 `Pick` 等更易理解。

#### TS.TYPE.12 元组类型 [Recommended]
简单 Pair 用元组 `[string, string]`；为属性命名通常更清晰，可用内联对象字面量类型替代过重的 interface。

#### TS.TYPE.13 包装器类型 [Required]
禁止 `String`/`Boolean`/`Number` 包装器类型，始终用小写原始类型；不要 `new` 调用包装器。

#### TS.TYPE.14 仅返回类型泛型 [Required]
避免创建仅返回类型的泛型 API；使用此类现有 API 时必须显式指定泛型。

### 模块与导入导出（Medium）

#### TS.SRC.01 文件顺序 [Required]
文件依次为：版权信息、`@fileoverview` JSDoc、导入、实现；每个部分之间恰好一个空行。

#### TS.SRC.03 四种导入 [Required]
module/named/default/side-effect 四种导入；default 仅用于需要它的外部代码；Node.js 内置模块必须用默认导入（`import fs from 'fs'`）。

#### TS.SRC.04 导入路径 [Required]
同一逻辑项目内优先相对导入（`./foo`）而非绝对路径；限制 `../../../` 层级。

#### TS.SRC.05 命名空间 vs 具名导入 [Recommended]
频繁/名称清晰的符号用具名导入；使用大型 API 的许多符号时用命名空间导入。

#### TS.SRC.06 重命名导入 [Recommended]
通过命名空间导入或重命名导出解决名称冲突；必要时可 `import {X as Y}`。

#### TS.SRC.07 仅命名导出 [Required]
所有代码使用命名导出，禁止默认导出（统一导入模式，命名导出可报未声明成员错误）。

#### TS.SRC.08 导出可见性 [Recommended]
只导出模块外部使用的符号，最小化导出 API 表面。

#### TS.SRC.09 可变导出 [Required]
禁止 `export let`；需外部可变绑定时用显式 getter 函数。

#### TS.SRC.10 容器类 [Required]
不要创建带静态方法/属性的容器类作为命名空间手段，改为导出单个常量和函数。

#### TS.SRC.12 模块而非 namespace [Required]
禁止 `namespace`/`module Foo {}`/`<reference>`/`require`；必须用 ES6 import/export。（`declare module '...'` 模块增强是合法的 Cordis 接缝模式。）

### 命名（Medium）

#### TS.NAM.01 命名风格 [Required]
名称不应装饰类型信息；禁止前后下划线、`opt_` 前缀、`IMyInterface` 式接口标记。

#### TS.NAM.02 描述性名称 [Required]
名称必须描述性，不用模糊缩写、不删词内字母；≤10 行作用域内可短名。

#### TS.NAM.03 Camel case [Required]
缩写按整词处理（`loadHttpUrl` 而非 `loadHTTPURL`）。

#### TS.NAM.04 大小写规则 [Required]
class/interface/type/enum/类型参数用 UpperCamelCase；变量/函数/方法/属性用 lowerCamelCase；模块级常量/枚举值用 CONSTANT_CASE。

#### TS.NAM.05 禁 `_` 前缀/后缀 [Required]
禁止 `_` 前缀/后缀，也禁止 `_` 单独作未使用参数标识符。

#### TS.NAM.06 常量 [Required]
CONSTANT_CASE 表示"意图不变"；仅模块级符号/静态字段/枚举值可用；多次实例化值用 lowerCamelCase。

### 类与语言特性（Medium）

#### TS.LANG.01 const/let [Required]
默认 `const`，需重赋值才用 `let`，禁止 `var`；每行只声明一个变量。

#### TS.LANG.04/05 类声明/方法不以分号结尾 [Required]
类声明与方法声明禁止以分号结尾；方法间用单个空行分隔。

#### TS.LANG.06 禁 `#private` 字段 [Required]
禁止 `#private`，用 TypeScript 可见性注解（`private`）。

#### TS.LANG.07 readonly [Recommended]
构造函数外不重新赋值的属性用 `readonly` 标记。

#### TS.LANG.08 构造函数必须用括号 [Required]
`new Foo()` 而非 `new Foo`。

#### TS.LANG.09 可见性 [Recommended]
TS 符号默认 public，除非声明非只读 public 参数属性，否则不要写 `public` 修饰符。

#### TS.LANG.10 单引号 [Required]
普通字符串用单引号 `'`；复杂拼接用模板字面量。

#### TS.LANG.13 类型转换 [Required]
用 `Number()` 解析数值并显式检查 NaN；禁止一元 `+`、禁止 `parseInt`/`parseFloat`（radix≠10 例外）。

#### TS.LANG.14 控制流大括号 [Required]
控制流语句必须用大括号；`switch` 必须有 `default` 分支且禁止 fall-through。

#### TS.LANG.15 异常处理 [Required]
用 `new Error()` 实例化，只抛出 `Error` 及其子类；`try` 块保持精简。

#### TS.LANG.16 空 catch 注释 [Required]
空 catch 块必须含解释注释。

#### TS.LANG.18 严格相等 [Required]
用 `===`/`!==`；与字面量 `null` 比较可用 `==`/`!=`。

#### TS.LANG.19 类型断言 [Required]
断言用 `as` 语法而非尖括号；无明确理由不应使用类型/非空断言，优先运行时检查。

#### TS.LANG.20 对象字面量用类型注解 [Required]
指定对象字面量类型用 `: Foo` 而非 `as Foo`，以便接口字段变更时报错。

#### TS.LANG.21 分号 [Required]
不要依赖 ASI，用分号显式结束所有语句。

#### TS.LANG.22 禁 const enum [Required]
禁止 `const enum`，用普通 `enum`。

### 注释与文档（Medium）

#### TS.DOC.01 JSDoc vs 普通注释 [Required]
`/** */` 用于文档化，`//` 用于实现注释；多行注释用 `//` 而非 `/* */`。

#### TS.DOC.02 JSDoc 格式 [Required]
JSDoc 必须格式良好；Markdown 列表需用 `-` 列表语法；`@param` 等标签独占一行。

#### TS.DOC.03 文档化顶层导出 [Required]
模块所有顶层导出必须 JSDoc 文档化；方法描述以第三人称动词短语开头。

#### TS.DOC.04 JSDoc 类型注解冗余 [Required]
TS 源码中 JSDoc 类型注解冗余，禁止在 `@param`/`@return` 中重复声明类型。

#### TS.DOC.05 注释须有实际信息 [Required]
避免仅重复参数名/类型；`@param`/`@return` 仅在添加信息时才需要。

### 工具链、核心风格与策略（Medium）

#### TS.TOOL.01 类型检查 [Required]
所有文件必须通过标准工具链类型检查；禁止 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`（单测中 `@ts-expect-error` 通常也不应该）。

#### TS.CORE.01 核心风格 [Required]
ES 模块；单引号；显式分号；2 空格缩进；第三方库/多导出模块用命名空间导入；Node 内置模块必须默认导入。

#### TS.CORE.02 禁 console.log [Required]
通过 logger 输出日志。

#### TS.CORE.03 文件行数 [Recommended]
普通业务文件 300-500 行，类文件 200-300 行，工具/配置文件 100-200 行，大型模块 ≤800 行。

#### TS.POL.01 一致性 [Required]
未解决风格问题与同文件/同目录现有代码保持一致；新文件必须用 Google 风格。

#### TS.POL.02 弃用 [Recommended]
用 `@deprecated` JSDoc 标记弃用并给出清晰修复指导。

## 3. Security & production notes

- **TS.TYPE.06**：`declare module '@deepseek-ai/cordis'` 的 `interface Context`/`interface Events` 与 `declare module '@deepseek-ai/dsh-session/types'` 的 `interface SessionEventMap` 依赖接口声明合并实现可扩展接缝；类型别名无法合并，接缝扩展必须用 interface。
- **TS.TYPE.05**：本地 `ShellExecutor`（shell.ts）与宿主注入的真实 `ShellExecutor` 依赖结构兼容（structurally compatible），声明处必须显式标注结构类型。
- **TS.TYPE.10/11**：接缝与持久化类型中避免 `any`/`{}`；字典型载荷用 `Record<string, unknown>`（如 `metadata?: Record<string, unknown>`）。
- **TS.SRC.11**：`.d.ts` 与纯类型文件（types.ts）必须区分 `import type`（如 `ContentBlock`）与值导入（如 `z` from `@deepseek-ai/schemastery`），避免类型被运行时加载。
- **TS.TOOL.01**：接缝/声明文件不得用 `@ts-ignore` 掩盖类型不匹配，结构兼容必须显式表达。
- **TS.TYPE.03/04**：接缝接口的可选字段（如 `resumePrompt?: string`、`cwd?: string`）用 `?` 而非 `|undefined`。
