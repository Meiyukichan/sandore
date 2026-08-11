# CleanCode 探索结果 — infra-01（workspace-and-types）

> 探索类型：cleancode（clean-ts）
> 探索目标：初始化根级 pnpm 工作区与 @meiyukichan/claude-sdk 包脚手架，并编写 `src/types.ts` 定义全部 opencode 协议类型
> 语言：chinese

---

## 0. 项目技术基线核查（本次探索的实地发现）

以下为本次探索实际读取到的项目事实源，供实现 infra-01 时作为技术基线与字段约束依据。**注意：`api.yaml`、`specs/**/*.md`、`design.md`、`plan.json` 均真实存在于 `furina/changes/claude-sdk-adapter/` 目录下**（而非仅 docs/sdk/openapi.json）。

### 0.1 根级现状

- 根目录**无** `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json`（需新建）。
- `packages/sdk/claude` 目录已存在但为**空**（`packages/` 下现有 `cli`/`client`/`daemon`/`sdk`/`server` 五个子目录，均无内容）。
- `.gitignore` 已忽略 `node_modules/`、`dist/`、`coverage*`、`package-lock.json`、`.claude/` 等。
- 项目唯一源码文件为 `scripts/conversation.ts`（TypeScript 为唯一语言，无 Python/TSX）。

### 0.2 技术栈基线（源自 scripts/）

- `scripts/tsconfig.json`：`target: ES2022`、`module: ESNext`、`moduleResolution: bundler`、`strict: true`、`skipLibCheck: true`、`noEmit: true`、`types: ["node"]`。
- `scripts/package.json`：`type: "module"`、`typescript ^5.5.0`、`@types/node ^26.2.0`、`tsx ^4.19.0`、`@anthropic-ai/claude-agent-sdk: latest`（scripts 内为直接依赖）。

### 0.3 @anthropic-ai/claude-agent-sdk 关键类型（scripts/node_modules 实际安装 v0.3.227）

- `Query extends AsyncGenerator<SDKMessage, void>`，方法：`interrupt()`、`setModel()`、`setPermissionMode()`、`supportedModels()`、`initializationResult()` 等。
- `ModelInfo`：`{ value: string; resolvedModel?: string; displayName: string; description: string; supportsEffort?; supportedEffortLevels?; supportsAdaptiveThinking?; ... }` → 映射 ModelV2Info 的 `value→id`、`displayName→name`。
- `ModelUsage`：`{ inputTokens; outputTokens; cacheReadInputTokens; cacheCreationInputTokens; webSearchRequests; costUSD; contextWindow; maxOutputTokens; ... }`（`result` 消息的 `usage`/`total_cost_usd` 是累计值）。
- `SDKResultSuccess`：含 `total_cost_usd`、`usage: NonNullableUsage`、`modelUsage: Record<string, ModelUsage>`、`session_id`、`uuid`、`result`、`stop_reason`、`num_turns`。
- `SDKResultError`：`subtype: 'error_during_execution' | 'error_max_turns' | ...`，含 `errors: string[]`。
- `SDKSystemMessage`（subtype=init）：含 `session_id`、`uuid`、`cwd`、`model`、`tools`、`capabilities?`（如 `interrupt_receipt_v1`）。
- `SDKUserMessage`：`{ type: 'user'; message: MessageParam; parent_tool_use_id: string | null; ... }`。
- `getSessionMessages(sessionId, { dir?, limit?, offset?, includeSystemMessages? })` → `SessionMessage[]`；`SessionMessage = { type: 'user'|'assistant'|'system'; uuid; session_id; message: unknown; parent_tool_use_id; parent_agent_id }`。
- SDK 自身也有 `peerDependencies`：`@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`、`zod`（消费者提供，与 claude-sdk 的 peerDependency 策略一致）。

### 0.4 opencode 协议字段约束（docs/sdk/openapi.json，OpenAPI 3.1，472 schemas，components.schemas）

| 类型 | 必填字段 | 关键 pattern | 备注 |
|---|---|---|---|
| `SessionV2Info` | id, projectID, cost, tokens, time, title, location | id `^ses`；parentID `^ses` | tokens{input,output,reasoning,cache{read,write}}、time{created,updated,archived?} 均含 required + additionalProperties:false |
| `SessionMessagesResponse` | data, cursor | — | data: SessionMessage[]；cursor{previous?, next?} |
| `SessionMessage` | anyOf 8 变体 | — | 变体含 AgentSwitched/ModelSwitched/User/Synthetic/System/Shell/Assistant/Compaction |
| `SessionMessageUser` | id, time, text, type | id `^msg_` | type enum ['user']；含 files/agents/metadata? |
| `SessionMessageSystem` | id, time, type, text | id `^msg_` | type enum ['system'] |
| `PromptInput` | text | — | 含 files?/agents?（PromptInputFileAttachment/PromptAgentAttachment） |
| `SessionInputAdmitted` | admittedSeq, id, sessionID, prompt, delivery, timeCreated | id `^msg_`；sessionID `^ses` | delivery enum ['steer','queue']；promotedSeq? min 0 |
| `ModelRef` | id, providerID | — | variant? |
| `LocationRef` | directory | workspaceID `^wrk` | — |
| `LocationInfo` | directory, project | workspaceID `^wrk` | project{id, directory} |
| `ModelV2Info` | id, providerID, name, api, capabilities, request, variants, time, cost, status, enabled, limit | — | status enum ['alpha','beta','deprecated','active'] |
| `GlobalEvent` | directory, payload | — | directory?/project?/workspace? 顶层可选；payload{id `^evt_`, type, properties}，anyOf 数十种事件变体 |
| `SessionNotFoundError` | _tag, sessionID, message | _tag enum ['SessionNotFoundError'] | — |
| `InvalidRequestError` | _tag, message | _tag enum ['InvalidRequestError'] | kind?/field? |
| `SessionsResponse` | data, cursor | — | data: SessionV2Info[] |

> 注：`TokenUsage`、`Cost`、`TimeoutError` 在 openapi.json 中**不存在**——它们是 api.yaml（适配层自有契约）定义的类型。

### 0.5 api.yaml 适配层契约（furina/changes/claude-sdk-adapter/api.yaml，Swagger 2.0）

- `LocationRef`：required [directory]，properties directory(string)、workspaceID(string, `^wrk`)。
- `ModelRef`：required [id, providerID]，variant?(string, 例 'claude-sonnet-4-0')。
- `TokenUsage`（自有）：input/output/reasoning: integer；cache{read, write}。
- `Cost`（自有）：total_cost_usd(number, 累计美元)、currency(string, default 'USD')。
- `SessionV2Info`：required [id, projectID, cost, tokens, time, title, location]；id 说明"保留 Claude 原始 session_id（如 UUID），不做 ^ses 前缀转换（design.md D7）"；cost/tokens 为 `$ref` 到 Cost/TokenUsage（对象）；time{created, updated(date-time, 必填), archived?}。
- `PromptInput`：required [text]；files?(PromptInputFileAttachment: uri 必填)、agents?(PromptAgentAttachment: name 必填)。
- `SessionInputAdmitted`：required [admittedSeq, id, sessionID, prompt, delivery, timeCreated]；id pattern `^msg_`；delivery enum [steer, queue]。
- `SessionMessage`：id pattern `^msg_`；type enum [user, assistant, system]；time{created?, completed?}；text?；content?(assistant 内容块)；finish?/cost?/tokens?。
- `SessionMessagesResponse`：required [data, cursor]；cursor{previous?, next?}。
- `ModelV2Info`：required [id, providerID, name, status]；status enum [alpha,beta,deprecated,active] default active；variants?(resolvedModel 保留处)。
- `LocationInfo`：required [directory, project]；project{id, directory} 必填。
- `ModelListResponse`：required [location, data]；data: ModelV2Info[]。
- `GlobalEventPayload`：required [id(`^evt_`), type, properties]；properties 常见字段 sessionID/messageID/partID/field/delta/info/finish/cost/tokens/error/status。
- `GlobalEvent`：required [payload]；directory?/project?/workspace? 顶层。
- 错误类型：`SessionNotFoundError`（_tag enum，sessionID, message）、`TimeoutError`（_tag enum，message, timeoutMs?）、`InvalidRequestError`（_tag enum，message, kind?, field?）。

### 0.6 specs / design.md#D8 字段约束要点

- `specs/session-management`：create 返回 SessionV2Info 必含 id/projectID/time/title/location/cost/tokens；prompt 返回 SessionInputAdmitted（id `^msg_`）；messages 返回 `{data, cursor}`；wait 超时抛超时错误；不存在的会话抛 SessionNotFoundError。
- `specs/model-providers`：list 返回 `{location, data}`，ModelV2Info 含 id/providerID/name/status；ModelInfo→ModelV2Info 映射（value→id、displayName→name、providerID='anthropic'、status='active'）。
- `specs/event-streaming`：GlobalEvent 信封 `{directory?, project?, workspace?, payload:{id(`^evt_`), type, properties}}`；SDKMessage→GlobalEvent 映射表（init→session.created、text_delta→message.part.delta、result success→session.next.step.ended 等）。
- `design.md#D8`（工程结构）：明确列出 `packages/sdk/claude/{package.json, tsconfig.json, src/{client,session,model,events,types,session-state}.ts, test/*.test.ts}`；依赖约束——`@anthropic-ai/claude-agent-sdk` 为 **peerDependency**（消费者提供），`typescript`、`vitest` 为 **devDependency**。
- `design.md` 其余关键决策：D3（命名空间无 v2 前缀）、D4（流式统一 GlobalEvent）、D7（session_id 保留原始 ID 不做 ^ses 转换）、D9（model.list 惰性控制 Query）。
- `plan.json` infra-01 acceptance：根级 3 配置 + 包脚手架 + src/types.ts 导出全部协议类型，`tsc --noEmit` 编译通过。

---

## 1. Scope（furina-cleancode 编码指南）

- **Requirement summary**: 初始化根级 pnpm 工作区与 @meiyukichan/claude-sdk 包脚手架，并编写 src/types.ts 定义全部 opencode 协议类型。
- **Code features affected**: 类型声明（接口/类型别名/联合/判别联合/模板字面量模式类型）、字符串字面量枚举、模块导入导出（export type/import type）、工具链配置（tsconfig strict）、JSDoc 注释。

## 2. Guidelines

### 类型声明（协议对象类型）

### T.IFACE 接口优于类型字面量别名 [Required]

**[Description]**
TypeScript 支持为类型表达式命名提供类型别名。这可用于命名原始类型、联合、元组和任何其他类型。
但是，声明对象的类型时，使用接口而不是对象字面量表达式的类型别名。

**[Compliant]**
```ts
interface User {
  firstName: string;
  lastName: string;
}
```

### T.NULL 可空/未定义类型别名 [Required]

**[Description]**
类型别名**禁止**在联合类型中包含 `|null` 或 `|undefined`。可空别名通常表示空值正在通过太多应用程序层传递，这模糊了导致 `null` 的原始问题的来源。它们还使类或接口上的特定值何时可能缺失变得不清楚。
相反，代码**必须**只在实际使用别名时添加 `|null` 或 `|undefined`。代码**应该**在值出现的附近处理空值。

**[Compliant]**
```ts
// Better
type CoffeeResponse = Latte|Americano;

class CoffeeService {
  getLatte(): CoffeeResponse|undefined { ... };
}
```

### T.OPT 优先使用可选而非 `|undefined` [Required]

**[Description]**
TypeScript 支持使用 `?` 的可选参数和字段的特殊构造。可选参数在其类型中隐式包含 `|undefined`，但它们在构造值或调用方法时可以省略。使用可选字段（在接口或类上）和参数而不是 `|undefined` 类型。

**[Compliant]**
```ts
interface CoffeeOrder {
  sugarCubes: number;
  milk?: Whole|LowFat|HalfHalf;
}

function pourCoffee(volume?: Milliliter) { ... }
```

### T.STRUCT 使用结构类型（含 _tag 判别联合） [Required]

**[Description]**
TypeScript 的类型系统是结构化的，不是名义上的。也就是说，如果值至少具有类型要求的所有属性，并且属性的类型匹配（递归地），则值匹配类型。
在提供基于结构的实现时，在符号的声明处显式包含类型（这允许更精确的类型检查和错误报告）。使用接口定义结构类型，而不是类。

**[Compliant]**
```ts
interface Foo {
  a: number;
  b: string;
}

const foo: Foo = {
  a: 123,
  b: 'abc',
}
```

### T.ANY 避免 `any`，使用 `unknown` [Required]

**[Description]**
TypeScript 的 `any` 类型是所有其他类型的超类型和子类型，并允许取消引用所有属性。因此，`any` 是危险的——它可以掩盖严重的编程错误，其使用从一开始就破坏了静态类型的价值。
**考虑*不*要使用 `any`**。在你想要使用 `any` 的情况下，考虑以下之一：提供更具体的类型、使用 `unknown`、抑制 lint 警告并记录原因。

**[Compliant]**
```ts
// Can assign any value (including null or undefined) into this but cannot
// use it without narrowing the type or casting.
const val: unknown = value;
```

### 工具链与配置

### TC.COMPILE 所有 TypeScript 文件必须通过类型检查 [Required]

**[Description]**
所有 TypeScript 文件必须使用标准工具链通过类型检查。不要使用 `@ts-ignore` 或变体 `@ts-expect-error` 或 `@ts-nocheck`。
**为什么？** 它们表面上似乎是"修复"编译器错误的简单方法，但实际上，特定的编译器错误通常是由更大的问题引起的，可以更直接地修复。在单元测试中可以使用 `@ts-expect-error`，但通常**不应该**，因为 `@ts-expect-error` 抑制所有错误，容易意外地过度匹配并抑制更严重的错误。

### 类型声明（其余通用规则）

### T.INF 类型推断 [Recommended]
可以依赖 TypeScript 的类型推断；可轻松推断的简单类型省略注解，复杂表达式应添加注解以提高可读性。

### T.ARRAY Array 类型 [Required]
简单类型（只含字母数字字符和点）使用 `T[]` 或 `readonly T[]` 语法糖，更复杂的情况使用 `Array<T>`。

### T.INDEX 索引签名 [Required]
对象作为关联数组使用时用索引签名 `{[k: string]: T}`，为键提供有意义的标签（如 `{[userName: string]: number}`）；考虑使用 `Map`/`Set`。

### T.MAP 映射和条件类型 [Recommended]
始终使用可以表达代码的最简单类型构造；一点重复或冗长通常比复杂类型表达式的长期成本便宜得多。

### T.OBJ `{}` 类型 [Required]
`{}` 表示任何非空值，很少合适；优先用 `unknown`、`Record<string, T>` 或 `object`。

### T.WRAP 包装器类型 [Required]
禁止使用 `String`、`Boolean`、`Number` 包装器类型，始终使用小写原始类型。

### 命名规范

### NAM.IDENT 标识符 [Required]
标识符只使用 ASCII 字母、数字、下划线（用于常量和结构化测试名）以及（很少使用的）美元符号。

### NAM.STYLE 命名风格 [Required]
名称不应装饰类型信息；禁止下划线前后缀、`opt_` 前缀；不要特别标记接口（如 `IMyInterface`）。

### NAM.DESC 描述性名称 [Required]
名称必须具有描述性，对新读者清晰；不使用模糊缩写，不删除单词内部字母；10 行以内的局部变量可用短名。

### NAM.CAMEL Camel case [Required]
将名称中的缩写视为整词处理，即使用 `loadHttpUrl`，而不是 `loadHTTPURL`。

### NAM.RULE 大小写表 [Required]
`UpperCamelCase`：class/interface/type/enum/类型参数；`lowerCamelCase`：variable/parameter/function/method/property；`CONSTANT_CASE`：全局常量与枚举值。

### NAM.CONST 常量 [Required]
`CONSTANT_CASE` 表示值意图不改变；只有模块级别符号、模块级类的静态字段以及模块级枚举的值可以使用。

### NAM.ALIAS 别名 [Required]
创建现有符号的局部作用域别名时，使用现有标识符的格式（与源相同大小写）。

### 模块导入导出

### SRC.PATH 导入路径 [Required]
引用同一项目文件时使用相对导入（`./foo`），考虑限制父目录层级数量。

### SRC.EXPORT 命名导出 [Required]
所有代码使用命名导出，禁止默认导出；默认导出没有规范名称，使集中维护困难。

### SRC.VIS 导出可见性 [Required]
只导出在模块外部使用的符号，通常最小化模块的导出 API 表面。

### SRC.IMPTYPE `import type` [Required]
仅将导入符号用作类型时使用 `import type {...}`；对值使用常规导入。

### SRC.EXPTYPE `export type` [Required]
重新导出类型时使用 `export type`，例如 `export type {AnInterface} from './foo'`。

### SRC.MOD 使用模块而非命名空间 [Required]
禁止使用 `namespace` 关键字，代码必须使用 ES6 import/export 形式组织代码。

### 注释与文档

### DOC.FORM JSDoc 格式 [Required]
JSDoc 注释必须格式良好；单行 JSDoc 可用单行格式，溢出到多行时必须使用多行样式（`/**` 和 `*/` 单独成行）。

### DOC.EXPORT 文档化所有顶层导出 [Required]
使用 `/** JSDoc */` 注释向代码用户传达信息；避免仅仅重复属性或参数名称。

### DOC.TYPE JSDoc 类型注解 [Required]
JSDoc 类型注解在 TypeScript 源代码中是冗余的，禁止在 `@param` 或 `@return` 中重复声明类型。

### DOC.INFO 注释要添加信息 [Required]
注释必须提供实际信息，避免只是重复参数名称和类型；`@param`/`@return` 行仅在添加信息时才需要。

### 语言特性

### LF.STR 字符串字面量 [Required]
普通字符串字面量用单引号分隔；禁止行延续；复杂字符串连接使用模板字面量。

### LF.ENUMBOOL 枚举布尔强制转换 [Required]
枚举类型（包括与其他类型的联合）的值禁止用 `Boolean()` 或 `!!` 转换为布尔值，必须使用比较运算符显式比较。

### LF.CONSTENUM const enum [Required]
禁止使用 `const enum`；使用普通的 `enum` 代替。

### LF.ASSERT 类型断言 [Required]
类型断言不安全，应优先使用运行时检查；必须使用 `as` 语法而非尖括号；指定对象字面量类型用类型注解（`: Foo`）而非断言（`as Foo`）。

### 代码风格

### CS.ESM Node.js ES 模块 [Required]
推荐使用 Node.js ES 模块。

### CS.NS 命名空间导入 [Recommended]
对于第三方库或有多个导出的模块，使用命名空间导入。

### CS.QUOTE 单引号 [Required]
使用单引号（'）。

### CS.SEMI 显式分号 [Required]
显式使用分号；不要依赖自动分号插入（ASI）。

### CS.LOGGER 禁止 console.log [Required]
禁止使用 console.log，通过 logger 输出日志。

### CS.INDENT 2 空格缩进 [Required]
TypeScript 的缩进风格必须采用 2 个空格缩进。

### CS.JSDOC 文件头与 JSDoc 注释 [Required]
文件头部声明采用 `/** Brief description / @author / @copyright */` 样式；类、main 方法、export 方法、以及确实重要的方法必须要有 JSDoc 注释，常量则使用行前 `//` 注释。

### CS.LINES 文件行数 [Recommended]
普通业务文件 300-500 行；组件/类文件 200-300 行；工具/配置文件 100-200 行；大型模块不超过 800 行。

## 3. Security &amp; production notes

- **T.IFACE / T.NULL / T.OPT（协议字段保真）**：types.ts 的类型必须与事实源 `docs/sdk/openapi.json` 的 `required` 数组和 `additionalProperties: false` 一致——openapi 标记 required 的字段必须是必填接口字段，缺省的字段用 `?` 可选建模，禁止用可空类型别名放宽约束，否则适配层会误信不存在的字段或漏掉必填字段。
- **pattern 前缀约束（^ses / ^msg_ / ^evt_ / ^wrk）**：`SessionV2Info.id`、`SessionInputAdmitted.id`、`SessionInputAdmitted.sessionID`、`LocationRef.workspaceID` 等字段在 openapi 中有 `pattern` 约束，建议用模板字面量类型建模（如 `type SessionID = \`ses${string}\``、`type MessageID = \`msg_${string}\``、`type WorkspaceID = \`wrk${string}\``），在编译期强制前缀，而不是裸 `string`。
- **T.STRUCT / 错误 `_tag` 判别联合**：openapi 中 UnauthorizedError、ConflictError、InvalidCursorError、InvalidRequestError 等以 `_tag` 字段（字符串字面量 enum 等于类型名）作判别式，应建模为判别联合（如 `type ClaudeSDKError = UnauthorizedError | ConflictError | ...`），`_tag` 字段用字符串字面量且必填。
- **TC.COMPILE**：goal 要求 `tsc --noEmit` 通过。根 tsconfig.base.json 与 packages/sdk/claude/tsconfig.json 必须开启 `strict`（含 strictNullChecks），使上述协议字段错误在声明期即被捕获，而不是运行时。
- **LF.CONSTENUM / LF.ENUMBOOL**：delivery（steer|queue）、status（alpha|beta|deprecated|active）在 openapi 中是字符串枚举，建议建模为字符串字面量联合类型（`type Delivery = 'steer' | 'queue'`），不要用 TS `enum` 数值枚举，避免首枚举值 0 的真值陷阱与运行时序数泄漏。

---

## 4. 与 infra-01 直接相关的落地要点（结合上述标准与事实源）

1. **根级三文件**：`pnpm-workspace.yaml`（`packages: ['packages/*']`）、根 `package.json`（`private: true`、`type: 'module'`）、`tsconfig.base.json`（`target: ES2022`、`module: ESNext`、`moduleResolution: bundler`、`strict: true`、`skipLibCheck: true`，并可为 `noEmit`/`types:['node']` 基线与 scripts/ 对齐）。
2. **包脚手架** `packages/sdk/claude/package.json`：name `@meiyukichan/claude-sdk`、`type: 'module'`；`@anthropic-ai/claude-agent-sdk` 声明为 **peerDependency**（版本建议 `>=0.3.0`，design.md Open Questions 待确认）；`typescript`、`vitest` 为 **devDependency**；`tsconfig.json` 以 `"extends": "../../../tsconfig.base.json"` 继承 base。
3. **src/types.ts 类型清单与约束**：
   - 对象类型用 `interface`；可选字段用 `?`；禁止可空别名放宽。
   - ID pattern 用模板字面量类型（`\`ses${string}\`` 等），但注意 design.md D7：`SessionV2Info.id` 保留 Claude 原始 session_id（UUID），不做 `^ses` 转换——类型层面应体现该偏差（可注释说明）。
   - 枚举用字符串字面量联合：`Delivery = 'steer' | 'queue'`、`ModelStatus = 'alpha' | 'beta' | 'deprecated' | 'active'`。
   - `GlobalEvent`：`{ directory?; project?; workspace?; payload: { id: \`evt_${string}\`; type: string; properties: Record<string, unknown> } }`；payload 的 id 用 `^evt_` 前缀模板类型。
   - `TokenUsage`、`Cost`、`TimeoutError` 为适配层自有类型（api.yaml definitions），非 openapi.json 定义。
   - 错误类型用 `_tag` 判别联合：`SessionNotFoundError`（sessionID 必填）、`TimeoutError`（timeoutMs?）、`InvalidRequestError`（kind?/field?）。
   - 导出仅命名导出（`export type`），使用 `import type` 引入 SDK 类型（如 `ModelInfo`、`SDKUserMessage`）。
   - 所有顶层导出配 JSDoc；文件头配 `/** ... */` 描述。
4. **验证**：`packages/sdk/claude` 下执行 `tsc --noEmit` 通过（TC.COMPILE）。
