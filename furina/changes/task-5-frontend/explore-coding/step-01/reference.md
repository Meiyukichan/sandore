## Exploration Result

> 说明：`furina config show exploration.reference` 返回空数组 `[]`，无预配置参考目录/技能/URL。以下结果为对本地 DSH 仓库（`D:/project-code/llm/deepseek-harness`）中「ui-workflow-run 三件套」及其依赖契约的直接探索，并对照 sandore 侧已有的设计/规格（`D:/project-code/llm/sandore`）。
>
> 参考实现根：`deepseek-harness/packages/client/ui-workflow-run/`（下述 DSH 仓库内路径均相对此根 `D:/project-code/llm/deepseek-harness`）。

### 1. ui-workflow-run 三件套源码（文件清单与职责）

包根 `packages/client/ui-workflow-run/`（包名 `@deepseek-ai/dsh-client-ui-workflow-run`）：

| 文件 | 职责 |
| --- | --- |
| `package.json` | `dsh.client` 声明：`{ inject: ['@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-runtime','@deepseek-ai/dsh-client-ui-conversation'], platform: 'web' }`；`exports["./client"]` 指向浏览器 bundle；peerDependencies 含 `dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-session`、`dsh-tool-workflow`、`dsh-workflow`、`cordis`（react 为唯一 dependency）。 |
| `src/index.ts` | node 半（host）空壳：`export function apply(): void {}`。 |
| `src/client/index.ts` | 浏览器半 `apply(ctx)`，三件事（即「三件套」的装配）：① `ctx.conversationEvents.register(workflowRunDefinition)`；② `ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflow-run: dictionaries')`；③ `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'workflow-run', locale: NS, inject: (): WorkflowRunInjected => ({ openSession: (id: SessionId) => { ctx.sessions.open(id) } }) }, WorkflowRunPanel))`。`export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']`。 |
| `src/client/workflow-definition.ts` | `workflowRunDefinition: ConversationNodeDefinition<WorkflowState>`（kind='workflow-run', target='chat'）+ `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData } }`。 |
| `src/client/WorkflowRunPanel.tsx` | keyed 渲染器组件；`WorkflowRunPanelProps = PropsRuntime<'conversation.chat.node', 'workflow-run'> & PropsLocale<'workflowRun'> & WorkflowRunInjected`；`WorkflowRunInjected = { openSession(id: SessionId): void }`。 |
| `src/client/locales.ts` | `NS = 'workflowRun'`；`zh`（key 集源头）+ `en satisfies Record<WorkflowRunKey, string>`；`WorkflowRunKey = keyof typeof zh`；`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { workflowRun: WorkflowRunKey } }`。 |
| `src/client/WorkflowRunPanel.module.css` | css-modules 样式。 |
| `tests/workflow-run.client.spec.tsx` | 三件套的客户端测试。 |

### 2. ConversationNodeDefinition 契约

来源：`packages/client/runtime/src/client/contract/conversation.ts`（`@deepseek-ai/dsh-client-runtime/client` 导出）。

核心接口：

```ts
interface ConversationMatchResult { id: string; role: 'start' | 'update' }
interface ConversationEventInput { event: SessionEvent; view: ToolEventView | undefined }
interface ConversationMatch extends ConversationEventInput { role: 'start' | 'update'; location: ConversationLocation }

type ConversationLocation =
  | { kind: 'session' } | { kind: 'turn'; turn: TurnLocation }
  | { kind: 'step'; turn: TurnLocation; step: StepLocation } | { kind: 'unresolved' }

interface ConversationViewNode { key: string; kind: string; id: string; target: string; data: unknown }
interface ChatConversationViewNode extends ConversationViewNode {
  target: 'chat'; anchorSeq: number; location: ConversationLocation; visibility: 'visible' | 'hidden'
}

interface ConversationNodeContext<State = unknown> {
  key: string; kind: string; id: string
  matches: readonly ConversationMatch[]
  start: ConversationMatch | undefined
  state: State | undefined
  current: ReadonlyMap<string, ConversationViewNode | null>
}
interface ConversationContextReader { previous<State>(kind: string): ConversationPreviousContext<State> | undefined }

interface ConversationNodeDefinition<State = unknown> {
  kind: string
  target?: string                                    // 声明即该定义拥有的唯一 view target
  match(event: SessionEvent): ConversationMatchResult | null   // 只读原始事件，无 context/history 访问
  start(context, match, reader): State
  update(context & { state: State }, match): State
  publication?(match): 'none' | 'animation-frame' | 'immediate'
  buildLocationData?(context, scope: 'step' | 'turn'): ConversationLocationData | null
  buildViewNode?(context): ConversationViewNode | null
}

function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`   // engine 拥有的事件折叠 key（同 kind + 同 id → 同一节点）
}
```

关键约定（实现层强制）：

- `target` 与 `buildViewNode` 必须成对声明（`event-registry.ts` 的 `assertDefinitionTarget` 校验二者「同有同无」）。
- 同一 `conversationContextKey` 只能有一个 `start`（重复 start 抛错）；`update` 必须先于 `start` 存在（否则抛错）；matches 必须按 `event.seq` 升序追加（`conversation-assembler.ts` 的 `acceptMatch` 校验）。
- `buildViewNode` 返回的 `node.key` 必须等于 `context.key`，`node.target` 必须等于声明 target；不能从「可见」变为 `null`（须改为返回同 key 但 `visibility: 'hidden'`）——`conversation-assembler.ts` 的 `buildNode` 校验。
- `match` 是纯函数（只拿 `SessionEvent`），通过返回 `{ id, role }` 决定「把哪个事件折叠进哪个节点」。

折叠引擎：`packages/client/runtime/src/client/sessions/conversation-assembler.ts`（`ConversationNodeAssembler`）。按 seq 排序事件窗口，`dispatchInput` 遍历所有 Definition 的 `match`，`acceptMatch` 以 `conversationContextKey(kind, id)` 建立/更新 Context：`role='start'` 调 `definition.start(...)` 建 state，`role='update'` 调 `definition.update(...)` 折叠；`flush()` 时按 target 分组调 `buildViewNode` 物化节点并推进 view builder（replace / incremental apply）。支持 `replaceWindow`（首载/重同步）、`append`（实时尾部）、`prepend`（向前翻页），三者回放得到一致 state。

注册入口：`packages/client/runtime/src/client/conversation/event-registry.ts`（`ConversationEventRegistry`）。`register(definition)` 返回 disposer；重复 kind 抛错；另有 `registerFallback`（仅当无普通 Definition 匹配时用于兜底，须声明 target）。

### 3. conversation.chat.node keyed 插槽

声明来源：`packages/client/ui-conversation/src/client/contract/slots.ts`：

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

- `ChatNodeOwnerProps`（owner 公共于所有 key）：`{ selectedCallId?, cwd?, openFile, inspectCall, forkAt, loadImage, fileMentions }`。
- `ChatNodeKind = Extract<keyof ChatNodeDataMap, string>`；`ChatNode<Kind> = ChatConversationViewNode & { kind: Kind; data: ChatNodeDataMap[Kind] }`（来源 `chat-nodes.ts`）。
- `ChatNodeDataMap` 为空 `interface {}`，通过 `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { ... } }` 声明合并扩展（ui-workflow-run 声明 `'workflow-run'`；ui-conversation 自身在 `conversation-nodes/*.ts` 声明 `user`/`assistant-step`/`tool`/`turn-tail` 等）。
- 组件 props：`ChatNodeViewProps<Kind> = PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'conversation'>`。

分派点：`packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`。每个节点一行，`renderSlot('conversation.chat.node', routedOwner, { entryKey: routedNode.kind, hookContext: nodeKey, fallback: <JsonBlock label={...} payload={routedNode.data} /> })`，其中 `routedOwner = { ...owner, node: routedNode }`。`entryKey = node.kind`（keyed 分派键），未注册 kind 时落到 fallback（JsonBlock 展示未知节点）。

注册范式：`packages/client/ui-conversation/src/client/chat/register-node-renderers.ts`——内置 12 个 key（`user`/`steering`/`context`/`assistant-step`/`command`/`manual-compaction`/`compaction`/`model-retry`/`turn-error`/`turn-max-tokens`/`turn-tail`/`unknown`），形式统一为 `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'user', locale: NS }, UserMessageNodeView))`。

`PropsRuntime` 机制（`packages/client/ui-slots/src/index.ts` L211）：

```ts
type PropsRuntime<K, EntryKey> =
  OwnerOf<K> & KeyPropsOf<K, EntryKey> & SlotInjectFace<SlotInjectOf<K>>
  & (ScopeOf<K> extends 'session' ? SessionStandardProps : ...) & GlobalStandardProps
```

- `KeyPropsOf<'conversation.chat.node', 'workflow-run'>` = `{ node: ChatNode<'workflow-run'> }` → 渲染器拿到 `node.data` 已类型化为 `ChatNodeDataMap['workflow-run']`。
- `SlotInjectFace` 绑定注册时 `inject: () => ({ openSession })` 提供的业务 face（函数型 hooks 成员会被绑定）。
- `SessionStandardProps`（session scope）由 runtime merge，含 `sessionId` 与 `useSession`（conversation snapshot selector，`useSessions` 同族）。

### 4. 事件 payload

`SessionEvent` 信封（`packages/core/session/src/types.ts` L404）：

```ts
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  type: T
  seq: number        // session 内单调序号
  time: number       // Unix epoch ms
  data: SessionEventMap[T]
  ignorable?: true
} & (T extends SurfaceEventType ? { sourceEventSeqs?: number[]; surfaceOp?: SurfaceOp } : object)
```

`SessionEventMap`（同文件 L236）是 merge-extensible interface，业务包通过 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'xxx': Payload } }` 声明合并扩展事件词汇。

ui-workflow-run 折叠的 4 个事件 payload（`packages/workflow/tool-workflow/src/types.ts`）：

```ts
interface ToolWorkflowRunStartData  { runId: WorkflowRunId; name: string }
interface ToolWorkflowAgentStartData { runId; seq: number; label: string; phase?: string; childId: SessionId }
interface ToolWorkflowAgentEndData   { runId; seq: number; outcome: WorkflowAgentOutcome }
interface ToolWorkflowRunEndData     { runId; stopReason: WorkflowStopReason }
```

配套类型（`packages/workflow/workflow/src/types.ts`）：`WorkflowStopReason = 'completed' | 'cancelled' | 'error'`；`WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'`；`WorkflowRunId = Branded<'WorkflowRunId'>`。

发射范式（`packages/workflow/tool-workflow/src/index.ts` 的 `createWorkflowRecorder`）——这是 sandore-step 必须照抄的「事件从哪来」范式：

- 先用 `ctx.on('workflow/agent-start', (info, agent) => { ... })` 等 Cordis 事件作**触发源**；
- 再 `session.append('tool-workflow/agent-start', data)` 把事件**append 成宿主 Session 的 log-only Session 事件**（带 seq/time），供 `ConversationNodeDefinition.match` 折叠。

即：`ConversationNodeDefinition.match(event)` 折叠的是 append 到 log 的 Session 事件（含 `seq`/`time`），不是 `ctx.emit` 的进程内事件。

子代理最终结果的选择助手（sandore-step 的 `step-completed` payload 需要内联结果）：`packages/subagent/subagent/src/assistant-output.ts` 的 `finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined`——选最后一条非空 `assistant/message`（`event.data.message.content`），否则累计 `assistant/chunk` 的 `text-delta` 文本；两者皆无返回 `undefined`。同文件 `AssistantOutputFold` 是其流式增量 fold 形式（`subagent/end` 事件的 `lastAssistantMessage` 与 `SubagentResult.output` 均用此规则）。

sandore 侧对应（已有设计/规格，非本次产出）：

- `dsh-workflow.md` §5.1 已声明 `sandore/*` 事件词汇（`sandore/start`/`stage-start`/`stage-completed`/`step-start`/`step-completed`/`step-failed`/`step-paused`/`step-resumed`/`step-retried`/`question`/`permission`/`end`/`aborted`），`step-*` payload 含 `(info, stepId, childId, name, ..., loopIteration?)`。
- §5.5 明确 `sandore/*` 是 **log-only Session 事件**（`session.append('sandore/…', data)`），声明合并进 `SessionEventMap`，经 apiproxy `session/event` 帧透传前端——这是 D8「讨论面板复用 ConversationNodeDefinition」成立的前提。
- §6.4 明确 `step-completed` 事件 payload 需**在宿主侧**把「子代理最终结果」塞进去（`ctx.sessions.get(childId)` + `finalAssistantOutput(childSession.events)`），renderer 从 `sandore-step` 节点 state 取结果（绕开客户端跨会话读 snapshot 的不可靠路径）。

### 5. 内联消息渲染（薄胶水，可 import / 照抄）

sandore 设计文档 §6.4 指定的三个照抄目标（DSH 仓库内实际位置与行数规模）：

1. `AssistantMarkdown.tsx`（`packages/client/ui-conversation/src/client/chat/AssistantMarkdown.tsx`，约 110 行）：props `{ blocks: AssistantBlock[]; streaming; interrupted?; loadImage?; mentions?; t }`。循环 block：`text` → `<MarkdownText text streaming codeLabels fileMentions/>`；`reasoning` → `<ReasoningRow/>`；`image` → `<ImageGallery/>`（连续 image 合并为一个 gallery）；`tool-call` 跳过（ChatView 已分组进 tool row）；default → `<JsonBlock/>`。`hasVisible` 判定：纯 tool-call 或空 blocks 时不渲染外壳（避免空根节点）。`MarkdownText`/`JsonBlock` 来自 `@deepseek-ai/dsh-client-ui-primitives`（可 import）。
2. `UserStyleBubble`（`packages/client/ui-conversation/src/client/chat/MessageItem.tsx` L179 起，约 100 行）：右对齐气泡；`projectUserText(text)` 用 `MessageText` 渲染正文并对 `/@name` 词边界 token 加 `refChip` 装饰；`ImageGallery`（align=end）+ `JsonBlock` 渲染剩余块；`UserMessageNodeView`/`PendingSteeringBubble` 复用。注意 `MessageText`/`JsonBlock` 均来自 primitives。
3. `ToolCallTree.tsx`（`packages/client/ui-tool/src/client/tool/ToolCallTree.tsx`，约 105 行）：`ToolCallBranch` 递归渲染 root + `subCalls`；每个 call 经 `renderSlot('tool.call.toolview', owner, { entryKey: toolName, fallback: <GenericToolCard/> })` 分派；工具名 `callName(node) = 'kind' in node ? node.call?.name ?? '' : node.name`。

可 import 的 primitives（`@deepseek-ai/dsh-client-ui-primitives`）：`MarkdownText`（`MarkdownCodeLabels`/`MarkdownFileMentions`）、`MessageText`、`JsonBlock`、`CodeBlock`、`StateDot`（`StateDotState = 'done' | 'warning' | 'ongoing' | 'error'`）、`DisclosureRow`、`Button`、`Pill`、`Modal`、图标集（`IconChevronRightOutline14` 等）。sandore ui 已将 `@deepseek-ai/dsh-client-ui-primitives` 列为 peerDependency。

### 6. ui-conversation 自身的 Definition 范式（补充参考）

`packages/client/ui-conversation/src/client/conversation-nodes/` 是 ui-conversation 自己的 `ConversationNodeDefinition` 集合（`register.ts` 统一 `ctx.conversationEvents.register(...)`），是比 ui-workflow-run 更「贴近普通消息」的第二参考：

- `common.ts` 的 `chatNode(context, kind, anchorSeq, data, options?)`：构造最终 `ChatNode<Kind>`（`key=context.key`、`target='chat'`、`anchorSeq`、`location`（默认 `contextLocation(context)`）、`visibility`、`data`）；`contextLocation(context) = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }`。
- `message.ts`（`messageDefinition`，kind='input-message'）：`match` 命中 `user/message`（append 表面事件、非 compaction checkpoint），`id = String(event.data.id)`；`start` 里用 `reader.previous<InboxState>('inbox-next-step')` 判定 user/steering/context 三种 kind；`buildViewNode` 调 `chatNode(...)`。展示了「一个 Definition 的 start 依据前序 Context 分支产出不同 render kind」的用法。
- `assistant.ts`（`assistantDefinition`，kind='assistant-step'）：`match` 以 `step/start` 为 start（`id = turn:step`），`assistant/chunk`/`assistant/message`/`llm/retry` 为 update；`publication` 按事件类型分级（step/start→none，usage/finish→none，其余 chunk→animation-frame，assistant/message→immediate）；`buildLocationData` 发布 step 级 `AssistantChatData`；`buildViewNode` 产出 running/settled/interrupted 节点。展示了「流式折叠 + publication 节奏控制 + Location data 发布」的完整范式。

### 7. sandore 侧既有规格（现状记录，非方案）

`sandore` 仓库 `furina/changes/task-5-frontend/specs/sandore-step-node/spec.md` 已定义讨论节点三件套需求（如实摘录要点）：

- `ConversationNodeDefinition`：`kind: 'sandore-step'`、`target: 'chat'`；`match` 命中 `sandore/step-start|step-completed|step-failed|step-paused|step-resumed|step-retried`；`start`/`update` 折叠 state `{stepId, childId, name, status, loopIteration?, output?, error?}`；同一 `stepId` 的循环多次迭代由 `stepId` + `loopIteration` 派生独立节点 id。
- keyed 渲染器三件套：① `ctx.conversationEvents.register(sandoreStepDefinition)`（inject 含 `'conversationEvents'`）；② `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name, key: 'sandore-step', locale: NS, inject: () => ({ openSession: (id) => ctx.sessions.open(id) }) }, DagStepNodeView))`；③ `declare module ... { interface ChatNodeDataMap { 'sandore-step': DagStepChatData } }`。
- 渲染规则：running=状态徽章+名称（无结果）；completed=内联 `step-completed` payload 的 `output: ContentBlock[]`（`MessageText`/`MarkdownText` 薄胶水）；failed=红框语义+error；paused=琥珀语义+会话快照提示；显示 `name` 与循环迭代标签（`#1.2` 形态）。
- 点击 `openSession(childId)` 跳子会话；failed/completed 节点提供「重试」控件（continue/revert/fork + 必填 `message`，经 `ctx.remote.sandore.retryStep({instanceId, stepId, mode, message})`，instanceId == 节点所在宿主 Session id）。

## Supplementary Exploration Result

- 配置：`experimental.websearch=true`、`experimental.context7=true`。
- 本地参考（deepseek-harness 仓库的 `ui-workflow-run` 包 + `runtime`/`ui-conversation`/`ui-slots`/`ui-tool`/`session`/`tool-workflow`/`workflow`/`subagent` 契约源码 + sandore 仓库的设计/规格）已完整覆盖需求理解（三件套源码、ConversationNodeDefinition 契约、chat.node keyed 插槽、事件 payload 与发射范式、内联消息渲染薄胶水、sandore 侧既有规格），Phase 3 信息充足，未触发额外 websearch / context7 查询。
