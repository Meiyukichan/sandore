# CleanCode 探索结果 — event-01（model-and-events-and-client）

> 探索类型：cleancode（clean-ts）
> 探索目标：`src/events.ts`（SDKMessage→GlobalEvent 归一化 + GlobalEventManager）、`src/model.ts`（ModelManager 惰性控制 Query）、`src/client.ts`（createClaudeClient 工厂）
> 语言：chinese
> 边界：仅 event-01 三个新源文件，不修改 session-01 产物

---

## 0. 项目技术基线核查（本次探索的实地发现，供 event-01 实现作为字段约束）

### 0.1 当前实现进度与可复用产物

- `src/types.ts`（infra-01，已完成）：已导出 event-01 全部所需协议类型 —— `GlobalEventType`（六种事件类型联合）、`GlobalEventPayload`（`{id: EventID, type, properties: Record<string,unknown>}`）、`GlobalEvent`（`{directory?, project?, workspace?, payload}`）、`EventID = \`evt_${string}\``、`ModelV2Info`、`LocationInfo`（`{directory, project:{id,directory}, workspaceID?}`）、`ModelListResponse`、`ModelRef`/`LocationRef`/`TokenUsage`/`ClaudeSDKError`。
- `src/session-state.ts`（session-01，已完成）：`SessionState.events` 访问器（行 241-243）返回 `AsyncIterable<SDKMessage>`；`ReplayChannel`（行 104-135）为**回放型广播通道**——缓冲全部消息、晚订阅者从缓冲回放、`close()` 后流终止；`SessionState` 暴露 `sessionId`/`state`/`isIdle`/`directory`。`QueryFactory`/`QueryLike`/`SessionQueryOptions` 为注入点。
- `src/session.ts`（session-01，已完成）：`SessionManager.events(sessionId)`（行 223-226）返回 `AsyncIterable<SDKMessage>`，不存在会话抛 `SessionNotFoundError`；`SessionManagerOptions`=`{cwd, queryFn?, getSessionMessagesFn?, initTimeoutMs?}`；`makeMessageId()`（行 279-283）用 `\`msg_${crypto.randomUUID()}\` as MessageID` —— **event-01 的 evt_/prt_ 前缀生成沿用同一手法**。

### 0.2 @anthropic-ai/claude-agent-sdk 关键类型（实际安装 v0.3.226）

- `SDKMessage` 联合（sdk.d.ts 行 4184）：约 50 种子类型，event-01 只映射下表子集，其余**静默跳过**。
- `SDKSystemMessage`（行 4601，subtype='init'）：`session_id/cwd/model/capabilities?/...` → `session.created`。
- `SDKSessionStateChangedMessage`（行 4562）：`state: 'idle'|'running'|'requires_action'` → 仅 idle 产 `session.idle`。
- `SDKPartialAssistantMessage`（行 4321-4328，type='stream_event'）：`event: BetaRawMessageStreamEvent`、`parent_tool_use_id`、`uuid`、`session_id`。`BetaRawMessageStreamEvent` = `message_start|message_delta|message_stop|content_block_start|content_block_delta|content_block_stop` 联合（@anthropic-ai/sdk messages.d.ts 行 1837）；`content_block_delta.delta: BetaRawContentBlockDelta`（行 1771）= `BetaTextDelta{type:'text_delta',text}`（行 2139）| `BetaInputJSONDelta{type:'input_json_delta',partial_json}`（行 1266）| ... → 前两者产 `message.part.delta`（field 分别 `'text'`/`'tool_input'`），`message_start` 携带 `message.id`（消息级 ID）、`content_block_start` 携带 `index`/`content_block.id`（块级 ID，tool_use 块有 id），`content_block_stop` **无对应事件应跳过**。
- `SDKAssistantMessage`（行 3019，type='assistant'）：`message: BetaMessage`、`session_id`、`uuid`、`error?`、`timestamp?`；`message.content` 每内容块 → 一条 `message.part.updated`（TextPart/ToolPart）。
- `SDKResultMessage = SDKResultSuccess | SDKResultError`（行 4470）：success（行 4472，`total_cost_usd/usage/modelUsage/result/stop_reason/num_turns`）→ `session.next.step.ended`（finish/cost/tokens）；error（行 4440，`subtype:'error_during_execution'|'error_max_turns'|'error_max_budget_usd'|'error_max_structured_output_retries'`、`errors: string[]`、`is_error:true`）→ `session.error`。
- `ModelInfo`（行 1224）：`{value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode?}`。
- `Query`（行 2356）：`supportedModels(): Promise<ModelInfo[]>`（行 2488）、`initializationResult(): Promise<SDKControlInitializeResponse>`（行 2459，其中 `models: coreTypes.ModelInfo[]` 行 3618）、`close()`（行 2661）。
- `query(_params)`（行 2664）：控制 Query 以 `query({prompt: <永不产出的空 AsyncIterable>, options:{cwd}})` 创建。

### 0.3 spec/design 关键约束（event-01）

- **映射表**（event-streaming spec「SDKMessage to GlobalEvent normalization」）：init→session.created、text_delta→message.part.delta、input_json_delta→message.part.delta、assistant→message.part.updated、result success→session.next.step.ended、result error→session.error、session_state_changed idle→session.idle。`payload.id` MUST `^evt_`；**无对应类型的 SDKMessage SHALL 静默跳过（不产出事件）**。
- **回放**：`client.session.events(sessionId)` 返回 `AsyncIterable<GlobalEvent>`；会话 query() 完成（result 产出）后事件流在产出最终 `session.next.step.ended` 后正常结束（AsyncIterable return）；create() 之后再订阅仍收到 `session.created`。
- **全局过滤（D6）**：`client.global.event({directory})` 只产出匹配 directory 的事件且 `GlobalEvent.directory` 等于该值；省略时默认用客户端 cwd。
- **D9 控制 Query**：`ModelManager.list()` 惰性初始化并缓存控制 Query，复用其 `supportedModels()`/`initializationResult().models`；不 yield 用户消息、不产生对话轮次；`client.close()` 时关闭。
- **映射**（model-providers spec）：value→id、displayName→name、providerID 固定 `'anthropic'`、status 默认 `'active'`、resolvedModel 保留在 `variants`。
- **Client factory**（session-management spec）：`createClaudeClient({cwd})` 返回含 `session`/`model`/`global` 三命名空间对象，不启动 HTTP 服务器；cwd 为默认 directory。
- **D7 ID**：session_id 保留 Claude 原始值（不做 `^ses`）；message/part/event ID 归一化时按 `msg_`/`prt`/`evt_` 前缀生成。
- **接线**：`session.events` = `globalEventManager.sessionEvents(sessionId)`；`global.event` = `GlobalEventManager` 全局视图；`model.list` = `ModelManager.list()`；`client.close()` 关闭 SessionManager（`closeAll()`）与控制 Query。

---

## 1. Scope（furina-cleancode 编码指南）

- **Requirement summary**: 实现 event-01 —— `src/events.ts` 把 Claude SDKMessage 流归一化为 GlobalEvent 信封（六条映射 + evt_ 前缀 + 静默跳过），`GlobalEventManager` 提供 `sessionEvents(sessionId)`（订阅会话回放通道并归一化）与 `global.event({directory})`（按 directory 过滤的全局视图）；`src/model.ts` 实现 `ModelManager.list()`（惰性初始化并缓存控制 Query，ModelInfo→ModelV2Info 映射，返回 `{location, data}`）；`src/client.ts` 实现 `createClaudeClient({cwd})` 工厂，返回 session/model/global 三命名空间客户端对象，不启动 HTTP 服务器。
- **Code features affected**: 类定义（GlobalEventManager/ModelManager）、工厂函数（createClaudeClient）、SDKMessage 判别联合 switch 归一化、AsyncIterable 异步生成器、控制 Query 惰性缓存、SessionManager 复用与依赖注入、类型声明/断言（evt_/msg_/prt_ 前缀）、`import type` 导入导出、JSDoc 注释、vitest 测试（events.test.ts/model.test.ts/client.test.ts）。

## 2. Guidelines

### 类定义与结构（GlobalEventManager / ModelManager）

##### LF.CLASS-DECL 类声明禁止以分号结尾 [Required]
类声明**禁止**以分号结尾；包含类表达式的语句（如 `export const Baz = class ...`）必须以分号结尾。
**[Compliant]**
```ts
class Foo {
}
```

##### LF.CLASS-METHOD 类方法声明禁止分号 [Required]
类方法声明禁止用分号分隔；方法声明用单个空行与周围代码分隔。

##### LF.PRIVATE 禁止 #private 字段 [Required]
不要使用 `#private` 私有字段（私有标识符），改用 TypeScript 可见性注解（`private ident = 1`）。

##### LF.READONLY 使用 readonly [Required]
用 `readonly` 修饰符标记在构造函数外部从不重新赋值的属性——如 GlobalEventManager 持有的 SessionManager 句柄、ModelManager 持有的 `cwd` 与 `queryFn` 注入工厂。

##### LF.PARAM-PROP 参数属性 [Required]
不要通过类成员引入明显初始化器，使用 TypeScript parameter property（如 `constructor(private readonly sessions: SessionManager) {}`）；参数属性需文档说明时用 `@param` JSDoc。

##### LF.FIELD-INIT 字段声明处初始化 [Required]
非参数的类成员在声明处初始化（如 `private controlQuery: QueryLike | undefined;`）；构造完成后属性不应增删，稍后填充的可选字段应显式初始化为 `undefined`。

##### LF.GETSET getter 必须是纯函数 [Required]
getter 必须是纯函数（结果一致且无副作用）；避免仅为隐藏属性定义"直通"访问器。event-01 的会话/全局事件视图应使用方法返回 `AsyncIterable<GlobalEvent>` 而非有副作用 getter。

##### LF.VIS 限制可见性 [Required]
尽可能限制符号可见性；TS 符号默认 public，除非声明非只读 public 参数属性，否则不要使用 `public` 修饰符；考虑将私有方法转为文件内类外部的非导出函数（如归一化辅助函数 `mapSdkMessage()` 可为模块级非导出函数）。

### 工厂函数与模块导出（createClaudeClient）

##### LF.FUNC-DECL 命名函数优先函数声明 [Required]
定义命名函数时优先函数声明而非箭头函数/函数表达式。`createClaudeClient` 应为函数声明：`export function createClaudeClient(options: CreateClientOptions): ClaudeClient`。

##### SRC.EXPORT 命名导出 [Required]
所有代码用命名导出，禁止默认导出；`createClaudeClient` 用 `export function`。

##### SRC.VIS 导出可见性 [Required]
只导出在模块外部使用的符号，最小化导出 API 表面。client.ts 只应导出 `createClaudeClient` 与必要的 options/client 接口类型；`GlobalEventManager`/`ModelManager` 是否导出视测试需要决定（推荐导出以便单测直接注入）。

##### SRC.EXPTYPE `export type` [Required]
重新导出类型时使用 `export type`，如 `export type {ClaudeClient} from './client'`。

### SDKMessage 判别联合 switch 归一化

##### LF.SWITCH switch 语句 [Required] — **High**
所有 `switch` 语句**必须**包含一个 `default` 语句组，即使它不包含代码。`default` 语句组必须放在最后。在 switch 块中，每个语句组要么通过 `break`、`return` 语句或抛出异常突然终止。非空语句组（`case ...`）**禁止** fall through。空的语句组允许 fall through。
**[Compliant]**
```ts
switch (x) {
  case Y:
    doSomethingElse();
    break;
  default:
    // nothing to do.
}
```

##### LF.EQ 严格相等 [Required]
始终使用 `===`/`!==`；双等会导致易错类型强制转换（与字面量 `null` 比较用 `==` 覆盖 null/undefined 属例外）。归一化判别 `message.type === 'system'`、`message.subtype === 'init'` 必须用 `===`。

##### T.STRUCT 使用结构类型 [Required]
TS 类型系统是结构化的；在符号声明处显式包含类型（`const ev: GlobalEvent = {...}`），用接口定义结构类型而非类。SDKMessage 判别联合即结构化类型——按 `type`/`subtype` 收窄后用 `message.session_id` 等字段。

##### T.ANY 避免 `any`，使用 `unknown` [Required] — **High**
TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型、使用 `unknown`、抑制 lint 警告并记录原因。`any` 类型允许赋值到任何其他类型并取消引用其上的任何属性。通常这种行为不是必要或期望的，代码只需要表达类型是未知的。在那种情况下使用内置类型 `unknown`——它表达了这个概念，而且更安全，因为它不允许取消引用任意属性。
**[Compliant]**
```ts
const val: unknown = value;
```

##### LF.ASSERT 类型断言不安全 [Required] — **High**
类型断言（`x as T`）与非空断言（`y!`）不安全，只让编译器静音而不插入运行时检查；无明确原因不应使用；需要时最好的答案是写显式运行时检查（`instanceof`、`if (y)`）；确需断言时加注释解释为何安全。event-01 生成 `evt_`/`prt_`/`msg_` 前缀 ID 时（`\`evt_${crypto.randomUUID()}\` as EventID`）须仿照 session.ts `makeMessageId()` 的注释手法说明模板字面量拼接保证前缀、断言仅为收窄。
**[Compliant]**
```ts
// x is a Foo, because ...
(x as Foo).foo();
```

##### LF.ASSERT-SYNTAX 类型断言必须用 as 语法 [Required]
类型断言必须用 `as` 语法而非尖括号 `<Foo>z` 语法。

##### LF.ASSERT-OBJ 对象字面量用类型注解而非断言 [Required]
用类型注解（`: Foo`）而非类型断言（`as Foo`）指定对象字面量类型，使接口字段变化时可检测重构错误。归一化产出的 `GlobalEvent`/`GlobalEventPayload` 信封对象应写 `const event: GlobalEvent = {...}`，不写 `{...} as GlobalEvent`。

### 异步流（AsyncIterable 归一化生成器）

##### LF.GEN 生成器格式化 [Required]
生成器将 `*` 附加到 `function` 和 `yield` 关键字（`async *sessionEvents()`、`yield* ...`），而非 `function *foo()` / `yield *iter`；rest/展开 `...` 后不加空格。

##### LF.ARROW-BODY 箭头函数体 [Required]
根据返回值是否使用决定简洁体或块体：返回值实际被使用时用简洁体；未使用（如回调产生副作用）用块体，必要时用 `void` 确保不泄漏返回值。

##### LF.CONTROL 控制流语句使用大括号 [Required]
`if/else/for/do/while` 等总是用大括号包围体，即使只有单条语句；单行 `if` 可省略大括号属例外；避免在控制语句中赋值。

##### LF.ITER 迭代容器 [Required]
优先用 `for (... of someArr)` 遍历数组；`for-in` 只能用于字典样式对象且需 `hasOwnProperty` 过滤；优先 `for-of` 配 `Object.keys/values/entries`。assistant 消息 `message.content` 逐块归一化用 `for (const block of content)`。

### 控制 Query 惰性缓存（ModelManager）

##### LF.CATCH 捕获错误时假设是 Error 实例 [Required]
捕获错误时假设所有抛出错误都是 `Error` 实例；除非被调用的 API 确定知道会抛出非 `Error`，否则异常处理程序禁止防御性处理非 `Error` 类型。`supportedModels()` 失败时按 Error 处理并传播。

##### LF.EMPTY-CATCH 空 catch 块必须注释 [Required]
当确实适合在 catch 块中完全不采取行动时，应在注释中解释正当理由；不允许无注释的空 catch。

##### LF.TRY-FOCUSED try 块保持精简 [Required]
在不损害可读性前提下限制 try 块内代码量，将非抛出行移出 try/catch。

##### T.INDEX 索引签名 [Required]
对象作为关联数组用索引签名 `{[k: string]: T}` 且键标签有意义；**考虑使用 ES6 `Map`/`Set` 而非对象**。ModelManager 的控制 Query 缓存可用单一字段（`controlQuery?: QueryLike`）而非索引对象；会话相关索引沿用 SessionManager 的 `Map`。

### 错误处理（session.error / 会话不存在）

##### LF.EXCEPTION-ONLY 只抛 Error [Required] — **High**
JavaScript（因此 TypeScript）允许抛出或拒绝带有任意值的 Promise。但是，如果抛出或拒绝的值不是 `Error`，它不会填充堆栈跟踪信息，使调试变得困难。这种处理扩展到 `Promise` 拒绝值，因为 `Promise.reject(obj)` 等同于 async 函数中的 `throw obj`。
**[Compliant]**
```ts
throw new Error('oh noes!');
class MyError extends Error {}
throw new MyError('my oh noes!');
Promise.reject(new Error('oh noes!'));
```

##### LF.NEW-ERROR 使用 new 实例化错误 [Required]
使用 `new Error()` 实例化异常，而非仅调用 `Error()`；`new` 与其他对象实例化方式更一致。

### 类型系统

##### T.IFACE 接口优于类型字面量别名 [Required]
声明对象类型时使用接口而非对象字面量表达式的类型别名；两者几乎等价，但接口工具支持更好。

##### T.INF 类型推断 [Recommended]
可依赖 TS 类型推断；可轻松推断的简单类型省略注解（如 `string/number/boolean/RegExp` 字面量或 `new` 表达式），复杂表达式添加注解提高可读性；空集合用显式泛型（`new Map<string, ...>()`）防推断为 unknown。

##### T.RETURN 返回类型 [Recommended]
返回类型注解由作者决定，审查者可要求澄清复杂返回类型；项目可有本地策略要求始终包含返回类型（event-01 的公开方法——`sessionEvents`/`global.event`/`ModelManager.list`——建议显式标注 `AsyncIterable<GlobalEvent>`/`Promise<ModelListResponse>`）。

##### T.OPT 优先使用可选而非 `|undefined` [Required]
使用 `?` 可选参数/可选字段（接口或类上）而不是 `|undefined` 类型；可选在构造/调用时可省略。

##### T.NULL 可空/未定义类型别名 [Required]
类型别名禁止在联合中包含 `|null` 或 `|undefined`；只在实际使用别名处添加可空性，在值出现附近处理空值。

##### T.ARRAY Array 类型 [Required]
简单类型用 `T[]`/`readonly T[]` 语法糖，复杂类型（含联合/对象元素）用 `Array<T>`；多维数组用语法糖。

##### T.MAP 映射和条件类型 [Recommended]
始终使用最简单类型构造；一点重复或冗长比复杂类型表达式的长期成本便宜；可用内置 `Record/Partial/Readonly`。

##### T.OBJ `{}` 类型 [Required]
`{}`（空接口类型）表示任何非空值，很少合适；优先用 `unknown`、`Record<string, T>` 或 `object`。GlobalEventPayload.properties 已为 `Record<string, unknown>`，不要改用 `{}`。

### 导入与导出

##### SRC.ORDER 文件顺序 [Required]
文件按序排列：版权信息（如有）→ `@fileoverview` JSDoc（如有）→ 导入 → 实现，每个存在部分之间恰好用一个空行分隔。

##### SRC.IMPTYPE `import type` [Required] — **High**
仅将导入符号用作类型时用 `import type {...}`（如从 src/types.ts 与 claude-agent-sdk 导入类型）；对值用常规导入；可混合 `import {type Foo, Bar}`。event-01 从 claude-agent-sdk 导入 `SDKMessage`/`SDKPartialAssistantMessage`/`SDKAssistantMessage`/`ModelInfo`/`query` 时，类型用 `import type`、值（`query`）用常规导入。
**[Compliant]**
```ts
import type {Foo} from './foo';
import {Bar} from './foo';
```

##### SRC.PATH 导入路径 [Required]
引用同一项目文件时使用相对导入（`./foo`）而非绝对导入，考虑限制父目录层级（`../../../`）数量。

##### SRC.MOD 使用模块而非命名空间 [Required]
禁止使用 `namespace`/`require`/`<reference>`，代码必须用 ES6 `import`/`export` 形式组织。

##### SRC.NS 命名空间 vs 具名导入 [Recommended]
频繁使用/名称清晰的符号优先具名导入（如 vitest 的 `describe`/`it`/`expect`）；使用大型 API 中许多不同符号时优先命名空间导入。

### 命名规范

##### NAM.IDENT 标识符 [Required]
标识符必须只使用 ASCII 字母、数字、下划线（用于常量与结构化测试名）及很少使用的 `$`。

##### NAM.STYLE 命名风格 [Required]
名称不应装饰类型信息；禁止私有属性/方法的尾部或前导下划线、`opt_` 前缀；不要特别标记接口（`IMyInterface`）。

##### NAM.DESC 描述性名称 [Required]
名称必须具有描述性，不用读者不熟悉的缩写，不删除单词内部字母缩写（`cstmrId` 禁止）；10 行以内局部作用域可用单字母名。

##### NAM.CAMEL Camel case [Required]
缩写视为整词处理（`loadHttpUrl` 而非 `loadHTTPURL`），除非平台名要求（`XMLHttpRequest`）。

##### NAM.RULE 大小写表 [Required]
`UpperCamelCase`：class/interface/type/enum/类型参数；`lowerCamelCase`：variable/parameter/function/method/property/module 别名；`CONSTANT_CASE`：全局常量与枚举值。`GlobalEventManager`/`ModelManager`/`createClaudeClient` 命名符合此表。

##### NAM.CONST 常量 [Required]
`CONSTANT_CASE` 表示值意图不变；只有模块级符号、模块级类静态字段、模块级枚举值可用；函数内局部/嵌套类静态字段必须用 `lowerCamelCase`。默认 directory/providerID（`'anthropic'`）若为模块级常量应用 `CONSTANT_CASE`。

##### NAM.PREFIX `_` 前后缀禁止 [Required]
标识符禁止 `_` 前缀/后缀，`_` 也禁止单独用作未使用参数标识符。

##### NAM.ALIAS 别名 [Required]
创建现有符号局部别名时使用与源相同的大小写格式；变量用 `const`，类字段用 `readonly` 属性。

### 注释与文档

##### DOC.JSDOC JSDoc 与注释 [Required]
用 `/** JSDoc */` 做文档化注释（代码用户阅读），用 `//` 行注释做实现注释；多行实现注释必须用多个单行注释（`//`）而非块注释。

##### DOC.EXPORT 文档化所有顶层导出 [Required]
用 `/** JSDoc */` 向代码用户传达信息，避免仅重复属性/参数名称；若属性/方法用途不是名称可立即看出的，应一并文档化（无论导出与否）。`createClaudeClient`、`GlobalEventManager`、`ModelManager` 及其公开方法必须 JSDoc。

##### DOC.CLASS 类注释 [Required]
类的 JSDoc 注释应为读者提供足够信息了解如何使用类及正确使用的额外考虑；构造函数文本描述可省略。

##### DOC.METHOD 方法与函数注释 [Required]
若签名 JSDoc 或方法名/类型可自明则可省略描述；方法描述以第三人称动词短语开头（如"返回该会话归一化后的 GlobalEvent 事件流"）。

##### DOC.PARAM-PROP 参数属性注释 [Required]
参数属性（带 `private/protected/public/readonly` 的构造参数）用 JSDoc `@param` 注解文档化，编辑器在构造调用与属性访问时显示。

##### DOC.TYPE JSDoc 类型注解冗余 [Required]
JSDoc 类型注解在 TS 源码中冗余，禁止在 `@param`/`@return` 中重复声明类型。

##### DOC.INFO 注释要添加信息 [Required]
注释必须提供实际信息，避免仅重复参数名和类型；`@param`/`@return` 仅在添加信息时需要，否则可省略。归一化 switch 的 default 分支须注释"无对应 opencode 事件类型，静默跳过"。

### 工具链

##### TC.COMPILE 所有 TS 文件必须通过类型检查 [Required]
所有 TypeScript 文件必须用标准工具链通过类型检查（`tsc --noEmit`，即 `pnpm --filter @meiyukichan/claude-sdk typecheck`）。

##### TC.TSIGNORE 禁止 @ts-ignore [Required]
不要使用 `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`；单元测试中可用 `@ts-expect-error` 但通常不应（易过度匹配抑制更严重错误）。

### 代码风格（typescript-core-style）

##### CS.ESM Node.js ES 模块 [Required]
推荐使用 Node.js ES 模块（`type: "module"`）。

##### CS.QUOTE 单引号 [Required]
使用单引号（`'`）。

##### CS.SEMI 显式分号 [Required]
显式使用分号；不要依赖自动分号插入（ASI）。

##### CS.LOGGER 禁止 console.log [Required]
禁止使用 console.log，通过 logger 输出日志。

##### CS.INDENT 2 空格缩进 [Required]
TypeScript 缩进必须采用 2 个空格。

##### CS.JSDOC 文件头与 JSDoc 注释 [Required]
文件头部声明采用 `/** Brief description / @author / @copyright */` 样式；类、export 方法及重要方法必须有 JSDoc 注释，常量用行前 `//` 注释。

##### CS.LINES 文件行数 [Recommended]
普通业务文件 300-500 行；组件/类文件 200-300 行；工具/配置文件 100-200 行；大型模块不超过 800 行（events.ts 归一化表 + GlobalEventManager 预计 200-300 行）。

### 一致性策略

##### POL.CONSISTENCY 一致性 [Required]
未明确解决的风格问题与同一文件/目录现有代码保持一致；**新文件必须使用 Google 风格**（events.ts/model.ts/client.ts 为新建文件，须与 session.ts/session-state.ts 已用风格一致：文件头 JSDoc、相对导入、`import type`、单引号、显式分号、2 空格、空行分隔方法、`crypto.randomUUID()` 前缀 ID）。

## 3. Security & production notes

- **LF.SWITCH / 静默跳过（归一化保真）**：归一化 switch 的 `default` 分支必须存在（LF.SWITCH）并注释"无对应 opencode 事件类型，静默跳过"（spec SHALL）。`stream_event` 内部还需二次判别 `event.type`（`content_block_delta`）与 `delta.type`（`text_delta`/`input_json_delta`），`content_block_stop`/`message_stop` 等应落入跳过分支；禁止用 `any` 绕过判别（T.ANY）。
- **T.ANY / SDKMessage 联合收窄**：SDK `SDKMessage`/`BetaRawMessageStreamEvent`/`BetaRawContentBlockDelta` 均为判别联合，按 `type`/`subtype`/`event.type`/`delta.type` 用 switch/类型守卫收窄，禁止 `as SDKPartialAssistantMessage` 直取字段而绕过运行时判别（LF.ASSERT），否则未映射消息会静默出错或越界访问。
- **LF.EXCEPTION-ONLY / result error 与错误传播**：`session.error` 的 `error` 字段承载错误信息（SDK `errors: string[]`/`subtype` 映射）；`sessionEvents(sessionId)` 对不存在会话应传播 SessionManager 抛出的 `SessionNotFoundError`（Error 子类），不吞错；`supportedModels()` 失败按 Error 传播（LF.CATCH），不返回空数组冒充成功。
- **LF.ASSERT / evt_/prt_/msg_ 前缀 ID**：前缀生成沿用 session.ts `makeMessageId()` 手法——`\`evt_${crypto.randomUUID()}\` as EventID`，注释说明模板字面量拼接保证前缀、断言仅为收窄；对象字面量用类型注解（LF.ASSERT-OBJ）保证 `GlobalEvent` 信封字段变化可检测。
- **回放型通道与生命周期**：`sessionEvents(sessionId)` 直接订阅 `SessionManager.events(sessionId)`（SessionState 回放型 ReplayChannel），晚订阅仍回放 `session.created`；会话 query() 完成后流在最终事件后正常 return（AsyncIterable 语义）；`client.close()` 必须调用 `SessionManager.closeAll()` 与 ModelManager 控制 Query 的 `close()`，防止 CLI 子进程悬挂。
- **全局过滤（D6）**：`global.event({directory})` 以入参 directory（或默认客户端 cwd）过滤每个 GlobalEvent 的 `directory` 字段；省略 directory 时回退到 `client.cwd`，两者都必须与 SessionManager 会话 `location.directory` 口径一致。

## 4. 与 event-01 直接相关的落地要点（结合上述标准与事实源）

1. **src/events.ts**：模块级非导出 `mapSdkMessage(message: SDKMessage, directory: string): GlobalEvent | undefined`（switch 按 `type`/`subtype`/`event.type`/`delta.type` 判别，产出 `GlobalEvent` 信封，`payload.id` 以 `evt_` 前缀生成，无对应类型返回 undefined 由调用方跳过）；`GlobalEventManager` 持有 `SessionManager`（参数属性 `private readonly sessions`）、`cwd`、可选 `queryFn`；`sessionEvents(sessionId)` 返回 `AsyncGenerator<GlobalEvent>`（`for await (const message of this.sessions.events(sessionId))` 逐条 `mapSdkMessage` 并 `yield`）；`global.event(options?: {directory?: string})` 以入参或 `this.cwd` 过滤 `GlobalEvent.directory`。
2. **src/model.ts**：`ModelManager` 持有 `cwd`/`queryFn`/`getControlQuery` 惰性缓存（`private controlQuery?: QueryLike`）；`list(options?: {location?: {directory?: string}})`: `Promise<ModelListResponse>` —— 首次调用以 `queryFn({prompt: emptyAsyncIterable(), options:{cwd}})` 创建控制 Query 并缓存，调用 `controlQuery.supportedModels()`，`ModelInfo`→`ModelV2Info`（value→id、displayName→name、providerID='anthropic'、status='active'、resolvedModel 放入 `variants`），返回 `{location: {directory, project:{id: encodeProjectID(directory), directory}}, data}`；`close()` 关闭缓存 Query。`encodeProjectID` 可从 session.ts 提取或复制（避免修改 session-01 产物）。
3. **src/client.ts**：`export function createClaudeClient(options: CreateClientOptions): ClaudeClient` —— 实例化 `SessionManager`、`GlobalEventManager`、`ModelManager`，暴露 `session`（create/messages/prompt/interrupt/wait/events）、`model`（list）、`global`（event）三命名空间；`session.events` = `(id) => events.sessionEvents(id)`；`global.event` = `(opts) => events.global(opts)`；`model.list` = `modelManager.list`；`close()` 调 `sessions.closeAll()` + `modelManager.close()`；**不启动任何 HTTP 服务器**。
4. **结构约束**：类用 `private readonly` 字段、参数属性、声明处初始化；方法无分号、空行分隔；getter 纯函数；命名导出、`import type`（types.ts 与 claude-agent-sdk）、相对导入、单引号、显式分号、2 空格缩进、文件头 JSDoc。
5. **验证**：`packages/sdk/claude` 下 `tsc --noEmit`（TC.COMPILE）与 `vitest run`（test/events.test.ts 覆盖六条映射、回放、全局过滤、静默跳过、evt_ 前缀、流终止；test/model.test.ts 覆盖 {location,data}、惰性控制 Query、映射四字段与 resolvedModel 保留；test/client.test.ts 覆盖三命名空间、cwd 默认 directory、不启动 HTTP、close 清理）。测试沿用 session.test.ts 的依赖注入手法（FakeQuery/可控 queryFn），不修改 session-01 产物。

## 5. Phase 5 验证结论

- **相关性分级**：LF.SWITCH / LF.EXCEPTION-ONLY / T.ANY / LF.ASSERT / SRC.IMPTYPE 判为 **High**（直接决定归一化正确性与类型安全，缺失将导致缺陷）；其余命名/文档/导入导出/风格规则判为 **Medium**（通用最佳实践），已按要求去除全部代码示例、仅留规则 ID + 级别 + 摘要；未纳入任何 Low 规则。
- **High 规则逐字核验**：上述 High 规则描述与合规示例已对照 `language-features.md`/`type-system.md`/`source-file-structure.md` 原文逐句核对，无删改；`LF.SWITCH`/`LF.EXCEPTION-ONLY`/`T.ANY`/`SRC.IMPTYPE` 的合规示例均逐字取自原文。
- **Medium 无示例核验**：Medium 规则均未包含任何代码示例。
- **无重复**：每条规则在 §2 仅出现一次，§3 只作上下文相关提示不重复全文。
- **行数**：§0-§5 正文约 250 行，未超 300 行上限。
- **一致性**：与 `furina/changes/claude-sdk-adapter/explore-coding/session-01/cleancode.md` 的文档结构、规则 ID、级别惯例保持一致（POL.CONSISTENCY）。
