# 探索结果：Typert 远程客户端贡献（`./remote` 子路径导出）

## 需求理解

- **What**：为 sandore 的 workflow 包提供 Typert 远程客户端贡献的 `./remote` 子路径导出——即用 tsdown + typert generator 从 `SandoreRemote` 的 `@Remote` 装饰器生成 `lib/typert.remote-client.js` + `.d.ts`（以及宿主半的 `./typert` → `lib/typert.host.js/.d.ts`），并让 ui Client 插件 `apply(ctx)` 内 `ctx.remote.$mount(sandoreRemote)` 后以 `ctx.remote.sandore.*` 调用 27 个 RPC。
- **Boundaries**：DSH 官方仓（`D:/project-code/llm/deepseek-harness`）的 typert 体系（protocol/generator/loader/registry + api/remotes + api/gateway + client/ui-commands）作为参照；sandore 当前 `workflow` 与 `ui` 两个包的现状。
- **Goal**：摸清 `./remote`/`./typert` 的产物形态、tsdown+generator 的构建接线、`@Remote`/`TypertRemoteService` 用法、`$mount`/`$on` 契约与 disposer 生命周期、`RemoteResult` 类型与解包惯例，以及 sandore 现状差距。

---

## 1. DSH 官方包如何配置 tsdown + typert generator 产出 `./remote` 与 `./typert`

### 1.1 参考包清单（包名 → 仓库路径）

| 探索名 | npm 包名 | 仓库路径 |
|---|---|---|
| message-feedback | `@deepseek-ai/dsh-message-feedback` | `packages/feedback/message-feedback` |
| commands | `@deepseek-ai/dsh-commands` | `packages/interaction/commands` |
| goal | `@deepseek-ai/dsh-goal` | `packages/goal/goal` |
| cordis-host-runner | `@deepseek-ai/dsh-cordis-host-runner` | `packages/extensions/cordis-host-runner` |

### 1.2 package.json 的 `exports` 与 `files`（四个包完全一致的模式）

每个包的 `exports` 都含两个关键子路径：

```jsonc
"./typert": {
  "types": "./lib/typert.host.d.ts",
  "default": "./lib/typert.host.js"
},
"./remote": {
  "types": "./lib/typert.remote-client.d.ts",
  "default": "./lib/typert.remote-client.js"
},
```

每个包的 `files` 都必须包含这 4 个产物（`typert.host` 2 个 + `typert.remote-client` 2 个）：

```jsonc
"files": [
  "lib/index.js",
  "lib/invariant.js",
  "lib/types/**/*.js",
  "lib/types/**/*.d.ts",
  "lib/typert.host.js",
  "lib/typert.host.d.ts",
  "lib/typert.remote-client.js",
  "lib/typert.remote-client.d.ts"
]
```

注意：`typert.remote-client.d.ts.map` 也被 generator 写出到 `lib/`，但**不进入 `files`**（仅供 workspace 内编辑器跳转，见 generator `workspace.ts` 的 `validateExport` 注释）。此外这四个参考包本身**没有** `scripts.bundle`——它们靠工作区根 tsdown 的 workspace 模式统一产出（见 1.3/1.4）。

### 1.3 根 tsdown 配置（`deepseek-harness/tsdown.config.ts`）

```ts
import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)   // 仅 'client' 为 true，缺省/'host' 为 false
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

要点：宿主构建（非 client）挂 `typertPlugin({ mode: 'workspace', faces: ['host'] })`，在 `writeBundle` 阶段为每个显式贡献包写出 `typert.host.*` 与 `typert.remote-client.*`。

### 1.4 构建脚本（根 `package.json`）

```jsonc
"build:lib:host":   "tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host",
"build:lib:client": "tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client",
```

即：先 `tsc -b` 产出 `lib/types/*.d.ts`/`.js`（generator 的入口依赖这些已 emit 的声明），再跑 tsdown（其 typert plugin 从 Host Program 生成 Remote 贡献）。

### 1.5 typert generator 的产物与校验契约

- 包名：`@deepseek-ai/dsh-typert-generator`，子路径 `./tsdown` 暴露 `typertPlugin`（见 `packages/typert/generator/package.json` 与 `src/tsdown-plugin.ts`）。
- 输出文件名（`tsdown-plugin.ts` 的 `emitArtifacts`）：
  - `typert.${face}.js` / `typert.${face}.d.ts`（host face → `typert.host.js`/`.d.ts`）
  - 当 artifact 含 `remote` 时额外写 `typert.remote-client.js` + `.d.ts` + `.d.ts.map`
- 跳过条件：`hasTypertExport(exports)` 要求包 `exports` 里存在 `./typert`、`./client/typert` 或 `./remote` 之一，否则跳过。
- 严格校验（`workspace.ts` 的 `validateExport`，构建时**报错**而不静默跳过）：
  - host face 必须导出 `./typert` = `{ types: './lib/typert.host.d.ts', default: './lib/typert.host.js' }`，且 `files` 含 `lib/typert.host.js`、`lib/typert.host.d.ts`；
  - 有 Remote 方法时，必须导出 `./remote` = `{ types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' }`，且 `files` 含 `lib/typert.remote-client.js`、`lib/typert.remote-client.d.ts`；
  - 无 Remote 方法却发布了 Remote 产物会报错。

### 1.6 生成的 `typert.remote-client.*` 形态（`emitter.ts` 的 `emitRemote` / `renderRemoteDts`）

JS 侧导出两个名字（默认导出与命名导出指向同一对象）：

```js
export const TYPERT_REMOTE = {
  package: '<包名>',
  descriptors: [ /* InvocationDescriptor[] */ ],
}
export default TYPERT_REMOTE
```

d.ts 侧（关键：模块增强 + 类型导入）：

```ts
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    '<namespace>/<method>': (...) => Promise<RemoteResult<T>>
    // ...
  }
  interface TypertRemoteNamespaceMap {
    '<namespace>': TypertRemoteNamespace$<hex>
    // ...
  }
}
export declare const TYPERT_REMOTE: TypertRemoteContribution
export default TYPERT_REMOTE
```

每个生成方法签名为 `(...) => Promise<RemoteResult<结果类型>>`（`emitter.ts` 的 `remoteFunctionType`）——客户端**永远**拿到 `Promise<RemoteResult<T>>`，不做 try/catch 解包。

### 1.7 生成 `typert.host.*`（宿主半）形态

`emitter.ts` 的 `renderJs`：导出 zod schema（`export const X$schema = ...`）+ `export const TYPERT = { package, face: 'host', schemas: [...], invocations: [...], model: {...} }`。宿主半由 `typert-loader`（`packages/typert/loader/src/index.ts`）读取：包导出 `./typert` 时动态 `import` 其 `TYPERT` 清单，校验后 `ctx.typert.register(manifest)`。

### 1.8 包被发现为 Typert 贡献者的条件（`analyzer.ts`）

- `loadRegistrations`：读取工作区根 `tsconfig.host.json`（及 `tsconfig.client.json`）的 project references，只认 `packages/` 下的包。
- `registrationHasSurface`：从包的公开导出入口（`packageExportTargets`，排除 `./typert`、`./remote`、`./client*`、`./package.json`、含 `*` 或 `.json` 的目标）出发做可达性遍历，命中下列任一即算“有 surface”：
  1. 带 `@typert` JSDoc 标签的 class/interface/type/enum；
  2. 类成员带 `@Remote` / `@RemoteScope` 装饰器，或 `typertRemote = bindTypertRemote(...)` 属性；
  3. `declare module '@deepseek-ai/cordis'` 中 `Context`/`Events` 的非空增强。

**关键推论（现状事实）**：`SandoreRemote` 必须从 `workflow/src/index.ts`（`. ` 导出目标回映射到的源入口）可被静态 import 链触达，generator 才会发现它；当前 `index.ts` 并未 re-export `remote.ts`。

### 1.9 `@Remote` / `TypertRemoteService` 用法（`packages/typert/protocol/src/index.ts`）

- `TypertRemoteService` 是抽象 `Service` 子类：`protected constructor(ctx, serviceKey, options?)` 内部 `super(ctx, serviceKey)` 并 `this.typertRemote = bindTypertRemote(this, this.name, options)`；`options.namespace` 可改写 wire 命名空间（默认 = serviceKey）。
- `@Remote('exportName')`（或裸 `@Remote` 用方法名）为公开实例方法打 direct 标记；`@RemoteScope(key, exportName?)` 用于 Context 作用域方法。
- sandore 的 `SandoreRemote` 已完全符合此用法（见第 5 节）。

---

## 2. api/remotes 客户端集中 `$mount`；ui-commands 如何 `ctx.remote.commands.*` 消费

### 2.1 `api/remotes`（`packages/api/remotes/src/client/index.ts`）

集中挂载的样板（这是 sandore ui 插件要仿照的形态）：

```ts
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import dynamicRemote from '@deepseek-ai/dsh-cordis-host-runner/remote'
import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'

// 类型侧：把生成模块增强并入本编译面
export type {} from '@deepseek-ai/dsh-commands/remote'
// ...

declare module '@deepseek-ai/cordis' {
  interface Context { remote: TypertClientRemote }
}

export const inject = ['remote']

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [commandsRemote, goalsRemote, dynamicRemote, messageFeedbackRemote]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  return async () => { for (const dispose of disposers.reverse()) await dispose() }
}
```

要点：每个 `<pkg>/remote` 做 **default import**（即 `TYPERT_REMOTE` 对象）；`export type {}` 把其 d.ts 模块增强带进消费面；`inject = ['remote']`；`apply` 依序 `$mount` 并收集 disposer，返回逆序展开的 disposer。

### 2.2 ui-commands 消费（`packages/client/ui-commands/src/client/`）

- `index.ts`：`export const inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands', 'locale']`——注意 `'remote.commands'` 是 `$mount` 后按命名空间注册的 cordis 服务键（见 4.3）。
- `service.ts`：`static inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands']`，通过 `ctx.remote.commands.*` 直接调用：
  - `await ctx.remote.commands.list(sessionId)`（`service.ts` 第 134 行）
  - `await ctx.remote.commands.execute(sessionId, line)`（第 374 行）
  - `ctx.remote.$on('commands/change', () => { ... })`（第 149 行）
  - `ctx.remote.$on('agent-preset/selected', (sessionId) => { ... })`（第 154 行）

---

## 3. `RemoteResult` 的确切类型与解包惯例

### 3.1 类型定义（`packages/typert/protocol/src/types.ts`）

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

- 生成方法统一返回 `Promise<RemoteResult<T>>`（见 1.6）。
- `RemoteFailure.code` 是开放 `string`（闭合 RPC code 联合属于 carrier 包，如 `api/gateway` 客户端内部用 `code: 'internal'`）。

### 3.2 解包惯例（`ui-commands/src/client/service.ts`）

```ts
const result = await ctx.remote.commands.list(sessionId)
if (!result.ok) throw new Error(`command.list failed: ${result.error.code}: ${result.error.message}`)
return result.value
```

以及可空结果：

```ts
const result = await this.ctx.remote.commands.execute(session.sessionId, line)
if (!result.ok) throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`)
if (result.value === undefined) return { kind: 'error', text: `unknown or malformed command: ${line}` }
```

即：`if (!result.ok) throw ...; result.value` 为通用解包法；业务上“可空成功值”通过 `result.value === undefined` 二次判断，而非走 error 分支。

---

## 4. `ctx.remote.$mount` / `$on` 契约与 disposer 生命周期

### 4.1 契约类型（`packages/typert/protocol/src/types.ts`）

```ts
export type TypertDisposer = () => Promise<void>

export interface TypertClientRemote extends TypertRemoteNamespaceMap {
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  $on<Event extends TypertRemoteEvent>(event: Event, listener: Events[Event]): () => void
  $dispatch(event: string, args: readonly unknown[]): void
}
```

`TypertRemoteContribution = { package: string; descriptors: readonly InvocationDescriptor[] }`（`./remote` 的 `TYPERT_REMOTE` 即此形状）。`ctx.remote` 上直接命名空间方法（`ctx.remote.sandore.*`）来自 `TypertClientRemote extends TypertRemoteNamespaceMap`，由生成 d.ts 的 `TypertRemoteNamespaceMap` 增强补上。

### 4.2 实现（`packages/api/gateway/src/client/index.ts`，`ClientRemoteService` 注册为 `'remote'` 服务）

- `$mount(contribution)`：
  1. `this.enqueue` 串行化 mutation；
  2. `callerCtx.typert.remotes.register(contribution)`（注册到 Typert 注册表的 remote store，重复包名报错）；
  3. 逐 descriptor `install()`：direct 方法经 `RemoteNamespaceService.installDirect` 在 `remote.<namespace>` 服务实例上用 `Object.defineProperty` 定义同名 getter，返回 `(...args) => Promise<RemoteResult<unknown>>`；最终经 `connection.rpc.call('/api', '<namespace>/<method>', { args }, signal)` 走到宿主。
  4. 返回的 disposer 逆序卸载各 installed + `disposeRemote()`；`$mount` 全程包在 `callerCtx.effect` 里，随调用方 fiber 生命周期自动清理。
- `$on(event, listener)`：同步返回 `() => void`；订阅表按事件名字符串索引，listener 签名从 Host 的 `Events[event]` 来（`$dispatch` 恢复实参）。返回值 disposer 内 `ctx.effect` 持有，随 fiber 清理。
- `$dispatch`：隔离监听器异常（同步 throw 或 Promise reject 都不外泄），快照本轮接收者。

### 4.3 命名空间即 cordis 服务

`remoteServiceKey(namespace) = 'remote.' + namespace`。`$mount` 首次见某命名空间时 `ownerCtx.plugin({ name: 'remote.<namespace>', apply: ctx => { service = new RemoteNamespaceService(ctx, name, invoke) } })` 启动一个 fiber，把命名空间注册成 cordis 服务（因此 `ui-commands` 可 `inject: ['remote.commands']`）。命名空间空时（无方法挂载）会 `disposeNamespace` 撤掉。

---

## 5. sandore 当前现状

### 5.1 `workflow/src/remote.ts`（`SandoreRemote`）

- 文件：`D:/project-code/llm/sandore/packages/sandore/workflow/src/remote.ts`
- `import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'`（`z` 来自 `zod`）。
- `export class SandoreRemote extends TypertRemoteService`，`static inject = ['sandorePersistence', 'sandoreEngine', 'llm']`，`constructor(ctx) { super(ctx, 'sandore') }`（wire 命名空间 `sandore`）。
- 27 个 `@Remote('name')` 方法（构成 `sandore.<method>` 端点）：
  1. `ping`（同步）
  2. `listDefinitions`、3. `createDefinition`、4. `updateDefinition`、5. `deleteDefinition`、6. `getYaml`、7. `updateYaml`
  8. `listJobs`、9. `createJob`、10. `getJob`、11. `updateJob`、12. `deleteJob`
  13. `listInstances`、14. `startInstance`、15. `deleteInstance`、16. `getInstanceState`、17. `abortInstance`
  18. `replyQuestion`、19. `replyPermission`、20. `pauseStep`、21. `resumeStep`、22. `pauseAll`、23. `resumeAll`、24. `retryStep`
  25. `getArtifacts`、26. `listProviders`、27. `listModels`
- 入参均用 zod schema（`CreateDefinitionInputSchema` 等 12 个）+ `z.infer` 导出类型；`export default SandoreRemote`。
- 现状事实：`remote.ts` **未**被 `workflow/src/index.ts` re-export（index.ts 只导出 `types/errors/schema/yaml-parser/shell/seam/dag-navigator` 与 `SandoreEngineRuntime`）；单元测试 `remote.spec.ts` 直接 `new SandoreRemote(ctx)` 自建 harness。

### 5.2 `workflow/package.json` 现状

- 包名 `@deepseek-ai/dsh-sandore-workflow`，`main: lib/index.js`，`types: lib/types/index.d.ts`。
- `exports` 只有 `.`、`./types`、`./src/*`、`./package.json`——**无 `./typert`、无 `./remote`**。
- `files` 只有 `lib/index.js`、`lib/types/**/*.js`、`lib/types/**/*.d.ts`——**无 typert 产物**。
- `scripts` 只有 `typecheck: tsc --noEmit`——**无 build/bundle 脚本**。
- peer/devDependencies 已含 `@deepseek-ai/dsh-typert-protocol: 0.1.0-rc.6`；但**无 `@deepseek-ai/dsh-typert-generator` 依赖**。
- 工作区 `D:/project-code/llm/sandore` 根 `package.json` devDependencies 含 `tsdown ^0.22.2`，但**无 `tsdown.config.ts`、无 `tsconfig.host.json`**（typert generator 的 `workspaceRoot` 依赖向上查找 `tsconfig.host.json` 定位工作区根）。
- `workflow/tsconfig.json`：`outDir: lib/types`、`rootDir: ..`、`include: ["src"]`（沿用 DSH 的 `lib/types` 布局）。

### 5.3 `ui` 包现状

- 包名 `@deepseek-ai/dsh-client-ui-sandore`（`packages/sandore/ui/package.json`），有 `dsh.client.inject`（runtime/locale/sidebar）、`exports["./client"]` → `lib/types/client/index.d.ts` + `lib/client.js`、`files` 含 `lib/index.js`/`lib/client.js`/`lib/types/**`；**无 `./remote` 相关**。
- `ui/src/index.ts`：宿主半 `export function apply(): void {}`（空）。
- `ui/src/client/index.ts`：当前 `inject = ['slots', 'locale']`；`apply(ctx)` 内手工构造 `host: HostCall` 桩，`sandore.ping` 返回字面量（`{ pong: true, service: 'sandore', time: ... }`），未知方法抛错；注释明示“生产链路接入 `ctx.remote` 的生成贡献后替换”。
- `ui/src/client/host.ts`：`HostCall`（`call(method, args?) => Promise<unknown>`）+ `PingResponse` + `isPingResponse` 守卫。

---

## 关键文件索引

- DSH 根 tsdown 配置：`D:/project-code/llm/deepseek-harness/tsdown.config.ts`
- DSH 宿主聚合 tsconfig：`D:/project-code/llm/deepseek-harness/tsconfig.host.json`
- typert generator：`D:/project-code/llm/deepseek-harness/packages/typert/generator/src/{tsdown-plugin,workspace,emitter,analyzer}.ts`
- typert protocol（`@Remote`/`TypertRemoteService`/`RemoteResult`/`TypertClientRemote`）：`D:/project-code/llm/deepseek-harness/packages/typert/protocol/src/{index,types}.ts`
- typert registry/loader：`D:/project-code/llm/deepseek-harness/packages/typert/{registry,loader}/src/`
- 集中 `$mount`：`D:/project-code/llm/deepseek-harness/packages/api/remotes/src/client/index.ts`
- `$mount`/`$on` 实现：`D:/project-code/llm/deepseek-harness/packages/api/gateway/src/client/index.ts`
- 消费方：`D:/project-code/llm/deepseek-harness/packages/client/ui-commands/src/client/{index,service}.ts`
- sandore workflow：`D:/project-code/llm/sandore/packages/sandore/workflow/{package.json,src/remote.ts,src/index.ts}`
- sandore ui：`D:/project-code/llm/sandore/packages/sandore/ui/{package.json,src/client/index.ts,src/client/host.ts,src/index.ts}`
