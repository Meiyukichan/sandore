# Furina Explore — 探索报告（specification）

## Explore Content

为 `@meiyukichan/claude-sdk`（packages/sdk/claude）实现结构化 parts 发送、会话运行时管理（setPermissionMode/delete/create title/messages before）与交互控制（rejectQuestion/listPending*）。本次探索围绕 plan.json `session-01` 任务的 9 个探索点，核验底层 SDK 类型与适配层现有实现，为 TDD 实现提供准确依据。

## Explore Type

specification

## 需求理解（Phase 2）

- **What**：在 `@meiyukichan/claude-sdk` 适配层落地 structured-prompt-parts、session-management、interactive-control 三个能力的**行为实现**（plan.json session-01，in_progress）：结构化 parts 发送、per-prompt/session 级 permissionMode、session.delete、create title 透传、messages before 游标、rejectQuestion、listPending*。
- **Boundaries**：范围限定于 `packages/sdk/claude/src/`（types.ts/session.ts/session-state.ts/client.ts/events.ts/index.ts）与 `test/`（session.test.ts/client.test.ts/types.test.ts），以及底层 `@anthropic-ai/claude-agent-sdk` sdk.d.ts 的相关类型核验；规范材料为 `furina/changes/sdk-engine-interfaces/specs/` 与 design.md。
- **Goal**：确认每个新接口的底层可行性、类型形状、注入点与现有实现差异，识别实现障碍（如 SDK 无 before 支持、pending Map 未存载荷），供实现阶段精确落地。

## 探索结果（Phase 3）

### 探索点 (1)：before 游标可行性

**核心结论：底层 SDK `getSessionMessages` 的 options 没有 `before` 字段。** `before` 只能由适配层自行实现（按消息 ID 定位后切片）。

- 底层类型（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` L764-783）：
  ```ts
  export declare type GetSessionMessagesOptions = {
      dir?: string;
      limit?: number;
      offset?: number;          // 从起始跳过 N 条
      includeSystemMessages?: boolean;
      sessionStore?: SessionStore;  // @alpha
  };
  ```
  `getSessionMessages(_sessionId, _options?)` 返回 `Promise<SessionMessage[]>`（L759），`SessionMessage` 含 `uuid: string`（消息 ID，L4918）。全文件 grep `before` 无任何 options 字段名命中（仅注释中的语义用法），确认 SDK 无按消息 ID 定位机制；分页只有 offset/limit。
- **适配层现状**（`packages/sdk/claude/src/session.ts` L97-104、L254-285）：
  - `SessionMessagesOptions = { limit?, cursor?, order? }`，cursor 为不透明游标，适配层编码为 `offset:<n>`（`CURSOR_PREFIX = 'offset:'`，L176；`decodeCursor`/`encodeCursor` L416-425）。
  - `messages()` 调 `getSessionMessagesFn(resolvedId, { dir, limit: limit+1, offset, includeSystemMessages: true })`；`hasNext = limit!==undefined && stored.length>limit`；`cursor.next = offset+limit`。
  - `GetSessionMessagesFn` 类型（L123-127）签名为 `(sessionId, options?: GetSessionMessagesOptions) => Promise<SDKStoredMessage[]>`——**类型上没有 before**。
- **对实现的影响**（任务 2.6）：`before` 需在适配层解析。适配层 `mapStoredMessage` 将 `stored.uuid` 映射为 `msg_${uuid}`（L459）；`before` 入参为 `msg_` 前缀 MessageID，实现时需剥前缀取 uuid → 获取全量/分段消息定位该 uuid 的下标 → 截取之前 limit 条。`GetSessionMessagesFn` 或注入 options 类型需扩展（因底层类型不含 before，直接透传会类型不通过）。openapi.json 的 `session.messages` 端点（`/session/{sessionID}/message` GET）确有 `before` 查询参数（docs/sdk/openapi.json L6425，type string，无 pattern），即协议层需要 before，但底层 SDK 不支持，属适配层职责。

### 探索点 (2)：structured parts 发送

- **makeUserMessage 现状**（`session.ts` L435-441）：只接受 `text: string`：
  ```ts
  function makeUserMessage(text: string): SDKUserMessage {
    return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
  }
  ```
  调用点：`create()` 的 firstMessage（L236 `state.push(makeUserMessage(firstMessage))`）与 `prompt()`（L292 `state.push(makeUserMessage(input.prompt.text))`）。
- **SDKUserMessage 的 content 是否支持内容块数组**：`SDKUserMessage.message: MessageParam`（sdk.d.ts L4772-4774），`MessageParam` 为 `@anthropic-ai/sdk` 类型（type-only import，未物理安装，运行时由 sdk.mjs 打包）。Anthropic Messages API 的 `MessageParam.content` 为 `string | Array<ContentBlockParam>`，text 块形状 `{ type: 'text'; text: string; ... }`。**现有代码已隐含支持**：`extractText`（session.ts L473-490）与 `extractAssistantContent`（L493-520）均处理 `content` 为字符串或内容块数组；`extractText` 对 text 块数组 `join('\n')`。故 parts 时构造 `message.content = [{ type:'text', text }, ...]` 类型可行。
- **PromptInput 现状**（`types.ts` L160-164）：`{ text: string; files?: PromptInputFileAttachment[]; agents?: PromptAgentAttachment[] }`——**无 parts 字段**。spec（structured-prompt-parts/spec.md）要求扩展为 `{ text?: string; files?: ...; agents?: ...; parts?: Array<{ type:'text'; text:string }> }`。
- **openapi.json prompt parts 协议**：openapi 的 `Prompt` schema（docs/sdk/openapi.json L18323-18346）仅有 text/files/agents，**无 parts**——parts 是适配层/本 spec 的扩展（spec.md「Requirement: PromptInput parts type extension」定义 parts 元素 type 限 'text'、text 非空、顺序对应 content block 数组）。`SessionInputAdmitted.prompt` 引用 `Prompt` schema（L31022）。
- **互斥语义**（spec）：parts 与 text 同时提供时 parts 优先；未提供 parts 保持 content 为字符串；空 parts 数组时 content 为空数组。

### 探索点 (3)：per-prompt permissionMode

- **QueryLike.setPermissionMode 真实签名**：`session-state.ts` L134 `setPermissionMode?(mode: PermissionMode): Promise<void>`（可选成员，结构子集）；底层 `Query` 接口 `setPermissionMode(mode: PermissionMode): Promise<void>`（sdk.d.ts L2377，注明「Only available in streaming input mode」——当前适配层正是流式输入模式）。`PermissionMode` 联合（sdk.d.ts L2169）：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`。
- **SessionState 当前如何持有 permissionMode**：仅构造时透传 `permissionMode: options.permissionMode` 到 query options（session-state.ts L342）。`SessionStateOptions.permissionMode?: PermissionMode`（L192）。`CreateSessionOptions.permissionMode?: PermissionMode`（session.ts L85）→ SessionStateOptions.permissionMode。**没有当前模式字段/记录器**——`SessionState` 无 `currentPermissionMode` 之类的状态字段，也无 getter。因此「提供且与当前会话模式不同时再切换」（spec「Prompt with per-message permission mode」）需要新增模式跟踪字段（构造默认值 = options.permissionMode，setPermissionMode 后更新）。
- **当前 `prompt()` 不处理 permissionMode**：`SessionPromptInput = { prompt; delivery?; resume? }`（session.ts L107-114）**无 permissionMode 字段**；`prompt()`（L290-303）直接 push，未调 setPermissionMode。任务 2.3 需在 `state.push` 前 `await Query.setPermissionMode(mode)`（提供且与当前不同时）。

### 探索点 (4)：rejectQuestion

- **respondQuestion 现状**（`session-state.ts` L437-455）：查 `pendingQuestions.get(requestID)`，未命中抛 `SessionNotFoundError(requestID, 'question request not found: ...')`；命中则 `delete` 后 `pending.resolve({ behavior:'allow', updatedInput:{ questions: pending.questions, answers: input.answers } })`，并 `controlChannel.write(makeControlEvent('question.replied', { sessionID, requestID, answers }, this.directory))`。
- **deny 分支 PermissionResult 形状**：底层 `PermissionResult`（sdk.d.ts L2191-2203）为判别联合：
  ```ts
  { behavior:'allow'; updatedInput?; updatedPermissions?; toolUseID?; decisionClassification? }
  | { behavior:'deny'; message: string; interrupt?; toolUseID?; decisionClassification? }
  ```
  `{ behavior:'deny', message:'rejected by user' }` 合法；与 `respondPermission` reject 分支完全对称（session-state.ts L404-405 `pending.resolve({ behavior:'deny', message:'rejected by user' })`）。spec（interactive-control）明确 rejectQuestion resolve 为 `{ behavior:'deny', message:'rejected by user' }`。
- **question.rejected 控制事件产出**：`makeControlEvent(type, properties, directory)`（L730-745）以 `GlobalEvent['payload']['type']` 为 type，`controlChannel` 回放型通道（L288，`session-state.ts`）。**`GlobalEventType` 联合当前无 'question.rejected'**（types.ts L80-90 仅到 'question.replied'）——需新增，加入后 makeControlEvent 即可产出。事件流可达性：`controlEvents(sessionId)` → `GlobalEventManager.sessionEvents` 经 `mergeAsyncIterables` 合并归一化流与控制流（events.ts L74-83），`feedGlobal` 投递到全局通道（L113-124）→ `session.events` 与 `global.event({directory})` 均可达。
- **rejectQuestion 入参形状**：spec 要求 input 含 `requestID`（`^que_` 前缀，对应 question.asked properties.id）。`RespondQuestionInput`（L107-112）目前为 `{ requestID; answers: QuestionAnswer }`；rejectQuestion 可复用 requestID 或定义独立 input（plan 任务 2.7 描述为 `rejectQuestion(input)`）。

### 探索点 (5)：listPending* 快照

- **pendingPermissions Map**（`session-state.ts` L299-302）：
  ```ts
  private readonly pendingPermissions = new Map<string, { resolve: (result: PermissionResult) => void; reject: (reason: unknown) => void }>();
  ```
  **值只存 resolve/reject，不含请求载荷**。请求载荷 `request: PermissionRequestInfo`（L671-683）仅在 `bridgePermission` 内构造后写入控制通道（permission.asked）并回调 `onPermissionRequest?.(request)`（L684-687），**未存进 Map**。因此 `listPendingPermissions()` 若要返回「requestID + permission/patterns/metadata/tool 载荷」，需：扩展 Map 值存载荷快照，或另维护注册表，或在生成快照时从控制通道/回调侧记录。这是实现障碍点。
- **pendingQuestions Map**（L304-311）：
  ```ts
  private readonly pendingQuestions = new Map<string, { questions: QuestionInfo[]; resolve: (result: PermissionResult) => void; reject: (reason: unknown) => void }>();
  ```
  **值含 `questions` 载荷**，`bridgeQuestion` 构造 `request: QuestionRequestInfo`（L700-706）并写 question.asked 事件 + 回调（L707-710），Map 值存 `{ questions, resolve, reject }`。故 `listPendingQuestions()` 可从 key（requestID）+ value.questions 重建快照，无需扩展。
- **载荷类型形状**（session-state.ts）：
  - `PermissionRequestInfo`（L69-84）：`{ id; sessionID; permission: string; patterns: string[]; metadata: Record<string,unknown>; always: string[]; tool?: { messageID; callID } }`——id 为 `per_` 前缀。
  - `QuestionRequestInfo`（L87-96）：`{ id; sessionID; questions: QuestionInfo[]; tool?: { messageID; callID } }`——id 为 `que_` 前缀。
  - `QuestionInfo`（types.ts L65-71）：`{ question; header; options: QuestionOption[]; multiple?; custom? }`。
- **快照语义**：spec 要求返回值为快照（不影响内部挂起状态），元素含 requestID 与载荷、**不含 resolve/reject 函数**（plan 任务 2.8「剥离 resolve/reject，深拷贝载荷」）。无挂起时返回空数组。`rejectPending()`（L717-726）在 close/泵结束时 reject 全部挂起并 clear。

### 探索点 (6)：session.delete

- **现有 close(sessionId)**（session.ts L342-346）：`getState(sessionId)`（不存在抛 SessionNotFoundError）→ `state.close()`（关闭 Query、结束通道、rejectPending、触发 onClose）→ `this.sessions.delete(sessionId)`。
- **现有 closeAll()**（L349-354）：遍历 `sessions.values()` 逐个 `state.close()` 后 `sessions.clear()`。
- **deleteSessionFn 注入点**：已存在（foundation-01 完成）——`DeleteSessionFn = (sessionId, options?: SessionMutationOptions) => Promise<void>`（session.ts L135-138），`SessionManagerOptions.deleteSessionFn`（L164），构造器默认 `deleteSession`（L197）。底层 `deleteSession(_sessionId, _options?: SessionMutationOptions)`（sdk.d.ts L530），`SessionMutationOptions = { dir?; sessionStore? }`（L4935-4947），无 dir 时搜索全部项目目录，删除 `{sessionId}.jsonl` 与 `{sessionId}/` 子目录，找不到抛错。
- **resolveSessionId 逻辑**（L357-360）：`this.sessions.get(sessionId)?.sessionId ?? sessionId`——占位别名（ses_<uuid>）在 created 后解析到真实 session_id；未创建/不存在返回原值。
- **delete 与 close 区别**（spec）：delete 额外清理服务端/磁盘会话数据；close 仅清客户端内存态。plan 任务 2.5：`getState 校验 → state.close() 清理 → 用 resolveSessionId 得真实 id → this.deleteSessionFn(resolvedId, { dir: state.directory })`。**注意顺序陷阱**：`state.close()` 触发 onClose 会从 Map 删除占位与真实 id，故 `resolveSessionId` 需在 close 之前调用（或先捕获 `state.sessionId`/`state.directory` 再 close），否则 close 后 `resolveSessionId(sessionId)` 返回原值、且 `state.directory` 仍可读（directory 为 readonly 字段，close 不清除）。

### 探索点 (7)：create title 透传

- **buildInfo 现状**（session.ts L381-398）：`title: ''` 硬编码。`CreateSessionOptions` **无 title 字段**。
- **openapi SessionV2Info**（types.ts L127-143）：`title: string` 必填。types.test.ts 已断言 `SessionV2Info['title'] === string`（L107），并有 title 非空的构造样例（L127 `title: 'hello world'`）——但那是值构造，与 buildInfo 产出无关。
- 实现（plan 任务 2.6）：`CreateSessionOptions` 增 `title?: string`（任务 2.1），buildInfo 改 `title: options.title ?? ''`（design.md D12）。另注意 events.ts `buildSessionInfo`（L449-462）产出的 session.created info 的 `title` 也恒为 `''`——D12 只要求 create() 返回的 SessionV2Info.title 透传，事件 info 未在任务范围明确（session.created 事件 info 是另一产出路径，任务未列）。

### 探索点 (8)：现有测试结构与断言位置

- **session.test.ts**：
  - `FakeQuery`（L108-189）：实现 QueryLike 的 `next/return/throw/[Symbol.asyncIterator]/interrupt/close`，另有 `pushMessage/end/fail/readInput`；`interrupt` 与 `close` 为 `vi.fn`。**无 `setPermissionMode`**——因 QueryLike.setPermissionMode 为可选，FakeQuery 仍满足类型；新增 setPermissionMode 测试时需在 FakeQuery 加 `vi.fn`（或经 cast）。
  - `createHarness`（L202-230）注入 `queryFn`（捕获 `lastQueryOptions`）与 `getMessages`；`createSession` 便捷函数（L233-240）。
  - prompt 形状断言位置：L514-537「push SDKUserMessage 并返回 SessionInputAdmitted」（`pushed.message.content === 'hello'`）；create firstMessage 断言 L308-323（`pushed?.message.content`）；占位→init 断言 L333-353。
  - messages 分页断言：L437-477（`getMessages` 收到 `{limit:11, offset:0/10, includeSystemMessages:true}`，cursor `offset:10`/`offset:0`）；`getMessages` 调用参数断言 L422-435。
  - canUseTool 桥接 describe（L841-982）：`respondPermission once`（L854-886）、`respondPermission reject`（L888-909）、`respondQuestion`（L911-946）、close reject 挂起（L948-956）、sessionEvents 合并控制事件（L958-981）——**rejectQuestion/listPending* 新测试的落点**。`toolContext()` 构造 canUseTool 第三参（L837-839）。
  - 注入点断言：L792-830（forkSessionFn/deleteSessionFn/listSubagentsFn/getSubagentMessagesFn 默认/注入）。
  - 类型锚定：L780-784 `SessionMessagesOptions` 构造断言（`{ limit, cursor, order }`）。
- **client.test.ts**：
  - `FakeQuery`（L63-130）：与 session.test 相同 + `supportedModels = vi.fn`；**无 setPermissionMode**。
  - `createHarness`（L144-170）注入 queryFn，`createClientSession` 便捷（L173-177）。
  - 命名空间暴露断言：L184-198（`typeof client.session.*` 列表——新增方法 delete/setPermissionMode/rejectQuestion/listPending* 需追加）；L218-228 close() 关闭会话+控制 Query。
- **types.test.ts**：
  - **GlobalEventType 断言位置**：L314-325 `expectTypeOf<GlobalEventType>().toEqualTypeOf<...10 项...>`——加入 'question.rejected' 必须同步更新此处（11 项）。
  - PromptInput 断言：L135-146（text 必填、files/agents 类型）——parts 扩展需在此补断言。
  - QueryLike 扩展断言：L382-419（rewindFiles/setPermissionMode 签名、MinimalQuery/FullQuery 赋给 QueryLike）。
  - 包入口断言：L422-465（`ClaudeSessionNamespace` 属性 `respondPermission/respondQuestion` 已断言，L447-448；新方法可追加）。
- **events.test.ts**：未在本次探索点直接涉及（git status 显示已修改），session-01 不涉及事件归一化新类型。

### 探索点 (9)：specs 与 design.md 具体要求

- **structured-prompt-parts/spec.md**：
  - `client.session.prompt` 的 `input.prompt` 支持可选 `parts?: Array<{type:'text';text:string}>`；提供时构造 `SDKUserMessage.message.content` 为内容块数组；未提供（仅 text）保持 content 为字符串；parts 与 text 互斥，同时提供 parts 优先；空数组传空数组。
  - `PromptInput` 扩展为 `{ text?; files?; agents?; parts? }`，parts 元素 type 限 'text'、text 非空，顺序对应 content block 数组。
- **session-management/spec.md**：
  - **Delete session**：`client.session.delete(sessionId)` 先关闭本地 SessionState（Query 关闭、事件通道结束、从 Map 移除）再调 `deleteSession(resolvedId, { dir })`；不存在会话抛 SessionNotFoundError。
  - **Set permission mode at runtime**：`client.session.setPermissionMode(sessionId, mode)` 调 Query.setPermissionMode(mode)（仅 streaming input mode）；mode 为 PermissionMode 联合（6 值）；不存在会话抛 SessionNotFoundError。
  - **Prompt with per-message permission mode**：prompt input 支持可选 `permissionMode`；提供且与当前模式不同时在 push 前调 Query.setPermissionMode；未提供不变。
  - **Create session**：options 支持 `title?: string`，提供时 SessionV2Info.title 用该值；支持 `firstMessage` 两种 init 路径（firstMessage 立即捕获真实 id / 缺省占位 pending）；init 受 initTimeoutMs 超时保护。
  - **Read session messages**：`messages(sessionId, options?)` 返回 SessionMessagesResponse；options 支持 `before?: string`（消息 ID 游标），透传底层 getSessionMessages 的 before 参数，before 与 offset cursor 互斥、before 优先。
  - **Send message (prompt)**：input 含 prompt（PromptInput 结构），支持 text 与 parts 两种形式；返回 SessionInputAdmitted；不存在会话抛 SessionNotFoundError。
- **interactive-control/spec.md**：
  - **Reject question**：`client.session.rejectQuestion(sessionId, input)`，input 含 `requestID`（question.asked properties.id，`^que_` 前缀）；拒绝时 resolve 挂起 Promise 为 `{ behavior:'deny', message:'rejected by user' }`；产出 `question.rejected` 控制事件（properties 含 sessionID 与 requestID）；不存在 requestID 抛 SessionNotFoundError 或等价错误。
  - **question.rejected event type**：GlobalEventType 联合含 'question.rejected'；经会话级控制通道与全局事件流可达。
  - **List pending permissions**：`listPendingPermissions(sessionId)` 返回挂起权限请求快照数组（元素含 `^per_` 前缀 requestID 与 permission/patterns/metadata/tool 载荷）；无挂起返回空数组；快照不影响内部状态。
  - **List pending questions**：`listPendingQuestions(sessionId)` 返回挂起问题请求快照数组（元素含 `^que_` 前缀 requestID 与 questions 载荷）；无挂起返回空数组。
- **design.md**：
  - **D2（parts 数组发送）**：扩展 PromptInput 增加 `parts?`；`prompt()` 优先 parts（content block 数组），无 parts 回退单文本；`makeUserMessage` 扩展为接受 `string | Array<{type:'text',text:string}>`。
  - **D3（per-prompt permissionMode）**：prompt 入参加可选 permissionMode；提供且与当前模式不同时先调 Query.setPermissionMode 再 push；`session.setPermissionMode(sessionId, mode)` 作为独立方法。
  - **D4（rejectQuestion）**：SessionState 新增 rejectQuestion(requestID)，resolve 挂起 question Promise 为 `{ behavior:'deny', message:'rejected by user' }`（与 respondPermission reject 对称），产出 question.rejected 控制事件（properties 含 sessionID/requestID）；question.rejected 加入 GlobalEventType。
  - **D5（listPending*）**：SessionState 暴露 listPendingPermissions()/listPendingQuestions()，返回 pendingPermissions/pendingQuestions Map 值快照（深拷贝 requestID + 载荷，不含 resolve/reject）；SessionManager 与 client.session 透传。
  - **D6（session.delete）**：SessionManager 注入 deleteSessionFn（默认 SDK deleteSession）；session.delete(sessionId) 先 close() 本地 SessionState 再调 deleteSessionFn(resolvedId, { dir })。
  - **D9（before 分页）**：SessionMessagesOptions 新增 `before?: string`（消息 ID）；底层 GetSessionMessagesOptions 支持 before 游标（「核验 sdk.d.ts」——**核验结果：不支持**，需适配层实现）；提供 before 时透传，与 offset cursor 互斥、before 优先。
  - **D12（create title 透传）**：CreateSessionOptions 新增 `title?: string`，buildInfo 使用 `options.title ?? ''`；底层 renameSession 可选持久化（非必须）。
  - D13（依赖注入扩展）：SessionManagerOptions 已含 forkSessionFn/deleteSessionFn/listSubagentsFn/getSubagentMessagesFn 注入点（foundation-01 已完成）；QueryLike 已扩展 rewindFiles/setPermissionMode 方法签名。

## 关键实现差异/障碍汇总

1. **before 无底层支持**（D9 声称核验 sdk.d.ts 即「支持」，实际 GetSessionMessagesOptions 无 before）：适配层必须自行按消息 ID（uuid）定位后切片；`GetSessionMessagesFn` 或注入 options 类型需扩展（底层类型不含 before，直接透传类型不通过）。
2. **SessionState 无当前 permissionMode 记录**：实现「与当前模式不同才切换」需新增模式跟踪字段（构造默认 = options.permissionMode，setPermissionMode 后更新）。
3. **pendingPermissions Map 值不含请求载荷**：listPendingPermissions 无法从现有 Map 重建 payload，需扩展 Map 值或另存 PermissionRequestInfo 快照；pendingQuestions Map 值已含 questions，可重建。
4. **delete 的 resolveSessionId 顺序陷阱**：state.close() 触发 onClose 从 Map 删除占位与真实 id，故须在 close 前捕获真实 id 与 directory（或先 resolveSessionId 再 close）。
5. **测试 FakeQuery 均无 setPermissionMode**：新增 setPermissionMode/prompt permissionMode 测试需在 FakeQuery 加 `vi.fn`；types.test.ts GlobalEventType 断言（L314-325）需同步加 'question.rejected'。
6. **PromptInput/GlobalEventType/CreateSessionOptions/SessionMessagesOptions/SessionPromptInput** 五个类型目前均缺新字段，任务 2.1 先行补齐。
