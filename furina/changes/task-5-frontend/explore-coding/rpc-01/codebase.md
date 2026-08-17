## Exploration Result

> 本阶段按 codebase.md 指令执行：`furina config show project.sourcecode codebases` 返回
> `project.sourcecode=src/`、`codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`。
> 该 codebase 元素（`D:/project-code/llm/sandore/docs/codebase`）目录为空，且其 description（`optix-explore skill`）与本探索主题（Typert 远程客户端）无关，故 Phase 3 无可调度内容，直接进入 Phase 4 补充探索。

## Supplementary Exploration Result

### 需求理解（Phase 2）

- **What**：为 sandore 的 `workflow` 包补齐 Typert 远程客户端贡献的 `./remote` 子路径导出（由 tsdown + typert generator 从 `SandoreRemote` 的 `@Remote` 装饰器生成 `lib/typert.remote-client.js` + `.d.ts`），并让 `ui` Client 插件在 `apply(ctx)` 内 `ctx.remote.$mount(sandoreRemote)` 后以 `ctx.remote.sandore.*` 调用 27 个 RPC。
- **Boundaries**：(a) DSH 官方包（`message-feedback`/`commands`/`goal`/`cordis-host-runner`）的 tsdown + typert generator 构建配置与 `./remote`/`./typert` 产出；(b) `api/remotes` 客户端集中 `$mount` 与 `ui-commands` 的 `ctx.remote.commands.*` 消费；(c) `RemoteResult` 类型与解包惯例；(d) `ctx.remote.$mount/$on` 契约与 disposer 生命周期；(e) sandore 当前 `workflow/src/remote.ts` 与 `package.json` exports、`ui/src/client/index.ts+host.ts` 桩现状。
- **Goal**：定位权威范本（DSH 仓库 + node_modules 发布物）与 sandore 现状差距，为 RPC 接线任务提供事实依据。
- **Project Context**：sandore 是 DSH（DeepSeek Harness）生态下的第三方插件仓库（4 包：`workflow`/`microflow`/`tool`/`ui`），运行在 `@deepseek-ai/cordis@4.0.1` DI 框架上；RPC 层走 DSH 自研 Typert 协议（`@deepseek-ai/dsh-typert-protocol`）。参考源码仓库位于 `D:/project-code/llm/deepseek-harness`（只读），发布物位于 sandore 的 `node_modules/.pnpm/@deepseek-ai+dsh-*`。

---

### (1) DSH 官方包如何配置 tsdown + typert generator 产出 `./remote` 与 `./typert`

**生成器插件入口**：`@deepseek-ai/dsh-typert-generator` 提供 `./tsdown` 子路径导出 `typertPlugin`。
- 包定义：`D:/project-code/llm/deepseek-harness/packages/typert/generator/package.json`（`exports["./tsdown"] → lib/types/tsdown-plugin.js`；版本 `0.1.0-rc.5`，协议为 `rc.6`）。
- 插件实现：`D:/project-code/llm/deepseek-harness/packages/typert/generator/src/tsdown-plugin.ts`。

**根 tsdown 配置**（workspace 模式，业务包无需各自配置）：
`D:/project-code/llm/deepseek-harness/tsdown.config.ts`
```ts
import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE) // host/client 双 face
  return {
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'], // 先由 tsc 把 .js/.d.ts emit 到 lib/types，tsdown 再从这里 bundle
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
```

**`typertPlugin` 行为要点**（`tsdown-plugin.ts`）：
- `transform` 钩子：对依赖中带 `@...` 装饰器语法的 `.ts/.tsx` 源做 `ts.transpileModule`（降装饰器）后交给 bundler。
- `writeBundle` 钩子：在 `mode: 'workspace'` 下，向上定位 workspace 根（以存在 `tsconfig.host.json` 为标记），`discover` 所有显式贡献者，**按 `package.json` 的 `exports` 是否含 `./typert`、`./client/typert` 或 `./remote` 过滤**，然后对每个包生成并写入：
  - `lib/typert.host.js` + `lib/typert.host.d.ts`（Host FaceModel，导出 `TYPERT`）
  - `lib/typert.remote-client.js` + `lib/typert.remote-client.d.ts` + `lib/typert.remote-client.d.ts.map`（客户端贡献，导出 `TYPERT_REMOTE`）
  - 无 remote 面时删除残留的 `typert.remote-client.*`。
- **关键结论**：业务包只需在其 `package.json` 的 `exports` 声明 `./typert`/`./remote` 并在 `files` 里包含生成物，生成动作由根 workspace 配置集中完成；业务包自身 `package.json` 无 `scripts.bundle`（对照 `typert-registry`/`api-remotes` 有 `"bundle": "tsdown"`）。

**四个业务包的 `package.json` exports/files 一致范式**（发布物 `node_modules/.pnpm/@deepseek-ai+dsh-{message-feedback,commands,goal,cordis-host-runner}*/.../package.json`）：
```jsonc
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
  "./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
  "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
  "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" },
  "./src/*": "./src/*",
  "./package.json": "./package.json"
},
"files": [
  "lib/index.js", "lib/invariant.js",
  "lib/types/**/*.js", "lib/types/**/*.d.ts",
  "lib/typert.host.js", "lib/typert.host.d.ts",
  "lib/typert.remote-client.js", "lib/typert.remote-client.d.ts"
]
```
（`goal` 额外有 `./client`；`commands` 额外有 `./brand`；`cordis-host-runner` 无 `invariant.js` 但 files 仍保留同形。）

**`@Remote`/`TypertRemoteService` 用法**（协议包 `D:/project-code/llm/deepseek-harness/packages/typert/protocol/src/...`，发布物 `.d.ts` 见 `node_modules/.pnpm/@deepseek-ai+dsh-typert-pro_*/.../lib/types/index.d.ts`）：
- `export abstract class TypertRemoteService<out T = never> extends Service<T>`，`constructor(ctx, serviceKey, options?)` 内 `bindTypertRemote(this, serviceKey, options)`，暴露 `readonly typertRemote: TypertGatewayBinding<this>`。
- `Remote` 装饰器两种形态：裸 `@Remote`（端点方法名 = 实现方法名）与 `@Remote(exportName)`（显式端点名）；另有 `RemoteScope(key, exportName?)`（按 Context 作用域解析）。
- 源码示例（`D:/project-code/llm/deepseek-harness/packages/interaction/commands/src/index.ts`，`CommandRuntime`）：`super(ctx, 'commands')` + `@Remote list(agent: Agent)` + `@Remote async execute(agent: Agent, line: string, signal: AbortSignal)`；`Agent` 参数经 `TypertLookupMap`/`TypertContextMap`（`scope: {context:'agent', wire:'agentId'}`）变成调用方的 `sessionId` 自动填充，`signal` 为 reserved 取消参数。

**生成物内容示例**（`node_modules/.pnpm/@deepseek-ai+dsh-commands@*/.../lib/typert.remote-client.{js,d.ts}`）：
- `.js`：inline `zod` schema + `export const TYPERT_REMOTE = { package, descriptors: InvocationDescriptor[] }`，`export default TYPERT_REMOTE`；每个 descriptor 含 `id/service/namespace/method/invocation/scope/parameters(带 zod codec)/cancellation/result/sourceLocation`。
- `.d.ts`：对 `@deepseek-ai/dsh-typert-protocol` 做 module augmentation（`TypertRemoteMap['commands/execute']`、`TypertRemoteNamespaceMap['commands']`、`TypertRemoteScopeMap['agent:commands/execute']`），并 `export declare const TYPERT_REMOTE: TypertRemoteContribution`。namespace 内部名用 hex 编码（如 `commands` → `TypertRemoteNamespace$636f6d6d616e6473`）。

**生成器对类型的 schema 化**（`generator/src/analyzer.ts`）：`typertMode()` 读 `@typert` JSDoc 标签区分 `'schema'`（zod 运行时校验 → strict codec）/`'object'`（引用传递能力对象 → lookup）；无标签时由 type-model 从普通 TS 类型自动派生 zod schema（strict）。`TypertCodec` 尚有 `{mode:'src-json'}` 弱模式兜底（协议 `types.d.ts`）。

**Client UI 包的 bundle 参考**（sandore `ui` 包对标）：
- 助手函数 `clientBundle(id, libEntry, options)`：`D:/project-code/llm/deepseek-harness/packages/client/tsdown.client.ts`。产出 Node 半 `lib/index.js`（从 `lib/types/*.js` 二次 bundle）+ 浏览器半 `lib/client.js`（`window.__ModuleLoader__.load({id, factory})` 闭包工厂，CSS Modules 经 lightningcss 内联，`CLIENT_EXTERNALS` 平台模块外置，`GENERATED_REMOTE`（`@deepseek-ai/dsh-*/remote`）内联放行）。
- 范例 `ui-cordis`：`D:/project-code/llm/deepseek-harness/packages/extensions/ui-cordis/tsdown.config.ts`（`export default clientBundle('@deepseek-ai/dsh-client-ui-cordis', ['lib/types/index.js','lib/types/invariant.js'])`）+ `package.json` 的 `dsh.client.inject` 含 `@deepseek-ai/dsh-api-remotes`。
- 注：DSH 包先由 tsc 将 `.js`/`.d.ts` emit 到 `lib/types`（`tsconfig.host.json`/`tsconfig.client.json` 的 `outDir: "lib/types"`），tsdown 再以 `lib/types/*.js` 为 entry。

---

### (2) `api/remotes` 客户端如何集中 `$mount`、ui-commands 如何 `ctx.remote.commands.*` 消费

**集中 `$mount` 源**：`D:/project-code/llm/deepseek-harness/packages/api/remotes/src/client/index.ts`（发布物 `node_modules/.pnpm/@deepseek-ai+dsh-api-remote_*/.../lib/types/client/index.d.ts` + bundle 版 `lib/client.js`）。
```ts
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import dynamicRemote from '@deepseek-ai/dsh-cordis-host-runner/remote'
import pluginInventoryRemote from '@deepseek-ai/dsh-host-plugin-inventory/remote'
import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'

declare module '@deepseek-ai/cordis' {
  interface Context { remote: TypertClientRemote }
}
export const inject = ['remote']
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [commandsRemote, goalsRemote, dynamicRemote, pluginInventoryRemote, messageFeedbackRemote]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  return async () => { for (const dispose of disposers.reverse()) await dispose() }
}
```
要点：`inject = ['remote']`；`apply` 返回**异步 disposer**；挂载失败时逆序回滚已挂项；卸载时逆序 dispose（挂载晚者先撤）。

**`ctx.remote` 服务的声明来源**：`dsh-api-remotes` 对 `@deepseek-ai/cordis` 的 `Context` 做 `remote: TypertClientRemote` 增强；运行时实现由 `dsh-api-gateway` client 提供（见下 (4)）。消费方 `import type {} from '@deepseek-ai/dsh-api-remotes/client'` 即可获得 `ctx.remote` 类型。

**ui-commands 消费**（命令执行链在 `node_modules/.pnpm/@deepseek-ai+dsh-client-run_*/.../dsh-client-runtime/lib/client.js`）：
- 服务注入声明：`const inject = ['connection','typert','remote','remote.commands']`。
- `apply` 里 `ctx.typert.contexts.registerClient('agent', { identity: sessions.scopeOf })` 注册 client 作用域 binder（把调用方 `Context` 映射为 `sessionId`，供 scoped 端点如 `commands/execute` 自动填第一个参数）；`ctx.remote.$dispatch(frame.event, frame.args)` 分发宿主导入的 `host/remote-event` 帧。
- 消费示例（`SessionRuntime.command`）：
```ts
const result = await this.remote.commands.execute(this.sessionId, line)
if (!result.ok) return result
return { ok: true, value: { matched: result.value !== void 0 } }
```

**ui 插件（`ui-cordis`）消费 `ctx.remote` 的完整形态**：`D:/project-code/llm/deepseek-harness/packages/extensions/ui-cordis/src/client/index.ts` —— `inject` 含 `'remote'` 与 `'remote.dynamicCordisRunner'`；`import type {} from '@deepseek-ai/dsh-api-remotes/client'`；直接调用 `ctx.remote.dynamicCordisRunner.stopFromPanel(...)` 后解包；`ctx.remote.$on('cordis/dynamic-package', () => inventory.refresh())` 订阅转发事件。注意：ui-cordis 自身不 `$mount`，因为 `dsh-api-remotes` 已集中挂载（`dsh.client.inject` 保证先加载）——而 sandore 的 workflow remote 不在该集中装配里，故 sandore `ui` 需自挂（设计 D-1 已明确）。

---

### (3) `RemoteResult`（`{ok:true,value}|{ok:false,error}`）确切类型与解包惯例

类型定义（`@deepseek-ai/dsh-typert-protocol` `lib/types/types.d.ts`，源码 `D:/project-code/llm/deepseek-harness/packages/typert/protocol/src/types.ts`）：
```ts
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}
export type RemoteResult<T> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }
```
语义注释（官方）：每个生成的 Remote 方法都 resolve 为 `RemoteResult<T>`；承载层故障折叠进 error 分支，消费者无需 try/catch 恢复；仅装配性故障（arity 不匹配、未挂载、缺 Context binder）才 reject。

**解包惯例**（多处一致）：
- `if (!result.ok) return result`（或 throw/呈现）→ 取 `result.error.code` + `result.error.message`；`result.ok === true` 时取 `result.value`。
- 例（`dsh-client-runtime`）：`if (!result.ok) return result; return { ok: true, value: {...result.value} }`。
- 例（`ui-cordis` `port.stop`）：`if (!answered.ok) return { ok:false, message: \`${answered.error.code}: ${answered.error.message}\` }; ... answered.value`。
- sandore `rpc-wiring` spec 要求 ui 组件层统一经薄封装解包，`ok:false` 抛/呈现错误（Toast/行内），不静默吞错。

---

### (4) `ctx.remote.$mount/$on` 契约与 disposer 生命周期

契约声明（`dsh-typert-protocol` `types.d.ts` 的 `TypertClientRemote`，扩展 `TypertRemoteNamespaceMap`）：
```ts
export type TypertDisposer = () => Promise<void>
interface TypertClientRemote extends TypertRemoteNamespaceMap {
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  $on<Event extends TypertRemoteEvent>(event: Event, listener: Events[Event]): () => void
  $dispatch(event: string, args: readonly unknown[]): void
}
interface TypertRemoteContribution { readonly package: string; readonly descriptors: readonly InvocationDescriptor[] }
```

运行时实现（`D:/project-code/llm/sandore/node_modules/.pnpm/@deepseek-ai+dsh-api-gatewa_*/.../dsh-api-gateway/lib/client.js`，`ClientRemoteService`，`super(ctx, 'remote')`，`inject = ['typert','connection']`）：
- `$mount(contribution)`：把本次挂载包进 `callerCtx.effect(...)`（**绑定调用方 fiber 生命周期**）；内部 `ctx.typert.remotes.register(contribution)` 登记贡献 → 逐 descriptor `install`（为每个 namespace 创建 `remote.<namespace>` 服务 fiber）→ 返回异步 disposer，逆序卸载各方法 + 撤销 registry 登记。若 install 中途失败，逆序回滚已装项并重抛。
- `$on(event, listener)`：把 listener 挂到 `callerCtx.effect` 的订阅表，返回同步 disposer；事件按注册顺序投递，单个 listener 抛错被隔离（console.error 不中断他人）。
- `$dispatch(event, args)`：由承载层（如 `dsh-client-runtime` 的 `onHostEnvelope`）把宿主导入帧喂给订阅表；无订阅者静默丢弃。

**命名空间嵌套解析机制**（这是 `ctx.remote.sandore.*` 能工作的底层原因，`@deepseek-ai/cordis/src/{service.ts,utils.ts,reflect.ts}`）：
- `Service` 构造器把 `associate: name` 写入实例 tracker（`remote` 服务的 `associate='remote'`）。
- `ctx.remote` 经 Context Proxy 解析为 `ClientRemoteService`（`getTraceable` 包裹为 traceable Proxy）。
- 访问 `ctx.remote.commands` 时，traceable Proxy 的 `get` 发现 `tracker.associate='remote'` 且 `ctx.reflect.props['remote.commands']` 已声明，遂 `Reflect.get(ctx, 'remote.commands', ...)` 转发到 `remote.commands` 服务（`RemoteNamespaceService`）。
- `RemoteNamespaceService`（`super(ctx, 'remote.<namespace>')`）在 `install` 时用 `Object.defineProperty(this, method, { get })` 逐方法挂 getter，getter 返回 `(...args) => this.invokeRemote(direct, scoped, callerCtx, args)`，调用时经 `connection.rpc.call('/api', endpoint, {args}, signal)` 走线，回包 `result.ok` 判定后 `parse(descriptor.result, result.value)` 返回 `RemoteResult`。

**sandore 落地含义**：`ctx.remote.$mount(sandoreRemote)` 后，`ctx.remote.sandore.*` 即 `remote.sandore` 命名空间服务上的 27 个方法；`$mount` 返回的 `TypertDisposer` 应经 `ctx.effect(() => disposer, ...)` 或 `apply` 返回的 async disposer 交由插件生命周期清理（对齐 `rpc-wiring` spec「卸载时清理」）。

---

### (5) sandore 当前状态

**`workflow` 包（`D:/project-code/llm/sandore/packages/sandore/workflow`）**

- `package.json`：`@deepseek-ai/dsh-sandore-workflow`，`exports` 仅 `"."`、`"./types"`、`"./src/*"`、`"./package.json"`——**无 `./typert`、无 `./remote`**；`files` 仅 `lib/index.js` + `lib/types/**`——**无 typert 生成物**；`scripts` 仅 `typecheck: tsc --noEmit`；`peerDependencies` 已含 `@deepseek-ai/dsh-typert-protocol: 0.1.0-rc.6`。
- `tsconfig.json`：`outDir: "lib/types"`、`rootDir: ".."`（因 `src/errors.ts` 等直引 `../../microflow/src/...`），仅 typecheck，无 emit 产物；仓库内 **无任何 `tsdown.config.*`**（`packages` 下无 build 配置）。
- `src/remote.ts`（`SandoreRemote`，核心）：
  - `export class SandoreRemote extends TypertRemoteService`，`constructor(ctx) { super(ctx, 'sandore') }` → wire namespace `sandore`，端点形态 `sandore.<method>`。
  - `static inject = ['sandorePersistence', 'sandoreEngine', 'llm']`。
  - 27 个 `@Remote('name')`（**显式 exportName 形态**，与 DSH `commands` 的裸 `@Remote` 不同）方法：`ping / listDefinitions / createDefinition / updateDefinition / deleteDefinition / getYaml / updateYaml / listJobs / createJob / getJob / updateJob / deleteJob / listInstances / startInstance / deleteInstance / getInstanceState / abortInstance / replyQuestion / replyPermission / pauseStep / resumeStep / pauseAll / resumeAll / retryStep / getArtifacts / listProviders / listModels`（共 27 个，与 spec 的 27 个 RPC 一致）。
  - 入参为单对象/字符串，方法体内自用 `zod`（`CreateDefinitionInputSchema` 等 `z.object(...)`）`.parse()` 同步校验；错误用 `SandoreError`（`code` 如 `NODE_NOT_FOUND`/`INVALID_OPERATION`/`YAML_PARSE`）抛出。**入参类型为 `z.infer` 派生**（如 `export type CreateDefinitionInput = z.infer<typeof CreateDefinitionInputSchema>`），无 `@typert` JSDoc 标签。
  - 底层依赖：`ctx.sandorePersistence`（`SandorePersistence` 三表 `definitions/jobs/state`，key 分别为 workflowId/jobId/instanceId，见 `src/persistence.ts`）、`ctx.sandoreEngine`（`SandoreEngine` 抽象，实例级生命周期 11 方法，见 `src/seam.ts`/`src/engine-surface.ts`）、`ctx.llm`（`listProviders/listModels`）。
  - `src/index.ts` 默认导出 `SandoreEngineRuntime`，named 导出 `SandoreEngine` 等；**未导出 `SandoreRemote`**（`remote.ts` 未被 `index.ts` 引用；`remote.spec.ts` 直接 `import { SandoreRemote } from './remote.ts'`）。
  - `src/remote.spec.ts`：内存 mock `storageDomain`/`llm`/`sandoreEngine` 直接 `new SandoreRemote(ctx)` 测 27 方法（zod 校验、SandoreError code、转发链），可作为生成后行为对齐依据。
  - 类型面：`src/types.ts`（browser-safe 纯 type，`DagRun`/`DagStartRequest`/`AskUserQuestionAnswer` 等）、`src/schema.ts`（真实 zod，顶部 `import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'` 为 Node 侧存储依赖，设计 D-1 指出需把定义层 schema 与存储层拆分以浏览器安全）。

**`ui` 包（`D:/project-code/llm/sandore/packages/sandore/ui`）**

- `package.json`：`@deepseek-ai/dsh-client-ui-sandore`，`exports` 含 `"."`、`"./client"`（`lib/types/client/index.d.ts`/`lib/client.js`）、`"./src/*"`、`"./package.json"`；`dsh.client.inject = ['@deepseek-ai/dsh-client-runtime','@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-ui-sidebar']`、`platform: 'web'`（**缺 `@deepseek-ai/dsh-api-remotes`**）；无 tsdown 配置。
- `src/client/index.ts`：`export const inject = ['slots', 'locale']`；`apply(ctx: ClientContext)` 注册 locale 字典 + `ctx.slots.inject('sidebar.footer.action', ...)` 注入 `WorkflowButton`；当前构造本地桩 `host: HostCall = { call: async (method, _args) => method === 'sandore.ping' ? {...ping 桩} : throw }` 传给按钮（注释明确「生产链路接入 ctx.remote 的生成贡献后替换」）。
- `src/client/host.ts`：`HostCall`/`PingResponse`/`isPingResponse` 类型守卫（`sandore.ping` 字面量桩，属 Task 1 原型）。
- `src/index.ts`：Host 半 `export function apply(): void {}`（空，仅让插件出现在 cordis.yml/Loader）。
- 组件：`WorkflowButton.tsx`/`WorkflowPanel.tsx`（+ `.module.css`）。

**权威需求（`D:/project-code/llm/sandore/furina/changes/task-5-frontend`）**

- `design.md` D-1：`workflow` 包构建用 tsdown + typert generator（`@deepseek-ai/dsh-typert-generator/tsdown`）从 `@Remote` 装饰器生成 `lib/typert.remote-client.js`；`package.json` 增 `"./remote"` 导出；`ui` 插件 `apply(ctx)` 内 `ctx.remote.$mount(sandoreRemote)`（disposer 经 `ctx.effect` 管理），调用面 `ctx.remote.sandore.*`；`inject` 加 `'remote'`，`dsh.client.inject` 含 `@deepseek-ai/dsh-api-remotes`。D-8：删除 `host.ts` 本地桩。
- `specs/rpc-wiring/spec.md`：`exports` MUST 含 `"./remote"`、`files` 含生成物；`import sandoreRemote from '@deepseek-ai/dsh-sandore-workflow/remote'` 类型解析到 `lib/types/typert.remote-client.d.ts`；挂载后 `ctx.remote.sandore.ping()` 返回 `RemoteResult`；卸载时 disposer 执行、命名空间移除；ui 组件统一解包 `RemoteResult`，`ok:false` 不静默吞错。
