## Exploration Result

> 参考对象：`D:\project-code\llm\deepseek-harness`（DSH）下的 `ui-cordis`（CordisPanel）与 `ui-workspace`（WorkspaceBrowser）两个包，以及支撑它们的 slot/运行时机制。
> 说明：`furina config show exploration.reference` 返回空数组 `[]`；本次参考材料由 exploreContent 直接点名定位，故按目录型参考材料逐文件探索。

---

### 一、CordisPanel.tsx 的精确形态（`ui-cordis`）

文件：`D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\CordisPanel.tsx`
样式：`...\ui-cordis\src\client\CordisPanel.module.css`

#### 1. 组件 props 合成（`wide` 的 owner prop 如何传入）

```ts
export type CordisPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>
```

- `PropsRuntime<'sidebar.footer.action'>` 展开后含四份：
  - `OwnerOf<'sidebar.footer.action'>` = `SidebarFooterActionOwnerProps` = `{ wide: boolean }`（唯一 owner 事实）。
  - `SlotInjectFace<...>`（该 slot 无 `children`/`inject` 声明，故为 `object`）。
  - `GlobalStandardProps`（运行时 merge 的全局 hook 座：`useSessions`、`useWorkspaces`，见下文）。
  - scope 为 `root`，故无 session 标准 props。
- `InjectFace<CordisPanelFace>`：把 inject face 里保留字 `hooks` 区的可观察源转成 `use<Name>` selector hook（`useInventory`、`useActiveRuns`、`useRunErrors`、`useRenderFailures`、`useLoaded`），其余普通成员（`onApprove`/`onDecline`/`onRun`/`onStop`/`onRemove`/`onRefresh`）原样透传。
- `PropsLocale<'cordis'>`：注入类型化的 `t: TranslateNS<'cordis'>`。

关键：`wide` 是 sidebar 外壳通过 `renderSlot('sidebar.footer.action', { wide })` 在渲染点传入的 owner 事实，不是组件自己读的。

#### 2. `wide` 的 owner prop 传递链

文件：`...\packages\client\ui-sidebar\src\client\contract\slots.ts`

```ts
'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}
```

文件：`...\packages\client\ui-sidebar\src\client\SidebarRoot.tsx`

- `const wide = !collapsed || !settled`（折叠动画 settle 前仍为 wide）。
- 渲染点：

```tsx
<div className={css.footArea}>
  <div className={css.footerActions}>
    {renderSlot('sidebar.footer.action', { wide })}
  </div>
  <div className={css.settingsArea}>
    {renderSlot('sidebar.settings', { wide })}
  </div>
</div>
```

- `sidebar.footer.action` 是 `kind: 'list'` 的可选 footer 动作槽（在 Settings 上方堆叠）；`sidebar.workspaces` 与 `sidebar.settings` 是 `kind: 'single'`。

#### 3. 注册方式（inject face 来源）

文件：`...\ui-cordis\src\client\index.ts`（`apply` 内）

```ts
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'cordis-panel',
  locale: NS,
  inject: (): CordisPanelFace => ({
    hooks: {
      inventory,                       // CordisInventory
      activeRuns: runner.activeRuns,   // HostObservable<ReadonlyMap<pluginId, activity>>
      runErrors: runner.lastRunError,
      loaded,                          // 外层 getSnapshot/subscribe 包装
      renderFailures: runner.renderFailures,
    },
    onApprove: ..., onDecline: ..., onRun: ..., onStop: ..., onRemove: ...,
    onRefresh: () => { inventory.refresh() },
  }),
}, CordisPanel))
```

- `hooks` 区对象自动合成 `useInventory`/`useActiveRuns`/`useRunErrors`/`useRenderFailures`/`useLoaded`。
- 数据刷新是事件驱动的：`ctx.remote.$on('cordis/dynamic-package' | 'cordis/dynamic-retract' | 'cordis/request-run' | 'cordis/request-run-resolved')`、`ctx.on('connection/reset')` 均触发 `inventory.refresh()`；无轮询。

#### 4. 双态 `wide ? css.layer : css.rail` 与组件主体

```tsx
return (
  <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
    {open && (
      <section className={css.panel} data-cordis-panel aria-label={t('panel.title')}>
        <header className={css.header}>
          <span className={css.title}>{t('panel.title')}</span>
        </header>
        <div className={css.body}>
          {/* inventory.error / !inventory.read / empty 三态提示 */}
          {mine.length > 0 && (<section><h3 className={css.group}>{t('panel.group.current')}</h3><ul className={css.rows}>{mine.map(renderRow)}</ul></section>)}
          {theirs.length > 0 && (<section><h3 className={css.group}>{t('panel.group.others')}</h3><ul className={css.rows}>{theirs.map(renderRow)}</ul></section>)}
        </div>
      </section>
    )}
    <div className={css.footerButtons}>
      <button type="button" className={css.badge}
        data-cordis-badge={all.length}
        data-cordis-approval-badge={approvals}
        data-active={approvals > 0 || undefined}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}>
        <IconCordisPluginOutline14 />
        {wide && (<>
          <span className={css.badgeLabel}>{t('panel.trigger')}</span>
          <span className={css.badgeCount}>{t('panel.runningCount', { count: running })}</span>
        </>)}
      </button>
    </div>
  </div>
)
```

- `useState(false)` 开合开关：`const [open, setOpen] = useState(false)`。
- 自动展开：`useEffect` 监听 `activeRuns`，发现新 `awaiting-approval` 请求时 `setOpen(true)`。
- `useEffect(() => { onRefresh() }, [onRefresh])` + `useEffect(() => { if (open) onRefresh() }, [onRefresh, open])` 负责挂载与展开时刷新。
- `all.length === 0` 时整体 `return null`（无数据不占 footer 位）。
- 行分组：`useSessions(state => state.current)` 取当前会话 id，按 `agentId === current` 拆 `mine`/`theirs`，`blockingFirst` 把 awaiting-approval 行排前。
- 每行 `data-cordis-status={status}`（idle / awaiting-approval / client-pending / running / failed 五态），CSS 按该 data 属性给状态徽章配色。

#### 5. 双态 CSS（关键观感数据）

`CordisPanel.module.css`：

- `.layer`：`position: relative; flex: none; display: flex; align-items: center; width: 100%; height: 49px; margin: 8px 0 0;`
- `.layer.rail`：`width: 36px; height: 36px; margin: 0;`
- `.rail .badge`：`width/height: 36px; padding: 0; border-radius: 50%; justify-content: center; gap: 0;`（rail 态只保留圆形图标按钮）
- `.rail .footerButtons`：`flex-direction: column; gap: 2px;`
- `.panel`（展开面板，fixed 定位悬浮在 footer 上方）：`position: fixed; left: 12px; bottom: 128px; z-index: 30; width: 420px; max-width: calc(100vw - 24px); max-height: 60vh; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-shadow-lv2);`
- `.header`：`min-height: 44px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2);`（header 固定，`.body` 单独 `overflow-y: auto`）
- `.group`（分组标题）：`font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-caption);`
- `.row`：卡片式 `padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;`
- `.badge[data-active]` 高亮、`.badgeLabel` 省略号、`.badgeCount` 右对齐 tabular-nums。
- 状态徽章配色：`data-cordis-status='awaiting-approval' | 'client-pending'` → warn 色；`failed` → danger 色；`running` → success 色；`idle` → ghost 色。

---

### 二、WorkspaceBrowser 观感（`ui-workspace`）

文件：`...\packages\client\ui-workspace\src\client\WorkspaceBrowser.tsx`
样式：`...\ui-workspace\src\client\WorkspaceBrowser.module.css`
契约：`...\ui-workspace\src\client\contract\slots.ts`；行组件 `...\ui-workspace\src\client\rows\Rows.tsx`；派生 `...\ui-workspace\src\client\tree.ts`；view store `...\ui-workspace\src\client\stores.ts`

#### 1. Props 合成

```ts
export type WorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsRenderSlots<'sidebar.workspaces.directoryFlow'>
  & PropsStore<ReturnType<typeof createWorkspaceViewStore>>
  & Omit<WorkspaceBrowserInjected, 'hooks'>
  & DirectoryPickingHooks
  & PropsLocale<'workspace'>
```

- owner：`{ wide: boolean; expandSidebar: () => void }`（`SidebarSectionOwnerProps`，来自 `sidebar.workspaces` 的 SlotMap owner 声明）。
- 全局 hook 座：`useSessions` / `useWorkspaces`（`GlobalStandardProps`，运行时 `...\packages\client\runtime\src\client\index.ts` 里 merge 定义）。
- `PropsStore`：本包注册的 view store（groupBy/orderBy/groupExpansion/order 账号），组件里经 `useStore(s => s.xxx)` 与 `actions.*` 使用。

#### 2. 数据取用（成员表）

```ts
const workspaces = useWorkspaces(state => state.items)        // readonly WorkspaceView[]
const workspacePhase = useWorkspaces(state => state.phase)
const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
const list = useSessions(s => s)                             // 整份 SessionListState
```

- `WorkspaceView`（wire 投影，`...\packages\host\apiproxy\src\api\workspace.ts`）：
  `{ workspaceId: WorkspaceId; path: string; title: string; sessionIds: SessionId[]; createdAt: string; updatedAt: string }`
  —— `sessionIds` 是「该 workspace 名下按手动顺序排列的会话账号表」。
- `useSessions(s => s)` 返回 `SessionListState`：
  `{ ids: SessionId[]; byId: Record<SessionId, SessionSummary>; current: SessionId | undefined; phase: ...; subagentsByParent; jobsBySession; currentAddress }`。
- `SessionSummary` 关键字段：`id/displayTitle/title/cwd/running/pendingInteraction/completed/blank/updatedAt/...`。

#### 3. header 搜索 + 分组/平铺列表结构

- 根容器：`<div className={clsx(css.root, !wide && css.rail)}>`。
- 区头 `.sectionHeader`：
  - `.sectionLabel`（标题：flat 态显示 `section.sessions`，否则 `section.workspaces`，仅 wide 渲染）。
  - `.searchSlot`/`.search`（内联搜索胶囊，点击展开；展开时 `.searchExpanded`，并隐藏标题与 action 簇）。搜索防抖 `SEARCH_DEBOUNCE_MS = 250`，`sanitizeSearchQuery` 截断到 500 码元，`AbortController` 取消上一请求，结果走 `SearchResults`（`deriveSearchResults` 合并本地标题/工作区匹配 + Host 内容搜索）。
  - `.headerActions`：`ViewOptionsMenu`（分组 groupBy=workspace/flat + 排序 orderBy=manual/updated）+ 新增工作区按钮（`WorkspacePickFlow`，仅在 directory-flow 洞被占用时显示）。
- rail 态：仅渲染两个 36x36 圆形控件（搜索 + 新增），搜索点击走 `expandSidebar()` + `searchOnExpand` 延迟聚焦（`EXPAND_SLIDE_MS = 300`）。
- 列表区 `.listArea`（始终挂载，保证 footer 不跳动），wide 时三分支：
  1. `normalizedQuery !== ''` → `SearchResults`；
  2. `groupBy === 'flat'` → `FlatList`（`deriveFlat`，纯按 `updatedAt` 最新优先，顶层平铺行）；
  3. 否则 → `SessionTree`（`deriveGroups` 按工作区分组）。

#### 4. 分组派生（`tree.ts`）

- `UNGROUPED_KEY = ''`，`UNGROUPED_LABEL = 'Ungrouped'`（无归属会话桶）。
- `deriveGroups(list, workspaces, archivedSessionIds, view)` → `GroupNode[]`：
  - 每个 workspace 一个组（Host 稳定顺序），成员按 `workspace.sessionIds` 顺序解析 `list.byId[id]`；
  - 不在任何 workspace 的会话进 ungrouped 桶（本地顺序或 recency 回退）；
  - 组头字段：`key`（workspaceId 或 `''`）、`workspaceId`、`cwd`、`createdAt`、`label`、`sessionCount`、`expanded`、`containsCurrent`、`sessions`（折叠时为空数组）。
  - `containsCurrent` 由 `workspaces.find(w => w.sessionIds.includes(current))` 判定，直接下发给渲染层，渲染层不扫描。
- 折叠策略：组默认显示 `COLLAPSED_SESSION_LIMIT = 5` 行，超出显示 `.sessionOverflowButton` 展开/收起；当前会话所在组自动展开（`setGroupExpanded(currentGroup, true)`）。
- 行组件（`Rows.tsx`）：
  - `ProjectRowItem`（组头行，34px 风格）：文件夹图标 + chevron + 标题，hover 显示创建新会话 `+` 与 `...` 菜单（真实 workspace 才显示 rename/delete；ungrouped 无菜单、无 hover 卡）。
  - `SessionNodeItem`（会话行，34px）：`StateDot` 状态点 + 标题 + 相对时间 + `...` 菜单（rename/fork/archive）；`sessionStatuses` 状态优先级 pending interaction > running > subagents > completed；blank 行隐藏时间戳与菜单。
  - `SearchResultItem`：标题 + workspace 上下文 + 可选 snippet。

#### 5. `useSessions` 全局 hook 用法

- 定义（`...\packages\client\runtime\src\client\index.ts` 的 `GlobalStandardProps` merge）：

```ts
interface GlobalStandardProps {
  useSessions: SnapshotSelectorHook<SessionListState>
  useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
}
```

- 用法均为 selector 式：`useSessions(s => s)`（整份）、`useSessions(state => state.current)`（仅当前 id，CordisPanel 即此用法）、`useWorkspaces(state => state.items)`（成员表）。
- `SnapshotSelectorHook<Snap>` 即 `(selector) => selected`，由 renderer 用 `useSyncExternalStore` 绑定到 `SessionRuntime.list` / `WorkspaceRuntime.list` 的 `SnapshotStore`（`getSnapshot` + `subscribe`，microtask 批量通知）。
- 会话/工作区数据来源：`SessionRuntime.list` = list RPC + host 流增量 + 重连 re-pull；`WorkspaceRuntime.list` = `WorkspaceManager` 投影，`project()` 在 manager 或 sessions list 变更时重投影。

#### 6. 3s 轮询范式（若有）

- **DSH 侧无轮询**：`packages/client` 与 `ui-cordis`/`ui-workspace` 中不存在 `setInterval`/定时刷新（grep 仅命中测试文件里的 `setTimeout`）。刷新范式是事件驱动：
  - host 流信封（`handleHostEnvelope`）、`connection/reset` → `handleConnected()` 重建基线、显式 `refresh()`（复用 in-flight pull）。
  - CordisPanel 通过 `ctx.remote.$on(...)` + `connection/reset` 触发 `inventory.refresh()`，展开/挂载时再 `onRefresh()`。
- **sandore 侧现为 5s 轮询**（`D:\project-code\llm\sandore\packages\sandore\ui\src\client\RunView.tsx`）：
  - `const POLL_INTERVAL_MS = 5000`
  - 递归 `setTimeout` 链 + `timerRef`/`disposedRef` 两个 ref：

```ts
const refreshAndSchedule = useCallback(async () => {
  const status = await refresh()
  if (disposedRef.current || status === undefined || !isRunningStatus(status)) return
  if (timerRef.current === undefined) {
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      void refreshAndSchedule()
    }, POLL_INTERVAL_MS)
  }
}, [refresh])
```

  - `useEffect` 首拉 + 卸载时 `disposedRef.current = true` 并 `clearTimeout`；动作后手动 `refresh`。
  - 即：exploreContent 所述「3s 轮询范式」在 DSH 参考中不存在；sandore 自己的轮询范式为 5s 递归 setTimeout 链（非 setInterval），可作三态列表刷新参考。

---

### 三、与本任务直接相关的形态要点（供对照，非实现建议）

- footer 入口 + 展开面板：CordisPanel 用「footer 常驻 badge 按钮（`aria-expanded`）+ `useState(open)` + fixed 面板挂在按钮上方」的形态；双态由单一 `wide` owner prop 驱动（wide=49px 全宽行，rail=36px 圆形图标）。
- 三态/多态列表：CordisPanel 用 `data-cordis-status` 数据属性 + 对应 CSS 配色；sandore 现有 WorkflowPanel 已是「三态占位列表（ready/running/completed，`StateDot` state=warning/ongoing/done）」。
- 按工作区分组：DSH 的「工作区 = 会话成员表」模型为 `WorkspaceView.sessionIds`（会话 id 数组）+ `useSessions` 的 `byId` 做成员解析；ungrouped 桶用 `UNGROUPED_KEY = ''`。
- 两级下钻 view 栈：DSH 无现成 view 栈，但 sandore 现有 `RunView`（实例详情，经普通 props 承载供 WorkflowPanel 下钻）是下钻层的现成形态。

## Supplementary Exploration Result

未触发补充探索：Phase 3 已从本地 DSH 参考材料获得充分信息；`experimental.websearch=true`、`experimental.context7=true`，但参考结果已完整覆盖 exploreContent，无需联网补充（未发现需外部文档佐证的缺失项）。
