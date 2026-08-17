# Furina CleanCode — 编码规范探索结果

## Explore Content

为 sandore 工作流引擎的 6 个 `step-*` Session 事件 payload（step-start / step-completed / step-failed / step-paused / step-resumed / step-retried）补充 `name` 与 `loopIteration` 字段的参考实现；涉及 workflow 包（workflow-engine.ts、seam.ts、types.ts、schema.ts、lifecycle-manager.ts、recovery-manager.ts、dag-navigator.ts）与 microflow 包（stage-executor.ts、loop-manager.ts）的类型声明、私有方法签名扩展、回调闭包扩展与双声明同步。

## Explore Type

cleancode

## Primary Language

TypeScript（项目源文件为 `.ts`，采用 zod/schemastery 双 schema 体系 + Cordis 插件架构 + vitest 集成测试）

---

## 1. Scope

- **Requirement summary**: 为 6 个 `step-*` 事件 payload 同步追加 `name`（string）与 `loopIteration?`（number[]）字段，覆盖 Cordis `Events` 位置参数、`SessionEventMap` 对象字段、`emit*` 函数签名与 hooks/管理器调用点。
- **Code features affected**: 类型/接口字段追加、类私有方法签名扩展、可选字段与数组类型、回调箭头函数、双声明一致性、JSDoc。

## 2. Guidelines

### 事件 payload 类型声明（seam.ts 双声明）

- **Prefer interfaces over type literal aliases [Recommended]** — 对象类型（`SessionEventMap` 事件 payload）使用 interface 而非对象字面量类型别名；`SessionEventMap` 已是 interface，保持该形式。
- **Use structural types [Recommended]** — 在符号声明处显式标注类型以获得更精确的类型检查；新增字段时保持声明处显式类型。
- **`Array<T>` Type [Required]** — 简单类型数组使用 `T[]` 语法糖而非 `Array<T>`；`loopIteration` 声明为 `number[]`。
- **Prefer optional over `|undefined` [Recommended]** — 可选字段使用 `?` 而非 `|undefined`；`loopIteration` 声明为 `loopIteration?: number[]`（与 `ExecutedStepDefault.loopIteration` 现状一致）。
- **Type inference [Recommended]** — 简单类型（string/number/boolean）可省略注解，复杂表达式可加注解。
- **Return types [Recommended]** — 方法返回类型注解由作者决定；本次涉及的私有 void 方法保持现状。
- **`any` Type [Required]** — 避免使用 `any`；不因新增字段引入 `any` 或额外 `as unknown as` 断言。

### emit 函数签名与调用点

- **Prefer passing arrow functions as callbacks [Required]** — 回调显式转发参数而非直接传命名函数引用；hooks/管理器回调已是箭头函数显式转发，扩展时保持一致。
- **Arrow function bodies [Required]** — 返回值未被使用时使用块体而非简洁体，防止返回值泄漏。
- **Object literals — spread syntax [Required]** — 条件展开的对象必须保证展开的是对象；沿用现有 `...(x === undefined ? {} : { x })` 条件展开模式。
- **Class method declarations / Visibility [Required]** — 类方法声明之间以单个空行分隔；保持 `private` 可见性不变，不额外使用 `public` 修饰符。

### 命名

- **标识符 / 命名风格 [Required]** — 类型信息不出现在名称中；不使用下划线前后缀；`name`/`loopIteration` 均符合 lowerCamelCase。
- **描述性名称 / Camel case [Required]** — 字段名描述清晰；缩写视为整词。

### 注释与文档

- **Document all top-level exports of modules [Recommended]** — 模块顶层导出（含 `seam.ts` 的 `SessionEventMap` 事件声明）应文档化；仅在名称/类型不显而易见时补充，避免重复名称与类型。
- **Make comments that actually add information [Required]** — 注释必须提供实际信息；新增 `loopIteration` 的语义注释（如「嵌套迭代路径」）应说明含义而非复述 `number[]`。

### 一致性

- **Consistency [Required]** — 未明确解决的风格问题与同文件现有代码保持一致（如 `emitStepResumed` 的条件展开、payload 字段排列顺序、双声明中 Events 与 SessionEventMap 的字段顺序对应）。
- **Core style（typescript-core-style）[Required]** — 2 空格缩进、单引号、显式分号、禁止 `console.log`（经 `ctx.logger` 输出日志）。

## 3. Security & production notes

- **双声明一致性（Use structural types / Consistency）** — `seam.ts` 中 Cordis `Events`（位置参数）与 `SessionEventMap`（对象字段）是同一事件的两份声明，任一漂移都会导致编译期类型错误。新增 `name`/`loopIteration` 时必须两处同步，且 `workflow-engine.ts` 中对应 `emitContained([...])` 与 `session.append({...})` 的实参顺序/字段与之严格一致。
- **loopIteration 可空语义（Prefer optional over `|undefined`）** — `loopIteration` 仅循环体内 Step 存在，非循环 Step 为 `undefined`；emit 时沿用「条件展开省略」模式，避免向非循环 Step 事件写入空数组造成语义污染。
- **测试兼容性（现有断言为位置参数索引）** — 若在 `Events` 声明中间插入新位置参数会破坏 `workflow-engine.spec.ts` / `lifecycle-manager.spec.ts` 中 `args[n]` 索引断言；追加到末尾则保持现有断言不变。
