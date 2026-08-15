# Furina Explore — 探索结果

## Explore Content（需求理解）

**What（是什么）**：为 sandore 工作流引擎 DSH 插件的 Client UI 入口（`@deepseek-ai/dsh-client-ui-sandore`）找到 DSH 官方参考实现范式。具体四个能力点：

1. `sidebar.footer.action` 按钮 slot 注册（设置上方入口按钮）
2. WorkflowPanel 展开面板占位 + 面板开关的 client 状态管理
3. Client 包 `package.json` 声明（`dsh.client` + `exports["./client"]`）
4. `host.call('sandore.ping')` 的 RPC 往返范式
5. `ui-primitives` 的公开扩展点（可复用组件清单）

**Boundaries（边界）**：仅探索 DSH 源码（`D:\project-code\llm\deepseek-harness`）中与上述四点直接相关的参考实现；不涉及 Host 端 seam/Provider 实现细节，不涉及真实引擎逻辑。

**Goal（目标）**：拿到可直接对照落地的参考范式（注册代码形态、props 组成、package.json 结构、RPC 两条链路、可复用 primitives），供 Task 1 的 `packages/sandore/ui/` 实现。

## Explore Type

specification

## Exploration Results

> 说明：`furina config show exploration.specification` 返回空数组 `[]`，无外部规格物料。本探索直接以 design.md / work.md 中指定的 DSH 源码路径为规格来源，全部结论基于真实代码。

---

### 1. sidebar.footer.action 槽位注册范式（footer 按钮 + 展开面板）

#### 1.1 Slot 系统三层结构

| 层 | 包 / 文件 | 职责 |
|---|---|---|
| 纯核心 | `packages/client/ui-slots/src/index.ts`（`SlotCore`） | slot 注册语义、声明台账、`SlotMap`/`SlotEntryDef` 类型、`kind`（single/list/keyed/chain）、`scope`（root/session-maybe/session） |
| 运行时 Service | `packages/client/runtime/src/client/slots.ts`（`SlotRegistry`） | `ctx.slots`：`inject(key, cb)`（按声明生命周期安装贡献）、`register(options, component)`、`install`/`installLocale`、store 实例轴 |
| 渲染 | `packages/client/ui-layout` / `web-react` | `root` 槽渲染树 |

关键点：`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({...}, Component))` 中，`register` 的返回值/disposal 由 `ctx.effect` 绑定到调用方 fiber——插件卸载即级联卸载。

#### 1.2 slot 声明链（谁声明了 `sidebar.footer.action`）

声明是分级的：**slot 先由父 entry 的 `children` 表声明，才能被 register 注入**。

1. `ui-layout` 的 `AppFrame` 注册进 `root`，声明 `sidebar`。
2. `ui-sidebar` 注册 `sidebar` 槽，并在其 `children` 里声明三个子槽（`packages/client/ui-sidebar/src/client/index.ts:40-55`）：

```typescript
ctx.slots.register({
  name: 'sidebar',
  locale: NS,
  children: {
    'sidebar.workspaces': { kind: 'single', scope: 'root' },
    'sidebar.settings': { kind: 'single', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  },
  inject: injectProps,
}, SidebarRoot)
```

3. 槽类型在 `packages/client/ui-sidebar/src/client/contract/slots.ts:16-37` 通过 declaration merging 写入 `SlotMap`：

```typescript
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}
// owner share —— 槽组件唯一收到的框架 props：
export interface SidebarFooterActionOwnerProps {
  wide: boolean   // sidebar 是否展开（false = 56px rail 仅图标）
}
```

4. `SidebarRoot.tsx:182-189` 实际渲染 footer action（位于 settings 上方）：

```typescript
<div className={css.footArea}>
  <div className={css.footerActions}>
    {renderSlot('sidebar.footer.action', { wide })}
  </div>
  <div className={css.settingsArea}>
    {renderSlot('sidebar.settings', { wide })}
  </div>
</div>
```

#### 1.3 插件侧注册范例（ui-cordis 是唯一权威参照）

`packages/extensions/ui-cordis/src/client/index.ts:84-112`：

```typescript
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'cordis-panel',          // list 槽必须提供 id（cell 键）
  locale: NS,                  // 声明字典命名空间 → 组件得到类型化 t
  inject: (): CordisPanelFace => ({
    hooks: { inventory, activeRuns: runner.activeRuns, ... },  // HostObservable 源
    onApprove: ..., onRun: ..., onRefresh: ...,
  }),
}, CordisPanel))
```

要点：
- `sidebar.footer.action` 是 **list** 槽：注册必须给 `id`（`SlotCore.register` 对 list 缺失 id 会 throw）；可选 `order`/`label`/`priority`。
- 可加性（additive）：多个插件可各自 `id` 注册，互不覆盖，都渲染在 settings 上方。
- 组件 props 由 `register` 声明 + 框架标准件组合而成（`ui-slots/src/index.ts` 的 `ComposedProps`），组件侧用现成类型拼装。

---

### 2. 面板开关 client 状态（自包含）+ 组件形态

参照 `packages/extensions/ui-cordis/src/client/CordisPanel.tsx`：

#### 2.1 面板开关是组件自有 state

```typescript
const [open, setOpen] = useState(false)
...
return (
  <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
    {open && (
      <section className={css.panel} aria-label={t('panel.title')}> ... </section>
    )}
    <div className={css.footerButtons}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconCordisPluginOutline14 />
        {wide && <span className={css.badgeLabel}>{t('panel.trigger')}</span>}
      </button>
    </div>
  </div>
)
```

关键结论（与 design.md D6「面板开关是插件自有 client 状态」一致）：
- **footer 按钮与展开面板在同一个 slot 组件内**，`open` 用 `useState(false)` 自包含，不需要跨 scope 联动、不需要 store。
- 该组件同时充当「按钮 + 面板」两个角色；design.md 里拆成 `WorkflowButton.tsx` + `WorkflowPanel.tsx` 两文件只是文件组织，最终仍是同一组件渲染按钮+面板（或按钮组件触发父组件 state）。
- `wide` 来自 owner share：`wide` 时按钮带文字 label，rail 时只渲染图标（`aria-expanded` 始终给）。

#### 2.2 组件 props 组成范式

`CordisPanel.tsx:23-24`：

```typescript
export type CordisPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>
```

- `PropsRuntime<'sidebar.footer.action'>` = owner share（`{ wide }`）等框架件。
- `InjectFace<CordisPanelFace>`：`inject` 里 `hooks` 命名空间下每个 `HostObservable<T>` 源会合成 `use<Name>` selector hook（如 `useInventory`、`useActiveRuns`）；其余成员原样透传。见 `ui-slots/src/index.ts` 的 `InjectFace`/`PropsHooks` 与 `renderer.ts` 的 `HostObservable<T>`（`getSnapshot` + `subscribe`）。
- `PropsLocale<'cordis'>`：注册时声明 `locale: NS` 后注入的 `t` 函数。

#### 2.3 面板样式要点（`CordisPanel.module.css`）

- 面板 `position: fixed; left: 12px; bottom: 128px;` 从 footer 上方浮出，`z-index: 30`，宽 420px、`max-height: 60vh`，用 `--dsw-*` 主题 token（`--dsw-alias-bg-base`、`--dsw-alias-border-l1`、`--dsw-shadow-lv2` 等）着色。
- 按钮 49px 高、圆角、hover 用 `--dsw-alias-interactive-bg-hover-solid`。

---

### 3. Client 包 package.json 声明

参照 `packages/extensions/ui-cordis/package.json`（第二参照：`packages/client/ui-workflow-run/package.json`）：

```jsonc
{
  "name": "@deepseek-ai/dsh-client-ui-cordis",
  "version": "0.1.0-rc.5",
  "publishConfig": { "access": "public" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-cordis-client-runner",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-input-trigger",
        "@deepseek-ai/dsh-client-ui-tool",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-client-ui-slots": "workspace:^",
    "@deepseek-ai/dsh-client-ui-primitives": "workspace:^",
    "@deepseek-ai/dsh-client-ui-sidebar": "workspace:^",
    "@deepseek-ai/dsh-client-runtime": "workspace:^",
    "@deepseek-ai/dsh-client-locale": "workspace:^",
    "@deepseek-ai/dsh-invariants": "workspace:^",
    "react": "^18.2.0"
  },
  "files": [ "lib/index.js", "lib/invariant.js", "lib/client.js", "lib/types/**/*.d.ts" ]
}
```

关键结论：
- **Client 插件声明在 `dsh.client` 字段**（不是 `dshClient`）：`{ "inject": [<npm 包名数组>], "platform": "web" }`。`inject` 数组内是**依赖的 npm 包名**（如 `@deepseek-ai/dsh-client-ui-sidebar`），不是 cordis service key——DSH 用它决定 client 构建时的组装顺序与运行注入。
- `exports["./client"]` 指向构建产物 `lib/client.js` + `.d.ts`；源码在 `src/client/`。
- 对 sandore 而言，`dsh.client.inject` 需含 `@deepseek-ai/dsh-client-ui-sidebar`（提供 `sidebar.footer.action` 槽声明）、`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-api-remotes`（RPC）；DSH 内部用 `workspace:^`，sandore 按约定改用 npm 版本 `0.1.0-rc.5`。
- Client 插件的 `apply(ctx)` 里注入的服务键（`export const inject = ['slots', 'locale', ...]`）与 package.json `dsh.client.inject` 是两回事：前者是 cordis service 键，后者是 npm 包名。

#### ClientContext 类型

`packages/client/runtime/src/client/index.ts:112`：`export type ClientContext = Context`。所有 client 插件 `apply(ctx: ClientContext)` 均从 `@deepseek-ai/dsh-client-runtime/client` import。为拉取 sidebar 槽的 `SlotMap` 声明，须带 `import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'`（type-only，见 `ui-cordis/src/client/index.ts:6`）。

---

### 4. host.call RPC —— 两条链路

DSH 里「Client 调 Host」存在两条独立机制，design.md 各用其一部分：

#### 4.1 生产范式：TypertRemoteService + @Remote（sandore.ping 的正式落点）

参照 `packages/goal/goal/src/index.ts`（`GoalService`）：

```typescript
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class GoalService extends TypertRemoteService {
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'goals')        // namespace = 'goals'
  }
  @Remote('edit')              // → 端点 goals.edit
  edit(agent, ref, request) { ... }
  @Remote('create')            // → 端点 goals.create
  remoteExportCreate(agent, request) { ... }
}
```

- `TypertRemoteService` 基类（`packages/typert/protocol/src/index.ts:147-161`）在构造时 `super(ctx, serviceKey)`，并用 `bindTypertRemote(this, this.name, options)` 绑定 namespace（默认 = serviceKey）。
- **名字段合法字符**：`isTypertRemoteSegment` 用 `/^[A-Za-z0-9_$.-]+$/`（点号、下划线均合法）。因此 `super(ctx, 'sandore')` + `@Remote('ping')` → 端点 **`sandore.ping`**（与 work.md「RPC 方法 `sandore.*`（点号）」完全对齐）。
- `@Remote(exportName)` 支持别名导出（导出名与实现方法名可不同）。
- 客户端经类型化 `ctx.remote` 消费：`api/remotes/src/client/index.ts` 中 `declare module '@deepseek-ai/cordis' { interface Context { remote: TypertClientRemote } }`，通过 `ctx.remote.$mount(contribution)` 挂载生成产物，`$on` 订阅转发事件（`typert/protocol/src/types.ts` 的 `TypertClientRemote`）。
- 返回值约定：`RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }`（见 `types.ts:60-62`）——客户端调用侧把 carrier 失败折叠进 error 分支。

#### 4.2 原型范式：harness.handle（Host）+ host.call（Client）—— `cordis_define`/`cordis_run` 动态插件

design.md §7.2 用 `cordis_define`/`cordis_run` 做快速原型验证。此机制下：

- **Host 半**：`harness.handle(method, fn)`（`packages/extensions/cordis-host-runner/src/index.ts:888-896`）把 handler 存入 `run.handlers: Map<string, DynamicCordisHandler>`；`DynamicCordisHandler = (args: unknown) => Promise<unknown>`（`registry.ts:14`）。`guard.ts` 的 `normalizeHandler` 校验 method 为非空字符串、fn 为函数，返回结果经 JSON clone。
- **Client 半**：`host.call(method: string, args?: JsonValue): Promise<JsonValue>`（`packages/extensions/cordis-client-runner/src/client/providers.ts:56-59` 的 builtin 签名）。`host` 是动态 client half 的**闭包符号**（不是 ctx service），与 `ctx`、`React`、`styles`、`console` 并列（`CLIENT_BUILTIN_INSPECTION`）。
- **路由**：`host.call` → evaluator 的 `invoke(method, args)` → `DynamicCordisRunnerEnv.invoke(pluginId, pluginRunId, method, args)`（`cordis-client-runner/src/client/runtime.ts:125-131`）→ Host `@Remote('invoke')`（`cordis-host-runner/src/index.ts:740-766`）→ `run.handlers.get(method)`。方法名由插件作者自定义，方向 Client→Host，仅 lossless JSON 可跨边界（`tool-cordis/src/prompt.ts:98`）。

**两者关系**：Task 1 产出的 `remote.ts` 用 Typert `@Remote('ping')`（生产），`harness.handle`/`host.call` 仅作动态原型验证捷径。design.md §6.1 写的 `host.call('sandore.ping')` 属于原型链路下的调用写法（原型里 method 字符串可自定义为 `'sandore.ping'`）。

---

### 5. ui-primitives 公开扩展点（可复用组件清单）

`packages/client/ui-primitives/src/index.ts` 全部导出（供自绘 WorkflowPanel 复用，风格经 `--dsw-*` token 主题化）：

- 基础原子：`StateDot`（`StateDotState`）、`DisclosureRow`（`DisclosureRowProps`）、`Button`（`ButtonVariant`）、`Pill`、`Input`、`Tooltip`（`TooltipSide`）、`Toast`、`Menu`（`MenuEntry/MenuItem/MenuSeparator/MenuLabel`）
- 浮层/表面：`HoverCard`、`Modal`、`OnboardingSurface`、`RiskConfirmation`、`ConnectionBanner`
- 品牌：`FishLogo`、`BrandWordmark`
- 工具：`writeClipboard`、`useAnchoredMaxHeight`、`extractMarkdownPlainText`
- 内容块：`JsonTree`、`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`
- Markdown：`CodeBlock`、`JsonBlock`、`MarkdownText`、`MessageText`
- 图标：`export * from './icons/index.tsx'`（`Icon*`，如 `IconCordisPluginOutline14`、`IconPlayOutline16` 等，`IconChevronRightOutline14` 用于 ui-workflow-run 面板）

---

### 6. 补充（与 Task 1 ui 直接相关但属后续 Task）

- **`conversation.chat.node` keyed 槽**（D8 讨论面板，Task 1 仅预留，非主入口）：`packages/client/ui-workflow-run/src/client/index.ts:24-31` 展示 keyed 注册形态：`ctx.slots.register({ name: 'conversation.chat.node', key: 'workflow-run', locale: NS, inject: ... }, WorkflowRunPanel)`。其组件 props 为 `PropsRuntime<'conversation.chat.node', 'workflow-run'> & PropsLocale<...> & Injected`。
- **panel 风格参照**：`ui-workflow-run/src/client/WorkflowRunPanel.tsx` 复用 `DisclosureRow`、`StateDot`、`IconChevronRightOutline14`，可作为「仿 workspace 风格三态列表占位」的组件选型参照。
- **slots.inject 语义**：`SlotRegistry.inject(key, cb)`（`client/runtime/src/client/slots.ts:143-205`）按声明生命周期安装 callback（声明已存在则同步跑；未声明则等父 entry 声明后跑；父卸载则级联清理），因此插件无需关心加载顺序即可安全注入 `sidebar.footer.action`。

---

### 关键文件清单（绝对路径）

- `D:\project-code\llm\deepseek-harness\packages\client\ui-sidebar\src\client\contract\slots.ts` —— `sidebar.footer.action` SlotMap 声明 + `SidebarFooterActionOwnerProps`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-sidebar\src\client\SidebarRoot.tsx` —— footer action 渲染位置（settings 上方）
- `D:\project-code\llm\deepseek-harness\packages\client\ui-sidebar\src\client\index.ts` —— `sidebar` entry 注册 + children 声明链
- `D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\index.ts` —— footer 按钮 slot 注册权威范例
- `D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\CordisPanel.tsx` —— 面板开关 state + 按钮/面板同组件
- `D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\slots.ts` —— inject face 类型声明
- `D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\CordisPanel.module.css` —— 面板/按钮样式 token
- `D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\package.json` —— `dsh.client` + `exports["./client"]` 声明
- `D:\project-code\llm\deepseek-harness\packages\client\ui-slots\src\index.ts` —— SlotCore / SlotMap / `ComposedProps` / `InjectFace` / `PropsRuntime`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-slots\src\renderer.ts` —— `HostObservable` / `SlotRendererHost`
- `D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\slots.ts` —— `ctx.slots`（SlotRegistry）+ `inject` 语义
- `D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\index.ts` —— `ClientContext = Context`
- `D:\project-code\llm\deepseek-harness\packages\client\ui-primitives\src\index.ts` —— primitives 公开导出清单
- `D:\project-code\llm\deepseek-harness\packages\goal\goal\src\index.ts` —— `TypertRemoteService` + `@Remote` 生产 RPC 范例
- `D:\project-code\llm\deepseek-harness\packages\typert\protocol\src\index.ts` / `types.ts` —— `TypertRemoteService` / `Remote` / `TypertClientRemote` / `RemoteResult`
- `D:\project-code\llm\deepseek-harness\packages\extensions\cordis-host-runner\src\index.ts` / `registry.ts` / `guard.ts` —— `harness.handle` + `@Remote('invoke')`
- `D:\project-code\llm\deepseek-harness\packages\extensions\cordis-client-runner\src\client\providers.ts` / `evaluator.ts` / `runtime.ts` —— `host.call` 闭包符号
- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\index.ts` / `WorkflowRunPanel.tsx` —— `conversation.chat.node` keyed 注册 + workspace 风格面板（后续 Task）
