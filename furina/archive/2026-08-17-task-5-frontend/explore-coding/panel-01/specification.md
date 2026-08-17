# panel-01（WorkflowPanel 重写 + InstanceList/DefinitionList 新增）— 规格探索结果

> 探索类型：specification
> 探索内容：重写 sandore `ui` 包 WorkflowPanel 并新增 InstanceList/DefinitionList（footer 入口展开面板 + 两级下钻 view 栈 + 三态列表 + 按工作区分组）
> 语言：中文
> 材料来源：`furina/changes/task-5-frontend/`（proposal/design/plan/specs）、`docs/design/task-5-frontend/`、`docs/engine/dsh-workflow.md`、当前 `packages/sandore/ui/src/client/**` 代码现状、`packages/sandore/workflow/src/remote.ts`（RPC wire 类型）

---

## 一、需求理解

- **What**：本任务（plan.json 中 `panel-01`，category `workflow-panel`）要重写 `packages/sandore/ui` 包现有的占位 `WorkflowPanel.tsx`，并新增 `InstanceList.tsx` / `DefinitionList.tsx` / `view-stack.ts`，实现：`sidebar.footer.action` 入口按钮点击展开 WorkflowPanel；面板 header 提供搜索/编排 toggle/新增；内部维护 `list ↔ editor(DagEditor) ↔ run(RunView)` 两级下钻 view 状态栈；默认态实例列表按工作区分组（3s 轮询）、编排态定义列表平铺；列表具备 loading/empty/error 三态。
- **Boundaries**：范围限定在 `packages/sandore/ui/src/client/`（组件/文案/CSS）与 `client/index.ts`（inject 面）；不改任何 DSH 源码、不引入第三方 UI 库；数据全部经 `ctx.remote.sandore.*`（Typert 已由 rpc-01 接线）。下钻承载的 `DagEditor` / `RunView` 是已交付组件（editor-01 / run-01），本任务只负责 view 栈装配与回调接线，不重做编辑器/执行详情本体。
- **Goal**：摸清本任务的权威 spec（`specs/workflow-panel/spec.md`）、设计决策（design.md D-4/D-6/D-7）、plan 任务定义、以及当前代码现状与可复用接口，为准确实施 panel-01 提供事实依据。

---

## 二、权威任务 Spec（`furina/changes/task-5-frontend/specs/workflow-panel/spec.md`）

该 spec 共 7 条 ADDED Requirement，全部直接绑定本任务：

1. **footer 入口按钮展开 WorkflowPanel**：`WorkflowButton`（`sidebar.footer.action`，`id: 'sandore-btn'`）点击展开/收起 WorkflowPanel；按钮渲染于 DSH 侧边栏设置按钮上方；`wide`（展开侧栏）与 rail（窄条）两态均可用——rail 态可显示图标按钮，面板以**宽展开 layer** 形态弹出。
2. **header 提供搜索/编排/新增**：搜索输入（客户端过滤当前列表）、「编排」toggle（默认态↔编排态）、「新增」按钮（默认态→新增实例入口、编排态→新增定义）。
3. **两级下钻承载**：WorkflowPanel 内部维护 view 状态栈 `list` ↔ `editor`（DagEditor，点定义进入）↔ `run`（RunView，点实例进入）；下钻态以宽展开 layer 渲染，返回按钮回退上一级；**全程零新增 slot 注册**（自包含 client 状态）。
4. **默认态实例列表按工作区分组**：`InstanceList` 经 `ctx.remote.sandore.listInstances()` 拉取实例，按工作区分组渲染：`useWorkspaces` 取 `WorkspaceView[].sessionIds` 成员表，`instanceId` 命中即归入对应 workspace 分组；不属于任何 workspace 的实例归「未分组」；每项显示实例状态（StateDot）、ID、Job/更新时间；面板打开期间 **3s 轮询**刷新。
5. **编排态定义列表**：`DefinitionList` 经 `ctx.remote.sandore.listDefinitions()` 拉取定义并**平铺**渲染（名称/版本/描述/更新时间）；提供删除（确认后 `deleteDefinition`）；点击定义进入 DagEditor。
6. **三态列表展示**：列表呈现三态 loading（加载中指示）/ empty（空态引导文案 + 「新增」入口）/ error（RPC 失败错误提示 + 重试）。
7. （分组/刷新/空态/错误态的 Scenario 细节见 spec 原文，与上述 Requirement 对应。）

---

## 三、设计决策（`furina/changes/task-5-frontend/design.md`）

panel-01 的 `spec_refs` 指向 D-4 / D-6 / D-7 三条：

- **D-4（DagEditor/RunView 承载：WorkflowPanel 两级下钻 + 宽展开）**：不新增 slot。WorkflowPanel 内部维护 `view` 状态栈：`list`（默认/编排列表态，窄面板形态）↔ `editor`（DagEditor）↔ `run`（RunView）。下钻态使用**宽展开 layer**（照 `ui-cordis` `CordisPanel` 的 `wide ? css.layer : css.rail` 双态形态，layer 定位脱离侧栏宽度约束、锚定 footer 按钮上方展开为宽浮层）。返回按钮回退栈。备选 `conversation.view` tab / `shell.overlay` 均被排除。RunView 的「打开讨论」按钮走 `ctx.sessions.open(instanceId)`，与承载决策正交。
- **D-6（数据获取与刷新策略）**：列表态挂载/打开面板时 `listInstances`/`listDefinitions` 拉取 + 打开期间 **3s 轮询**（对齐原 sandore §23.3.2 语义）；搜索走**客户端过滤**（不 `ctx.sessions.search`）。RunView 是 5s 轮询（run-01 已实现）。全部经 `ctx.remote.sandore.*`（D-1），无独立 HTTP 层。
- **D-7（工作区分组）**：`InstanceList` 默认态按 workspace 分组：`useWorkspaces(state => state.items)` 取 `WorkspaceView[].sessionIds` 成员表，`instanceId ∈ sessionIds` → 归组；不在任何 workspace 的实例归「未分组」。编排态 `DefinitionList` 平铺（定义无 workspace 归属）。`ui` 的 `inject` 补 `workspaces`。

> 另见 proposal.md「Capabilities → New Capabilities → `workflow-panel`」：与上述一致，概括为「WorkflowPanel 展开面板 + 两级下钻承载（header 搜索/编排/新增 + InstanceList/DefinitionList 三态列表 + 按工作区分组）」。

---

## 四、plan.json 中 panel-01 的权威任务定义

`furina/changes/task-5-frontend/plan.json` 中 `panel-01`（`status: in_progress`）：

- **function**：重写 WorkflowPanel 并新增 InstanceList/DefinitionList：header 提供搜索（客户端过滤）、编排 toggle（默认态↔编排态）、新增按钮（默认态新增实例/编排态新增定义）；内部维护 view 状态栈 list↔editor(DagEditor)↔run(RunView)，下钻态以宽展开 layer 渲染（`wide ? css.layer : css.rail`），返回按钮回退；默认态 InstanceList 经 `listInstances` 拉取并按工作区分组（`useWorkspaces` 取 workspace.sessionIds 成员表，未命中归「未分组」，3s 轮询）；编排态 DefinitionList 经 `listDefinitions` 平铺（删除需确认后 `deleteDefinition`）；三态 loading/empty/error。WorkflowButton 微调接入面板 store 与新增/下钻回调；inject 补 sessions/workspaces。
- **acceptance_criteria（7 条）**：
  1. 点击「工作流」footer 按钮展开 WorkflowPanel（首次进入默认态列表），rail 窄态仍可点且面板以宽展开 layer 弹出。
  2. 切换编排 toggle 时列表切换为 DefinitionList，新增语义变为新增定义；搜索框按名称/ID 客户端过滤当前列表。
  3. 编排态点定义下钻为 DagEditor 宽展开态；默认态点实例下钻为 RunView 宽展开态；返回按钮回退并保留编排 toggle/搜索状态。
  4. 实例 A 的 instanceId 命中 workspace W1 的 sessionIds、实例 B 不属于任何 workspace 时，列表在 W1 分组显示 A、未分组显示 B。
  5. 面板打开且默认态时每 3s 调用 `listInstances` 刷新（收起面板/卸载即停止）。
  6. `listInstances` 返回空数组显示空态引导；`listDefinitions` 返回 `{ok:false}` 显示错误提示与重试；删除定义经确认后 `deleteDefinition`。
  7. view 栈 reducer 纯函数单测全绿，`pnpm -r typecheck` 全绿。
- **tasks**：
  - `6.1` 新增 `view-stack.ts`（list/editor/run 状态栈 reducer，纯函数）+ `view-stack.spec.ts` 单测
  - `6.2` 重写 `WorkflowPanel.tsx`（header 搜索/编排/新增 + view 栈 + 宽展开 layer 双态）
  - `6.3` 新增 `InstanceList.tsx`（listInstances + useWorkspaces 分组 + 3s 轮询 + 三态）
  - `6.4` 新增 `DefinitionList.tsx`（listDefinitions 平铺 + 删除确认 + 三态）
  - `6.5` 微调 `WorkflowButton.tsx` 接入面板 store 与下钻回调，`index.ts` inject 补 sessions/workspaces
  - `6.6` 扩充 `locales.ts` 文案并更新 `WorkflowPanel.module.css`
  - `6.7` `pnpm -r typecheck` 全绿
  - `6.x` 下钻到 RunView 时用 `createOpenDiscussion(ctx.sessions, instanceId)` 生成 openDiscussion 回调并注入 RunView（闭合 AC-6 端到端）；下钻到 DagEditor 时用 `createSandoreSave(ctx.remote.sandore)` 生成 save 回调并注入 DagEditor
- **files**：`WorkflowPanel.tsx`、`WorkflowPanel.module.css`、`InstanceList.tsx`、`DefinitionList.tsx`、`WorkflowButton.tsx`、`view-stack.ts`、`view-stack.spec.ts`、`index.ts`、`locales.ts`（均在 `packages/sandore/ui/src/client/`）
- **dependencies**：`rpc-01`、`editor-01`、`run-01`（三者 status 均为 `done`）

---

## 五、权威设计文档相关约定（docs/design + docs/engine）

### 5.1 `docs/design/task-5-frontend/design.md`

- **§1.1（入口 + UI 结构）**：工作流管理 UI 入口 = `sidebar.footer.action` 按钮 + 点击展开 WorkflowPanel（设置上方）。sidebar 子 slot「声明即独占」，插件无法新增常驻分组。面板结构：
  ```
  header：搜索图标 | 「编排」toggle + 「新增」按钮
  默认态（编排 off）：工作流实例列表（按工作区分组）
  编排态（编排 on）：工作流定义列表 → 点定义进 DagEditor
  新增：默认态→新增实例；编排态→新增定义
  ```
  分组依据 = `workspace.sessionIds` 显式成员表（非 cwd）。sidebar 展开面板宽约 260-300px，承载 DagEditor/RunView 偏窄，故两级下钻：列表态窄 rail ↔ 编辑/执行态宽展开 layer。
- **§1.2（Slot 注册）**：`sidebar.footer.action` 为 list slot（root scope），注册 `id: 'sandore-btn'` 即可加性插入，位置在设置上方；`useSessions`/`useWorkspaces` 是框架全局 hook。
- **§3（WorkflowList 职责）**：实例列表「每 3s 轮询实例状态 + 待处理交互」是原 sandore `WorkflowLabSidebar` 的既有语义（`dynamic-workflow-engine.md §23.3.2`），DSH 中统一进 WorkflowList/WorkflowPanel。
- **§6.2（RPC 清单）**：与本任务直接相关的 RPC：`listDefinitions`/`createDefinition`/`updateDefinition`/`deleteDefinition`/`getYaml`/`updateYaml`、`listInstances`/`startInstance`/`deleteInstance`/`getInstanceState`/`abortInstance`、`getArtifacts`、`replyQuestion`/`replyPermission`、`pauseStep`/`resumeStep`/`pauseAll`/`resumeAll`/`retryStep`、`listProviders`/`listModels`。

### 5.2 `docs/engine/dsh-workflow.md`

- **§6.1（Slot 注册 + D6）**：入口落点 = `sidebar.footer.action`（foot 区域、settings 上方，`SidebarRoot.tsx:181` "Footer actions stack above Settings"），参考 `ui-cordis` 先例。面板开关是插件自有 client 状态。
- **§6.2（UI 结构）**：WorkflowPanel 仿 `ui-workspace` WorkspaceBrowser 观感（header 搜索+操作按钮 + 分组/平铺列表）；workspace 的 header 组件与分组逻辑包内私有不可 import，需用 `ui-primitives` 自绘同款观感。**三态切换**：`编排` 是 toggle（off=实例列表，on=定义列表），非独立页面；`新增` 按钮动作随当前态改变。分组依据 = 实例的父 session id → `workspace.sessionIds`（显式成员表）。

---

## 六、当前代码现状（重写对象的既有形态 + 下游组件接口）

### 6.1 现状总览（`packages/sandore/ui/src/client/`）

已有（来自已完成的 rpc-01/editor-01/run-01）：
`remote.ts`（RemoteResult 解包 + `unwrap` + `SandoreRemoteError`）、`dag-editor-model.ts`、`DagEditor.tsx`+`.module.css`、`open-discussion.ts`、`run-view-model.ts`、`RunView.tsx`+`.module.css`、`sandore-save.ts`、`WorkflowButton.tsx`+`.module.css`、`WorkflowPanel.tsx`+`.module.css`（待重写）、`index.ts`、`locales.ts`。

尚缺（本任务新增）：`InstanceList.tsx`、`DefinitionList.tsx`、`view-stack.ts`、`view-stack.spec.ts`。

### 6.2 WorkflowPanel.tsx（占位，待重写）

当前是 Task 1 占位：`WorkflowPanelProps { t: TranslateNS<'sandore'>; ping(): Promise<PingResponse> }`；内部 `orchestrating` state（编排 toggle）+ `PLACEHOLDER_ROWS` 三态占位行（`StateDot` + 名称 + 状态文案）+ ping 往返按钮。**尚无**：真实列表数据、搜索框、view 栈、下钻、工作区分组、轮询。结构 `<section className={css.panel}>` → `<header>`（title + 编排 checkbox + 新增 Button）→ `<body>`（`<h3 className={css.group}>` + `<ul className={css.rows}>` + ping 区）。

### 6.3 WorkflowButton.tsx（待微调）

当前：`WorkflowButtonFace { ping(): Promise<PingResponse> }`；props = `PropsRuntime<'sidebar.footer.action'> & InjectFace<WorkflowButtonFace> & PropsLocale<'sandore'>`；`useState(open)` 控制展开；`<div className={wide ? css.layer : css.layer + css.rail}>`，`{open && <WorkflowPanel t={t} ping={ping} />}` + footer badge 按钮（`IconBranchOutline16`，`data-sandore-btn`）。已是 `ui-cordis` `wide ? css.layer : css.rail` 双态形态；需把 face 从 `ping` 扩充为「面板 store + 列表/新增/下钻回调」。

### 6.4 index.ts（inject 现状，待补）

当前 `client/index.ts`：`export const inject = ['slots', 'locale', 'remote', 'sessions']`；apply 内 `ctx.locale.register(NS, {zh,en})`、`ctx.remote.$mount(sandoreRemote)`（disposer 经 ctx.effect）、构造 `sandore = { ping: ... }` 后 `ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name:'sidebar.footer.action', id:'sandore-btn', locale:NS, inject: () => sandore }, WorkflowButton))`。panel-01 需补 `workspaces`（若走 `ctx.workspaces` 服务面）并扩展 `sandore` face（listInstances/listDefinitions/deleteDefinition 等）。当前 `ui/package.json` 的 `dsh.client.inject` 为 `[dsh-api-remotes, dsh-client-runtime, dsh-client-locale, dsh-client-ui-sidebar]`（static-01 才补全 ui-slots/ui-conversation 等）。

### 6.5 RPC 面与 wire 类型（`packages/sandore/workflow/src/remote.ts`）

panel-01 直接消费的方法与类型：

- `listInstances(jobId?): InstanceSummary[]`
  - `InstanceSummary = { instanceId: string; jobId: string; workflowId: string; status: WorkflowTaskState['status']; createdAt: string; updatedAt: string }`
  - `status` 为 `DagRunStatus`（pending/running/interacting/completed/failed/aborted/paused）。
- `listDefinitions(): WorkflowDefinitionEntry[]`
  - `WorkflowDefinitionEntry = WorkflowDefinitionRecord & { id: string }`
  - `WorkflowDefinitionRecord = { yaml; name; version; description?; createdAt; updatedAt }`（定义列表平铺显示 名称/版本/描述/更新时间 即来自这些字段）。
- `deleteDefinition(id): Promise<boolean>`（删除定义；重复删除幂等返回 false）。
- 另：`createDefinition({yaml})` / `updateYaml(id, yaml)` 是 DagEditor 保存面（由 `sandore-save.ts` 的 `createSandoreSave` 接线，panel-01 仅透传）。
- 客户端调用统一经 `remote.ts` 的 `unwrap<T>(result)` 解包：`ok:true` 取 value，`ok:false` 抛 `SandoreRemoteError`（含 `code`/`details`）——三态中的 error 态据此呈现。

### 6.6 DagEditor props（下钻 editor 态接口，editor-01 已交付）

`DagEditorProps { t; initialYaml?: string | undefined; initialId?: string | undefined; save: SaveDefinition }`。`SaveDefinition = (id: string | undefined, yaml: string) => Promise<string>`（`sandore-save.ts` 的 `createSandoreSave(remote)` 生成）。panel-01 下钻到 editor 时需用 `createSandoreSave(ctx.remote.sandore)` 生成 `save` 回调注入（plan 6.x）。

### 6.7 RunView props（下钻 run 态接口，run-01 已交付）

`RunViewProps { t; instanceId: string; openDiscussion: () => void; remote: RunViewRemote }`。`RunViewRemote` 是 `ctx.remote.sandore` 的最小访问面（`getInstanceState`/`getArtifacts`/`abortInstance`/`pauseAll`/`resumeAll`/`pauseStep`/`resumeStep`/`retryStep`/`replyQuestion`/`replyPermission`，均返回 `RemoteResult`）。`openDiscussion` 由 `open-discussion.ts` 的 `createOpenDiscussion(sessions, instanceId)` 生成（内部 `sessions.open(instanceId)`）。panel-01 下钻到 run 时需用该 adapter 生成回调并注入（plan 6.x）。RunView 自带 5s 轮询（运行中），与 panel-01 的列表 3s 轮询相互独立。

### 6.8 状态→StateDot 映射（`run-view-model.ts`，可复用）

`runDotState(status: DagRunStatus): StateDotState`：`completed→done`、`failed→error`、`running→ongoing`，其余（pending/interacting/aborted/paused）→`warning`。InstanceList 每项的状态点（StateDot）可直接复用此映射；另有 `isRunningStatus`/`isTerminalStatus`。该模块从 `@deepseek-ai/dsh-sandore-workflow/schema`（浏览器安全子路径）导入 `WorkflowTaskState` 派生类型，避免 dsh-llm 依赖。

### 6.9 locales.ts 既有文案键

命名空间 `NS = 'sandore'`。已存在的键（可参考命名风格）：`panel.title/orchestrate/add/list.heading`、`panel.state.*`、`editor.*`、`run.*`。panel-01 需扩充列表三态（loading/empty/error）、「未分组」、搜索占位、删除确认等新键（zh/en 逐键对齐，`satisfies Record<SandoreKey, string>`，缺一即编译错）。`SandoreKey = keyof typeof zh`，`LocaleNamespaceMap.sandore` 声明合并。

---

## 七、DSH 参考契约（footer 面板 / workspace 分组 / 标准 hook）

来源：`furina/changes/task-5-frontend/explore-design/{specification,codebase,repository}.md` 与 `furina/archive/2026-08-15-task-1-skeleton/explore-coding/ui-01/reference.md`（均为对 DSH 源码 `D:\project-code\llm\deepseek-harness` 的探索记录）。

- **`sidebar.footer.action` 契约**（`ui-sidebar/src/client/contract/slots.ts`）：`{ kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }`；owner props **仅 `{ wide: boolean }`**（false = 56px rail）。list slot 注册必须提供 `id`。
- **root scope 标准 hook**（`packages/client/runtime/src/client/index.ts`）：`GlobalStandardProps { useSessions; useWorkspaces }` 注入到每个 root slot 组件——即 `PropsRuntime<'sidebar.footer.action'>` 已含 `useWorkspaces`（类型 `SnapshotSelectorHook<T>`，uSES selector hook，`useWorkspaces(selector)` 取 `WorkspaceView[]`）。
- **`WorkspaceView.sessionIds`**：`ui-workspace/src/client/WorkspaceBrowser.tsx` 第 280 行 `workspaces.flatMap(w => w.sessionIds)` 是「实例 → 父 session → workspace」分组的既定范式；分组依据 = 显式成员表 `sessionIds`（非 cwd）。
- **`InjectFace<I>` 约定**（`@deepseek-ai/dsh-client-ui-slots`）：inject face 中 `hooks` 保留字会被转成 `use<Name>` selector hook（`HostObservable` → `SnapshotSelectorHook`）；其余成员原样传入。`PropsLocale<N>` 提供 `t`；`register` 支持 `store`/`locale`/`key`/`children` 选项。
- **`ui-cordis`（`packages/extensions/ui-cordis`）**：footer 按钮 + 展开 CordisPanel 范本，`wide ? css.layer : css.rail` 双态、`useSessions(state => state.current)`、`useState(open)` 开关——WorkflowPanel 最直接结构参照。
- **服务面**：`ctx.workspaces`（`IWorkspaces`，create/rename/delete/insertSessionBefore/archiveSession/startSession 等）需 `inject: ['workspaces']`；`ctx.sessions.open(id)` 是打开会话的既有用法。二者与 `useWorkspaces` hook（运行时标准 hook）是不同概念，spec 中分组走的是 `useWorkspaces` hook。

---

## 八、panel-01 依赖的已交付能力（上游）

- **rpc-01（done）**：`ctx.remote.sandore.*` 命名空间就绪（`remote.ts` 的 `$mount` + `unwrap`），27 个 RPC 可调，动态桩已移除。panel-01 的 listInstances/listDefinitions/deleteDefinition 均经此。
- **editor-01（done）**：`DagEditor.tsx` + `sandore-save.ts`（`createSandoreSave`）。panel-01 下钻 editor 态复用。
- **run-01（done）**：`RunView.tsx` + `open-discussion.ts`（`createOpenDiscussion`）+ `run-view-model.ts`。panel-01 下钻 run 态复用。

> 与 panel-01 同变更但尚 pending 的：`step-01`（sandore-step 讨论节点）、`static-01`（cordis.yml 固化 + dsh.client.inject 补全 + 构建），均非本任务范围，但与 panel-01 的 `ui/package.json` 最终 `dsh.client.inject` 补齐有交集（panel-01 只负责 `src/client/index.ts` 的 `inject` 数组，package.json 的 `dsh.client.inject` 补齐归 static-01）。
