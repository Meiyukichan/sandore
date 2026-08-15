## Exploration Result

> 参考对象：DSH 源码 `D:\project-code\llm\deepseek-harness`（仅供阅读，不改源码）。
> 探索目标：sandore 工作流引擎 DSH 插件 Client UI 入口所需的参考实现范式 —— `sidebar.footer.action` 按钮 + WorkflowPanel 占位 + `host.call('sandore.ping')` 往返 + Client 包 `package.json` 声明。

### 1. footer 按钮 + 展开面板 slot 注册范式

**主参考文件**：`packages/extensions/ui-cordis/src/client/index.ts`

DSH 的 `sidebar.footer.action` 是一个 **list 型 / root scope** 的 slot（可加性 additive），注册范式是 `ctx.slots.inject(slotName, factory)`，其中 factory 同步返回 `ctx.slots.register(options, Component)`：

```ts
// packages/extensions/ui-cordis/src/client/index.ts
export const inject = [
  'slots', 'locale', 'inputTriggers', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner',
]

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cordis: dictionaries')

  // footer 按钮 + 展开面板：register 一个 list slot entry（list 型必须给 id）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'cordis-panel',
    locale: NS,
    inject: (): CordisPanelFace => ({ /* 业务数据/回调（自包含状态不放这里） */ }),
  }, CordisPanel))
}
```

关键点（对 sandore `ui` 包直接可复制）：
- `ctx.slots.inject(slotName, () => ctx.slots.register({...}, Component))` 是标准注册壳。
- `register` options 对 **list slot 必须有 `id`**（`ui-slots` 的 `SlotCore.register` 里 list 型缺 `id` 会 throw：`list slot "..." requires options.id`）。sandore 的 `id: 'sandore-btn'` 即对应此字段。
- `locale: NS` 会触发 render 机制注入 `t` 标准 prop（见 §7）。
- `inject` 工厂返回「业务 face」，成员会原样传到组件 props（`hooks` 保留字除外，见 §8）。
- `inject` 数组声明插件依赖的 `ctx.*` 服务；此处至少需要 `'slots'` 和 `'locale'`。
- 需要 type-only 拉入 sidebar 的 SlotMap 声明（否则 `PropsRuntime<'sidebar.footer.action'>` 不解析）：
  `import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'`。

### 2. 面板开关的自包含 client 状态（CordisPanel 开关）

**主参考文件**：`packages/extensions/ui-cordis/src/client/CordisPanel.tsx`

面板「开/关」是**插件组件自己的 React 本地状态**，不跨 scope、不进 inject face：

```tsx
// CordisPanel.tsx（节选）
export function CordisPanel({ wide, useSessions, /*...inject face...*/, t }: CordisPanelProps) {
  const [open, setOpen] = useState(false)
  // ... 其他自包含状态：selected / pending / actionErrors 等 ...
  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && (
        <section className={css.panel} data-cordis-panel aria-label={t('panel.title')}>
          {/* header + body ... */}
        </section>
      )}
      <div className={css.footerButtons}>
        <button
          type="button"
          className={css.badge}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconCordisPluginOutline14 />
          {wide && (<> <span>{t('panel.trigger')}</span> ... </>)}
        </button>
      </div>
    </div>
  )
}
```

要点：
- 展开状态就是 `const [open, setOpen] = useState(false)`，按钮 `onClick={() => setOpen(v => !v)}` + `aria-expanded={open}`。
- `wide`（来自 owner props，见 §3）决定渲染宽/窄两态：窄 rail（56px）只渲染图标，宽态渲染 label。
- 组件 props 组成 `CordisPanelProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>`（见 §8 的四份 props 组合）。
- 面板主体 `section` 用 `css.panel` 样式 + `data-*` 测试锚点；面板外是一个 `footerButtons` 容器（按钮始终可见，面板条件渲染）。

### 3. `sidebar.footer.action` slot 的 owner props（wide 宽/窄 rail）与 slot 声明

**主参考文件**：`packages/client/ui-sidebar/src/client/contract/slots.ts`、`packages/client/ui-sidebar/src/client/SidebarRoot.tsx`、`packages/client/ui-sidebar/src/client/index.ts`

slot 声明（`declare module '@deepseek-ai/dsh-client-ui-slots'` 的 `SlotMap` 合并）：

```ts
// contract/slots.ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

/** Owner share of an action rendered beside Settings at the sidebar foot. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}
```

- owner props 只有一个字段 **`wide: boolean`**（`false` = 56px rail）。这是跨 shell/region 边界唯一传入的数据，业务数据/回调全部走 registrant 自己的 `inject`。
- 声明者（`ui-sidebar`）在注册 `sidebar` shell 时用 `children` 表声明这三个子 slot（「declaring is claiming」）：

```ts
// ui-sidebar/src/client/index.ts
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

shell 渲染处（footer action 在 Settings 上方）：

```tsx
// SidebarRoot.tsx（节选）
<div className={css.footArea}>
  <div className={css.footerActions}>
    {renderSlot('sidebar.footer.action', { wide })}
  </div>
  <div className={css.settingsArea}>
    {renderSlot('sidebar.settings', { wide })}
  </div>
</div>
```

- 结论：`sidebar.footer.action` 是「工作区下方、设置上方」的位置，纯插件可加性插入；owner 只传 `{ wide }`。

### 4. Client 包 `package.json` 约定

**主参考文件**：`packages/extensions/ui-cordis/package.json`、`packages/client/ui-workflow-run/package.json`

共同结构（sandore `ui` 包 `package.json` 需对齐的字段）：

```jsonc
{
  "name": "@deepseek-ai/dsh-client-ui-cordis",   // sandore: @deepseek-ai/dsh-client-ui-sandore
  "version": "0.1.0-rc.5",
  "publishConfig": { "access": "public" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-sidebar"
        // ... 该包 client 半依赖的平台插件
      ],
      "platform": "web"
    }
  },
  "files": ["lib/index.js", "lib/invariant.js", "lib/client.js", "lib/types/**/*.d.ts"],
  "peerDependencies": {
    "@deepseek-ai/dsh-client-ui-slots": "workspace:^",
    "@deepseek-ai/cordis": "workspace:^",
    "react": "^18.2.0"
    // ...
  }
}
```

关键约定：
- **`exports["./client"]`** 指向构建产物 `./lib/client.js`（类型 `./lib/types/client/index.d.ts`）——这是 Client 半的加载入口。
- **`dsh.client`**：`{ inject: [...平台插件包名...], platform: 'web' }` —— Loader 据此发现并加载浏览器半。`inject` 列的是该 client 半依赖的其它 `@deepseek-ai/dsh-client-*` 平台插件（ui-cordis 依赖 `dsh-client-runtime/connection/locale/ui-sidebar/...`；ui-workflow-run 依赖 `dsh-client-locale/runtime/ui-conversation`）。sandore `ui` 至少需 `dsh-client-locale` + `dsh-client-runtime` + `dsh-client-ui-sidebar`（后两者分别给 `ctx.slots`/标准 hook 与 sidebar SlotMap 声明）。
- DSH 内部用 `"workspace:^"` 作 peer/devDependencies；**sandore 改为 npm 版本 `0.1.0-rc.5`**（不指向本地源码，见 design.md §4.2/work.md 依赖来源约定）。
- `ui-primitives`（纯 React atoms，无 cordis）从根路径 `@deepseek-ai/dsh-client-ui-primitives` 导入（无 `/client` 子路径），见 §7。

### 5. Host 半空 apply

**主参考文件**：`packages/extensions/ui-cordis/src/index.ts`、`packages/client/ui-workflow-run/src/index.ts`

纯 UI 插件的 Node 半是一个**空 apply**，仅为了让插件出现在 host `cordis.yml` / Loader 里：

```ts
// ui-cordis/src/index.ts
/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
```

### 6. RPC 范式：`host.call`（动态原型）与 `@Remote`（生产）

**参考文件**：`packages/typert/protocol/src/index.ts`、`packages/extensions/cordis-client-runner/src/client/providers.ts`、`packages/extensions/cordis-host-runner/src/sandbox.ts`、`packages/extensions/cordis-host-runner/src/guard.ts`、`packages/api/remotes/src/client/index.ts`

DSH 有**两条 RPC 路径**，需区分：

**(A) 动态插件原型捷径 `host.call`（cordis_define / cordis_run，Task 1 原型验证用）**

Client 闭包符号签名（`cordis-client-runner/src/client/providers.ts`）：

```ts
host: { signatures: ['host.call(method: string, args?: JsonValue): Promise<JsonValue>'] }
```

Host 闭包符号签名（`cordis-host-runner/src/sandbox.ts`）：

```ts
harness: { signatures: [
  'harness.handle(method: string, handler: (args: JsonValue) => JsonValue | Promise<JsonValue>): () => void',
  // harness.defineTool / harness.registerTool ...
] }
```

- 方向 Client→Host，仅 JSON 可跨边界。`host.call(method)` 的 `method` 是**自由字符串**（由 Host 半 `harness.handle(method, fn)` 注册同名 handler 匹配，见 `guard.ts` `normalizeHandler`，方法名只要求非空字符串）。
- 因此 `host.call('sandore.ping')` 字面量即可作为方法名往返；Host 半需 `harness.handle('sandore.ping', async (args) => ({...}))`。
- **注意**：`harness.handle` 是动态插件的 sandbox 闭包能力（`harness.handle` 仅作原型验证捷径，work.md 明确「不进入 Task 1 产出」）。

**(B) 生产范式 `TypertRemoteService + @Remote`（Task 1 产出用）**

Host 侧（`packages/typert/protocol/src/index.ts`）：

```ts
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  readonly typertRemote: TypertGatewayBinding<this>
  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)  // namespace 默认 = serviceKey
  }
}
// @Remote 装饰器标记 public 实例方法为 direct Remote 端点
export function Remote(exportName: string): RemoteMethodDecorator
```

- sandore 的 `class SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')` + `@Remote('ping')`。
- 端点 = `<namespace>/<method>`，namespace 默认取 serviceKey `'sandore'`，故 wire 端点为 **`sandore/ping`**（`types.ts` 的 `TypertRemoteNamespace<Namespace>` 按 `` `${Namespace}/${Method}` `` 解析；`Remote` 导出名只允许 `[A-Za-z0-9_$.-]` 段字符）。设计文档里的 `sandore.ping` 是逻辑方法名，wire 上是 `/` 分隔（源码实证为 `/`）。
- 方法返回值经 gateway 包装为 `RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }`。

Client 侧（`packages/api/remotes/src/client/index.ts`）：生成的 remote 贡献通过 `ctx.remote.$mount(contribution)` 挂载，然后 `ctx.remote.<namespace>.<method>(args)` 调用（`ctx.remote` 类型 `TypertClientRemote`，由 `declare module '@deepseek-ai/cordis' { interface Context { remote: TypertClientRemote } }` 合并）。

### 7. ui-primitives / theme / locale / 标准 hook 的公开导入点

**ui-primitives**（`packages/client/ui-primitives/src/index.ts`，纯 React atoms，zero cordis，从根 `@deepseek-ai/dsh-client-ui-primitives` 导入）：

- 控件：`StateDot` / `DisclosureRow` / `Button` / `Pill` / `Input` / `Menu` / `HoverCard` / `Modal` / `Tooltip` / `Toast` / `OnboardingSurface` / `RiskConfirmation` / `ConnectionBanner`。
- 展示：`FishLogo` / `BrandWordmark` / `JsonTree` / `TerminalBlock` / `ReadBlock` / `DiffBlock` / `SearchBlock` / `WebBlock` / `CodeBlock` / `JsonBlock` / `MarkdownText` / `MessageText`。
- hook/工具：`useAnchoredMaxHeight` / `writeClipboard` / `extractMarkdownPlainText`。
- 图标：`export * from './icons/index.tsx'`（`IconCheckOutline16`、`IconPanelLeftOutline16` 等 `Icon*` 组件）。
- 全部样式只通过 `--dsw-*` 设计 token（无硬编码色值）。

**theme**（`packages/client/ui-theme/src/client/index.ts`）：
- 服务 `ctx.theme: ThemeRuntime`；`theme/change` 事件；`getTheme()` 快照；`--dsw-*` token（如 `--dsw-alias-bg-base`、`--dsw-alias-brand-primary`、`--dsw-specific-sidebar-fill`）。组件自绘时用 CSS 变量而非引入 theme 服务。

**locale**（`packages/client/locale/src/client/index.ts`）：
- `ctx.locale: LocaleRuntime`；插件内 `ctx.effect(() => ctx.locale.register(NS, { zh, en }), '...')` 注册命名空间字典（双语平衡，缺一即编译错）。
- 命名空间先合并进 `LocaleNamespaceMap`；register options 里 `locale: NS` 让 render 机制注入 `t` 座位。
- `NS` 通常取与包名对应的短串（ui-cordis 用 `NS`，ui-sidebar 用 `'sidebar'`）。

**标准 hook（runtime 合并的框架标准 props）**（`packages/client/runtime/src/client/index.ts`）：

```ts
interface SessionStandardProps { useSession; sessionId; useProjection }      // session scope
interface SessionMaybeStandardProps { useSession; sessionId; useProjection } // session-maybe
interface GlobalStandardProps { useSessions; useWorkspaces }                 // 每个 root slot 组件
```

- `sidebar.footer.action` 是 **root scope**，组件能拿到 `useSessions` / `useWorkspaces` 两个标准 hook（CordisPanel 即用 `useSessions(state => state.current)`）。
- 标准 hook 类型是 `SnapshotSelectorHook<T>`（`getSnapshot`/`subscribe` 的 uSES selector hook）。

### 8. ui-slots 公开类型（`@deepseek-ai/dsh-client-ui-slots`）

**主参考文件**：`packages/client/ui-slots/src/index.ts`、`packages/client/ui-slots/src/renderer.ts`

对外类型/约定：
- `SlotMap`：slot 契约表，owner 用 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { ... } }` 合并。
- `LocaleNamespaceMap`：命名空间字典 key 表（同上声明合并）。
- `SlotKind = 'single' | 'list' | 'keyed' | 'chain'`；`SlotScope = 'root' | 'session-maybe' | 'session'`。
- 四份 props 组合（`ComposedProps`）= `PropsRuntime<K, EntryKey>`（owner share + keyProps + slot 级 inject face + 标准 kit）& `PropsRenderSlots<S>`（`renderSlot`/`renderSlotChain`/`SessionProvider`）& `PropsStore<H>` & `InjectFace<I>` & `MatchedShare` & `PropsLocale<N>`。
  - 组件侧引用 `PropsRuntime<'sidebar.footer.action'> & InjectFace<MyFace> & PropsLocale<'sandore'>` 即得完整 props 类型（无需重写）。
- `InjectFace<I>`：inject face 的 `hooks` 保留字会被转成 `use<Name>` selector hook（`HostObservable` source → `SnapshotSelectorHook`），其余成员原样传递。
- `PropsLocale<N>`：`locale:` 声明注入的 `t`（`TranslateNS<N>`）。
- `HostObservable<T> = { getSnapshot(): T; subscribe(fn): () => void }`：inject face `hooks` 隔间的数据源形状（uSES 安全）。
- `register` 重载：list slot 必须 `id`；keyed 必须 `key`；chain 必须 `select`；`inject` 工厂参数按 scope/decl 派生（root scope 无参数）。

### 9. `conversation.chat.node` keyed 范式（仅作背景参考，Task 1 用 sidebar 入口）

**主参考文件**：`packages/client/ui-workflow-run/src/client/index.ts`、`src/client/workflow-definition.ts`

```ts
// ui-workflow-run/src/client/index.ts
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(workflowRunDefinition)   // ConversationNodeDefinition
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflow-run: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'workflow-run',
    locale: NS,
    inject: (): WorkflowRunInjected => ({ openSession: (id: SessionId) => { ctx.sessions.open(id) } }),
  }, WorkflowRunPanel))
}
```

- keyed slot 注册用 `key`（非 `id`）；消息折叠逻辑在 `ConversationNodeDefinition`（`match`/`start`/`update`/`buildViewNode`），并 `declare module '@deepseek-ai/dsh-client-ui-conversation/client' { interface ChatNodeDataMap { 'workflow-run': WorkflowRunChatData } }`。
- D8 讨论面板后续会仿此注册 `key: 'sandore-step'`；Task 1 只做 sidebar 入口，不涉及此 slot。

### 10. Client 包构建（tsdown `clientBundle`，背景）

**主参考文件**：`packages/client/tsdown.client.ts`、`packages/extensions/ui-cordis/tsdown.config.ts`

- `exports["./client"]` 的 `lib/client.js` 是 closure-factory 产物：banner `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`；external 走 loader 模块表（平台插件跨包协作必须走 cordis 服务，**禁止跨插件 value import**——`dsh-client-bundle-purity` gate 会编译报错，`import type` 被擦除不受限）。
- CSS Modules 由 lightningcss 内联编译（`x.module.css` → hashed class map + 自动注入 `<style data-plugin>`）。
- 该细节是 DSH 内部构建约定；sandore 各包用根 `tsdown` devDependency 自行对齐，仅作背景。
