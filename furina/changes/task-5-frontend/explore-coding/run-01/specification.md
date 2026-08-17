# RunView 执行详情组件 — 参考实现探索（specification）

## Explore Content 理解

- **What**：理解新增 sandore `ui` 包 RunView 组件（执行轨迹只读视图 + 产物面板 + 交互控件 + 打开讨论）所需的既有参考实现与集成点：`ctx.remote.sandore` 的 wire 类型签名、pendingInteractions 渲染可复用的 DSH 组件、`ctx.sessions.open(id)` 服务来源与 inject 声明、`ui-primitives` 可用组件、ui 包现有组件范式、7 态状态到 `StateDotState` 的映射惯例、`ui/src/client/remote.ts` 的 unwrap 封装。
- **Boundaries**：sandore 仓库 `packages/sandore/ui` 与 `packages/sandore/workflow` 两个包，以及 node_modules 中已安装的 DSH client 依赖包（`dsh-client-runtime`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-api-remotes`、`dsh-typert-protocol`、`dsh-user-questions`、`dsh-user-approval`、`dsh-client-connection`、`dsh-host-apiproxy`）。
- **Goal**：拿到确切（非臆测）的签名、类型与可复用组件清单，供 RunView 对照真实类型实现。

> 说明：`furina config show exploration.specification` 返回空数组 `[]`。本次「规范材料」即项目自身参考实现（workflow 包 wire 类型 + ui 包组件范式 + 已安装 DSH 依赖的 `.d.ts`）。

---

## (1) `ctx.remote.sandore` 的 wire 类型

### Wire 命名空间来源

- Host RPC 权威定义：`packages/sandore/workflow/src/remote.ts`（`class SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`，方法用 `@Remote('name')` 装饰，构成端点 `sandore.<method>`）。
- 客户端生成的 wire 类型：`packages/sandore/workflow/lib/typert.remote-client.d.ts`，经 `@deepseek-ai/dsh-sandore-workflow/remote` 子路径导出（`export default TYPERT_REMOTE`，并通过 `declare module '@deepseek-ai/dsh-typert-protocol'` 把 `sandore` 命名空间并入 `TypertRemoteMap`/`TypertRemoteNamespaceMap`）。
- `ctx.remote` 类型为 `TypertClientRemote`（`@deepseek-ai/dsh-typert-protocol`），由 `@deepseek-ai/dsh-api-remotes/client` 声明并提供（`Context.remote: TypertClientRemote`）；`TypertClientRemote extends TypertRemoteNamespaceMap`，故 `ctx.remote.sandore` 即生成的命名空间类型 `TypertRemoteNamespace$73616e646f7265`。挂载方式：`ctx.remote.$mount(sandoreRemote)`（见 ui 包 `src/client/index.ts`）。

### 客户端侧确切签名（来自 typert.remote-client.d.ts）

每个方法都返回 `Promise<RemoteResult<T>>`：

| 方法 | 入参 | 返回 |
|---|---|---|
| `getInstanceState` | `(instanceId: string)` | `RemoteResult<unknown>`（**注意：结果 codec 是 `unknown`**，Host 侧源码返回 `WorkflowTaskState`） |
| `getArtifacts` | `(instanceId: string, stageId?: string)` | `RemoteResult<ArtifactEntry[]>` |
| `abortInstance` | `(instanceId: string)` | `RemoteResult<void>` |
| `pauseAll` | `(input: { instanceId: string })` | `RemoteResult<void>` |
| `resumeAll` | `(input: { instanceId: string; resumePrompt?: string })` | `RemoteResult<void>` |
| `pauseStep` | `(input: { instanceId: string; stepId: string })` | `RemoteResult<void>` |
| `resumeStep` | `(input: { instanceId: string; stepId: string; resumePrompt?: string })` | `RemoteResult<void>` |
| `retryStep` | `(input: { instanceId: string; stepId: string; mode: 'continue' \| 'revert' \| 'fork'; message: string })` | `RemoteResult<void>` |
| `replyQuestion` | `(input: { instanceId: string; requestId: string; answers: unknown })` | `RemoteResult<void>`（wire 上 `answers` 为 `unknown`；真实类型为 `AskUserQuestionAnswer`，Host 侧 zod `AskUserQuestionAnswerSchema` 校验） |
| `replyPermission` | `(input: { instanceId: string; requestId: string; reply: 'once' \| 'always' \| 'reject' })` | `RemoteResult<void>` |

另有 `listInstances(jobId?): RemoteResult<InstanceSummary[]>`、`startInstance(input): RemoteResult<DagRun>`、`listDefinitions/getYaml/createDefinition/updateYaml/...`、`listProviders()/listModels(provider)`。

> 客户端 wire 上 `InstanceSummary.status` 与 `DagRun.status` 均为 `string`（未收窄），只有 `ArtifactEntry`、`WorkflowDefinitionEntry`、`JobEntry`、`InstanceSummary` 等标量/条目类型被完整生成；`getInstanceState` 结果与 `replyQuestion` 的 `answers` 在客户端被抹成 `unknown`。

### 关键类型定义

- `ArtifactEntry`（remote.ts + typert.remote-client.d.ts）：`{ stepId: string; stageId: string; outputToId?: string; files: string[]; returnPrompt?: string }`
- `RetryMode`：`'continue' | 'revert' | 'fork'`。定义在 `packages/sandore/workflow/src/recovery-manager.ts`（`export type RetryMode = ...`，**内部导出，未经 `/remote` 或 `/types` 公共子路径对外暴露**）；客户端 wire 用内联 union。
- `WorkflowTaskState`（`workflow/src/schema.ts`，`z.infer` 派生）：
  `{ taskId; jobId; workflowId; cwd; status: DagRunStatus; originalInput; currentStageId; executedSteps: ExecutedStepDefault[]; stageInfos: StageInfo[]; pendingInteractions: (PendingQuestionEntry | PendingPermissionEntry)[]; pendingQueue: string[]; visitCounts: Record<string, number>; passThroughVars: Record<string, { value; description; refresh? }>; activeLoopIterationStack: number[]; activeLoopNodeId: string | null; activeLoopStack: string[]; pausedChildIds: string[]; stageContracts: Record<string, StageContract>; createdAt; updatedAt }`
- 7 态枚举（`workflow/src/types.ts`）：
  - `StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`
  - `DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'`
  （schema.ts 中对应 `StepStatusSchema`/`DagRunStatusSchema` 为 zod enum，但**派生的 `StepStatus`/`DagRunStatus` 类型不导出**，只在 types.ts 里以 type alias 定义。）
- `ExecutedStepDefault`（types.ts interface）：`{ type: 'default'; id; stepId?; stageId; name; status: StepStatus; command?; inputFrom?; outputTo?; passThroughVars?; sessionMeta?; finalizeMeta?; visitCount; branchMeta?; error?; pausedAt?; resumedAt?; resumePrompt?; sessionMessages?; pauseEntryId?; loopIteration?; loopMeta?; retryHistory?; parentSessionId?; output?: ContentBlock[] }`
- `StageInfo`（types.ts）：`{ id; name; status: StepStatus }`
- `StageContract`（types.ts）：`{ stageId; stageName; status: StepStatus; artifacts: Array<{ stepId; outputToId; files: string[]; returnPrompt? }>; passThroughVars: Record<string, { value; description; refresh? }>; contractArtifacts: Record<string, string[]>; completedAt; errorDetail? }`
- `PendingQuestionEntry`（schema.ts zod）：`{ id; stageId; stepId; sessionId; requestId; kind: 'question'; status: 'pending'|'replied'|'rejected'; payload: AskUserQuestionPayload; answer?: string[][]; createdAt }`
- `PendingPermissionEntry`（schema.ts zod）：`{ id; stageId; stepId; sessionId; requestId; kind: 'permission'; status: 'pending'|'replied'|'rejected'; payload: { permission: string; patterns?: string[]; metadata?: Record<string, unknown>; tool?: string }; answer?: 'once'|'always'|'reject'; createdAt }`
- `PendingInteractionEntry = PendingQuestionEntry | PendingPermissionEntry`（`workflow/src/interaction-manager.ts` 导出）。
- `AskUserQuestionPayload`（schema.ts）：`{ questions: Array<{ id; question; header?; options?: Array<{ label; description? }>; multi_select? }> }`（**snake_case `multi_select`**）。
- 驼峰对齐 DSH 的问答类型在 `types.ts`：`AskUserQuestionItem`（`multiSelect`）、`AskUserQuestionOption`、`AskUserQuestionAnswerItem`、`AskUserQuestionAnswer`（`{ answers: AskUserQuestionAnswerItem[] }`）。

### 类型可导入路径（浏览器安全）

- `WorkflowTaskState`、`PendingQuestionEntry`、`PendingPermissionEntry`、`AskUserQuestionPayload`、`StageContractSchema` 等 → `@deepseek-ai/dsh-sandore-workflow/schema`（schema.ts，仅依赖 zod）。
- `StepStatus`、`DagRunStatus`、`ExecutedStepDefault`、`StageInfo`、`StageContract`（type）、`AskUserQuestionAnswer` 等 → `@deepseek-ai/dsh-sandore-workflow/src/types.ts`（type-only；但文件 `import type { ContentBlock } from '@deepseek-ai/dsh-llm'`，而 `dsh-llm` **不在 ui 包 peer/devDependencies 与 node_modules 中**，如需导入需先补充该类型依赖）。workflow 包 `package.json` 的 `"./types"` 子路径指向 `lib/types/types.d.ts`，但当前构建产物 `lib/` 下并无 `types/` 目录（未产出），故实际可用的稳定子路径是 `/schema`、`/yaml`、`/remote`、`/src/*`。

---

## (2) DSH 渲染 pendingInteractions 的可复用组件

**结论：已安装的 DSH client 依赖树中不存在名为 `PendingQuestion` 的 React 卡片组件**，也没有 `QuestionCard`/`ApprovalCard`/`PendingApproval` 组件。先前探索报告「复用 PendingQuestion + PendingWait」的表述与当前安装树不完全一致——实际可用的是 runtime 里的 `PendingWait` 类型，而非一个 `PendingQuestion` UI 组件。

实际存在（`@deepseek-ai/dsh-client-runtime/client`，`lib/types/client/sessions/pending.d.ts` + `client/index.d.ts` 再导出）：

```ts
export type PendingKind = keyof PendingPayloads;              // 'approval' | 'question'
export type PendingInteractionStatus = 'approval' | 'plan-review' | 'question';
export type PendingPayloads = {
  approval: Omit<Extract<MuxFrame, { type: 'approval/requested' }>, 'type' | 'sessionId'>;
  question: Omit<Extract<MuxFrame, { type: 'question/requested' }>, 'type' | 'sessionId'>;
};
export type PendingInteraction = { [K in PendingKind]: PendingWait<K> }[PendingKind];
export declare class PendingWait<K extends PendingKind = PendingKind> {
  readonly kind: K;
  readonly key: string;              // '<prefix>:<rpcId>', 可作 React key
  readonly sessionId: SessionId;
  readonly payload: PendingPayloads[K];
  respond(result: ClientResponse['result']): Promise<RpcReceipt>;
  markSettled(): void;
}
```

由此推导：

- `PendingWait<'question'>.payload` = `{ questions: AskUserQuestionItem[] }`（`AskUserQuestionItem` 来自 `@deepseek-ai/dsh-user-questions/types`，含 `id/question/header?/detail?/options?/multiSelect?/intent?`）。
- `PendingWait<'approval'>.payload` = `{ approvalId: ApprovalRequestId; toolName: string; callId?: CallId; reason?: string }`。

相关 frame/payload（`@deepseek-ai/dsh-host-apiproxy/api` 的 `MuxFrame`，经 `@deepseek-ai/dsh-client-connection/client` → `@deepseek-ai/dsh-api-remotes/client` 再导出）：

- `MuxFrame` 的 `question/requested`：`{ type; sessionId; questions: AskUserQuestionItem[] }`
- `MuxFrame` 的 `approval/requested`：`{ type; sessionId; approvalId; toolName; callId?; reason? }`
- `QuestionResponsePayload = { sessionId; answer: AskUserQuestionAnswer }`（`answer` 为整批回答）
- `ApprovalResponsePayload = { sessionId; approvalId; outcome: 'allowed-once' | 'rejected' }`
- `ClientResponse = { type: 'client-response'; rpcId: RpcId; result: RpcResult<unknown> }`；`PendingWait.respond` 收 `ClientResponse['result']`（即 `RpcResult<unknown>`）。
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`@deepseek-ai/dsh-user-approval/types`）。

**与 sandore 的关系**：`PendingWait` 是 DSH runtime 自己的「宿主会话 question/approval 帧」载体（mux 流），与 sandore 引擎的 `ctx.userQuestions.ask`（Host 卡片通道）对应；而 RunView 的 pendingInteractions 数据来自 `WorkflowTaskState.pendingInteractions`（sandore schema 条目），回复走 sandore 自己的 wire RPC `replyQuestion`/`replyPermission`（兼容回复路径，resolve 引擎侧等待 Promise），**不是** `PendingWait.respond()`。两条通道是分开的。

---

## (3) `ctx.sessions.open(id)` 的服务来源与 inject 声明

- `ctx.sessions` 由 `@deepseek-ai/dsh-client-runtime/client` 声明（`lib/types/client/index.d.ts` 的 `declare module '@deepseek-ai/cordis'` 增强）：`sessions: import('./contract/sessions.ts').ISessions`。
- `ISessions`（`lib/types/client/contract/sessions.d.ts`）关键方法：`open(id: SessionId): void`（选中某会话为当前；id 必须在列表中，未知 id fail loud）、`list: ObservableSnapshot<SessionListState>`、`clear(): void`、`fork(...)`、`search(...)`、`scope(id)`、`binding(id)` 等。
- 服务由 runtime 包 `apply(ctx)` 提供（其 `dsh.client.inject` 声明依赖 `@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-typert-registry`、`@deepseek-ai/dsh-api-remotes`，`immediately: true`）；runtime 自身导出 `inject: string[]` 与 `apply`。
- **ui 包现状**：`packages/sandore/ui/src/client/index.ts` 的 `export const inject = ['slots', 'locale', 'remote']` —— **尚未含 `sessions`**（也未含 runtime 的 import type 增强）。要访问 `ctx.sessions`，需在 inject 中加 `'sessions'`，并 `import type {} from '@deepseek-ai/dsh-client-runtime/client'` 引入类型增强。
- `SessionId` 类型来自 `@deepseek-ai/dsh-client-connection/client`（并经 `@deepseek-ai/dsh-api-remotes/client`、`@deepseek-ai/dsh-client-runtime/client` 再导出）。
- 挂载范式参考：ui 包当前用 `ctx.effect(() => ctx.remote.$mount(sandoreRemote), ...)`、`ctx.effect(() => ctx.locale.register(NS, { zh, en }), ...)`、`ctx.slots.inject(...)` 完成副作用挂载。

---

## (4) `ui-primitives` 可用组件

来源：`@deepseek-ai/dsh-client-ui-primitives`（纯 React 原子、零 cordis、仅 `--dsw-*` token 样式、文案经 props 传入）。`lib/types/index.d.ts` 导出：

- **StateDot** `{ state, size?, className? }`，`StateDotState = 'done' | 'warning' | 'ongoing' | 'error'`（**只有 4 态**）。
- **DisclosureRow** `{ icon, title, open, expandable, onToggle, expandOnRowClick?, previewChevron?, keepContentWhenOpen?, collapsedContent?, children?, className?, rowClassName?, leadingClassName?, chevronClassName?, titleClassName? }`（受控折叠行，适合执行轨迹/Stage 列表）。
- **Button** `{ variant?: 'primary'|'ghost'|'outline'|'toolbar', size?: 'md'|'sm', icon?, className?, children?, ...rest }`（rest 透传原生 button 属性）。
- **Pill** `{ active?, className?, children?, onClick?, ...rest }`（chip，带 onClick 时渲染 button）。
- **Modal** `{ open, onClose, title, closeLabel?, description?, children?, footer?, className?, contentClassName?, headless? }`。
- **CodeBlock**（`./markdown/CodeBlock`）`{ code, lang?, className?, copyLabel?, copiedLabel? }`。
- 其他：`Input`、`Menu`（`MenuEntry = MenuItem | MenuSeparator | MenuLabel`）、`HoverCard`、`Tooltip`、`Toast`、`RiskConfirmation`（带 acknowledge 门槛的确认卡）、`JsonTree`、`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`、`JsonBlock`、`MarkdownText`、`MessageText`、`extractMarkdownPlainText`、`writeClipboard`。
- 图标集（`icons/index`，`{ size, className }`）：`IconPauseOutline16`、`IconPlayOutline16`、`IconStopFill16`、`IconRefreshOutline16/14`、`IconQuestionOutline14`、`IconBranchOutline16`、`IconChevronDown/Right/Left/UpOutline14`、`IconTriangleRightFill14`、`IconCloseOutline16/CloseFill14`、`IconTrashOutline16`、`IconPlusOutline16`、`IconCheckOutline16/14`、`IconCopyOutline16`、`IconDownloadOutline16`、`IconWarningOutline16`、`IconCodeOutline16`、`IconLinkOutline14/16`、`IconInspectOutline12` 等（fill="currentColor"）。

---

## (5) ui 包现有组件范式

- 目录：`packages/sandore/ui/src/client/*.tsx` + 同名 `.module.css`（CSS Modules，经 `src/css-modules.d.ts` 声明 `*.module.css`）。
- **Props 组合（slot 组件）**：`WorkflowButton.tsx` 用 `type WorkflowButtonProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`。`PropsRuntime`/`InjectFace`/`PropsLocale`/`TranslateNS`/`ComposedProps`/`SlotMap`/`LocaleNamespaceMap` 均来自 `@deepseek-ai/dsh-client-ui-slots`。
- **非 slot 子组件**（`WorkflowPanel`/`DagEditor`）用普通 props：`{ t: TranslateNS<'sandore'>; ...业务回调 }`，如 `DagEditorProps = { t, initialYaml?, initialId?, save: SaveDefinition }`、`WorkflowPanelProps = { t, ping }`。
- **注册范式**（`src/client/index.ts` 的 `apply`）：
  ```ts
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'sandore-btn', locale: NS,
    inject: (): WorkflowButtonFace => sandore,   // 业务 face（RPC 面，已 unwrap）
  }, WorkflowButton))
  ```
  其中 `sandore = { ping: async () => unwrap(await ctx.remote.sandore.ping()) }`。
- **locales**（`src/client/locales.ts`）：`NS = 'sandore'`；`zh`/`en` 两份字典，`en` 用 `satisfies Record<SandoreKey, string>` 强制与 `zh` 逐键对齐（缺一即编译错）；`SandoreKey = keyof typeof zh`；`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }`。`apply` 里 `ctx.locale.register(NS, { zh, en })`。
- **RPC 访问**：统一经 `src/client/remote.ts` 的 `sandoreRemote` + `unwrap`；组件/纯函数拿到的是「已解包」的业务面（`PingResponse`、`WorkflowDefinitionEntry` 等），失败抛 `SandoreRemoteError`。
- **纯逻辑拆分**：非 React 逻辑拆到独立模块并配 vitest spec（`dag-editor-model.spec.ts`、`sandore-save.spec.ts`、`remote.spec.ts`）。
- **状态建模**：用 discriminated union 建模本地异步态（如 `type PingState = { kind:'idle' } | { kind:'pending' } | { kind:'ok'; response } | { kind:'error'; message }`、`SaveState`）。
- **import 路径惯例**：primitives 从 `@deepseek-ai/dsh-client-ui-primitives`；slots 类型从 `@deepseek-ai/dsh-client-ui-slots`；workflow 浏览器安全类型从 `@deepseek-ai/dsh-sandore-workflow/schema`、`/yaml`、`/remote`、`/src/yaml-error.ts`。

---

## (6) 7 态 StepStatus/DagRunStatus → StateDotState 映射惯例

- `StateDotState` 只有 4 态：`'done' | 'warning' | 'ongoing' | 'error'`。**依赖树中不存在 `ui-workflow-run` 包**，无该包的状态映射可参考。
- 仓库内唯一现成映射惯例在 `WorkflowPanel.tsx` 的占位行：
  - `ready → 'warning'`（琥珀，需用户注意）
  - `running → 'ongoing'`（蓝，进行中）
  - `completed → 'done'`（绿，完成）
  - `error`（红，失败）由 `StateDotState` 语义隐含，但尚未在现有代码中用于 Step/DagRun 状态。
- 7 态（StepStatus 的 blocked/ready/interacting/running/completed/failed/paused；DagRunStatus 的 pending/running/interacting/completed/failed/aborted/paused）到 4 态 `StateDotState` 的完整映射尚未在仓库中确立，RunView 需自行定义（仅上述 3 个样例态可复用）。

---

## (7) `ui/src/client/remote.ts` 的 unwrap 封装

`packages/sandore/ui/src/client/remote.ts`：

- `import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'`（默认导出 `TYPERT_REMOTE: TypertRemoteContribution`），并 `export { sandoreRemote }`、`export type { PingResponse }`。
- `class SandoreRemoteError extends Error`，额外 `readonly code: string` 与 `readonly details: object`，由 `RemoteFailure` 构造（`name = 'SandoreRemoteError'`）。
- `function unwrap<T>(result: RemoteResult<T>): T`：`ok` 取 `result.value`，`!ok` 抛 `new SandoreRemoteError(result.error)`。
- `RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }`（`@deepseek-ai/dsh-typert-protocol`）；`RemoteFailure = { code: string; message: string; details: object }`。
- 语义：载波层故障已折叠进 error 分支，消费者无需 try/catch 恢复；仅装配性故障（arity 不匹配、方法未挂载、缺 Context binder）仍 reject。
- 使用方式（`sandore-save.ts`）：`unwrap(await remote.createDefinition({ yaml })).id`、`unwrap(await remote.updateYaml(id, yaml)).id`；`describeSaveError` 对 `SandoreRemoteError` 取 `.details` 渲染校验详情。

> RunView 相关推论（仅记录现状）：因 `getInstanceState` 客户端返回 `RemoteResult<unknown>`，`unwrap(await ctx.remote.sandore.getInstanceState(id))` 的结果是 `unknown`，需再断言/收窄到 `WorkflowTaskState`（从 `@deepseek-ai/dsh-sandore-workflow/schema` 或 `/src/types.ts` 导入该类型）。
