# Furina CleanCode Exploration Result

## Explore Content

为 sandore UI 插件新增 sandore-step 讨论节点（conversation.chat.node keyed 三件套），照抄 deepseek-harness 的 ui-workflow-run 参考实现：新增 ConversationNodeDefinition（kind:'sandore-step', target:'chat'）把 6 个 sandore/step-* Session 事件折叠为单节点状态，注册 keyed chat.node 渲染器 DagStepNodeView，declare module 扩展 ChatNodeDataMap，按状态内联渲染（running/completed/failed/paused）并支持点击跳子会话与节点级重试控件。

## Explore Type

cleancode

## Primary Language

TypeScript（tracked TS/TSX = 84，Python = 0）

## Scope

- **需求摘要**: 为 sandore UI 插件新增 `sandore-step` 讨论节点（`kind:'sandore-step'`, `target:'chat'`），照抄 deepseek-harness `ui-workflow-run` 的 `conversation.chat.node` keyed 三件套（Definition + keyed 渲染器 + ChatNodeDataMap 声明合并）。
- **涉及的代码特性**: 纯函数状态机与判别联合穷尽 switch、React 函数组件 + CSS Module、`declare module` 声明合并、typed locale 字典（`keyof typeof zh`）、Cordis DI 生命周期（`static inject` / `ctx.effect` / `ctx.slots.register`）、Readonly 不可变状态、可选字段（`loopIteration?`）、ui-primitives 组合、vitest/@testing-library 测试。

## Guidelines

### 判别联合状态折叠与 switch

#### H1 Switch statements [Required]

**Description**

所有 `switch` 语句**必须**包含一个 `default` 语句组，即使它不包含代码。`default` 语句组必须放在最后。在 switch 块中，每个语句组要么通过 `break`、`return` 语句或抛出异常突然终止。非空语句组（`case ...`）**禁止** fall through（由编译器强制）。空的语句组允许 fall through。

**Compliant**

```ts
switch (x) {
  case Y:
    doSomethingElse();
    break;
  default:
    // nothing to do.
}
```

```ts
switch (x) {
  case X:
  case Y:
    doSomething();
    break;
  default: // nothing to do.
}
```

### 类型安全与断言

#### H2 Type and non-nullability assertions [Required]

**Description**

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。有时由于代码的某些局部属性，你可以确定断言形式是安全的。在那些情况下，你应该添加说明来解释为什么你可以接受不安全的行为。如果类型或非空断言背后的推理是显而易见的，注释**可以**不是必需的。类型断言**必须**使用 `as` 语法（而不是尖括号语法）。

**Compliant**

```ts
if (x instanceof Foo) {
  x.foo();
}

if (y) {
  y.bar();
}
```

```ts
// x is a Foo, because ...
(x as Foo).foo();

// y cannot be null, because ...
y!.bar();
```

```ts
// z must be Foo because ...
const x = (z as Foo).length;
```

### 缺失值与可选字段（缺省 vs 空串）

#### H3 Prefer optional over |undefined / no nullable aliases [Required]

**Description**

TypeScript 支持 `undefined` 和 `null` 类型。可空类型可以构造为联合类型（`string|null`）；`undefined` 也是如此。类型别名**禁止**在联合类型中包含 `|null` 或 `|undefined`。可空别名通常表示空值正在通过太多应用程序层传递，这模糊了导致 `null` 的原始问题的来源。相反，代码**必须**只在实际使用别名时添加 `|null` 或 `|undefined`。代码**应该**在值出现的附近处理空值。TypeScript 支持使用 `?` 的可选参数和字段的特殊构造。可选参数在其类型中隐式包含 `|undefined`。使用可选字段（在接口或类上）和参数而不是 `|undefined` 类型。对于类，最好避免这种模式，尽可能多地初始化字段。

**Compliant**

```ts
type CoffeeResponse = Latte|Americano;

class CoffeeService {
  getLatte(): CoffeeResponse|undefined { ... };
}
```

```ts
interface CoffeeOrder {
  sugarCubes: number;
  milk?: Whole|LowFat|HalfHalf;
}

function pourCoffee(volume?: Milliliter) { ... }
```

```ts
class MyClass {
  field = '';
}
```

### 工具链与类型检查

#### H4 @ts-ignore/@ts-expect-error/@ts-nocheck forbidden [Required]

**Description**

所有 TypeScript 文件必须使用标准工具链通过类型检查。不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。它们表面上似乎是"修复"编译器错误的简单方法，但实际上，特定的编译器错误通常是由更大的问题引起的，可以更直接地修复。在单元测试中可以使用 `@ts-expect-error`，但通常**不应该**。

### 模块与导入导出

- **MOD.NAMED 命名导出、禁止默认导出 [Required]** — 所有代码使用命名导出，禁止默认导出；命名导出能在导入未声明内容时报错，并避免默认导出改名导致的静默 bug。
- **MOD.IMPORTTYPE import/export type [Recommended]** — 仅作类型使用时用 `import type`，类型重导出用 `export type`。
- **MOD.NONAMESPACE 使用模块而非命名空间 [Required]** — 禁止 `namespace Foo {}` 与 `require`，必须用 ES6 import/export 组织代码。
- **MOD.PATH 相对导入 [Recommended]** — 同一逻辑项目内应使用相对导入（`./foo`），限制父目录层级。
- **MOD.VIS 导出可见性 [Recommended]** — 只导出模块外使用的符号，最小化模块导出 API 表面。
- **MOD.NOLET 可变导出 [Required]** — 禁止 `export let`，可变绑定改用显式 getter 函数。
- **MOD.NOCONTAINER 容器类 [Recommended]** — 不要创建静态容器类作命名空间，导出单个常量与函数。

### 文件基础与结构

- **FILE.UTF8 [Required]** — 源文件用 UTF-8；非 ASCII 字符直接用 Unicode 字符（如 `∞`）。
- **FILE.ORDER [Required]** — 文件顺序：版权 → @fileoverview JSDoc → 导入 → 实现，各节间恰好一个空行。
- **FILE.HEADER [Required]** — 文件头 JSDoc 采用 `/** 描述 */ @author ... @copyright {年份} ...` 样式（core style）。

### 变量与字面量

- **VAR.CONST [Required]** — 用 `const`/`let`，默认 `const`，禁止 `var`；每个声明只声明一个变量。
- **VAR.ARRAY [Required]** — 禁止 `Array()` 构造函数，用 `[]`；数组上不定义非数字属性。
- **VAR.OBJECT [Required]** — 禁止 `Object()` 构造函数，用 `{}`；对象展开只展开对象，数组展开只展开可迭代对象，禁止展开原始类型。
- **VAR.DESTRUCT [Recommended]** — 解构作函数参数时保持单层、非引号简写属性，左侧给默认值（`{a, b} = {}`）。

### 函数与 this

- **FN.DECL [Recommended]** — 命名函数优先用函数声明而非箭头函数。
- **FN.NOEXPR [Required]** — 不用函数表达式，用箭头函数代替。
- **FN.BODY [Required]** — 返回值被使用时用简洁体，否则用块体（块体保证返回 `void`，防止副作用泄漏）。
- **FN.THIS [Required]** — 用箭头函数/显式参数避免重绑定 `this`；优先传递箭头函数作回调。
- **FN.HANDLER [Recommended]** — 事件处理程序可用箭头函数属性以获得稳定卸载引用（onClick 跳子会话/重试场景）。
- **FN.PARAM [Required]** — 默认参数初始化器禁止有可观察副作用；用 rest 参数而非 `arguments`。

### 类与可见性

- **CLS.READONLY [Recommended]** — 用 `readonly` 修饰符标记构造后从不重新赋值的属性（不可变 State）。
- **CLS.NOPRIVATE [Required]** — 禁止 `#private` 字段，用 TypeScript 可见性注解。
- **CLS.VIS [Recommended]** — 除构造函数参数外不用多余的 `public` 修饰符。
- **CLS.PARAMPROP [Recommended]** — 用 parameter property `constructor(private readonly x: T) {}` 代替显式初始化。

### 接口与类型声明

- **TYPE.INFER [Recommended]** — 简单类型（string/number/boolean/RegExp/new）省略注解；复杂表达式加注解。
- **TYPE.RETURN [Recommended]** — 返回类型注解由作者决定，审查者可要求澄清复杂类型。
- **TYPE.STRUCT [Recommended]** — 结构化类型系统；在符号声明处显式包含类型以获得更好的错误报告。
- **TYPE.INTERFACE [Required]** — 声明对象类型用接口而非类型别名（ChatNodeDataMap 扩展即接口声明合并）。
- **TYPE.ARRAY [Required]** — 简单类型用 `T[]`/`readonly T[]` 语法糖，复杂类型用 `Array<T>`（如 `loopIteration?: number[]`）。
- **TYPE.INDEX [Recommended]** — 对象作关联数组用索引签名或 `Record`，键给有意义标签。
- **TYPE.MAPPED [Recommended]** — 始终使用能表达代码的最简单类型构造（`keyof typeof zh` 适度使用）。
- **TYPE.ANY [Required]** — 避免 `any`，优先更具体类型或 `unknown`。
- **TYPE.EMPTY [Recommended]** — 避免 `{}`，优先 `unknown`/`Record<string,T>`/`object`。
- **TYPE.WRAPPER [Required]** — 禁止 `String`/`Boolean`/`Number` 包装器类型，用小写原始类型。

### 命名

- **NAM.ASCII [Required]** — 标识符只用 ASCII 字母数字下划线（及罕见 `$`）。
- **NAM.STYLE [Required]** — class/interface/type/enum 用 UpperCamelCase，变量/函数/方法/属性用 lowerCamelCase，模块级常量用 CONSTANT_CASE。
- **NAM.DESC [Required]** — 名称必须描述性，不用含糊缩写；10 行内局部变量可用短名。
- **NAM.CAMEL [Required]** — 缩写视为整词（`loadHttpUrl` 而非 `loadHTTPURL`）。
- **NAM.CONST [Required]** — CONSTANT_CASE 仅用于模块级符号/静态 readonly 字段/枚举值。

### 控制结构与相等性

- **CTRL.BRACE [Required]** — 控制流语句必须用大括号；可放一行的 if 可省略。
- **EQ.STRICT [Required]** — 必须用 `===`/`!==`；与 `null` 比较可用 `==`/`!=` 同时覆盖 null 与 undefined。
- **ERR.NEW [Required]** — 用 `new Error()` 实例化异常，只抛出 Error 子类。
- **ERR.TRY [Recommended]** — 精简 try 块，将不抛出的语句移出。
- **ERR.CATCH [Required]** — 空 catch 块必须含解释注释。

### 注释与文档

- **DOC.JSDOC [Required]** — 文档化用 `/** JSDoc */`，实现注释用 `//`；多行注释用 `//` 风格。
- **DOC.FORMAT [Required]** — JSDoc 格式良好，用 Markdown 写，`@param` 等标签独占一行。
- **DOC.EXPORT [Required]** — 模块所有顶层导出必须文档化；方法描述以第三人称动词短语开头。
- **DOC.NOTYPE [Required]** — 禁止在 JSDoc 中重复声明类型（`@param` 类型冗余）。
- **DOC.INFO [Required]** — 注释必须提供实际信息，不重复参数名和类型。

### 代码风格（core style）

- **STYLE.QUOTE [Required]** — 字符串字面量用单引号。
- **STYLE.SEMI [Required]** — 显式使用分号。
- **STYLE.INDENT [Required]** — 2 空格缩进。
- **STYLE.LOG [Required]** — 禁止 `console.log`，通过 logger 输出日志。
- **STYLE.ESM [Required]** — 推荐 Node.js ES 模块；第三方/多导出模块用命名空间导入，Node 内置模块用默认导入。
- **STYLE.LINES [Recommended]** — 组件/类文件 200-300 行，工具/配置 100-200 行，大型模块不超过 800 行。

### 策略

- **POL.CONSISTENT [Required]** — 未解决风格问题与同文件/同目录现有代码一致；新文件必须用 Google 风格。
- **POL.REFORMAT [Recommended]** — 重大更改时同步重格式化，避免机会主义风格修复。
- **POL.DEPRECATE [Recommended]** — 弃用标记用 `@deprecated` JSDoc 并给出清晰修复指导。

## Security & production notes（结合本任务契约）

- **H1（Switch）**: 状态机 fold 对 6 个 `sandore/step-*` 事件联合必须用穷尽 switch；`default` 分支应返回 `satisfies never`（本仓库/参考实现范式，作判别联合兜底），新增事件 kind 时编译器会强制补齐分支，避免静默吞事件。
- **H2（断言）**: keyed slot 注入（`PropsRuntime<'conversation.chat.node','sandore-step'>`）与 `node.data` 状态收窄若需断言，必须附解释注释（如 `// node is a sandore-step because registered by kind`），优先用判别收窄/运行时检查而非裸 `as`/`!`。
- **H3（可选字段）**: `loopIteration?: number[]` 用可选字段区分「缺省」与「空数组」，不要用 `|undefined` 别名；locale 字典用 `keyof typeof zh` 约束 en 键集合一致，缺省 key 不用可空别名。
- **H4（@ts-ignore）**: ChatNodeDataMap / SessionEventMap / LocaleNamespaceMap 声明合并若类型不匹配，必须修正声明而非加 `@ts-ignore`，否则 keyed 渲染契约静默失效。
