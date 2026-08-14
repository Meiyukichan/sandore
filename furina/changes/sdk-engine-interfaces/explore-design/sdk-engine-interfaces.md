# 探索报告 —— 工作流引擎所需 SDK 接口能力评估

> 探索类型：design（接口能力差距评估）
> 目标：评估现有 `packages/sdk/claude`（`@meiyukichan/claude-sdk`）能否满足 `docs/engine/agentic-native.md`（Harness Workflow Engine V2）所需的 SDK 接口能力。
> 关注重点：权限申请（permission.asked）与问题选择（question.asked）事件。
> 探索范围：①引擎文档 SDK 集成层（§9 SSE、§10 人机交互、§18 SDK 集成层、§19.6 会话 API、§20 重试）；②`packages/sdk/claude` 全部源码（client/session/events/session-state/model/types）。
> 本文件仅记录双方接口面与差距事实，不含实现方案。

---

## 1. 当前 SDK 公开接口面（`packages/sdk/claude`，@meiyukichan/claude-sdk v0.1.0）

### 1.1 client 命名空间（src/client.ts）
```
createClaudeClient({ cwd, queryFn?, getSessionMessagesFn? }) → ClaudeClient
  .session
    .create(options: CreateSessionOptions) → SessionV2Info
    .messages(sessionId, options?: { limit?, cursor?, order? }) → SessionMessagesResponse
    .prompt(sessionId, input: { prompt: PromptInput, delivery?, resume? }) → SessionInputAdmitted
    .interrupt(sessionId) → void
    .wait(sessionId, options?: { timeout? }) → void
    .events(sessionId) → AsyncIterable<GlobalEvent>        // 会话级归一化事件
    .respondPermission(sessionId, { requestID, reply }) → void
    .respondQuestion(sessionId, { requestID, answers }) → void
  .model.list(options?) → ModelListResponse
  .global.event(options?: { directory? }) → AsyncIterable<GlobalEvent>   // 目录级全局事件
  .close()
```

### 1.2 事件类型（GlobalEventType，src/types.ts）
`session.created` / `message.part.delta` / `message.part.updated` / `session.next.step.ended` / `session.error` / `session.idle` / `permission.asked` / `permission.replied` / `question.asked` / `question.replied`

### 1.3 权限申请事件载荷（PermissionRequestInfo，src/session-state.ts）
```
permission.asked properties: {
  id: string;            // ^per_ 前缀，respondPermission 的 requestID 依据
  sessionID: string;
  permission: string;    // 如 "Bash(npm run build)"
  patterns: string[];    // 本适配层为空数组
  metadata: { toolInput, blockedPath?, decisionReason? };
  always: string[];      // 本适配层为空数组
  tool?: { messageID, callID };
}
```
产出方式：canUseTool 桥接（受限工具调用 → `permission.asked` + 挂起 Promise，等待 `respondPermission` resolve）。

### 1.4 问题选择事件载荷（QuestionRequestInfo，src/session-state.ts）
```
question.asked properties: {
  id: string;            // ^que_ 前缀，respondQuestion 的 requestID 依据
  sessionID: string;
  questions: QuestionInfo[];   // { question, header, options: [{label, description?, preview?}], multiple?, custom? }
  tool?: { messageID, callID };
}
```
产出方式：canUseTool 桥接（AskUserQuestion 工具调用 → `question.asked` + 挂起 Promise，等待 `respondQuestion` resolve）。

### 1.5 回复接口
- `respondPermission({ requestID, reply: 'once'|'always'|'reject' })`：once/always → allow（always 附 addRules）；reject → deny；产出 `permission.replied`。
- `respondQuestion({ requestID, answers: QuestionAnswer })`：`QuestionAnswer = Record<question, string|string[]>`（question→所选 label 或 label 数组）；产出 `question.replied`。**无 deny/reject 分支**。

### 1.6 权限模式（CreateSessionOptions.permissionMode → query options）
透传 Claude SDK 原生 `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`。`bypassPermissions`/`acceptEdits` 由 SDK 原生自动放行（不触发 canUseTool）。

---

## 2. 引擎所需 SDK 接口 vs 现有 SDK —— 能力矩阵

> 引擎文档 `agentic-native.md` 面向 `@codeagent/sdk`（CodeAgent 协议），本评估以该文档列出的 SDK 集成层接口为基准逐项比对。

### 2.1 会话管理（引擎 §18.2 session.ts）
| 引擎接口 | 现有 SDK 对应 | 状态 |
|---|---|---|
| createSession(directory, title, providerId, modelId, permissionMode) | `client.session.create({ cwd/location, model, agent, permissionMode, ... })` | ✅ 基本满足（`title`/`providerId` 未透传，create options 无 title 字段） |
| sendChat({ sessionID, parts, permissionMode }) | `client.session.prompt({ prompt: { text } })` | ⚠️ 部分：**不支持 parts 数组**（PromptInput 仅 text+files+agents）、无 permissionMode/providerId 逐次传参 |
| subscribeEvents(directory, signal) | `client.global.event({ directory })`（GlobalEvent 流） | ✅ 满足（事件为 GlobalEvent 信封，非原始 SDK；无 AbortSignal 参数但迭代器可中断） |
| getSessionMessages(sessionId, { limit, before }) | `client.session.messages({ limit, cursor, order })` | ⚠️ 部分：分页游标为 offset 编码，非 `before`（消息 ID 游标） |
| getCommands() | — | ❌ 缺失（无 command 命名空间） |
| listHooks() | — | ❌ 缺失（无 mcp 命名空间） |
| abortSession(sessionId) | `client.session.interrupt(sessionId)` | ✅ 功能等价（中断当前回合；空闲 no-op） |
| deleteSession(sessionId) | — | ❌ 缺失（仅内部 close()，无对外删除） |
| revertSession(sessionId, messageID) | — | ❌ 缺失 |
| unrevertSession(sessionId) | — | ❌ 缺失 |
| forkSession(sessionId, messageID) | — | ❌ 缺失（Claude SDK 仅有 query option `forkSession: boolean`，无会话级 fork 方法） |
| autoReplyPermission() | `respondPermission`（引擎层可自行实现） | ✅ 可行 |

### 2.2 临时会话工具（引擎 §18.3 utils.ts）
startTempSession / collectTempSession / runTempSession —— 依赖 createSession + 等待 idle + 读取消息。现有 SDK 的 `create/wait/events/messages` 齐备，**可行**。引擎文档中的 `readLastTextFromJsonl`/`stripThinkTags` 为引擎侧封装（jsonl 由引擎的 SdkSseManager 写入），非 SDK 接口。

### 2.3 SSE 事件流（引擎 §9.1-§9.3）
| 引擎监听事件 | 现有 SDK GlobalEvent | 状态 |
|---|---|---|
| session.idle | ✅ session.idle | ✅ 满足 |
| question.asked | ✅ question.asked | ✅ 满足 |
| permission.asked | ✅ permission.asked | ✅ 满足 |
| message.part.updated | ✅ message.part.updated | ✅ 满足（但子 Agent 会话 ID 提取需解析 tool input） |
| message.part.delta | ✅ message.part.delta | ✅ 满足 |
| 事件信封形状 | `{ directory, payload: { id, type, properties } }` | ⚠️ 引擎 NormalizedSseEvent 为 `{ type, properties, sessionId, raw }`，需在引擎层适配（从 payload + properties.sessionID 提取） |

### 2.4 人机交互 —— 权限（引擎 §5.3、§10、§18.2）
| 引擎需求 | 现有 SDK | 状态 |
|---|---|---|
| permission.asked 事件（含 permission/patterns/metadata/tool） | ✅ PermissionRequestInfo | ✅ 完整匹配 |
| replyPermission(requestId, 'once'|'always'|'reject') | ✅ `respondPermission` | ✅ 完整匹配 |
| permission.replied 事件 | ✅ | ✅ 满足 |
| bypassPermissions / acceptEdits 自动放行 | ✅ SDK 原生 permissionMode | ✅ 满足 |
| 运行时切换权限模式（V2.3 updateInstancePermissionMode） | — | ❌ 缺失（Claude SDK Query 有 setPermissionMode，适配层未暴露） |

### 2.5 人机交互 —— 问题选择（引擎 §5.3、§10）
| 引擎需求 | 现有 SDK | 状态 |
|---|---|---|
| question.asked 事件（含 questions 选项） | ✅ QuestionRequestInfo + QuestionInfo | ✅ 完整匹配 |
| replyQuestion(requestId, answers) | ✅ `respondQuestion` | ⚠️ 格式差异：引擎传 `answers: string[][]`（按问题顺序的 label 数组），SDK 期望 `Record<question, string|string[]>`，需转换 |
| rejectQuestion(requestId) | — | ❌ 缺失（respondQuestion 仅 allow 分支，无 deny/reject） |
| question.replied 事件 | ✅ | ✅ 满足 |

### 2.6 重试机制（引擎 §20.2，V2.3）
| 重试模式 | 现有 SDK | 状态 |
|---|---|---|
| continue（同一会话追加消息） | ✅ `session.prompt` | ✅ 满足 |
| revert（回退到指定消息） | — | ❌ 缺失 |
| fork（分叉新会话） | — | ❌ 缺失 |

### 2.7 会话消息读取（引擎 §22.3 / §18.2）
- `getSessionMsgs(sessionId, limit, before)` → `client.session.messages({ limit, cursor, order })`。limit/order 满足；`before` 语义由 offset 游标近似替代。✅/⚠️

---

## 3. 关键结论（事实清单）

1. **权限申请事件：SDK 已有完整能力**。`permission.asked`（canUseTool 桥接）+ `respondPermission('once'/'always'/'reject')` + `permission.replied` 齐全，载荷字段（id/sessionID/permission/patterns/metadata/tool）与引擎 `PendingPermission` 所需字段一一对应（引擎 §5.3 addPendingPermission 入参 `{stepId, sessionId, requestId, permission, patterns?, metadata?, tool?}` 全部可由 permission.asked properties 提供，stepId 由引擎按 sessionId 路由补齐）。

2. **问题选择事件：SDK 已有完整能力**。`question.asked`（AskUserQuestion 桥接）+ `respondQuestion` + `question.replied` 齐全，questions 载荷含 label/description/preview 选项，与引擎 `PendingQuestion` 所需 `{stepId, sessionId, requestId, questions}` 对应。

3. **权限/问题桥接的依赖**：两者都依赖 `canUseTool` 回调（SessionState 构造时注入，`toolAuth !== 'disabled'` 时启用），以挂起 Promise + 控制事件通道（controlChannel）产出事件，并合并进 `sessionEvents()`/`global.event` 流（events.ts mergeAsyncIterables）。

4. **主要缺口（均非权限/问题事件本身）**：
   - `session.prompt` 不支持 parts 数组（引擎 Step 用结构化 XML parts 提示词）、无逐次 permissionMode/providerId 传参；
   - `revertSession`/`unrevertSession`/`forkSession` 缺失（V2.3 重试 revert/fork 两模式依赖）；
   - `rejectQuestion` 缺失（问题无拒绝路径，仅 allow）；
   - `deleteSession`、`getCommands`、`listHooks(mcp)`、运行时 `setPermissionMode` 缺失；
   - `create` 无 title 透传；`messages` 无 `before` 消息 ID 游标。

5. **形状适配点**：引擎 NormalizedSseEvent（`{type, properties, sessionId, raw}`）与 SDK GlobalEvent（`{directory, payload:{id,type,properties}}`）结构不同，引擎的 SdkSseManager 需做一层解包；子 Agent 会话 ID 需从 `message.part.updated` 的 ToolPart `state.input` 解析（SDK 未原生暴露 subtask/sessionId 字段）。

---

## 4. 引用文件（绝对路径）
- 引擎需求：`D:\project-code\llm\sandore\docs\engine\agentic-native.md`
- SDK 客户端：`D:\project-code\llm\sandore\packages\sdk\claude\src\client.ts`
- SDK 会话：`D:\project-code\llm\sandore\packages\sdk\claude\src\session.ts`
- SDK 事件：`D:\project-code\llm\sandore\packages\sdk\claude\src\events.ts`
- SDK 会话状态/canUseTool 桥接：`D:\project-code\llm\sandore\packages\sdk\claude\src\session-state.ts`
- SDK 类型：`D:\project-code\llm\sandore\packages\sdk\claude\src\types.ts`
- SDK 测试（桥接回归）：`D:\project-code\llm\sandore\packages\sdk\claude\test\events.test.ts`（permission.asked 合并消费用例位于约 709 行）
- 目标协议：`D:\project-code\llm\sandore\docs\sdk\openapi.json`（session.prompt 含 parts、session.revert/fork/abort/delete 等 operationId）
- 适配层归档规格：`D:\project-code\llm\sandore\furina\archive\2026-08-11-claude-sdk-adapter\api.yaml`、`specs\event-streaming\spec.md`、`specs\session-management\spec.md`
