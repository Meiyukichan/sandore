# CleanCode 探索结果 — session-01（session-management）

> 探索类型：cleancode（clean-ts）
> 探索目标：实现会话管理核心——SessionState（`src/session-state.ts`）与 SessionManager（`src/session.ts`）+ `test/session.test.ts`
> 语言：chinese

---

## 0. 项目技术基线核查（本次探索的实地发现）

以下为本次探索实际读取到的项目事实源，供实现 session-01 时作为技术基线与字段约束依据。

### 0.1 当前实现进度

- `infra-01` 已完成：根级 `pnpm-workspace.yaml`（`packages: ['packages/*', 'packages/sdk/*']` + `allowBuilds.esbuild`）、根 `package.json`（private、type: module）、`tsconfig.base.json`（ES2022/ESNext/bundler/strict/skipLibCheck）均已存在。
- `packages/sdk/claude/src/types.ts` 已存在（7.7KB），导出了 `SessionV2Info`、`SessionMessagesResponse`、`SessionMessage`、`PromptInput`、`SessionInputAdmitted`、`ModelRef`、`LocationRef`、`LocationInfo`、`ModelV2Info`、`GlobalEvent`、`TokenUsage`、`Cost` 及错误类型（`SessionNotFoundError`、`TimeoutError`、`InvalidRequestError`、`ClaudeSDKError`）。
- `packages/sdk/claude/test/types.test.ts` 已存在（vitest + expectTypeOf 断言类型）。
- `src/session-state.ts`、`src/session.ts`、`test/session.test.ts` **尚未创建**（session-01 的任务）。
- `packages/sdk/claude/package.json`：`type: "module"`，`@anthropic-ai/claude-agent-sdk` 为 **peerDependency**（`>=0.3.0`，消费者提供），`typescript`、`vitest` 为 devDependency；`scripts.test = "vitest run"`、`scripts.typecheck = "tsc --noEmit"`。
- `packages/sdk/claude/tsconfig.json`：`extends: "../../../tsconfig.base.json"`，`include: ["src", "test"]`。

### 0.2 @anthropic-ai/claude-agent-sdk 关键类型（scripts/node_modules 实际安装 v0.3.227）

- `query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query` —— `prompt` 传 `AsyncIterable` 即流式输入模式（多轮持久会话）。
- `Query extends AsyncGenerator<SDKMessage, void>`，控制方法（仅流式输入模式可用）：`interrupt(): Promise<SDKControlInterruptResponse | undefined>`、`setModel()`、`setPermissionMode()`；另有 `supportedModels()`、`initializationResult()` 等。
- `SDKUserMessage`：`{ type: 'user'; message: MessageParam; parent_tool_use_id: string | null; isSynthetic?; priority?; origin?; shouldQuery?; timestamp?; uuid?; session_id?; ... }`。
- `SDKSystemMessage`（subtype='init'）：`{ type: 'system'; subtype: 'init'; session_id: string; uuid; cwd; model; tools; capabilities?: string[]; ... }` —— session_id 在此捕获。
- `SDKPartialAssistantMessage`（type='stream_event'）：`{ event: BetaRawMessageStreamEvent; parent_tool_use_id: string | null; uuid; session_id; ttft_ms? }`（需 `includePartialMessages: true`）。
- `SDKResultMessage = SDKResultSuccess | SDKResultError`：success 含 `total_cost_usd`、`usage`、`modelUsage`、`result`、`stop_reason`、`num_turns`、`session_id`、`uuid`；error 含 `subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`、`errors: string[]`。
- `SDKSessionStateChangedMessage`（type='system', subtype='session_state_changed'）：`{ state: 'idle' | 'running' | 'requires_action'; uuid; session_id }` —— wait() 判定空闲的关键事件。
- `SDKMessage` 联合：`SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | ...`（40+ 种，后台泵需按 type/subtype 判别）。
- `getSessionMessages(_sessionId: string, _options?: GetSessionMessagesOptions): Promise<SessionMessage[]>`；`GetSessionMessagesOptions = { dir?; limit?; offset?; includeSystemMessages?; sessionStore? }`。
- `SessionMessage`（SDK 返回）：`{ type: 'user' | 'assistant' | 'system'; uuid; session_id; message: unknown; parent_tool_use_id: string | null; parent_agent_id: string | null }`。
- `Options` 关键字段：`agent?: string`、`cwd?: string`、`includePartialMessages?: boolean`、`resume?: string`、`continue?: boolean`、`forkSession?: boolean`、`maxTurns?: number`、`permissionMode?: PermissionMode`、`allowedTools?: string[]` 等。

### 0.3 scripts/conversation.ts 流式输入模式（参考蓝本）

- 输入队列：模块级 `pending: SDKUserMessage[]` + `wake` 回调；`enqueueUserMessage(text)` push `{ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }` 并调用 `wake?.()`。
- 无限生成器：`async function* chatStream()` 中 `while (pending.length === 0) { await new Promise(resolve => { wake = resolve; }); wake = null; } yield pending.shift()!;` —— **永不完结**，由 `close()` 终止。
- 创建会话：`const q = query({ prompt: chatStream(), options: { cwd, resume?, includePartialMessages: true, maxTurns, allowedTools } })`。
- init 捕获：`for await (const message of q)` 中 `case 'system': if (message.subtype === 'init') { sessionId = message.session_id; }`。
- 消费：`stream_event`（message_start/content_block_start/content_block_delta/content_block_stop）、`assistant`（完整消息）、`result`（subtype/duration/total_cost_usd）。
- 结束：`q.close()` + `rl.close()` + `await consume`。

### 0.4 design.md 关键决策（session-01 相关）

- **D2 一体化解耦**：`session.create()` 后台启动 `query({ prompt: inputQueue, options: { includePartialMessages: true } })`；首条 `system/init` 产出后 resolve SessionV2Info（session_id 捕获）；`prompt()` 向 inputQueue push SDKUserMessage；事件推入 sessionEvents 通道。SessionState = `{ query, sessionId, inputQueue, eventsChannel }`。
- **D5 暂停语义**：`interrupt()` → `Query.interrupt()`；`wait()` → 基于结果消息/状态变更事件驱动，避免高频轮询，超时退出。
- **D7 ID 映射**：保留 Claude 原始 session_id 作为 `SessionV2Info.id`（不做 `^ses` 前缀转换，需用于 resume/getSessionMessages）；message/part/event ID 在归一化时按 `msg_`/`prt`/`evt_` 前缀生成（event-01 负责归一化，session-01 只生成 prompt 的 `msg_` 前缀 id）。
- 风险条目：session.create() 启动延迟 → Promise 在 init 时 resolve + 超时保护；wait() 轮询效率 → 结果消息/状态变更事件驱动；interrupt 前置条件 `interrupt_receipt_v1` 能力，无能力时降级为 close()；并发会话 → Map 隔离无共享可变状态。

### 0.5 specs/session-management 约束（session-01 覆盖的全部 Requirement）

- **Create session**：create() 后台启动 query()（流式输入模式），从首条 system/init 的 session_id 捕获会话 ID；返回 SessionV2Info 必含 `id`、`projectID`、`time`、`title`、`location`、`cost`、`tokens`；`location.directory` 等于客户端 cwd；create({ agent }) 将 agent 透传 query() options 且 SessionV2Info 含该值；init 超时 reject 抛超时错误。
- **Read session messages**：messages(sessionId, options?) 返回 SessionMessagesResponse `{ data, cursor: { previous?, next? } }`；内部调用 `getSessionMessages()`。
- **Send message (prompt)**：prompt(sessionId, input) 向该会话输入队列 push `{ type:'user', message:{role:'user', content:text}, parent_tool_use_id:null }`；返回 SessionInputAdmitted（`id` 以 `msg_` 前缀，含 sessionID/prompt/delivery/timeCreated）；不存在会话抛 SessionNotFoundError。
- **Interrupt**：interrupt(sessionId) 调用 `Query.interrupt()`；空闲会话为 no-op（不抛错）。
- **Wait**：wait(sessionId, options?) 等待 agent loop 空闲后 resolve；支持 timeout 参数，超时 reject 抛超时错误。
- **Session state management**：后台维护 `Map<sessionId, SessionState>`；并发会话状态隔离；close() 关闭 Query、事件通道结束、从 Map 移除。

### 0.6 types.ts 现有错误类型（错误抛出形态约束）

`SessionNotFoundError`/`TimeoutError`/`InvalidRequestError` 均为 `_tag` 判别联合的**接口**（非 Error 子类），`ClaudeSDKError` 为三者联合。`TimeoutError` 含 `message`（必填）+ `timeoutMs?`（可选）；`SessionNotFoundError` 含 `sessionID`（必填）+ `message`。

---

## 1. Scope（furina-cleancode 编码指南）

- **Requirement summary**: 实现会话管理核心：SessionState（`src/session-state.ts`）封装每个会话的 Claude SDK Query 句柄、流式输入队列（push/yield）、SDKMessage 事件通道（原始通道，回放型广播，归一化由 event-01 负责）与后台 query 泵；SessionManager（`src/session.ts`）维护 `Map<sessionId, SessionState>`，实现 create/messages/prompt/interrupt/wait/close 方法集。
- **Code features affected**: 类定义（SessionState/SessionManager）、异步流（AsyncGenerator/AsyncIterable 输入队列、push/yield）、并发状态管理（Map、后台 query 泵、Promise resolve/reject、超时保护）、SDKMessage 事件通道、_tag 判别联合错误（SessionNotFoundError/TimeoutError/InvalidRequestError）、`import type` 类型导入（src/types.ts 与 claude-agent-sdk）、vitest 测试。

## 2. Guidelines

### 错误处理（异常）

### LF.EXCEPTION-ONLY 只抛 Error [Required]

**[Description]**
JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。

**[Compliant]**
```ts
throw new Error('oh noes!');
class MyError extends Error {}
throw new MyError('my oh noes!');
Promise.reject(new Error('oh noes!'));
```

### LF.EXCEPTION-NEW 使用 new 实例化错误 [Required]

使用 `new Error()` 实例化异常，而非仅调用 `Error()`；`new` 与其他对象实例化方式更一致。

### LF.CATCH 捕获错误时假设是 Error 实例 [Required]

捕获错误时假设所有抛出错误都是 `Error` 实例；除非被调用的 API 确定知道会抛出非 `Error`，否则异常处理程序禁止防御性处理非 `Error` 类型。

### LF.EMPTY-CATCH 空 catch 块必须注释 [Required]

当确实适合在 catch 块中完全不采取行动时，应在注释中解释正当理由；不允许无注释的空 catch。

### LF.TRY-FOCUSED try 块保持精简 [Required]

在不损害可读性前提下限制 try 块内代码量，将非抛出行移出 try/catch。

### 类定义与结构（SessionState / SessionManager）

### LF.CLASS-DECL 类声明禁止以分号结尾 [Required]

类声明禁止以分号结尾；包含类表达式的语句（如 `export const Baz = class ...`）必须以分号结尾。

### LF.CLASS-METHOD 类方法声明禁止分号 [Required]

类方法声明禁止用分号分隔；方法声明用单个空行与周围代码分隔。

### LF.PRIVATE 禁止 #private 字段 [Required]

不要使用 `#private` 私有字段（私有标识符），改用 TypeScript 可见性注解（`private ident = 1`）。

### LF.READONLY 使用 readonly [Required]

用 `readonly` 修饰符标记在构造函数外部从不重新赋值的属性——如 SessionState 的 Query 句柄。

### LF.PARAM-PROP 参数属性 [Required]

不要通过类成员引入明显初始化器，使用 TypeScript parameter property（如 `constructor(private readonly query: Query) {}`）；参数属性需文档说明时用 `@param` JSDoc。

### LF.FIELD-INIT 字段声明处初始化 [Required]

非参数的类成员在声明处初始化（`private readonly pending: SDKUserMessage[] = []`）；构造完成后属性不应增删，稍后填充的可选字段应显式初始化为 `undefined`。

### LF.GETSET getter 必须是纯函数 [Required]

getter 必须是纯函数（结果一致且无副作用）；避免仅为隐藏属性定义"直通"访问器。

### LF.VIS 限制可见性 [Required]

尽可能限制符号可见性；TS 符号默认 public，除非声明非只读 public 参数属性，否则不要使用 `public` 修饰符；考虑将私有方法转为文件内类外部的非导出函数。

### 异步流与输入队列（push/yield）

### LF.FUNC-DECL 命名函数优先函数声明 [Required]

定义命名函数时优先函数声明而非箭头函数/函数表达式；箭头函数可用于需要显式类型注解等场景。

### LF.ARROW-BODY 箭头函数体 [Required]

根据返回值是否使用决定简洁体或块体：返回值实际被使用时用简洁体；未使用（如回调产生副作用）用块体，必要时用 `void` 确保不泄漏返回值。

### LF.NO-FUNC-EXPR 不要使用函数表达式 [Required]

不要使用 `function` 表达式，用箭头函数代替（异常：需动态重绑 `this` 或生成器函数无箭头语法）。

### LF.CALLBACK 优先传递箭头函数作为回调 [Required]

避免将命名回调直接传给高阶函数（可选参数可能被意外传入导致逻辑错误）；优先传显式转发参数的箭头函数。

### LF.ARROW-PROP 类通常不应含箭头函数属性 [Required]

类通常不应包含初始化为箭头函数的属性；应始终用箭头函数调用实例方法，不应获取/传递实例方法引用（事件处理程序需卸载时属例外）。

### LF.EVENT-HANDLERS 事件处理程序 [Required]

当不需要卸载处理程序时（事件由类自身发出）可用匿名箭头函数；需要卸载时用箭头函数属性（自动捕获 `this` 并提供稳定卸载引用）；不要在安装表达式中用 `bind`。

### LF.GEN 生成器格式化 [Required]

生成器将 `*` 附加到 `function` 和 `yield` 关键字（`function* foo()`、`yield* iter`），而非 `function *foo()` / `yield *iter`；rest/展开 `...` 后不加空格。

### LF.ITER 迭代容器 [Required]

优先用 `for (... of someArr)` 遍历数组；`for-in` 只能用于字典样式对象且需 `hasOwnProperty` 过滤；优先 `for-of` 配 `Object.keys/values/entries`。

### 并发与状态管理（Map / Promise / 超时）

### T.INDEX 索引签名 [Required]

对象作为关联数组用索引签名 `{[k: string]: T}` 且键标签有意义；**考虑使用 ES6 `Map`/`Set` 而非对象**——JS 对象有不良行为，`Map` 可用非 string 键。会话表 `Map<sessionId, SessionState>` 即此规则倡导的形态。

### LF.CONTROL 控制流语句使用大括号 [Required]

`if/else/for/do/while` 等总是用大括号包围体，即使只有单条语句；单行 `if` 可省略大括号属例外；避免在控制语句中赋值。

### LF.EQ 严格相等 [Required]

始终使用 `===`/`!==`；双等会导致易错类型强制转换（与字面量 `null` 比较用 `==` 覆盖 null/undefined 属例外）。

### LF.SWITCH switch 语句 [Required]

所有 switch 必须含 `default` 组且置于最后；每个语句组须以 `break`/`return`/抛异常突然终止，非空组禁止 fall through（空组允许 fall through）。

### 类型系统

### T.ANY 避免 `any`，使用 `unknown` [Required]

**[Description]**
TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。

**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型、使用 `unknown`、抑制 lint 警告并记录原因。

`any` 类型允许赋值到任何其他类型并取消引用其上的任何属性。通常这种行为不是必要或期望的，代码只需要表达类型是未知的。在那种情况下使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。

**[Compliant]**
```ts
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

### T.IFACE 接口优于类型字面量别名 [Required]

声明对象类型时使用接口而非对象字面量表达式的类型别名；两者几乎等价，但接口工具支持更好。

### T.STRUCT 使用结构类型 [Required]

TS 类型系统是结构化的；在符号声明处显式包含类型（`const foo: Foo = {...}`），用接口定义结构类型而非类——利于精确类型检查与跨代码库接口变更时的错误报告（_tag 判别联合即结构化类型）。

### T.OPT 优先使用可选而非 `|undefined` [Required]

使用 `?` 可选参数/可选字段（接口或类上）而不是 `|undefined` 类型；可选在构造/调用时可省略。

### T.NULL 可空/未定义类型别名 [Required]

类型别名禁止在联合中包含 `|null` 或 `|undefined`；只在实际使用别名处添加可空性，在值出现附近处理空值。

### T.INF 类型推断 [Recommended]

可依赖 TS 类型推断；可轻松推断的简单类型省略注解（如 `string/number/boolean/RegExp` 字面量或 `new` 表达式），复杂表达式添加注解提高可读性；空集合用显式泛型（`new Set<string>()`）防推断为 unknown。

### T.RETURN 返回类型 [Recommended]

返回类型注解由作者决定，审查者可要求澄清复杂返回类型；项目可有本地策略要求始终包含返回类型（session-01 的公开方法建议显式标注）。

### T.ARRAY Array 类型 [Required]

简单类型用 `T[]`/`readonly T[]` 语法糖，复杂类型（含联合/对象元素）用 `Array<T>`；多维数组用语法糖。

### T.MAP 映射和条件类型 [Recommended]

始终使用最简单类型构造；一点重复或冗长比复杂类型表达式的长期成本便宜；可用内置 `Record/Partial/Readonly`。

### T.OBJ `{}` 类型 [Required]

`{}`（空接口类型）表示任何非空值，很少合适；优先用 `unknown`、`Record<string, T>` 或 `object`。

### 类型断言

### LF.ASSERT 类型断言不安全 [Required]

类型断言（`x as T`）与非空断言（`y!`）不安全，只让编译器静音而不插入运行时检查；无明确原因不应使用；需要时最好的答案是写显式运行时检查（`instanceof`、`if (y)`）；确需断言时加注释解释为何安全。

### LF.ASSERT-SYNTAX 类型断言必须用 as 语法 [Required]

类型断言必须用 `as` 语法而非尖括号 `<Foo>z` 语法。

### LF.ASSERT-OBJ 对象字面量用类型注解而非断言 [Required]

用类型注解（`: Foo`）而非类型断言（`as Foo`）指定对象字面量类型，使接口字段变化时可检测重构错误。

### 导入与导出

### SRC.EXPORT 命名导出 [Required]

所有代码用命名导出，禁止默认导出；默认导出没有规范名称，使集中维护困难且鼓励大对象命名空间反模式。

### SRC.VIS 导出可见性 [Required]

只导出在模块外部使用的符号，最小化模块的导出 API 表面。

### SRC.IMPTYPE `import type` [Required]

仅将导入符号用作类型时用 `import type {...}`（如从 src/types.ts 与 claude-agent-sdk 导入类型）；对值用常规导入；可混合 `import {type Foo, Bar}`。

### SRC.EXPTYPE `export type` [Required]

重新导出类型时使用 `export type`，如 `export type {AnInterface} from './foo'`。

### SRC.PATH 导入路径 [Required]

引用同一项目文件时使用相对导入（`./foo`）而非绝对导入，考虑限制父目录层级（`../../../`）数量。

### SRC.MOD 使用模块而非命名空间 [Required]

禁止使用 `namespace`/`require`/`<reference>`，代码必须用 ES6 `import`/`export` 形式组织。

### SRC.ORDER 文件顺序 [Required]

文件按序排列：版权信息（如有）→ `@fileoverview` JSDoc（如有）→ 导入 → 实现，每个存在部分之间恰好用一个空行分隔。

### SRC.NS 命名空间 vs 具名导入 [Recommended]

频繁使用/名称清晰的符号优先具名导入（如 vitest 的 `describe`/`it`/`expect`）；使用大型 API 中许多不同符号时优先命名空间导入。

### 命名规范

### NAM.IDENT 标识符 [Required]

标识符必须只使用 ASCII 字母、数字、下划线（用于常量与结构化测试名）及很少使用的 `$`。

### NAM.STYLE 命名风格 [Required]

名称不应装饰类型信息；禁止私有属性/方法的尾部或前导下划线、`opt_` 前缀；不要特别标记接口（`IMyInterface`）。

### NAM.DESC 描述性名称 [Required]

名称必须具有描述性，不用读者不熟悉的缩写，不删除单词内部字母缩写（`cstmrId` 禁止）；10 行以内局部作用域可用单字母名。

### NAM.CAMEL Camel case [Required]

缩写视为整词处理（`loadHttpUrl` 而非 `loadHTTPURL`），除非平台名要求（`XMLHttpRequest`）。

### NAM.RULE 大小写表 [Required]

`UpperCamelCase`：class/interface/type/enum/类型参数；`lowerCamelCase`：variable/parameter/function/method/property/module 别名；`CONSTANT_CASE`：全局常量与枚举值。

### NAM.CONST 常量 [Required]

`CONSTANT_CASE` 表示值意图不变；只有模块级符号、模块级类静态字段、模块级枚举值可用；函数内局部/嵌套类静态字段必须用 `lowerCamelCase`。

### NAM.TEST 测试名称 [Required]

xUnit 风格测试方法名称可用 `_` 分隔符结构（如 `testX_whenY_doesZ()`）。

### NAM.PREFIX `_` 前后缀禁止 [Required]

标识符禁止 `_` 前缀/后缀，`_` 也禁止单独用作未使用参数标识符。

### NAM.ALIAS 别名 [Required]

创建现有符号局部别名时使用与源相同的大小写格式；变量用 `const`，类字段用 `readonly` 属性。

### 注释与文档

### DOC.JSDOC JSDoc 与注释 [Required]

用 `/** JSDoc */` 做文档化注释（代码用户阅读），用 `//` 行注释做实现注释；多行实现注释必须用多个单行注释（`//`）而非块注释。

### DOC.EXPORT 文档化所有顶层导出 [Required]

用 `/** JSDoc */` 向代码用户传达信息，避免仅重复属性/参数名称；若属性/方法用途不是名称可立即看出的，应一并文档化（无论导出与否）。

### DOC.CLASS 类注释 [Required]

类的 JSDoc 注释应为读者提供足够信息了解如何使用类及正确使用的额外考虑；构造函数文本描述可省略。

### DOC.METHOD 方法与函数注释 [Required]

若签名 JSDoc 或方法名/类型可自明则可省略描述；方法描述以第三人称动词短语开头（如"POSTs the request..."，非祈使句，隐含"此方法..."）。

### DOC.PARAM-PROP 参数属性注释 [Required]

参数属性（带 `private/protected/public/readonly` 的构造参数）用 JSDoc `@param` 注解文档化，编辑器在构造调用与属性访问时显示。

### DOC.TYPE JSDoc 类型注解冗余 [Required]

JSDoc 类型注解在 TS 源码中冗余，禁止在 `@param`/`@return` 中重复声明类型。

### DOC.INFO 注释要添加信息 [Required]

注释必须提供实际信息，避免仅重复参数名和类型；`@param`/`@return` 仅在添加信息时需要，否则可省略。

### 工具链

### TC.COMPILE 所有 TS 文件必须通过类型检查 [Required]

所有 TypeScript 文件必须用标准工具链通过类型检查（`tsc --noEmit`）。

### TC.TSIGNORE 禁止 @ts-ignore [Required]

不要使用 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`；单元测试中可用 `@ts-expect-error` 但通常不应（易过度匹配抑制更严重错误）。

### 代码风格（typescript-core-style）

### CS.ESM Node.js ES 模块 [Required]
推荐使用 Node.js ES 模块（`type: "module"`）。

### CS.NS 命名空间导入 [Recommended]
对于第三方库或有多个导出的模块，使用命名空间导入。

### CS.QUOTE 单引号 [Required]
使用单引号（`'`）。

### CS.SEMI 显式分号 [Required]
显式使用分号；不要依赖自动分号插入（ASI）。

### CS.LOGGER 禁止 console.log [Required]
禁止使用 console.log，通过 logger 输出日志。

### CS.INDENT 2 空格缩进 [Required]
TypeScript 缩进必须采用 2 个空格。

### CS.JSDOC 文件头与 JSDoc 注释 [Required]
文件头部声明采用 `/** Brief description / @author / @copyright */` 样式；类、main 方法、export 方法及重要方法必须有 JSDoc 注释，常量用行前 `//` 注释。

### CS.LINES 文件行数 [Recommended]
普通业务文件 300-500 行；组件/类文件 200-300 行（session-state.ts/session.ts 属此类）；工具/配置文件 100-200 行；大型模块不超过 800 行。

### 一致性策略

### POL.CONSISTENCY 一致性 [Required]

未明确解决的风格问题与同一文件/目录现有代码保持一致；**新文件必须使用 Google 风格**（session-state.ts/session.ts 为新建文件）。

## 3. Security & production notes

- **LF.EXCEPTION-ONLY（错误抛出形态）**：types.ts 的 `SessionNotFoundError`/`TimeoutError`/`InvalidRequestError` 是 `_tag` 判别联合的**接口**（非 Error 子类）。实现中若直接 `throw` 这些纯对象，将不填充堆栈跟踪，调试困难。建议：错误类实现为 `Error` 子类（`class SessionNotFoundError extends Error { _tag = 'SessionNotFoundError' as const; ... }`）以兼顾协议字段与堆栈；`wait()` 超时与 `create()` init 超时的 Promise reject 值必须是 `Error`（含 `TimeoutError`）。
- **T.ANY（判别联合保真）**：SDK 的 `SDKMessage.message`、`getSessionMessages()` 返回的 `message: unknown`，以及事件通道的原始 `SDKMessage` 联合——后台泵按 `message.type`/`subtype` 判别分发时必须用类型守卫/`switch` 收窄（`case 'system': if (message.subtype === 'init')`），禁止用 `any` 绕过，否则未映射消息类型会静默出错。未映射的消息类型应显式跳过（default 分支 + 注释）。
- **T.INDEX / 会话状态隔离**：`Map<sessionId, SessionState>` 是并发会话隔离的正确容器（非裸对象索引签名）。`close()` 必须调用 `Query.close()` 并 `Map.delete()` 清理，防止 SessionState 泄漏与 CLI 子进程悬挂。
- **LF.EMPTY-CATCH / interrupt no-op**：`interrupt()` 空闲会话为 no-op 属"故意不做事"，若实现含空 catch 必须加注释说明理由（如"会话已 idle，中断无需操作"）。
- **后台 query 泵生命周期**：输入队列是**永不完结的无限生成器**（conversation.ts 蓝本 `for(;;)` + `yield pending.shift()!`），`close()` 时必须终止泵并 `q.close()`，否则异步任务悬挂。`pending.shift()!` 的非空断言需以 `while (pending.length === 0)` 的运行时守卫为前提（LF.ASSERT），并在必要处加注释说明安全原因。
- **LF.ARROW-BODY / 回调**：后台泵与 `wake` 唤醒回调（`wake?.()`）的箭头函数体需按返回值是否使用选择块体（避免副作用泄漏返回值）；事件通道订阅回调注意卸载语义（LF.EVENT-HANDLERS）。
- **wait() 事件驱动与超时**：wait() 基于 `session_state_changed`（`state === 'idle'`）与 `result` 消息驱动 resolve，配 `timeout` 参数；超时 reject `TimeoutError`。超时清理需在 catch 中注释（LF.EMPTY-CATCH），避免悬挂监听器。

---

## 4. 与 session-01 直接相关的落地要点（结合上述标准与事实源）

1. **src/session-state.ts 的 SessionState**：封装 `Query` 句柄（`readonly`，LF.PARAM-PROP/LF.READONLY）、流式输入队列（push/yield，无限 AsyncGenerator，蓝本 `scripts/conversation.ts`）、SDKMessage 事件通道（原始 SDKMessage 通道，回放型广播，event-01 负责归一化）、后台 query 泵。后台启动 `query({ prompt: 输入队列, options: { includePartialMessages: true, cwd, agent, model } })`，消费首条 `system/init` 消息捕获 `session_id`（带超时保护，超时 reject `TimeoutError`）。
2. **src/session.ts 的 SessionManager**：维护 `Map<sessionId, SessionState>`（T.INDEX：用 Map 而非对象）。`create`（后台启动 query，init 后 resolve SessionV2Info，字段含 id/projectID/time/title/location/cost/tokens，`location.directory` 取客户端 cwd，agent 透传）、`messages`（包装 `getSessionMessages()` 返回 `{ data, cursor: { previous?, next? } }`）、`prompt`（push SDKUserMessage 并返回 SessionInputAdmitted，`id` 以 `msg_` 前缀生成；不存在会话抛 SessionNotFoundError）、`interrupt`（调用 `Query.interrupt()`，空闲会话 no-op）、`wait`（基于 `session_state_changed`/`result` 事件驱动等待空闲，支持 timeout，超时抛 TimeoutError）、`close`（关闭 Query、终止事件通道、从 Map 清理）。
3. **结构约束**：类用 `private readonly` 字段、参数属性、声明处初始化；方法无分号、空行分隔；getter 纯函数；可见性最小化；命名导出、`import type`（types.ts 与 claude-agent-sdk）、相对导入、单引号、显式分号、2 空格缩进、文件头 JSDoc。
4. **错误形态**：错误用 `Error` 子类承载 `_tag` 判别字段（`_tag` 用 `as const` 字符串字面量），保证堆栈跟踪且兼容 `ClaudeSDKError` 结构；只抛 Error。
5. **并发与生命周期**：输入队列为永不完结生成器，`close()` 必须终止泵并 `q.close()`；后台泵按 `message.type`/`subtype` 判别分发（switch + default 跳过未映射类型）；`wait()` 事件驱动 + 超时清理监听器。
6. **验证**：`packages/sdk/claude` 下执行 `tsc --noEmit`（TC.COMPILE）与 `vitest run`（`test/session.test.ts` 覆盖 plan.json acceptance：create 捕获 session_id 返回 SessionV2Info、agent 透传、init 超时、messages 分页、prompt push 与 msg_ 前缀、SessionNotFoundError、interrupt 调用/no-op、wait 空闲/超时、并发隔离、close 清理）。
