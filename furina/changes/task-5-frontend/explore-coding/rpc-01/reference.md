## Exploration Result

> 说明：`furina config show exploration.reference` 返回空数组 `[]`，故无预配置参考目录/技能/URL。以下结果为对本地两处仓库的直接探索：
> 1. DSH 官方包：`D:/project-code/llm/deepseek-harness`
> 2. sandore 当前仓库：`D:/project-code/llm/sandore`

### 1. DSH 官方包如何配置 tsdown + typert generator 产出 `./remote`（typert.remote-client）与 `./typert`（typert.host）

#### 1.1 构建管线（两阶段）

根 `package.json`（`D:/project-code/llm/deepseek-harness/package.json`）的 scripts：

```
"build:lib": "npm run build:lib:host && npm run build:lib:client",
"build:lib:host": "tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host",
"build:lib:client": "tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client",
```

即：先 `tsc` 产出 `lib/types/**/*.js + .d.ts`（保留 `@Remote` 等标准 decorator 语法），再由 tsdown 打包并触发 typert 插件在 `lib/` 根写出 face 工件。

#### 1.2 根 tsdown.config.ts（`D:/project-code/llm/deepseek-harness/tsdown.config.ts`）

```ts
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
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

关键点：
- workspace 模式统一构建所有 `packages/*/*`；host 面 entry 是已编译产物 `lib/types/{index,invariant,startup}.js`。
- host 面才挂 `typertPlugin({ mode: 'workspace', faces: ['host'] })`。

#### 1.3 typert 插件（`D:/project-code/llm/deepseek-harness/packages/typert/generator/src/tsdown-plugin.ts`）

- `transform(code, id)`：对含 decorator 的 `.ts/.tsx` 用 `ts.transpileModule` 降级 decorator 语法（`DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m`）。
- `writeBundle({ dir })`：定位包根后，对**存在** `./typert`、`./client/typert` 或 `./remote` 任一 export 的包（`hasTypertExport`）调用 `WorkspaceTypertGenerator` 生成并写出：
  - `typert.{face}.js` + `typert.{face}.d.ts`（face=host → `typert.host.js` / `typert.host.d.ts`）
  - 若 face=host 且有 Remote 方法，额外写 `typert.remote-client.js` / `typert.remote-client.d.ts` / `typert.remote-client.d.ts.map`
  - `emitArtifacts` 中无 remote 且 face=host 时，会 `rmSync` 掉旧的 `typert.remote-client.*`。

#### 1.4 生成时的 exports/files 强制契约（`D:/project-code/llm/deepseek-harness/packages/typert/generator/src/workspace.ts` 的 `validateExport`）

对 host 面有 Remote 方法的包，生成器在写出时校验（不满足即抛 `TypertAnalysisError`）：

- `./typert` export 必须等于 `{ types: './lib/typert.host.d.ts', default: './lib/typert.host.js' }`
- `./remote` export 必须等于 `{ types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' }`
- `files` 必须包含：`lib/typert.host.js`、`lib/typert.host.d.ts`、`lib/typert.remote-client.js`、`lib/typert.remote-client.d.ts`

（`typert.remote-client.d.ts.map` 仅在工作区内生成供编辑器跳转，不发布。）

#### 1.5 DSH 四个官方包的实际 package.json exports/files

四个包（`message-feedback`、`interaction/commands`、`goal/goal`、`extensions/cordis-host-runner`）的 `exports` 均含：

```json
"./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
"./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" }
```

`files` 均含 `lib/typert.host.js`、`lib/typert.host.d.ts`、`lib/typert.remote-client.js`、`lib/typert.remote-client.d.ts`（以及 `lib/index.js`、`lib/invariant.js`、`lib/types/**/*`）。

包级 tsdown 配置：仅 `goal/goal` 有自己的 `tsdown.config.ts`（entry 为 `lib/types/index.js`、`lib/types/invariant.js`，esm/node/es2024/dts:false/clean:false）；`message-feedback`、`commands`、`cordis-host-runner` 无包级 tsdown 配置，由根 workspace 配置统一构建。

#### 1.6 `@Remote` / `TypertRemoteService` 用法

- 协议实现（`D:/project-code/llm/deepseek-harness/packages/typert/protocol/src/index.ts`）：
  - `abstract class TypertRemoteService extends Service`，`protected constructor(ctx, serviceKey, options?)`：`super(ctx, serviceKey)` 同时设定 cordis 服务名与默认 wire namespace；实例上挂 `readonly typertRemote: TypertGatewayBinding<this>`。
  - `Remote(exportName?)`：方法装饰器，标记公开实例方法为 direct Remote 调用（无参用方法名，带参为导出别名）；标记存于私有 `WeakMap`，`remoteMethods(service)` 读取。
  - 另提供 `bindTypertRemote(service, serviceKey, options)` 与 `RemoteScope(key, exportName?)`。
- 官方示例（`D:/project-code/llm/deepseek-harness/packages/interaction/commands/src/index.ts`）：
  ```ts
  export class CommandRuntime extends TypertRemoteService {
    constructor(ctx: Context) { super(ctx, 'commands') }
    @Remote
    list(agent: Agent): readonly CommandDescriptor[] { ... }
    @Remote
    async execute(agent: Agent, line: string, signal: AbortSignal): Promise<CommandExecution | undefined> { ... }
  }
  ```
- 生成器 analyzer 的 Remote 服务发现规则（`D:/project-code/llm/deepseek-harness/packages/typert/generator/src/analyzer.ts`，约 L916/L960/L1131 附近）：
  - 类继承 `TypertRemoteService`（heritage 检测，且要求构造器直接 `super(ctx, serviceKey)`，2~3 个实参）；
  - 或声明 `readonly typertGateway = bindTypertRemote(this, serviceKey)` 字段绑定；
  - 或 `@typert service <key>` JSDoc 标签（非 Remote 服务用）；
  - `TypertRemoteService` 子类不得再声明第二个 `typertRemote` 绑定。

### 2. api/remotes 客户端集中 `$mount` 与 ui-commands 的 `ctx.remote.commands.*` 消费

#### 2.1 api/remotes 客户端（`D:/project-code/llm/deepseek-harness/packages/api/remotes/src/client/index.ts`）

- 从每个提供方的 `.../remote` 子路径**默认导入** contribution（`TypertRemoteContribution`）：
  ```ts
  import commandsRemote from '@deepseek-ai/dsh-commands/remote'
  import goalsRemote from '@deepseek-ai/dsh-goal/remote'
  import dynamicRemote from '@deepseek-ai/dsh-cordis-host-runner/remote'
  import pluginInventoryRemote from '@deepseek-ai/dsh-host-plugin-inventory/remote'
  import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'
  ```
- 类型合并（关键）：`declare module '@deepseek-ai/cordis' { interface Context { remote: TypertClientRemote } }`，并用 `export type {} from '.../remote'` 拉入各包生成的 module augmentation（把方法签名并入 `TypertRemoteMap`/`TypertRemoteNamespaceMap`）。
- `export const inject = ['remote']`。
- `apply(ctx)`：按顺序 `await ctx.remote.$mount(contribution)`，收集 disposer；失败时逆序 dispose 后重抛；返回逆序 dispose 的总 disposer。
- `package.json`：`dsh.client = { inject: ['@deepseek-ai/dsh-api-gateway'], platform: 'web', immediately: true }`；`@deepseek-ai/dsh-typert-protocol` 为 dependency，各 remote 包为 peerDependency。

#### 2.2 ui-commands 消费（`D:/project-code/llm/deepseek-harness/packages/client/ui-commands/src/client/index.ts` 与 `service.ts`）

- 插件 `inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands', 'locale']`——`remote.commands` 是 `$mount` 后由 gateway 安装的 cordis 命名空间服务（服务键 `remote.${namespace}`）。
- `CommandUiRuntime` `static inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands']`。
- 调用与解包（service.ts）：
  ```ts
  const result = await ctx.remote.commands.list(sessionId)
  if (!result.ok) throw new Error(`command.list failed: ${result.error.code}: ${result.error.message}`)
  return result.value
  ```
  ```ts
  const result = await this.ctx.remote.commands.execute(session.sessionId, line)
  if (!result.ok) throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`)
  if (result.value === undefined) return { kind: 'error', text: `unknown or malformed command: ${line}` }
  ```
- 事件订阅：`ctx.remote.$on('commands/change', () => { this.directory.invalidateAll() })`、`ctx.remote.$on('agent-preset/selected', (sessionId) => { ... })`。
- 类型接入方式：`import type {} from '@deepseek-ai/dsh-api-remotes/client'`（拉入 `ctx.remote` 合并 + `$on` 事件 allowlist `ApiRemoteForwardedEvent`）。
- `package.json`：`dsh.client.inject` 首项即 `@deepseek-ai/dsh-api-remotes`；`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-api-remotes` 在 peerDependencies。

### 3. `RemoteResult` 的确切类型与解包惯例

#### 3.1 类型（`D:/project-code/llm/deepseek-harness/packages/typert/protocol/src/types.ts`）

```ts
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }
```

#### 3.2 生成端签名（`D:/project-code/llm/deepseek-harness/packages/typert/generator/src/emitter.ts` 的 `remoteFunctionType`）

每个生成方法固定为 `(...args) => Promise<RemoteResult<T>>`——载波失败已折叠进 error 分支，消费者不需要自行 try/catch 载波失败；只有装配错误（参数个数、方法未挂载、缺 Context binder）仍 reject。

#### 3.3 运行时语义（`D:/project-code/llm/deepseek-harness/packages/api/gateway/src/client/index.ts` 的 `invoke`）

- 载波返回 `{ ok:false }` → 原样 `{ ok: false, error: result.error }`。
- 载波抛错（离线 / abort / 拒绝的 result 载荷）→ `carrierFailure` 折叠为 `{ ok: false, error: { code: 'internal', message, details: {} } }`。
- 方法已卸载（`!token.active`）→ `withdrawn` 同样 `{ ok:false, error:{ code:'internal', message, details:{} } }`。
- 真正抛错（reject）仅发生在 `validateContribution`/arity 校验/缺 Context binder 等装配层。

#### 3.4 解包惯例

统一模式（ui-commands、api/remotes 消费处一致）：`if (!result.ok) { 处理/抛 result.error（code/message） } else { 用 result.value }`。

### 4. `ctx.remote.$mount` / `$on` 契约与 disposer 生命周期

#### 4.1 接口契约（`D:/project-code/llm/deepseek-harness/packages/typert/protocol/src/types.ts` 的 `TypertClientRemote`）

```ts
export interface TypertClientRemote extends TypertRemoteNamespaceMap {
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  $on<Event extends TypertRemoteEvent>(event: Event, listener: Events[Event]): () => void
  $dispatch(event: string, args: readonly unknown[]): void
}
export type TypertDisposer = () => Promise<void>
```

- `TypertRemoteContribution = { package: string; descriptors: readonly InvocationDescriptor[] }`。
- `$mount` 返回**异步** disposer（`() => Promise<void>`）；`$on` 返回**同步** disposer（`() => void`）。
- 事件键 `TypertRemoteEvent = Extract<keyof Events, keyof TypertRemoteEventSelection>`，即由 Host 组装面 allowlist（`TypertRemoteEventSelection`）选中才可用。

#### 4.2 实现（`D:/project-code/llm/deepseek-harness/packages/api/gateway/src/client/index.ts` 的 `ClientRemoteService`）

- 服务键：`super(ctx, 'remote')`，`inject = ['typert', 'connection']`。
- `$mount(contribution)`：
  1. `validateContribution`（重复 method/namespace 冲突、需 strict codec 等校验）；
  2. `callerCtx.typert.remotes.register(contribution)`（注册到 typert registry）；
  3. 对每个 descriptor `install()`：为每个 namespace 创建 `RemoteNamespaceService`（cordis 服务键 `remote.${namespace}`），`Object.defineProperty` 每个方法为 getter，返回 `(...args) => Promise<RemoteResult<unknown>>`，内部 `connection.rpc.call('/api', endpoint, { args }, signal)`（endpoint = `${namespace}/${method}`）。
  4. disposer：逆序卸载方法、namespace 空则 dispose、注销 registry。
- 整个 `$mount` 经 `ctx.effect(...)` 绑定调用方 fiber（label `api-gateway.client.$mount(<package>)`），fiber 销毁时自动逆序清理。
- `$on(event, listener)`：按事件名维护订阅表，经 `ctx.effect` 绑定 fiber，disposer 只移除自身注册（同函数多次订阅互不影响）；`$dispatch` 按注册顺序投递并隔离 listener 抛错/拒绝的 Promise。

#### 4.3 生命周期约定

- `$mount` 的贡献随调用方 fiber 存续；api/remotes 的 `apply` 在客户端根上统一 mount，返回的总 disposer 逆序卸载。
- 命名空间服务 `remote.commands` /（对应 sandore 即为）`remote.sandore` 是 cordis 服务，可被 `inject` 依赖注入，也可 `ctx.remote.sandore.*` 访问。

### 5. sandore 当前状态（workflow + ui 桩）

#### 5.1 `workflow/src/remote.ts`（`D:/project-code/llm/sandore/packages/sandore/workflow/src/remote.ts`）

- `export class SandoreRemote extends TypertRemoteService`，`static inject = ['sandorePersistence', 'sandoreEngine', 'llm']`，`constructor(ctx) { super(ctx, 'sandore') }`（wire namespace / 服务键 = `sandore`）。
- 27 个 `@Remote('name')` 方法（端点 `sandore/<name>`）：
  1. `ping`
  2. `listDefinitions`
  3. `createDefinition`
  4. `updateDefinition`
  5. `deleteDefinition`
  6. `getYaml`
  7. `updateYaml`
  8. `listJobs`
  9. `createJob`
  10. `getJob`
  11. `updateJob`
  12. `deleteJob`
  13. `listInstances`
  14. `startInstance`
  15. `deleteInstance`
  16. `getInstanceState`
  17. `abortInstance`
  18. `replyQuestion`
  19. `replyPermission`
  20. `pauseStep`
  21. `resumeStep`
  22. `pauseAll`
  23. `resumeAll`
  24. `retryStep`
  25. `getArtifacts`
  26. `listProviders`
  27. `listModels`
- 入参一律 zod schema 校验后转发/存储；参数均为 JSON（字符串/对象，如 `CreateDefinitionInput` 等），**无** lookup 参数（对比 commands 的 `agent: Agent` lookup 参数）。`export default SandoreRemote`。
- 文件内注释把端点写作 `sandore.<method>`（点号）为口语化表述；实际 wire key 为 `${namespace}/${method}`（斜杠），由 `typertEndpoint` / `TypertRemoteNamespace` 决定。

#### 5.2 `workflow/package.json`（`D:/project-code/llm/sandore/packages/sandore/workflow/package.json`）

- name `@deepseek-ai/dsh-sandore-workflow`，`type: module`。
- `exports` 仅有 `.`（`./lib/index.js` + `./lib/types/index.d.ts`）、`./types`、`./src/*`、`./package.json`；**无 `./typert`、无 `./remote`**。
- `files` 仅 `lib/index.js`、`lib/types/**/*.js`、`lib/types/**/*.d.ts`；**无 `lib/typert.*`**。
- `scripts` 仅 `typecheck`（`tsc --noEmit`）；**无 `build`/`bundle`、无 tsdown 配置**。
- `peerDependencies` / `devDependencies` 含 `@deepseek-ai/dsh-typert-protocol: 0.1.0-rc.6`；**不含** `@deepseek-ai/dsh-typert-generator`、`@deepseek-ai/dsh-typert-registry`。
- `workflow/tsconfig.json`：`rootDir: ".."`、`outDir: "lib/types"`、`include: ["src"]`（当前 `lib/types` 输出路径与 package.json 的 `lib/types/index.d.ts` 引用未对齐，属未完成骨架）。

#### 5.3 `workflow/src/index.ts`

- 只导出 `types/errors/schema/yaml-parser/shell/seam/dag-navigator` 与默认 `SandoreEngineRuntime`；**未导出也未注册 `SandoreRemote`**。

#### 5.4 `ui/src/client/index.ts`（`D:/project-code/llm/sandore/packages/sandore/ui/src/client/index.ts`）

- `inject = ['slots', 'locale']`。
- `apply(ctx)` 内构造 `HostCall` 桩：`call: async (method, _args) => { if (method === 'sandore.ping') return { pong: true, service: 'sandore', time: ... }; throw ... }`，经 `ctx.slots.inject('sidebar.footer.action', ...)` 注入 `WorkflowButton`。
- **未使用 `ctx.remote`**，注释明示“生产链路接入 `ctx.remote` 的生成贡献后替换”。

#### 5.5 `ui/src/client/host.ts`

- `HostCall` 接口：`call(method: string, args?: unknown): Promise<unknown>`。
- `PingResponse` 接口 + `isPingResponse(value): value is PingResponse` 类型守卫。

#### 5.6 `ui/src/index.ts` 与 `ui/package.json`

- `ui/src/index.ts`：Node 半空 `apply(): void {}`。
- `ui/package.json`：name `@deepseek-ai/dsh-client-ui-sandore`；`exports` 含 `.`、`./client`、`./src/*`；`dsh.client = { inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-sidebar'], platform: 'web' }`；**无 `@deepseek-ai/dsh-api-remotes` 依赖/注入、无 `remote` 注入**；`scripts` 仅 `typecheck`；无 tsdown 配置。

#### 5.7 sandore 仓库级构建现状

- 根 `package.json` 仅 `typecheck`/`build`（`pnpm -r --if-present run build`）/`test`；`tsconfig.base.json` 声明 `declaration/sourceMap/declarationMap`、`allowImportingTsExtensions`、`rewriteRelativeImportExtensions` 等。
- 全仓库**无** `tsdown.config.*`、**无** `tsconfig.host.json` / `tsconfig.client.json`（仅有 `tsconfig.base.json`），即 tsdown + typert generator 的 host/client 双面构建管线尚未接入。

## Supplementary Exploration Result

- 配置：`experimental.websearch=true`、`experimental.context7=true`。
- 本地参考（deepseek-harness 仓库）已完整覆盖需求理解（typert generator/plugin、protocol、registry、gateway、api/remotes、ui-commands、DSH 四包 package.json 与 tsdown 配置、sandore 现状），Phase 3 信息充足，未触发额外 websearch / context7 查询。
