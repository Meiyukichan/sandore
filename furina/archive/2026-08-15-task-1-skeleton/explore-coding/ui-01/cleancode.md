# CleanCode 探索结果：sandore ui 包 Client 插件（TypeScript）

> 探索类型：cleancode（coding standards）
> 目标语言：TypeScript（clean-ts）
> 输出语言：chinese
> 输出文件：`D:\project-code\llm\sandore\furina\changes\task-1-skeleton\explore-coding\ui-01\cleancode.md`

## 1. 需求理解（Phase 1）

### What
为 sandore 工作流引擎 DSH 插件实现最小 Client UI 入口——`@deepseek-ai/dsh-client-ui-sandore` 包的 Client 半：`sidebar.footer.action` 工作流按钮 + 点击展开 WorkflowPanel 占位 + `host.call('sandore.ping')` JSON 往返 + Client 包 `package.json` 声明（`exports["./client"]` + `dsh.client`）。

### Boundaries
仅覆盖 Client 端骨架（footer 按钮/展开面板 slot 注册、panel 开关 client 状态、client 包声明、host.call RPC、ui-primitives 公开扩展点）。不涉及真实引擎执行逻辑、microflow/tool 包、`conversation.chat.node` 讨论节点（Task 5）。

### Goal
为 sandore ui 包的最小 Client 插件实现提供准确的 DSH 参考实现范式与 TypeScript 编码规范，确保 `pnpm run typecheck` 可通过且与 DSH slot/RPC 生态对齐。

### 主语言判定
项目 `D:\project-code\llm\sandore` 中 `*.ts`/`*.tsx` 文件 > 0，`*.py` 文件 = 0 → **主语言 TypeScript → clean-ts**。

## 2. 编码规范（Phase 3：furina-cleancode 输出）

### Scope

- **Requirement summary**：实现 `@deepseek-ai/dsh-client-ui-sandore` 最小 Client 插件——sidebar.footer.action 按钮 + 点击展开 WorkflowPanel 占位 + `host.call('sandore.ping')` JSON 往返 + Client 包 `package.json` 声明。
- **Code features affected**：ESM 模块导出与 import/export type、Cordis 插件类与 `@Remote` 框架装饰器、SlotMap `declare module` 声明合并、RPC JSON 类型安全（断言/`any`→`unknown`）、React 组件、接口/可选字段类型声明、命名、JSDoc、类型检查合规。

### Guidelines

#### 模块组织与导出（ESM / package.json）

##### SFS.05 命名导出，禁止默认导出 [Required]

**[Description]** 所有代码中使用命名导出。不要使用默认导出。这确保所有导入遵循统一的模式。默认导出没有规范名称，这使得集中维护变得困难，而对代码所有者几乎没有好处，包括可能降低可读性。命名导出有一个好处：当导入语句尝试导入未声明的内容时会报错。

**[Compliant]**

```ts
// Use named exports:
export class Foo { ... }
```

##### SFS.09 `import type` / `export type` [Required]

**[Description]** 当仅将导入的符号用作类型时，可以使用 `import type {...}`。对值使用常规导入。重新导出类型时使用 `export type`，例如 `export type {AnInterface} from './foo';`。`export type` 对于文件转译中的类型重新导出很有用，也有助于避免为 API 导出值符号。

**[Compliant]**

```ts
import type {Foo} from './foo';
import {Bar} from './foo';

import {type Foo, Bar} from './foo';

export type {AnInterface} from './foo';
```

##### SFS.10 使用模块而非命名空间 [Required]

**[Description]** TypeScript 支持两种组织代码的方法：**命名空间**和**模块**，但命名空间是禁止的。也就是说，代码**必须**使用 `import {foo} from 'bar';` 形式的导入和导出引用其他文件中的代码。代码**禁止**使用 `namespace Foo { ... }` 结构。命名空间**只能**在与外部第三方代码接口时使用。要在语义上命名空间化代码，请使用单独的文件。代码**禁止**使用 `require`（如 `import x = require('...');`）进行导入。使用 ES6 模块语法。

**[Compliant]**

```ts
export const SOME_CONSTANT = ...
export function someHelpfulFunction()
export class Foo {
  // only class stuff here
}
```

> 注：SlotMap 的 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { ... } }` 是**模块增强（ambient module augmentation）**，属于「与外部第三方代码接口」的合法例外，不是被禁止的 `namespace` 关键字。详见 Section 3。

##### CORE 核心风格（ES 模块 / 命名空间导入 / 单引号 / 分号 / 缩进）[Required]

**[Description]** 推荐使用 Node.js ES 模块；对于第三方库或有多个导出的模块，使用命名空间导入；使用单引号（'）；显式使用分号；TypeScript 的缩进风格必须采用 2 个空格缩进。

**[Compliant]**

```ts
import * as ng from '@angular/core';
import {Foo} from './foo';
```

#### RPC 调用与 JSON 类型安全（host.call）

##### LF.34 类型断言与非空断言 [Required]

**[Description]** 类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。有时由于代码的某些局部属性，你可以确定断言形式是安全的，在那些情况下，你应该添加说明来解释为什么你可以接受不安全的行为。类型断言**必须**使用 `as` 语法（而不是尖括号语法）。这会在访问成员时强制在断言周围添加括号。

**[Compliant]**

```ts
// assuming Foo is a class.
if (x instanceof Foo) {
  x.foo();
}

if (y) {
  y.bar();
}

// z must be Foo because ...
const x = (z as Foo).length;
```

##### TS.09 `any` 类型 → 使用 `unknown` [Required]

**[Description]** TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型、使用 `unknown`、抑制 lint 警告并记录原因。`any` 类型允许赋值到任何其他类型并取消引用其上的任何属性，通常这种行为不是必要或期望的；代码只需要表达类型是未知的，此时使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。要安全地使用 `unknown` 值，使用类型守卫缩小类型。

**[Compliant]**

```ts
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

#### 装饰器（@Remote）

##### LF.35 装饰器（只用框架定义的装饰器）[Required]

**[Description]** 不要定义新的装饰器。只使用框架定义的装饰器（如 Angular 的 `@Component`、Polymer 的 `@property`）。使用装饰器时，装饰器**必须**紧跟在其装饰的符号前面，两者之间没有空行。

**[Compliant]**

```ts
/** JSDoc comments go before decorators */
@Component({...})  // Note: no empty line after the decorator.
class MyComp {
  @Input() myField: string;  // Decorators on fields may be on the same line...
}
```

> `@Remote`（来自 dsh-typert-protocol）属于「框架定义的装饰器」，可直接使用。

#### 工具链合规（typecheck）

##### TC.01 TypeScript 编译器 [Required]

**[Description]** 所有 TypeScript 文件必须使用标准工具链通过类型检查。

##### TC.02 禁止 @ts-ignore / @ts-expect-error / @ts-nocheck [Required]

**[Description]** 不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。它们表面上似乎是"修复"编译器错误的简单方法，但实际上，特定的编译器错误通常是由更大的问题引起的，可以更直接地修复。

#### 类与函数（Cordis 插件 / React 组件）

- **LF.01 const/let，禁 var [Required]**：始终用 `const`/`let`，默认 `const`，禁止 `var`（函数作用域易出 bug），变量禁止声明前使用。
- **LF.02 每声明一个变量 [Required]**：每行只声明一个变量。
- **LF.06/07 类声明与方法禁止多余分号 [Required]**：类声明禁止以分号结尾，类方法间禁止用分号分隔。
- **LF.09 构造函数必须用括号 [Required]**：`new Foo()` 而非 `new Foo`。
- **LF.10 禁 #private 字段 [Required]**：用 TypeScript 可见性注解（`private`）替代 `#` 私有标识符。
- **LF.11 readonly [Required]**：构造函数外从不重新赋值的属性用 `readonly`。
- **LF.12 parameter properties [Required]**：构造器注入用参数属性（如 `constructor(private readonly barService: BarService) {}`）。
- **LF.13 field initializers [Required]**：非参数成员在声明处初始化。
- **LF.14 类词法作用域外使用的属性禁止 private [Required]**：React 组件在模板/渲染中用到的属性应使用 `protected`/`public` 而非 `private`；禁止用 `obj['foo']` 绕过可见性。
- **LF.15 getter 必须纯函数 [Required]**：getter 结果一致且无副作用，禁止改变可观察状态。
- **LF.16 限制可见性 [Required]**：尽量缩小符号可见性，非只读 public 参数属性外不使用 `public` 修饰符。
- **LF.17 命名函数优先函数声明 [Required]**：定义命名函数优先 `function foo() {}` 而非 `const foo = () => {}`。
- **LF.18 不用函数表达式 [Required]**：用箭头函数替代 `function() {...}`（生成器或需动态重绑定 this 时除外）。
- **LF.19 箭头函数体 [Required]**：返回值被使用时用简洁体，否则用块体（块体保证返回 `void` 并防止副作用泄漏）。
- **LF.20/21 回调与 this [Required]**：回调优先传箭头函数，箭头函数显式转发参数（避免 `map(parseInt)` 这类隐式参数 bug）。
- **LF.23 事件处理器 [Required]**：无需卸载时可用匿名箭头函数；需卸载时用箭头函数属性（稳定引用）；禁止在安装处 `bind`。
- **LF.28 类型转换 [Required]**：可用 `String()`/`Boolean()`（无 `new`）/`!!` 或模板字符串；解析数值必须用 `Number()` 并显式检查 `NaN`；禁止一元加号 `+y`、禁止 `parseInt`/`parseFloat`（radix≠10 且先校验输入除外）。
- **LF.29 控制结构大括号 [Required]**：`if`/`for`/`while` 等必须用大括号（可放单行的 `if` 语句例外）；控制语句内赋值需加双层括号表明意图。
- **LF.31 异常 [Required]**：实例化异常用 `new Error()`（非 `Error()`），只抛 `Error` 及其子类；Promise reject 也必须是 `Error`。
- **LF.33 严格相等 [Required]**：用 `===`/`!==`；仅与字面量 `null` 比较时可用 `==`/`!=`（同时覆盖 null/undefined）。
- **LF.37 禁 const enum [Required]**：用普通 `enum`。
- **LF.40 / CORE.05 显式分号 [Required]**：不依赖 ASI，用分号显式结束所有语句。

#### 类型声明（PropsRuntime / SlotMap / 接口）

- **TS.01 类型推断 [Recommended]**：简单类型（string/number/boolean/new 表达式）可省略注解；复杂表达式加注解提高可读性。
- **TS.02 返回类型 [Recommended]**：是否加返回类型注解由作者决定，审查者可要求复杂类型显式注解。
- **TS.03 undefined/null [Required]**：类型别名禁止内嵌 `|null`/`|undefined`，应在实际使用时添加；优先用可选字段/可选参数（`milk?`）而非 `|undefined`。
- **TS.04 结构类型 [Required]**：在符号声明处显式包含类型以获得更精确的类型检查与错误报告。
- **TS.05 接口优于类型别名 [Required]**：声明对象类型时用 `interface` 而非对象字面量类型别名（SlotMap 增强必须是 `interface` 才能声明合并）。
- **TS.06 Array 语法糖 [Required]**：简单类型用 `T[]`/`readonly T[]`，复杂类型用 `Array<T>`。
- **TS.07 索引签名 [Recommended]**：对象作关联数组用 `{[key: string]: T}` 并给键起有意义标签，考虑用 `Map`/`Set`/`Record`。
- **TS.08 映射/条件类型 [Recommended]**：始终用能表达代码的最简单类型构造，一点重复/冗长通常比复杂类型表达式成本低。
- **TS.10 空类型 {} [Required]**：优先 `unknown`、`Record<string, T>` 或 `object`，而非 `{}`。

#### 命名

- **NAM.01 标识符 [Required]**：只用 ASCII 字母/数字/下划线（常量）及（少用）`$`。
- **NAM.02 命名风格 [Required]**：类型信息不入名；禁下划线前后缀、`opt_` 前缀；不特别标记接口（无 `IMyInterface`）；Observable 用 `$` 后缀是常见约定。
- **NAM.03 描述性名称 [Required]**：不用模糊缩写、不删除单词内字母；≤10 行局部作用域可用短名/单字母。
- **NAM.04 camel case [Required]**：缩写按整词处理（`loadHttpUrl` 而非 `loadHTTPURL`）。
- **NAM.05/07 大小写 [Required]**：class/interface/type/enum/decorator/类型参数/TSX 组件用 `UpperCamelCase`；variable/parameter/function/method/property/module alias 用 `lowerCamelCase`；模块级全局常量与 enum 值用 `CONSTANT_CASE`。
- **NAM.08 导入命名空间 [Required]**：模块命名空间导入用 `lowerCamelCase`（如 `import * as fooBar from './foo_bar'`）。

#### 注释与文档（JSDoc）

- **CD.01 JSDoc vs 普通注释 [Required]**：文档化用 `/** JSDoc */`，实现注释用 `//`；多行注释必须用多个 `//` 而非 `/* */`，且不用星号画框。
- **CD.02/03 JSDoc 格式与标签 [Required]**：JSDoc 必须格式良好、用 Markdown（列表用 Markdown 列表语法）；`@param` 等标签必须独占一行。
- **CD.04 顶层导出文档化 [Required]**：模块所有顶层导出必须文档化；工具消费的符号（如框架注册类）可例外。
- **CD.06 JSDoc 类型注解冗余 [Required]**：`@param`/`@return` 中禁止重复声明 TypeScript 已有的类型。
- **CD.07 注释加实际信息 [Required]**：避免只重复参数名/类型；`@param`/`@return` 仅在添加信息时使用；调用处可用 `/* name= */` 参数名注释。
- **CD.08 文档放在装饰器之前 [Required]**：JSDoc 写在 `@Component`/`@Remote` 等装饰器之前。

#### 一致性

- **POL.01 一致性 [Required]**：规范未覆盖的风格问题与同文件/同目录现有代码一致；新文件必须用 Google 风格。

### Security & production notes

- **SFS.10 / SlotMap 声明合并**：`declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { ... } }` 属于「与外部第三方代码接口」的模块增强，合法且是 DSH slot 注册的标准范式；务必用 `interface`（可声明合并）而非 `type`，且不要写 `namespace`。
- **LF.34 / host.call JSON 往返**：`host.call('sandore.ping')` 返回的是运行时不可校验的 JSON，禁止直接用 `as SomeType` 或 `!` 断言；应先用运行时检查/类型守卫收窄，或用 `unknown` 逐字段校验后再安全收窄。
- **TS.09 / RPC 载荷**：RPC 响应载荷类型应声明为接口（如 `declare interface MyUserJson {...}`）或经类型守卫收窄，避免 `any` 直接取消引用导致未捕获的运行时错误。
- **LF.35 / @Remote**：只允许使用框架（typert/protocol）提供的 `@Remote` 装饰器，禁止自定义装饰器；装饰器必须紧跟被装饰符号、中间无空行。
- **TC.01/TC.02 / typecheck**：任何 typecheck 失败都不得用 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck` 压制；应修正类型来源（如 SlotMap 增强、接口显式类型、`import type`）。

### 参考文件（绝对路径）

- 指令：`D:/project-code/llm/furina/marketplace/skills/furina-cleancode/instructions/clean-ts.md`
- 标准目录：`D:/project-code/llm/furina/marketplace/skills/furina-cleancode/references/ts/`（含 `toc.md`、`typescript-core-style.md`、`source-file-structure.md`、`language-features.md`、`type-system.md`、`toolchain-requirements.md`、`naming.md`、`comments-and-documentation.md`、`policies.md`）
