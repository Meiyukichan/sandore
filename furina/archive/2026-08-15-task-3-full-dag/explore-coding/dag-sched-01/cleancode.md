# Furina CleanCode Exploration Result

# Explore Content

为 sandore 工作流引擎接入完整 DAG 调度（分支/循环/Step 级并行与就近匹配），需改造 `dag-navigator.ts` 的 `resolveNextNodes`、`stage-executor.ts` 的线性 `execute()` 与 `workflow-engine.ts` 的 `runInstance` Stage 级 while 循环，并复用前五个 feature 产出的 step-runner/branch-evaluator/loop-manager/finalize-manager/file-utils 模块。

# Explore Type

cleancode

# Exploration Result

### 1. Scope

- **Requirement summary**: 为 sandore 工作流引擎接入完整 DAG 调度（分支/循环/Step 级并行与就近匹配），改造 `dag-navigator.ts` 的 `resolveNextNodes`、`stage-executor.ts` 的线性 `execute()` 与 `workflow-engine.ts` 的 `runInstance` Stage 级 while 循环，并复用 step-runner/branch-evaluator/loop-manager/finalize-manager/file-utils 模块。
- **Code features affected**: 类与接口设计（私有字段/readonly/参数属性/getter）、类型系统（Zod 三层 schema、discriminated union CommandConfig、可选字段）、导入导出（.ts 后缀、import type、re-export）、错误处理（SandoreError code 联合、fatal 标志）、异步与控制流（while/for-of/switch 调度循环）、函数与箭头回调、命名、JSDoc 注释、工具链约束。

### 2. Guidelines

#### 类与接口设计

##### LF.CLASS.NOPRIVATE 禁止 #private 字段 [Required]
不使用 `#` 私有字段，改用 TypeScript 可见性注解（`private`/`protected`/`readonly`）。现有 `private readonly` 风格已符合。

##### LF.CLASS.SEMI 类声明/方法禁止分号 [Required]
类声明不以分号结尾，类方法之间不用分号分隔，方法间用单个空行分隔。

##### LF.CLASS.READONLY readonly 修饰符 [Recommended]
对构造后从不重新赋值的属性加 `readonly`（不要求深度不可变），与现有 readonly 接口风格一致。

##### LF.CLASS.PARAM 参数属性 [Recommended]
用参数属性 `constructor(private readonly x: T)` 替代「显式字段 + 构造函数赋值」样板。

##### LF.CLASS.FIELDINIT 字段初始化器 [Recommended]
非参数成员在声明处初始化，可省去构造函数；后续可能填充的可选字段显式初始化为 `undefined` 以避免 VM shape 变化。

##### LF.CLASS.GETTER getter 必须纯函数 [Recommended]
getter 结果一致且无副作用，不改变可观察状态（现有 `currentNodeId`/`getStageContracts` 等均满足）。

##### LF.CLASS.VIS 可见性最小化 [Recommended]
尽可能限制符号可见性；除非声明非只读 public 参数属性，否则不使用 `public` 修饰符。

##### TS.STRUCT 结构化类型，声明处显式类型 [Recommended]
在声明处显式标注类型以获得精确错误报告；用接口描述结构类型（readonly 接口风格）。

##### TS.INTERFACE 对象类型优先接口而非类型别名 [Recommended]
声明对象形状用 interface；联合/判别联合（如 CommandConfig、SandoreErrorCode）仍用 type。

#### 类型系统

##### TS.INFER 类型推断 [Recommended]
简单类型（`string`/`number`/`boolean`/`new` 表达式）可省略注解；复杂表达式建议显式标注。

##### TS.RETURN 返回类型注解 [Recommended]
是否标注由作者决定，复杂返回类型可被审查者要求标注（现有公开方法均标注返回类型）。

##### TS.NULLABLE 类型别名禁止内嵌 |null/|undefined [Required]
可空性在别名使用处添加（`getLatte(): CoffeeResponse|undefined`），不在别名定义处合并。

##### TS.OPTIONAL 优先可选参数/字段 ? 而非 |undefined [Recommended]
接口/类字段与参数用 `?`；类字段尽量初始化。

##### TS.ARRAY Array 类型用 T[] 语法糖 [Recommended]
简单类型用 `T[]`/`readonly T[]`，复杂类型用 `Array<T>`。

##### TS.INDEX 索引签名/Record/Map [Recommended]
字典对象用 `{[key: string]: T}` 或 `Record<K, V>`，键名有含义；考虑 Map/Set（现有 `nodeIndex`/`stageContracts` 已用 Map）。

##### TS.ANY 避免 any，优先 unknown [Recommended]
用更具体类型或 `unknown`；测试中构造 mock 需 any 时加注释说明原因（现有 `describeError`/`renderError` 以 unknown 收口）。

#### 导入导出与模块结构

##### CS.MODULE 模块导入方式 [Required]
推荐 Node.js ES 模块；第三方库/多导出模块用命名空间导入；Node.js 内置模块必须默认导入。

##### SFS.NAMED 命名导出，禁止默认导出 [Required]
全部使用命名导出；默认导出无规范名称、不利重构。注意：现有 `workflow-engine.ts` 的 `SandoreEngineRuntime` 使用 `export default`，改造时评估改为命名导出。

##### SFS.VIS 导出可见性最小化 [Recommended]
只导出模块外部使用的符号，最小化 API 表面。

##### SFS.NOLET 禁止 export let [Required]
可变绑定用显式 getter 函数访问。

##### SFS.REL 相对导入 + 限制父目录层级 [Recommended]
引用同项目文件用相对导入（本项目约定保留 `.ts` 后缀），限制 `../../../` 层级。

##### SFS.IMPORTTYPE import type / export type [Recommended]
仅作为类型使用的导入用 `import type`；类型 re-export 用 `export type`（现有 errors.ts re-export 已采用）。

##### SFS.NONS 禁止 namespace 与 require [Required]
用 ES6 import/export，不用 `namespace`、`/// <reference>`、`import x = require()`。

##### SFS.ORDER 文件顺序 [Required]
版权 → `@fileoverview` JSDoc → 导入 → 实现，各部分间单个空行。

#### 错误处理

##### LF.ERR.TYPE 只抛出 Error 子类 [Required]

**[Description]**

JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。

**[Compliant]**

```ts
// Throw only Errors
throw new Error('oh noes!');
// ... or subtypes of Error.
class MyError extends Error {}
throw new MyError('my oh noes!');
```

##### LF.ERR.NEW 用 new 实例化异常 [Required]
实例化异常用 `new Error()`，不用 `Error()` 直接调用（两种形式均创建实例，但 `new` 与其他对象实例化方式一致）。

##### LF.ERR.CATCH 捕获时假设 Error 实例 [Recommended]
捕获 `error: unknown` 时经 `instanceof` 收窄或断言后再用 `message`；不防御性处理非 Error（除非已知来源抛出非 Error 并加注释）。

##### LF.ERR.EMPTYCATCH 空 catch 块加注释 [Required]
空 catch 必须用注释说明为何不处理。

##### LF.ERR.TRYFOCUS try 块保持精简 [Recommended]
限制 try 内代码量；循环内可扩大 try 覆盖整循环。

##### LF.ENUMBOOL 枚举/联合值禁止隐式布尔转换 [Required]
对 status/code 等联合值用显式比较（`=== 'failed'`、`!== undefined`），不用 `if (level)`/`!!level`。SandoreError 路由只按 code 判断，永不解析 message。

##### LF.EQ 严格相等 === [Required]
始终用 `===` 和 `!==`；仅与 null 比较可用 `==`（同时覆盖 undefined）。

##### LF.ASSERT 类型断言用 as 且优先运行时检查 [Required]
类型断言（`x as T`）与非空断言（`y!`）不安全，应优先运行时检查；必须用 `as` 语法而非尖括号；有把握时加注释说明理由。

#### 异步与控制流

##### LF.SPREAD 展开语法值类型必须匹配 [Required]

**[Description]**

使用展开语法时，被展开的值**必须**与正在创建的内容匹配。创建数组时，只展开可迭代对象。禁止展开原始类型（包括 `null` 和 `undefined`）。

使用展开语法时，被展开的值**必须**与正在创建的内容匹配。也就是说，创建对象时，只展开对象；禁止展开数组和原始类型（包括 `null` 和 `undefined`）。避免展开具有非 Object 原型的对象（例如类定义、类实例、函数），因为行为是不直观的（只浅拷贝可枚举的非原型属性）。

**[Compliant]**

```ts
const foo = shouldUseFoo ? [7] : [];
const bar = [5, ...foo];
```

```ts
const foo = shouldUseFoo ? {num: 7} : {};
const bar = {num: 5, ...foo};
```

##### LF.BLOCK 控制流语句用大括号 [Required]
`if`/`for`/`while` 等即使单语句也用大括号；可一行放下的 `if` 可省略大括号（DAG while 循环必须带块）。

##### LF.FOROF for-of 遍历数组 [Recommended]
遍历数组用 for-of；for-in 仅用于字典对象并需 hasOwnProperty 过滤，或改用 `Object.keys`/`entries`。

##### LF.SWITCH switch 必须有 default 且禁 fall through [Required]
`default` 放最后；非空 case 必须 `break`/`return`/`throw` 终止。CommandConfig 按 type 分发时应确保 default 兜底。

##### LF.COERCE 禁止隐式布尔强制转换 [Recommended]
`if`/`while` 条件里不用 `!!foo`；直接 `if (foo)` 或显式比较。

##### LF.ARROWCALLBACK 优先传递箭头函数回调 [Recommended]
回调用箭头函数显式转发参数，避免把命名函数直接当回调（防止意外参数）；hooks 已用箭头函数。

##### LF.ARROWBODY 箭头函数体 [Recommended]
返回值被使用才用简洁体；返回 void 时用块体或 `void` 运算符。

#### 函数与回调

##### LF.VAR 用 const/let，禁止 var [Required]
默认 `const`，需重新赋值才用 `let`；变量禁止在声明前使用；每行只声明一个变量。

##### LF.FUNCDECL 命名函数优先函数声明 [Recommended]
命名函数用 function 声明；方法体内嵌套优先箭头函数以捕获 this。

##### LF.STRING 字符串单引号 [Required]
字符串字面量用单引号；复杂拼接用模板字面量；禁止行延续（反斜杠续行）。

#### 命名规范

##### NAM.ASCII 标识符 ASCII [Required]
仅用 ASCII 字母数字、下划线（常量/结构化测试名）、极少 `$`。

##### NAM.CASE 命名大小写 [Required]
类/接口/类型/枚举用 UpperCamelCase；变量/函数/参数/属性用 lowerCamelCase；模块级常量用 CONSTANT_CASE（现有 `TERMINAL_STATUSES` 符合）。

##### NAM.NOMARK 禁止下划线/opt_ 前缀与接口标记 [Required]
不用 `_` 前缀后缀、`opt_` 前缀、`IMyInterface` 等标记。

##### NAM.DESC 描述性名称 [Required]
名称描述清晰，不用模糊缩写；≤10 行作用域的局部变量可用短名。

##### NAM.CONST 常量 CONSTANT_CASE [Recommended]
CONSTANT_CASE 表示值意图不变；类 `static readonly` 属性也是常量；仅模块级符号可用 CONSTANT_CASE。

##### NAM.TEST 测试名可用 _ 分隔 [Recommended]
`testX_whenY_doesZ()` 结构（vitest describe/it 场景适用）。

#### 注释与文档

##### CD.JSDOC JSDoc 与 // 注释分工 [Required]
文档化用 `/** JSDoc */`，实现注释用 `//`。

##### CD.MULTILINE 多行注释用 // [Required]
不用 `/* */` 块注释。

##### CD.TOPLEVEL 文档化所有顶层导出 [Required]
模块顶层导出（类/函数/接口）需 JSDoc；保留现有 `@module` + 逐项 JSDoc 风格。

##### CD.METHOD 方法注释第三人称动词 [Recommended]
方法描述以第三人称动词短语开头（「此方法 …」）。

##### CD.NOTYPE JSDoc 类型注解冗余 [Required]
TS 源码中不在 `@param`/`@return` 重复类型，不用 `@implements`/`@enum`/`@private` 等。

#### 工具链与核心风格

##### TC.NOTS 禁止 @ts-ignore/@ts-expect-error/@ts-nocheck [Required]
所有文件必须通过类型检查；测试中尽量用显式断言/注释替代 @ts-expect-error。

##### CS.QUOTE 单引号 [Required]
字符串用单引号。

##### CS.SEMI 显式分号 [Required]
所有语句以分号结尾，不依赖 ASI。

##### CS.INDENT 2 空格缩进 [Required]

##### CS.LOG 禁止 console.log，用 logger [Required]
日志经 `ctx.logger` 输出（现有 `ctx.logger.warn` 风格）。

##### CS.LINES 文件行数限制 [Recommended]
业务文件 300-500 行，组件/类 200-300，工具/配置 100-200，大型模块 ≤800 行。

##### POL.CONSIST 一致性 [Recommended]
规范未覆盖的风格问题与同文件/同目录现有代码保持一致；新文件用 Google 风格。

### 3. Security & production notes

- **LF.ERR.TYPE（只抛 Error 子类）**：`SandoreError` 继承 `HarnessError`，`isFatalSandoreError` 与 code 路由依赖 `instanceof` 与堆栈跟踪；调度路径新增处若 `throw` 裸值（字符串等）将破坏按 code 路由与堆栈诊断。`describeError`/`renderError` 已按 unknown 收口，新增代码不得抛出非 Error 值。
- **LF.SPREAD（展开匹配）**：可选字段构造统一用 `...(cond === undefined ? {} : { key })`；resolveNextNodes/DAG 循环新增状态合并（activeLoopStack/passThroughVars/visitCounts 等）时禁止展开可能为 null/undefined 的值，否则运行时抛 TypeError。
- **SFS.NAMED（命名导出）**：`workflow-engine.ts` 现有 `export default class SandoreEngineRuntime` 与本规范冲突；若保留为包默认导出需显式评估，其余新增导出应一律命名导出。
- **项目约定（改造保持一致）**：import 保留 `.ts` 后缀；错误经 `ctx.emit` 与 `session.append` 双发；vitest 集成测试用 `harness()` 注入 FakeLlm/FakeShell/FakeSessionStore/MemoryStorageDomain mock。
