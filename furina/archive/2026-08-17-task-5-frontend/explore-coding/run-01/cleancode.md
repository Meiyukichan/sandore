# Cleancode 探索结果 — RunView 组件编码规范

## Explore Content

新增 sandore `ui` 包的 RunView 组件（执行轨迹只读视图 + 产物面板 + 交互控件 + 打开讨论），复用 `@deepseek-ai/dsh-sandore-workflow` 的 wire 类型与 DSH `ui-primitives`/`ui-user-questions` 组件，遵循 sandore ui 包现有组件范式（`PropsRuntime`/`InjectFace`/`PropsLocale` 组合、`locales.ts` 字典、css-modules）。

## 需求理解（Phase 1）

### What
在 `packages/sandore/ui` 包新增一个 React 组件 RunView：只读展示工作流实例的执行轨迹（executedSteps/stageInfos）与产物（ArtifactEntry），并提供交互控件（pause/resume/retry/abort/reply 问答/reply 权限）与「打开讨论」跳转入口。

### Boundaries
范围限定于 sandore `ui` 包内（`packages/sandore/ui/src/client/*`），复用 `@deepseek-ai/dsh-sandore-workflow` 的 wire 类型、DSH 的 `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-user-questions`/`ui-conversation` 的交互复用组件，不涉及引擎侧实现改动。

### Goal
获取 RunView 组件实现的编码规范依据：TypeScript 类型安全（wire 数据渲染、RPC 错误处理）、模块导出规范、组件/Props/locales/css-modules 的命名与结构约定。

### Code Characteristics
- 目录：`packages/sandore/ui/src/client/`（现有 `WorkflowButton.tsx`/`WorkflowPanel.tsx`/`DagEditor.tsx`/`remote.ts`/`locales.ts`/`sandore-save.ts` 及对应 `*.module.css`）
- 构造：React 函数组件（`export function Xxx()`）、Props/Face 接口、判别联合状态（`kind` 字段）、css-modules、locales 字典、JSDoc
- 依赖：`@deepseek-ai/dsh-sandore-workflow`（wire 类型 + `remote.ts` 的 `unwrap`/`SandoreRemoteError`）、`@deepseek-ai/dsh-client-ui-primitives`（Button/StateDot/DisclosureRow/Pill/Modal/CodeBlock 等）、`@deepseek-ai/dsh-client-ui-slots`（`PropsRuntime`/`InjectFace`/`PropsLocale`/`TranslateNS`）
- 框架/范式：TypeScript + React 18 + cordis client 插件；`inject` 数组声明服务依赖；`ctx.effect`/`ctx.slots.register` 装配

## 主语言判定（Phase 2）

- TypeScript/TSX 文件：70（`packages/**/*.ts`、`*.tsx`）
- Python 文件：0

主语言为 **TypeScript**，采用 `clean-ts` 规范。

## 编码规范（Phase 3 — furina-cleancode 结果）

### 1. Scope

- **Requirement summary**：在 sandore ui 包新增 RunView 组件（执行轨迹只读视图 + 产物面板 + 交互控件 + 打开讨论），复用 workflow 包 wire 类型与 DSH ui-primitives/ui-user-questions 组件，遵循现有组件范式。
- **Code features affected**：React 函数组件；Props/Face 接口与判别联合状态；`import type`/`export type` wire 类型复用；locales 字典；css-modules；JSDoc；RPC 错误处理；无障碍属性。

### 2. Guidelines

#### wire 类型复用与类型安全

##### SAFE-01 `any` 类型 [Recommended]
避免使用 `any`。需要表示「未知」时用 `unknown`；用类型守卫缩小后才能安全使用。用声明的 interface 表示服务端 JSON。
```ts
const val: unknown = value;

declare interface MyUserJson {
  name: string;
  email: string
}
```

##### SAFE-02 类型断言与非空断言 [Recommended]
类型断言（`x as SomeType`）与非空断言（`y!`）不安全，仅在原因明确时使用；断言必须用 `as` 语法。渲染 wire 数据（如 `ExecutedStepDefault.error?`/`output?`、`ArtifactEntry.returnPrompt?`）时禁止用 `!`/`as` 断言存在，应做运行时守卫（`=== undefined` 判断或条件渲染）。
```ts
if (x instanceof Foo) {
  x.foo();
}

if (y) {
  y.bar();
}

// z must be Foo because ...
const x = (z as Foo).length;
```

#### 交互控件的 RPC 错误处理

##### SAFE-03 异常处理：仅抛 Error、捕获按 unknown + instanceof [Required]
实例化异常用 `new Error()`（或 `Error` 子类）；捕获时 `catch (e: unknown)` 并按 `instanceof Error` 处理，不防御性处理非 `Error` 类型（除非被调 API 明确会抛非 `Error`，此时加注释说明来源）。交互控件（回复问答/暂停/恢复/重试）RPC 失败统一经 `unwrap`/`SandoreRemoteError` 抛出，捕获分支按 `error instanceof Error` 处理，不静默吞错。
```ts
throw new Error('oh noes!');
// ... or subtypes of Error.
class MyError extends Error {}
throw new MyError('my oh noes!');
```
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

#### 模块与导入导出

- **MOD-01 命名导出，禁止默认导出 [Required]**：仅用命名导出（`export function`/`export interface`），禁止 `export default`。
- **MOD-02 导出可见性最小化 [Recommended]**：只导出模块外部真正使用的符号。
- **MOD-03 import type / export type [Recommended]**：仅作类型使用的导入用 `import type {...}`，类型重新导出用 `export type`。
- **MOD-04 使用 ES 模块 [Required]**：禁止 `namespace` 与 `import x = require(...)`。
- **MOD-05 相对导入优先 [Recommended]**：同项目内优先相对导入（`./x`）。

#### 组件、Props 与类型定义

- **FUNC-02 命名函数使用函数声明 [Recommended]**：命名函数（含 React 组件）优先 `export function RunView(...)` 而非箭头函数。
- **FUNC-03 箭头函数体 [Recommended]**：返回值被使用时才用简洁体；返回 `void` 时用块体。
- **FUNC-04 优先传箭头函数作回调 [Recommended]**：回调显式转发参数，避免具名函数直接作回调。
- **TYP-01 接口优于类型字面量别名 [Recommended]**：Props/Face 等对象结构类型用 `interface`。
- **TYP-02 类型推断 [Recommended]**：简单类型可省略注解；复杂表达式（RPC 解包结果）加注解。
- **TYP-03 可选字段 [Recommended]**：类型别名禁止包含 `|null`/`|undefined`；优先 `?` 可选字段。
- **TYP-04 Array 语法糖 [Recommended]**：简单类型用 `T[]`/`readonly T[]`。
- **TYP-05 索引签名 / Record [Recommended]**：字典用索引签名或 `Record<K, V>`（如 `Record<string, string>`、`Record<SandoreKey, string>`）。
- **TYP-06 避免 `{}` 类型 [Recommended]**：改用 `unknown`、`Record<string, T>` 或 `object`。
- **TYP-07 禁止包装器类型 [Required]**：禁止 `String`/`Boolean`/`Number`，用原始类型。
- **TYP-08 结构类型声明处显式注解 [Recommended]**。
- **FUNC-01 const/let 与单声明 [Required]**：默认 `const`，禁 `var`；每行一个声明。
- **FUNC-05 对象字面量与展开 [Required]**：禁止 `Object`/`Array` 构造函数。
- **FUNC-06 单引号与模板字面量 [Required]**。
- **FUNC-07 控制结构与 for-of [Required]**：控制流必须用大括号；遍历数组优先 `for...of`。
- **FUNC-08 严格相等 [Required]**：用 `===`/`!==`。
- **FUNC-09 try 块精简 [Recommended]**：空 catch 块须加解释注释。

#### 命名规范

- **NAM-01 描述性名称 [Required]**：名称必须描述性，不删词、不用陌生缩写。
- **NAM-02 大小写规则 [Recommended]**：`UpperCamelCase`：interface/type/TSX 组件函数；`lowerCamelCase`：变量/函数/属性/参数。
- **NAM-03 CONSTANT_CASE 常量 [Recommended]**：模块级常量值（如 `NS`、`PLACEHOLDER_ROWS`）用 `CONSTANT_CASE`。

#### locales 字典与文档注释

- **DOC-01 JSDoc 与普通注释 [Recommended]**：文档化用 `/** JSDoc */`，实现注释用 `//`。
- **DOC-02 文档化所有顶层导出 [Recommended]**：顶层导出（组件、接口、字典键类型）都应文档化。
- **DOC-03 JSDoc 类型注解冗余禁止 [Required]**：JSDoc 中禁止重复声明 TS 类型（`@param`/`@return` 不加类型）。
- **DOC-04 注释需提供实际信息 [Recommended]**。

#### 文件头与核心风格

- **STY-05 文件头 JSDoc [Recommended]**：文件头 `/** ... */` 说明用途，可带 `@module`。
- **STY-01 2 空格缩进 [Required]**。
- **STY-02 单引号 [Required]**。
- **STY-03 显式分号 [Required]**。
- **STY-04 禁止 console.log [Required]**。
- **STY-06 组件文件 200-300 行 [Recommended]**。

#### 策略

- **POL-01 与现有代码保持一致 [Required]**：未明确解决的风格问题与同文件/同目录现有代码一致。
- **POL-02 重新格式化现有代码 [Recommended]**：避免机会主义风格修复。

### 3. Security & production notes

- **SAFE-02**：渲染 wire 数据（`ExecutedStepDefault` 的 `error?`/`output?`、`ArtifactEntry` 的 `returnPrompt?` 等可选字段）时禁止用 `!`/`as` 断言存在，做运行时守卫，避免只读视图在数据缺失时崩溃。
- **SAFE-01**：复用 workflow 包 wire 类型时，不因桥接 `exactOptionalPropertyTypes` 与 zod `.optional()` 差异退化为 `any`；沿用 `remote.ts` 的文档化 `as` 收窄并加原因注释。
- **SAFE-03**：交互控件 RPC 失败统一经 `unwrap`/`SandoreRemoteError` 抛出，捕获按 `error instanceof Error` 分支，不静默吞错。

## 现有范式印证（供编码参考）

- **Props 组合范式**：`WorkflowButton.tsx` 用 `PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`；`WorkflowPanel.tsx` 用最小业务 face（`t: TranslateNS<'sandore'>` + 解包后的 `ping(): Promise<PingResponse>`）。
- **locales 范式**：`locales.ts` 用 `export const NS = 'sandore'`、`export const zh = {...} satisfies Record<string, string>`、`export type SandoreKey = keyof typeof zh`，`declare module '@deepseek-ai/dsh-client-ui-slots'` 扩充 `LocaleNamespaceMap`，`en` 用 `satisfies Record<SandoreKey, string>` 保证逐键对齐。
- **文件组织范式**：组件文件以 `/** 文件用途 */` 头注释 + `import css from './X.module.css'` + `export function` 命名导出；判别联合状态用 `{ readonly kind: 'idle' | 'pending' | 'ok' | 'error' ... }`。
- **wire 类型来源**：`@deepseek-ai/dsh-sandore-workflow` 根入口 `export type * from './types.ts'`、`export * from './schema.ts'`、`export * from './remote.ts'`，可直接导入 `DagInstanceState`/`ExecutedStepDefault`/`StageInfo`/`StageContract`/`StepStatus`/`DagRunStatus`/`AskUserQuestionPayload`/`PendingQuestionEntry`/`PendingPermissionEntry`/`ArtifactEntry` 等类型。
- **RPC 解包范式**：`remote.ts` 暴露 `unwrap<T>(result: RemoteResult<T>): T` 与 `SandoreRemoteError`（保留 `code`/`details`），组件层统一解包、失败抛错。
