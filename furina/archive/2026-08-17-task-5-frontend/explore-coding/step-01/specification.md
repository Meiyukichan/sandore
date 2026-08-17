# sandore-step 讨论节点三件套 — 参考实现探索（specification）

## 探索内容理解

- **What**：为 sandore 的 6 个 `sandore/step-*` Session 事件注册一个折叠式「讨论节点三件套」——即 DSH 的 `ConversationNodeDefinition`（`kind: 'sandore-step'`、`target: 'chat'`）+ keyed 渲染器（`conversation.chat.node`）+ `ChatNodeDataMap` 类型声明，使宿主 Session 聊天流内折叠出一个 `sandore-step` 节点（含状态/内联结果/重试/跳转子会话）。本次探索只考察**参考实现与既有契约**（`ui-workflow-run` 三件套源码、`ConversationNodeDefinition` 契约、`chat.node` keyed 插槽、事件 payload、内联消息渲染），不涉及方案或实现。
- **Boundaries**：
  - DSH 参考仓库 `D:/project-code/llm/deepseek-harness`：`packages/client/ui-workflow-run`（三件套参考源码）、`packages/client/ui-conversation`（`chat.node` keyed 插槽 + `ChatNodeDataMap`）、`packages/client/runtime`（`ConversationNodeDefinition` 契约 + `conversationEvents` 服务 + assembler 管线）、`packages/client/ui-slots`（`PropsRuntime`/`PropsLocale` 组合类型）、`packages/client/ui-primitives`（`MessageText`/`MarkdownText`）、`packages/llm/llm`（`ContentBlock`）、`packages/core/session`（`SessionEvent`/`SessionEventMap`）。
  - sandore 仓库 `D:/project-code/llm/sandore`：`packages/sandore/workflow/src/seam.ts`（step-* 事件双声明）、`packages/sandore/ui`（当前插件 inject/peerDep 现状）。
- **Goal**：拿到**确切（非臆测）**的契约类型、三件套注册范式、keyed 分派机制、事件 payload 形状与内联渲染胶水，供 `sandore-step` 节点三件套对照真实类型实现。

> 说明：`furina config show exploration.specification` 返回空数组 `[]`。本次「规范材料」即上述本地参考源码（deepseek-harness 仓库 + sandore 仓库现有代码）。事件 payload 侧可交叉参考本目录下既有 `event-01/specification.md`（本文第 4 节以当前工作区为准，因 `name`/`loopIteration` 已在工作区落地）。

---

## 1. 参考实现三件套源码（ui-workflow-run）

参考插件：`@deepseek-ai/dsh-client-ui-workflow-run`，位于 `D:/project-code/llm/deepseek-harness/packages/client/ui-workflow-run/src/client/`。共 4 个源码文件 + 1 个 node 半入口。

### 1.1 三件套注册（`src/client/index.ts`，全文件 32 行）

```ts
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'   // ← 拉取 ChatNodeDataMap 类型增强
import { WorkflowRunPanel, type WorkflowRunInjected } from './WorkflowRunPanel.tsx'
import { en, NS, type WorkflowRunKey, zh } from './locales.ts'
import { workflowRunDefinition } from './workflow-definition.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    workflowRun: WorkflowRunKey
  }
}

export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(workflowRunDefinition)                 // 三件套①：Definition
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflow-run: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({   // 三件套②：keyed 渲染器
    name: 'conversation.chat.node',
    key: 'workflow-run',
    locale: NS,
    inject: (): WorkflowRunInjected => ({
      openSession: (id: SessionId) => { ctx.sessions.open(id) },
    }),
  }, WorkflowRunPanel))
}
```

三件套③是 `workflow-definition.ts` 内的模块增强：

```ts
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'workflow-run': WorkflowRunChatData
  }
}
```

关键点：
- `inject` 需 `'conversationEvents'`（Definition 注册）、`'slots'`（渲染器注册）、`'sessions'`（跳转）、`'locale'`（字典）。
- `apply` 顺序：先注册 Definition，再注册字典，最后 `slots.inject` keyed 渲染器。
- keyed 渲染器注册用 `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({...}, Component))`；`register` 的第二参是组件，第一参 options 含 `name`/`key`/`locale`/`inject`。
- `inject` 工厂返回业务 face（`WorkflowRunInjected = { openSession }`），组件侧以 `InjectFace<...>` 收。

### 1.2 node 半入口（`src/index.ts`）

```ts
/** Host plugin body; the feature is entirely browser-side. */
export function apply(): void {}
```

即该插件的 node 半是空 `apply`，全部逻辑在 `./client`。

### 1.3 包元数据（`package.json`）

- `exports`：`"."`、`"./client"`、`"./invariant"`、`"./src/*"`、`"./package.json"`（与 sandore ui 包同构）。
- `dsh.client.inject` = `['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation']`，`platform: 'web'`。
- `peerDependencies` 含 `dsh-client-runtime`、`dsh-client-ui-conversation`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-session`、`dsh-tool-workflow`、`dsh-workflow`、`cordis` 等。

---

## 2. ConversationNodeDefinition 契约

来源：`@deepseek-ai/dsh-client-runtime/client`（实际文件 `packages/client/runtime/src/client/contract/conversation.ts` L171-228，经 `runtime/src/client/index.ts` 的 `export type` 再导出）。

### 2.1 接口定义（L171-228）

```ts
export interface ConversationNodeDefinition<State = unknown> {
  readonly kind: string
  /** Sole view target owned by this Definition; omitted for state-only Contexts. */
  readonly target?: string
  match(event: SessionEvent): ConversationMatchResult | null
  start(
    context: ConversationNodeContext<State>,
    match: ConversationMatch,
    reader: ConversationContextReader,
  ): State
  update(
    context: ConversationNodeContext<State> & { readonly state: State },
    match: ConversationMatch,
  ): State
  publication?(match: ConversationMatch): ConversationPublication
  buildLocationData?(
    context: ConversationNodeContext<State>,
    scope: ConversationLocationDataScope,
  ): ConversationLocationData | null
  buildViewNode?(context: ConversationNodeContext<State>): ConversationViewNode | null
}
```

- `match(event)`：从单个原始 `SessionEvent` 提取稳定业务身份，返回 `{ id: string; role: 'start' | 'update' }` 或 `null`（不相关）。**无 Context/历史访问**。
- `start`：从唯一 start Match 创建 `State`；`reader.previous(kind)` 可做严格后向的 Context 查找。
- `update`：按日志升序对每个 update Match 应用到 `state`。
- `publication`：可选，返回发布节奏 `'none' | 'animation-frame' | 'immediate'`，缺省 immediate。
- `buildViewNode`：把最新 Context 物化为最终 `ChatConversationViewNode`，返回 null 表示当前不可见。
- 约束（`event-registry.ts` L61-67 `assertDefinitionTarget`）：`target` 与 `buildViewNode` **必须成对声明**（要么都有，要么都没有）。

### 2.2 相关类型（同文件）

- `ConversationMatchResult = { id: string; role: 'start' | 'update' }`（L15-18）。
- `ConversationMatch = ConversationEventInput & { role; location: ConversationLocation }`（L99-102），其中 `ConversationEventInput = { event: SessionEvent; view: ToolEventView | undefined }`。
- `ConversationLocation = { kind:'session' } | { kind:'turn'; turn } | { kind:'step'; turn; step } | { kind:'unresolved' }`（L92-96）。
- `ConversationNodeContext<State>`（L133-141）：`{ key; kind; id; matches; start; state; current: ReadonlyMap<string, ConversationViewNode | null> }`。
- `ChatConversationViewNode`（L125-130）= `ConversationViewNode`（`{ key; kind; id; target; data }`）+ `{ target:'chat'; anchorSeq: number; location: ConversationLocation; visibility: 'visible' | 'hidden' }`。
- `ConversationPublication = 'none' | 'animation-frame' | 'immediate'`（L165）。
- `conversationContextKey(kind, id)`（L272-274）= `` `${kind.length}:${kind}${id}` ``——引擎侧的 Context key，`buildViewNode` 返回的 `node.key` **必须等于** `context.key`（见 2.3）。

### 2.3 引擎装配管线（`runtime/src/client/sessions/conversation-assembler.ts`）

- 事件按 `seq` 升序，逐一定义调用 `definition.match(input.event)`（L371）；非 null 命中则 `acceptMatch`。
- `acceptMatch`（L387-447）：
  - `key = conversationContextKey(kind, id)`；同一 key 出现第二个 `start` 会 throw（L395-397）；`start` 前出现 `update` 也会 throw（L424-426）。
  - start 时记 `startSeq`/`start` 并 `replayContext`；update 时 `context.state = definition.update(typed, match)`（L441）。
  - 每次命中 `definition.publication?.(match) ?? 'immediate'` 决定刷新节奏。
- `buildNode`（L707-718）：调用 `definition.buildViewNode(contextSnapshot(context))`，并校验返回的 `node.key === context.key`、`node.target === target`，不匹配即 throw。一旦某 Context 曾产出过非 null 节点，后续不得回退为 null（否则 throw，L296-300，提示「用同 key + hidden visibility 替代撤回」）。
- 未命中任何普通 Definition 的事件才落到 `registerFallback` 的 fallback（`dispatchInput` L376-383）。

### 2.4 `conversationEvents` 服务

- 类型：`ConversationEventRegistry extends ConversationDefinitionRegistry<ConversationNodeDefinition>`（`runtime/src/client/conversation/event-registry.ts`）。
- `register(definition)`：按 `kind` 唯一注册，重复 throw；返回幂等 disposer；内部走 `registerDefinition`（`definition-registry.ts` L35-53，用 `ctx.effect` 绑定注册者 fiber 生命周期）。
- 服务暴露：`ConversationEventRegistry` 是 cordis `Service`（`super(ctx, 'conversationEvents')`），在 runtime `apply` 内实例化，通过 `rootCtx.get('conversationEvents')` 注入 `SessionRuntime`（`sessions/service.ts` L288-293）。
- Context 类型增强（`runtime/src/client/index.ts` L170-172）：
  ```ts
  declare module '@deepseek-ai/cordis' {
    interface Context {
      slots: import('./slots.ts').SlotRegistry
      conversationEvents: import('./conversation/event-registry.ts').ConversationEventRegistry
      conversationViews: import('./conversation/view-registry.ts').ConversationViewRegistry
      sessions: import('./contract/sessions.ts').ISessions
      workspaces: import('./contract/workspaces.ts').IWorkspaces
    }
  }
  ```
- `ClientContext` 就是 `Context`（`runtime/src/client/index.ts` L112 `export type ClientContext = Context`）。

---

## 3. chat.node keyed 插槽

### 3.1 SlotMap 声明（`ui-conversation/src/client/contract/slots.ts` L78-85）

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

- `kind: 'keyed'`：按 key 分派；`EntryKeyOf`/`KeyPropsOf`（`ui-slots/src/index.ts` L152-165）从 `keyProps` 推导，`keyProps` 的键域即 `ChatNodeKind`。
- `owner`（`ChatNodeOwnerProps`，slots.ts L356-367）：`{ selectedCallId?; cwd?; openFile; inspectCall; forkAt; loadImage; fileMentions }`。
- `hookContext: string`：每个 renderSlot 发生点携带的 `nodeKey`（Context key），供注入 hook 使用。
- `inject`（`ChatNodeTurnDataInjected`，L349-353）：`{ hooks: { turnData: SlotHookFactory<'conversation.chat.node', UseChatNodeTurnData> } }`——`apply.ts` L78-89 实现为按 `nodeKey` 读 `snapshot.chat.nodes.get(nodeKey)?.location` 的 `turn.data`。
- 组合 props 类型（`ChatNodeViewProps<Kind>`，L370-371）= `PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'conversation'>`；但**参考实现 ui-workflow-run 用自己的 locale 命名空间**，即 `PropsRuntime<'conversation.chat.node', 'workflow-run'> & PropsLocale<'workflowRun'> & WorkflowRunInjected`——说明 keyed 节点的 `locale` 席位由**注册方自己的 `locale` 字段**决定（不强制 `'conversation'`）。

### 3.2 分派点（`ui-conversation/src/client/chat/ChatNodeSeat.tsx` L48-58）

```tsx
{renderSlot('conversation.chat.node', routedOwner, {
  entryKey: routedNode.kind,
  hookContext: nodeKey,
  fallback: <JsonBlock label={t('message.unknownSurface', { type: routedNode.kind })}
                     payload={routedNode.data} ... />,
})}
```

- 每个稳定 `nodeKey`（Context key）一个 `ChatNodeSeat`，从 `snapshot.chat.nodes.get(nodeKey)` 订阅节点。
- `entryKey = routedNode.kind` 是 keyed 分派的判别元；未注册该 kind 时落到 `fallback`（`JsonBlock` 渲染 `message.unknownSurface`）。

### 3.3 内置渲染器注册（`chat/register-node-renderers.ts`）

`registerChatNodeRenderers(ctx)` 用完全相同的 `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name, key, locale: NS, ... }, Component))` 注册 `user`/`steering`/`context`/`assistant-step`/`command`/`manual-compaction`/`compaction`/`model-retry`/`turn-error`/`turn-max-tokens`/`turn-tail`/`unknown` 等内置 kind（`command`/`turn-tail` 还声明了 `children` 子槽）。

### 3.4 ChatNodeDataMap 与派生的 ChatNode/ChatNodeKind（`contract/chat-nodes.ts`）

```ts
export interface ChatNodeDataMap {}                    // 空接口，业务包通过 declaration-merge 扩展
export type ChatNodeKind = Extract<keyof ChatNodeDataMap, string>
export type ChatNode<Kind extends ChatNodeKind = ChatNodeKind> = {
  [RegisteredKind in Kind]: ChatConversationViewNode & {
    readonly kind: RegisteredKind
    readonly data: ChatNodeDataMap[RegisteredKind]
  }
}[Kind]
```

- 三件套③的本质：`declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { '<kind>': <Data> } }`，让 `ChatNode<'<kind>'>.data` 收窄到自己的 payload。
- 该模块增强为何挂在 `dsh-client-ui-conversation/client`：`ChatNodeDataMap` 由 ui-conversation 声明，插件的 `apply` 里 `import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'` 即可拉取类型（无需运行时依赖，仅类型增强）。

### 3.5 PropsRuntime 两参数形式（`ui-slots/src/index.ts` L211-221）

```ts
export type PropsRuntime<K extends keyof SlotMap & string, EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>> =
  OwnerOf<K> & KeyPropsOf<K, EntryKey> & SlotInjectFace<SlotInjectOf<K>> &
  (ScopeOf<K> extends 'session' ? SessionStandardProps : ...) & GlobalStandardProps
```

- keyed 节点组件 props = `PropsRuntime<'conversation.chat.node', '<my-kind>'>`（第二参数收窄 `keyProps` 到本 kind 的 `{ node: ChatNode<'<my-kind>'> }`）+ `PropsLocale<'<my-locale-ns>'>` + 业务 `InjectFace`。

---

## 4. 事件 payload（sandore/step-* 双声明，当前工作区状态）

来源：`D:/project-code/llm/sandore/packages/sandore/workflow/src/seam.ts`（**当前工作区已含 `name`/`loopIteration`**，与 `event-01` 探索时相比已落地）。

### 4.1 Cordis `Events` 声明（`declare module '@deepseek-ai/cordis'`，L34-48）

```ts
'sandore/step-start'      (info: DagRunInfo, stepId: string, childId: string, name: string, loopIteration?: number[]): void
'sandore/step-completed'  (info: DagRunInfo, stepId: string, childId: string, output: ContentBlock[], name: string, loopIteration?: number[]): void
'sandore/step-failed'     (info: DagRunInfo, stepId: string, childId: string, error: string, name: string, loopIteration?: number[]): void
'sandore/step-paused'     (info: DagRunInfo, stepId: string, childId: string, name: string, loopIteration?: number[]): void
'sandore/step-resumed'    (info: DagRunInfo, stepId: string, childId: string, resumePrompt: string | undefined, name: string, loopIteration?: number[]): void
'sandore/step-retried'    (info: DagRunInfo, stepId: string, mode: string, name: string, loopIteration?: number[]): void
```

### 4.2 Session `SessionEventMap` 声明（`declare module '@deepseek-ai/dsh-session/types'`，L51-67）

```ts
'sandore/step-start':      { stepId: string; childId: string; name: string; loopIteration?: number[] }
'sandore/step-completed':  { stepId: string; childId: string; output: ContentBlock[]; name: string; loopIteration?: number[] }
'sandore/step-failed':     { stepId: string; childId: string; error: string; name: string; loopIteration?: number[] }
'sandore/step-paused':     { stepId: string; childId: string; name: string; loopIteration?: number[] }
'sandore/step-resumed':    { stepId: string; childId: string; resumePrompt?: string; name: string; loopIteration?: number[] }
'sandore/step-retried':    { stepId: string; mode: string; name: string; loopIteration?: number[] }
```

- **这就是 `match(event)` 里 `event.data` 的形状**：`SessionEvent` 的 `data` 字段由 `SessionEventMap[K]` 派生（见 4.3）。讨论节点可从 `event.data.stepId`/`event.data.childId`/`event.data.name`/`event.data.loopIteration`/`event.data.output`/`event.data.error` 直接取到折叠所需全部信息，**零 RPC 补偿**。
- `loopIteration` 为可选，非循环 Step 省略该键（emit 时以 `...(loopIteration === undefined ? {} : { loopIteration })` 展开）；`mode` 在两处均声明为 `string`（emit 实参是 `RetryMode = 'continue' | 'revert' | 'fork'`）。
- 其他 7 个事件（`start`/`stage-start`/`stage-completed`/`question`/`permission`/`end`/`aborted`）同文件声明，供完整参考。

### 4.3 `SessionEvent` 类型（`packages/core/session/src/types.ts` L404-411 附近）

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: number      // 会话内单调序号
    time: number     // Unix 毫秒
    data: SessionEventMap[K]
    // ...（surface 相关字段，SurfaceOp / sourceEventSeqs 等）
  }
}[SessionEventType]
```

- `SessionEventType = keyof SessionEventMap`（L336）；`SessionEventMap` 基础声明在 `packages/core/session/src/types.ts` L236（`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、…）。
- sandore 通过 `declare module '@deepseek-ai/dsh-session/types'` 把 `sandore/step-*` 并入 `SessionEventMap`，于是 `event.type === 'sandore/step-start'` 后 `event.data` 自动收窄到对应 payload——这是 `ConversationNodeDefinition.match(event)` 能类型安全地匹配 sandore 事件的机制。

### 4.4 emit 侧现状（`workflow-engine.ts`，工作区）

- 6 个 emit 函数（L943-985）均已带 `name: string, loopIteration?: number[]` 形参，并以 `...(loopIteration === undefined ? [] : [loopIteration])`（Cordis 位置参数）与 `...(loopIteration === undefined ? {} : { loopIteration })`（safeAppend payload）两种形式写出。
- `onStepStart/onStepCompleted/onStepFailed` 调用点（L512-514）传 `step.name ?? step.id` 与 `currentLoopIteration()`；`emitStepPaused/Resumed/Retried`（L760/761/785）由注入回调携带 `name`/`loopIteration`。

---

## 5. 内联消息渲染

来源：`@deepseek-ai/dsh-client-ui-primitives`（`packages/client/ui-primitives/src/markdown/`）。

### 5.1 两个薄胶水原语

```ts
// MessageText.tsx —— 字面文本原语（user/steering 内容），assistant 输出用 MarkdownText
export function MessageText({ text }: { text: string }) {
  return <div className={css.text}>{text}</div>
}

// MarkdownText.tsx —— 渲染不受信 assistant Markdown 为语义 React 元素
export const MarkdownText = memo(function MarkdownText({
  text, streaming = false, codeLabels, fileMentions,
}: {
  text: string
  streaming?: boolean
  codeLabels?: MarkdownCodeLabels | undefined
  fileMentions?: MarkdownFileMentions | undefined
})
```

- `MarkdownText` 输出 GFM + KaTeX 数学公式；禁用 raw HTML / 相对链接 / 不安全协议，绝对 HTTP(S) 图片直出（L140-155 注释）。
- 二者均可从 `@deepseek-ai/dsh-client-ui-primitives` 直接 import（`index.ts` L45-47 导出；`MessageText` 为 value，`MarkdownText` 连同 `MarkdownCodeLabels`/`MarkdownFileMentions` 类型一起导出）。

### 5.2 `ContentBlock`（sandore 事件 `output` 的类型）

来源：`@deepseek-ai/dsh-llm`（`packages/llm/llm/src/types.ts`）。

- `ContentBlockMap`（L99-105）核心块：`'text' | 'reasoning' | 'image' | 'tool-call' | 'tool-result'`；`ContentBlock = ContentBlockMap[ContentBlockType]`（L110，可合并扩展，switch 需对未知 type 兜底）。
- `TextBlock = { type: 'text'; text: string }`（L54-57）、`ReasoningBlock = { type: 'reasoning'; text: string }`（L60-63）、`ImageBlock = { type: 'image'; attachment: ImageAttachmentRef }`、`ToolCallBlock = { type: 'tool-call'; id; name; arguments: string }`、`ToolResultBlock = { type: 'tool-result'; toolCallId; content: ContentBlock[]; isError? }`。
- 薄胶水语义：`output: ContentBlock[]` 中可见文本来自 `type === 'text'` 块的 `text` 字段；`reasoning` 是思考内容（非可见正文）。

### 5.3 参考渲染范式（`ui-conversation/src/client/chat/AssistantMarkdown.tsx`）

- 遍历 `AssistantBlock[]`（runtime 对 `ContentBlock` 的投影，`kind: 'text' | 'reasoning' | 'image' | 'tool-call'`），按 `kind` 分派：`text → <MarkdownText text={block.text} .../>`、`reasoning → <ReasoningRow .../>`、`image → <ImageGallery .../>`、`tool-call` 跳过（由 ChatView 分组为 tool 行）、未知块 → `<JsonBlock label={t('message.unknownBlock')} payload={block.block} .../>`。
- 这是 sandore 节点「completed 内联最后 assistant 结果」的渲染范式来源：取 `output` 中的 text 块文本 → `MarkdownText`（或字面 `MessageText`）。

---

## 6. 补充：sandore ui 包现状（三件套落地的既有前提）

来源：`D:/project-code/llm/sandore/packages/sandore/ui/`。

### 6.1 当前插件入口（`src/client/index.ts`）

```ts
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces']
```

- 已含 `'sessions'`（`ctx.sessions`，`createOpenDiscussion(ctx.sessions, instanceId)` 已在使用）与 `'slots'`/`'locale'`。
- **尚缺 `'conversationEvents'`**（Definition 注册所需）——需补进 inject。
- 尚无 `import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'`（三件套③的 `ChatNodeDataMap` 增强宿主）。

### 6.2 package.json 依赖现状

- `peerDependencies` 已含：`cordis`、`dsh-api-remotes`、`dsh-sandore-workflow`、`dsh-typert-protocol`、`dsh-client-locale`、`dsh-client-runtime`、`dsh-client-ui-primitives`、`dsh-client-ui-sidebar`、`dsh-client-ui-slots`、`react`。
- **未含 `@deepseek-ai/dsh-client-ui-conversation`**：`conversationEvents` 服务本身由 `dsh-client-runtime` 提供（已含），但 `ChatNodeDataMap` 增强 + `conversation.chat.node` 槽的 `ChatNodeOwnerProps`/`ChatNodeTurnDataInjected` 类型声明在 `dsh-client-ui-conversation`，因此三件套实现需补该 peerDep（照 `ui-workflow-run` 的 `dsh.client.inject` 亦需纳入该包）。
- `dsh.client.inject` 现为 `['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-sidebar']`（未含 `dsh-client-ui-conversation`）。
- 既有 locale 范式（`src/client/locales.ts`）：`NS = 'sandore'`、`zh`/`en` 字典、`SandoreKey = keyof typeof zh`、`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }`——keyed 节点组件可用 `PropsLocale<'sandore'>`，与既有 `WorkflowButton`（`PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`）一致。

### 6.3 与 ui-workflow-run 的差异要点

- sandore 节点的 `id`/key 需由 `stepId` + `loopIteration` 派生（参考 `ui-workflow-run` 用 `String(runId)` 作为单一 `id`；sandore 因同一 `stepId` 循环多迭代需独立节点，故身份需含迭代路径）。此为需求差异，非本次探索结论。
- 参考实现的跳转注入 `openSession: (id) => ctx.sessions.open(id)`；sandore 已有 `ctx.sessions` 可直接复用该范式。

---

## 补充探索结果

`exploration.specification` 配置为空（`furina config show exploration.specification` 返回 `[]`），本次全部基于本地两处源码仓库（`D:/project-code/llm/deepseek-harness` 与 `D:/project-code/llm/sandore`）实际代码探索，未触发联网检索。关键结论均已落到上述 6 节。
