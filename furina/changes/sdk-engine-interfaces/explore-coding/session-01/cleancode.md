# Clean TypeScript 编码规范 —— @meiyukichan/claude-sdk 适配层增量扩展（结构化 parts / 会话运行时管理 / 交互控制）

## 1. Scope

- **Requirement summary**: 为 `@meiyukichan/claude-sdk`（packages/sdk/claude）适配层实现结构化 parts 发送、会话运行时管理（setPermissionMode/delete/create title/messages before）与交互控制（rejectQuestion/listPendingPermissions/listPendingQuestions），涉及 `src/types.ts`、`src/session.ts`、`src/session-state.ts`、`src/client.ts` 及对应测试。
- **Code features affected**: 类型联合扩展（types.ts 的 PromptInput/GlobalEventType）、class 方法新增（SessionState/SessionManager）、ESM + `.js` 后缀相对导入、`import type`/`export type`、模板字面量类型断言（`msg_${string}` as MessageID）、结构子集接口（QueryLike）、DI 函数类型（`xxxFn ?? sdkFn`）、异常处理、vitest + FakeQuery。

## 2. Guidelines

### 类型声明与结构类型

##### LF.29 类型与非空断言 [High]

**[Description]**

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。有时由于代码的某些局部属性，你可以确定断言形式是安全的。在那些情况下，你应该添加说明来解释为什么你可以接受不安全的行为。如果类型或非空断言背后的推理是显而易见的，注释**可以**不是必需的。

**[Compliant]**

```ts
// x is a Foo, because ...
(x as Foo).foo();
// y cannot be null, because ...
y!.bar();
```

##### LF.30 类型断言语法 [High]

**[Description]**

类型断言**必须**使用 `as` 语法（而不是尖括号语法）。这会在访问成员时强制在断言周围添加括号。

**[Compliant]**

```ts
// z must be Foo because ...
const x = (z as Foo).length;
```

##### LF.32 类型断言和对象字面量 [High]

**[Description]**

使用类型注解（`: Foo`）而不是类型断言（`as Foo`）来指定对象字面量的类型。这允许在接口字段随时间变化时检测重构错误。

**[Compliant]**

```ts
interface Foo {
  bar: number;
  baz?: string;
}
const foo: Foo = {
  bar: 123,
  bam: 'abc',  // complains about "bam" not being defined on Foo.
};
function func(): Foo {
  return {
    bar: 123,
    bam: 'abc',   // complains about "bam" not being defined on Foo.
  };
}
```

##### TYP.06 使用结构类型 [High]

**[Description]**

TypeScript 的类型系统是结构化的，不是名义上的。也就是说，如果值至少具有类型要求的所有属性，并且属性的类型匹配（递归地），则值匹配类型。在提供基于结构的实现时，在符号的声明处显式包含类型（这允许更精确的类型检查和错误报告）。使用接口定义结构类型，而不是类。

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

##### TYP.03 可空/undefined 类型别名 [Medium]

类型别名禁止在联合类型中包含 `|null` 或 `|undefined`；应在实际使用别名时添加。

##### TYP.04 优先可选参数/字段而非 `|undefined` [Medium]

使用可选字段（`?`）和参数而非 `|undefined` 类型；类尽可能在声明处初始化字段。

##### TYP.05 接口优于类型字面量别名 [Medium]

声明对象类型时使用接口而非对象字面量类型别名。

##### TYP.01 Type inference [Medium]

可依赖编译器推断；易推断的简单类型省略注解，复杂表达式可加注解帮助可读性。

##### TYP.02 Return types [Medium]

是否包含返回类型注解由作者决定，审查者可要求澄清复杂返回类型。

##### TYP.07 `Array<T>` 类型 [Medium]

简单类型用 `T[]` 语法糖，复杂类型（联合、对象元素等）用 `Array<T>`。

##### TYP.08 索引签名 [Medium]

索引签名为键提供有意义的标签；优先考虑 Map/Set。

##### TYP.09 `any` 类型 [Medium]

`any` 危险，优先更具体类型、`unknown` 或抑制警告并记录原因；测试中构造模拟对象可用 `any` 但需注释。

##### TYP.10 `{}` 类型 [Medium]

不要用 `{}` 表示任意非空值，优先 `unknown`、`Record<string, T>` 或 `object`。

### 模块、导入与导出

##### SFS.07 Import type / Export type [High]

**[Description]**

当仅将导入的符号用作类型时，可以使用 `import type {...}`。对值使用常规导入。重新导出类型时使用 `export type`。TypeScript 编译器开发模式转译需 `import type`；生产模式类型检查确保正确使用 `import type`。

**[Compliant]**

```ts
import type {Foo} from './foo';
import {Bar} from './foo';
import {type Foo, Bar} from './foo';
export type {AnInterface} from './foo';
```

##### SFS.03 Import paths [Medium]

同一项目内文件使用相对导入（`./foo`），限制父目录层级（`../../../`）数量。

##### SFS.05 命名导出 [Medium]

所有代码使用命名导出，禁止默认导出；命名导出在导入未声明内容时报错。

##### SFS.06 Export visibility [Medium]

只导出模块外部使用的符号，最小化导出 API 表面。

##### SFS.01 文件顺序 [Medium]

文件按版权信息、`@fileoverview` JSDoc、导入、实现顺序排列，各部分间用一个空行分隔。

##### SFS.02 `@fileoverview` JSDoc [Medium]

文件可有顶层 `@fileoverview` JSDoc 描述内容、用途或依赖，换行内容不缩进。

##### SFS.04 Namespace vs named imports [Medium]

频繁使用/名称清晰的符号用具名导入；使用大型 API 中许多符号时用命名空间导入。

##### SFS.08 使用模块而非命名空间 [Medium]

禁止 `namespace` 与 `import x = require(...)`，必须使用 ES6 `import`/`export`。

### 类与会话运行时（SessionState/SessionManager）

##### LF.06 类声明无分号 [Medium]

类声明禁止以分号结尾；类表达式语句必须以分号结尾。

##### LF.07 类方法声明无分号 [Medium]

类方法声明禁止用分号分隔，方法间用单个空行与周围代码分隔。

##### LF.08 构造函数括号 [Medium]

构造函数调用必须使用括号（`new Foo()`）；无参或仅委托父类的空构造器不必要，但含参数属性的构造器不应省略。

##### LF.09 No #private fields [Medium]

不要使用 `#private` 字段，使用 TypeScript 可见性注解（`private`/`protected`/`public`）。

##### LF.10 Use readonly [Medium]

用 `readonly` 标记构造函数外从不重新赋值的属性。

##### LF.11 Parameter properties [Medium]

用 parameter property（`constructor(private readonly x)`）而非显式成员初始化器；参数属性用 `@param` 文档化。

##### LF.12 Field initializers [Medium]

非参数类成员在声明处初始化，可省略构造函数；可选字段显式初始化为 `undefined` 防止 shape 变化。

##### LF.13 Getters and setters [Medium]

getter 必须是纯函数（结果一致、无副作用、禁止改变可观察状态）；至少一个访问器须非平凡。

##### LF.14 Visibility [Medium]

尽可能限制符号可见性；私有方法可转同文件非导出函数；默认 `public`，非必要不用 `public` 修饰符。

##### LF.33 Keep try blocks focused [Medium]

不损害可读性时限制 try 块内代码量，非抛出行移出 try/catch（循环内 try 可扩大覆盖整个循环）。

### 函数与依赖注入

##### LF.15 优先函数声明 [Medium]

定义命名函数用函数声明；箭头函数可在需显式类型注解时使用。

##### LF.16 禁止函数表达式 [Medium]

用箭头函数代替函数表达式（需动态重绑 `this` 或生成器除外）。

##### LF.17 Arrow function bodies [Medium]

返回值被使用时用简洁体，否则用块体；`void` 运算符确保表达式体箭头函数不泄漏返回值。

##### LF.18 优先箭头回调 [Medium]

避免传递命名回调给高阶函数（可选参数意外传递导致逻辑错误），用箭头函数显式转发参数。

##### LF.19 Arrow functions as properties [Medium]

类通常不应包含初始化为箭头函数的属性；应使用箭头函数调用实例方法，不获取/传递实例方法引用。

##### LF.20 Parameter initializers [Medium]

可选参数默认值禁止有可观察副作用，保持简单；可选参数多时优先解构 API。

##### LF.21 Prefer rest and spread [Medium]

用 rest 参数代替 `arguments`，用函数展开代替 `Function.prototype.apply`。

##### LF.35 this [Medium]

只在类构造函数/方法、显式声明 `this` 类型的函数或可用 `this` 的箭头函数中使用 `this`。

### 控制结构与异常

##### LF.01 Use const and let [Medium]

始终用 `const`（默认）或 `let`（需重新赋值）声明，禁止 `var`；变量禁止在声明前使用。

##### LF.02 One variable per declaration [Medium]

每个局部变量声明只声明一个变量。

##### LF.03 Object spread 匹配 [Medium]

创建对象时只展开对象，禁止展开数组和原始类型（含 `null`/`undefined`）及非 Object 原型对象。

##### LF.04 Iterating objects [Medium]

不用未过滤的 `for-in`；用 `hasOwnProperty` 过滤或 `for-of` + `Object.keys`/`values`/`entries`。

##### LF.05 Object destructuring [Medium]

函数参数解构保持简单（单层非引号简写属性），可选解构参数默认为 `{}`，默认值在左侧指定。

##### LF.25 控制流大括号 [Medium]

控制流语句总用大括号包裹；单行 `if` 语句可省略大括号。

##### LF.26 Iterating containers [Medium]

优先 `for-of` 遍历数组；`for-in` 仅用于字典样式对象。

##### LF.27 Switch statements [Medium]

`switch` 必须有 `default` 语句组（放最后）；非空语句组禁止 fall through，空语句组允许。

##### LF.28 Equality checks [Medium]

使用严格相等 `===`/`!==`；与 `null` 字面量比较可用 `==`/`!=` 同时覆盖 `null` 与 `undefined`。

##### LF.34 分号（无 ASI）[Medium]

不依赖自动分号插入，用分号显式结束所有语句。

### 字符串与类型转换

##### LF.22 String literals [Medium]

普通字符串用单引号；不用行延续；含单引号时考虑模板字符串。

##### LF.23 Template literals [Medium]

涉及多字符串时用模板字面量代替复杂字符串连接。

##### LF.24 Type coercion [Medium]

用 `String()`/`Boolean()`/`Number()` 或 `!!`；禁止一元加号、`parseInt`/`parseFloat`（非十进制除外）；枚举值必须用比较运算符显式比较；条件子句中不叠加显式布尔强制转换。

### 命名

##### NAM.01 ASCII 标识符 [Medium]

标识符只用 ASCII 字母、数字、下划线（常量与结构化测试名）及少量美元符号。

##### NAM.02 命名风格 [Medium]

名称不应装饰类型信息；不用下划线前后缀、`opt_` 前缀、`IMyInterface` 标记。

##### NAM.03 描述性名称 [Medium]

名称必须描述性、对新读者清晰；不熟缩写禁止；10 行内局部变量可用单字母。

##### NAM.04 Camel case [Medium]

缩写视为整词（`loadHttpUrl` 而非 `loadHTTPURL`）。

##### NAM.05 标识符大小写表 [Medium]

class/interface/type/enum 用 UpperCamelCase；变量/函数/参数/方法用 lowerCamelCase；全局常量用 CONSTANT_CASE。

##### NAM.06 Test names [Medium]

xUnit 测试方法名可用 `_` 分隔，如 `testX_whenY_doesZ()`。

##### NAM.07 Constants [Medium]

CONSTANT_CASE 表示值意图不改变；仅模块级符号、类静态字段、模块级枚举值可用。

### 注释与文档

##### COM.01 JSDoc versus comments [Medium]

用 `/** JSDoc */` 文档化（用户阅读），`//` 做实现注释。

##### COM.02 Multi-line comments [Medium]

多行注释用多个 `//` 单行注释而非 `/* */` 块注释，不用星号盒子。

##### COM.03 JSDoc general form [Medium]

JSDoc 必须格式良好；单行溢出到多行时 `/** */` 单独成行。

##### COM.04 Markdown [Medium]

JSDoc 用 Markdown 编写，列表用 Markdown 列表语法（否则解析为一行）。

##### COM.05 JSDoc tags [Medium]

大多数标签必须占据自己的行，标签在行首。

##### COM.06 Document all top-level exports [Medium]

用 `/** JSDoc */` 文档化模块所有顶层导出；属性/方法用途不明显时也应文档化。

##### COM.07 Class comments [Medium]

类 JSDoc 提供足够信息了解如何使用类及额外考虑。

##### COM.08 Method/function comments [Medium]

方法描述以第三人称动词短语开头；名称类型显而易见时可省略。

##### COM.09 Parameter property comments [Medium]

参数属性用 `@param` JSDoc 标签文档化。

##### COM.10 JSDoc type annotations [Medium]

JSDoc 类型注解在 TS 中冗余，禁止在 `@param`/`@return` 中声明类型。

##### COM.11 Comments that add information [Medium]

注释须提供实际信息，避免重复名称类型；`@param`/`@return` 仅在添加信息时。

##### COM.12 Comments when calling a function [Medium]

参数名注释放在参数值之前，含参数名和 `=` 后缀（如 `/* shouldRender= */`）。

### 工具链与测试

##### TC.01 TypeScript compiler [Medium]

所有 TS 文件必须使用标准工具链通过类型检查。

##### TC.02 `@ts-ignore` [Medium]

不使用 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`；测试中 `@ts-expect-error` 可谨慎使用但通常不应，改用强制转换 + 说明性注释。

### 源文件基础与核心风格

##### SFB.01 UTF-8 [Medium]

源文件 UTF-8 编码，除换行符外仅允许 ASCII 空格 (0x20)。

##### SFB.02 非 ASCII 字符 [Medium]

非 ASCII 字符用实际 Unicode（中文注释直接书写）；不可打印字符用转义 + 说明性注释。

##### STYLE.01 单引号 [Medium]

使用单引号（`'`）。

##### STYLE.02 显式分号 [Medium]

显式使用分号。

##### STYLE.03 禁止 console.log [Medium]

禁止 `console.log`，通过 logger 输出日志。

##### STYLE.04 2 空格缩进 [Medium]

TS 缩进必须采用 2 个空格。

##### STYLE.05 文件头 JSDoc [Medium]

文件头部用 `@author`/`@copyright` JSDoc 声明。

##### STYLE.06 关键符号 JSDoc [Medium]

类、main、export 方法、重要方法必须有 JSDoc；常量用行前 `//` 注释。

##### STYLE.07 文件行数 [Medium]

组件/类文件 200-300 行、普通业务 300-500 行、工具 100-200 行、大型模块 ≤800 行。

##### STYLE.08 ES 模块 + 命名空间导入 [Medium]

推荐 Node.js ES 模块；第三方库/多导出模块用命名空间导入。

### 策略

##### POL.01 Consistency [High]

**[Description]**

对于本规范未明确解决的所有风格问题，请执行与同一文件中已有代码相同的操作（"保持一致"）。如果这不能解决问题，考虑模拟同一目录中的其他文件。新文件**必须**使用 Google 风格，无论同一包中其他文件的风格选择如何。向不是 Google 风格的文件添加新代码时，建议先重新格式化现有代码。如果不进行此重新格式化，新代码**应该**尽可能与同一文件中的现有代码保持一致，但**禁止**违反风格指南。

##### POL.02 Reformatting existing code [Medium]

不需要更改所有现有代码；重大更改的文件应符合 Google 风格；避免机会主义风格修复混淆变更焦点。

##### POL.03 Deprecation [Medium]

用 `@deprecated` JSDoc 标记弃用的方法/类/接口，并提供清晰的修复指导。

## 3. Security & production notes

- **模板字面量 ID 断言**（LF.29/LF.30）：扩展 MessageID/PartID/EventID 模板字面量类型时，`msg_${crypto.randomUUID()} as MessageID` 等断言必须保留 "why safe" 注释（前缀由拼接保证），且**必须**使用 `as` 语法；新增 parts 类型联合分支时以 `: Part` 注解构造对象（LF.32）以捕获字段改名/漏配。
- **结构子集 QueryLike**（TYP.06）：QueryLike 必须保持"最小结构子集"——只列当前消费的 SDK Query 成员，新运行时方法（如 `setPermissionMode`）作为**可选成员**加入，避免破坏 FakeQuery 等测试实现与向后兼容。
- **import type 隔离**（SFS.07）：新增类型（如 Part 联合、DI 函数类型）在 session.ts/session-state.ts/client.ts 中一律 `import type`，值导入（如 SDK query/deleteSession 函数）用常规导入，确保 ESM 转译/类型擦除正确。
- **一致性护栏**（POL.01）：新增 SessionManager/SessionState 方法须沿用现有依赖注入（`options.xxxFn ?? sdkFn`）与 ReplayChannel/control event 模式，不要引入新架构范式。
