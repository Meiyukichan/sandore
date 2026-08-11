# 规范材料探索：SessionState 后台状态与 SessionManager 方法集（session-01）

> 探索类型：specification
> 探索日期：2026-08-11
> 项目路径：`D:\project-code\llm\sandore`
> 输出目录：`furina/changes/claude-sdk-adapter/explore-coding/session-01`

## 一、需求理解（Phase 2）

### What
实现会话管理核心（plan.json `session-01`），含两个模块：

1. **SessionState（`src/session-state.ts`）**——每个会话的后台状态封装：
   - 持有 Claude SDK 的 `Query` 句柄；
   - 流式输入队列（`push`/`yield` 模式，异步生成器供 `query()` 的 `prompt` 消费）；
   - **SDKMessage 事件通道**（原始 `SDKMessage` 广播/回放通道，归一化为 GlobalEvent 由 event-01 负责，本任务只透传原始消息）；
   - **后台 query 泵**：启动 `query({ prompt: 输入队列, options: { includePartialMessages: true, cwd, agent, model } })`，消费首条 `system/init` 消息捕获 `session_id`（带超时保护）。

2. **SessionManager（`src/session.ts`）**——维护 `Map<sessionId, SessionState>`，实现六个方法：
   - `create`：后台启动 query，`init` 后 resolve `SessionV2Info`；
   - `messages`：包装 `getSessionMessages()` 返回 `SessionMessagesResponse{data, cursor}`；
   - `prompt`：向会话输入队列 push `SDKUserMessage`，返回 `SessionInputAdmitted`（id 以 `msg_` 前缀生成）；不存在的会话抛 `SessionNotFoundError`；
   - `interrupt`：调用 `Query.interrupt()`；空闲会话为 no-op；
   - `wait`：基于结果/状态变更事件驱动等待空闲，支持 `timeout` 参数，超时抛 `TimeoutError`；
   - `close`：关闭 Query 并从 Map 清理。

### Boundaries
- **源接口**：`@anthropic-ai/claude-agent-sdk` v0.3.227（`scripts/node_modules/.../sdk.d.ts`、`docs/sdk/claude/*.md`、`scripts/conversation.ts` 已验证蓝本）。
- **适配层契约**：`furina/changes/claude-sdk-adapter/api.yaml` 的 `/client/session/*` 五个端点 + `specs/session-management/spec.md` + `design.md#D2/D5/D7`。
- **已有类型**：`packages/sdk/claude/src/types.ts`（infra-01 已完成）——`SessionV2Info`、`SessionMessagesResponse`、`SessionInputAdmitted`、`PromptInput`、错误类型等，本任务直接复用。
- **输出位置**：`packages/sdk/claude/src/session-state.ts`、`src/session.ts`、`test/session.test.ts`（当前均不存在，仅 `src/types.ts` 与 `test/types.test.ts` 已就绪）。
- **范围排除**：SDKMessage→GlobalEvent 归一化、`session.events()`/`global.event()` 属 event-01；本任务仅维护「原始 SDKMessage 事件通道」。

### Goal
为 `session-01` 的实施提供方法级精确依据：每个 SessionManager 方法的语义、SessionState 的内部结构、所涉及的 Claude SDK 类型与关键字段、design.md 决策约束，以及 api.yaml/spec/design 与 SDK 实际行为之间的差异，避免实现与契约不一致。

---

## 二、工程现状

- `packages/sdk/claude/src/` 当前仅含 `types.ts`（infra-01 产物）；`session-state.ts`、`session.ts` 待创建。
- `packages/sdk/claude/test/` 仅含 `types.test.ts`；`session.test.ts` 待创建。
- `packages/sdk/claude/package.json`：`@meiyukichan/claude-sdk`，`type: module`；`@anthropic-ai/claude-agent-sdk >=0.3.0` 为 peerDependency；`vitest` 为 devDependency（test 脚本 `vitest run`、typecheck 脚本 `tsc --noEmit`）。
- `furina config show exploration.specification` 返回空数组 `[]`，无预置规范材料配置；本次按 exploreContent 直接探索指定参考材料。
- `scripts/conversation.ts` 已演示「流式输入 + 流式输出 + 会话管理」的完整可用模式（见第三节）。

---

## 三、scripts/conversation.ts 流式输入模式实现（参考蓝本）

`scripts/conversation.ts` 是 `query()` 流式输入模式的多轮持久会话验证蓝本，其关键结构直接映射到 SessionState 的输入队列与后台 query 泵：

### 3.1 流式输入队列（push/yield 解耦）

```ts
const pending: SDKUserMessage[] = [];
let wake: (() => void) | null = null;

function enqueueUserMessage(text: string): void {
  pending.push({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  });
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
```

- 队列 + `wake` 回调实现「stdin 读取」与「消息流消费」两个并行异步任务解耦；`prompt()` 入队即唤醒生成器 yield。
- **关键点**：`wake` 是单占位——一次只允许一个等待者。SessionState 封装此模式时需保留 push（`enqueueUserMessage` 等价）与 yield（`chatStream` 等价）两侧。

### 3.2 后台 query 泵与 init 捕获

```ts
const q = query({
  prompt: chatStream(),                       // 传异步生成器 => 流式输入模式
  options: {
    cwd: process.cwd(),
    resume: resumeSessionId,                  // 可选恢复
    includePartialMessages: true,             // 开启 token 级流式事件
    maxTurns: 20,
    allowedTools: ["Read", ...],
  },
});

for await (const message of q) {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        sessionId = message.session_id;       // 首条 system/init 捕获 session_id
        ...
      }
      break;
    case "stream_event": { ... }              // includePartialMessages 逐 token
    case "assistant": { ... }                 // 完整助手消息
    case "result": { ... }                    // 回合结束（success / error）
  }
}
```

- `query()` 返回 `Query`（`AsyncGenerator<SDKMessage, void>`），消费即泵；`system/init` 是首个携带 `session_id` 的消息（`SDKSystemMessage.session_id`）。
- 结束会话用 `q.close()`（终止底层 CLI 进程）。

### 3.3 会话状态判断线索

- 循环结束由 `result` 消息标记（`subtype: 'success' | 'error_*'`）。
- SDK 另有 `system/subtype='session_state_changed'` 消息（`SDKSessionStateChangedMessage`）带 `state: 'idle' | 'running' | 'requires_action'`——这是 `wait()` 事件驱动空闲判断的关键消息（见 5.3）。

---

## 四、SessionState（src/session-state.ts）设计依据

### 4.1 封装内容（design.md D2 / plan.json 任务 2.1）

design.md D2 明确 SessionState 组成与三段式解耦：

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

SessionState 应至少持有：
- `query: Query` —— `query()` 返回的句柄（AsyncGenerator + 控制方法）。
- `sessionId: string` —— init 捕获后回填。
- 输入队列 —— push/yield 双向接口（封装第三节的 `pending` + `chatStream` 模式）。
- **SDKMessage 事件通道** —— 后台泵消费的每条原始 `SDKMessage` 都推入该通道；event-01 的 `session.events()` 从这里读取并归一化为 GlobalEvent。design.md D4 要求该通道为**回放型广播通道**（晚订阅者仍收到 session.created 等已发生事件，会话结束后流正常终止）——本任务只保证原始 SDKMessage 被缓冲/广播，归一化由 event-01 负责。

### 4.2 后台 query 泵的 options（plan.json 任务 2.1）

- `prompt`：输入队列的异步生成器（`AsyncIterable<SDKUserMessage>`）→ 流式输入模式（多轮持久会话），非单消息字符串。
- `options.includePartialMessages: true` —— 开启 `stream_event`（token 级）事件。
- `options.cwd` —— 客户端 `cwd`（默认 `process.cwd()`）。
- `options.agent` —— create 时透传（如 `'general-purpose'`）。
- `options.model` —— create 时透传（`Options.model: string`，如 `'claude-sonnet-5'`；api.yaml 的 body.model 为 `ModelRef{id, providerID}`，实现时取 `id`）。

### 4.3 init 捕获超时保护

- design.md 风险项：**「session.create() 必须等 system/init 产出 session_id 才能返回 SessionV2Info，存在启动延迟。→ 用 Promise 在 init 消息到达时 resolve；设置超时保护。」**
- api.yaml `/client/session/create`：`session.create() 在 session_id 捕获后 resolve，不阻塞等待后续消息；启动超时 reject`；408 响应 `TimeoutError`（`{_tag:'TimeoutError', message, timeoutMs?}`）。
- 超时机制：等待 init 的 Promise 与一个 timer 竞争，超时后 reject `TimeoutError`（timeoutMs 填入）。

### 4.4 空闲/运行状态跟踪（wait 的前提）

SessionState 需维护会话当前状态，供 `interrupt`（空闲 no-op）与 `wait`（等待空闲）判断。状态来源：
- `SDKSessionStateChangedMessage`（`subtype='session_state_changed'`，`state: 'idle' | 'running' | 'requires_action'`）；
- `SDKResultMessage`（`type='result'`）——一轮结束（design.md D5「wait() → 轮询会话状态直到 idle」「基于结果消息/状态变更事件驱动，避免高频轮询」）。

---

## 五、SessionManager（src/session.ts）方法集依据

对应 `specs/session-management/spec.md` 全部 Requirement 与 api.yaml `/client/session/*` 五个端点。

### 5.1 create（spec「Create session」/ api.yaml ①）

- 行为：后台启动 query（见 4.2），捕获 `system/init` 的 `session_id` 后 resolve `SessionV2Info`；不阻塞等待后续消息。
- 返回 `SessionV2Info`（api.yaml definitions / types.ts）：
  - 必填 `id`、`projectID`、`cost`、`tokens`、`time`、`title`、`location`；
  - `id` —— 保留 Claude 原始 session_id（UUID），**不做 `^ses` 前缀转换**（design.md D7）；
  - `location.directory` —— 客户端 cwd（create 未传 location 时，api.yaml：省略时使用客户端 cwd 作为默认 location）；
  - `projectID` —— 由 cwd 编码生成（spec「cwd 作为默认项目标识」；具体编码算法本任务未定，须实现时确定）；
  - `agent` —— create 入参透传（spec 场景：`create({ agent: 'general-purpose' })` 时 SessionV2Info 含该值）；
  - `model` —— `ModelRef{id, providerID}`（api.yaml body.model）；
  - `cost`/`tokens`/`time`/`title` —— 字段口径见 infra-01 探索（Cost 对象、TokenUsage 全可选、time 为 date-time 字符串）；具体取值来源（init 后可用数据有限）需实现时决策（如 cost/tokens 初始空、title 取首条 prompt 或空）。
- 超时：`system/init` 未在合理时间内到达 → reject `TimeoutError`。

### 5.2 messages（spec「Read session messages」/ api.yaml ②）

- 行为：包装 `getSessionMessages(sessionId, options)` 返回 `SessionMessagesResponse{ data, cursor:{previous?, next?} }`。
- Claude SDK 签名：`getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>`；options：`dir`、`limit`、`offset`、`includeSystemMessages?`、`sessionStore?`。
- **分页映射差异（重要）**：Claude SDK 是 `limit`/`offset` 整数分页；opencode 的 `SessionMessagesResponse.cursor` 是 `previous`/`next` **不透明游标**。api.yaml 端点入参为 `limit` + `cursor`（不透明字符串）+ `order`。实现需把 `cursor` 解码为 offset（或编码 offset 进 cursor），并把 limit/offset 结果映射为 `{data, cursor}`。
- **消息归一化差异**：Claude `SessionMessage` 为 `{type: 'user'|'assistant'|'system', uuid, session_id, message: unknown, parent_tool_use_id, parent_agent_id}`；opencode `SessionMessage`（types.ts）为 `{id: msg_*, type, text?/content?, time?, finish?, cost?, tokens?}`，需从 `message: unknown`（原始消息 payload）提取 text/content 并映射 `uuid→id`（加 `msg_` 前缀）。此映射属 messages 方法职责（非 event-01 归一化）。
- 会话不存在：api.yaml 404 返回 `SessionNotFoundError`（与 prompt 一致；spec 未单独列 messages 的 not-found 场景，但 api.yaml 定义 404）。

### 5.3 prompt（spec「Send message (prompt)」/ api.yaml ③）

- 行为：向该会话输入队列 push 一条 `SDKUserMessage`，返回 `SessionInputAdmitted`。
- push 形状（api.yaml 明确）：
  ```
  { type:'user', message:{ role:'user', content: input.prompt.text }, parent_tool_use_id:null }
  ```
  （`input.prompt` 为 `PromptInput{text, files?, agents?}`；files/agents 附件本任务范围内不处理，`content` 用 `text`。）
- 返回 `SessionInputAdmitted`（types.ts / api.yaml definitions）：
  - **必填**：`admittedSeq`（`>=0`，本会话自增序号）、`id`（`^msg_` 前缀，`MessageID` 模板 `msg_${string}`，归一化时生成）、`sessionID`、`prompt`（原样回显 `PromptInput`）、`delivery`（types.ts `Delivery = 'steer'|'queue'`；api.yaml 默认 `queue`）、`timeCreated`（date-time 字符串）；
  - 可选：`promotedSeq`（`>=0`）。
- **不存在的会话抛 `SessionNotFoundError`**（spec 场景 / api.yaml 404）：从 `Map<sessionId, SessionState>` 查不到即抛 `{_tag:'SessionNotFoundError', sessionID, message}`。
- id 生成：`msg_` 前缀（可用 Claude uuid 映射或随机生成，design.md D7）。

### 5.4 interrupt（spec「Interrupt session execution」/ api.yaml ④）

- 行为：调用该会话 `Query.interrupt()`。
- SDK 签名：`interrupt(): Promise<SDKControlInterruptResponse | undefined>`（`SDKControlInterruptResponse = { still_queued: string[] }`，需 CLI 通告 `interrupt_receipt_v1` 能力；旧 CLI resolve `undefined`）。
- 空闲会话 no-op：spec 场景「会话处于空闲状态时调用不抛错，操作为 no-op」——SessionState 若记录状态为 idle（见 4.4），则跳过 `interrupt()` 调用。
- design.md 风险：**「interrupt() 需 CLI 通告 interrupt_receipt_v1 能力；无能力时降级为 close()」**（api.yaml ④ 也标注此前置条件）。
- 不存在的会话：api.yaml 404 `SessionNotFoundError`（spec 未列但契约如此）。

### 5.5 wait（spec「Wait for session idle」/ api.yaml ⑤）

- 行为：等待会话 agent loop 变为空闲。**事件驱动**：基于结果消息/状态变更事件（`SDKSessionStateChangedMessage.state==='idle'` 或 `SDKResultMessage`），避免高频轮询（design.md D5 / 风险项）。
- 支持 `timeout` 参数（api.yaml ⑤ body.timeout 毫秒数）；超时 reject `TimeoutError`（spec 场景：`wait('ses-xxx', { timeout: 5000 })` 5 秒未空闲 → 抛超时错误）。
- 若会话已空闲：立即 resolve。
- 实现途径：SessionState 暴露状态变更订阅（事件通道派生或独立状态 emitter）；`wait()` 监听该状态，用 `Promise.race`/timer 实现 timeout。

### 5.6 close（spec「Session state management」/ plan.json 任务 2.2）

- 行为：关闭该会话 Query（`Query.close()`，终止底层 CLI 进程）并从 `Map<sessionId, SessionState>` 移除。
- spec 场景「会话关闭清理资源」：Query 句柄关闭、事件通道结束、SessionState 从 Map 移除。
- api.yaml 未单列 close 端点（客户端级方法，非 opencode v2 端点）。

---

## 六、@anthropic-ai/claude-agent-sdk 关键类型参考（v0.3.227）

来源：`scripts/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`。

### 6.1 query() 与 Query

```ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;

export declare interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;  // 需 interrupt_receipt_v1
  close(): void;                                                  // 终止底层进程
  setModel(model?: string): Promise<void>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  // ...（setPermissionMode / reinitialize / supportedAgents 等）
}
```

- **`prompt` 传 `AsyncIterable<SDKUserMessage>` 即流式输入模式**（docs `streaming-vs-single-mode.md`：流式输入是默认且推荐，多轮持久会话）。

### 6.2 Options 关键字段（与本任务相关）

- `cwd?: string`（默认 `process.cwd()`）。
- `agent?: string`（主线程代理名；等价 `--agent` CLI 标志；需在 agents 或 settings 定义）。
- `model?: string`（如 `'claude-sonnet-5'`、`'claude-opus-4-8'`；默认 CLI 默认模型）。
- `includePartialMessages?: boolean`（开启 `stream_event` token 级事件）。
- `resume?: string` / `continue?: boolean` / `forkSession?: boolean`（会话恢复，create 新会话不用）。
- `maxTurns?: number`、`allowedTools?: string[]` 等（可选，本任务核心 query 未强制要求）。

### 6.3 会话相关 SDKMessage 判别

- **SDKSystemMessage**（init）：`{ type:'system', subtype:'init', uuid, session_id, cwd, model, tools[], mcp_servers[], permissionMode, slash_commands[], skills[], plugins[], capabilities?, ... }` —— **`session_id` 在此捕获**。
- **SDKResultMessage = SDKResultSuccess | SDKResultError**：
  - success：`{ type:'result', subtype:'success', uuid, session_id, duration_ms, total_cost_usd, usage, modelUsage, permission_denials, result, stop_reason, terminal_reason?, ... }`；
  - error：`subtype: 'error_max_turns'|'error_during_execution'|'error_max_budget_usd'|'error_max_structured_output_retries'`、`errors: string[]`。
- **SDKSessionStateChangedMessage**：`{ type:'system', subtype:'session_state_changed', state: 'idle'|'running'|'requires_action', uuid, session_id }` —— **wait/interrupt 的会话状态依据**。
- **SDKPartialAssistantMessage**（stream_event，需 includePartialMessages）：`{ type:'stream_event', event: BetaRawMessageStreamEvent, parent_tool_use_id: null, uuid, session_id, ttft_ms? }`。
- **SDKAssistantMessage**：`{ type:'assistant', uuid, session_id, message: BetaMessage, parent_tool_use_id, error? }`。
- **SDKMessage**（query 产出联合）包含以上及大量可观测性消息（hook/task/status 等，event-01 需静默跳过无对应类型）。

### 6.4 getSessionMessages 与历史消息

```ts
export declare function getSessionMessages(
  _sessionId: string,
  _options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>;
// GetSessionMessagesOptions: { dir?, limit?, offset?, includeSystemMessages?, sessionStore? }

export declare type SessionMessage = {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  message: unknown;                 // 原始消息 payload（需提取 text/content）
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
};
```

- **分页为 limit/offset**（非 opencode 的 cursor 不透明游标，见 5.2 映射差异）。
- docs `sessions.md`：`getSessionMessages()` 返回历史 user/assistant 消息（默认不含 system，除非 `includeSystemMessages: true`）。

### 6.5 interrupt 收据

```ts
export type SDKControlInterruptResponse = { still_queued: string[] };
```
需 `SDKSystemMessage.capabilities` 含 `interrupt_receipt_v1`（docs typescript-sdk-api.md：v2.1.205+）；旧 CLI resolve `undefined`。

---

## 七、关键差异与实现注意事项

1. **分页语义差异**：Claude SDK `getSessionMessages` 用 `limit`/`offset`；opencode `SessionMessagesResponse.cursor` 用不透明 `previous`/`next`。messages 方法必须做游标↔offset 映射（api.yaml 端点入参是 `limit`+`cursor`+`order`）。
2. **消息结构差异**：Claude 历史 `SessionMessage.message` 为 `unknown` 原始负载；opencode `SessionMessage`（types.ts）要求 `id(^msg_)`/`type`/`text?`/`content?`/`time?`。messages 需归一化映射（uuid→id 加 `msg_` 前缀、提取 text/content）。此映射属 messages，不属 event-01。
3. **SessionV2Info 字段取值**：api.yaml 必填 `id/projectID/cost/tokens/time/title/location`。`id` 保留 Claude 原始 session_id（D7，不做 `^ses`）；`location.directory` 用客户端 cwd；`projectID` 由 cwd 编码生成（算法未定）；`cost`/`tokens`/`time`/`title` 在 init 时可用的数据有限（init 消息无 cost/tokens），实现时需决策初始值（如空对象/当前时间/空字符串）。
4. **model 映射**：api.yaml body.model 为 `ModelRef{id, providerID}`；`Options.model` 为 `string`。create 透传时应取 `ModelRef.id`。
5. **输入队列的唤醒语义**：conversation.ts 的 `wake` 为单占位；SessionState 封装为类时须保持「入队即唤醒、yield 即出队」且一次只一个等待者的正确性（并发 prompt 场景）。
6. **wait 事件驱动**：不要轮询；用 `SDKSessionStateChangedMessage.state==='idle'` 或 `SDKResultMessage`（回合结束）驱动；已空闲立即 resolve；`timeout` 用 timer 竞争，超时抛 `TimeoutError`（带 `timeoutMs`）。
7. **interrupt 前置条件**：`interrupt_receipt_v1` 能力缺失时按 design.md 降级为 `close()`；空闲会话 no-op（用 SessionState 状态判断）。
8. **事件通道为回放型广播**：SessionState 的 SDKMessage 通道须缓冲自会话创建起的消息（event-01 的 `session.events()` 晚订阅仍收到 session.created）；会话结束后流正常终止。本任务仅负责「缓冲/广播原始 SDKMessage」，不归一化。
9. **close 清理顺序**：先 `Query.close()` 终止底层进程，再结束事件通道，最后从 Map 移除（spec「会话关闭清理资源」场景）。
10. **错误类型复用**：`SessionNotFoundError`（`{_tag, sessionID, message}`）、`TimeoutError`（`{_tag, message, timeoutMs?}`）已在 types.ts 定义，直接构造抛错。
