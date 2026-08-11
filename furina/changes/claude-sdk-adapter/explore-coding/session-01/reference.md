## Exploration Result

### Phase 1: 参考资料配置

`furina config show exploration.reference` 返回空数组 `[]`，但 exploreContent 已显式列出本次探索所需的参考资料（`@anthropic-ai/claude-agent-sdk` 的 `query()` 流式输入模式、`scripts/conversation.ts`、`docs/sdk/claude` 文档、`specs/session-management/spec.md`、`design.md` 的 D2/D5/D7、`src/types.ts` 已有类型、会话状态判断），故按下述清单逐项探索：

1. `packages/sdk/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（SDK v0.3.227 源类型权威定义）
2. `scripts/conversation.ts`（流式输入 + 流式输出模式的参考蓝本）
3. `docs/sdk/claude/*.md`（typescript-sdk-api、streaming-vs-single-mode、streaming-output、sessions、agent-loop）
4. `furina/changes/claude-sdk-adapter/specs/session-management/spec.md` 与 `event-streaming/spec.md`
5. `furina/changes/claude-sdk-adapter/design.md`（D2/D5/D7 决策）
6. `furina/changes/claude-sdk-adapter/api.yaml`（方法级客户端契约）
7. `packages/sdk/claude/src/types.ts` 与 `test/types.test.ts`（infra-01 已有类型定义与测试惯例）
8. `docs/sdk/openapi.json`（目标协议 SessionV2Info / SessionInputAdmitted 等 schema）

---

### Phase 2: 需求理解

**What**：实现会话管理核心——`SessionState`（`src/session-state.ts`）封装每个会话的 Claude SDK `Query` 句柄、流式输入队列（push/yield）、原始 `SDKMessage` 事件通道与后台 query 泵；`SessionManager`（`src/session.ts`）维护 `Map<sessionId, SessionState>`，对外提供 `create / messages / prompt / interrupt / wait / close` 方法集，将 Claude SDK 一体化的 `query()` AsyncGenerator 解耦为 opencode 协议风格的三段式会话方法。

**Boundaries**：仅覆盖 plan.json 中 `session-01` 范畴——SessionState 后台状态与 SessionManager 方法集。不涉及 `event-01` 的 SDKMessage→GlobalEvent 归一化（session-state.ts 只承载原始 SDKMessage 通道，归一化由 event-01 负责）、`model-01` 的模型查询、`client.ts` 工厂装配。参考物聚焦：query() 流式输入模式、会话状态判断、spec 的六个 Requirement、design.md D2/D5/D7、api.yaml 方法契约、types.ts 已有类型。

**Goal**：摸清 (a) 后台 query 泵与可控输入队列（push/yield）的精确实现形态（SDK 签名 + conversation.ts 蓝本）；(b) `system/init` 捕获 session_id 与超时保护的时序；(c) 会话状态机（`session_state_changed` 的 idle/running/requires_action 三态）及 `wait()` 事件驱动依据；(d) 六个方法各自需要调用的 SDK 能力（`Query.interrupt()`、`getSessionMessages()`、`Query.close()`）与返回的 opencode 类型字段；(e) types.ts 中已就绪、可直接复用的类型，以及 test 的编写惯例。

---

### Phase 3: 参考物探索结果

#### 3.1 `query()` 流式输入模式（SDK 签名 + `scripts/conversation.ts` 蓝本）

**SDK 签名**（`sdk.d.ts`）：
```ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  close(): void;
  // ... setPermissionMode / setModel / supportedCommands / supportedAgents 等
}
```
- **流式输入模式 = `prompt` 传 `AsyncIterable<SDKUserMessage>`**（`docs/sdk/claude/streaming-vs-single-mode.md` 明确其为「默认和推荐」模式）：代理作为长期运行进程，通过生成器**逐个 yield 用户消息**实现多轮持久会话；会话 ID 在 `system/init` 消息中**更早获得**（比 result 消息早）。
- **`Options` 相关字段**（session-01 需要的）：`cwd?: string`（默认 `process.cwd()`）、`agent?: string`（主线程代理名，须在 agents 或设置中定义）、`model?: string`（模型别名或完整名）、`includePartialMessages?: boolean`（true 时产出 `SDKPartialAssistantMessage` token 级事件）、`resume?`、`maxTurns?`、`allowedTools?`、`permissionMode?`。
- **`SDKControlInterruptResponse`**（`interrupt()` 的返回）：`{ still_queued: string[], cancelled?: string[] }`——`still_queued` 为中断后仍将执行的异步用户消息 UUID；CLI 通告 `interrupt_receipt_v1` 能力时 resolve 该收据，旧 CLI resolve `undefined`。

**`scripts/conversation.ts` 的可控输入队列模式**（适配层 inputQueue 的直接蓝本）：
```ts
const pending: SDKUserMessage[] = [];
let wake: (() => void) | null = null;

function enqueueUserMessage(text: string): void {
  pending.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  wake?.();
}

async function* chatStream(): AsyncGenerator<SDKUserMessage> {
  for (;;) {
    while (pending.length === 0) {
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = null;
    }
    yield pending.shift()!;
  }
}
// query({ prompt: chatStream(), options: { cwd, includePartialMessages: true, ... } })
```
要点：队列数组 + `wake` 唤醒函数解耦「stdin 读入」与「消息流消费」两个并行异步任务；`prompt()` 对应 `enqueueUserMessage`（push），生成器对应 `for(;;)` 循环内 `yield pending.shift()`。**这是一个永不完结的无限生成器**——query 泵需在 `close()` 时主动终止。

`conversation.ts` 对 init 消息的处理（session_id 捕获点）：
```ts
case "system":
  if (message.subtype === "init") { sessionId = message.session_id; }
```
流式输出消费用 `includePartialMessages: true` 产出的 `stream_event`（`content_block_delta`/`text_delta`/`input_json_delta`），回合结束收到 `result`（`subtype === "success"` 时打印 `message.result`）；结束时 `q.close()` 关闭查询并终止底层 CLI 进程。

#### 3.2 SDKMessage 类型与会话状态判断（会话状态机）

**`SDKSessionStateChangedMessage`**（`sdk.d.ts` 精确定义）——wait() 状态驱动的核心：
```ts
export declare type SDKSessionStateChangedMessage = {
  type: 'system';
  subtype: 'session_state_changed';
  state: 'idle' | 'running' | 'requires_action';
  uuid: UUID;
  session_id: string;
};
```
- **三态状态机**：`idle`（空闲/等待下一条输入）｜`running`（agent loop 执行中）｜`requires_action`（等待用户输入，如权限请求/AskUserQuestion）。
- `event-streaming/spec.md` 映射：`system (session_state_changed, idle)` → GlobalEvent `session.idle`（`{sessionID, status}`）；`design.md` D4 映射表同样将 `system (session_state_changed)` 归为 `session.idle` / `session.status`。
- `design.md` 风险段明确 wait() 语义：**「基于结果消息/状态变更事件驱动，避免高频轮询；超时退出」**——即 wait 应监听 `session_state_changed`（state→idle）与 `result` 消息，而非轮询。

**`SDKResultMessage`**（回合结束标记，也是 idle 判据）：
```ts
type SDKResultMessage = SDKResultSuccess | SDKResultError;
type SDKResultSuccess = {
  type: 'result'; subtype: 'success';
  uuid; session_id; duration_ms; duration_api_ms;
  total_cost_usd: number; usage; modelUsage; ...
};
type SDKResultError = { type: 'result';
  subtype: 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  ...; errors: string[]; };
```
`agent-loop.md` 提示：`result` 标记代理循环结束，但少数尾随系统事件（如 `prompt_suggestion`）可能在其后到达，故**迭代流直到完成**，而非在 result 处中断——wait() 若仅以 result 判定 idle 需注意此边界。

**`SDKUserMessage`**（prompt 入队载荷）：
```ts
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;          // { role:'user', content:text } 或内容块数组
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  uuid?: UUID;
  session_id?: string;
  shouldQuery?: boolean;
  tool_use_result?: unknown;
  priority?: 'now' | 'next' | 'later';
  origin?: SDKMessageOrigin;
};
```
spec 要求 prompt() push 精确形态：`{ type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null }`（uuid/session_id 可省）。

**`SDKSystemMessage`（init）**——create 捕获 session_id 与构造 SessionV2Info 的数据源：
```ts
type SDKSystemMessage = {
  type: 'system'; subtype: 'init';
  uuid; session_id: string;          // ← 会话 ID 捕获点
  cwd: string; model: string; permissionMode: PermissionMode;
  claude_code_version: string; agents?: string[];
  capabilities?: string[];           // 含 interrupt_receipt_v1（feature-detect interrupt）
  ...
};
```

#### 3.3 SessionState 所需：后台 query 泵、输入队列 push/yield、SDKMessage 事件通道、init 捕获超时保护

`design.md` D2 给出了 SessionState 的精确结构图：
```
session.create()
   ├─▶ 启动 query({ prompt: inputQueue, options: {includePartialMessages:true} })
   │      ├─ system/init ──▶ resolve SessionV2Info（session_id 捕获）
   │      ├─ stream_event ──▶ 推入 sessionEvents 通道
   │      ├─ assistant ────▶ 推入 sessionEvents 通道
   │      └─ result ───────▶ 推入 sessionEvents 通道
   ├─▶ inputQueue: AsyncIterable<SDKUserMessage>（由 prompt() 控制 yield）
   └─▶ SessionState { query, sessionId, inputQueue, eventsChannel }
```
- **后台 query 泵**：`session.create()` 内部以**后台异步任务**启动 query 并消费 `for await (const message of q)`，将每类 SDKMessage 分发到事件通道；`system/init` 到达时用 Promise resolve 捕获的 session_id。create() **在 init 后即 resolve，不阻塞等待后续消息**（spec + api.yaml）。
- **init 捕获超时保护**：`spec`「Create session」场景 3 + api.yaml 408 响应 + `design.md` 风险段「用 Promise 在 init 消息到达时 resolve；设置超时保护」——init 在合理超时内未到达则 reject 并抛 `TimeoutError`（types.ts 已定义 `{ _tag:'TimeoutError', message, timeoutMs? }`）。
- **事件通道**：session-state 承载**原始 SDKMessage 通道**（回放型广播通道语义在 event-01/events.ts 实现，本文件只做通道容器与后台泵分发）。

#### 3.4 SessionManager 方法集：create / messages / prompt / interrupt / wait / close

**create(options)** → `SessionV2Info`：
- spec 必填字段：`id / projectID / time / title / location / cost / tokens`；`location.directory` 等于客户端 cwd；`agent` 透传给 query() options.agent 且含于 SessionV2Info。
- `id` = Claude 原始 session_id（**不做 `^ses` 前缀转换**，design.md D7，保证 resume/getSessionMessages 可用）。
- `projectID` 由 cwd 编码生成（api.yaml 注释；opencode 侧无明确编码算法，实现时自定）。
- `model`（ModelRef `{ id, providerID:'anthropic' }`）由 options 传入。
- 启动超时（init 未达）reject 抛 `TimeoutError`。

**messages(sessionId, options?)** → `SessionMessagesResponse { data, cursor }`：
- 内部调用 SDK `getSessionMessages(sessionId, options)`：`GetSessionMessagesOptions = { dir?, limit?, offset?, includeSystemMessages?, sessionStore? }`；返回 `SessionMessage[] = { type:'user'|'assistant'|'system', uuid, session_id, message: unknown, parent_tool_use_id, parent_agent_id }`。
- 注意差异：SDK 用 `limit`/`offset` 分页，而 opencode `cursor` 为不透明 `{ previous?, next? }`——适配层需自行在 offset 与 cursor 之间做映射（`api.yaml` 定义的 messages 入参含 `limit`、`cursor`、`order`）。

**prompt(sessionId, input)** → `SessionInputAdmitted`：
- 向该会话输入队列 push `{ type:'user', message:{ role:'user', content: input.prompt.text }, parent_tool_use_id:null }`（spec「Send message」场景 1 的精确载荷）。
- 返回 `SessionInputAdmitted`：required `[admittedSeq, id, sessionID, prompt, delivery, timeCreated]`；`id` 以 `msg_` 前缀生成（types.ts `MessageID = \`msg_${string}\``）；`delivery` 本适配层固定 `'queue'`；`timeCreated` 为 date-time 字符串。
- 会话不存在 → 抛 `SessionNotFoundError`（types.ts 已定义 `{ _tag:'SessionNotFoundError', sessionID, message }`）。

**interrupt(sessionId)**：
- 调用该会话 `Query.interrupt(): Promise<SDKControlInterruptResponse | undefined>`（D5 决策）；空闲会话中断为 **no-op（不抛错）**（spec 场景 2）。
- 前置条件：CLI 需通告 `interrupt_receipt_v1` 能力（init 的 `capabilities`）；无能力时 design.md 提示降级为 close()。

**wait(sessionId, options?)**：
- D5 决策 + api.yaml 描述：**基于结果消息/状态变更事件驱动，避免高频轮询**；对应 opencode v2 `POST /api/session/{id}/wait`。
- 支持 `timeout` 参数；超时 reject 抛 `TimeoutError`（spec 场景 2，如 5 秒未空闲）。
- idle 判据：`session_state_changed` 消息 `state === 'idle'`，或 `result` 消息（回合结束）。

**close(sessionId)**：
- 调用 `Query.close()`（强制结束查询、清理资源含 CLI 子进程）；关闭事件通道、SessionState 从 `Map` 移除（spec「Session state management」场景 2）。

#### 3.5 会话状态判断（三态 + 事件驱动）归纳

| 判据 | SDK 消息 | state / subtype | 用途 |
|---|---|---|---|
| 空闲 | `system / session_state_changed` | `state: 'idle'` | wait() 完成信号；映射 `session.idle` |
| 执行中 | `system / session_state_changed` | `state: 'running'` | wait() 持续等待；interrupt 有效 |
| 需用户输入 | `system / session_state_changed` | `state: 'requires_action'` | 权限/AskUserQuestion 挂起态 |
| 回合结束 | `result` | `subtype: 'success' \| 'error_*'` | 回合完成的补充判据（result 后通常回到 idle） |
| 会话初始化 | `system / init` | `subtype: 'init'` | create() 捕获 session_id |

`SessionState` 应持有当前 state（初始可视为 running/待 init），后台泵在收到 `session_state_changed` 与 `result` 时更新并唤醒 wait 等待者。

#### 3.6 `src/types.ts` 已有类型（infra-01 产出，session-01 直接复用）

- 会话：`SessionV2Info`（required `id/projectID/cost/tokens/time/title/location`；`time: {created,updated,archived?}` date-time 字符串；`cost: Cost`；`tokens: TokenUsage`）、`SessionMessagesResponse { data, cursor:{previous?,next?} }`、`SessionMessage`（`id: MessageID(^msg_)`、`type: 'user'|'assistant'|'system'`、`time?{created?,completed?}`、`text?`、`content?`、`finish?/cost?/tokens?`）、`SessionMessageAssistantContent`（Text/Reasoning/Tool 联合）。
- 输入：`PromptInput`（required `text`；`files?/agents?`）、`SessionInputAdmitted`（required `admittedSeq/id/sessionID/prompt/delivery/timeCreated`；`delivery: 'steer'|'queue'`；`id: MessageID`）。
- 引用/通用：`LocationRef`（required `directory`；`workspaceID?`）、`ModelRef`（required `id/providerID`；`variant?`）、`TokenUsage`、`Cost`、`Delivery`。
- 错误：`SessionNotFoundError`、`TimeoutError`、`InvalidRequestError`、`ClaudeSDKError`（`_tag` 判别联合）。
- ID 前缀类型：`MessageID = \`msg_${string}\``、`EventID = \`evt_${string}\``、`WorkspaceID = \`wrk${string}\``。
- **注意**：types.ts 的 `SessionV2Info.id` 类型为 `string`（非 `^ses` 前缀约束），与 D7「保留 Claude 原始 session_id」一致；`SessionInputAdmitted.timeCreated` 为 date-time 字符串（api.yaml 口径，非 openapi 的 number）。

#### 3.7 工程基线与会话状态判断的测试惯例

- `packages/sdk/claude`：包名 `@meiyukichan/claude-sdk`、`type: module`、peer `@anthropic-ai/claude-agent-sdk >=0.3.0`、dev `typescript`/`vitest`；`tsconfig.json` 继承根 `tsconfig.base.json`（ES2022/ESNext/bundler/strict），include `["src", "test"]`；scripts `test: vitest run`、`typecheck: tsc --noEmit`。
- `test/types.test.ts` 惯例：`import { describe, expect, expectTypeOf, it } from 'vitest'`；编译期用 `expectTypeOf`、运行期用值构造 + `expect`。`session-01` 的 `test/session.test.ts` 应沿用同一风格，但 session 方法需要 mock `query()`/`getSessionMessages()`（vitest `vi.mock`）或注入 fake Query 实现。
- `plan.json` 中 `session-01` acceptance criteria（实现验收口径）：create 捕获 init session_id 后 resolve（location.directory=cwd）、agent 透传、init 超时 reject；messages 返回 `{data, cursor}`；prompt push SDKUserMessage 并返回 `SessionInputAdmitted`（id 以 `msg_` 开头）、不存在会话抛 SessionNotFoundError；interrupt 调 Query.interrupt()、空闲 no-op；wait 空闲 resolve、超时抛错；Map 状态隔离、close 清理；test 全部通过。

---

## Supplementary Exploration Result

`experimental.websearch=true`、`experimental.context7=true`。本次参考物（SDK 本地类型定义 `sdk.d.ts`、`docs/sdk/claude/*.md` 官方文档、`spec.md`/`design.md`/`api.yaml` 本地权威契约、`types.ts` 已落地类型）信息充分且互为印证，足以支撑 `session-01` 的 SessionState 与 SessionManager 实现；会话状态判断（`session_state_changed` 三态）、query 流式输入模式、六个方法语义均已有权威来源，无需启用 websearch/context7 补充查询。无额外补充结果。
