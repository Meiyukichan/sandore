# Furina CleanCode Exploration Result

# Explore Content

在 sandore 仓库（TypeScript monorepo）中为 Task 4 recovery-01（recoverInstance 单实例恢复 + recoverOrphanedInstances 启动扫描 + retryStep 三种模式 continue/revert/fork 重试）探索参考实现与落点应遵循的 TypeScript 编码规范。涉及文件：workflow/src/workflow-engine.ts（retryStep/recoverInstance 当前 stub、runInstance 主循环、persistState、runnerConfig、execute/runInstance 的 pendingPaused 断点续跑 + while(interacting||paused) 等待循环）、microflow/src/subagents.ts（AgentRegistry.create/resume 含 seed/setup、SubagentRuntime.followup/interrupt/listChildren、Agent 的 session.events）、microflow/src/step-runner.ts（runSubagent/collectSubagentOutput/resumeSubagent 与 StepRunnerConfig）、microflow/src/stage-executor.ts（pendingPaused/pendingAsk 断点续跑状态机）、workflow/src/schema.ts（RetryRecordSchema/retryHistory/parentSessionId/sessionMeta）、DSH 参考源码 sessions.fork/agents.resume/agents.create({seed})/followup 冷恢复、测试 mock（sessions.ts fork / agents.ts resume-create seed / storage-domain.ts state 表 entries 扫描）、workflow-engine.spec.ts 对 retryStep/recoverInstance 抛 INVALID_OPERATION 的断言。

# Explore Type

cleancode

# Exploration Result

# Clean-TypeScript 编码规范 — sandore 工作流引擎 Task 4 recovery-01（recoverInstance / recoverOrphanedInstances / retryStep）

## 1. Scope

- **Requirement summary**: 为 sandore 工作流引擎 Task 4 recovery-01 实现单实例恢复入口 `recoverInstance(instanceId)`、启动扫描 `recoverOrphanedInstances()` 与 `retryStep(instanceId, stepId, mode, message)` 三种重试模式（continue 同会话 followup 续跑 / revert 计算安全 turn 边界 fork 前缀 + agents.create({seed}) / fork 全量历史分叉），提炼 workflow 层 TypeScript 编码规范。
- **Code features affected**: 异步方法（retryStep/recoverInstance/recoverOrphanedInstances 均为 async Promise）、类字段初始化（`instances` Map / `pausedChildIds` Set 在声明处初始化）、SandoreError 错误 code 路由（NODE_NOT_FOUND/INVALID_OPERATION/STEP_EXECUTION，`SandoreError extends HarnessError` 带 `fatal` 标志）、类型断言（`executedSteps as unknown as` 双重断言、childId 反查、持久化 JSON 反序列化）、Zod 派生类型（RetryRecordSchema/ExecutedStepDefaultSchema 的 retryHistory/parentSessionId/sessionMeta 可选字段）、事件双发（emitContained/safeAppend，含新增 `sandore/step-retried`）、结构类型接口（Agent/SubagentRuntime/AgentRegistry 判别联合）、import type/export type、vitest mock（FakeSessionStore.fork/FakeAgentRegistry.create-resume seed/MemoryKvTable.entries 扫描）、不可变状态更新（`active.state = { ...active.state, ... }`）。

## 2. Guidelines

### 类型断言与类型安全

##### TA.01 类型断言语法（必须用 `as`）[Required]

**[Description]**

类型断言**必须**使用 `as` 语法（而不是尖括号语法）。这会在访问成员时强制在断言周围添加括号。

**[Compliant]**

```ts
// z must be Foo because ...
const x = (z as Foo).length;
```

##### TA.02 双重断言（经 `unknown` 中转）[Required]

**[Description]**

TypeScript 只允许类型断言转换为更具体或更不具体的类型版本。添加不满足此条件的类型断言将给出错误："类型 'X' 到类型 'Y' 的转换可能是错误的，因为两种类型都不足以重叠。" 如果你确定断言是安全的，可以执行*双重断言*。这涉及通过 `unknown` 转换，因为它比所有类型都不具体。使用 `unknown`（而不是 `any` 或 `{}`）作为中间类型。

**[Compliant]**

```ts
// x is a Foo here, because...
(x as unknown as Foo).fooMethod();
```

##### TA.03 类型断言与对象字面量（注解优于断言）[Required]

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

##### TA.04 类型与非空断言（优先运行时检查 + 说明注释）[Required]

**[Description]**

类型断言（`x as SomeType`）和非空断言（`y!`）是不安全的。两者都只是让 TypeScript 编译器静音，但不会插入任何运行时检查来匹配这些断言，因此可能导致程序在运行时崩溃。因此，如果没有明显或明确的原因，**不应该**使用类型和非空断言。当你想断言类型或非空性时，最好的答案是编写一个执行该检查的显式运行时检查。有时由于代码的某些局部属性，你可以确定断言形式是安全的。在那些情况下，你应该添加说明来解释为什么你可以接受不安全的行为：如果类型或非空断言背后的推理是显而易见的，注释**可以**不是必需的。

**[Compliant]**

```ts
// assuming Foo is a class.
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

##### TS.01 `any` 类型（优先具体类型 / `unknown`）[Required]

**[Description]**

TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型；使用 `unknown`；抑制 lint 警告并记录原因。`any` 类型允许赋值到任何其他类型并取消引用其上的任何属性。通常这种行为不是必要或期望的，代码只需要表达类型是未知的。在那种情况下使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。

**[Compliant]**

```ts
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

##### TT.01 禁止 @ts-ignore / @ts-expect-error / @ts-nocheck [Required]

**[Description]**

不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。它们表面上似乎是"修复"编译器错误的简单方法，但实际上，特定的编译器错误通常是由更大的问题引起的，可以更直接地修复。例如，如果你使用 `@ts-ignore` 抑制类型错误，很难预测周围代码最终会看到什么类型。在单元测试中可以使用 `@ts-expect-error`，但通常**不应该**。`@ts-expect-error` 抑制所有错误。很容易意外地过度匹配并抑制更严重的错误。考虑以下之一：当测试需要处理运行时未检查值的 API 时，添加强制转换为预期类型或 `any`，并添加说明性注释；或抑制 lint 警告并记录原因。

### 错误处理与 code 路由

##### EX.02 只抛出 Error（含 Promise reject）[Required]

**[Description]**

JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。相反，只抛出（的子类）`Error`。

**[Compliant]**

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

##### EX.03 捕获与重抛（假定为 Error 实例）[Required]

**[Description]**

捕获错误时，代码**应该**假设所有抛出的错误都是 `Error` 的实例。除非被调用的 API 确定知道会抛出非 `Error` 来违反上述规则，否则异常处理程序**禁止**防御性地处理非 `Error` 类型。在这种情况下，应包含注释以特别识别非 `Error` 的来源。

**[Compliant]**

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

### 类与字段初始化

##### CL.03 类字段初始化 / readonly / 禁 #private [Required]

**[Description]**

用 `readonly` 修饰符标记在构造函数外部从不重新赋值的属性。不要使用私有字段（`#ident`），应使用 TypeScript 可见性注解。如果类成员不是参数，在声明处初始化它。属性在构造函数完成后不应添加或删除实例，稍后可能填充的可选字段应显式初始化为 `undefined` 以防止后续 shape 变化。不要通过类成员引入明显的初始化器，而是使用 TypeScript 的 parameter property（`constructor(private readonly barService: BarService) {}`）。

##### CL.04 可见性（默认 public，不写 public 修饰符）[Required]

**[Description]**

TypeScript 符号默认是 public。除非要声明非只读 public 参数属性，否则不要使用 `public` 修饰符。限制属性、方法和整个类型的可见性有助于保持代码解耦。代码**禁止**使用 `obj['foo']` 绕过属性的可见性。

### 异步控制流与状态更新

##### CS.02 switch 必须有 default 且禁 fall-through [Required]

**[Description]**

所有 `switch` 语句**必须**包含一个 `default` 语句组，即使它不包含代码。`default` 语句组必须放在最后。非空语句组（`case ...`）**禁止** fall through。空的语句组允许 fall through。

##### CS.03 优先 for-of 遍历 [Required]

**[Description]**

优先使用 `for (... of someArr)` 遍历数组；需要索引时可用 `for (... of arr.entries())`。`for`-`in` 仅用于字典样式对象，不要用于数组。

##### OB.01 对象展开（不可变状态更新）[Required]

**[Description]**

使用展开语法 `{...bar}` 创建对象浅拷贝；后面值替换同键较早值。被展开的值**必须**与创建内容匹配——创建对象时只展开对象，禁止展开数组与原始类型（含 `null`/`undefined`）。

##### FN.02 箭头函数简洁体 vs 块体 [Required]

**[Description]**

只有当函数的返回值实际被使用时，才使用简洁体。块体确保返回类型是 `void` 并防止潜在的副作用。

### 模块与导入导出

##### MD.01 命名导出（禁止默认导出）[Required]

**[Description]**

所有代码中使用命名导出（`export class Foo { ... }`），不要使用默认导出。命名导出在导入语句尝试导入未声明的内容时会报错。

##### MD.02 import type / export type [Required]

**[Description]**

当仅将导入的符号用作类型时，使用 `import type {...}`；对值使用常规导入。重新导出类型时使用 `export type`。

##### MD.03 用模块而非 namespace、禁止 require [Required]

**[Description]**

代码**必须**使用 `import {foo} from 'bar';` 形式引用其他文件中的代码；**禁止**使用 `namespace` 结构与 `require`（`import x = require('...')`）。

### 命名

##### NM.01 描述性名称 [Required]

**[Description]**

名称**必须**具有描述性，不使用含义模糊的缩写，不删除单词内部字母缩写（如 `customerId` 而非 `cstmrId`/`customerID`）。标识符只用 ASCII 字母、数字、下划线与美元符号。

##### NM.02 camelCase 与常量 CONSTANT_CASE [Required]

**[Description]**

class/interface/type/enum 用 `UpperCamelCase`；变量/函数/方法/属性/模块别名用 `lowerCamelCase`；模块级别常量与枚举值用 `CONSTANT_CASE`。类型信息不应出现在名称中，禁止下划线前缀/后缀与 `opt_` 前缀。

### 注释与文档

##### CM.01 顶层导出需 JSDoc [Required]

**[Description]**

使用 `/** JSDoc */` 注释向代码用户传达信息。模块的所有顶层导出必须文档化；类的 JSDoc 应为读者提供足够信息了解如何使用类。

##### CM.02 方法注释第三人称动词短语 [Required]

**[Description]**

方法描述以描述方法作用的动词短语开头，以第三人称书写（隐含"此方法 …"）。`@param`/`@return` 仅在添加信息时使用，避免只重复参数名称和类型。

##### CM.03 JSDoc 类型注解冗余 [Required]

**[Description]**

JSDoc 类型注解在 TypeScript 源代码中是冗余的，禁止在 `@param`/`@return` 块中声明类型。

### 代码风格与一致性

##### ST.01 核心风格（缩进/分号/引号/日志/行数）[Required]

**[Description]**

TypeScript 缩进必须 2 空格；使用单引号；显式使用分号；禁止 console.log，通过 logger 输出。类、export 方法必须要有 JSDoc。文件行数：普通业务文件 300-500 行，类文件 200-300 行，大型模块不超过 800 行。

##### PL.01 一致性 [Required]

**[Description]**

对规范未明确解决的风格问题，与同一文件已有代码保持一致；新文件必须使用 Google 风格。避免机会主义风格修复干扰变更焦点。

## 3. Security & production notes

- **TA.02 / TA.04**：`executedSteps as unknown as ExecutedStepDefault[]` 双重断言在 recovery-01 中用于将持久化 JSON 反序列化为结构化类型（recoverInstance 从 state 表读回快照重建内存态），必须经 `unknown` 中转，并在断言处附说明注释；若能从 schema 推断类型，优先用 Zod parse 做运行时校验替代断言。
- **EX.02 / EX.03**：`SandoreError` 必须继承自 `Error`（实际继承 `HarnessError`）；async 方法（retryStep/recoverInstance/recoverOrphanedInstances）拒绝 Promise 时只能 `reject(new SandoreError(...))`，以保证 `catch` 中 `e.code` 路由（NODE_NOT_FOUND/INVALID_OPERATION/STEP_EXECUTION）能安全读取 `Error` 实例的 code 字段。recoverOrphanedInstances 逐实例 try/catch 聚合 `{ recovered, errors }` 时，单实例失败 SHALL NOT 阻断其他实例，且空 catch 需注释说明。
- **TS.01 / TT.01**：禁止用 `@ts-ignore` 压制恢复逻辑的类型错误；对未检查的持久化数据（state 表快照、fork 的 boundary 计算）用 `unknown` + 窄化，或按规范加注释后的受控转换，而非引入 `any`。
- **CL.03**：`instances` Map / 恢复后重建的 `pausedChildIds` Set 等类字段在声明处初始化；不会被重新赋值的字段加 `readonly`（ActiveInstance 的 controller/session/hostAgent/definition/interactions/lifecycle 五字段 readonly，仅 state 可变）。
- **CS.02 / retryStep 三模式**：retryStep 若用 switch 分发 continue/revert/fork，必须带 `default` 分支且非空 case 不得 fall-through；revert 的 boundary 计算（最后一个闭合 turn 末事件 seq，不得落未闭合 turn，透传 DSH OPEN_TURN 类错误）的 for-of 遍历优先。
- **OB.01 / 状态不可变更新**：每次状态变化以 `active.state = { ...active.state, ... }` 不可变重建后再 persistState（全文件一致）；revert/fork 更新 `sessionMeta.childId` 新值 + 记录 `parentSessionId` 旧值、追加 `retryHistory` 记录时沿用同一范式。
