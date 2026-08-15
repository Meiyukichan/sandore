# Furina Explore — specification 探索结果

## Explore Content（需求理解）

### What
为 sandore DAG 工作流引擎（v2.6）落地为 DeepSeek Harness (DSH) 插件的第一步「骨架」（Task 1）：在 sandore 根 monorepo 工作区（当前 greenfield）新建 4 个包，其中 `packages/sandore/workflow` 承载 capability seam（抽象类 `SandoreEngine extends Service` + 11 个实例级方法 + 13 个 `sandore/*` 事件双声明 + 13 个基础类型 + 空 Provider 桩 + `TypertRemoteService`/`@Remote` 最小 RPC），`microflow`/`tool` 为空占位，`ui` 为 Client 插件（`sidebar.footer.action` 按钮 + WorkflowPanel + `host.call('sandore.ping')` 往返）。本探索只做研究理解，不写任何实现代码。

### Boundaries
范围锁定在「DSH 参考实现范式」——即从 DSH 源码（`D:\project-code\llm\deepseek-harness`）中找出 sandore Task 1 编码所需的 6 类范式：
1. Service Definition 范式（抽象 seam 类 + `declare module` Context/Events 合并）
2. Session 事件范式（`session.append` + `SessionEventMap` 双声明）
3. RPC 范式（`TypertRemoteService` + `@Remote` 生产范式）
4. schemastery Config 范式（`static Config`）
5. package.json + tsconfig 约定（monorepo 工作区、包声明、`dsh.client`、tsdown）
6. 相关背景：`ctx.storageDomain.open(spec)` 范式（Task 1 仅声明 inject，不实现）

### Goal
为 `docs/design/task-1-skeleton/work.md` 与 `design.md` 及 `furina/changes/task-1-skeleton/specs/*` 中的 4 个 spec（engine-seam / engine-rpc / monorepo-workspace / ui-entry）提供准确、可落地的 DSH 参考范式依据（含精确文件路径与代码形状），确保编码时签名、声明合并、端点命名、包声明等与 DSH 先例对齐。

---

## 关键结论速览

| 范式 | DSH 参考源（绝对路径） | sandore 落点（Task 1） |
|---|---|---|
| Service Definition | `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts` | `packages/sandore/workflow/src/index.ts` |
| Session 事件（append + SessionEventMap 合并） | `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\types.ts` / `src\index.ts` | `declare module '@deepseek-ai/dsh-session/types'` 合并 13 个 `sandore/*` |
| RPC（TypertRemoteService + @Remote） | `D:\project-code\llm\deepseek-harness\packages\typert\protocol\src\index.ts`（定义）、`packages\feedback\message-feedback\src\index.ts`、`packages\goal\goal\src\index.ts`（用法） | `packages/sandore/workflow/src/remote.ts` |
| schemastery Config | `packages\goal\goal\src\index.ts`、`packages\feedback\message-feedback\src\index.ts` | Provider 桩 `static Config` |
| package.json / tsconfig | `packages\workflow\workflow\package.json`、`packages\extensions\ui-cordis\package.json`、`tsconfig.base.json` | 根工作区 + 4 包 |
| UI 入口（sidebar.footer.action + panel） | `packages\extensions\ui-cordis\src\client\index.ts`、`CordisPanel.tsx`、`packages\client\ui-sidebar\src\client\contract\slots.ts` | `packages/sandore/ui/` |
| conversation.chat.node keyed（D8 背景） | `packages\client\ui-workflow-run\src\client\index.ts` | 后续 Task |
| storageDomain.open(spec)（背景） | `packages\feedback\message-feedback\src\index.ts` + `src\spec.ts`、`packages\storage\storage-domain\src\index.ts` | Task 1 仅 inject 声明 |

---

## 1. Service Definition 范式

### 1.1 参考源
`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`

### 1.2 范式要点

**seam 抽象类**（对应 sandore `SandoreEngine extends Service`）：

```ts
import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowEngine: WorkflowEngine   // sandore: sandoreEngine: SandoreEngine
  }
  interface Events {
    'workflow/start'(info: WorkflowRunInfo): void   // sandore: 'sandore/*'
    // ...每个事件首参为 identity snapshot（info: WorkflowRunInfo）
  }
}

export abstract class WorkflowEngine extends Service {
  constructor(ctx: Context) { super(ctx, 'workflowEngine') }  // sandore: super(ctx, 'sandoreEngine')
  abstract start(request: WorkflowStartRequest): WorkflowRun
  // ...
}
export default WorkflowEngine
```

关键约定：
- 抽象类 `extends Service`，构造函数 `super(ctx, '<serviceKey>')`（sandore 为 `'sandoreEngine'`）。
- `declare module '@deepseek-ai/cordis'` 里同时合并 `interface Context`（`sandoreEngine: SandoreEngine`）与 `interface Events`（13 个 `sandore/*`）。
- Cordis `Events` 声明中，首参固定为 `info: DagRunInfo`（identity snapshot），每个事件有 `@mode emit` JSDoc。
- 类型来源用 `import type { ... } from './types.ts'` / `./runtime-types.ts`，并在文件头 `export type {...}` 再导出。
- 引擎内部用 `this.ctx.events.dispatch('emit', [name, ...args])` 触发 Cordis 事件（可参考 `emitWorkflowEvent` helper，含 listener 错误隔离）。

### 1.3 `Service` 基类（`@deepseek-ai/cordis`）
参考 `D:\project-code\llm\deepseek-harness\vendor\cordis\src\service.ts`：
- `abstract class Service<out T = never>`，构造函数 `constructor(protected ctx: Context, name: string)`，内部 `ctx.reflect.provide(name, this, ...)` 注册。
- `static readonly init: unique symbol` —— 构造后执行的实例方法，惯用写法 `protected async [Service.init](): Promise<void>`（message-feedback 用它打开 storageDomain）。
- `static Config`（schemastery schema）由 Loader 校验后注入构造函数；`static inject` 声明所需 service key。
- `this.ctx` 可用，`this.name` 记录 service key。

---

## 2. Session 事件范式（必需，Task 1 13 个事件）

### 2.1 参考源
- `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\types.ts`（`SessionEventMap` 声明合并）
- `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\index.ts`（`session.append` 用法）
- `D:\project-code\llm\deepseek-harness\packages\goal\goal\src\index.ts`（`agent.session.append('goal/change', change)`）

### 2.2 `SessionEventMap` 声明合并

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'tool-workflow/run-start': ToolWorkflowRunStartData
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    // ...
  }
}
```
- 模块路径固定为 `'@deepseek-ai/dsh-session/types'`（不是 `@deepseek-ai/dsh-session`）。
- 事件数据类型为纯数据载荷（无 `DagRunInfo` 首参包装）；sandore 的 13 个 `sandore/*` 按 design.md §5.2 声明（如 `'sandore/step-completed': { stepId; childId; output: ContentBlock[] }`）。

### 2.3 `session.append` 用法

```ts
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'

// 窄化 append 签名后调用：
const append = session.append.bind(session) as <E extends keyof ToolWorkflowRecordEventMap>(
  event: E, value: SessionEventMap[E],
) => void
append('tool-workflow/run-start', { runId, name })
```
- 运行时形态：`session.append(event, data)`，`event` 为 `SessionEventMap` 的 key，`data` 为其载荷。
- 也可 `agent.session.append('goal/change', change)`。
- `SessionEventMap` / `Session` / `JsonValue` 均从 `@deepseek-ai/dsh-session` 引入（type-only 即可）。

---

## 3. RPC 范式（TypertRemoteService + @Remote，生产范式）

### 3.1 定义源
`D:\project-code\llm\deepseek-harness\packages\typert\protocol\src\index.ts`

- 包名：`@deepseek-ai/dsh-typert-protocol`（版本 `0.1.0-rc.5`）。
- `export abstract class TypertRemoteService<out T = never> extends Service<T>`：
  - `protected constructor(ctx: Context, serviceKey: string, options = {})` → `super(ctx, serviceKey)` + `bindTypertRemote(this, this.name, options)`（`namespace` 默认等于 serviceKey）。
- `export function Remote(exportName: string): RemoteMethodDecorator`（也可作无参方法装饰器 `@Remote`）——标记 public instance method；`exportName` 为端点 method 名。
- 端点命名：`endpointOf(namespace, method) = `${namespace}/${method}``（见 `packages\api\gateway\src\index.ts` 第 491 行）。因此 `super(ctx, 'sandore')` + `@Remote('ping')` → 线端点 `sandore/ping`（design 写作逻辑名 `sandore.ping`）。

### 3.2 用法参考（两个真实例）
`D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts` 与 `packages\goal\goal\src\index.ts`：

```ts
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']
  static Config: s<Config> = s.object({ maxNoteBytes: s.number().step(1).min(1).required() })
  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')   // sandore: super(ctx, 'sandore')
    // ...
  }
  @Remote('list')
  async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> { /* ... */ }
  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> { /* ... */ }
}
export default MessageFeedbackService
```

要点：
- `@Remote('ping')` 装饰的方法返回可 JSON 序列化数据（sandore 返回桩数据 JSON）。
- `Remote` 与 `TypertRemoteService` 是**值导入**（装饰器运行时生效），非 type-only。
- Host 网关（`packages\api\gateway\src\index.ts`）通过 `Reflect.get(original, 'typertRemote')` 与 `remoteMethods(original)` 自动发现并分发 `/api` RPC；client 侧调用 `connection.rpc.call('/api', endpoint, { args }, signal)`。
- **`host.call` 与 `harness.handle` 属动态 Cordis 原型验证机制**（`packages\extensions\cordis-client-runner\src\client\providers.ts` 第 58 行签名 `host.call(method: string, args?: JsonValue): Promise<JsonValue>`，路由到 host half 的 `harness.handle`）——按 spec `engine-rpc`，Task 1 产出**不含** `harness.handle`，生产用 `TypertRemoteService + @Remote`。

---

## 4. schemastery Config 范式

### 4.1 参考源
- `D:\project-code\llm\deepseek-harness\packages\goal\goal\src\index.ts`
- `D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts`
- `D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\index.ts`

### 4.2 范式

```ts
import z from '@deepseek-ai/schemastery'   // 或 import s from '@deepseek-ai/schemastery'

export interface Config { defaultMaxGoalRounds?: number }
export const Config: z<Config> = z.object({
  defaultMaxGoalRounds: z.number().default(256),
})
```

- 包名 `@deepseek-ai/schemastery`（DSH vendored 版本 `3.18.1`；在 DSH 内是 `dependency` 而非 peer，见 tool-workflow package.json）。
- `static Config: z<Config>` 为 schemastery object；Loader 校验后把解析后的 config 作为构造函数第二参注入（`constructor(ctx: Context, config: Config)`）。
- 常见成员：`z.number().default(...)`、`z.number().step(1).min(1).required()`、`z.string().default(...)`、`z.dict(z.string()).default({})`。
- sandore Provider 桩 `static Config` 含 `defaultTimeoutMs` / `maxConcurrentSteps`，**不含** `permissionMode`。

---

## 5. package.json + tsconfig 约定

### 5.1 Host-only 包（workflow 参考）
`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\package.json`：
- `"type": "module"`、`"main": "lib/index.js"`、`"types": "lib/types/index.d.ts"`。
- `exports`：`"."`、`"./invariant"`、`"./types"`、`"./src/*"`、`"./package.json"`（sandore 包按需，`ui` 额外加 `"./client"`）。
- `files`：`lib/index.js` + `lib/types/**/*.js|d.ts`。
- `peerDependencies` + 同名 `devDependencies`（DSH 内用 `workspace:^`；sandore 用 `0.1.0-rc.5` 并从 npm 解析，**禁止** `file:`/`link:` 指向本地 DSH）。

sandore `workflow` 包 peerDependencies（design.md §4.2 权威清单）：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-storage`，版本均 `0.1.0-rc.5`。

### 5.2 包名确认（对应 peer 清单）
| peer | 实际 npm 包名 | 提供内容 |
|---|---|---|
| cordis | `@deepseek-ai/cordis` | `Context`/`Service`/`Events` |
| dsh-session | `@deepseek-ai/dsh-session` | `Session`/`SessionEventMap`；`@deepseek-ai/dsh-session/types` 供声明合并 |
| dsh-llm | `@deepseek-ai/dsh-llm` | `ContentBlock` |
| dsh-typert-protocol | `@deepseek-ai/dsh-typert-protocol` | `TypertRemoteService`/`Remote` |
| dsh-agent | `@deepseek-ai/dsh-agent` | `Agent`（后续 Task） |
| dsh-storage | `@deepseek-ai/dsh-storage` | 存储 hub；`ctx.storageDomain` 实际由 `@deepseek-ai/dsh-storage-domain` 提供（DomainFacility） |

### 5.3 Client 包（ui 参考）
`D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\package.json`：
- 包名 `@deepseek-ai/dsh-client-ui-cordis`（sandore 对应 `@deepseek-ai/dsh-client-ui-sandore`，`-client-` 中缀）。
- `exports` 含 `"./client"`（`types` → `lib/types/client/index.d.ts`，`default` → `lib/client.js`）。
- `"dsh": { "client": { "inject": [ "@deepseek-ai/dsh-client-*", ... ], "platform": "web" } }`（design/spec 写作 `dsh.client`）。
- peerDependencies 含 `react: "^18.2.0"`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-sidebar`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-connection` 等；devDependencies 加 `@types/react`。
- Host 半：`src/index.ts` 可仅 `export function apply(): void {}`（纯 UI 插件，空 host 半），Client 半在 `src/client/`。
- scripts：`"bundle": "tsdown"`。

### 5.4 tsconfig 约定
`D:\project-code\llm\deepseek-harness\tsconfig.base.json`（关键 compilerOptions）：
- `target: es2024`、`module: esnext`、`moduleResolution: bundler`、`declaration: true`、`composite: true`、`incremental: true`、`strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`、`noImplicitOverride: true`、`verbatimModuleSyntax: false`、`allowImportingTsExtensions: true`、`rewriteRelativeImportExtensions: true`、`skipLibCheck: true`、`esModuleInterop: true`、`types: ["node"]`。
- 各包 tsconfig（如 `packages\workflow\workflow\tsconfig.json`）：`extends` 根 base，`compilerOptions: { rootDir: "src", outDir: "lib/types" }`，`include: ["src"]`；DSH 内还有 `references` 指项目引用（sandore 依赖从 npm 解析，通常无需 references）。
- 构建：`tsdown`（根 `tsdown.config.ts`），`format: ['esm']`、`platform: 'node'`、`dts: false`；client 面由 `DSH_BUILD_FACE=client` 分支产出 browser bundle。
- sandore 根 `tsconfig.base.json` 由各包 extends（spec `monorepo-workspace`：每个包 tsconfig `extends` 根 `tsconfig.base.json`）。

### 5.5 根 monorepo 工作区
- DSH 根 `pnpm-workspace.yaml` 用 `packages: [...]` 列表（含 `vendor/*`、`packages/*/*` 等）+ `linkWorkspacePackages`/`overrides`/`allowBuilds` 等（DSH 内部专用）。
- sandore 根按 design.md §4.2：`package.json`（`name: "sandore"`、`private: true`、`packageManager: "pnpm@11.7.0"`、`engines.node >= 22`、`type: "module"`、scripts `typecheck`/`build`、devDeps `typescript`/`tsdown`/`tsx`）+ `pnpm-workspace.yaml`（`packages: ['packages/sandore/*']`）+ `tsconfig.base.json`（+ 可选 `.npmrc`）。

---

## 6. UI 入口（sidebar.footer.action + WorkflowPanel）——ui-entry 参考

### 6.1 Slot 契约
`D:\project-code\llm\deepseek-harness\packages\client\ui-sidebar\src\client\contract\slots.ts`：
```ts
'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
export interface SidebarFooterActionOwnerProps { wide: boolean }  // false = 56px rail
```
- `wide` 是 shell 传入的唯一 owner prop（宽栏/窄栏 rail 适配）。

### 6.2 注册范式
`D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\index.ts`（第 84-112 行）：
```ts
export const inject = ['slots', 'locale', 'inputTriggers', 'remote', ...]
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'cordis-panel',        // sandore: id: 'sandore-btn'（list 槽用 id，keyed 槽才用 key）
    locale: NS,
    inject: (): CordisPanelFace => ({ /* 面板业务 face */ }),
  }, CordisPanel))
}
```

### 6.3 面板组件范式
`D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\src\client\CordisPanel.tsx`：
- 组件 props 组合类型：`PropsRuntime<'sidebar.footer.action'> & InjectFace<CordisPanelFace> & PropsLocale<'cordis'>`。
- `wide` 从 `PropsRuntime`（owner share）解构；`<div className={wide ? css.layer : `${css.layer} ${css.rail}`}>`。
- 面板开关用组件自有 `useState(false)`（`open`）实现「自包含 client 状态」，点击 footer 按钮 toggle（`setOpen(v => !v)`，`aria-expanded={open}`）。
- 复用 `@deepseek-ai/dsh-client-ui-primitives`（`Tooltip`/`Icon*`）、`useSessions` 等 DSH 标准 hook。

### 6.4 conversation.chat.node keyed（D8 背景，后续 Task）
`D:\project-code\llm\deepseek-harness\packages\client\ui-workflow-run\src\client\index.ts`：
```ts
export const inject = ['conversationEvents', 'slots', 'sessions', 'locale']
ctx.conversationEvents.register(workflowRunDefinition)
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node', key: 'workflow-run', locale: NS,
  inject: (): WorkflowRunInjected => ({ openSession: (id) => { ctx.sessions.open(id) } }),
}, WorkflowRunPanel))
```
- keyed 槽注册用 `key`（sandore 对应 `key: 'sandore-step'`，后续 Task）。

---

## 7. storageDomain.open(spec) 范式（背景，Task 1 仅 inject 声明）

### 7.1 参考源
- `D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts`（第 173-181 行）
- `D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\spec.ts`
- `D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\index.ts`

### 7.2 范式
```ts
// src/spec.ts —— 用 zod 定义域表 schema
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
export const messageFeedbackDomainSpec = defineDomain({
  name: 'message_feedback', version: 0,
  tables: { sessions: domainTable<SessionId, MessageFeedbackRow>(messageFeedbackRowSchema) },
})

// src/index.ts —— 在 [Service.init] 打开
protected async [Service.init](): Promise<void> {
  const domain = await this.ctx.storageDomain.open(messageFeedbackDomainSpec)
  this.ctx.effect(() => async () => { /* ... */ await domain.close() }, '...')
  this.table = domain.table('sessions')
}
```
- `ctx.storageDomain` 类型为 `DomainFacility`（`@deepseek-ai/dsh-storage-domain`，其 `declare module '@deepseek-ai/cordis' { interface Context { storageDomain: DomainFacility } }`）。
- 域 spec 内部 record schema 用 `zod`（`z` from `'zod'`），而插件 `Config` 用 schemastery——两者不同源（storage-domain `src/index.ts` 顶部注释明确该 split）。
- sandore Task 1 **不实现**持久化，仅在 Provider 桩 `static inject` 声明 `storageDomain`（design.md §7.3 的 7 个服务：`sessions`/`sessionPersistence`/`subagents`/`llm`/`shell`/`fs`/`storageDomain`）。

---

## 8. 附：13 个 sandore/* 事件清单（对齐 work.md/design.md §5.2）

Cordis `Events`（首参 `info: DagRunInfo`）与 Session `SessionEventMap`（纯数据载荷）**双声明**的 13 个事件名：
`sandore/start`、`sandore/stage-start`、`sandore/stage-completed`、`sandore/step-start`、`sandore/step-completed`、`sandore/step-failed`、`sandore/step-paused`、`sandore/step-resumed`、`sandore/step-retried`、`sandore/question`、`sandore/permission`、`sandore/end`、`sandore/aborted`。
- 禁止虚构事件：无 `default-session-mounted`（D9）、无 `user-message`。
- `sandore/step-completed.output` 类型为 `ContentBlock[]`（`import type { ContentBlock } from '@deepseek-ai/dsh-llm'`）。
