## Exploration Result

`furina config show project.sourcecode codebases` 返回：

```
project.sourcecode=src/
codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]
```

`docs/codebase` 目录为空（0 个文件），无任何可探索产物。项目实际为 pnpm monorepo，`project.sourcecode=src/` 并不存在于仓库根（源码位于 `packages/sandore/` 下）。故 Phase 3 的 furina-codebase 探索无返回，本次探索全部经由 Phase 4 补充探索（Grep/Glob/Read）完成。

## Supplementary Exploration Result

### 0. 项目结构定位

- 根目录：`D:/project-code/llm/sandore`（pnpm monorepo，`pnpm-workspace.yaml` 指向 `packages/*`）
- sandore 包位于 `packages/sandore/` 下四个子包：
  - `microflow/`（microflow 引擎）
  - `tool/`
  - `workflow/`（引擎 + schema + Host RPC，包名 `@deepseek-ai/dsh-sandore-workflow`）
  - `ui/`（本次探索目标，包名 `@deepseek-ai/dsh-client-ui-sandore`）
- `ui` 包浏览器入口：`packages/sandore/ui/src/client/index.ts`（经 `package.json` 的 `exports["./client"]` 与 `dsh.client` 声明被发现加载）。`ui/src/index.ts` 是空 Node 半（`export function apply(): void {}`）。
- `ui` 包 `package.json` 的 peerDependencies 中可用依赖：`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-sidebar`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-sandore-workflow`（workspace:*）、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-api-remotes`、`react`。

---

### 1. WorkflowButton.tsx / WorkflowPanel.tsx 现有 props 组合与 store 模式

文件：
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/WorkflowButton.tsx`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/WorkflowPanel.tsx`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/index.ts`（`apply` 注册逻辑）

#### 1.1 注册入口（client/index.ts）

```ts
export const inject = ['slots', 'locale', 'remote', 'sessions']   // 依赖的 cordis 服务键

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sandore: dictionaries')
  ctx.effect(() => ctx.remote.$mount(sandoreRemote), 'ui-sandore: remote')

  const sandore = {
    ping: async (): Promise<PingResponse> => unwrap(await ctx.remote.sandore.ping()),
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'sandore-btn',
    locale: NS,
    inject: (): WorkflowButtonFace => sandore,
  }, WorkflowButton))
}
```

要点：
- 插件 `inject` 声明了 `'sessions'`（已有），故 `ctx.sessions` 可用；`'remote'` 挂载 `sandoreRemote` 后 `ctx.remote.sandore.*` 命名空间就绪。**注意**：当前未声明 `'workspaces'`，若要 `ctx.workspaces` 需加入 inject 数组（但 `useWorkspaces` 走的是 `PropsRuntime` 的全局标准 seat，不经 `ctx.workspaces`，见 §2.4）。
- 注册用 `ctx.slots.register({...}, WorkflowButton)`，通过 `ctx.slots.inject('sidebar.footer.action', callback)` 包裹——callback 里调用 `register`，其 disposer 经 caller 的 ctx.effect 绑定插件 fiber，卸载时自动逆序清理。
- 注册选项里 `locale: NS` 使组件拿到类型化 `t`；`inject: () => sandore` 提供业务 face。

#### 1.2 `sidebar.footer.action` slot 契约（dsh-client-ui-sidebar）

来源：`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`

```ts
'sidebar.footer.action': {
  kind: 'list';
  scope: 'root';
  owner: SidebarFooterActionOwnerProps;   // { wide: boolean }
}
```

- `kind: 'list'`：注册必须给 `id`（当前为 `'sandore-btn'`）；同 id 同 priority 第二次注册会 throw。
- `scope: 'root'`：非 session 作用域，`PropsRuntime` 不含 `useSession`/`sessionId`，但**含 `GlobalStandardProps`（`useSessions`/`useWorkspaces`）**。
- **未声明 `inject`**：即 slot 级无公共 inject face，`SlotInjectOf<'sidebar.footer.action'> = object`；inject face 完全由注册方（sandore）提供。
- **未声明 `hookContext`**。
- owner props 仅 `wide: boolean`。

#### 1.3 WorkflowButton 的 props 组合

```ts
export interface WorkflowButtonFace {
  ping(): Promise<PingResponse>
}
export type WorkflowButtonProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>

export function WorkflowButton({ wide, ping, t }: WorkflowButtonProps) { ... }
```

展开后 `WorkflowButtonProps` 实际为（类型来自 ui-slots 的 `PropsRuntime`/`InjectFace`/`PropsLocale` 定义）：

- `wide: boolean`（owner）
- `useSessions: SnapshotSelectorHook<SessionListState>`（GlobalStandardProps）
- `useWorkspaces: SnapshotSelectorHook<WorkspaceListState>`（GlobalStandardProps）
- `ping(): Promise<PingResponse>`（`InjectFace<WorkflowButtonFace>`；face 无 `hooks` 槽，故 `InjectFace<I> = I`）
- `t: TranslateNS<'sandore'>`

当前组件只解构了 `{ wide, ping, t }`，**未使用 `useSessions`/`useWorkspaces`**——这是新 WorkflowPanel 复用这两个能力的位置。

#### 1.4 WorkflowPanel 现状

`WorkflowPanel({ t, ping }: WorkflowPanelProps)`（`WorkflowPanelProps = { t: TranslateNS<'sandore'>; ping(): Promise<PingResponse> }`）：

- 纯本地 `useState`：`orchestrating`（编排 toggle）、`pingState`（PingState 四态：idle/pending/ok/error）。
- 渲染 `section[data-sandore-panel]`：header（title + orchestrating checkbox + 新增 Button）+ body（`panel.list.heading` 三态占位列表 + ping 验证）。
- 三态占位列表为硬编码常量 `PLACEHOLDER_ROWS`：每行 `{ id, name, state: StateDotState, statusKey: SandoreKey }`，用 `StateDot state` 渲染（state 取 `'warning'|'ongoing'|'done'`）。
- **没有任何 store**（无 `createPanelStore`、无 `defineStore`、无 `ctx.slots.register({store})`）——当前所谓“store 模式”就是组件内 `useState`。sandore ui 包全局也搜不到 `createPanelStore`/`defineStore`/`persist`/`useSessions`/`useWorkspaces` 任何使用。

#### 1.5 `StateDot` / `StateDotState`

来源：`dsh-client-ui-primitives/lib/types/StateDot.d.ts`

```ts
export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error'
```

`run-view-model.ts` 已有 7 态 → 4 态映射（`runDotState`/`stepDotState`），可作为实例三态/四态列表的现成纯函数复用（见 §3.3）。

---

### 2. `ctx.slots.register` 的 store 选项 与 `PropsRuntime<'sidebar.footer.action'>` 能力

#### 2.1 register 的 store 选项（ui-slots 契约）

来源：`dsh-client-ui-slots/lib/types/index.d.ts`（`BaseOptions`）与 `lib/types/store.d.ts`

`register` 选项中的 store 座位：

```ts
store?: H   // H = StoreDecl = StoreHandle<any, any> | StoreFactory
// StoreFactory = () => StoreHandle<any, any>
```

`StoreHandle<T, A>` 结构（`store.d.ts`）：

```ts
interface StoreSpec<T, A extends ActionsDecl<T>> {
  init: () => T
  persist?: string          // 持久化键（localStorage）
  actions: A                // immer-draft 变更集
}
interface StoreHandle<T, A> {
  readonly spec: StoreSpec<T, A>
  create(scopeKey?: string): StoreInstance<T, A>   // scopeKey = session id（session 作用域）
}
// ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>
```

组件侧（`PropsStore<H>`）拿到：

```ts
{ useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A> }
```

`BakedActions` 去掉 draft 首参（框架已绑定实例）。**组件看不到实例本身**：读走 `useStore`，写只能走声明的 `actions`。

声明了 store 的注册，其 `inject` 工厂会额外收到 `actions` 参数（`InjectParams`）：root 作用域且声明 store 时签名 `[actions: BoundActions<HandleOf<H>>]`；root 作用域无 store 时 `[]`（当前 sandore 即此形态）。

#### 2.2 `defineStore` 运行时实现

来源：`dsh-client-runtime/lib/types/client/contract/store.d.ts`（实现即 `lib/client.js`）

```ts
export declare function defineStore<T, A extends ActionsDecl<T>>(
  decl: StoreSpec<T, A> & { actions: A & ActionsDecl<T> }
): EngineStoreHandle<T, A>
// EngineStoreHandle<T,A> extends StoreHandle<T,A>，create() 返回 EngineStoreInstance<T,A>（多带 store: SnapshotStore<T>）
```

导出位置：`@deepseek-ai/dsh-client-runtime/client`（`lib/types/client/index.d.ts` 里 `export { createSnapshotStore, defineStore, shallowEqual } from './contract/store.ts'`）。同包还导出 `createSnapshotStore<T>(init, opts?: {flush?:'raf'|'sync'; persist?:{name:string}})` 与 `shallowEqual`。

关键语义（来自 store.d.ts JSDoc）：
- `persist` 键是 localStorage 存储身份；session 作用域实例的 persist key 会追加 scopeKey（session id），root 作用域不追加。
- 同一 handle × scope key 只缓存一个实例（框架保证生产安全）。
- `defineStore` 的 `actions: A & ActionsDecl<T>` 交叉位置是“load-bearing”：T 从 `init` 第一轮推断出，交叉再上下文类型化每个 mutator 的 draft 参数，调用点写 `(d, x: X) => {...}` 无需标注 draft。

**没有 `createPanelStore` 这个 API**——探索中未在任何 sandore/DSH 包发现；`defineStore` 就是 `ctx.slots.register({ store })` 持久化的等价/标准能力。sandore 若需持久化面板 store，可 `const panelStore = defineStore({ init, persist, actions })` 后经 register `store: panelStore`（shared handle）或 `store: () => panelStore`（factory）注入。

#### 2.3 SlotRegistry 服务面（`ctx.slots`）

来源：`dsh-client-runtime/lib/types/client/slots.d.ts`

`ctx.slots` 类型为 `SlotRegistry`，主要方法：
- `register`（两个重载，同 SlotCore，含 store/inject/children/locale）
- `inject(key, callback): () => void`（对某 slot 每个 declaration 生命周期装一个 effect）
- `install/installLocale/renderSlot/snapshot/spec/entries/entriesOfSlot/subscribe/getVersion/onEntryError/pruneStoreScope(sessionId)`

register 的 disposer 经 caller 的 `ctx.effect` 绑定 fiber（`slots.inject('sidebar.footer.action', () => ctx.slots.register(...))` 正是这个惯用法）。

#### 2.4 `PropsRuntime<'sidebar.footer.action'>` 提供的 `useSessions` / `useWorkspaces`

来源：`dsh-client-runtime/lib/types/client/index.d.ts` 对 `@deepseek-ai/dsh-client-ui-slots` 的 module augmentation：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    useSessions: SnapshotSelectorHook<SessionListState>
    useWorkspaces: SnapshotSelectorHook<import('./workspaces/service.ts').WorkspaceListState>
  }
}
```

`PropsRuntime<K>` 定义（ui-slots `index.d.ts`）= `OwnerOf<K> & KeyPropsOf<K,EntryKey> & SlotInjectFace<SlotInjectOf<K>> & (scope 相关标准 seat) & GlobalStandardProps`。对 `'sidebar.footer.action'`（root scope）即：

```
{ wide } & {} & {} & {} & { useSessions; useWorkspaces }
```

Selector hook 签名（`SnapshotSelectorHook<T>`）：

```ts
type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S
```

##### `SessionListState`（useSessions 返回快照）

来源：`dsh-client-runtime/lib/types/client/sessions/service.d.ts`

```ts
interface SessionListState {
  ids: SessionId[]
  byId: Record<SessionId, SessionSummary>
  current: SessionId | undefined
  phase: SessionListPhase                       // 'pending' | 'ready'
  subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>
  jobsBySession: Readonly<Record<SessionId, readonly JobView[]>>
  currentAddress: SubagentAddress | undefined
}

interface SessionSummary {
  id: SessionId
  title?: string
  displayTitle: string
  cwd?: string                                  // 会话工作目录（→ 分组到 workspace 的锚点）
  agentPreset?: string
  parentId?: SessionId
  origin?: 'subagent'
  running: boolean
  pendingInteraction?: PendingInteractionStatus
  completed?: boolean
  blank: boolean
  updatedAt: number
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}
```

另：`service.d.ts` 导出 `workspaceTitleOf(cwd: string): string`（从 cwd 路径取 basename 作为 workspace 展示标题的仓库级唯一派生）。

##### `WorkspaceListState`（useWorkspaces 返回快照）

来源：`dsh-client-runtime/lib/types/client/workspaces/service.d.ts`

```ts
interface WorkspaceListState {
  items: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
  state: 'idle' | 'loading' | 'error'
  phase: WorkspaceListPhase                    // 'pending' | 'ready'
  error: RpcError | null
  baselinesReady: boolean
  recentWorkspaceId: WorkspaceId | undefined
}
```

##### `WorkspaceView`（分组数据）

来源：`dsh-host-apiproxy/lib/types/api/workspace.d.ts`（经 `dsh-api-remotes/client` 再导出）

```ts
type WorkspaceId = Branded<'WorkspaceId'>
interface WorkspaceView {
  workspaceId: WorkspaceId
  path: string                    // 规范目录路径
  title: string                   // 展示标题（默认 path basename）
  sessionIds: SessionId[]         // 归属该 workspace 的 session 账号（有序）
  createdAt: string
  updatedAt: string
}
```

“按工作区分组”的两条数据通路（对实例 `instanceId` == 宿主 Session id）：
1. `useWorkspaces` 的 `items[].sessionIds.includes(instanceId)` → 命中某 workspace 分组，未命中 → 未分组。
2. `useSessions` 的 `byId[instanceId]?.cwd` → `workspaceTitleOf(cwd)` 推导标题。

---

### 3. DagEditor.tsx / RunView.tsx props 接口 与 保存/讨论 adapter 签名

#### 3.1 DagEditor（`packages/sandore/ui/src/client/DagEditor.tsx`）

```ts
export interface DagEditorProps {
  t: TranslateNS<'sandore'>
  initialYaml?: string | undefined      // 省略 → 新建（createBlankDefinition()）
  initialId?: string | undefined        // 省略 → 新建（首次保存后由 save 回填）
  save: SaveDefinition
}
```

- `save` 类型 `SaveDefinition`（来自 `sandore-save.ts`）：`(id: string | undefined, yaml: string) => Promise<string>`，返回持久化后的 id；`id === undefined` 时新建（createDefinition）、否则 updateYaml。
- 内部：`useState<WorkflowDefinition>`（initialYaml 为空用 `createBlankDefinition()`，否则 `parseWorkflowYaml`）、`useState<string|undefined>(id)`、保存后 `withDefinitionId` 回填真实 id。
- 保存错误经 `describeSaveError` 归一化展示。

#### 3.2 RunView（`packages/sandore/ui/src/client/RunView.tsx`）

```ts
export interface RunViewProps {
  t: TranslateNS<'sandore'>
  instanceId: string                      // 宿主 Session id == instanceId
  openDiscussion: () => void              // → ctx.sessions.open(instanceId)
  remote: RunViewRemote
}

export interface RunViewRemote {          // ctx.remote.sandore 的最小访问面（返回 RemoteResult，经 unwrap）
  getInstanceState(instanceId: string): Promise<RemoteResult<unknown>>
  getArtifacts(instanceId: string, stageId?: string): Promise<RemoteResult<ArtifactEntry[]>>
  abortInstance(instanceId: string): Promise<RemoteResult<void>>
  pauseAll(input: { instanceId: string }): Promise<RemoteResult<void>>
  resumeAll(input: { instanceId: string; resumePrompt?: string }): Promise<RemoteResult<void>>
  pauseStep(input: { instanceId: string; stepId: string }): Promise<RemoteResult<void>>
  resumeStep(input: { instanceId: string; stepId: string; resumePrompt?: string }): Promise<RemoteResult<void>>
  retryStep(input: { instanceId: string; stepId: string; mode: RetryMode; message: string }): Promise<RemoteResult<void>>
  replyQuestion(input: { instanceId: string; requestId: string; answers: unknown }): Promise<RemoteResult<void>>
  replyPermission(input: { instanceId: string; requestId: string; reply: 'once' | 'always' | 'reject' }): Promise<RemoteResult<void>>
}
```

RunView 是普通 props 组件（非 slot 子组件），供 WorkflowPanel 下钻承载；`getInstanceState` 生成 wire 面被标为 `unknown`，运行时强转 `as WorkflowTaskState`。运行中每 5s 轮询。

#### 3.3 `sandore-save.ts` / `open-discussion.ts`

`packages/sandore/ui/src/client/sandore-save.ts`：

```ts
export interface SandoreSaveRemote {
  createDefinition(input: { yaml: string }): Promise<RemoteResult<WorkflowDefinitionEntry>>
  updateYaml(id: string, yaml: string): Promise<RemoteResult<WorkflowDefinitionEntry>>
}
export type SaveDefinition = (id: string | undefined, yaml: string) => Promise<string>
export function createSandoreSave(remote: SandoreSaveRemote): SaveDefinition
// id===undefined → createDefinition({yaml}).id；否则 updateYaml(id, yaml).id（均经 unwrap）
export interface SaveErrorInfo { message: string; details: string | undefined }
export function describeSaveError(error: unknown): SaveErrorInfo
```

`packages/sandore/ui/src/client/open-discussion.ts`：

```ts
export interface SessionsOpenFace { open(id: SessionId): void }
export type OpenDiscussion = () => void
export function createOpenDiscussion(sessions: SessionsOpenFace, instanceId: string): OpenDiscussion
// () => sessions.open(instanceId as SessionId)（宿主 Session id == instanceId）
```

#### 3.4 `run-view-model.ts` 可供复用的纯函数

`packages/sandore/ui/src/client/run-view-model.ts` 导出：

- `type DagRunStatus = WorkflowTaskState['status']`（7 态：pending/running/interacting/completed/failed/aborted/paused）
- `type StepStatus`、`type ExecutedStep`、`type StageInfo`、`type RetryMode = 'continue'|'revert'|'fork'`、`RETRY_MODES`
- `stepDotState(status: StepStatus): StateDotState`（completed→done / failed→error / running→ongoing / 其余→warning）
- `runDotState(status: DagRunStatus): StateDotState`
- `isRunningStatus(status): boolean`（running|interacting）、`isTerminalStatus(status): boolean`（completed|failed|aborted）
- `partitionInteractions`、`isBlank`、`stepIdOf`、`isSubagentStep`

---

### 4. `ctx.remote.sandore.listInstances / listDefinitions / deleteDefinition` 的 wire 类型

生成物（`@deepseek-ai/dsh-sandore-workflow/remote` = `packages/sandore/workflow/lib/typert.remote-client.d.ts`）中的 client namespace：

```ts
listDefinitions: () => Promise<RemoteResult<WorkflowDefinitionEntry[]>>
deleteDefinition: (id: string) => Promise<RemoteResult<boolean>>
listInstances: (jobId?: string) => Promise<RemoteResult<InstanceSummary[]>>
getYaml: (id: string) => Promise<RemoteResult<string>>
// 其余（createDefinition/updateYaml/updateDefinition/listJobs/getInstanceState/abort/pause/resume/retry/reply/getArtifacts/listProviders/listModels）见同文件
```

##### `WorkflowDefinitionEntry`（生成 wire 类型）

```ts
interface WorkflowDefinitionRecord {
  readonly yaml: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly createdAt: string
  readonly updatedAt: string
}
interface WorkflowDefinitionEntry extends WorkflowDefinitionRecord {
  readonly id: string
}
```

##### `InstanceSummary`（生成 wire 类型）

```ts
interface InstanceSummary {
  readonly instanceId: string
  readonly jobId: string
  readonly workflowId: string
  readonly status: string       // 注意：生成 wire 侧为 string（源码 remote.ts 为 WorkflowTaskState['status']）
  readonly createdAt: string
  readonly updatedAt: string
}
```

补充：源码侧 `packages/sandore/workflow/src/remote.ts` 里 `InstanceSummary.status: WorkflowTaskState['status']`，但 typert 生成器把 status 拍平为 `string`；Host 实际返回的正是 `WorkflowTaskState['status']` 7 态枚举。`deleteDefinition(id)` Host 实现幂等返回 `boolean`（重复删除返回 false，不级联删实例）。`listInstances` 可选按 `jobId` 过滤。

Host RPC 完整实现见 `packages/sandore/workflow/src/remote.ts`（`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')`，`@Remote('listInstances')` 等，`inject = ['sandorePersistence','sandoreEngine','llm']`）。

---

### 5. ui 包现有 locales.ts 键结构

文件：`packages/sandore/ui/src/client/locales.ts`

结构模式（可复制的既有约定）：

```ts
export const NS = 'sandore'

export const zh = { ... } satisfies Record<string, string>   // 键为点分扁平字符串
export type SandoreKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { sandore: SandoreKey }
}

export const en = { ... } satisfies Record<SandoreKey, string>   // 与 zh 逐键对齐，缺一即编译错
```

现有键前缀分组（`键: 值` 中键的命名空间）：

- `button.*`：`button.trigger`、`button.aria`
- `panel.*`：`panel.title`、`panel.orchestrate`、`panel.add`、`panel.list.heading`、`panel.state.ready|running|completed`、`panel.ping`、`panel.ping.loading`、`panel.ping.failed`（`{message}` 模板）
- `editor.*`：`editor.title`、`editor.save|saving|save.success|save.failed`、`editor.preview`、`editor.steps.count|steps.empty`、`editor.step.add|step.name|step.command`、`editor.stage.add`、`editor.command.shell|prompt|agent|skill|mcp`、`editor.field.*`、`editor.section.*`、`editor.add.item`、`editor.remove.item`
- `run.*`：`run.title`、`run.discuss`、`run.refresh`、`run.loading|error`、`run.status.*`（7 态）、`run.abort|pauseAll|resumeAll`、`run.trajectory.*`、`run.visitCount`、`run.step.status.*`、`run.step.pause|resume|retry`、`run.interactions.title`、`run.question.*`、`run.permission.*`、`run.artifacts.*`、`run.retry.*`

模板参数用 `{message}` / `{count}` 形式。注册进 `LocaleNamespaceMap` 后，组件通过 `TranslateNS<'sandore'>`（`t: TranslateNS<'sandore'>`）得到类型化翻译函数。

---

### 附：关键类型定义源文件（绝对路径）

- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/index.ts`（apply / inject 注册）
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/WorkflowButton.tsx`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/WorkflowPanel.tsx`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/DagEditor.tsx`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/RunView.tsx`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/sandore-save.ts`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/open-discussion.ts`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/run-view-model.ts`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/locales.ts`
- `D:/project-code/llm/sandore/packages/sandore/ui/src/client/remote.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/remote.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/src/schema.ts`
- `D:/project-code/llm/sandore/packages/sandore/workflow/lib/typert.remote-client.d.ts`（生成 wire 类型）
- `dsh-client-ui-slots`：`lib/types/index.d.ts`、`lib/types/store.d.ts`、`lib/types/renderer.d.ts`
- `dsh-client-runtime`：`lib/types/client/index.d.ts`、`lib/types/client/slots.d.ts`、`lib/types/client/contract/store.d.ts`、`lib/types/client/contract/sessions.d.ts`、`lib/types/client/contract/workspaces.d.ts`、`lib/types/client/sessions/service.d.ts`、`lib/types/client/workspaces/service.d.ts`
- `dsh-client-ui-sidebar`：`lib/types/client/contract/slots.d.ts`
- `dsh-host-apiproxy`：`lib/types/api/workspace.d.ts`
