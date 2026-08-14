# Exploration Result — session-01（结构化 parts / 会话运行时管理 / 交互控制）

## Exploration Result

`furina config show project.sourcecode codebases` 返回 `codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`。经核验，`D:/project-code/llm/sandore/docs/codebase` 目录为空（`total 0`），无文件可供 furina-codebase 探索，Phase 3 无有效产出，转入 Phase 4 手动补充探索（探索对象：`packages/sdk/claude` 源码、`furina/changes/sdk-engine-interfaces` 的 specs/design.md/plan.json、`docs/sdk/openapi.json`、底层 `@anthropic-ai/claude-agent-sdk` sdk.d.ts）。

## Supplementary Exploration Result

以下所有结论均基于实际代码。底层 SDK 为 `@anthropic-ai/claude-agent-sdk` **v0.3.226**（`node_modules/.pnpm/@anthropic-ai+claude-agent-_3d6e0582a1149899b85c7d67a91390db/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）。

---

### (1) before 游标可行性——底层 GetSessionMessagesOptions 无 before 字段（关键发现）

**底层 SDK `GetSessionMessagesOptions`（sdk.d.ts L764-783）完整定义：**
```ts
export declare type GetSessionMessagesOptions = {
    dir?: string;                    // Project directory to find the session in
    limit?: number;                  // Maximum number of messages to return
    offset?: number;                 // Number of messages to skip from the start
    includeSystemMessages?: boolean; // Defaults to false
    sessionStore?: SessionStore;     // @alpha
};
```
- **没有 `before` 字段**。全文件 grep `before` 确认：`getSessionMessages` 相关的 options 中不存在按消息 ID 定位的参数。
- **消息分页方式为 offset + limit**（`offset` = "Number of messages to skip from the start"），**没有按消息 ID 定位机制**。
- 返回的消息 `SessionMessage`（L4916-4929）结构为 `{ type: 'user'|'assistant'|'system', uuid, session_id, message: unknown, parent_tool_use_id, parent_agent_id }`——消息标识字段是 `uuid`。
- **目标协议 openapi.json 的 session.messages GET 端点有 `before` query 参数**（`docs/sdk/openapi.json` L6425-6431：`name: "before", schema: { type: "string" }`），且 `session-management/spec.md` L99 明确要求"提供 before 时 MUST 透传给底层 getSessionMessages 的 before 参数"。
- **design.md D9 的假设不成立**：D9 写"底层 getSessionMessages 的 GetSessionMessagesOptions 支持 before 游标（核验 sdk.d.ts）"，但实际核验 v0.3.226 的 sdk.d.ts **没有 before**。因此 `before` 无法直接透传，实现需自模拟（如本地按 messageID 过滤：opencode `msg_` 前缀 ↔ 底层 `uuid` 的映射，适配层 `mapStoredMessage` 已做 `msg_${stored.uuid}` 转换）。
- **适配层现有 `messages()`（session.ts L254-285）**：`getSessionMessagesFn(resolvedId, { dir: state.directory, limit: limit+1, offset, includeSystemMessages: true })`，`limit+1` 用于探测 hasNext；游标为 `offset:<n>` 编码（`CURSOR_PREFIX` L176，`decodeCursor` L416-420 / `encodeCursor` L423-425）；`order` asc/desc 在本地 reverse（L273-275）。适配层 `SessionMessagesOptions`（L97-104）当前为 `{ limit?, cursor?, order? }`，**无 before**。

---

### (2) structured parts 发送

**`makeUserMessage`（session.ts L434-441）当前实现：**
```ts
function makeUserMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}
```
- `content` 为单字符串。调用点仅两处：`create()` 的 `firstMessage`（L236）与 `prompt()`（L292，`input.prompt.text`）。

**`SDKUserMessage` 是否支持 content 内容块数组：支持。**
- `SDKUserMessage`（sdk.d.ts L4772-4816）：`{ type:'user', message: MessageParam, parent_tool_use_id, isSynthetic?, tool_use_result?, priority?, origin?, shouldQuery?, timestamp?, uuid?, session_id?, subagent_type?, task_description? }`。
- `MessageParam`（`@anthropic-ai/sdk` v0.116.0 `resources/messages/messages.d.ts` L808-811）：
  ```ts
  export interface MessageParam {
      content: string | Array<ContentBlockParam>;
      role: 'user' | 'assistant' | 'system';
  }
  ```
  `content` 支持内容块数组，user 角色可用的内容块含 `TextBlockParam`（`{ type:'text', text }`）、`ImageBlockParam`、`ToolResultBlockParam`、`DocumentBlockParam`、`WebFetchBlockParam` 等。适配层注释（session.ts L472）也确认"MessageParam.content 为字符串或内容块数组"。

**`PromptInput` 当前类型形状（types.ts L159-164）：**
```ts
export interface PromptInput {
  text: string;                    // 必填 string
  files?: PromptInputFileAttachment[];
  agents?: PromptAgentAttachment[];
}
```
- `text` 为**必填**；spec 要求扩展为 `text?: string`（可选）+ `parts?: Array<{ type:'text'; text:string }>`。

**openapi.json prompt parts 协议定义：**
- `session.prompt` POST body（openapi.json L6636-6654）：`parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>`，且 parts **required**（L6656-6658）。
- `TextPartInput`（L25634-25682）：`{ id?(^prt), type:'text', text, synthetic?, ignored?, time?, metadata? }`，required 仅 `type`+`text`。
- `FilePartInput`（L25683）：`{ type:'file', mime, url, filename?, source? }`；`AgentPartInput`（L25716）：`{ type:'agent', name, source? }`；`SubtaskPartInput`（L25761）：`{ type:'subtask', prompt, description?, agent?, model? }`。
- **注意**：openapi 的 `PromptInput` schema（L26237-26260）本身只有 `text/files/agents`（text required），**无 parts**；parts 是 prompt 请求体的独立可选结构。spec `structured-prompt-parts` 将 parts 收窄为仅 text 块（`{ type:'text'; text:string }`），且与 text 互斥、parts 优先、空数组传 `[]`。

---

### (3) per-prompt permissionMode

**`QueryLike.setPermissionMode` 真实 SDK 签名：**
- `Query` 接口（sdk.d.ts L2377）：`setPermissionMode(mode: PermissionMode): Promise<void>`；文档标注"Only available in streaming input mode"。
- `PermissionMode`（sdk.d.ts L2169）：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`。
- `QueryLike`（session-state.ts L119-135）已含可选成员 `setPermissionMode?(mode: PermissionMode): Promise<void>`（L134，design.md D13 已建骨架）。`SessionState` 中**尚无任何调用点**。

**SessionState 当前如何持有/记录 permissionMode：**
- 仅 create 时经 `SessionQueryOptions.permissionMode`（session-state.ts L54-55）透传给 `query()` options（构造器 L342）。`SessionState` **没有运行时 permissionMode 字段 / getter**，无法直接判断"当前会话权限模式"以决定 per-prompt 是否需要切换。D3 的"若提供且与当前模式不同才 setPermissionMode"语义需要新增跟踪字段（或每次无条件调用）。

---

### (4) rejectQuestion

**`respondQuestion` 如何 resolve 挂起问题 Promise（session-state.ts L437-455）：**
```ts
respondQuestion(input: RespondQuestionInput): void {
  const pending = this.pendingQuestions.get(input.requestID);
  if (pending === undefined) throw new SessionNotFoundError(input.requestID, `question request not found: ${input.requestID}`);
  this.pendingQuestions.delete(input.requestID);
  pending.resolve({ behavior: 'allow', updatedInput: { questions: pending.questions, answers: input.answers } });
  this.controlChannel.write(makeControlEvent('question.replied', { sessionID, requestID, answers }, this.directory));
}
```
- 挂起入口 `bridgeQuestion`（L694-714）：构造 `requestID = que_<uuid>`，`controlChannel.write(question.asked)` + `onQuestionRequest?.(request)`，然后 `new Promise((resolve, reject) => pendingQuestions.set(requestID, { questions, resolve, reject }))`。
- **deny 分支应返回的 PermissionResult 形状**：与 `respondPermission` 的 reject 分支对称（L404-405 `pending.resolve({ behavior: 'deny', message: 'rejected by user' })`）。`PermissionResult` deny 变体（sdk.d.ts L2197-2203）：`{ behavior:'deny'; message: string; interrupt?; toolUseID?; decisionClassification? }`。spec 明确要求 resolve 为 `{ behavior: 'deny', message: 'rejected by user' }`。
- **question.rejected 控制事件产出**：经 `makeControlEvent(type, properties, directory)`（L730-745）产出 `{ directory, payload: { id: evt_<uuid>, type, properties } }`（properties 含 sessionID 与 requestID）。控制事件写入 `controlChannel`（ReplayChannel<GlobalEvent>），`controlEvents` getter（L390-392）与 `SessionManager.controlEvents`（session.ts L324-327）可达；经 `GlobalEventManager.sessionEvents`（events.ts L74-83）的 `mergeAsyncIterables` 与归一化流合并，故 global 事件流亦可达。
- **`GlobalEventType` 联合（types.ts L80-90）当前无 `question.rejected`**——仅有 `question.asked` / `question.replied`，需新增。

---

### (5) listPending*——SessionState 挂起 Map 结构与快照

**`pendingPermissions`（session-state.ts L299-302）：**
```ts
private readonly pendingPermissions = new Map<string, { resolve: (result: PermissionResult) => void; reject: (reason: unknown) => void }>();
```
- 值**仅含 resolve/reject 函数，不存 PermissionRequestInfo 载荷**（permission/patterns/metadata/tool 在 `bridgePermission` L671-683 构造的 `request` 局部变量中，未入 Map）。**listPendingPermissions 要返回"requestID + permission/patterns/metadata/tool 载荷"，需在 bridgePermission 时将载荷一并存入 Map 值，或另行缓存。**

**`pendingQuestions`（L304-311）：**
```ts
private readonly pendingQuestions = new Map<string, { questions: QuestionInfo[]; resolve: (result: PermissionResult) => void; reject: (reason: unknown) => void }>();
```
- 值含 `questions: QuestionInfo[]` + resolve/reject。**listPendingQuestions 可直接取 key（requestID）+ value.questions 构造快照。**

**值快照（剥离函数）**：spec 要求"深拷贝 requestID + 载荷，不含 resolve/reject 函数"；两个 Map 均为私有，现无 getter。`rejectPending()`（L717-726）在 close/泵结束时 reject 全部挂起并 clear。

**载荷类型形状（session-state.ts）：**
- `PermissionRequestInfo`（L68-84）：`{ id, sessionID, permission, patterns: string[], metadata: Record<string,unknown>, always: string[], tool?: { messageID, callID } }`。
- `QuestionRequestInfo`（L86-96）：`{ id, sessionID, questions: QuestionInfo[], tool?: { messageID, callID } }`。
- `QuestionInfo`（types.ts L64-71）：`{ question, header, options: QuestionOption[], multiple?, custom? }`。

---

### (6) session.delete

**注入点 `deleteSessionFn` 已存在但未使用（session.ts L134-138、L187、L197）：**
```ts
export type DeleteSessionFn = (sessionId: string, options?: SessionMutationOptions) => Promise<void>;
// 构造器：this.deleteSessionFn = options.deleteSessionFn ?? deleteSession;
```
- 现有测试已断言注入接线（session.test.ts L792-830：未注入默认 `deleteSession`；注入 mock 后被使用）。

**现有 `close(sessionId)`（session.ts L342-346）：**
```ts
close(sessionId: string): void {
  const state = this.getState(sessionId);   // 不存在抛 SessionNotFoundError
  state.close();
  this.sessions.delete(sessionId);
}
```
**`closeAll()`（L349-354）**：遍历 `this.sessions.values()` 逐个 `state.close()`，再 `clear()`。
**`resolveSessionId`（L357-360）**：`return this.sessions.get(sessionId)?.sessionId ?? sessionId;`（占位别名→真实 id）。

**`SessionState.close()`（session-state.ts L535-547）**：设 closed、`stateValue='ended'`、`query.close()`、wake、idle、notifyIdle、`channel.close()`、`controlChannel.close()`、`rejectPending()`、`onClose?.()`。`onClose`（create 注入，session.ts L224-230）会按 placeholderId 与真实 id 从 Map 删除。

**plan.json 2.5 的 delete 顺序**：`getState` 校验 → `state.close()` 清理（触发 onClose 从 Map 移除）→ 用 `resolveSessionId` 得真实 id → `this.deleteSessionFn(resolvedId, { dir: state.directory })`。**注意：`state.close()` 触发 onClose 已删 Map，须在 close 前捕获 `state` 引用（含 `state.directory` 与 `state.sessionId`）；`state.directory` 是 public readonly（session-state.ts L357）。** 底层 `deleteSession` 签名（sdk.d.ts L530）：`deleteSession(sessionId, options?: SessionMutationOptions): Promise<void>`；`SessionMutationOptions`（L4935）：`{ dir?, sessionStore? }`（renameSession/tagSession/deleteSession/forkSession 共享）。

---

### (7) create title 透传

- **`buildInfo`（session.ts L380-398）** 构造 SessionV2Info，L395 硬编码 `title: ''`。`SessionV2Info.title` 为必填 string（types.ts L139）。
- **`CreateSessionOptions`（session.ts L66-94）当前无 `title` 字段**；计划改为 `buildInfo` 用 `options.title ?? ''`（D12）。
- 底层可持久化 title 的接口：`renameSession(sessionId, title, options?)`（sdk.d.ts L2675），D12 标注"可选地持久化 title（非必须）"。
- 另注意 `events.ts` 的 `buildSessionInfo`（L449-462）也产出 `title: ''`（session.created 事件的 info），当前 spec/plan 未要求改此路径。

---

### (8) 现有测试

**`test/session.test.ts`：**
- `FakeQuery`（L108-189）实现 `QueryLike`：字段 `inputIterator`（prompt 生成器迭代器）、`queue`、`waiters`、`ended`；方法 `interrupt`/`close` 为 vi.fn，`pushMessage/end/fail/readInput/next/return/throw/[Symbol.asyncIterator]`。**未实现 `setPermissionMode`**（QueryLike 中可选，故类型通过；若要测试 setPermissionMode 行为需扩展 FakeQuery 加 `setPermissionMode` vi.fn）。
- `createHarness`（L202-230）：`queryFn` 捕获 `lastQueryOptions` 并每会话建 FakeQuery；`SessionManager` cwd `/tmp/project`。
- `createSession` 助手（L233-240）：`manager.create({ firstMessage:'hello' })` + `fake.pushMessage(initMessage('ses-1'))`。
- `respondPermission` 测试（L854-909）：触发 canUseTool → 等 `permission.asked` 事件 → 从 `props.id` 取 requestID（断言 `per_` 前缀）→ `respondPermission` → 断言 `result.behavior` 与 `permission.replied` 事件。
- `respondQuestion` 测试（L911-946）：`question.asked` → `respondQuestion` → 断言 `updatedInput.answers` 与 `question.replied` 事件。
- 其它：`close` 时挂起被 reject（L948-956）、`sessionEvents` 合并控制事件（L958-981）、DI 注入断言（L792-830）。
- `toolContext()`（L837-839）：`{ signal, toolUseID, requestId }`。

**`test/client.test.ts`：**
- `FakeQuery`（L63-130）在 QueryLike 基础上加 `supportedModels` vi.fn。`createHarness`（L144-170）注入 `queryFn` 建 `createClaudeClient({ cwd, queryFn })`。`createClientSession`（L173-177）。

**`test/types.test.ts`（GlobalEventType 断言位置）：**
- `GlobalEventType` 精确字面量联合断言在 **L314-325**（`expectTypeOf<GlobalEventType>().toEqualTypeOf<...10 个类型...>()`）——新增 `question.rejected` 需同步此断言。
- `QueryLike` 扩展断言 **L382-420**（setPermissionMode 签名 L388-389、MinimalQuery/FullQuery 结构）。
- `ClaudeSessionNamespace` 属性断言 **L444-448**（create/prompt/messages/respondPermission/respondQuestion）。
- `PromptInput` 断言 **L135-145**：`text` 必填 string、files/agents 附件数组；`SessionInputAdmitted` 断言 **L148+**。

**`test/events.test.ts`**：permission 事件合并测试在 L746-781；question 相关暂无断言。

---

### (9) specs 与 design.md 的具体要求

**`specs/structured-prompt-parts/spec.md`：**
- `client.session.prompt` 的 `input.prompt` 支持可选 `parts?: Array<{type:'text';text:string}>`；提供 parts 时构造 `SDKUserMessage.message.content` 为内容块数组；未提供 parts（仅 text）保持 content 为字符串；parts 与 text 互斥，同时提供 parts 优先；空数组传 `[]`。
- `PromptInput` 扩展为 `{ text?: string; files?; agents?; parts? }`，parts 元素 type 限 `'text'`、text 非空，顺序对应 content block 数组元素。

**`specs/session-management/spec.md`：**
- delete：`client.session.delete(sessionId)` 先关闭本地 SessionState（Query 关闭、事件通道结束、从 Map 移除）再调 `deleteSession(resolvedId, { dir })`；不存在会话抛 SessionNotFoundError。
- setPermissionMode：`client.session.setPermissionMode(sessionId, mode)` 透传 `Query.setPermissionMode(mode)`（仅 streaming input mode）；mode 为 `'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`。
- per-message permissionMode：`prompt` 的 input 支持可选 `permissionMode`，提供且与当前模式不同时 push 前调 `setPermissionMode`；未提供不变。
- create：options 支持 `title?: string`，返回的 SessionV2Info.title 用该值（非空字符串）；其余 create 行为（firstMessage 双路径、initTimeoutMs）不变。
- messages：options 支持 `before?: string`（消息 ID 游标），透传底层 before，与 offset cursor 互斥、before 优先（**底层 SDK 无 before，需注意第 (1) 点**）。
- prompt：输入含 prompt（PromptInput 支持 text/parts 两种形式）。

**`specs/interactive-control/spec.md`：**
- rejectQuestion：`client.session.rejectQuestion(sessionId, input)`，input 含 `requestID`（question.asked 的 properties.id，`^que_` 前缀）；resolve 挂起 Promise 为 `{ behavior:'deny', message:'rejected by user' }`；产出 `question.rejected` 控制事件（properties 含 sessionID 与 requestID）；不存在请求抛 SessionNotFoundError。
- question.rejected：加入 `GlobalEventType` 联合；经会话级控制事件通道与全局事件流可达。
- listPendingPermissions / listPendingQuestions：返回挂起请求快照数组（元素含 `^per_`/`^que_` 前缀 requestID 与载荷），快照不影响内部状态；无挂起返回空数组。

**`design.md` 决策：**
- **D2（parts）**：扩展 `PromptInput` 加 `parts`；`prompt()` parts 优先，无 parts 回退单文本；`makeUserMessage` 扩展为接受 `string | Array<{type:'text',text:string}>`，parts 时构造 `content: [{type:'text',text},...]`。否决"引擎自行拼单字符串"。
- **D3（per-prompt permissionMode）**：`prompt()` 入参加 `permissionMode`；不同时先 `setPermissionMode` 再 push；`session.setPermissionMode` 作为独立方法暴露（支撑引擎 V2.3 updateInstancePermissionMode）。
- **D4（rejectQuestion）**：`SessionState` 新增 `rejectQuestion(requestID)`，resolve `{ behavior:'deny', message:'rejected by user' }`（与 respondPermission 的 reject 对称），产出 `question.rejected` 控制事件（sessionID/requestID）；加入 `GlobalEventType`。
- **D5（listPending*）**：`SessionState` 暴露 `listPendingPermissions()`/`listPendingQuestions()`，返回挂起 Map 值快照（深拷贝 requestID+载荷，不含 resolve/reject）；SessionManager 与 client.session 透传。
- **D6（session.delete）**：`SessionManager` 注入 `deleteSessionFn`（默认 SDK `deleteSession`）；`session.delete` 先 close 本地再 `deleteSessionFn(resolvedId, { dir })`；区分 close（仅内存清理）。
- **D9（before 分页）**：`SessionMessagesOptions` 加 `before?: string`；底层 getSessionMessages 支持 before 则透传、与 offset 互斥 before 优先（**实际底层无 before，见第 (1) 点**）。
- **D12（create title）**：`CreateSessionOptions` 加 `title?: string`；`buildInfo` 用 `options.title ?? ''`；`renameSession` 可选持久化 title。
- **D13（依赖注入）**：`SessionManagerOptions` 加 `forkSessionFn?/deleteSessionFn?/listSubagentsFn?/getSubagentMessagesFn?`（已完成，见第 (6) 点）；`QueryLike` 扩展 `rewindFiles`/`setPermissionMode`（已完成骨架）。

**`plan.json`（feature 2「session-01 行为实现」）关键任务**（L48-73）：
- 2.1 types.ts：`PromptInput` 加 `parts?`；`GlobalEventType` 加 `'question.rejected'`；session.ts `SessionMessagesOptions` 加 `before?`、`SessionPromptInput` 加 `permissionMode?`、`CreateSessionOptions` 加 `title?`。
- 2.3 prompt() permissionMode：不同时先 `await Query.setPermissionMode(mode)` 再 push。
- 2.4 SessionState 加 `setPermissionMode(mode)`（透传 `this.query.setPermissionMode`）；SessionManager 与 client.session 透传。
- 2.5 SessionManager.delete：getState 校验 → state.close() → resolveSessionId → deleteSessionFn(resolvedId, { dir: state.directory })。
- 2.6 create() buildInfo 用 `options.title ?? ''`；messages() before 透传（before 优先，忽略 offset cursor）。
- 2.7 session-state.ts 加 `rejectQuestion(input)`。
- 2.8 session-state.ts 加 `listPendingPermissions()/listPendingQuestions()`（剥离 resolve/reject 深拷贝）。
- 2.9 session.ts SessionManager 与 client.ts ClaudeSessionNamespace 透传。
- 2.10 测试：parts 三场景、prompt permissionMode、setPermissionMode、delete、title、before、rejectQuestion、listPending*。

---

### 关键结论汇总（实现前必须注意）

1. **before 无法直接透传**：底层 `GetSessionMessagesOptions`（v0.3.226）无 `before`，design.md D9 的前提不成立；需本地模拟（按 messageID/uuid 过滤）或另议。
2. **SDKUserMessage.content 支持内容块数组**：`MessageParam.content: string | Array<ContentBlockParam>`（user 角色 text 块可用），parts 发送类型上完全可行。
3. **SessionState 无运行时 permissionMode 记录**：D3"当前模式不同才切换"需新增跟踪字段。
4. **pendingPermissions Map 值不含载荷**：listPendingPermissions 需把 `bridgePermission` 构造的 `request` 载荷一并存入 Map 值。
5. **delete 顺序注意 onClose 竞态**：`state.close()` 会经 onClose 删 Map，须先捕获 state（含 directory）再调 deleteSessionFn。
6. **测试扩展点**：FakeQuery 需加 `setPermissionMode` vi.fn；types.test.ts L314-325 的 GlobalEventType 字面量联合断言需加 `question.rejected`。
