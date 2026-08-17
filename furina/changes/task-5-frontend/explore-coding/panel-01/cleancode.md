# Furina CleanCode Exploration Result

## Explore Content

重写 sandore `ui` 包（DSH client 插件 `@deepseek-ai/dsh-client-ui-sandore`）的 `WorkflowPanel` 并新增 `InstanceList`/`DefinitionList`：

- footer 入口（`sidebar.footer.action` 槽位按钮 `WorkflowButton`）点击展开面板；
- 面板内部维护两级下钻 view 状态栈（`list` ↔ `editor`/DagEditor ↔ `run`/RunView），下钻态以宽展开 layer 渲染（`wide ? css.layer : css.rail`）；
- 列表呈现三态（loading/empty/error）；
- 默认态实例列表按工作区分组渲染。

## Explore Type

cleancode

## Exploration Result

### 1. Scope

- **Requirement summary**: 重写 sandore UI 客户端插件 WorkflowPanel，新增 InstanceList/DefinitionList 与 view-stack reducer：footer 槽位按钮展开面板，面板内维护两级下钻 view 状态栈（list ↔ editor ↔ run），列表三态（loading/empty/error），默认实例列表按工作区分组。
- **Code features affected**: React 函数组件 + strict TS（判别联合状态、readonly、穷尽 switch、satisfies/as const）、CSS Modules、无 React 依赖纯 model 模块 + vitest、cordis 插件范式（apply/ctx.effect/slots.inject）、RPC RemoteResult<T> + unwrap 异常、locale 字典（satisfies Record + declare module）、hooks 轮询（disposed ref + cleanup）、按工作区分组。

### 2. Guidelines

#### 模块与导出

##### SFS-01 命名导出，禁止默认导出 [Required]
所有代码使用命名导出，禁止默认导出，保证导入统一性与重构安全。

##### SFS-02 导出可见性最小化 [Recommended]
只导出模块外部使用的符号，最小化模块导出 API 表面。

##### SFS-03 禁止 export let，可变绑定用 getter [Required]
禁止 `export let`；需要外部可变绑定时用显式 getter 函数。

##### SFS-04 禁止 namespace/require，用 ES6 import [Required]
禁止 `namespace Foo {}` 与 `import x = require()`，必须用 ES6 import/export 组织代码。

##### SFS-05 import type / export type [Recommended]
仅作类型使用的导入用 `import type`；类型重导出用 `export type`。

##### SFS-06 相对导入优先 [Recommended]
同项目内应优先相对导入（`./foo`），限制 `../../../` 层级。

##### SFS-07 具名 vs 命名空间导入 [Recommended]
频繁/清晰的符号用具名导入；使用大型 API 多符号时用命名空间导入。

##### CORE-01 单引号 + 显式分号 [Required]
字符串用单引号，所有语句显式以分号结尾（不依赖 ASI）。

##### CORE-02 2 空格缩进 [Required]
TypeScript 采用 2 空格缩进。

##### CORE-03 禁止 console.log [Required]
禁止 `console.log`，通过 logger 输出日志。

#### 变量与类型声明

##### LF-01 const/let，禁止 var [Required]
始终用 `const`/`let` 声明变量，默认 `const`，禁止 `var`；变量禁止在声明前使用。

##### LF-02 每行一个变量声明 [Required]
每个局部变量声明只声明一个变量。

##### TS-01 类型推断 [Recommended]
简单类型（string/number/boolean 字面量、`new` 表达式）可省略注解；复杂表达式加注解提高可读性。

##### TS-02 返回类型注解 [Recommended]
是否加返回类型由作者决定；复杂返回类型可加注解以澄清。

##### TS-06 结构类型在声明处显式标注 [Recommended]
结构实现应在符号声明处显式标注类型，以获得更精确的类型检查与错误报告。

##### LF-53 用类型注解而非断言标注对象字面量 [Required]

使用类型注解（`: Foo`）而不是类型断言（`as Foo`）来指定对象字面量的类型。这允许在接口字段随时间变化时检测重构错误。

```ts
interface Foo {
  bar: number;
  baz?: string;
}

const foo: Foo = {
  bar: 123,
  bam: 'abc',  // complains about "bam" not being defined on Foo.
};
```

##### LF-50 类型断言用 as 语法 [Required]
类型断言必须用 `as` 语法（`(z as Foo).length`），禁止尖括号语法。

##### LF-51 非空断言 ! 避免或加说明 [Recommended]
非空断言（`y!`）不安全，应优先运行时检查；确需使用应加注释说明原因。

#### 类型系统（判别联合 / 接口 / any）

##### TS-11 禁止 any [Required]

TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型；使用 `unknown`；抑制 lint 警告并记录原因。

```ts
// Use declared interfaces to represent server-side JSON.
declare interface MyUserJson {
  name: string;
  email: string
}

const val: unknown = value;  // unknown 更安全，禁止任意属性解引用
```

##### TS-04 类型别名禁止含 |null/|undefined [Required]
类型别名禁止在联合中包含 `|null` 或 `|undefined`，应仅在实际使用时添加，并在值出现处附近处理空值。

##### TS-05 可选优于 |undefined [Required]
可选字段/参数（`?`）优于显式 `|undefined`。

##### TS-07 接口优于类型字面量别名（对象类型）[Required]
对象类型声明用 `interface` 而非 `type` 别名；判别联合等非对象类型用 `type` 别名。

##### TS-08 Array<T> 语法糖 [Required]
简单类型用 `T[]`/`readonly T[]`，复杂类型用 `Array<T>`。

##### TS-10 映射/条件类型用最简构造 [Recommended]
始终使用能表达代码的最简类型构造；一点重复优于复杂类型表达式。

##### TS-12 空类型 {} 避免 [Required]
避免 `{}` 空接口类型，优先 `unknown` / `Record<string, T>` / `object`。

#### 函数与箭头函数

##### LF-20 命名函数优先函数声明 [Recommended]
命名函数优先用 `function` 声明而非箭头函数/函数表达式。

##### LF-21 不用函数表达式，用箭头函数 [Required]
回调用箭头函数代替 `function` 表达式（除非需动态重绑定 this）。

##### LF-22 箭头函数体 [Recommended]
仅当返回值被使用时才用简洁体；否则用块体，或用 `void` 运算符确保无返回值泄漏。

##### LF-24 优先传箭头函数作回调 [Recommended]
避免传命名回调给高阶函数（除非签名稳定），优先传显式转发参数的箭头函数。

##### LF-23 禁止不必要的 this [Required]
仅在类构造函数/方法、显式声明 this 类型的函数或箭头函数中使用 this。

##### LF-27 参数初始化器无副作用 [Recommended]
默认参数初始化器禁止可观察副作用，尽量简单。

#### 类与只读性

##### LF-15 使用 readonly [Recommended]
构造函数外从不重新赋值的属性用 `readonly` 修饰符标记（不必深度不可变）。

##### LF-14 禁止 #private 字段 [Required]
不用 `#private`，用 TS 可见性注解（private/public/protected）。

##### LF-19 可见性最小化 [Recommended]
尽可能限制符号可见性；除非只读 public 参数属性外不使用 public 修饰符。

#### 控制结构与判别联合穷尽

##### LF-47 switch 必须含 default [Required]

所有 `switch` 语句**必须**包含一个 `default` 语句组，即使它不包含代码。`default` 语句组必须放在最后。

```ts
switch (x) {
  case Y:
    doSomethingElse();
    break;
  default:
    // nothing to do.
}
```

##### LF-48 switch 禁止 fall through [Required]

在 switch 块中，每个语句组要么通过 `break`、`return` 语句或抛出异常突然终止。非空语句组（`case ...`）**禁止** fall through（由编译器强制）：空的语句组允许 fall through：

```ts
switch (x) {
  case X:
  case Y:
    doSomething();
    break;
  default: // nothing to do.
}
```

##### LF-39 控制流语句大括号 [Required]
控制流语句（if/else/for/while）总是用大括号；单行 if 可省略。

##### LF-49 严格相等 ===/!== [Required]
始终用 `===`/`!==`；与字面量 `null` 比较可用 `==`/`!=` 同时覆盖 null/undefined。

##### LF-41 遍历容器用 for-of [Recommended]
数组遍历优先 `for (...of arr)`；`for-in` 仅用于字典对象并需 hasOwnProperty 过滤。

#### 异常处理

##### LF-43 用 new 实例化异常 [Required]

实例化异常时始终使用 `new Error()`，而不仅仅是调用 `Error()`。两种形式都创建一个新的 `Error` 实例，但使用 `new` 与其他对象的实例化方式更一致。

```ts
throw new Error('Foo is not a valid bar.');
```

##### LF-44 只抛出 Error 及其子类 [Required]

JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。相反，只抛出（的子类）`Error`：

```ts
// Throw only Errors
throw new Error('oh noes!');
// ... or subtypes of Error.
class MyError extends Error {}
throw new MyError('my oh noes!');
```

##### LF-45 捕获时假定 Error [Recommended]
捕获错误时应假定抛出的都是 `Error` 实例；用 `unknown` 接收并窄化（assertIsError），避免防御性处理非 Error 类型。

##### LF-46 空 catch 块需注释 [Required]

很少有情况下在响应捕获的异常时什么都不做是正确。当确实适合在 catch 块中完全不采取行动时，应在注释中解释这是正当的理由。

```ts
  try {
    return handleNumericResponse(response);
  } catch (e: unknown) {
    // Response is not numeric. Continue to handle as text.
  }
  return handleTextResponse(response);
```

##### LF-54 try 块保持精简 [Recommended]
限制 try 块内代码量，将非抛出行移出 try/catch。

#### 命名

##### NAM-03 命名风格约束 [Required]
类型信息不进名称；禁止 `_` 前缀/后缀、`opt_` 前缀；不特别标记接口（无 `IMyInterface`）。

##### NAM-04 描述性名称 [Required]
名称必须描述性、清晰；不用不熟悉缩写；≤10 行局部作用域可用单字母。

##### NAM-05 camel case 缩写整词 [Required]
缩写按整词处理：`loadHttpUrl` 而非 `loadHTTPURL`。

##### NAM-06 大小写类别 [Required]
UpperCamelCase：class/interface/type/enum/类型参数/TSX 组件函数；lowerCamelCase：变量/参数/函数/方法/属性/模块别名；CONSTANT_CASE：模块级常量、enum 值、static readonly。

##### NAM-10 常量 CONSTANT_CASE [Required]
模块级常量、模块级类静态字段、模块级 enum 值用 CONSTANT_CASE；函数内局部常量用 lowerCamelCase。

#### 注释与文档

##### CD-01 JSDoc vs 普通注释 [Recommended]
文档化用 `/** JSDoc */`，实现注释用 `//`。

##### CD-02 多行注释用 // [Required]
多行注释用多个 `//` 单行注释，禁止 `/* */` 块注释。

##### CD-07 文档化顶层导出 [Required]
模块所有顶层导出应文档化；方法描述以第三人称动词短语开头。

##### CD-11 JSDoc 类型注解冗余 [Required]
JSDoc 中禁止重复声明类型（@param/@return 不写类型）。

##### CD-12 注释提供实际信息 [Required]
注释避免仅重复参数名/类型；@param/@return 仅在添加信息时需要。

##### CORE-06 文件头 JSDoc [Recommended]
文件头部用 JSDoc 声明（@fileoverview/@author/@copyright）；类/export 方法需 JSDoc，常量用 `//` 注释。

##### CORE-08 文件行数 [Recommended]
组件/类文件 200-300 行；工具/配置 100-200 行；大型模块 ≤800 行。

#### 工具链与一致性

##### TC-02 禁止 @ts-ignore/@ts-expect-error/@ts-nocheck [Required]
禁止这些指令；单测中 `@ts-expect-error` 也应谨慎。

##### TC-01 类型检查通过 [Required]
所有 TS 文件必须通过标准工具链类型检查。

##### POL-01 一致性 [Required]
规范未明示的风格问题与同文件/目录现有代码保持一致；新文件用 Google 风格。

### 3. Security & production notes

- **RemoteResult.unwrap 与 SandoreRemoteError**：`ok:false` 抛出的 SandoreRemoteError 必须 `extends Error`（LF-44）并用 `new` 实例化（LF-43）；组件/轮询捕获错误不得静默吞掉——空 catch 需说明理由（LF-46），否则向上抛给状态机（`{kind:'error';message}`）。
- **view-stack reducer 穷尽 switch**：所有 switch 必须带 default 分支（LF-47），非空 case 不得 fall through（LF-48），default 处理未知 view kind（返回当前态或抛错）。
- **轮询（3s 实例列表 / 5s RunView）**：useEffect 内定时器必须返回 cleanup 停止，配合 disposed ref 防止卸载后 setState；避免用 bind 注册无法卸载的监听。
- **locale 字典与 wire 类型**：用类型注解/`satisfies`（LF-53）而非 `as` 断言以在字段变化时捕获错误；避免 any（TS-11），RPC 数据用具体 wire 类型或 `unknown` 窄化。
