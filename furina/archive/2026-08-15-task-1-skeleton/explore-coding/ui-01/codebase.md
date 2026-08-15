## Exploration Result

`furina config show project.sourcecode codebases` 返回的 codebases 列表为 `docs/codebase`（`project.sourcecode=src/`）。该目录在 sandore 仓库中为空（`docs/codebase` 下无任何文件），因此 Phase 3（furina-codebase 迭代探索）无结果。下述范式全部来自 Phase 4 的补充探索（DSH 参考源码 `D:\project-code\llm\deepseek-harness`，只读参考；以及 sandore 已安装的 npm 依赖 `D:\project-code\llm\sandore\node_modules\.pnpm\@deepseek-ai+*`）。

> 补充说明：sandore 仓库当前已非完全 greenfield——`packages/sandore/workflow`、`microflow`、`tool` 三个包已存在（`package.json` + `tsconfig.json`，peerDependencies 版本已从 design.md 的 `0.1.0-rc.5` 升为 **`0.1.0-rc.6`**，与 npm 实际解析版本一致）。本任务关注的 **`packages/sandore/ui`（Client UI 插件）尚不存在**，是本次探索的目标落点。

## Supplementary Exploration Result

> 探索目标：为 sandore 工作流引擎 DSH 插件 Client UI 入口（`sidebar.footer.action` 按钮 + 点击展开 WorkflowPanel 占位 + `host.call('sandore.ping')` RPC 往返 + Client 包 package.json 声明）所需的 DSH 参考实现范式。以下每一条均直接对应 work.md / design.md §6 中引用的 DSH 参考文件，给出实际代码位置与范式结论。

---

### 1. `sidebar.footer.action` slot 契约（谁声明、owner props 是什么）

**声明处（关键）**：`D:\project-code\llm\deepseek-harness\packages\client\ui-sidebar\src\client\contract\slots.ts`

- L16–37：通过 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { ... } }` 声明合并三个 sidebar 子 slot，其中本任务入口：

```ts
'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
```

- L59–63：`SidebarFooterActionOwnerProps` 只有一个字段 `{ wide: boolean }`（`wide` = 侧栏是否宽内容展开，false 为 56px rail）。**owner props 仅传递列宽，无任何业务状态**。
- 对比同文件另两个 slot：`sidebar.workspaces`（single/root，owner 多一个 `expandSidebar()`）、`sidebar.settings`（single/root，owner `{wide}`）。

**slot 的运行时声明（claiming = declaring）**：`D:\project-code\llm\deepseek-harness\packages\client\ui-sidebar\src\client\index.ts`

- L40–55：ui-sidebar 插件注册 `sidebar` slot 时，在 `children` 表里声明子 slot（`children` 即「声明并独占渲染权」）：

```ts
children: {
  'sidebar.workspaces': { kind: 'single', scope: 'root' },
  'sidebar.settings':  { kind: 'single', scope: 'root' },
  'sidebar.footer.action': { kind: 'list', scope: 'root' },
},
```

**渲染点（按钮实际出现在设置上方）**：`D:\project-code\llm\deepseek-harness\packages\client\ui-sidebar\src\client\SidebarRoot.tsx`

- L181–189：`footArea` 里 footer actions 在 settings **上方**渲染：

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

**结论**：`sidebar.footer.action` 是 **list / root scope** 的可加性 slot（additive，每个注册项一个 `id`），owner props 只有 `{ wide: boolean }`。纯插件通过 `ctx.slots.inject('sidebar.footer.action', ...)` 注册 `id: 'sandore-btn'` 即可新增按钮，且天然位于设置上方，无需改 ui-sidebar。插件必须在 `dsh.client.inject` 里依赖 `@deepseek-ai/dsh-client-ui-sidebar`（slot 的声明方），并 `import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'` 拉入 SlotMap 合并（否则 `PropsRuntime<'sidebar.footer.action'>` 的 owner 类型不解析）。

---

### 2. 注册范式：`ctx.slots.inject(...)` + `ctx.slots.register(...)`（footer 按钮 + 展开面板）

**权威参考文件**：`D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\index.ts`（design.md §6.1 明确指出的「参考 ui-cordis 的 footer 按钮 + 展开 CordisPanel」）

- L35–37：插件级 `export const inject = [...]`（本插件需要的 Client 服务键，含 `'slots'`, `'locale'`, `'sessions'` 等）。
- L40：`export function apply(ctx: ClientContext): void` —— Client 插件入口签名。
- L84–112：**`sidebar.footer.action` 按钮 + 面板的注册**（本任务直接仿照对象）：

```ts
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'cordis-panel',
  locale: NS,
  inject: (): CordisPanelFace => ({
    hooks: { inventory, activeRuns, loaded, ... },   // 面板业务数据源（HostObservable）
    onApprove: ..., onDecline: ..., onRun: ..., onStop: ..., onRemove: ..., onRefresh: ...,
  }),
}, CordisPanel))
```

**`ctx.slots.inject` / `ctx.slots.register` 的语义**（`D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\slots.ts`）：

- `SlotRegistry extends Service`，`super(ctx, 'slots')`（L105），因此 Client 里 `ctx.slots` 就是该服务；`inject`/`register` 都是原型方法。
- `inject(key, callback)`（L143–205）：等待 slot 被声明（用 `subscribeDeclaration` + `reconcile`），声明存在时立即同步执行 callback，否则等声明后再执行；返回的 effect 挂在调用方 fiber，插件卸载自动级联清理。**`register` 必须放在 `inject` 回调里**（否则 slot 未声明时 register 会抛 `slot "x" is not declared`）。
- `register(options, component)`（L464–471 原型赋值 + L356–383 `_register`）：`options` 携带 `name` / `id`（list 必填）/ `locale`（声明字典命名空间，注入 `t`）/ `inject`（业务 face 工厂）/ `children` / `store` / `priority` 等；`component` 是纯函数组件（`SlotComponent<P> = (props: P) => ReactNode`，见 `ui-slots/src/index.ts` L370）。

**纯核心 SlotCore 的 register 约束**（`D:\project-code\llm\deepseek-harness\packages\client\ui-slots\src\index.ts` L787–896）：

- list slot 必须给 `id`（L813–819：`list slot requires options.id`）；同一 cell（同 `id`）同 `priority` 二次注册会抛错。
- `inject` 工厂参数表 `InjectParams`（L460–467）：root scope、无 store 时参数表为 `[]`（即 `inject: () => ({...})`，如 design.md §6.1 所写 `inject: () => ({ 面板开关状态 })`）。

**组件 props 组合类型**（`ui-slots/src/index.ts`）：

- `ComposedProps`（L442–450）= `PropsRuntime<K>`（owner + scope 标准件 + slot 级 inject face）+ `PropsRenderSlots<S>` + `PropsStore` + `InjectFace<I>`（`hooks` 区自动合成 `use<Name>` 选择器 hook）+ `PropsLocale<N>`（`t`）。
- 常用类型导出：`InjectFace`、`PropsRuntime`、`PropsLocale`、`PropsRenderSlots`、`HostObservable`、`SlotComponent`（组件直接用这些类型组合，如 CordisPanel 里 `PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>`，见 CordisPanel.tsx L23–24）。

---

### 3. 面板开关 client 状态（「自包含 client 状态」的权威范式）

**权威参考文件**：`D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\CordisPanel.tsx`

关键点（design.md §6.1「面板开关是插件自有 client 状态」的直接证据）：

- **按钮与面板是同一个组件**：`CordisPanel` 同时渲染 footer 按钮（`footerButtons` div）和展开面板（`{open && <section className={css.panel}>...}`），二者共享同一份 `open` 状态，无需跨组件、跨 slot、跨 scope 的联动。
- L117：`const [open, setOpen] = useState(false)` —— 面板开关就是组件内的普通 React `useState`，无全局 store、无 session 状态。
- L423–449：`{open && (<section className={css.panel}>...header/body...</section>)}` —— open 时才渲染面板主体。
- L450–468：footer 按钮（`badge`）的 `onClick={() => { setOpen(value => !value) }}`，并带 `aria-expanded={open}`；`wide`（owner props 传下的列宽）决定 rail 态只显图标、宽态显 label + count。
- 面板状态「自包含」的另一佐证：`inject` 工厂注入的 `CordisPanelFace` 只含 `hooks`（业务数据源）+ 回调动词（`onApprove/onStop/...`），**不含任何 `open`/`setOpen` 状态**——开关完全留在组件内。

**对应 sandore（Task 1 最小 UI）**：`WorkflowButton`/`WorkflowPanel` 可合并为单组件（仿 CordisPanel），或按钮渲染组件内部 `useState(false)` + 按钮 `onClick` 翻转 + 面板 `{open && ...}`。Task 1 占位无需 `hooks` 数据源，`inject: () => ({})` 即可（owner props `{ wide }` 与 `PropsRuntime<'sidebar.footer.action'>` 自动到达）。

---

### 4. Client 包 package.json 声明范式（`dsh.client` + `exports["./client"]`）

**权威参考文件**：
- `D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\package.json`（footer 按钮插件，最贴近）
- `D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\package.json`（conversation 节点插件，D8 参考）
- `D:\project-code\llm\deepseek-harness\packages\client\runtime\package.json`（含 `immediately: true` 变体）

共同结构（ui-cordis）：

```jsonc
{
  "name": "@deepseek-ai/dsh-client-ui-cordis",
  "version": "0.1.0-rc.5",
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
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-primitives",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "platform": "web"
    }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "workspace:^", "react": "^18.2.0", /* 各 dsh-client-* */ }
}
```

**关键结论**：

- **`dsh.client`** 是 Client 插件声明块，字段：`platform: 'web'`（必填）+ `inject: [...]`（本插件 Client 半部所依赖的 **Client 插件包名**数组，不是服务键）+ 可选 `immediately: true`（boot 即加载，见 runtime 包 L40）。
- `inject` 数组里列什么，取决于插件用到什么能力：注册 `sidebar.footer.action` 必须依赖 **`@deepseek-ai/dsh-client-ui-sidebar`**（slot 声明方）；用 `ctx.slots` 依赖 `@deepseek-ai/dsh-client-ui-slots` 的运行时合并（实际上 `slots` 服务由 `@deepseek-ai/dsh-client-runtime` 提供）；用 `ctx.locale` 依赖 `@deepseek-ai/dsh-client-locale`；用 ui-primitives 组件依赖 `@deepseek-ai/dsh-client-ui-primitives`；做 RPC 依赖 `@deepseek-ai/dsh-client-connection`（/ `@deepseek-ai/dsh-api-remotes`）。
- **`exports["./client"]`** 指向构建产物 `lib/client.js`（由 `tsdown` bundle，`scripts.bundle = "tsdown"`），Client 半源码在 `src/client/`。
- **Host 半与 Client 半并存**：纯 UI 插件的 node 半是空 `apply`（`ui-cordis/src/index.ts` L9 `export function apply(): void {}`），只为了让插件出现在 host cordis.yml / Loader；浏览器半经 `exports["./client"]` 被 `dsh.client` 发现。这与 design.md §3.2「一个包可同时提供 Host 半（`src/`）和 Client 半（`src/client/`）」一致。
- **peerDependencies** 用 `workspace:^`（DSH 仓库内）；sandore 作为外部插件按 design.md §4.2 改成 npm 版本（当前 **`0.1.0-rc.6`**，见 sandore 现有 `workflow/package.json`，npm 实际解析版本亦为 `0.1.0-rc.6`）。

---

### 5. `host.call` RPC 范式（两条路径）

**（A）生产范式：`TypertRemoteService` + `@Remote`（Host 暴露，Client 经 `ctx.remote.<namespace>.<method>()` 调用）**

- **装饰器与基类定义**：`D:\project-code\llm\deepseek-harness\packages\typert\protocol\src\index.ts`
  - L147–161：`export abstract class TypertRemoteService<out T> extends Service`，`protected constructor(ctx, serviceKey, options?)` 内 `super(ctx, serviceKey)` + `bindTypertRemote(this, this.name, options)`；`namespace` 默认 = serviceKey。
  - L168–196：`Remote` 方法装饰器（`@Remote` 或 `@Remote('exportName')`），把 public 实例方法标记为 direct Remote 调用；`RemoteScope(key, exportName?)` 用于绑定 Typert Context 作用域。
- **权威用例**：`D:\project-code\llm\deepseek-harness\packages\interaction\commands\src\index.ts`
  - L225–238：`export class CommandRuntime extends TypertRemoteService { constructor(ctx) { super(ctx, 'commands') } }`。
  - L259–265 / L296–301：`@Remote list(agent) {...}`、`@Remote async execute(agent, line, signal) {...}` → 端点分别为 `commands/list`、`commands/execute`。
- **Client 侧消费**：`D:\project-code\llm\deepseek-harness\packages\api\gateway\src\client\index.ts`
  - L58–63：`declare module '@deepseek-ai/cordis' { interface Context { remote: ClientRemote } }` —— Client 端通过 `ctx.remote` 访问。
  - L504–518：`remoteServiceKey(namespace)` = `remote.<namespace>`、`endpointOf(descriptor)` = `` `${namespace}/${method}` ``；`installDirect` 给 namespace 服务实例挂 getter，调用即 `connection.rpc.call('/api', endpoint, { args }, signal)`（L406）。
  - 端点字符集约束：`dsh-typert-protocol` L10 `TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`（namespace/method 均可含 `$ . -`），transport 层 `dsh-client-connection/src/client/rpc.ts` L13 `ENDPOINT_SEGMENT_PATTERN` 同集。
- **对应 sandore**：work.md「`class SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')` + `@Remote('ping')`」即产生 namespace=`sandore`、method=`ping`；wire 端点为 `sandore/ping`（namespace/method 以 `/` 拼接），design/work 文档里的 `sandore.ping` 是逻辑命名（点号），二者同源。Client 侧调用为 `ctx.remote.sandore.ping()`。

**（B）动态原型捷径：`harness.handle`（Host）+ `host.call`（Client），不进 Task 1 产出**

- **权威文档**：`D:\project-code\llm\deepseek-harness\apps\cli\config\agent-presets\cordis\skills\cordis-plugin-development\SKILL.md` L321–348「Call Host from Client」：
  - Host：`harness.handle('read-state', async (args) => ({ value: args.key }))`
  - Client：`const result = await host.call('read-state', { key: 'demo' })`
  - 约束：参数/返回值必须是 lossless JSON；不用 public Remote Service / `ctx.remote` 做 Package 私有通信。
- **机制说明**：`.agents/notes/proposed/architecture/2026-08-08-cordis-web-dynamic-packages.md` L140/228：`harness.handle`/`host.call` 是动态 Package 的私有 Client→Host JSON 通道，每次调用绑定 `pluginId + pluginRunId`，Host 拒绝过期 Run。生产应通过 public Remote Service / `ctx.remote`。
- 该 SKILL.md 同时给出动态插件 `apply(ctx)` 里注册 slot 的通用范式（L242–253）：`const slots = ctx.get('slots'); slots.inject('target.slot', () => slots.register({name, id}, (props) => React.createElement(...)))`，以及 L308 明确「small sidebar actions 用 `sidebar.footer.action`，不要替换整个 sidebar」。

**结论**：Task 1 生产产出走 (A) `TypertRemoteService + @Remote`（`remote.ts` 里 `SandoreRemote`）；`harness.handle`/`host.call` 仅用于 `cordis_define`/`cordis_run` 动态原型验证（work.md §7.2 已写明「不进入 Task 1 产出」）。

---

### 6. ui-primitives 公开扩展点（Task 1 UI 可直接复用）

**权威参考文件**：`D:\project-code\llm\deepseek-harness\packages\client\ui-primitives\src\index.ts`

- 包注释：`Cordis-free React primitives styled only through \`--dsw-*\` tokens`（零 Cordis 依赖、仅靠 `--dsw-*` 主题 token）。
- **公开组件**（`export`）：`Button`（含 `ButtonVariant`）、`Tooltip`（含 `TooltipSide`）、`Modal`、`Pill`、`Input`、`Menu`（`MenuEntry/MenuItem/MenuSeparator/MenuLabel`）、`StateDot`（`StateDotState`）、`DisclosureRow`、`HoverCard`、`OnboardingSurface`、`RiskConfirmation`、`ConnectionBanner`、`Toast`、`JsonTree`、`TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`、`CodeBlock`、`JsonBlock`、`MarkdownText`、`MessageText`、`extractMarkdownPlainText`、`writeClipboard`、`useAnchoredMaxHeight`、`FishLogo`、`BrandWordmark`。
- **图标集**：`export * from './icons/index.tsx'` —— 命名 `Icon<名><Outline/Fill><尺寸>`（如 `IconNewChatOutline16`、`IconSettingsOutline14/16`、`IconPanelLeftOutline16`、`IconCheckOutline16/14`、`IconCloseOutline16`、`IconPlusOutline16`、`IconBranchOutline16`、`IconChevronDownOutline14`、`IconCordisPluginOutline14`、`IconPlayOutline16`、`IconStopFill16`、`IconTrashOutline16` 等，尺寸后缀 14/16/24 等）。图标统一 props 为 `IconProps { size?, className? }`（`icons/props.ts`）。
- **CordisPanel 里的实际用法**（CordisPanel.tsx L5–8）：从 `@deepseek-ai/dsh-client-ui-primitives` 引入 `Tooltip` + 各 `Icon*` + 若干块组件——即「UI 能复用就复用 ui-primitives」的范本。

**对应 sandore（Task 1 占位）**：WorkflowPanel 的「编排 toggle + 新增按钮 + 三态列表」占位可复用 `Button`/`Pill`/`StateDot`/`Tooltip`/`Icon*`，样式走 `--dsw-*` token（D7「复用 DSH 组件与设计语言」）。

---

### 7. Client 插件 `apply`/`inject` 签名与 `ClientContext`

**权威参考文件**：`D:\project-code\llm\deepseek-harness\packages\client\runtime\src\client\index.ts`

- L112：`export type ClientContext = Context` —— Client 侧 `apply(ctx: ClientContext)` 里的 `ctx` 就是 Cordis `Context`（经各 client 包声明合并后带上 `slots`/`locale`/`sessions`/`remote` 等）。
- L124–151：`declare module '@deepseek-ai/dsh-client-ui-slots'` 合并 session/global 标准件真实成员：`SessionStandardProps { useSession, sessionId, useProjection }`、`SessionMaybeStandardProps`、`GlobalStandardProps { useSessions, useWorkspaces }`——即 session 作用域 slot 组件的标准 hooks 来源。
- L153–168：`declare module '@deepseek-ai/cordis'` 里 `Events` 合并 `slots/changed(key)` 与 `connection/reset()`。
- 典型 Client 插件 `inject` 数组示例：ui-cordis `['slots', 'locale', 'inputTriggers', 'remote', 'remote.dynamicCordisRunner', 'dynamicCordisRunner']`；ui-workflow-run `['conversationEvents', 'slots', 'sessions', 'locale']`；ui-sidebar `['slots', 'layout', 'sessions', 'workspaces', 'locale']`。sandore UI 最小只需 `['slots', 'locale', 'sessions']`（design.md §6.1）。

---

### 8. D8 参考：`conversation.chat.node` keyed slot（背景，Task 1 非主入口）

**权威参考文件**：`D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\index.ts`

- L21–32：`ctx.conversationEvents.register(workflowRunDefinition)`（注册 ConversationNodeDefinition）+ `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'workflow-run', locale: NS, inject: () => ({ openSession: id => ctx.sessions.open(id) }) }, WorkflowRunPanel))`。
- 这就是 design.md §3.4/§5.2 提到的 `conversation.chat.node`（keyed, session scope）注册范式：`key: 'workflow-run'` → sandore 后续 `key: 'sandore-step'`（Task 1 不做，仅约定）。
- 注意该包 `dsh.client.inject` = `['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation']`（conversation 节点需依赖 `@deepseek-ai/dsh-client-ui-conversation` 的 slot 声明）。

---

### 9. 依赖版本现状（sandore 侧已核实）

- sandore 已安装 npm 依赖实际版本：`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-session@0.1.0-rc.6`、`@deepseek-ai/dsh-llm@0.1.0-rc.6`、`@deepseek-ai/dsh-agent@0.1.0-rc.6`、`@deepseek-ai/dsh-storage@0.1.0-rc.6`、`@deepseek-ai/dsh-typert-protocol@0.1.0-rc.6`、`@deepseek-ai/schemastery@3.18.1`。
- sandore 现有 `packages/sandore/workflow/package.json` 已按 `0.1.0-rc.6` 声明 peerDependencies，并额外含 `@deepseek-ai/schemastery@3.18.1`。
- 结论：sandore 全部 peerDependencies 应以 **`0.1.0-rc.6`**（而非 design.md 起草时的 `0.1.0-rc.5`）为准；Client UI 包（`@deepseek-ai/dsh-client-ui-sidebar` / `-slots` / `-primitives` / `-runtime` / `-locale` / `-connection`）尚未进入 sandore node_modules，需同样以 npm public scope `0.1.0-rc.6` 声明为 peerDependencies（design.md §4.2「从 npm 解析，不用 file:/link:」）。
