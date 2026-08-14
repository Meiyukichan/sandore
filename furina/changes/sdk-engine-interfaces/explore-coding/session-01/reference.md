## Exploration Result

### 需求理解（Phase 2）

- **What**：为 `@meiyukichan/claude-sdk`（packages/sdk/claude）实现三类能力：结构化 parts 发送、会话运行时管理（setPermissionMode/delete/create title/messages before）、交互控制（rejectQuestion/listPending*）。本探索核验这些能力在底层 Claude SDK（`@anthropic-ai/claude-agent-sdk` v0.3.226）与现有适配层代码中的真实形态与可行性。
- **Boundaries**：`packages/sdk/claude/src/`（client.ts / session.ts / session-state.ts / events.ts / types.ts / index.ts）、`packages/sdk/claude/test/`（session/client/events/types.test.ts）、`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`、`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`、`docs/sdk/openapi.json`、`furina/changes/sdk-engine-interfaces/`（design.md / specs / plan.json）。
- **Goal**：为 session-01 的实现提供基于真实代码的事实依据，特别是识别底层 SDK 不支持的假设（before 游标）与内部状态缺口（permissionMode 未记录、pendingPermissions 未存载荷）。

### 探索点（1）before 游标可行性 —— 底层不支持，D9 假设未成立

- `getSessionMessages`（sdk.d.ts L759）：`(_sessionId, _options?: GetSessionMessagesOptions): Promise<SessionMessage[]>`。
- `GetSessionMessagesOptions`（sdk.d.ts L764-783）字段全集：`dir?`、`limit?`、`offset?`、`includeSystemMessages?`、`sessionStore?`。**无 `before` 字段**，无任何按消息 ID 定位机制。分页仅 offset/limit。
- SDK 中唯一按消息 ID 切片的是 `ForkSessionOptions.upToMessageId?`（sdk.d.ts L705-710，forkSession 专属），与 getSessionMessages 无关。
- 适配层 `GetSessionMessagesFn`（session.ts L123-126）签名 `(sessionId, options?: GetSessionMessagesOptions) => Promise<SDKStoredMessage[]>`，同样无 before。
- 现有 `messages()`（session.ts L253-285）仅用 offset 编码游标（`CURSOR_PREFIX = 'offset:'`，L176），decodeCursor/encodeCursor（L416-425）。
- **结论**：spec/session-management「按 before 消息 ID 分页」与 design.md D9 假定底层支持 before，但真实 SDK v0.3.226 不支持。实现须自行扩展：或扩展适配层 `GetSessionMessagesFn` 的 options 类型（交叉 `before?: string`）并在适配层按「先取全部/按消息 uuid 定位索引再 offset 切片」实现客户端侧 before 语义；注入 mock 可透传，但真实 SDK 函数不会消费该字段。

### 探索点（2）structured parts 发送 —— 底层支持 content 数组，SDKUserMessage 形状已核验

- `makeUserMessage`（session.ts L434-441）：当前仅接受 `text: string`，构造 `{ type:'user', message:{ role:'user', content:text }, parent_tool_use_id:null }`。prompt()（L290-303）直接 `makeUserMessage(input.prompt.text)`。
- `SDKUserMessage`（sdk.d.ts L4772-4816）：`message: MessageParam`；`MessageParam.content`（@anthropic-ai/sdk resources/messages/messages.d.ts L808-811）= `string | Array<ContentBlockParam>`。
- `ContentBlockParam` 联合（messages.d.ts L555）含 `TextBlockParam`；`TextBlockParam`（L1080-1088）= `{ text: string; type: 'text'; cache_control?; citations? }`。**user 消息 content 数组块合法**，`[{type:'text',text},...]` 可直接作为 `SDKUserMessage.message.content`。
- `PromptInput`（types.ts L160-164）：`{ text: string; files?; agents? }`，无 parts。openapi.json `PromptInput`（L26237-26260）：`text/files/agents`，`required: ['text']`，`additionalProperties:false`——**无 parts 字段**，spec 的 parts 扩展为新增（需放宽 additionalProperties 或扩展本地类型）。openapi `session.prompt` requestBody（L11108+）为 `{ id, prompt, delivery, resume }`，亦无 permissionMode。

### 探索点（3）per-prompt permissionMode —— Query 签名已核验，SessionState 未记录当前模式

- `Query.setPermissionMode(mode: PermissionMode): Promise<void>`（sdk.d.ts L2377），仅 streaming input mode 可用。`PermissionMode`（L2169）= `'default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto'`。
- `QueryLike.setPermissionMode?`（session-state.ts L134）为可选成员（D13 已加），FakeQuery 等简化实现不受影响。
- **SessionState 未持有/记录会话 permissionMode**：仅构造时透传 `permissionMode: options.permissionMode` 到 query options（session-state.ts L342），无字段存储、无 getter。D3「若提供且与当前会话模式不同」的比较需要新增一个记录的当前模式字段（create 的 `options.permissionMode` 作为初始值，`setPermissionMode`/prompt 切换后更新）。

### 探索点（4）rejectQuestion —— respondQuestion 现状与 deny 分支形状

- `respondQuestion`（session-state.ts L437-455）：查 `pendingQuestions` Map（不存在抛 SessionNotFoundError）→ delete → `pending.resolve({ behavior:'allow', updatedInput:{ questions: pending.questions, answers: input.answers } })` → 写 `question.replied` 控制事件（properties 含 sessionID/requestID/answers）。
- 对称的 deny 形状参考：`respondPermission` reject 分支（L404-405）resolve `{ behavior:'deny', message:'rejected by user' }`。`PermissionResult` deny 变体（sdk.d.ts L2191-2203）= `{ behavior:'deny'; message: string; interrupt?; toolUseID?; decisionClassification? }`。`docs/sdk/claude/user-input.md` L216-217 确认拒绝语义 `{ behavior:"deny", message }`。
- **当前无 rejectQuestion 方法**。D4 设计：resolve `{ behavior:'deny', message:'rejected by user' }`（与 respondPermission reject 对称），并写 `question.rejected` 控制事件（properties 含 sessionID + requestID）。`question.rejected` 需加入 `GlobalEventType`（types.ts L80-90 目前为 10 项联合，无 question.rejected）。控制事件经 `makeControlEvent`（L730-745）生成，payload.id 以 `evt_` 前缀。

### 探索点（5）listPending* —— Map 值结构、快照与载荷缺口

- `pendingPermissions`（session-state.ts L298-302）：`Map<string, { resolve: (result: PermissionResult) => void; reject: (reason: unknown) => void }>`——**仅存 resolve/reject，未存 PermissionRequestInfo 载荷**。`pendingQuestions`（L303-311）：`Map<string, { questions: QuestionInfo[]; resolve; reject }>`——存了 questions 数组但未存完整 request。
- `PermissionRequestInfo`（L69-84）：`{ id, sessionID, permission, patterns, metadata, always, tool? }`。`QuestionRequestInfo`（L87-96）：`{ id, sessionID, questions, tool? }`。这两个形状在 `bridgePermission`（L664-691）与 `bridgeQuestion`（L694-714）中构造，写入 controlChannel 事件并触发回调，但**权限载荷未入 Map**。
- **结论**：listPendingPermissions 要返回「requestID + permission/patterns/metadata/tool 载荷」，需将 `pendingPermissions` Map 值扩展为携带 `PermissionRequestInfo`（或并行 Map）；listPendingQuestions 已有 questions 可直接快照。快照 = 剥离 resolve/reject 函数、深拷贝载荷。spec 要求 requestID 为 `^per_`/`^que_` 前缀（构造处 L669/L698 已保证）。

### 探索点（6）session.delete —— close/closeAll/deleteSessionFn 注入/resolveSessionId

- `close(sessionId)`（session.ts L342-346）：`getState` 校验 → `state.close()`（SessionState.close 关闭 Query/通道/拒绝挂起/onClose，session-state.ts L534-547）→ `sessions.delete(sessionId)`。
- `closeAll()`（L349-354）：遍历 values 逐个 `state.close()` 后 `sessions.clear()`。
- `DeleteSessionFn`（session.ts L135-138）：`(sessionId, options?: SessionMutationOptions) => Promise<void>`；构造器默认 `deleteSession`（L197）。SDK `deleteSession`（sdk.d.ts L530）`(sessionId, options?: SessionMutationOptions): Promise<void>`；`SessionMutationOptions`（L4935-4947）= `{ dir?; sessionStore? }`，无 sessionId 时删 `{sessionId}.jsonl` 与 `{sessionId}/` 子 Agent 转录目录，会话不存在抛错。
- `resolveSessionId`（L357-360）：`this.sessions.get(sessionId)?.sessionId ?? sessionId`——占位别名映射到真实 session_id。
- plan.json session-01 2.5 的实现路径：`getState` 校验 → `state.close()` 清理 → `resolveSessionId` 得真实 id → `deleteSessionFn(resolvedId, { dir: state.directory })`。区分于 close：delete 额外清磁盘会话文件。

### 探索点（7）create title 透传 —— buildInfo 恒为 ''

- `buildInfo`（session.ts L381-398）`title: ''`（L395）；`CreateSessionOptions`（L66-94）**无 title 字段**。
- events.ts `buildSessionInfo`（L449-462）同样 `title: ''`（L459）——`session.created` 事件 info。
- D12：`CreateSessionOptions` 增 `title?: string`，`buildInfo` 用 `options.title ?? ''`。type-test（types.test.ts L107）已断言 `SessionV2Info['title']` 为 string。

### 探索点（8）现有测试结构

- **session.test.ts**：`FakeQuery`（L108-189）实现 QueryLike——inputIterator（验证 push 消息形状，`readInput()` L160-163）、queue/waiters、`interrupt`/`close` vi.fn、`pushMessage`/`end`/`fail`。`createHarness`（L202-230）注入 queryFn（记录 `lastQueryOptions`）/getMessages。canUseTool 桥接测试（L841-982）：permission.asked → respondPermission once/reject（断言 result.behavior allow/deny）、question.asked → respondQuestion（断言 allow + updatedInput.answers）、close 时挂起被 reject、sessionEvents 合并控制事件（L958-981）。respondPermission/respondQuestion 的 requestID 从控制事件 `payload.properties.id` 提取（`per_`/`que_` 前缀断言 L874/L933）。
- **client.test.ts**：`FakeQuery`（L63-130，含 `supportedModels`）。命名空间函数断言（L184-198）、pending→created 事件（L273-316）、`client.session.prompt` 形状。
- **types.test.ts**：`GlobalEventType` 精确联合断言（L314-325，10 项，**无 question.rejected**——需同步更新）；PromptInput 断言（L135-146，`text` 必填）；QueryLike D13（L382-419）；SessionV2Info.title（L107）。
- **events.test.ts**：`payload.type` 断言遍布（L346-951）；sessionEvents 合并 permission.asked/permission.replied（L768-781）；信封 `evt_` 前缀断言（L346-355）。

### 探索点（9）specs 与 design.md 具体要求

- **structured-prompt-parts/spec.md**：`parts?: Array<{type:'text';text:string}>`；parts 优先/回退单文本/空数组三场景；parts 数组元素顺序对应 content block 数组元素。
- **session-management/spec.md**：delete（先关本地再调 `deleteSession(resolvedId,{dir})`，不存在抛 SessionNotFoundError）；运行时 setPermissionMode（mode 为 PermissionMode 联合）；prompt 可选 permissionMode（不同才切换、未传不变）；create 可选 `title`；messages 可选 `before`（透传、与 offset cursor 互斥、before 优先）。
- **interactive-control/spec.md**：rejectQuestion（resolve `{behavior:'deny',message:'rejected by user'}`，产 `question.rejected`，requestID `^que_`，不存在抛错）；question.rejected 进 GlobalEventType 并经会话控制通道与全局流可达；listPendingPermissions（`^per_` + 载荷快照、空数组）；listPendingQuestions（`^que_` + questions 快照、空数组）。
- **design.md**：D2 parts（makeUserMessage 扩展 `string | Array<{type:'text',text}>`）、D3 per-prompt permissionMode（先 setPermissionMode 再 push，session.setPermissionMode 独立暴露）、D4 rejectQuestion（deny 分支 + question.rejected）、D5 listPending*（Map 值快照剥离函数）、D6 delete（deleteSessionFn 注入 + close 差异）、D9 before 分页（**其「核验 sdk.d.ts」的假定未通过——见探索点 1**）、D12 create title 透传。plan.json session-01 给出实现步骤 2.1-2.10（类型扩展 → makeUserMessage → prompt permissionMode → setPermissionMode → delete → title/before → rejectQuestion → listPending* → 命名空间透传 → 测试）。

### 关键文件路径

- 适配层源码：`D:/project-code/llm/sandore/packages/sdk/claude/src/session.ts`、`session-state.ts`、`client.ts`、`events.ts`、`types.ts`、`index.ts`
- 测试：`D:/project-code/llm/sandore/packages/sdk/claude/test/session.test.ts`、`client.test.ts`、`events.test.ts`、`types.test.ts`
- 底层 SDK 类型：`D:/project-code/llm/sandore/packages/sdk/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（v0.3.226）；`@anthropic-ai/sdk` messages.d.ts 在 `D:/project-code/llm/sandore/node_modules/.pnpm/@anthropic-ai+sdk@0.116.0_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`
- 协议与规格：`D:/project-code/llm/sandore/docs/sdk/openapi.json`、`D:/project-code/llm/sandore/furina/changes/sdk-engine-interfaces/design.md`、`.../specs/{structured-prompt-parts,session-management,interactive-control}/spec.md`、`.../plan.json`
- 参考文档：`D:/project-code/llm/sandore/docs/sdk/claude/user-input.md`（deny 语义）

## Supplementary Exploration Result

- 本探索 `exploration.reference` 配置为空 `[]`，无外部参考资料；`experimental.websearch`/`context7` 已启用但底层类型事实已从本地 node_modules 源码直接核验（sdk.d.ts / messages.d.ts / openapi.json），无需外部补充。未发现与探索点直接相关的官方文档差异。
