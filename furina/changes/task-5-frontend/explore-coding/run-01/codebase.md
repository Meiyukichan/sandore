## Exploration Result

> 探索范围：sandore `ui` 包 RunView（执行轨迹只读视图 + 产物面板 + 交互控件 + 打开讨论）所需的技术事实。全部结论基于仓库实际代码（`packages/sandore/*`）与已安装 DSH 包（`node_modules/.pnpm/@deepseek-ai/*` 的 `lib/types` 声明）。`ui-workflow-run` 源码不在本仓库（仅 `D:\project-code\llm\deepseek-harness` 只读参考，未随 npm 安装），其结论以设计文档与既有探索记录为准并已注明。

### 1. `ctx.remote.sandore` wire 类型（item 1）

**接线方式**（已落地）：`workflow` 包构建产物 `lib/typert.remote-client.d.ts` 通过 `declare module '@deepseek-ai/dsh-typert-protocol'` 注入 `TypertRemoteNamespace$73616e646f7265` / `TypertRemoteMap` / `TypertRemoteNamespaceMap`，默认导出 `TypertRemoteContribution`（`TYPERT_REMOTE`）。`ui/src/client/index.ts` 的 `apply(ctx)` 内 `ctx.remote.$mount(sandoreRemote)` 挂载后，调用面为 `ctx.remote.sandore.<method>(...)`，每个方法返回 `Promise<RemoteResult<T>>`（`{ok:true,value}|{ok:false,error}`，见 item 7）。

**与 RunView 直接相关的 RPC 签名**（客户端生成面，`lib/typert.remote-client.d.ts`）：

| 方法 | 客户端签名 |
|---|---|
| `getInstanceState` | `(instanceId: string) => Promise<RemoteResult<unknown>>`（注意：生成面为 `unknown`，非 `WorkflowTaskState`；Host 端实际返回 `WorkflowTaskState`，见 `remote.ts` `requireInstanceState`） |
| `getArtifacts` | `(instanceId: string, stageId?: string) => Promise<RemoteResult<ArtifactEntry[]>>` |
| `abortInstance` | `(instanceId: string) => Promise<RemoteResult<void>>` |
| `pauseAll` | `(input: { instanceId: string }) => Promise<RemoteResult<void>>` |
| `resumeAll` | `(input: { instanceId: string; resumePrompt?: string }) => Promise<RemoteResult<void>>` |
| `pauseStep` | `(input: { instanceId: string; stepId: string }) => Promise<RemoteResult<void>>` |
| `resumeStep` | `(input: { instanceId: string; stepId: string; resumePrompt?: string }) => Promise<RemoteResult<void>>` |
| `retryStep` | `(input: { instanceId: string; stepId: string; mode: 'continue' \| 'revert' \| 'fork'; message: string }) => Promise<RemoteResult<void>>` |
| `replyQuestion` | `(input: { instanceId: string; requestId: string; answers: unknown }) => Promise<RemoteResult<void>>`（生成面 `answers: unknown`；Host zod 为 `{ answers: { id: string; selected: string[]; custom?: string }[] }`，见 `remote.ts` `ReplyQuestionInputSchema`） |
| `replyPermission` | `(input: { instanceId: string; requestId: string; reply: 'once' \| 'always' \| 'reject' }) => Promise<RemoteResult<void>>` |

**wire 返回类型**（Host 侧，`workflow/src/remote.ts` + `workflow/src/schema.ts` + `workflow/src/types.ts`）：

- `WorkflowTaskState`（`schema.ts` `WorkflowTaskStateSchema` 的 `z.infer`）：`{ taskId, jobId, workflowId, cwd, status: DagRunStatus, originalInput, currentStageId, executedSteps: ExecutedStepDefault[], stageInfos: StageInfo[], pendingInteractions: (PendingQuestionEntry | PendingPermissionEntry)[], pendingQueue, visitCounts, passThroughVars, activeLoopIterationStack, activeLoopNodeId, activeLoopStack, pausedChildIds, stageContracts: Record<string, StageContract>, createdAt, updatedAt }`。
- `ArtifactEntry`（`remote.ts` wire 类型，从 `stageContracts` 产物契约扁平化）：`{ stepId, stageId, outputToId?, files: string[], returnPrompt? }`。
- `RetryMode = 'continue' | 'revert' | 'fork'`（`workflow/src/recovery-manager.ts:34`，与 wire `retryStep` 入参 `mode` 的 zod 枚举一致）。
- `ExecutedStepDefault`（`types.ts`）：`{ type: 'default', id, stepId?, stageId, name, status: StepStatus, command?, inputFrom?, outputTo?, passThroughVars?, sessionMeta?, finalizeMeta?, visitCount, branchMeta?, error?, pausedAt?, resumedAt?, resumePrompt?, sessionMessages?, pauseEntryId?, loopIteration?, loopMeta?, retryHistory?, parentSessionId?, output?: ContentBlock[] }`。
- `StageInfo`：`{ id, name, status: StepStatus }`。
- `StageContract`：`{ stageId, stageName, status: StepStatus, artifacts: { stepId, outputToId, files, returnPrompt? }[], passThroughVars, contractArtifacts, completedAt, errorDetail? }`。
- `StepStatus = 'blocked' | 'ready' | 'interacting' | 'running' | 'completed' | 'failed' | 'paused'`（7 态，`types.ts:165` + `schema.ts:18`）。
- `DagRunStatus = 'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'`（7 态，`types.ts:111` + `schema.ts:21`）。
- `PendingQuestionEntry`（`schema.ts` `PendingQuestionEntrySchema`）：`{ id, stageId, stepId, sessionId, requestId, kind: 'question', status: 'pending' | 'replied' | 'rejected', payload: AskUserQuestionPayload, answer?: string[][], createdAt }`。`AskUserQuestionPayload = { questions: { id, question, header?, options?: { label, description? }[], multi_select? }[] }`——注意字段为 **snake_case `multi_select`**（`schema.ts:195-207`）。
- `PendingPermissionEntry`（`schema.ts` `PendingPermissionEntrySchema`）：`{ id, stageId, stepId, sessionId, requestId, kind: 'permission', status, payload: { permission, patterns?, metadata?, tool? }, answer?: 'once' | 'always' | 'reject', createdAt }`。

**Host 侧转发目标**（`workflow/src/engine-surface.ts`，均 `Promise<void>`）：`abortInstance(instanceId)` / `replyQuestion(instanceId, requestId, answers: AskUserQuestionAnswer)` / `replyPermission(instanceId, requestId, reply)` / `pauseStep(instanceId, stepId)` / `resumeStep(instanceId, stepId, resumePrompt?)` / `pauseAllSteps(instanceId)` / `resumeAllSteps(instanceId, resumePrompt?)` / `retryStep(instanceId, stepId, mode, message)`。RPC 层仅 zod 校验 + 转发，无业务逻辑。

**浏览器侧类型导入路径**（ui 包可用）：`@deepseek-ai/dsh-sandore-workflow/schema`（`package.json` 导出 `./schema` → `src/schema.ts`，浏览器安全，仅依赖 zod）与 `@deepseek-ai/dsh-sandore-workflow/types`（→ `lib/types/types.d.ts`）。`WorkflowTaskState`/`StepStatus`/`DagRunStatus`/`ExecutedStepDefault`/`StageInfo`/`StageContract`/`PendingQuestionEntry`/`PendingPermissionEntry` 均由 `schema.ts` `export type` 派生；由于生成 wire 面把 `getInstanceState` 返回标为 `unknown`，组件层需以 `./schema`/`./types` 的类型对 `unwrap` 结果收窄。

### 2. pendingInteractions 问答/权限的复用组件（item 2）

**核心事实：`PendingQuestion` 组件不存在；`ui-user-questions` 不是客户端 UI 包。**

- `@deepseek-ai/dsh-user-questions`（本仓库已装，`node_modules/.pnpm/@deepseek-ai+dsh-user-quest_*/node_modules/@deepseek-ai/dsh-user-questions`）：是 **Node 侧 seam**（`ctx.userQuestions`，`UserQuestionService` + `UserQuestionProvider`），提供 UI-backed 提问能力；**不包含任何 React 渲染组件**。其 wire 安全类型（`./types` 子路径）可 import：`AskUserQuestionItem` / `AskUserQuestionOption` / `AskUserQuestionIntent` / `AskUserQuestionAnswer` / `AskUserQuestionAnswerItem`。注意 `AskUserQuestionItem` 用 **camelCase `multiSelect`**，与 sandore `AskUserQuestionPayload` 的 snake_case `multi_select` 不一致。
- **`PendingWait<K>` 类存在**，从 `@deepseek-ai/dsh-client-runtime` 导出（`lib/types/client/index.d.ts` `export { PendingWait } from './sessions/pending.ts'`），且 `PendingWait<'question'>` / `PendingWait<'approval'>` 是其两个具体泛型实例（经 `PendingInteraction`/`PendingKind`）。成员：`readonly kind`、`readonly key`（`<prefix>:<rpcId>`）、`readonly sessionId`、`readonly payload`、`respond(result: ClientResponse['result']): Promise<RpcReceipt>`、`markSettled()`。
  - `PendingPayloads = { approval: Omit<approval/requested, 'type'|'sessionId'>, question: Omit<question/requested, 'type'|'sessionId'> }`，即 `approval = { approvalId: ApprovalRequestId, toolName, callId?, reason? }`、`question = { questions: AskUserQuestionItem[] }`（源自 `dsh-host-apiproxy` 的 `MuxFrame`）。
  - 应答载荷：`QuestionResponsePayload = { sessionId, answer: AskUserQuestionAnswer }`、`ApprovalResponsePayload = { sessionId, approvalId, outcome: 'allowed-once' | 'rejected' }`（`dsh-host-apiproxy/lib/types/api/{questions,approvals}.d.ts`）。
  - `@deepseek-ai/dsh-user-approval`：`ApprovalRequestId = Branded<'ApprovalRequestId'>`、`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`。
- **真正渲染问答/审批卡片的 React 组件未随 npm 安装**：全仓库 node_modules 中不存在消费 `PendingWait` 的渲染组件（它们属于 DSH web renderer host 的包内私有实现）。因此「复用 `ui-user-questions` 的 `PendingQuestion` + `PendingWait`」这一既往探索表述需修正为：**仅 `PendingWait<'question'>`/`PendingWait<'approval'>` 的数据面（来自 `@deepseek-ai/dsh-client-runtime`）可 import；`PendingQuestion` 组件不可 import**。
- **机制区分**：`PendingWait` 是「会话级 mux pending 队列」的等待对象（经 `PendingWait.respond()` 应答），与 sandore 自身的 `WorkflowTaskState.pendingInteractions`（经 `ctx.remote.sandore.replyQuestion`/`replyPermission` 应答）是**两套独立体系**。RunView 的交互控件（`specs/run-view/spec.md` §19-24）走的是后者：渲染 `pendingInteractions` 的 `PendingQuestionEntry`/`PendingPermissionEntry`，提交经 `replyQuestion`/`replyPermission`；`PendingWait` 体系属 `conversation.chat.node` 讨论面板（D8），由 DSH 原生消息 UI 承载，不折叠为 `sandore-step` 节点（`design.md` D-5）。

### 3. `ctx.sessions.open(id)` 来源与 inject（item 3）

- `ctx.sessions: ISessions`：由 `@deepseek-ai/dsh-client-runtime` 经 `declare module '@deepseek-ai/cordis' { interface Context { sessions: ISessions } }` 声明（`lib/types/client/index.d.ts:115`），具体由 `SessionRuntime`（`lib/types/client/sessions/service.d.ts`，`implements ISessions`）提供，运行时 `apply(ctx)` 内 `ctx.get("sessions")`（`lib/client.js:267`）表明它是 cordis 服务。
- `open` 签名：`ISessions.open(id: SessionId): void`（`lib/types/client/contract/sessions.d.ts:35`，`@param id` 必须已在列表中，未知 id fail loud）。
- `SessionId` 类型：`Branded<'SessionId'>`（`@deepseek-ai/dsh-session/types`），经 `@deepseek-ai/dsh-api-remotes/client` 再导出（其又转自 `@deepseek-ai/dsh-client-connection/client`）。
- **ui 包现有 inject 状态**：`ui/src/client/index.ts` 顶层 `export const inject = ['slots', 'locale', 'remote']`——**不含 `'sessions'`**。但 `@deepseek-ai/dsh-client-runtime` 已在 `ui/package.json` 的 `dsh.client.inject` 列表里（`['@deepseek-ai/dsh-api-remotes','@deepseek-ai/dsh-client-runtime','@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-ui-sidebar']`），故 `ctx.sessions` 运行时可用。既有代码只在 slot 注册闭包内访问 `ctx`（设计 D-5 范式：`ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ ... inject: () => ({ openSession: id => ctx.sessions.open(id) }) }, DagStepNodeView))`），未在顶层 `inject` 数组声明 `sessions`。RunView 的「打开讨论」按钮按 `specs/run-view/spec.md` §38-39 调 `ctx.sessions.open(instanceId)`（宿主 Session id == instanceId）。

### 4. DSH `ui-primitives` 可用组件（item 4）

包：`@deepseek-ai/dsh-client-ui-primitives`（ui 包 peerDependencies 已有；`lib/types/index.d.ts` 全量导出）：

- `StateDot` + `StateDotState = 'done' | 'warning' | 'ongoing' | 'error'`（props `{ state, size?=10, className? }`，aria-hidden，需配文本）。
- `DisclosureRow` + `DisclosureRowProps`（`{ icon, title, open, expandable, onToggle, expandOnRowClick?, previewChevron?, keepContentWhenOpen?, collapsedContent?, children?, className?, rowClassName?, leadingClassName?, chevronClassName?, titleClassName? }`）——RunView 轨迹行/Stage 分组的折叠外壳。
- `Button` + `ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'`（props `{ variant?='ghost', size?: 'md'|'sm', icon?: ReactNode, className?, children?, ...ButtonHTMLAttributes }`）。
- `Pill`（`{ active?, className?, children? } & ButtonHTMLAttributes`）。
- `Input`（`{ icon?, className? } & InputHTMLAttributes`）。
- `Modal`（`{ open, onClose, title, closeLabel?, description?, children?, footer?, className?, contentClassName?, headless? }`，返回 `ReactPortal | null`）——重试 message 输入/审批确认候选。
- `CodeBlock` + `CodeBlockProps`（`{ code, lang?, className?, copyLabel?, copiedLabel? }`）——YAML/产物文本展示。
- 其它：`Menu`、`useAnchoredMaxHeight`、`HoverCard`、`OnboardingSurface`、`RiskConfirmation`、`ConnectionBanner`、`FishLogo`、`BrandWordmark`、`Tooltip`、`Toast`、`writeClipboard`、`JsonTree`、`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`、`JsonBlock`、`MarkdownText`、`MessageText`、`extractMarkdownPlainText`、`export * from './icons/index.tsx'`。
- 图标（RunView 相关）：`IconPauseOutline16`、`IconPlayOutline16`、`IconStopFill16`、`IconRefreshOutline16`/`IconRefreshOutline14`、`IconBranchOutline16`、`IconTrashOutline16`、`IconChevronDownOutline14`、`IconChevronRightOutline14`、`IconQuestionOutline14`、`IconCheckOutline16`、`IconCloseOutline16`、`IconWarningOutline16`、`IconCodeOutline16`、`IconLinkOutline16`、`IconRightUpOutline14`/`16`、`IconPlusOutline16`。

### 5. ui 包现有组件范式（item 5）

以 `WorkflowButton.tsx` / `WorkflowPanel.tsx` / `DagEditor.tsx` / `locales.ts` / `sandore-save.ts` / `dag-editor-model.ts` 为准：

- **props 组合**：slot 组件用 `PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`（`WorkflowButtonProps`）。`InjectFace`/`PropsLocale`/`PropsRuntime` 来自 `@deepseek-ai/dsh-client-ui-slots`；`PropsRuntime` 含 `OwnerOf & KeyPropsOf & SlotInjectFace & (scope 标准 props) & GlobalStandardProps`（`GlobalStandardProps = { useSessions, useWorkspaces }`，`SessionStandardProps = { useSession, sessionId, useProjection }`）。**非 slot 组件**（`WorkflowPanel`/`DagEditor`/未来 `RunView`）用普通接口 props：`{ t: TranslateNS<'sandore'>; ping(): Promise<PingResponse> }` / `{ t, initialYaml?, initialId?, save: SaveDefinition }`。
- **face 注入**：注册处 `ctx.slots.register({ name, id, locale: NS, inject: (): Face => ({ ping: async () => unwrap(await ctx.remote.sandore.ping()) }) }, Component)`。组件只接收已解包的 RPC 回调，不直接碰 `ctx.remote`。
- **locales**：`NS = 'sandore'`；`zh`/`en` 字典（`en` 用 `satisfies Record<SandoreKey, string>` 强制与 `zh` 逐键对齐）；`export type SandoreKey = keyof typeof zh`；`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sandore: SandoreKey } }`；`TranslateNS<'sandore'>` 类型化 `t`。
- **css-modules**：`import css from './X.module.css'`，`css.xxx` 使用，多类名模板串拼接（`` `${css.layer} ${css.rail}` ``）；`src/css-modules.d.ts` 声明 `*.module.css`/`*.css` 返回 `Record<string,string>`；颜色走 `var(--dsw-*)` token。
- **本地状态机**：`useState` + discriminated union（`PingState = idle|pending|ok|error`、`SaveState = idle|pending|ok|error`）。
- **测试锚点**：`data-sandore-btn` / `data-sandore-panel` / `data-sandore-dag-editor`。
- **可测逻辑外提**：无 React 依赖的纯逻辑（`dag-editor-model.ts`、`sandore-save.ts`）单独成模块并配 `.spec.ts`（vitest）；`remote.ts` 的 `unwrap`/`SandoreRemoteError` 有 `remote.spec.ts`。
- **错误归一化**：`describeSaveError` 把 `SandoreRemoteError`（取 `.details`）/`WorkflowYamlError`（取 `.code`/`.cause`）/zod issues 归一为 `{ message, details? }`。

### 6. 7 态 StepStatus/DagRunStatus → StateDotState 映射惯例（item 6）

- 仓库内 **尚无** StepStatus/DagRunStatus → StateDotState 的映射函数（RunView 尚未实现）。现有 `WorkflowPanel.tsx` 仅用三态占位（`warning/ongoing/done` 对应 ready/running/completed）。
- `StateDotState` 仅 4 值：`'done' | 'warning' | 'ongoing' | 'error'`（绿完成/琥珀用户注意/蓝运行环/红错误）。
- 待映射的 7 态：`StepStatus = blocked|ready|interacting|running|completed|failed|paused`；`DagRunStatus = pending|running|interacting|completed|failed|aborted|paused`。
- **仅有的映射先例**（DSH `ui-workflow-run` 的 `dotState(status)`，记录于本仓库既往探索 `furina/changes/task-5-frontend/explore-coding/editor-01/reference.md:144` 与 `specification.md:271`）：`running→ongoing`、`completed→done`、`failed→error`、`cancelled/interrupted→warning`。但 `ui-workflow-run` 的状态词汇是 **5 态**（`running/completed/failed/cancelled/interrupted`），与 sandore 的 7 态不构成一一对应；sandore 的 7 态需自行折入 4 个 StateDotState（无现成权威映射可抄，`ui-workflow-run` 源码不在本仓库）。

### 7. `ui/src/client/remote.ts` unwrap 封装（item 7）

- `unwrap<T>(result: RemoteResult<T>): T`：`ok:true` 返回 `result.value`，`ok:false` 抛 `SandoreRemoteError`。
- `SandoreRemoteError extends Error`：`readonly code: string`、`readonly details: object`（`RemoteFailure` 的 `Error` 子类包装，保留 code/details）。
- 依赖类型（`@deepseek-ai/dsh-typert-protocol/types`）：`RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }`；`RemoteFailure = { code: string; message: string; details: object }`。
- 文件同时 `export { sandoreRemote }`（从 `@deepseek-ai/dsh-sandore-workflow/remote` 默认导入的 `TypertRemoteContribution`）并 `export type { PingResponse }`；组件层经 `unwrap(await ctx.remote.sandore.<method>())` 统一解包，不静默吞错（载波层故障已折叠进 error 分支，仅装配性故障仍 reject）。

## Supplementary Exploration Result

以下为 Phase 4 补充（Grep/Read 手动核实），覆盖 Phase 3 未达的关键点：

- **RunView 权威规格**（`furina/changes/task-5-frontend/specs/run-view/spec.md`）：轨迹只读视图（`getInstanceState` 按 `stageInfos` 分组渲染 `executedSteps[]`，Step 含 7 态图标/名称/`visitCount` 徽章/`error`）；产物面板（`getArtifacts`，running 时 5s 轮询、终态停）；交互控件（实例级 `abortInstance`/`pauseAll`/`resumeAll`，Step 级 `pauseStep`/`resumeStep`/`retryStep`，问答 `replyQuestion`、权限 `replyPermission`，动作后立即手动刷新）；「打开讨论」`ctx.sessions.open(instanceId)`；实例状态 5s 轮询（运行中）。
- **RunView 承载**（`design.md` D-4 + `specs/workflow-panel/spec.md` §27-40）：不新增 slot；WorkflowPanel 内部 view 状态栈 `list ↔ editor ↔ run`，下钻态宽展开 layer。
- **挂载固化**（`design.md` D-8）：ui 包 `dsh.client.inject` 需补 `@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-ui-conversation`；`@deepseek-ai/dsh-client-ui-primitives` 为直 import 的 peer 依赖（非服务提供方，不入 inject）。
- **workflow 包公开导出**（`src/index.ts`）：`export * from './schema.ts'`（含全部 zod 派生类型）、`export type * from './types.ts'`、`export * from './remote.ts'`；`./schema`/`./yaml` 为浏览器安全子路径（`package.json` exports），ui 包已在 `DagEditor.tsx` 中以 `@deepseek-ai/dsh-sandore-workflow/schema`、`.../yaml` 直接 import。
