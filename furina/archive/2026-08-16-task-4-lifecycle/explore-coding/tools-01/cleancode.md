# Furina CleanCode Exploration Result

## Explore Content

Task 4 tools-01：在 sandore monorepo 中新建/落地 `@deepseek-ai/dsh-sandore-tool` 包，实现工作流生命周期控制工具（getState/startInstance/abortInstance/pauseStep/resumeStep/pauseAllSteps/resumeAllSteps/retryStep），并通过子代理 `agentCtx.tools.register` 注入。

## Explore Type

cleancode（clean-ts / TypeScript 编码规范）

## Scope

- **需求摘要**：落地 `@deepseek-ai/dsh-sandore-tool` 包，用 DSH `defineTool` 实现 8 个工作流生命周期控制工具，通过子代理 `agentCtx.tools.register` 注入；遵循 Cordis Service 抽象类、schemastery Config、typed error 与 peerDependencies 镜像范式。
- **影响的代码特征**：包/模块组织（命名导出、`import type`、`.ts` 后缀相对导入）、类/Service 派生、`declare module` 上下文键增强、schemastery Config、DSH defineTool 泛型推断（ParameterSchemaSpec/ValueSchemaSpec）、typed error（SandoreError/HarnessError code）、异常处理、控制结构、JSDoc 文档化。

## Guidelines

### 包结构与模块导出

#### 命名导出 [Required]
所有代码中使用命名导出，禁止默认导出（默认导出无规范名称，集中维护困难且易产生歧义）。只导出在模块外部使用的符号，最小化模块导出 API 表面。禁止 `export let`（可变导出产生难以理解的代码），可变绑定应改用显式 getter 函数。

#### import type / export type [Required]
当仅将导入符号用作类型时使用 `import type {...}`；对值使用常规导入。重新导出类型时使用 `export type {...}`。

#### 使用模块而非命名空间 [Required]
禁止 `namespace Foo { ... }` 结构，禁止 `require` / `import x = require(...)`，必须使用 ES6 `import {foo} from 'bar'` 形式组织代码。

#### 相对导入路径 [Recommended]
引用同一（逻辑）项目中的文件时应使用相对导入（`./foo`）而非绝对导入；考虑限制父目录层级（`../../../`）数量。本项目按仓库既有范式使用 `.ts` 后缀相对导入与 workspace 包名导入。

### 类型声明

#### 接口优于类型别名 [Required]
声明对象类型时使用接口而非对象字面量表达式的类型别名；接口有更好的工具支持与重构反馈。

#### 结构化类型 + 声明处显式类型 [Recommended]
TypeScript 使用结构化类型系统；在符号声明处显式包含类型，以允许更精确的类型检查和错误报告。

#### 可选字段优于 |undefined [Required]
使用 `?` 可选字段（接口/类）和可选参数，而非 `|undefined` 类型；类型别名禁止在联合类型中包含 `|null` 或 `|undefined`，只在实际使用别名处添加。

#### 类型推断与返回类型 [Recommended]
简单类型（初始化为 string/number/boolean/RegExp 字面量或 new 表达式）可省略注解；复杂表达式应添加注解。是否为函数/方法包含返回类型注解由代码作者决定。

#### unknown 优于 any [Required]
`any` 会掩盖编程错误；优先提供更具体的类型、使用 `unknown`，或抑制 lint 警告并记录原因。`unknown` 需先经类型守卫缩小后才可安全使用。

#### Array T[] 语法糖 [Required]
简单类型使用 `T[]` / `readonly T[]` 语法糖；任何更复杂的情况（联合、对象字面量元素）使用 `Array<T>`。

### 类与 Service 派生

#### 类/方法声明与分隔 [Required]
类声明禁止以分号结尾；类方法声明禁止以分号分隔；方法声明应该用单个空行与周围代码分隔。抽象类派生实现（含 `override`/`noImplicitOverride`）遵循同一约束。

#### readonly 修饰符 [Required]
用 `readonly` 修饰符标记在构造函数外部从不重新赋值的属性（不必深度不可变）。

#### 参数属性 [Recommended]
使用 TypeScript 参数属性 `constructor(private readonly x: X)` 而非显式初始化器；若需文档化用 `@param` JSDoc。

#### 可见性 [Required]
尽可能限制符号可见性；TypeScript 符号默认 public，除非声明非只读 public 参数属性，否则不要使用 `public` 修饰符；禁止用 `obj['foo']` 绕过属性可见性。

#### 避免私有静态方法 [Recommended]
优先使用模块局部（非导出）函数而非私有静态方法，除非干扰可读性。

#### 构造函数必须带括号 [Required]
构造函数调用必须使用括号（`new Foo()`），即使没有参数。

### 函数与 defineTool 回调

#### 函数声明优先 [Required]
定义命名函数时优先使用函数声明而非箭头函数或函数表达式；函数表达式应使用箭头函数代替（除非必须动态重绑定 `this`）。

#### 箭头函数体 [Required]
只有返回值实际被使用时才用简洁体（表达式）；块体确保返回类型为 void 并防止副作用。

#### 优先传箭头函数作为回调 [Recommended]
回调可能以意外参数调用；优先传递显式转发参数到命名回调的箭头函数，而非直接传递命名回调。

### 异常处理（typed error）

#### 只抛出 Error 对象及其子类 [High]
允许抛出或拒绝带有任意值的 Promise，但非 `Error` 值不会填充堆栈跟踪信息，使调试困难。该约束扩展到 Promise 拒绝值。合规示例：

```ts
throw new Error('oh noes!');
class MyError extends Error {}
throw new MyError('my oh noes!');
Promise.reject(new Error('oh noes!'));
```

#### 实例化异常使用 new [High]
实例化异常时始终使用 `new Error()`，而非仅调用 `Error()`。合规示例：

```ts
throw new Error('Foo is not a valid bar.');
```

#### 捕获错误并假设 Error [High]
捕获错误时，应假设所有抛出的错误都是 `Error` 的实例。除非被调用的 API 确定会抛出非 `Error`，否则异常处理程序禁止防御性地处理非 `Error` 类型。合规示例：

```ts
function assertIsError(e: unknown): asserts e is Error {
  if (!(e instanceof Error)) throw new Error("e is not an Error");
}

try {
  doSomething();
} catch (e: unknown) {
  assertIsError(e);
  displayError(e.message);
  // or rethrow:
  throw e;
}
```

#### 空 catch 块需注释 [Required]
空 catch 块仅在确实无需响应时允许，且必须在注释中解释其正当理由。

### 控制结构

#### 大括号 / switch default / 严格相等 [Required]
控制流语句（if/else/for/do/while）必须用大括号包围；所有 switch 必须含 default 分支且放最后，非空 case 禁止 fall through；始终使用 `===`/`!==`（与字面量 `null` 比较可用 `==`/`!=` 同时覆盖 null/undefined）。

### 命名

#### 命名风格与描述性名称 [Required]
class/interface/type/enum/type 参数用 UpperCamelCase；variable/parameter/function/method/property/模块别名用 lowerCamelCase；模块级常量用 CONSTANT_CASE。名称必须描述性、不删单词内部字母，缩写视为整词（`loadHttpUrl` 而非 `loadHTTPURL`）；类型信息不应出现在名称中；禁止 `_` 前缀/后缀。

### 工具链

#### @ts-ignore / @ts-expect-error / @ts-nocheck 禁止 [Required]
所有 TypeScript 文件必须通过标准工具链类型检查；不要使用 `@ts-ignore` 或变体 `@ts-expect-error`、`@ts-nocheck` 抑制类型错误。本项目启用 strict/exactOptionalPropertyTypes/noUncheckedIndexedAccess/noImplicitOverride，必须真实满足类型而非抑制。

### 注释与文档

#### JSDoc 文档化顶层导出 [Required]
模块的所有顶层导出用 `/** JSDoc */` 文档化（`//` 用于实现注释；多行用多个 `//` 而非 `/* */`）。类注释应提供足够信息了解如何使用类；方法描述以第三人称动词短语开头；JSDoc 类型注解在 TS 中冗余，禁止在 `@param`/`@return` 中重复声明类型。

### 核心风格

#### ESM / 单引号 / 分号 / 2 空格缩进 / logger [Required]
推荐 Node.js ES 模块（`type: module`）；普通字符串用单引号；显式使用分号；TypeScript 缩进必须为 2 个空格；禁止 `console.log`，通过 logger 输出日志。

#### 文件行数 [Recommended]
普通业务文件 300-500 行、组件/类文件 200-300 行、工具/配置文件 100-200 行为理想范围；大型模块不超过 800 行。

### 策略

#### 一致性 [Required]
规范未明确解决的风格问题与同一文件/目录既有代码保持一致；新文件必须使用 Google 风格。避免机会主义风格修复。

## Security & production notes

- **Typed error 按 code 路由**：8 个工具在 `execute` 中调用 `ctx.sandoreEngine` 生命周期方法时，引擎失败应抛/透传 `SandoreError`（继承 `HarnessError`，携带稳定 `code`），不得抛出非 `Error` 值，否则 DSH 工具注册表的 `errorInfo()`（`error instanceof HarnessError`）无法提取 `{name, code}` 供策略/重试按 `code` 路由，`isFatalSandoreError` 的 `instanceof` 判定也会失效。
- **defineTool 输出契约**：`output.schema` 会在每次成功 `execute` 返回后强制校验，返回不匹配值会抛 `ToolOutputError`（code `INVALID_TOOL_OUTPUT`）。8 个工具的 `execute` 必须返回与声明 `output.schema` 一致的规范 JSON 值（如 `getState` 返回快照对象、`startInstance` 返回 `{instanceId, status}`）。
- **参数校验边界**：模型入参在注册表内已按 `parameters` schema 校验后（非法抛 `ToolArgsError`/`INVALID_ARGS`）才进入 `execute`，故 `execute` 内对已收窄的 `args` 不应再用 `as`/`!` 断言；`retryStep` 的 `mode` 用 enum 约束（`'continue'|'revert'|'fork'`），未知值在 schema 边界即被拒绝。
- **子代理注入面**：`agentCtx.tools.register(defineTool({...}))` 注册的是 `ToolDefinition`；`register` 返回 disposer 用于有序清理。`getState`/`startInstance` 为同步方法，需注意 `execute` 内 await 语义与 `exec.signal` 取消观察。
