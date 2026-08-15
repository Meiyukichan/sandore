# CleanCode 探索结果

> 类型：cleancode（TypeScript 编码规范） | 语言：chinese | 项目：sandore

## 探索内容

实现 crud-02（定义/Job/实例 CRUD + 存储域持久化 + Host RPC）：`packages/sandore/workflow/src/persistence.ts`（待建，`ctx.storageDomain.open(sandoreDomainSpec)` 三表 definitions/jobs/state + `[Service.init]` 生命周期 + `Domain.close()` 释放）、`remote.ts`（扩展 stub，`TypertRemoteService` + `@Remote` 定义 CRUD + Job CRUD + 实例生命周期 + getArtifacts + listProviders/listModels）、以及 `schema.ts`/`types.ts`/`errors.ts`/`index.ts` 的配套扩展；测试用内存 mock storageDomain。

## 涉及代码特征

- 类定义与继承、构造注入与 `readonly`/参数属性
- 框架装饰器（`@Remote` / `[Service.init]`）
- async 方法（`Promise`）、接口与类型别名
- 命名导出与 `import type` / `export type`
- Zod 类型推断、类型化异常（`throw new SandoreError`）
- 类型/非空断言、JSDoc 文档化、工具链类型检查

---

## 1. 异常处理与类型断言

### LF.16 用 `new` 实例化异常 [Required]

实例化异常时始终使用 `new Error()`，而不仅仅是调用 `Error()`。

```ts
throw new Error('Foo is not a valid bar.')
```

### LF.17 只抛出 Error 对象 [Required]

只抛出或拒绝 `Error`（或其子类）对象，否则不会填充堆栈跟踪信息。Promise 拒绝值同理。

```ts
throw new Error('oh noes!')
class MyError extends Error {}
throw new MyError('my oh noes!')
Promise.reject(new Error('oh noes!'))
```

### LF.20 类型/非空断言优先运行时检查 [Recommended]

类型断言（`x as SomeType`）和非空断言（`y!`）不安全（只让编译器静音、无运行时检查）。应写显式运行时检查：

```ts
if (x instanceof Foo) { x.foo() }
if (y) { y.bar() }
```

### TS.10 `unknown` 优于 `any` [Required]

无法确定类型时用 `unknown` 而非 `any`；`unknown` 不允许取消引用任意属性，更安全。

```ts
const val: unknown = value
```

### TC.01 禁止 `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` [Required]

不要使用这些指令。测试需要处理未检查值的 API 时，用显式转换（`as`）加说明性注释，将错误抑制限制在单个表达式。

## 2. 文件与模块组织

### SFS.02 命名导出，禁止默认导出 [Required]

所有代码使用命名导出（`export class Foo`），禁止 `export default`。默认导出无规范名称，且鼓励将一切塞进一个作为命名空间的大对象。

### SFS.03 导出可见性 [Recommended]

只导出在模块外部使用的符号，最小化导出 API 表面。

### SFS.04 可变导出 [Recommended]

禁止 `export let`；可变绑定应通过显式 getter 函数访问。

### SFS.06 `import type` / `export type` [Recommended]

仅作为类型使用的导入用 `import type {...}`，重新导出类型用 `export type {...}`。

### SFS.08 导入路径与命名空间导入 [Recommended]

引用同一（逻辑）项目文件优先相对导入（`./foo`），并限制 `../../..` 父目录层级；第三方库或导出很多符号的模块用命名空间导入。

## 3. 类、构造注入与装饰器

### LF.02 类声明不以分号结尾 [Required]

类声明禁止以分号结尾；类表达式语句必须分号结尾。

### LF.03 类方法不以分号分隔 [Required]

类方法声明之间禁止用分号分隔，方法间用单个空行分隔。

### LF.04 禁止 `#private` 字段 [Required]

禁止 `#ident` 私有字段，改用 TypeScript 可见性注解（`private`）。

### LF.05 `readonly` 修饰符 [Recommended]

用 `readonly` 修饰符标记在构造函数外从不重新赋值的属性。

### LF.06 参数属性 [Recommended]

不要为类成员写显式初始化器，直接用构造参数属性（`constructor(private readonly foo: Foo) {}`）。

### LF.07 可见性 [Recommended]

尽可能限制符号可见性；TypeScript 符号默认 public，除非声明非只读 public 参数属性，否则不要写 `public` 修饰符。

### LF.22 装饰器只限框架 [Required]

禁止定义新装饰器，只使用框架提供的装饰器（如 `@Remote`、`[Service.init]`）。

### LF.23 装饰器紧邻符号 [Required]

装饰器必须紧跟在其装饰的符号前面，两者之间没有空行。

## 4. 函数与异步

### LF.01 `const`/`let` 与单声明 [Required]

用 `const`/`let` 声明变量（默认 `const`，需重赋值才用 `let`），禁止 `var`；每个局部变量声明只声明一个变量。

### LF.09 命名函数优先函数声明 [Recommended]

定义命名函数优先用函数声明（`function foo() {}`），而非箭头函数或函数表达式。

### LF.10 不使用函数表达式 [Required]

不要用 `function` 表达式，用箭头函数代替（除非必须动态重绑定 `this`，或没有箭头语法的生成器）。

### LF.11 箭头函数体 [Recommended]

返回值被使用时才用简洁体（表达式），否则用块体确保返回类型是 `void` 并防止副作用泄漏。

### LF.13 回调优先传箭头函数 [Recommended]

回调优先传显式转发参数的箭头函数，避免命名回调因意外参数导致逻辑错误。

### LF.15 控制流语句大括号 [Required]

控制流语句（`if`/`for`/`while` 等）总是用大括号包围；非空块的第一个语句必须从自己的行开始。

### LF.18 空 catch 块 [Recommended]

catch 块完全不作为时，应在注释中解释这是正当理由。

### LF.19 类型断言 `as` 语法 [Required]

类型断言必须用 `as` 语法（`z as Foo`），禁止尖括号语法（`<Foo>z`）。

### LF.21 try 块保持精简 [Recommended]

在不损害可读性的情况下限制 try 块内的代码量，把非抛出行移出 try/catch。

## 5. 类型系统

### TS.01 类型推断 [Recommended]

代码可依赖 TypeScript 的类型推断；简单类型省略注解，复杂表达式加注解以提高可读性。

### TS.03 类型别名禁止 `|null`/`|undefined` [Required]

类型别名禁止在联合类型中包含 `|null` 或 `|undefined`，应只在实际使用别名处添加并就近处理空值。

### TS.04 优先可选参数而非 `|undefined` [Recommended]

接口/类字段与参数优先用 `?` 可选，而非 `|undefined` 联合类型。

### TS.06 接口优于类型字面量别名 [Recommended]

声明对象类型时用 `interface` 而非对象字面量表达式的 `type` 别名。

### TS.07 `Array<T>` 语法糖 [Required]

简单类型用 `T[]`/`readonly T[]` 语法糖，更复杂情况才用 `Array<T>`。

### TS.09 最简类型构造 [Recommended]

始终使用能表达代码的最简单类型构造。

### TS.11 `{}` 空类型 [Recommended]

`{}` 表示任何非空值，大多数场景不适用；优先 `unknown`、`Record<string, T>` 或 `object`。

## 6. 命名

### NM.01 标识符与大小写风格 [Required]

标识符只用 ASCII 字母、数字、下划线与美元符号；class/interface/type/enum/decorator/类型参数用 UpperCamelCase，变量/函数/参数/方法/属性/模块别名用 lowerCamelCase，全局常量（含枚举值）用 CONSTANT_CASE。

### NM.02 名称不装饰类型信息 [Recommended]

名称不装饰类型中已包含的信息；禁止下划线前缀/后缀、`opt_` 前缀，不特别标记接口（如 `IMyInterface`）。

### NM.03 描述性名称 [Required]

名称必须描述性、对新读者清晰；不用含义模糊的缩写、不删除单词内字母；短名单字母仅限 10 行以内局部作用域且非导出 API 参数。

### NM.04 camelCase 缩写视为整词 [Required]

名称中的缩写视为整词：`loadHttpUrl` 而非 `loadHTTPURL`（平台名如 `XMLHttpRequest` 除外）。

### NM.06 CONSTANT_CASE 仅模块级 [Required]

只有模块级符号、模块级类静态字段、模块级枚举值可用 CONSTANT_CASE；函数内局部变量等用 lowerCamelCase。

## 7. 注释与文档

### CD.01 JSDoc 与普通注释 [Required]

文档化用 `/** JSDoc */`，实现注释用 `//`；多行注释用多个 `//` 单行注释，不用 `/* */` 块注释。

### CD.02 JSDoc 格式 [Required]

JSDoc 必须格式良好，用 Markdown 书写；列表用 Markdown 列表语法（`-` 项）。

### CD.03 JSDoc 标签单独占行 [Required]

大多数 JSDoc 标签（如 `@param`）必须占据自己的行，不得合并。

### CD.04 文档化所有顶层导出 [Recommended]

用 JSDoc 文档化模块的所有顶层导出；用途不显而易见的属性/方法也应文档化。

### CD.06 方法描述动词短语 [Recommended]

方法描述以第三人称动词短语开头（隐含「此方法 …」），非祈使句。

### CD.07 参数属性 `@param` [Recommended]

参数属性（带 `private`/`protected`/`public`/`readonly` 的构造参数）用 `@param` JSDoc 注解文档化。

### CD.08 JSDoc 类型注解禁止 [Required]

JSDoc 类型注解在 TS 源码中冗余：不在 `@param`/`@return` 中声明类型，不写 `@implements`/`@enum`/`@private`/`@override`。

### CD.09 注释提供实际信息 [Recommended]

注释必须提供实际信息，避免只重复参数名称和类型；`@param`/`@return` 仅在增加信息时才需要。

### CD.11 JSDoc 在装饰器之前 [Required]

类/方法/属性同时有装饰器与 JSDoc 时，JSDoc 写在装饰器之前，不在装饰器与被装饰语句之间写 JSDoc。

## 8. 工具链与代码风格

### TC.02 通过标准工具链类型检查 [Required]

所有 TypeScript 文件必须通过标准工具链的类型检查。

### CS.02 命名空间导入 [Recommended]

第三方库或有多个导出的模块使用命名空间导入。

### CS.03 Node 内置模块默认导入 [Required]

Node.js 内置模块必须使用默认导入（`import fs from 'fs'`）。

### CS.04 单引号 [Required]

字符串字面量使用单引号（`'`）。

### CS.06 禁止 `console.log` [Required]

禁止使用 `console.log`，通过 logger 输出日志。

### CS.07 两空格缩进 [Required]

TypeScript 缩进风格必须采用 2 个空格。

### CS.08 文件头部 JSDoc [Required]

文件头部声明采用 JSDoc 样式（`@author`/`@copyright`）；类、main 方法、`export` 方法及确实重要的方法必须有 JSDoc，常量用行前 `//` 注释。

### CS.10 文件行数 [Recommended]

普通业务文件 300-500 行，组件/类文件 200-300 行，工具/配置文件 100-200 行，大型模块不超过 800 行。

### PL.01 一致性 [Required]

规范未明确解决的风格问题与同文件/同目录现有代码保持一致；新文件必须使用 Google 风格；向非 Google 风格文件添加代码时尽量一致但禁止违反风格指南。

## 9. 本项目落点提示（安全与生产注意）

- **TS.10（unknown 优于 any）**：`remote.ts` 的 RPC 入参、YAML 解析结果、storageDomain 读回的 value 都是跨信任边界的外部数据，应先以 `unknown` 接收再经 Zod schema 收窄为具体类型，禁止用 `any` 绕过校验。
- **LF.17（只抛 Error）**：`persistence.ts`/`remote.ts` 的校验失败、条目不存在等错误必须抛 `SandoreError`（`errors.ts` 的 `Error` 子类，携带稳定 `code`），以便 Host RPC 层按 `code` 稳定路由，不抛字符串/裸对象。
- **TC.01（禁止 @ts-ignore）**：不得用 `@ts-ignore`/`@ts-expect-error` 压掉 storageDomain/typert 的类型错误；测试中的 mock 用显式 `as` 转换 + 说明注释，把抑制限制在单个表达式。
- **LF.20（运行时检查优于断言）**：storageDomain `get()` 的返回值即使经 schema 校验，对未定义/非空仍需真值或 `instanceof` 检查，而不是 `!`/`as` 断言，避免运行时崩溃。
- **SFS.02 与既有代码的张力**：`remote.ts` 现存 `export default SandoreRemote`、`index.ts` 现存 `export default class SandoreEngineStub`，与「禁止默认导出」冲突。新建的 `persistence.ts` 必须只用命名导出；对既有 default export，若其为 DSH 插件注册所需（`default export` 作为插件入口），按 PL.01 一致性保留，否则应改为命名导出。
- **SFS.08 与 `.ts` 后缀导入**：仓库现有代码使用 `import ... from './schema.ts'`（带扩展名）与 `import type {} from '@deepseek-ai/dsh-session/types'`，属 DSH 特有约定；`persistence.ts`/`remote.ts` 沿用该约定以保持一致。
