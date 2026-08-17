## Exploration Result

> 说明：`furina config show exploration.reference` 返回空数组 `[]`，无预配置参考目录/技能/URL。以下结果为对两处本地仓库的直接探索：
> 1. sandore 当前仓库（wire 类型 / ui 包现状）：`D:/project-code/llm/sandore`
> 2. DSH 官方包（复用组件 / 服务 / 范式）：`D:/project-code/llm/deepseek-harness`

### 1. `ctx.remote.sandore` 的 wire 类型（签名 / 返回类型 / 枚举）

来源：`packages/sandore/workflow/src/remote.ts`（`SandoreRemote extends TypertRemoteService`，`constructor(ctx) { super(ctx, 'sandore') }`，wire namespace = `sandore`，端点 = `sandore/<method>`）。

RunView 直接使用的 9 个方法（均为 `@Remote('name')`，客户端经 `ctx.remote.sandore.<method>(...)` 调用，生成端签名统一为 `Promise<RemoteResult<T>>`）：

| 方法 | 入参（zod） | 返回类型 | 备注 |
| --- | --- | --- | --- |
| `getInstanceState` | `instanceId: string`（位置参数） | `WorkflowTaskState`（同步） | 不存在抛 `SandoreError('NODE_NOT_FOUND')` |
| `getArtifacts` | `instanceId: string, stageId?: string`（位置参数） | `ArtifactEntry[]`（同步） | 从 `state.stageContracts` 扁平化，可选按 stageId 过滤 |
| `abortInstance` | `instanceId: string` | `Promise<void>` | 终态（completed/failed/aborted）抛 `INVALID_OPERATION` |
| `pauseAll` | `{ instanceId: string }` | `Promise<void>` | 转发 `sandoreEngine.pauseAllSteps` |
| `resumeAll` | `{ instanceId: string; resumePrompt?: string }` | `Promise<void>` | 转发 `sandoreEngine.resumeAllSteps` |
| `pauseStep` | `{ instanceId: string; stepId: string }` | `Promise<void>` | |
| `resumeStep` | `{ instanceId: string; stepId: string; resumePrompt?: string }` | `Promise<void>` | |
| `retryStep` | `{ instanceId: string; stepId: string; mode: 'continue'\|'revert'\|'fork'; message: string }` | `Promise<void>` | |
| `replyQuestion` | `{ instanceId: string; requestId: string; answers: AskUserQuestionAnswer }` | `Promise<void>` | `answers = { answers: AskUserQuestionAnswerItem[] }`，`AskUserQuestionAnswerItem = { id: string; selected: string[]; custom?: string }` |
| `replyPermission` | `{ instanceId: string; requestId: string; reply: 'once'\|'always'\|'reject' }` | `Promise<void>` | |

（前 8 项与 exploreContent 的 9 个方法名一一对应；第 9 项 `replyPermission` 的 `reply` 仅限 once/always/reject。）

关键类型（`packages/sandore/workflow/src/schema.ts` / `types.ts`，经 `export type * from './types.ts'` + `export * from './schema.ts'` 从包根导出）：

- `WorkflowTaskState`（`z.infer<WorkflowTaskStateSchema>`）：`{ taskId, jobId, workflowId, cwd, status: DagRunStatus, originalInput, currentStageId, executedSteps: ExecutedStepDefault[], stageInfos: StageInfo[], pendingInteractions: Array<PendingQuestionEntry | PendingPermissionEntry>, pendingQueue: string[], visitCounts, passThroughVars, activeLoopIterationStack, activeLoopNodeId, activeLoopStack, pausedChildIds, stageContracts: Record<string, StageContract>, createdAt, updatedAt }`。
- `ExecutedStepDefault`：`{ type: 'default', id, stepId?, stageId, name, status: StepStatus, command?, inputFrom?, outputTo?, passThroughVars?, sessionMeta?, finalizeMeta?, visitCount: number, branchMeta?, error?, pausedAt?, resumedAt?, resumePrompt?, sessionMessages?, pauseEntryId?, loopIteration?: number[], loopMeta?, retryHistory?, parentSessionId?, output?: ContentBlock[] }`。
- `StageInfo`：`{ id, name, status: StepStatus }`。
- `StageContract`：`{ stageId, stageName, status: StepStatus, artifacts: Array<{ stepId, outputToId, files: string[], returnPrompt? }>, passThroughVars, contractArtifacts, completedAt, errorDetail? }`。
- `ArtifactEntry`（定义在 `remote.ts`，非 schema）：`{ stepId, stageId, outputToId?, files: string[], returnPrompt? }`。
- `StepStatus`（7 态）：`'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`。
- `DagRunStatus`（7 态）：`'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'`。
- `RetryMode`：`'continue' | 'revert' | 'fork'`（`export type RetryMode` 定义在 `packages/sandore/workflow/src/recovery-manager.ts`；`remote.ts` 的 `RetryStepInputSchema.mode` 以 `z.enum(['continue','revert','fork'])` 内联，`RetryRecordSchema.mode` 同值）。
- `PendingQuestionEntry`（注意：sandore 实际类型名是 `...Entry`，不是 exploreContent 里的 `PendingQuestion`）：`{ id, stageId, stepId, sessionId, requestId, kind: 'question', status: 'pending'|'replied'|'rejected', payload: AskUserQuestionPayload, answer?: string[][], createdAt }`；其中 `AskUserQuestionPayload = { questions: Array<{ id, question, header?, options?: Array<{ label, description? }>, multi_select? }> }`（wire 存储格式为**蛇形** `multi_select`）。
- `PendingPermissionEntry`：`{ id, stageId, stepId, sessionId, requestId, kind: 'permission', status: 'pending'|'replied'|'rejected', payload: { permission: string, patterns?: string[], metadata?: Record<string, unknown>, tool?: string }, answer?: 'once'|'always'|'reject', createdAt }`。

命名碰撞提醒：`seam.ts` 的事件双声明与引擎内部均使用 `PendingQuestionEntry`/`PendingPermissionEntry`；而 DSH UI 侧另有 `PendingQuestion`（域类，见第 2 节）。Task 1/4 设计文档里写的 `PendingQuestion`/`PendingPermission` 在实现时已更名为 `...Entry`。

### 2. DSH 渲染 pendingInteractions 的复用组件（问答 / 权限）

#### 2.1 `PendingWait<K>`（载体，`@deepseek-ai/dsh-client-runtime/client`，可 import）

文件：`deepseek-harness/packages/client/runtime/src/client/sessions/pending.ts`（经 `client/index.ts` `export { PendingWait }`）。

```ts
export type PendingKind = 'approval' | 'question'
export interface PendingPayloads {
  approval: Omit<Extract<MuxFrame, { type: 'approval/requested' }>, 'type' | 'sessionId'>
  question:  Omit<Extract<MuxFrame, { type: 'question/requested' }>, 'type' | 'sessionId'>
}
export class PendingWait<K extends PendingKind = PendingKind> {
  readonly kind: K
  readonly key: string            // `<prefix>:<rpcId>`，'a:'/'q:' 前缀，可作 React key
  readonly sessionId: SessionId
  readonly payload: PendingPayloads[K]
  respond(result): Promise<RpcReceipt>   // 回填 rpcId；已 settle 再 respond 抛错
  markSettled(): void
}
```

payload 实际形状（来自 `deepseek-harness/packages/host/apiproxy/src/api/events.ts` 的 `MuxFrame`）：

- `PendingWait<'approval'>` payload = `{ approvalId, toolName, callId?, reason? }`。
- `PendingWait<'question'>` payload = `{ questions: AskUserQuestionItem[] }`，其中 `AskUserQuestionItem = { id, question, detail?, header?, options?: {label,description?}[], multiSelect?, intent? }`（**驼峰** `multiSelect`，与 sandore wire 的 `multi_select` 不同）。

`sandore` ui 已有 `@deepseek-ai/dsh-client-runtime` 作为 peerDependency 且在 `dsh.client.inject` 中，故 `PendingWait` 可直接 import。

#### 2.2 `PendingQuestion`（域类，`@deepseek-ai/dsh-client-ui-user-questions/client`，可 import 但需补 peerDep）

文件：`deepseek-harness/packages/client/ui-user-questions/src/client/contract/slots.ts`，经 `client/index.ts` 导出：

```ts
export { PendingQuestion } from './contract/slots.ts'
export type { PlanReview, QuestionAnswer, QuestionComposerProps, QuestionWait } from './contract/slots.ts'
```

- `type QuestionWait = PendingWait<'question'>`。
- `class PendingQuestion { key; questions: QuestionWait['payload']['questions']; async answer(answer: QuestionAnswer): Promise<void>; async cancel(): Promise<void> }`。
- 注意：`PendingQuestion.answer()` 走的是 `wait.respond({ ok:true, value:{ sessionId, answer } })`（DSH 原生 `question/requested` 载体），**不是** sandore 的 `ctx.remote.sandore.replyQuestion` RPC。RunView 的问答数据源是 `getInstanceState().pendingInteractions`（`PendingQuestionEntry`），提交走 `replyQuestion({instanceId, requestId, answers})`——两者协议不同。因此「复用 PendingQuestion」= 复用 `QuestionComposer.tsx`（~100 行）的渲染/交互形态与 `AskUserQuestionItem` 类型形状，而非复用其原生 answer 载体。
- 可用性：该包的 `exports["./client"]`（浏览器半）导出这些符号；`.exports["."]`（node 半）为空 `apply`。sandore ui 的 peerDependencies **尚未包含** `@deepseek-ai/dsh-client-ui-user-questions`，要 import `PendingQuestion` 需先补该 peerDep。

#### 2.3 审批卡片 `PendingWait<'approval'>`

- `PendingWait<'approval'>`（见 2.1）可直接 import，用于驱动自写审批卡片。
- DSH 官方审批实现 `PendingApproval` 类 + `ApprovalPanel.tsx`（`deepseek-harness/packages/client/ui-conversation/src/client/contract/slots.ts` 与 `src/client/skeleton/ApprovalPanel.tsx`）**均未从 `@deepseek-ai/dsh-client-ui-conversation/client` 导出**（该入口只导出 `apply`/`inject`/`ConversationController`/`IConversation` 及一批 type）。故审批卡片须自写（task-4 设计 §1.2 已记「PendingWait<'approval'> 驱动自写审批卡片，照抄 ApprovalPanel ~50 行」）。
- 参考形状（`PendingApproval`）：`key`、`toolName`（`payload.toolName`）、`reason`（`payload.reason`）、`callId`（`payload.callId`）、`answer(outcome: 'allowed-once' | 'rejected')` → `wait.respond({ ok:true, value:{ sessionId, approvalId, outcome } })`。

### 3. `ctx.sessions.open(id)` 的客户端服务来源与 inject 声明

- 服务键 `'sessions'`，由 `@deepseek-ai/dsh-client-runtime` 提供：`SessionRuntime` 构造器内 `rootCtx.reflect.provide('sessions', this, undefined)`（`deepseek-harness/packages/client/runtime/src/client/sessions/service.ts` L348）。
- 接口 `ISessions`（`@deepseek-ai/dsh-client-runtime/client` 的 `contract/sessions.ts`）核心成员：`open(id: SessionId): void`、`list`、`currentProvideInfo`、`searchResultLimit`、`openSubagent(address)`、`subagentAddress`、`setSubagentCatalogOpen`、`refreshSubagents`、`noteAgentPreset`、`clear`、`search`、`fork`、`provide`、`scope`/`scopeOf`/`sessionOf`/`binding`。
- `SessionId` 类型：`@deepseek-ai/dsh-client-runtime/client` 再导出（源自 `@deepseek-ai/dsh-client-connection/client`）；`@deepseek-ai/dsh-session/types` 亦有。
- 参考用法（`ui-workflow-run/src/client/index.ts`）：`export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']`，并在 keyed 渲染器注入 `inject: (): WorkflowRunInjected => ({ openSession: (id: SessionId) => { ctx.sessions.open(id) } })`。
- sandore ui 现状：`client/index.ts` 的 `export const inject = ['slots', 'locale', 'remote']`——**未含 `'sessions'`**；但 `package.json` 的 `dsh.client.inject` 已含 `@deepseek-ai/dsh-client-runtime`（sessions 的提供包）。要调用 `ctx.sessions.open(instanceId)`，需在插件 `inject` 数组补 `'sessions'`。

### 4. DSH `ui-primitives` 可用于状态徽章/轨迹/产物的组件

来源：`deepseek-harness/packages/client/ui-primitives/src/index.ts`（包名 `@deepseek-ai/dsh-client-ui-primitives`，sandore ui 已列为 peerDependency）。

- `StateDot`（`{ state: StateDotState; size?: number; className? }`）；`StateDotState = 'done' | 'warning' | 'ongoing' | 'error'`（green done / amber attention / blue running chase / red error）。
- `DisclosureRow`（`icon`, `title`, `open`, `expandable`, `onToggle` 必填；`expandOnRowClick?`, `previewChevron?`, `keepContentWhenOpen?`, `collapsedContent?`, `children?` 及 `className`/`rowClassName`/`leadingClassName`/`chevronClassName`/`titleClassName`）——受控折叠行，适合 Stage→Step 分层轨迹。
- `Button`（`variant?: 'primary'|'ghost'|'outline'|'toolbar'` 默认 ghost；`size?: 'md'|'sm'`；`icon?`；透传原生 button 属性）。
- `Pill`（`active?`, `onClick?`, `className?`, `children?`）——徽章/标签 chip（visitCount 徽章可用）。
- `Modal`（`open`, `onClose`, `title`, `closeLabel?`, `description?`, `children?`, `footer?`, `className?`, `contentClassName?`, `headless?`）——portal 对话框（retryStep 填 message 可用）。
- `Input`、`Menu`（`MenuEntry`/`MenuItem`/`MenuSeparator`/`MenuLabel`）、`useAnchoredMaxHeight`、`HoverCard`、`Tooltip`/`TooltipSide`、`Toast`、`RiskConfirmation`、`OnboardingSurface`、`ConnectionBanner`。
- 内容块：`CodeBlock`（`code`, `lang?`, `className?`, `copyLabel?`, `copiedLabel?`）、`JsonBlock`、`MarkdownText`（`MarkdownCodeLabels`/`MarkdownFileMentions`）、`MessageText`、`extractMarkdownPlainText`、`JsonTree`、`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`。
- `export * from './icons/index.tsx'`（`IconBranchOutline16`、`IconPlusOutline16`、`IconChevronRightOutline14`、`IconChevronDownOutline14`、`IconCheckOutline14`、`IconCloseOutline16`、`IconEditOutline16`、`IconTrashOutline16` 等）。

### 5. ui 包现有组件范式（props 组合 / locales / css-modules）

来源：`packages/sandore/ui/src/client/`。

- **slot 组件 props 组合**（`WorkflowButton.tsx`）：`PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`；业务 face 定义为 `export interface WorkflowButtonFace { ping(): Promise<PingResponse> }`，在 `apply` 内 `ctx.slots.register({ name, id, locale: NS, inject: (): WorkflowButtonFace => sandore }, WorkflowButton)`。四共享组合类型出自 `@deepseek-ai/dsh-client-ui-slots`：`PropsRuntime`（owner + 标准 kit + global）、`InjectFace`（注册注入的 face，hooks 会被绑定）、`PropsLocale<'sandore'>`（注入 `t: TranslateNS<'sandore'>`）。
- **非 slot 子组件 props**（`WorkflowPanel.tsx` / `DagEditor.tsx`）：普通 props，`t: TranslateNS<'sandore'>` + 业务回调（`ping` / `save: SaveDefinition` / `initialYaml?`）。
- **locales**（`locales.ts`）：`export const NS = 'sandore'`；`zh` 字典 + `en satisfies Record<SandoreKey, string>`（逐键对齐，缺一编译错）；`export type SandoreKey = keyof typeof zh`；`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }`。
- **css-modules**：每组件一个 `*.module.css`，import 为 `css` 后以 `css.xxx` / `clsx(css.a, css.b)` 使用；仓库有 `css-modules.d.ts` 声明模块。`WorkflowButton` 的 `wide ? css.layer : `${css.layer} ${css.rail}`` 双态形态。
- **RPC 接线**（`client/index.ts`）：`export const inject = ['slots', 'locale', 'remote']`；`apply(ctx)` 内 `ctx.effect(() => ctx.locale.register(NS, { zh, en }), ...)`、`ctx.effect(() => ctx.remote.$mount(sandoreRemote), 'ui-sandore: remote')`、`ctx.slots.inject('sidebar.footer.action', ...)`。包名 `@deepseek-ai/dsh-client-ui-sandore`；`dsh.client.inject` = `['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-sidebar']`。

### 6. 7 态 StepStatus/DagRunStatus → StateDotState 的映射惯例

参考 `deepseek-harness/packages/client/ui-workflow-run/src/client/WorkflowRunPanel.tsx` 的 `dotState()`：

```ts
function dotState(status: WorkflowRunStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'cancelled':
    case 'interrupted': return 'warning'
    default: return status satisfies never  // 穷尽
  }
}
```

- 该参考 `WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'`（5 态，定义在 `workflow-definition.ts`），映射约定：`running → ongoing`、`completed → done`、`failed → error`、`cancelled/interrupted → warning`。
- 同文件另见文本态映射 `STATUS_KEYS: Record<WorkflowRunStatus, WorkflowRunKey>`（`status.running`/`status.completed`/`status.failed`/`status.cancelled`/`status.interrupted`），并在 `MemberRow`/`RunHeader` 中以 `<StateDot state={dotState(status)} />` + `t(STATUS_KEYS[status])` 成对渲染。
- sandore 侧为 7 态（`StepStatus`/`DagRunStatus` 各 7 值，见第 1 节），`StateDotState` 仅 4 值；sandore 目前**尚无** 7 态映射实现（`WorkflowPanel.tsx` 占位仅硬编码 `'warning'`/`'ongoing'`/`'done'` 三态演示）。

### 7. 既有 `ui/src/client/remote.ts` 的 unwrap 封装

文件：`packages/sandore/ui/src/client/remote.ts`。

- `export { sandoreRemote }`：默认导入 `@deepseek-ai/dsh-sandore-workflow/remote` 生成的 `TypertRemoteContribution`；`export type { PingResponse }`。
- `export class SandoreRemoteError extends Error`：保留 `readonly code: string` 与 `readonly details: object`（`RemoteFailure` 包装，`name = 'SandoreRemoteError'`）。
- `export function unwrap<T>(result: RemoteResult<T>): T`：`result.ok` 为 true 返回 `result.value`，否则 `throw new SandoreRemoteError(result.error)`。
- `RemoteResult<T>`/`RemoteFailure`（`@deepseek-ai/dsh-typert-protocol`）：`RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }`，`RemoteFailure = { code, message, details }`。生成端每个方法固定返回 `Promise<RemoteResult<T>>`，载波失败已折叠进 `error` 分支（无需 try/catch 载波失败），仅装配性故障（arity 不匹配 / 方法未挂载 / 缺 Context binder）仍 reject。
- 消费范式（`client/index.ts`）：`unwrap(await ctx.remote.sandore.ping())`。单测见 `remote.spec.ts`（`ok:true` 取 value；`ok:false` 抛 `SandoreRemoteError` 且保留 code/details）。

## Supplementary Exploration Result

- 配置：`experimental.websearch=true`、`experimental.context7=true`。
- 本地参考（sandore 仓库 + deepseek-harness 仓库）已完整覆盖需求理解（9 个 wire 方法签名与返回类型、`WorkflowTaskState`/`ArtifactEntry`/`RetryMode`/7 态枚举/`PendingQuestionEntry`/`PendingPermissionEntry`、`PendingWait`/`PendingQuestion`/审批卡片可用性、`ctx.sessions.open` 服务来源与 inject、ui-primitives 组件清单、ui 包组件范式、ui-workflow-run 状态映射、unwrap 封装），Phase 3 信息充足，未触发额外 websearch / context7 查询。
