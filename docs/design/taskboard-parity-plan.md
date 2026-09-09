# sandore ↔ dsh-taskboard 对齐计划：侧边栏入口上移 + 工作流视图内嵌化（非遮罩）

## 0. 文档信息

- 目标仓库：`D:\project-code\llm\sandore`（单包 `@meiyukichan/dsh-sandore`，host + client 双端合一）
- 参考实现：`D:\project-code\llm\dsh-taskboard`（本地兄弟仓库，版本 0.6.4）
- DSH 宿主源码：`D:\project-code\llm\deepseek-harness`（只读，**禁止修改**）
- 本文档性质：**设计/实施计划**，尚未开始改代码；评审通过后按本文实施。
- 语言与风格约束（AGENTS.md）：中文；UI 复用 DSH、不能复用就照 DSH 风格做成一模一样；不建分支；重要功能点要带单元测试。

---

## 1. 需求（用户原话要点）

dsh-taskboard 相比 sandore 做到、而 sandore 没有做到的两点，要求 sandore 对齐：

1. **侧边栏入口位置**：taskboard 的入口插入在「工作区」浏览区**上方**（即 New Session 行之下、工作区列表之上）；而 sandore 现在只能通过 `sidebar.footer.action` 席位挂在**侧栏底部、设置之上**。
2. **打开后的形态与关闭方式**：taskboard 点开后是**中心列内嵌的"页面"**（会话内容让位、无遮罩浮层、侧栏保持可点）；而 sandore 现在走 `shell.overlay`，是**盖在会话列上的浮层**，且要**再点一次入口才能关**。taskboard 里**点击任意工作区会话（项目/会话/搜索结果/新建会话行），看板自然消失**，无需再点入口。

> 非目标：不要求 sandore 的工作台 UI 视觉变成看板风格；只对齐上述两个**交互/落位能力**。工作台 UI 外观保持现有风格（照 DSH token）。

---

## 2. 探索结论（现状与根因）

### 2.1 sandore 现状（两处 slot 注册）

`packages/client/index.ts` 目前注册了两个 DSH slot：

| slot | 作用 | 问题 |
|---|---|---|
| `sidebar.footer.action`（list，root scope） | 挂 `WorkflowButton`，宽态行/窄 rail 图标，点击 `toggleWorkflowOverlay` | 席位在侧栏**脚部**（设置上方），不是导航区 |
| `shell.overlay`（list，root scope） | 挂 `WorkflowOverlay`（覆盖 conversation/details 列、sidebar 保持可见） | 浮层观感 + 需再点入口关闭 |

`WorkflowOverlay` 结构（`packages/client/WorkflowOverlay.tsx` + `.module.css`）：`.layer{position:absolute;inset:0;pointer-events:none;z-index:30}` → `.overlay{position:absolute;left:var(--wf-left);…}` 面板从侧栏右缘盖住中间与详情列，带 `box-shadow` 与 0.18s 动画——这就是"遮罩/浮层"体感来源。宽态开合状态在模块级 `workflow-store.ts`（`open` 布尔）。

### 2.2 DSH 侧栏与布局的 slot 地图（读了宿主源码，行号可复查）

`D:\project-code\llm\deepseek-harness\packages\client\ui-sidebar\src\client\`：

- `contract/slots.ts`：`sidebar` 入口声明全部子席位 —— `sidebar.brand.mark/name`（single）、`sidebar.workspaces`（**single**）、`sidebar.settings`（single）、`sidebar.footer.action`（list）。**不存在** New Session 行与浏览区之间的任何 list 席位。
- `SidebarRoot.tsx` DOM 顺序：`logoRow`（brand + 折叠钮）→ `button.newSession` → `div.regionArea`（渲染 `sidebar.workspaces`，ui-workspace 独占：区头"工作区"+ 搜索 + 会话树）→ `div.footArea`（`sidebar.footer.action` + `sidebar.settings`）。
- ui-workspace 只额外声明 `sidebar.workspaces.directoryFlow`（single，目录流），无导航行插口。

`D:\project-code\llm\deepseek-harness\packages\client\ui-layout\src\client\AppFrame.tsx`：

- 三列网格 `sidebarCol | centerCol | detailsCol`；中心列 = `<CenterColumn>{renderSlot('conversation', {})}</CenterColumn>`，`conversation` 是 **single** 席位（ui-conversation 独占），**中心列内没有任何可加的列表席位**。
- `shell.overlay` 渲染在独立 `.overlayLayer`（`data-shell-overlay`），是设计给"全应用级浮层"用的（list、可点击穿透），**不是给列内替换视图用的**。
- 侧栏折叠时 frame 根带 `data-sidebar-collapsed`，侧栏自身带 CSS-Module `*_collapsed` 类（双信号，family 插件已按此适配）。

**结论 A：不改 DSH 源码的前提下，官方 slot 系统无法实现"入口进导航区/视图占中心列"。** `sidebar.workspaces`、`conversation` 都是 single，唯一能"塞进去"的 `shell.overlay` 语义就是浮层。

### 2.3 dsh-taskboard 的解法（同一 shell 上已验证可运行）

`D:\project-code\llm\dsh-taskboard\src\client\`：

- `sidebar-entry.ts`：**原生 DOM 注入**。三世代选择器找侧栏根（`[data-pane="sidebar"]`、`[class*="sidebarCol"]`、DSH Desktop 两段类）；在 root 内找 New Session 按钮（`button[class*="newSession"]` → 直子 BUTTON → aria/文本兜底），把入口行 `insertBefore(NewSession.nextElementSibling)`，即**落在 New Session 与浏览区之间（工作区上方）**；body 级 MutationObserver + root 级自愈 Observer + 2s 兜底定时器，React 重渲染后自动归位；CSS 按 `[data-sidebar-collapsed]` / `[*_collapsed]` 做窄 rail 图标态。
- `board-mount.tsx`：同样三世代选择器找中心列（`[data-pane="conversation"]`、`[class*="centerCol"]`、`.dshDesktopConversationSurface`），把看板容器**append 为中心列尾子节点**（React 从不管理的 trailing child），`createRoot` 渲染 React 树；开合在 `<html>` 上打 `data-dsh-atb-active`，CSS 规则把中心列里**除看板容器外的兄弟全部 `display:none !important`**（会话内容保持挂载、仅隐藏，回来秒显、聊天状态不丢），看板容器平时 `display:none`、active 时 `display:flex;height:100%`。
- `board-mount.tsx` 的关闭监听：document **捕获阶段** click，命中侧栏行选择器（`sessionRow/projectRow/searchResultRow/searchResultWorkspace/newSession` 的 `class*=` 变体）→ `closeBoard()`；豁免自身入口子树（防 toggle 竞态，0.4.1 修复）；另有 `dsh-panel-activate` 跨插件驱逐事件（别的面板打开时本面板收起，反之亦然）。
- `styles.ts`：全局样式表注入，`dsh-atb-*` 前缀 + `--dsw-*` token，跟随主题。

dsh-taskboard 的 selectors/observer/attr-CSS/捕获关闭在**当前这套 shell（ui-layout 一代）里已经跑通**（本机 3080 GUI 即如此），可直接对照移植。sidebar DOM 挂点与中心列结构同源（同一份 apps/web），移植后行为一致。

### 2.4 可行性确认：sandore 客户端自带的支撑能力（探索到的关键 API）

- CSS：`tsdown.config.ts` 的 `cssModulesPlugin` 会把 `.module.css` 哈希注入 `<style>`，把**普通 `.css` 原样全局注入**（先例 `reactflow-theme.css`、`@xyflow/react/dist/style.css`）。→ 需要"针对 DSH shell DOM 的全局选择器"（如兄弟隐藏规则）就新建一个普通 `.css` 导入，无需改构建。
- Locale：DSH `locale` 客户端服务就是完整 LocaleFace（`packages/client/locale/src/client/index.ts`）：`ctx.locale.bind(NS)` 返回与 slot 注入 `t` **同一实现、同一键域**的稳定翻译函数；`getSnapshot()/subscribe()` 提供 revision 订阅（slot 机制内部即用它合成 `t` 并触发重渲染）。→ 自挂载树可拿到与原来完全一致的 `t`，字典仍走 `ctx.locale.register(NS, {zh, en})`。
- 全局标准 hook：`ui-workspace` 通过 `ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })` 注册 `useWorkspaces`；`workspaces` 服务（`IWorkspaces`）的 `list` 是一个 `HostObservable<WorkspaceSnapshot>`（`getSnapshot().items: WorkspaceView[]` + `subscribe`）。→ 自挂载组件可用 `useSyncExternalStore` 包一层等价 hook，不依赖 slot 渲染机。
- 既有先例：`StepChatPanel.tsx` 的 `installStepChatSessions/installStepChatWorkspaces` 就是"模块级单例注入 + ctx.effect 清理"模式，本计划沿用同款模式做 seat bridge。

---

## 3. 目标行为规格

### 3.1 能力一：入口在"工作区"上方

- 宽态侧栏：入口行位于 New Session 行之下、工作区浏览区（区头"工作区"）之上——与 taskboard 入口同位置、同几何语言。
- 窄 rail（折叠态）：入口退化为图标钮（36×36），随 `data-sidebar-collapsed` / `*_collapsed` 双信号适配。
- 开态高亮（`data-active`），点击 = `toggleWorkflowOverlay`（保持现语义）。
- 与其他 family 插件（taskboard/ssh）行共存：按"New Session 之后、family 块之内/紧邻"稳定落位，不做任何跨插件删除。

### 3.2 能力二：中心列内嵌"页面"，点会话自然消失

- 打开：工作流 UI 以中心列尾子节点容器呈现（conversation 内容 `display:none` 让位、不卸载）；**无全屏/半屏遮罩**；侧栏可交互；详情列保持宿主行为不变。
- 关闭（任一触发即关，state 保留可再开）：
  1. 点击侧栏任意**会话行 / 工作区(项目)行 / 搜索结果行 / 新建会话行**（捕获阶段监听，命中即 `closeWorkflowOverlay()`）；
  2. 再点一次入口（toggle）；
  3. 工作流内部"打开会话"动作（现有 `openSession` face 已先 `closeWorkflowOverlay()` 再 `sessions.open`）；
  4. 其他 DSH family 面板激活（`dsh-panel-activate` 驱逐事件，开自家时派发、听别家时收）。
- 会话内容**保持挂载**（隐藏而非卸载），关闭后聊天/编辑器状态零丢失。

---

## 4. 改动文件总览

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/client/workflow-seat.css` | 新增 | 全局 CSS：入口行 + rail 态 + 中心列兄弟隐藏 + 视图容器 |
| `packages/client/seat-bridge.ts` | 新增 | 模块级单例：face / locale(t) / workspaces 源注入 + hooks |
| `packages/client/sidebar-seat.ts` | 新增 | 侧栏入口 DOM 挂载（自愈 Observer、三世代选择器、active 同步） |
| `packages/client/view-seat.ts` | 新增 | 中心列视图容器挂载（createRoot）、开合 attr、点击自动关、驱逐事件 |
| `packages/client/workflow-icon.ts` | 新增 | 入口图标 SVG 字符串常量（从现 `WorkflowButton` 图标抽出） |
| `packages/client/WorkflowOverlay.tsx` | 修改 | 去掉 slot 依赖（props 清空），改用 seat-bridge；根节点改 `.viewRoot` 内嵌布局；删除 `--wf-left` 测量 effect |
| `packages/client/WorkflowOverlay.module.css` | 修改 | `.layer/.overlay/overlay-in` 删除，新增 `.viewRoot`；其余（list/editor/toggle 等）不动 |
| `packages/client/index.ts` | 修改 | 删除两处 slot 注册；inject 回调内装配 face 并 install bridge + 两个 mount；效果逆序清理 |
| `packages/client/WorkflowButton.tsx` | 删除 | 席位不再存在 |
| `packages/client/WorkflowButton.module.css` | 删除 | 同上 |
| `packages/client/workflow-seat.spec.ts` | 新增 | 席位逻辑单测（jsdom，见 §6） |
| `package.json` | 修改 | devDependencies 增加 `jsdom`（仅测试用） |

---

## 5. 详细设计（含代码片段）

> 标识统一：本插件 data 属性 `data-sandore-seat-entry`（入口）、`data-sandore-seat-view`（视图容器）、列级开态 `data-sandore-open`；全局类前缀 `dsh-sandore-seat-*`，与 taskboard 的 `dsh-atb-*` 不冲突。驱逐事件复用 family 既有事件名 `dsh-panel-activate`，自家 PANEL_NAME 取 `'dsh-sandore'`（与 taskboard 的 `'dsh-taskboard'` 区分）。

### 5.1 全局样式 `packages/client/workflow-seat.css`

仿 `dsh-taskboard/src/client/styles.ts` 顶部写法（行内几何沿用其调好的 8px margin/8px radius 观感），但前缀与 attr 全部换成 sandore 自己的。需在某个 .ts(x) 中 `import './workflow-seat.css'`（建议 `WorkflowOverlay.tsx` 或 `view-seat.ts` 顶部）。

```css
/* dsh-sandore：侧栏导航区入口行（宽态） */
.dsh-sandore-seat-entry {
  display: flex; align-items: center; gap: 8px; position: relative;
  flex: none; width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
  border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-text-secondary, var(--dsw-alias-label-secondary, inherit));
  font: inherit; font-size: 13px; line-height: 18px; cursor: pointer; text-align: left;
}
.dsh-sandore-seat-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid, rgba(128, 128, 128, .12));
  color: var(--dsw-alias-label-primary, inherit);
}
/* 打开工作流视图时行高亮（沿用旧 footer 按钮的 accent 语义） */
.dsh-sandore-seat-entry[data-active="true"] {
  background: var(--dsw-alias-accent-bg, rgba(128, 128, 128, .18));
  color: var(--dsw-alias-accent-primary, inherit); font-weight: 500;
}
.dsh-sandore-seat-entry svg { flex: none; }

/* 窄 rail（折叠）：DSH frame 的 data-sidebar-collapsed 与侧栏 CSS-Module *_collapsed 双信号 */
[data-sidebar-collapsed] .dsh-sandore-seat-entry,
[class*="_collapsed"] .dsh-sandore-seat-entry {
  width: 36px; height: 36px; min-width: 36px; margin: 0 0 12px; padding: 0;
  justify-content: center; text-align: center; border-radius: 50%;
}
[data-sidebar-collapsed] .dsh-sandore-seat-label,
[class*="_collapsed"] .dsh-sandore-seat-label { display: none; }

/* 视图容器：默认隐藏；宿主中心列带 data-sandore-open 时显示为列内全高 flex */
[data-sandore-seat-view] { display: none; }
[data-sandore-open] [data-sandore-seat-view] {
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
}

/* 打开时隐藏中心列里除本视图外的所有兄弟（会话内容保持挂载）。
   三世代列选择器与 board-mount.tsx 的 conversationColumn() 一一对应。 */
[data-pane="conversation"][data-sandore-open] > *:not([data-sandore-seat-view]),
[class*="centerCol"][data-sandore-open] > *:not([data-sandore-seat-view]),
.dshDesktopConversationSurface[data-sandore-open] > *:not([data-sandore-seat-view]) {
  display: none !important;
}
```

要点：开态 attr 打在**列元素自身**（React 不会清理它没管理的 data 属性；列节点由 React 长期持有、不重建，Observer 兜底重挂），CSS 组合器因此只需列级作用域，比 `<html>` 级更收敛；不开时不隐藏任何东西。

### 5.2 模块级桥 `packages/client/seat-bridge.ts`

仿 StepChatPanel 的 install 模式：apply 期间注入单例，组件运行时经 hooks 读取。工作流 face 照旧在 index.ts 组装（同现有代码），改为"安装"进 bridge。

```ts
/**
 * seat-bridge：自挂载工作流视图（非 slot 渲染）所需的三个模块级单例：
 * face（业务 RPC）、locale t（与 slot 同源的 ctx.locale.bind）、workspaces 源。
 * 组件树拿不到 slot 注入 props，统一经本模块注入（StepChatPanel 同款模式）。
 * @module @meiyukichan/dsh-sandore/src/client/seat-bridge
 */
import { useSyncExternalStore } from 'react'
import type { WorkflowOverlayFace } from './workflow-face.ts'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

/** workspaces 服务 list 的可观察形状（避免为类型引入新 peer 依赖）。 */
export interface WorkspaceSourceLike {
  getSnapshot(): { items: readonly WorkspaceView[]; archivedSessionIds?: readonly string[] }
  subscribe(fn: () => void): () => void
}

/** locale 服务的可观察 + bind 形状（运行时即 LocaleRuntime 的窄面）。 */
export interface SeatLocaleLike {
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  subscribe(fn: () => void): () => void
}

let face: WorkflowOverlayFace | undefined
let locale: SeatLocaleLike | undefined
let workspaceSource: WorkspaceSourceLike | undefined
const listeners = new Set<() => void>()

function notify(): void { for (const fn of [...listeners]) fn() }

/** 安装（幂等；apply 的 ctx.effect 清理时调用 clearSeatBridge）。 */
export function installSeatBridge(
  value: WorkflowOverlayFace,
  localeLike: SeatLocaleLike,
  workspaces: WorkspaceSourceLike | undefined,
): void {
  face = value
  locale = localeLike
  workspaceSource = workspaces
  notify()
}

export function clearSeatBridge(): void {
  face = undefined; locale = undefined; workspaceSource = undefined
}

// ---- 组件侧读取 ----
export function useSeatFace(): WorkflowOverlayFace | undefined {
  return useSyncExternalStore(subscribeSeat, getSeatFace)
}
export function getSeatFace(): WorkflowOverlayFace | undefined { return face }

/** locale revision 订阅：与 slot 渲染机同一信号，切换语言时重渲染整棵树。 */
export function useSeatLocaleRevision(): number {
  const snap = useSyncExternalStore(
    (fn) => { const un = locale?.subscribe(fn); return () => { un?.() } },
    () => localeRevision(),
  )
  return snap
}
let revision = 0
function localeRevision(): number {
  // 订阅回调里递增即可；真实实现改为记录 locale 侧 revision
  return revision
}

/** 工作区快照选择 hook（等价 slot 注入的 useWorkspaces）。 */
export function useSeatWorkspaces(): readonly WorkspaceView[] {
  const EMPTY: readonly WorkspaceView[] = []
  return useSyncExternalStore(
    (fn) => { const un = workspaceSource?.subscribe(fn); return () => { un?.() } },
    () => workspaceSource?.getSnapshot().items ?? EMPTY,
  )
}

function subscribeSeat(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
```

> 注：上例把 revision 简化了。实现时让 `installSeatBridge` 接受 `localeLike.subscribe`，在内部把 locale 变化转发给 `listeners`（每次 locale 变更 bump 一个计数器），使 `useSeatLocaleRevision` 返回变化值以触发整树重渲染——`t` 本身稳定（`bind(NS)` 缓存同一函数、调用时读当前语言），重渲染后文本即新语言。视图树的 `t` 由 `WorkflowOverlay` 内部取：

```ts
// WorkflowOverlay 内（5.4）：模块级缓存 bind 结果
let boundT: ((key: string, params?: Record<string, unknown>) => string) | undefined
export function seatT(): (key: string, params?: Record<string, unknown>) => string {
  if (boundT === undefined && bridgeLocale !== undefined) boundT = bridgeLocale.bind(NS)
  return boundT ?? ((key) => key)
}
```

（若嫌桥接太绕，备选：`WorkflowOverlay` 保留 `t`/`face`/`workspaces` props，由 view-seat 的 host 组件提供——见 5.4 注释。两种都行，推荐桥接版，改动面最小。）

### 5.3 侧栏入口 `packages/client/sidebar-seat.ts`

结构对照 `dsh-taskboard/src/client/sidebar-entry.ts` 移植，但只保留 sandore 需要的部分（icon + label + active 高亮，无数字徽标）；属性与类名换成本插件前缀；自愈逻辑与三世代选择器保持一致。

```ts
/** 侧栏导航区入口（工作区上方）：原生 DOM 行，避免扰动 DSH React 调和。 */
import { getWorkflowState, subscribeWorkflowState, toggleWorkflowOverlay } from './workflow-store.ts'
import { WORKFLOW_ICON } from './workflow-icon.ts'

export const SEAT_ENTRY_SELECTOR = '[data-sandore-seat-entry]'

/** 三世代侧栏根：dev 壳 data-pane、官方 layout 的 sidebarCol、DSH Desktop 包装。 */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(
    '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface',
  )
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** New Session 按钮（宽态行即其下）；自检排除自身入口。 */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child instanceof HTMLButtonElement && !child.matches(SEAT_ENTRY_SELECTOR)) return child
  }
  const byAria = root.querySelector<HTMLButtonElement>(
    'button[aria-label="新建会话"], button[aria-label="New Session"], button[aria-label*="新会话"], button[aria-label*="new session" i]',
  )
  if (byAria !== null) return byAria
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .find(b => !b.matches(SEAT_ENTRY_SELECTOR) && /新会话|新建会话|new session/i.test(b.textContent ?? ''))
}

/** 目标锚点：自己的行（若已在位）> 第一个 family 行 > New Session 的下一兄弟（浏览区）。
    永远不 append 到 root 末尾（会把入口甩到设置区下面）。 */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  if (entry.parentElement === root && root.contains(entry)) return true
  const button = newSessionButton(root)
  if (button === undefined) return false
  const row = button.closest('[class*="logoRow"]')
  const base = (row !== null && row.parentElement === root) ? row : button
  const family = Array.from(root.children).filter((el): el is HTMLElement =>
    el instanceof HTMLElement && el.matches(
      '[data-sandore-seat-entry], [data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]',
    ))
  const anchor = family.find(el => el !== entry) ?? base.nextElementSibling
  if (anchor === null || anchor === entry) return false
  root.insertBefore(entry, anchor)
  return true
}

/** 挂载入口；返回 disposer。DOM 失败只降级（不显示入口），绝不抛给 GUI。 */
export function mountSidebarSeat(): () => void {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.sandoreSeatEntry = ''
  entry.className = 'dsh-sandore-seat-entry'
  entry.innerHTML =
    `<span aria-hidden="true">${WORKFLOW_ICON}</span><span class="dsh-sandore-seat-label">工作流</span>`
  entry.addEventListener('click', () => { toggleWorkflowOverlay() })

  let root: HTMLElement | undefined
  let placed = false
  const syncActive = () => {
    if (getWorkflowState().open) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribeStore = subscribeWorkflowState(syncActive)
  syncActive()

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) { root = undefined; placed = false }
    if (placed && document.body.contains(entry)) return
    placed = false
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected || !root.contains(entry)) tryPlace()
  })
  const retry = setInterval(() => { tryPlace() }, 2_000)
  tryPlace()

  return () => {
    clearInterval(retry)
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeStore()
    entry.remove()
  }
}
```

> 文案补丁点（实现时）：label/aria 不要硬编码——`entry` 文本在 `installSeatBridge` 提供 `locale.bind(NS)` 后经 `subscribeSeat` 更新（`'button.trigger'`/`'button.aria'`，zh/en 键已存在）。为保持片段可读上面先写死中文，实施时替换为"读取 `getSeatT()('button.trigger')` + 订阅更新"。rail 态不需要 JS——CSS 已按祖先折叠信号隐藏 label。

### 5.4 中心列视图挂载 `packages/client/view-seat.ts`

结构对照 `board-mount.tsx`：容器 append 到中心列尾部 → `createRoot` 渲染 `WorkflowOverlay`；开合状态打到列元素 attr；捕获 click 关、驱逐事件互斥。

```ts
/** 工作流视图挂载：中心列尾子容器 + React 根；会话列内容由 CSS 隐藏（保持挂载）。 */
import { createRoot, type Root } from 'react-dom/client'
import { WorkflowOverlay } from './WorkflowOverlay.tsx'
import { SEAT_ENTRY_SELECTOR } from './sidebar-seat.ts'
import { closeWorkflowOverlay, getWorkflowState, subscribeWorkflowState } from './workflow-store.ts'

export const SEAT_VIEW_SELECTOR = '[data-sandore-seat-view]'

const CONVERSATION_COLUMN_SELECTOR =
  '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
const OPEN_ATTR = 'data-sandore-open'
const SIDEBAR_ROW_SELECTOR =
  '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'dsh-sandore'

function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

/** 挂载视图容器与 React 根，绑定开合；返回 disposer。 */
export function mountWorkflowSeatView(): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let column: HTMLElement | undefined

  const ensure = (): void => {
    if (container !== undefined) return
    column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.sandoreSeatView = ''
    column.appendChild(container)
    root = createRoot(container)
    // WorkflowOverlay 内部自读 bridge（face/workspaces/t）；关闭时返回 null。
    root.render(<WorkflowOverlay />)
    if (getWorkflowState().open) column.setAttribute(OPEN_ATTR, '')
  }

  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyOpen = (): void => {
    if (column === undefined) return
    if (getWorkflowState().open) {
      // 与 taskboard 互斥：开自家前先广播；别家开的时候我们关。
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
      column.setAttribute(OPEN_ATTR, '')
    } else {
      column.removeAttribute(OPEN_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== PANEL_NAME && getWorkflowState().open) closeWorkflowOverlay()
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!getWorkflowState().open) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(SEAT_ENTRY_SELECTOR) !== null) return   // 入口子树整体豁免（toggle 竞态）
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) closeWorkflowOverlay()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = subscribeWorkflowState(applyOpen)
  applyOpen()
  ensure()

  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    column?.removeAttribute(OPEN_ATTR)
    root?.unmount()
    container?.remove()
  }
}
```

要点（对照 taskboard 已验证行为）：

- 开态 attr 打在**列元素**（`column.setAttribute(OPEN_ATTR, '')`），CSS 见 5.1；列节点被 React 重渲染时 data 属性不受影响；若列节点被整体重建（桌面扩展壳），`ensure()` 的重放逻辑（开态补打 attr）兜底。
- 点击关：捕获阶段先于会话行的 React onClick 执行 → 视图先收起、会话内容立即显示，随后会话切换发生，无"点两次"。
- 豁免 `SEAT_ENTRY_SELECTOR` 子树：入口若嵌在带 `newSession` 类的容器祖先内，先 `closeWorkflowOverlay` 再被自身 toggle 翻回的竞态必须按子树豁免（taskboard 0.4.1 教训，注释保留）。
- 跨插件驱逐：开自家广播 `dsh-panel-activate`，taskboard 收到会关它的板；反之我们收它的广播即关。两者不会同时占中心列。
- **不再需要** `WorkflowOverlay` 里测量 sidebar 宽 → `--wf-left` 的 ResizeObserver effect（5.5 删掉）。

### 5.5 `WorkflowOverlay.tsx` 改造（slot 依赖清零）

```tsx
// 修改前：props = InjectFace<WorkflowOverlayFace> & PropsLocale<'sandore'> & GlobalStandardProps（useWorkspaces）
// 修改后：无 props；face / workspaces / t 全部经 seat-bridge 读取。
export function WorkflowOverlay() {
  const open = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().open)
  const listWidth = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listWidth)
  const listCollapsed = useSyncExternalStore(subscribeWorkflowState, () => getWorkflowState().listCollapsed)
  const face = useSeatFace()
  const workspaces = useSeatWorkspaces()
  const t = getSeatT()          // 稳定引用；locale revision 由 useSeatLocaleRevision() 驱动重渲染
  useSeatLocaleRevision()
  if (!open) return null
  if (face === undefined) return null   // bridge 未就绪（理论不发生：mount 在 install 之后）

  return (
    <div className={css.viewRoot} data-sandore-wf-view>
      <div className={css.body}>
        {listCollapsed ? <ListRail t={t} onExpand={toggleListCollapse} /> : (
          <>
            <WorkflowList t={t} workspaces={workspaces} face={face} refreshKey={0} width={listWidth} />
            <DragHandle side="list" className={css.dragHandle} onDrag={resizeListWidth} />
          </>
        )}
        <EditorPane t={t} face={face} onSaved={() => { /* refreshKey 提升逻辑见下 */ }} />
      </div>
    </div>
  )
}
```

- 删除：`--wf-left` ResizeObserver effect、`layerRef`、`sidebar 实测宽`注释块、`.layer/.overlay` 两层外壳、props 解构。
- `refreshKey` 原为组件内 `useState`，保留 useState 即可（片段为省篇幅写成 0；实施保持原状）。
- 文件顶部删掉 `PropsLocale/InjectFace/GlobalStandardProps` 相关 import，改从 `seat-bridge.ts` 引入 hooks；`t` 类型仍为 `TranslateNS<'sandore'>`（由 `getSeatT()` 内部 cast，键域一致）。

`WorkflowOverlay.module.css` 修改：

```css
/* 删除：.layer（absolute/inset/z-index/pointer-events）与 .overlay（left:var(--wf-left)、shadow、动画）
   及其 @keyframes overlay-in。新增： */
.viewRoot {
  width: 100%; height: 100%; min-height: 0;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-base);
  overflow: hidden;
}
```

`.body` 及以下（`.list*`/`.editorCol*`/`.toggle*`/`.listRail`/`.railBtn`/`.dragHandle`/`.error`）全部原样保留——`WorkflowList`/`EditorPane` 继续引用这些类。

### 5.6 `index.ts` apply 重构

删除：`WorkflowButton` 导入与 `sidebar.footer.action` 注册（43-49 行）、`WorkflowOverlay` 相关 import（14-17 行）、`shell.overlay` 注册整块（67-163 行）。保留：locale 注册、`$mount(sandoreRemote)`、StepChat 安装。`ctx.inject(['remote.sandore','remote.commands'])` 回调体内改为装配 + 安装 + 挂载：

```ts
await ctx.inject(['remote.sandore', 'remote.commands'], (remoteCtx) => {
  const sandore = remoteCtx.remote.sandore
  const workspaces = (remoteCtx as unknown as {
    workspaces: {
      list?: { getSnapshot(): { items: readonly WorkspaceView[] }; subscribe(fn: () => void): () => void }
      pickDirectory(): Promise<string | null>
      listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
      createDirectory(path: string, name: string): Promise<string>
    }
  }).workspaces

  const face: WorkflowOverlayFace = { /* 与现有 73-161 行同内容：listInstances…queryPermission */ }

  const disposers: Array<() => void> = []
  installSeatBridge(face, remoteCtx.locale as unknown as SeatLocaleLike, workspaces.list)   // 幂等
  disposers.push(mountSidebarSeat())
  disposers.push(mountWorkflowSeatView())
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    clearSeatBridge()
  }, 'ui-sandore: seat mounts')
})
```

- face 构造代码逐行复用现有实现（含权限投影、命令执行、模型目录桥），**零逻辑改动**，只搬位置。
- `WorkflowButtonFace`/`WorkflowButton`/`WorkflowButton.module.css` 删除（footer 席位不存在了）。
- `workflow-icon.ts` 导出 `WORKFLOW_ICON`：把原 `WorkflowButton.tsx` 内联 16×16 workflow SVG 的 path 数据拷为字符串常量（`fill="currentColor"`），入口 innerHTML 使用。

### 5.7 关闭矩阵（验收对照表）

| 用户动作 | 视图是否关闭 | 机制 |
|---|---|---|
| 点侧栏会话行 | 关 | 捕获 click + `sessionRow` 匹配 |
| 点工作区（项目）行 / 搜索结果 | 关 | 同上 |
| 点"新建会话"（含 logo 行宽态 brand 内嵌按钮经 `newSession` 类/`logoRow` 行内子按钮? 见注） | 关 | 同上（`class*="newSession"`） |
| 再点 sandore 入口 | 关（toggle） | 入口 onClick |
| 工作流内点实例跳会话 | 关 | face.openSession 先 close 再 sessions.open（保留） |
| taskboard/ssh 面板打开 | 关 | `dsh-panel-activate` 驱逐 |
| 点设置 / 模型选择 / 详情列 | 不关 | 无匹配行（与 taskboard 一致） |

> 注：侧栏品牌 logo（宽态 New Session 快捷键）不在 `class*="newSession"` 命中范围（它是 `class*="brand"`）。实现时对照真实 DOM 决定是否把 `[class*="logoRow"]` 纳入行选择器——taskboard 未纳入，首版保持与其一致，验收时观察是否"点击 logo 新建会话后视图未关"再补。此点写入风险清单。

---

## 6. 测试计划

### 6.1 单元测试（新增 `packages/client/workflow-seat.spec.ts`）

vitest 现为 node 环境；给该文件加 `// @vitest-environment jsdom`，并在 devDependencies 增加 `jsdom`（taskboard/DSH 同款做法）。

用例（jsdom 手搭最小 DOM，覆盖纯逻辑与挂载行为）：

1. **落位**：仿 SidebarRoot 结构（`logoRow + newSession button + 浏览区 div`）时，`placeEntry` 后入口恰在 newSession 与浏览区之间；root 无按钮时不插；重复调用不重复插入。
2. **自愈**：模拟 React 重渲染（把入口摘走再触发 rootObserver 回调）→ 入口回到原位。
3. **开合 attr**：open=true → 列元素带 `data-sandore-open` 且容器 display 由 CSS 规则接管（jsdom 只断言 attr；display 断言放 QA）；open=false → attr 移除。
4. **点击自动关**：dispatch click（捕获）于 `sessionRow` 元素 → store open=false；点击入口子树 → 不关。
5. **驱逐事件**：收到 `dsh-panel-activate`（detail≠'dsh-sandore'）→ 关；开自家 → 广播事件 detail='dsh-sandore'。
6. **bridge**：installSeatBridge 幂等、clear 后组件读 undefined；workspaces hook 空源回落 `[]`。
7. 既有 spec 全量回归（`pnpm test`）。

### 6.2 手动 QA 清单（dev 实例 3090）

```bash
pnpm build
node --import tsx/esm D:\project-code\llm\deepseek-harness\apps\cli\src\bin.ts --profile web --patch D:\project-code\llm\sandore\cordis.yml --port 3090
# 浏览器 http://127.0.0.1:3090
```

- [ ] 入口出现在 New Session 行之下、工作区列表之上（与 taskboard 入口同排），foot 的旧按钮消失；
- [ ] 打开后中心列显示工作流台（列表/编排/执行/运行实例），**无遮罩、无浮层阴影**；详情列行为同 taskboard（随宿主）；
- [ ] 打开态点击任意会话 → 视图消失、会话聊天显示且状态无损；点工作区/搜索结果同理；
- [ ] 再点入口 toggle 关闭正常；实例内跳会话（运行行"打开会话"）先关再跳；
- [ ] 侧栏折叠 rail：入口 36×36 图标态，点击可开/关；展开恢复行态；
- [ ] 宽窄切换、会话切换、语言切换（设置→通用→语言）后入口文本/整树语言即时刷新；
- [ ] HMR（改 client 代码 → 重载）后入口/视图自动重建、无重复行/重复 React 根；
- [ ] 与 dsh-taskboard 同装：两入口同排无冲突；一方打开另一方自动收起；CSS 不串（无 dsh-atb 污染/被污染）；
- [ ] DagEditor（画布、新增节点、导入/导出 YAML、保存）、RunView 三栏、StepChat 打开等原有功能回归。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| DSH 未来改版破坏 CSS-Module 类后缀/结构（`centerCol`/`newSession`/折叠信号） | 与 taskboard 相同三世代选择器 + 可降级设计（找不到就不挂，绝不抛异常破坏 GUI）；这类 DOM-seat 是 family 插件（taskboard/ssh）共用约定 |
| 中心列 React 重渲染清理我们加的 attr/容器 | 容器/attr 均不受 React 管理（trailing child、未声明 data 属性）；Observer 兜底重挂并重放开态 |
| 与 taskboard 行/事件抢位 | 属性前缀隔离；开态互斥走既有 `dsh-panel-activate`；入口 family 锚点只做自身归位、不删别家节点 |
| 语言切换时入口文本/视图不刷新 | `ctx.locale.subscribe` revision 驱动（slot 渲染机同信号） |
| `locale.bind`/`workspaces.list` 窄面与真实服务不符（类型绕过） | 结构与 DSH 源码逐项核对（本文 2.4 已列依据）；tsc typecheck + QA 清单覆盖 |
| logo 行"新建会话"点击不关视图 | 与 taskboard 行为一致（首版不纳入），验收时按需补 `logoRow` 命中（见 5.7 注） |
| 视图打开时 URL/会话在别处（通知/命令）被切换 | 视图像 taskboard 一样只响应侧栏行点击；若验收发现需要"会话 current 变化即关"，可加 `sessions` 订阅（face 已持 sessions），列为增量项 |

---

## 8. 验收标准

1. sandore 侧栏入口出现在**工作区浏览区上方**（与 taskboard 入口同位），设置上方不再有 sandore 按钮。
2. 点击入口打开的是**中心列内嵌工作台**：无遮罩/无浮层体感、侧栏可交互、会话内容隐藏但保留（关闭后聊天原地恢复）。
3. 打开态**点击任意工作区会话/项目行即自动关闭**；再点入口也可关闭；其余关闭时机符合 5.7 矩阵。
4. 窄 rail、语言切换、HMR、与 taskboard 共存互斥均通过 §6.2 QA。
5. `pnpm typecheck`、`pnpm test`（含新增 spec）、`pnpm build` 全绿；主分支直接提交（不建分支）。
