# Sandore DagEditor 与 workflow 浏览器安全拆分 — TypeScript 编码规范

> 依据 Google TypeScript 风格指南（furina-cleancode/references/ts）生成，按相关性分层输出。

### 1. Scope

- **Requirement summary**: 新增 sandore `ui` 包 DagEditor 组件（Stage DAG 简化可视化 + Step 编辑 + YAML 预览/保存），并将 `workflow` 包定义层 zod schema 与 YAML 解析/序列化拆分为浏览器安全模块导出。
- **Code features affected**: React 18 函数组件与 hooks（.tsx）、zod v4 discriminatedUnion schema 与 `z.infer` 派生类型、ESM 子路径导出与浏览器安全模块边界、YAML 解析/序列化与外部输入校验、类型化错误（SandoreError/SandoreRemoteError）、CSS Modules 与 locale 字典。

### 2. Guidelines

#### 浏览器安全模块边界（workflow 包拆分）

##### SFS.12 Import type [Recommended]

**Description**: 当仅将导入的符号用作类型时，可以使用 `import type {...}`。对值使用常规导入。

**为什么？** TypeScript 编译器自动处理区别，不插入类型引用的运行时加载。那么为什么要注释类型导入呢？TypeScript 编译器可以以两种模式运行：

- 在开发模式下，我们通常希望快速迭代循环。编译器转译为 JavaScript 而无需完整类型信息。这更快，但在某些情况下需要 `import type`。
- 在生产模式下，我们希望正确性。编译器类型检查一切并确保正确使用 `import type`。

注意：如果需要强制加载副作用，请使用 `import '...';`。

**Compliant**:

```ts
import type {Foo} from './foo';
import {Bar} from './foo';

import {type Foo, Bar} from './foo';
```

##### SFS.13 Export type [Recommended]

**Description**: 重新导出类型时使用 `export type`。`export type` 对于文件转译中的类型重新导出很有用。`export type` 也可能有助于避免为 API 导出值符号。然而它不能提供保证：下游代码可能通过不同路径导入 API。分割和保证 API 类型与值用法的好方法是实际将符号拆分为例如 `UserService` 和 `AjaxUserService`。这更不容易出错，也更好地传达意图。

**Compliant**:

```ts
export type {AnInterface} from './foo';
```

#### 外部数据校验（YAML 解析 / 预览保存）

##### TS.12 使用 unknown 而非 any [Recommended]

**Description**: `any` 类型允许赋值到任何其他类型并取消引用其上的任何属性。通常这种行为不是必要或期望的，代码只需要表达类型是未知的。在那种情况下使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。要安全地使用 `unknown` 值，使用类型守卫缩小类型。

**Compliant**:

```ts
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

#### 类型化错误与异常处理

##### LF.48 只抛出 Error [Required]

**Description**: JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。相反，只抛出（的子类）`Error`。

**Compliant**:

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

##### LF.49 捕获与重抛 [Recommended]

**Description**: 捕获错误时，代码应该假设所有抛出的错误都是 `Error` 的实例。除非被调用的 API 确定知道会抛出非 `Error` 来违反上述规则，否则异常处理程序禁止防御性地处理非 `Error` 类型。在这种情况下，应包含注释以特别识别非 `Error` 的来源。

**为什么？** 避免过度防御性编程。对一个在大多数代码中不存在的问题重复相同的防御措施会导致无用的样板代码。

**Compliant**:

```ts
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

#### 命名

##### NAM.02 命名风格 [Required]

标识符不应携带类型信息；禁止下划线前缀/后缀与 `opt_` 前缀；不特别标记接口；`Observable` 用 `$` 后缀是常见约定。

##### NAM.03 描述性名称 [Required]

名称必须具有描述性，不使用含义模糊的缩写、不删词内部字母缩写；10 行以内局部作用域可用单字母变量。

##### NAM.04 Camel case [Required]

缩写视为整词，如 `loadHttpUrl` 而非 `loadHTTPURL`。

##### NAM.10 常量 [Required]

`CONSTANT_CASE` 表示值不应被修改；只有模块级别常量、静态只读字段与枚举值可用 `CONST_CASE`，函数内局部常量用 `lowerCamelCase`。

#### 模块与导出

##### SFS.08 命名导出（禁止默认导出）[Required]

所有代码使用命名导出，禁止默认导出；命名导出在导入不存在的成员时立即报错。现有 `remote.ts`/`workflow-engine.ts` 的 `export default` 是 typert generator 与插件 Loader 的既有约定，保持不变。

##### SFS.09 导出可见性 [Recommended]

只导出在模块外部使用的符号，最小化模块导出 API 表面。

##### SFS.14 使用模块而非命名空间 [Required]

禁止 `namespace`；代码必须使用 ES6 `import`/`export` 组织，禁止 `require`。

##### SFS.05 导入路径 [Recommended]

同项目文件优先相对导入（`./foo`）；避免过深父目录层级（`../../../`）。

#### 类型声明与派生

##### TS.01 类型推断 [Recommended]

简单类型（string/number/boolean 字面量初始化）省略注解；复杂表达式加注解提高可读性。

##### TS.02 返回类型 [Recommended]

是否加返回类型注解由作者决定，审查者可要求澄清复杂类型；项目可要求始终包含。

##### TS.05 可选优先于 |undefined [Recommended]

使用可选字段/参数（`?`）而非 `|undefined` 联合；类字段尽量在声明处初始化。

##### TS.04 可空别名 [Required]

类型别名禁止在联合中包含 `|null` 或 `|undefined`，应只在实际使用时添加。

##### TS.07 接口优于类型别名 [Recommended]

声明对象类型时用接口而非对象字面量类型别名，接口有更好的工具支持。

##### TS.08 Array 类型 [Required]

简单类型用 `T[]` 语法糖，复杂类型用 `Array<T>`；多维简单类型也用语法糖。

##### TS.10 映射和条件类型 [Recommended]

始终使用最简单的类型构造；少量重复或冗长优于复杂类型表达式。

##### TS.17 仅返回类型泛型 [Recommended]

避免创建仅返回类型的泛型 API；使用现有仅返回类型泛型（如 `z.infer`）时始终显式指定泛型。

#### 函数与 React 组件

##### LF.01 const/let [Required]

默认 `const`，需要重新赋值用 `let`，禁止 `var`；变量禁止在声明前使用；每行只声明一个变量。

##### LF.25 函数声明优先 [Recommended]

命名函数优先用函数声明而非箭头函数（React 组件用 `export function Xxx()`）；函数表达式用箭头函数代替。

##### LF.28 箭头函数体 [Recommended]

返回值被使用时用简洁体，未使用时用块体（块体确保返回 `void`）。

##### LF.30 回调传箭头函数 [Recommended]

避免把命名回调直接传给高阶函数（意外参数会导致逻辑错误），优先传显式转发参数的箭头函数。

##### LF.43 控制流大括号 [Required]

控制流语句必须使用大括号；可单行放置的 `if` 可省略大括号。

##### LF.45 容器遍历 [Recommended]

数组优先 `for...of`；`for...in` 遍历对象需 `hasOwnProperty` 过滤或改用 `Object.keys/values/entries`。

##### LF.52 严格相等 [Required]

必须使用 `===`/`!==`；与字面量 `null` 比较可用 `==`/`!=` 同时覆盖 `undefined`。

##### LF.53 类型与非空断言 [Recommended]

类型断言与非空断言不安全，应优先运行时检查；确需断言时加注释说明原因；必须用 `as` 语法而非尖括号。

##### LF.56 断言与对象字面量 [Required]

对象字面量用类型注解（`: Foo`）而非断言（`as Foo`），以在接口字段变化时捕获重构错误。

##### LF.57 try 块精简 [Recommended]

限制 try 块内代码量，将不抛出的代码移出 try/catch。

##### LF.50 空 catch 块 [Recommended]

空 catch 块必须包含解释注释说明正当理由。

##### LF.58 装饰器 [Recommended]

禁止定义新装饰器，只使用框架提供的装饰器（如 `@Remote`）；装饰器必须紧跟被装饰符号，JSDoc 放在装饰器之前。

#### 注释与文档

##### DOC.01 JSDoc vs 普通注释 [Required]

用 `/** JSDoc */` 文档化，用 `//` 实现注释；多行注释用多个 `//` 而非 `/* */`。

##### DOC.07 文档化顶层导出 [Recommended]

模块所有顶层导出必须文档化；类注释应说明如何正确使用类；避免仅重复参数名/类型。

##### DOC.09 方法/函数注释 [Recommended]

描述以第三人称动词短语开头（如"解析工作流 YAML 文本"）；签名显而易见时可省略。

##### DOC.11 JSDoc 类型注解 [Required]

JSDoc 类型注解在 TS 源代码中冗余，禁止在 `@param`/`@return` 中重复声明类型。

##### DOC.12 注释加信息 [Required]

注释必须提供实际信息；调用时参数含义不清用 `/* name= */` 参数名注释。

#### 工具链与一致性

##### TC.01 @ts-ignore 禁止 [Required]

禁止 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`；单测可用 `@ts-expect-error` 但通常不应该。

##### CS.04 单引号 [Required]

字符串字面量用单引号；复杂拼接用模板字面量。

##### CS.05 分号 [Required]

显式使用分号结束所有语句，不依赖自动分号插入（ASI）。

##### CS.06 禁止 console.log [Required]

禁止 console.log，通过 logger 输出日志。

##### CS.07 缩进 [Required]

TypeScript 缩进必须采用 2 个空格。

##### CS.09 文件行数 [Recommended]

普通业务文件 300-500 行、组件/类文件 200-300 行、工具/配置文件 100-200 行、大型模块不超过 800 行。

##### POL.01 一致性 [Required]

未解决的风格问题与同文件/目录保持一致；新文件必须用 Google 风格；重大更改时重新格式化；避免机会主义风格修复。

### 3. Security & production notes

- **浏览器安全边界（SFS.12/SFS.13）**: 拆分 `schema.ts`/`yaml-parser.ts` 时，定义层模块只能依赖 `zod`/`yaml` 与类型；`defineDomain`/`domainTable`（`@deepseek-ai/dsh-storage-domain`）等 Node 侧运行时值必须留在存储层（如 `sandoreDomainSpec`），不得被浏览器模块导入。
- **外部输入校验（TS.12）**: DagEditor 的 YAML 预览/保存必须走 `parseWorkflowYaml`（zod `WorkflowDefinitionSchema.parse`）校验，解析结果按 `unknown` 收窄，不得对用户 YAML 输入使用 `any` 或类型断言。
- **错误面（LF.48/LF.49）**: `SandoreError`/`SandoreRemoteError` 均继承 `Error`；组件 catch 块按 `e instanceof Error` 收窄后取 message，避免对非 Error 值做防御性处理。
- **命名导出（SFS.08）**: 新 DagEditor 组件用命名导出；`remote.ts` 的 `export default sandoreRemote` 是 typert remote-client 的既有约定，保持不变。
