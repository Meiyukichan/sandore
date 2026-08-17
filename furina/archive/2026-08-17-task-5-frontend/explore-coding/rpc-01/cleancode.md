# Furina CleanCode Exploration Result

# Explore Content

为 sandore 的 workflow 包新增 ./remote 子路径导出（Typert 远程客户端贡献），由 tsdown + typert generator 从 SandoreRemote 的 @Remote 装饰器方法生成 lib/typert.remote-client.js + .d.ts（同时产出 ./typert 的 typert.host），并让 ui Client 插件 apply(ctx) 内 ctx.remote.$mount(sandoreRemote) 后以 ctx.remote.sandore.* 调用 27 个 RPC。

# Explore Type

cleancode

# Exploration Result

# Sandore Workflow `./remote` 子路径导出 — Clean-TypeScript 编码规范

## 1. Scope

- **Requirement summary**: 为 workflow 包新增 `./remote` 子路径导出，由 tsdown + typert generator 从 `SandoreRemote` 的 `@Remote` 装饰器方法生成 `lib/typert.remote-client.js/.d.ts`，并让 ui Client 插件 `apply(ctx)` 内 `ctx.remote.$mount(sandoreRemote)` 后以 `ctx.remote.sandore.*` 调用 27 个 RPC。
- **Code features affected**: stage-3 方法装饰器与抽象 TypertRemoteService 基类；zod schema + `z.infer` 派生 wire 类型 + `Schema.parse` 运行时边界校验；`RemoteResult<T>` 判别联合解包；`declare module` 接口合并；`import type`/`export type`；`package.json` exports/files 与 tsdown 配置；disposer 生命周期；readonly/ReadonlySet/Object.freeze；`SandoreError extends Error` code 路由；exactOptionalPropertyTypes 可选字段展开；React 插件 `apply(ctx)`；vitest `*.spec.ts`。

## 2. Guidelines

### 装饰器与 @Remote / TypertRemoteService 基类

##### LF.29 装饰器 [禁止/必须]

**[Description]**

装饰器是带有 `@` 前缀的语法，如 `@MyDecorator`。

不要定义新的装饰器。只使用框架定义的装饰器：

- Angular（例如 `@Component`、`@NgModule` 等）
- Polymer（例如 `@property`）

**为什么？**

我们通常要避免装饰器，因为它们是实验性功能，已偏离 TC39 提案，并且有已知不会修复的错误。

使用装饰器时，装饰器**必须**紧跟在其装饰的符号前面，两者之间没有空行：

**[Compliant]**

```
/** JSDoc comments go before decorators */
@Component({...})  // Note: no empty line after the decorator.
class MyComp {
  @Input() myField: string;  // Decorators on fields may be on the same line...

  @Input()
  myOtherField: string;  // ... or wrap.
}
```

##### LF.06 类声明禁分号 [禁止]

类声明禁止以分号结尾；包含类表达式的语句必须以分号结尾。

##### LF.09 构造函数括号与参数属性 [必须/不应该]

构造函数调用必须使用括号（即使无参）；空构造函数或仅委托 `super` 的构造函数不必要；具有参数属性、可见性修饰符或参数装饰器的构造函数不应省略。

##### LF.08 静态方法 [禁止/应该]

禁止在静态上下文中使用 `this`；优先使用模块本地函数而非私有静态方法（`static inject` 应为 public 静态成员，不在其中引用 `this`）。

##### LF.16 可见性 [应该]

尽可能限制符号可见性；默认即为 public 时省略 `public` 修饰符（readonly 参数属性无需 public）。

##### LF.10 / LF.11 / LF.12 / LF.13 私有字段、readonly、参数属性、字段初始化器 [禁止/应该]

禁止 `#private` 字段，使用 TS 可见性注解；用 `readonly` 标记构造外不重新赋值的属性；用 parameter property（`constructor(private readonly ...)`）替代显式初始化；非参数成员在声明处初始化。

##### LF.14 词法作用域外使用的属性禁 private [禁止]

在类词法作用域外使用的属性（如插件中被外部访问的成员）禁止 `private`，用 `protected` 或 `public`；禁止 `obj['foo']` 绕过可见性。

### zod schema 与 z.infer 派生 / RemoteResult 判别联合

##### LF.27 类型与非空断言 [不应该/必须/应该]

**[Description]**

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。

因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。

不要使用以下形式：

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

类型断言**必须**使用 `as` 语法（而不是尖括号语法）；双重断言经 `unknown` 转换，且**必须**使用 `unknown`（而不是 `any` 或 `{}`）作为中间类型：

```
// x is a Foo here, because...
(x as unknown as Foo).fooMethod();
```

##### TS.09 any 类型 [不应该/应该]

**[Description]**

TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。

**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：

- 提供更具体的类型
- 使用 `unknown`
- 抑制 lint 警告并记录原因

**[Compliant]**

```
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

##### TS.01 / TS.02 类型推断与返回类型 [可以]

简单类型（string/number/boolean 等字面量或 `new` 表达式）可省略注解；复杂表达式应加注解以提升可读性；是否标注返回类型由作者决定，审查者可要求澄清复杂返回类型。

##### TS.05 接口优于类型字面量别名 [应该]

对象类型使用 `interface`；但联合类型（如 `RemoteResult<T>` 判别联合、`z.infer` 派生的联合）必须用 `type` 别名，本规则仅约束对象类型。

##### TS.03 可空别名与可选字段 [禁止/应该]

类型别名禁止在联合中包含 `|null`/`|undefined`，应在实际使用处添加；优先用 `?` 可选参数/字段而非 `|undefined`（对应 exactOptionalPropertyTypes 下的可选字段展开写法）。

##### TS.06 / TS.07 / TS.08 / TS.10 / TS.11 数组语法糖、索引签名、映射类型、空类型、包装器 [应该/禁止/不应该]

简单类型数组用 `T[]`/`readonly T[]` 语法糖；对象作字典用索引签名或 `Record`/`Map`/`Set`；始终用能表达代码的最简类型构造，避免复杂映射/条件类型；避免 `{}`，用 `unknown`/`Record<string,T>`/`object`；禁止 `String`/`Boolean`/`Number`/`Object` 包装器类型。

### 异常处理与 SandoreError code 路由

##### LF.24 异常处理（new Error / 只抛 Error）[必须/禁止]

**[Description]**

实例化异常时始终使用 `new Error()`，而不仅仅是调用 `Error()`。两种形式都创建一个新的 `Error` 实例，但使用 `new` 与其他对象的实例化方式更一致。

JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。

**[Compliant]**

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

##### LF.24b 捕获与重抛 [应该]

捕获错误时应假设所有抛出的值都是 `Error` 实例（`catch (e: unknown)` 后收窄）；异常处理程序禁止防御性地处理非 `Error` 类型，除非确知被调 API 会抛非 `Error`。

##### LF.28 精简 try 块 [应该]

限制 try 块内的代码量，将不抛出的行移出 try/catch。

##### LF.25 switch 语句 [必须]

所有 `switch` 必须含 `default` 且放最后；非空语句组禁止 fall-through（对应 `noFallthroughCasesInSwitch`）；空语句组允许 fall-through（SandoreError code 路由若用 switch，必须落此约束）。

##### LF.26 严格相等 [必须]

始终使用 `===`/`!==`；与字面量 `null` 比较可用 `==`/`!=` 同时覆盖 `null` 与 `undefined`。

### declare module 接口合并与模块导出

##### SFS.12 用模块而非 namespace [禁止]

禁止 `namespace` 关键字与 `import x = require(...)`，必须用 ES6 模块语法（`declare module` 是模块增强，不属被禁的 namespace）。

##### SFS.06 命名导出 [必须]

全部使用命名导出，禁止默认导出（对应 `./remote`、`./typert` 子路径导出符号）。

##### SFS.07 导出可见性 [应该]

只导出模块外部使用的符号，最小化导出 API 表面。

##### SFS.08 可变导出 [禁止]

禁止 `export let`；需要外部可变绑定时改用显式 getter 函数。

##### SFS.10 / SFS.11 import type / export type [可以]

仅作类型使用的导入用 `import type {...}`（可 `import {type Foo, Bar}`）；重新导出类型用 `export type`；需要强制副作用时用 `import '...'`。

### package.json exports/files 与 tsdown 生成代码

##### POL.02 生成代码豁免 [必须]

构建过程生成的源代码不需要符合 Google 风格；但任何从手写代码引用的生成标识符必须遵循命名要求（typert generator 产出的 `typert.remote-client.js/.d.ts` 属此类）。

##### TC.01 / TC.02 工具链 [必须/禁止]

所有 TS 文件必须通过标准工具链类型检查；禁止 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`（单元测试中 `@ts-expect-error` 通常也应避免）。

##### CORE.01 / CORE.02 / CORE.03 核心风格 [应该/必须/禁止]

推荐 Node.js ES 模块；第三方库或多导出模块用命名空间导入，Node.js 内置模块必须默认导入；单引号、显式分号、2 空格缩进；禁止 `console.log`，通过 logger 输出日志。

### disposer 生命周期 / React apply(ctx) / 异步与函数

##### LF.17 / LF.18 / LF.19 函数形式 [应该/禁止/应该]

命名函数优先函数声明；禁止函数表达式，用箭头函数；箭头函数简洁体仅在返回值被使用时，否则用块体。

##### LF.20 / LF.21 this 与箭头函数属性 [禁止/不应该]

禁止在函数表达式/函数声明中使用 `this`（除非专门为重新绑定而存在）；类通常不应包含初始化为箭头函数的属性，用箭头函数调用实例方法。

##### LF.22 控制流大括号 [必须]

控制流语句（if/for/while 等）总是使用大括号；可放一行的 `if` 可省略。

##### LF.23 for-of 遍历 [应该]

优先 `for...of` 遍历数组；`for...in` 仅用于字典对象且需 `hasOwnProperty` 过滤。

##### LF.05 对象展开 [必须]

创建对象时只展开对象，禁止展开数组与原始类型（含 `null`/`undefined`）；避免展开类实例/函数等非 Object 原型对象（对应 `...(x===undefined?{}:{x})` 应写成 `...(shouldUseFoo ? {num: 7} : {})` 这类先判空再展开的形式）。

##### LF.01 / LF.02 const/let [必须]

默认 `const`，需要重新赋值才用 `let`，禁止 `var`；每个声明只声明一个变量。

### 命名与注释

##### NAM.05 标识符大小写 [必须]

class/interface/type/enum/decorator/类型参数用 `UpperCamelCase`；变量/参数/函数/方法/属性用 `lowerCamelCase`；全局常量（含 enum 值、模块级 static readonly）用 `CONSTANT_CASE`。

##### NAM.03 / NAM.04 描述性与驼峰 [必须]

名称必须描述性，不用不熟悉缩写、不删除单词内字母；缩写视为整词（`loadHttpUrl` 而非 `loadHTTPURL`）；`_` 前缀/后缀禁止。

##### DOC.03 顶层导出文档化 [必须]

模块的所有顶层导出必须用 `/** JSDoc */` 文档化（仅被工具消费的符号除外）。

##### DOC.09 JSDoc 置于装饰器之前 [必须]

类/方法/属性同时有装饰器（如 `@Remote`）与 JSDoc 时，JSDoc 写在装饰器之前，不在装饰器与被装饰语句之间写 JSDoc。

##### DOC.07 / DOC.02 注释形式 [禁止/必须]

JSDoc 类型注解在 TS 源代码中冗余，禁止重复声明；多行注释必须用 `//` 风格而非 `/* */`。

##### POL.01 一致性 [必须]

未解决的风格问题与同一文件/目录现有代码保持一致；新文件必须用 Google 风格。

##### CORE.05 文件行数 [应该]

业务文件 300-500 行、组件/类文件 200-300 行、工具/配置文件 100-200 行、大型模块不超过 800 行（`remote.ts` 的 27 个 RPC 方法应控制在此范围，必要时拆分）。

## 3. Security & production notes

- **LF.27 + zod 边界校验**：`RemoteResult<T>` 解包惯例 `if (!result.ok) throw ...; return result.value;` 正是该规则要求的"运行时收窄而非断言"；`Schema.parse` 作为 wire 边界的运行时校验同样取代 `as` 断言，二者组合即该规则的 High 实践。
- **LF.24 + RemoteResult 解包**：解包 `RemoteResult` 失败分支抛出 `result.error` 时，若 `RemoteFailure` 是普通对象而非 `Error`，将违反"只抛 Error"。应将其包裹为 `SandoreError`（`extends Error`）再抛出，以保留堆栈与 code 路由信息。
- **LF.29 + @Remote**：`@Remote('name')` 为 typert 框架提供的装饰器，本改动不定义新装饰器，符合"只使用框架定义的装饰器"；stage-3 `ClassMethodDecoratorContext` 属新 TC39 标准（规则中"已偏离 TC39 提案"指旧实验版），需确认 tsdown 目标环境支持。
- **SFS.12 + declare module**：`declare module '@deepseek-ai/cordis'` 合并 `Context.remote` 是模块增强，须避免使用被禁的 `namespace` 语法。
- **TC.01 + 编译器选项**：`strict`/`exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`/`noImplicitOverride`/`noFallthroughCasesInSwitch`/`allowImportingTsExtensions` 应保持开启；`noFallthroughCasesInSwitch` 直接对应 LF.25，`exactOptionalPropertyTypes` 直接对应 TS.03 的可选字段展开写法。
- **POL.02 + 生成产物**：`lib/typert.remote-client.js/.d.ts` 与 `typert.host` 为生成代码，样式可豁免，但被 `ctx.remote.sandore.*` 引用的生成标识符必须符合命名规范。
