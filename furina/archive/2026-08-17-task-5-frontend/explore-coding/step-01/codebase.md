# step-01 sandore-step 讨论节点三件套 — 参考实现探索

> 探索类型：codebase
> 参考源码：`D:\project-code\llm\deepseek-harness`（DSH 官方 `ui-workflow-run` 包）
> 当前项目：`D:\project-code\llm\sandore`（sandore DSH 插件仓库）
> 依据规格：`docs/design/task-5-frontend/design.md` §5.3（决策 D8）
> 本文件仅记录「当前状态」的探索事实，不含任何实现方案。

---

## 一、需求理解（Phase 2）

### 1. What

要理解 DSH 官方范本 `ui-workflow-run`（`packages/client/ui-workflow-run/`）如何把多个子代理 run 折叠成主对话消息流里的**一个 Chat 节点**——这套「三件套」是 sandore `sandore-step` 讨论节点（每个 Step 折叠为一个节点）的**照抄范本**。具体五块：

1. `ui-workflow-run` 三件套源码（注册入口 + Definition + keyed 渲染器 + locale）
2. `ConversationNodeDefinition` 契约（runtime 契约类型与引擎折叠机制）
3. `conversation.chat.node` keyed 插槽（声明 + 派发 + `ChatNodeDataMap` merge）
4. 事件 payload（DSH `SessionEvent` 包络 + 参考 `tool-workflow/*` + sandore 自身 `sandore/*`）
5. 内联消息渲染（primitives 可 import 的 `MarkdownText`/`MessageText` + 照抄对象 `AssistantMarkdown`/`UserStyleBubble`/`ToolCallTree`）

### 2. Boundaries

- DSH 参考：`packages/client/ui-workflow-run`（三件套）、`packages/client/runtime`（`ConversationNodeDefinition` 契约 + assembler）、`packages/client/ui-conversation`（`conversation.chat.node` slot 声明/派发 + 消息渲染）、`packages/client/ui-primitives`（`MarkdownText`/`MessageText` 等）、`packages/workflow/tool-workflow` + `packages/workflow/workflow`（参考事件 payload 类型）。
- sandore 现状：`packages/sandore/workflow/src/seam.ts`（`sandore/*` 事件 payload）、`packages/sandore/microflow/src/subagents.ts` + `step-runner.ts`（`output: ContentBlock[]` 来源）、`packages/sandore/ui/`（当前 UI 现状与缺口）。

### 3. Goal

准确掌握「讨论节点三件套」的**真实形状**（每一件的类型签名、注册范式、事件折叠生命周期、payload 形状、渲染复用点），为 sandore `sandore-step` 节点照抄提供事实依据，并识别 sandore `ui` 包当前相对范本的缺口。

### 4. Project Context

决策 D8（`design.md` §5.3）规定：讨论面板 = 复用 `ui-workflow-run` 的 Chat 节点机制——`ConversationNodeDefinition`（kind=`sandore-step`, target=`chat`）+ `conversation.chat.node` keyed 渲染器 + primitives 自绘内联消息。DSH 的对话消息组件全部 package-internal，不可跨插件 import，但 `ui-workflow-run` 是官方「多子代理组合」范本，其机制与主对话页完全一致，可直接复用。

---

## 二、`ui-workflow-run` 三件套源码（Phase 3）

### 2.1 包结构

```
packages/client/ui-workflow-run/
├── package.json              # dsh.client.inject / peerDependencies / exports "./client"
├── tsdown.config.ts          # clientBundle('@deepseek-ai/dsh-client-ui-workflow-run', ...)
├── src/index.ts              # Host 半：apply(): void {}（功能全在浏览器侧）
└── src/client/
    ├── index.ts              # 三件套注册入口
    ├── workflow-definition.ts# ① ConversationNodeDefinition
    ├── WorkflowRunPanel.tsx  # ② keyed 渲染器
    ├── WorkflowRunPanel.module.css
    └── locales.ts            # ③ locale 字典
```

### 2.2 三件套注册入口 `src/client/index.ts`（全文关键）

```ts
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(workflowRunDefinition)              // ① Definition
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), '...')        // ③ locale
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'workflow-run',                                              // ② keyed
    locale: NS,
    inject: (): WorkflowRunInjected => ({
      openSession: (id: SessionId) => { ctx.sessions.open(id) },       // 跳子会话
    }),
  }, WorkflowRunPanel))
}
```

要点：
- `inject` 依赖 **`conversationEvents`**（Definition 注册服务）、`slots`、`sessions`（子会话导航）、`locale`。
- 三件套分别是：`ctx.conversationEvents.register(workflowRunDefinition)` + `ctx.slots.register({ key: 'workflow-run' }, WorkflowRunPanel)` + `ctx.locale.register(NS, ...)`。
- keyed 渲染器的 `inject` 只注入 `openSession`（即 `ctx.sessions.open(id)`），供点击成员跳子会话页。

### 2.3 ① Definition `src/client/workflow-definition.ts`

```ts
export const workflowRunDefinition: ConversationNodeDefinition<WorkflowState> = {
  kind: 'workflow-run',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool-workflow/run-start') return { id: String(event.data.runId), role: 'start' }
    if (event.type === 'tool-workflow/agent-start'
      || event.type === 'tool-workflow/agent-end'
      || event.type === 'tool-workflow/run-end') {
      return { id: String(event.data.runId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool-workflow/run-start') {
      throw new Error('workflow-run start requires tool-workflow/run-start')
    }
    return { name: match.event.data.name, members: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool-workflow/agent-start') return updateAgentStart(...)
    if (match.event.type === 'tool-workflow/agent-end')   return updateAgentEnd(...)
    if (match.event.type === 'tool-workflow/run-end')     return { ...context.state, stopReason: ... }
    return context.state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    const data = projectWorkflow(context, context.start.location)
    return {
      key: context.key, kind: 'workflow-run', id: context.id, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location,
      visibility: 'visible', data,
    }
  },
}
```

要点：
- **`match`** 从原始 `SessionEvent` 提取稳定业务身份 `id`（= runId）与生命周期角色 `role: 'start' | 'update'`；不相关返回 `null`。
- **`start`** 从唯一 start Match 建初始 State；**`update`** 按日志升序折叠后续 update Match 到 State。
- **`buildViewNode`** 把 State 投影为 `ChatConversationViewNode`（`target: 'chat'`、`anchorSeq`、`location`、`visibility`、`data`）。`anchorSeq` 决定节点在主对话流中的锚点位置。
- **声明合并扩展 payload 注册表**：
  ```ts
  declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ChatNodeDataMap {
      'workflow-run': WorkflowRunChatData   // kind 名 → 渲染 payload 类型
    }
  }
  ```

### 2.4 ② keyed 渲染器 `src/client/WorkflowRunPanel.tsx`

```ts
export interface WorkflowRunInjected {
  readonly openSession: (id: SessionId) => void
}

export type WorkflowRunPanelProps =
  PropsRuntime<'conversation.chat.node', 'workflow-run'>
  & PropsLocale<'workflowRun'>
  & WorkflowRunInjected
```

- 渲染函数签名解构：`WorkflowRunPanel({ node, sessionId, useSessions, openSession, t })`。
  - `node.data` 为 `WorkflowRunChatData`（由 Definition 投影）。
  - `useSessions` 是框架标准 hook（`sessionId` + `useSessions` 来自 `PropsRuntime<'conversation.chat.node', ...>`）。
- 用 `useSessions(sessions => navigableMembers(...), shallowEqual)` 判定哪些成员「当前可导航」（`origin: 'subagent'`、`parentId === 当前 sessionId`、`running`、子会话在普通列表），只有可导航成员才渲染成 `<button onClick={() => openSession(member.childId)}>`。
- 视觉组件复用 primitives：`DisclosureRow`、`StateDot`（`StateDotState`：`ongoing`/`done`/`error`/`warning`）、`IconChevronRightOutline14`。
- 状态机：`WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'`；`dotState`/`statusFromStopReason`/`statusFromOutcome` 做映射。
- 折叠规则：run/phase 只要含非 completed 成员就强制展开（`DisclosureRow open expandable={false}`）；全部 completed 后转为 `ManualDisclosure`（受控 open 状态）。

### 2.5 ③ locale `src/client/locales.ts`

- `NS = 'workflowRun'`；`zh`（键集真源）/ `en` 双字典；`WorkflowRunKey = keyof typeof zh`。
- 通过 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { workflowRun: WorkflowRunKey } }` 把命名空间并入 locale 映射。
- 键样例：`run.title`、`status.running/completed/failed/cancelled/interrupted`、`member.open`、`phase.unassigned` 等。

### 2.6 包配置（package.json / tsdown.config.ts）

- `dsh.client.inject`（浏览器组合注入顺序）：`dsh-client-locale`、`dsh-client-runtime`、`dsh-client-ui-conversation`；`platform: 'web'`。
- `peerDependencies` 含 `dsh-client-ui-conversation`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-session`、`dsh-tool-workflow`、`dsh-workflow`、`dsh-client-runtime` 等。
- `exports["./client"]` 指向 `lib/client.js`；`tsdown.config.ts` 用 `clientBundle(...)` 打包 client 入口。

---

## 三、`ConversationNodeDefinition` 契约（Phase 3）

位置：`packages/client/runtime/src/client/contract/conversation.ts`

### 3.1 核心接口

```ts
export interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string
  readonly target?: string                       // 唯一视图 target；纯 state-only Context 省略
  match(event: SessionEvent): ConversationMatchResult | null
  start(context, match, reader): State
  update(context & { state: State }, match): State
  publication?(match): ConversationPublication    // 'none' | 'animation-frame' | 'immediate'
  buildLocationData?(context, scope): ConversationLocationData | null
  buildViewNode?(context): ConversationViewNode | null
}
```

- `ConversationMatchResult = { id: string; role: 'start' | 'update' }`。
- `ChatConversationViewNode extends ConversationViewNode`，额外字段：`target: 'chat'`、`anchorSeq: number`、`location: ConversationLocation`、`visibility: 'visible' | 'hidden'`。
- `ConversationViewNode = { key, kind, id, target, data }`。
- `ConversationNodeContext<State> = { key, kind, id, matches, start, state, current }`。
- `ConversationLocation`：`{ kind: 'session' } | { kind: 'turn', turn } | { kind: 'step', turn, step } | { kind: 'unresolved' }`。
- `conversationContextKey(kind, id) = `${kind.length}:${kind}${id}`` — 引擎拥有的 Context key。

### 3.2 注册契约 `event-registry.ts`

- `ConversationEventRegistry.register(definition)` 以 `definition.kind` 为唯一键；重复注册抛错。
- `assertDefinitionTarget`：`target` 与 `buildViewNode` 必须**成对出现/同时省略**。
- `registerFallback(definition)`：仅在无普通 Definition 匹配时兜底（`ui-conversation` 的 `unknown` 节点即此机制）。

### 3.3 折叠引擎 `conversation-assembler.ts`

- `ConversationNodeAssembler` 是 Session 拥有的增量引擎：`match`（`dispatchInput` 遍历 `eventDefinitions.entries()`，逐个 Definition 调 `match(event)`）→ 命中则建 Context（`conversationContextKey` 为键）→ `role === 'start'` 调 `start()` 建 State；`role === 'update'` 按日志升序调 `update()` 折叠。
- `buildNode` 调 `buildViewNode`，并校验返回的 `key`/`target` 与 Context 一致。
- 三种窗口操作：`replaceWindow`（全量重放）、`append`（实时尾追加）、`prepend`（加载更旧页）；`flush()` 把脏 Context 物化成 view snapshot（`replace` / `apply` 增量）。
- 去重天然保证：同一事件只匹配一次；`mergeMatches` 拒绝重复 seq。

---

## 四、`conversation.chat.node` keyed 插槽（Phase 3）

### 4.1 插槽声明

位置：`packages/client/ui-conversation/src/client/contract/slots.ts`

```ts
'conversation.chat.node': {
  kind: 'keyed'
  scope: 'session'
  owner: ChatNodeOwnerProps
  keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
  hookContext: string
  inject: ChatNodeTurnDataInjected
}
```

- `ChatNodeOwnerProps`（owner 分派给渲染器的 owner currency）：`selectedCallId?`、`cwd?`、`openFile`、`inspectCall`、`forkAt`、`loadImage`、`fileMentions`。
- `ChatNodeViewProps<Kind> = PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'conversation'>` — 渲染器统一 props 形状（`node`、`sessionId`、`useSessions` 等来自 `PropsRuntime`）。
- `ChatNodeTurnDataInjected = { hooks: { turnData: SlotHookFactory<'conversation.chat.node', UseChatNodeTurnData> } }` — 供渲染器读取节点 Turn 上的业务数据（如 `useTurnData('turn-tail')`）。

### 4.2 payload 注册表与节点类型

位置：`packages/client/ui-conversation/src/client/contract/chat-nodes.ts`

```ts
export interface ChatNodeDataMap {}                            // merge-extensible
export type ChatNodeKind = Extract<keyof ChatNodeDataMap, string>
export type ChatNode<Kind extends ChatNodeKind = ChatNodeKind> = {
  [K in Kind]: ChatConversationViewNode & { kind: K; data: ChatNodeDataMap[K] }
}[Kind]
```

- 内置 kind（`register-node-renderers.ts`）：`user`、`steering`、`context`、`assistant-step`、`command`、`manual-compaction`、`compaction`、`model-retry`、`turn-error`、`turn-max-tokens`、`turn-tail`、`unknown`。
- 业务插件（如 `ui-workflow-run`）通过 `declare module ... { interface ChatNodeDataMap { 'workflow-run': ... } }` 新增 kind 与 payload。

### 4.3 派发点 `ChatNodeSeat.tsx`

```tsx
renderSlot('conversation.chat.node', routedOwner, {
  entryKey: routedNode.kind,     // 按节点 kind 派发到对应 keyed 渲染器
  hookContext: nodeKey,
  fallback: <JsonBlock ... />,    // 未注册 kind 的兜底
})
```

- 每个节点一个 `ChatNodeSeat`，`useSession(snapshot => snapshot.chat.nodes.get(nodeKey))` 只订阅自己的节点，不观察兄弟节点（`memo`）。
- 外层 `div` 带 `data-chat-anchor-key` / `data-chat-flow-key` / `data-chat-flow-kind`。

---

## 五、事件 payload（Phase 3 + 4）

### 5.1 DSH `SessionEvent` 包络

位置：`packages/core/session/src/types.ts`

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: number        // 会话内单调递增序号
    time: number       // Unix 毫秒
    data: SessionEventMap[K]
    ignorable?: true
  } & (K extends SurfaceEventType ? { surfaceOp: SurfaceOp; sourceEventSeqs?: number[] } : {})
}[SessionEventType]
```

- `SessionEventMap` 是可合并扩展的（`interface`），插件经 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { ... } }` 追加事件类型。
- `SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'` — 只有这三类带 `surfaceOp`/`sourceEventSeqs`；`sandore/*`、`tool-workflow/*` 均为 log-only 事件（非 surface，不产生历史消息）。

### 5.2 参考事件：`tool-workflow/*`（ui-workflow-run 消费）

位置：`packages/workflow/tool-workflow/src/types.ts` + `packages/workflow/workflow/src/types.ts`

| 事件 | data 关键字段 |
|---|---|
| `tool-workflow/run-start` | `runId`, `name` |
| `tool-workflow/agent-start` | `runId`, `seq`, `label`, `phase?`, `childId` |
| `tool-workflow/agent-end` | `runId`, `seq`, `outcome` |
| `tool-workflow/run-end` | `runId`, `stopReason` |

- `WorkflowStopReason = 'completed' | 'cancelled' | 'error'`；`WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'`。

### 5.3 sandore 自身事件：`sandore/*`（本项目，将被 sandore-step 消费）

位置：`packages/sandore/workflow/src/seam.ts`（13 个事件**双声明**：Cordis `Events` + Session `SessionEventMap`）

Session `SessionEventMap` 侧 payload（与 `match(event)` 直接相关）：

| 事件 | data 关键字段 |
|---|---|
| `sandore/start` | `taskId`, `workflowId`, `jobId` |
| `sandore/stage-start` | `taskId`, `stageId` |
| `sandore/stage-completed` | `taskId`, `stageId`, `stageContract` |
| `sandore/step-start` | `stepId`, `childId`, `name`, `loopIteration?` |
| `sandore/step-completed` | `stepId`, `childId`, `output: ContentBlock[]`, `name`, `loopIteration?` |
| `sandore/step-failed` | `stepId`, `childId`, `error`, `name`, `loopIteration?` |
| `sandore/step-paused` | `stepId`, `childId`, `name`, `loopIteration?` |
| `sandore/step-resumed` | `stepId`, `childId`, `resumePrompt?`, `name`, `loopIteration?` |
| `sandore/step-retried` | `stepId`, `mode`, `name`, `loopIteration?` |
| `sandore/question` | `question: PendingQuestionEntry` |
| `sandore/permission` | `permission: PendingPermissionEntry` |
| `sandore/end` | `taskId`, `jobId`, `result: DagResultInfo` |
| `sandore/aborted` | `taskId` |

- 事件由引擎 `workflow-engine.ts` 双发：`emitContained('sandore/step-completed', [...])`（Cordis）+ `session.append('sandore/step-completed', { stepId, childId, output, name, ... })`（宿主 Session append）。见 `workflow-engine.ts:944-965`。
- **`output: ContentBlock[]` 来源**：`packages/sandore/microflow/src/subagents.ts` 的 `finalAssistantOutput(events)`——取子代理最后一条非空 `assistant/message` 的 `message.content`（后写覆盖），否则累积 `assistant/chunk` 的 `text-delta`；返回 `ContentBlock[]`（`{ type: 'text', text }` 等）。`step-runner.ts:545` 调用之，把「子代理最终结果」塞进 step-completed payload，绕开跨会话读 snapshot（`binding(childId)` 需子会话窗口 open，不可靠——与 design.md §5.3.1 一致）。
- `loopIteration?: number[]` 为扁平迭代路径（如 `[1, 2]`）。
- `ContentBlock` 类型来自 `@deepseek-ai/dsh-llm`；`textSummary()`（`microflow/src/internal.ts`）按 `block.type === 'text'` 过滤拼接纯文本。

---

## 六、内联消息渲染（Phase 3 + 4）

### 6.1 primitives 可 import 的渲染基元

位置：`packages/client/ui-primitives/src/index.ts`

- **`MarkdownText`**（`markdown/MarkdownText.tsx`）：非可信 assistant Markdown 渲染器，GFM + KaTeX；props `{ text, streaming?, codeLabels?, fileMentions? }`；流式期间增量解析、冻结前块缓存。settled 时 `renderSettled(text, ...)`。
- **`MessageText`**（`markdown/MessageText.tsx`）：字面文本基元，props `{ text }`，用于 user/steering 内容。
- 其它可 import：`StateDot`、`DisclosureRow`、`Button`、`Pill`、`Input`、`Menu`、`Modal`、`Tooltip`、`Toast`、`JsonBlock`、`CodeBlock`、`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`、`extractMarkdownPlainText`、icons（`IconChevronRightOutline14` 等）。

### 6.2 照抄对象（ui-conversation 内部，不可跨插件 import，需自绘同款）

- **`AssistantMarkdown.tsx`**（约 111 行）：按 `AssistantBlock[]` 顺序渲染——`text` → `MarkdownText`；`reasoning` → `ReasoningRow`（展开缩进灰字）；`image` → `ImageGallery`；`tool-call` 头不在此渲染（由 chat view 分组进 tool 行）；未知块 → `JsonBlock`。
- **`UserStyleBubble`**（`MessageItem.tsx:179`，约 100 行）：右对齐气泡，`contentParts` 拆分 text/images/rest，`MessageText` 渲染文本 + `ImageGallery` + `JsonBlock` 渲染额外块，`actions` 接收拼接文本（IconActions 行）。
- **`ToolCallTree`**（`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx`，约 105 行）：根 Tool call + 递归子调用经同一 keyed 原子派发 `renderSlot('tool.call.toolview', owner, { entryKey: toolName, fallback: <GenericToolCard/> })`。

### 6.3 渲染器 props 形状（keyed chat node）

- `ChatNodeViewProps<Kind> = PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'conversation'>`（`slots.ts`）。
- `PropsRuntime` 提供 `node`（含 `node.data` 业务 payload、`node.location`、`node.anchorSeq`）、`sessionId`、`useSession`、`useSessions` 等；`PropsLocale` 提供 `t`。

---

## 七、sandore 现状与缺口（Phase 4 补充，事实记录）

### 7.1 sandore `ui` 包当前入口

位置：`packages/sandore/ui/src/client/index.ts`

```ts
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries')
  ctx.effect(() => ctx.remote.$mount(sandoreRemote), 'ui-sandore: remote')
  // ... WorkflowButtonFace 组装
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'sandore-btn', locale: NS,
    inject: (): WorkflowButtonFace => sandore,
  }, WorkflowButton))
}
```

事实：当前**只注册了 `sidebar.footer.action` 工作流入口按钮**；**没有** `conversation.chat.node` 的 `sandore-step` keyed 渲染器、**没有** `ConversationNodeDefinition`、**没有** `DagStepNodeView.tsx`。

### 7.2 相对范本的缺口（事实）

1. `inject` 数组缺 **`conversationEvents`**（范本 `ui-workflow-run` 为 `['conversationEvents', 'slots', 'sessions', 'locale']`）。
2. `package.json` 的 `dsh.client.inject` 缺 **`@deepseek-ai/dsh-client-ui-conversation`**（`conversation.chat.node` 插槽类型声明与 `ChatNodeDataMap` merge 需要）；`peerDependencies` 同样未声明该包。
3. `package.json` 的 `scripts` 只有 `typecheck`，无 `bundle`/`build`；`exports` 已有 `./client`（`lib/client.js`）。
4. 现有 `open-discussion.ts` 已实现 `createOpenDiscussion(sessions, instanceId)` → `sessions.open(instanceId as SessionId)`（宿主 Session id == instanceId），作为 RunView「打开讨论」按钮 adapter；这是与 `ui-workflow-run` 的 `openSession` 同款的跳转动作，但跳的是宿主会话（`sandore-step` 节点所在 chat 视图）。

### 7.3 关键契约文件清单（绝对路径）

- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\index.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\workflow-definition.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\WorkflowRunPanel.tsx`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\locales.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\contract\conversation.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\conversation\event-registry.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\sessions\conversation-assembler.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-conversation\src\client\contract\slots.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-conversation\src\client\contract\chat-nodes.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-conversation\src\client\chat\ChatNodeSeat.tsx`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-conversation\src\client\chat\register-node-renderers.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-conversation\src\client\chat\AssistantMarkdown.tsx`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-conversation\src\client\chat\MessageItem.tsx`（`UserStyleBubble`）
- `D:\project-code\llm\deepseek-harness\packages\client\ui-tool\src\client\tool\ToolCallTree.tsx`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-primitives\src\index.ts`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-primitives\src\markdown\MarkdownText.tsx`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-primitives\src\markdown\MessageText.tsx`
- `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\types.ts`
- `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\types.ts`
- `D:\project-code\llm\deepseek-harness\packages\core\session\src\types.ts`（`SessionEvent` / `SessionEventMap`）
- `D:\project-code\llm\sandore\packages\sandore\workflow\src\seam.ts`（`sandore/*` 事件双声明）
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\subagents.ts`（`finalAssistantOutput`）
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\step-runner.ts`（`output: ContentBlock[]`）
- `D:\project-code\llm\sandore\packages\sandore\microflow\src\internal.ts`（`textSummary`）
- `D:\project-code\llm\sandore\packages\sandore\ui\src\client\index.ts`（当前入口）
- `D:\project-code\llm\sandore\packages\sandore\ui\src\client\open-discussion.ts`（打开讨论 adapter）
- `D:\project-code\llm\sandore\packages\sandore\ui\package.json`
