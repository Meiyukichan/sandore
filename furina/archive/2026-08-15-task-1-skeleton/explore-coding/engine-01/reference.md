## Exploration Result

> 参考源：DSH 源码仓库 `D:\project-code\llm\deepseek-harness`（仅阅读参考，不改源码）。
> 本结果严格对应 exploreContent 列出的 5 类参考范式，均基于实际代码，未做推断。

---

### 1. Service Definition 范式（`extends Service` + `super(ctx,key)` + `declare module '@deepseek-ai/cordis'` 合并 Context/Events + emitWorkflowEvent）

**参考文件**：`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`

DSH 的 workflow capability seam 是 sandore `SandoreEngine` 抽象 seam 的最直接范本。关键结构：

**（1）导入**
```typescript
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { WorkflowRunInfo, ... } from './types.ts'
import type { WorkflowRun, WorkflowStartRequest } from './runtime-types.ts'
```

**（2）Cordis 声明合并**——用 `declare module '@deepseek-ai/cordis'` 同时合并两处：
- `interface Context { workflowEngine: WorkflowEngine }` —— 注册 `ctx.<key>`；
- `interface Events { 'workflow/start'(info: WorkflowRunInfo): void; ... }` —— 每个事件首参固定为 `info: WorkflowRunInfo`（身份快照），后续参数按事件追加（如 `'workflow/phase'(info, title)`、`'workflow/agent-start'(info, agent)`）。每个事件带 `@mode emit` JSDoc 标注。

**（3）抽象 Service 类**
```typescript
export abstract class WorkflowEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflowEngine')   // key 与 Context 合并的字段名一致
  }
  abstract start(request: WorkflowStartRequest): WorkflowRun
  // ...
  protected emitWorkflowEvent(name: WorkflowEventName, ...args: unknown[]): void { ... }
}
export default WorkflowEngine
```
- `WorkflowEventName` 是 `'workflow/start' | 'workflow/phase' | ...` 的联合类型。
- `emitWorkflowEvent` 内部通过 `this.ctx.events.dispatch('emit', [name, ...args])` 迭代回调，并对每个 listener 用 try/catch + `this.ctx.logger.warn` 做错误隔离（listener 失败不抛散）。
- 文件末尾 `export default WorkflowEngine`。

**（4）类型文件拆分**（对应 sandore 的 `types.ts` / `runtime-types.ts`）：
- `packages/workflow/workflow/src/types.ts` —— 纯类型 + id-brand 工厂（`export type WorkflowRunId = Branded<'WorkflowRunId'>` + `WorkflowRunId(id)` 工厂函数）。事件载荷类型（`WorkflowRunInfo`、`WorkflowAgentInfo`、`WorkflowResultInfo` 等）都在此。仅 `import type`，无运行时依赖。
- `packages/workflow/workflow/src/runtime-types.ts` —— Host-only 请求/活柄类型（`WorkflowStartRequest`、`WorkflowRun`），注释明确「browser-safe 词汇留在 `./types`」。

> sandore 对应：`SandoreEngine extends Service` + `super(ctx, 'sandoreEngine')`；`declare module '@deepseek-ai/cordis'` 合并 `Context.sandoreEngine` 与 13 个 `sandore/*` Cordis `Events`（首参 `info: DagRunInfo`）。

---

### 2. Session 事件范式（`session.append` + `declare module '@deepseek-ai/dsh-session/types'` 合并 SessionEventMap）

**参考文件**：
- `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\types.ts`（声明合并）
- `D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\index.ts`（append 调用）

**（1）SessionEventMap 声明合并**（`tool-workflow/src/types.ts`）：
```typescript
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// ... 定义各事件 data 接口（readonly 字段）...

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'tool-workflow/run-start': ToolWorkflowRunStartData
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    'tool-workflow/run-end': ToolWorkflowRunEndData
  }
}
```
- 事件名用 `namespace/event` 前缀形式；data 为纯数据接口（`readonly` 字段）。
- 注意：`SessionEventMap` 的合并目标模块是 `'@deepseek-ai/dsh-session/types'`（不是 `'@deepseek-ai/dsh-session'`）。

**（2）`session.append` 调用**（`tool-workflow/src/index.ts` 的 `createWorkflowRecorder`）：
```typescript
import type { JsonValue, Session, SessionEventMap } from '@deepseek-ai/dsh-session'

const append = <Type extends keyof ToolWorkflowRecordEventMap>(
  session: Session, type: Type, data: SessionEventMap[Type],
): boolean => {
  const appendRecord = session.append.bind(session) as <Event extends keyof ToolWorkflowRecordEventMap>(
    event: Event, value: SessionEventMap[Event],
  ) => void
  try {
    appendRecord(type, data)
    return true
  } catch (error) { ctx.logger.warn(...); return false }
}
```
- 引擎 Cordis 事件 → Session 事件的桥接用 `ctx.on('workflow/agent-start', (info, agent) => { ... append(session, 'tool-workflow/agent-start', data) })`。
- 这些包自有事件都是 **log-only**（非 surface 事件），所以 `append` 不传 `SurfaceIntent` 第三个参数。

**（3）`Session.append` 签名**（`D:\project-code\llm\deepseek-harness\packages\core\session\src\index.ts`）：
```typescript
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
): SessionEvent<T>
```
- `SessionEventType = keyof SessionEventMap`（可合并扩展）。
- log-only 事件（非 `user/message` / `assistant/message` / `tool/result`）无需第三个参数。
- data 必须 JSON-serializable（运行时 `snapshotJsonValue` 校验，非 JSON 直接 throw）。

**（4）基础 `SessionEventMap`**（`D:\project-code\llm\deepseek-harness\packages\core\session\src\types.ts`）：`export interface SessionEventMap { ... }`，声明为「merge-extensible」接口，插件通过上述 `declare module` 扩展。

> sandore 对应：`sandore/*` 13 个 Session 事件，用 `session.append('sandore/…', data)` + `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { ... } }` 声明纯数据载荷（必需）；Cordis `Events` 声明仅作引擎内部可选触发源。

---

### 3. RPC 范式（`extends TypertRemoteService` + `super(ctx,'namespace')` + `@Remote('method')`）

**参考文件**：
- `D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts`（生产 RPC Service）
- `D:\project-code\llm\deepseek-harness\packages\typert\protocol\src\index.ts` 与 `src\types.ts`（协议）

**（1）生产 RPC Service**（`message-feedback/src/index.ts`）：
```typescript
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']
  static Config: s<Config> = s.object({ maxNoteBytes: s.number().step(1).min(1).required() })

  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')   // 第二参 = service key + 默认 wire namespace
    this.maxNoteBytes = resolveMaxNoteBytes(config.maxNoteBytes)
  }

  @Remote('list')
  async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> { ... }

  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> { ... }

  @Remote('delete')
  delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult> { ... }
}
export default MessageFeedbackService
```
- `@Remote('method')` 装饰公开实例方法；方法名与导出名可不同（`@Remote('list')` 导出名为 `list`）。
- 该类同时做了 `declare module '@deepseek-ai/cordis' { interface Context { messageFeedback: MessageFeedbackService } }`（在 index.ts 顶部）。

**（2）`TypertRemoteService` / `Remote` 协议**（`typert/protocol/src/index.ts`）：
```typescript
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  readonly typertRemote: TypertGatewayBinding<this>
  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}
```
- `bindTypertRemote(service, serviceKey, options)` 返回 `{ service, serviceKey, namespace }`，`namespace` 默认等于 `serviceKey`，也可用 `options.namespace` 覆盖。
- `Remote` 装饰器：`@Remote('ping')` → 记录 `exportName`；裸 `@Remote` → 用方法名。用 `isTypertRemoteSegment`（正则 `^[A-Za-z0-9_$.-]+$`，且非 `'.'`/`'..'`）校验导出名/namespace 字符。
- 端点解析：`typert/protocol/src/types.ts` 中 `TypertLocalRegistry.get(endpoint)` 注释「Look up one invocation by `<namespace>/<method>`」；`TypertRemoteNamespace<Namespace>` 类型按 `` Endpoint extends `${Namespace}/${infer Method}` `` 拆分。即 **DSH 协议层 wire 端点文法为 `<namespace>/<method>`（斜杠）**。

> 事实性观察（不评判对错）：design.md 写的是 `super(ctx,'sandore') + @Remote('ping') → 端点 sandore.ping`（点号）。DSH 实际协议的类型级端点映射（`TypertRemoteNamespace` / `TypertLocalRegistry.get`）用 `namespace/method`（斜杠）拆分；`Remote` 导出名与 namespace 均允许点号/横杠字符（segment 正则 `[A-Za-z0-9_$.-]`）。sandore 实现 `remote.ts` 时需以 DSH 实际机制（`super(ctx,'sandore')` 定 namespace，`@Remote('ping')` 定 method）为准。

**（3）其他协议要点**（`typert/protocol/src/types.ts`）：
- `RemoteResult<T> = { ok:true; value:T } | { ok:false; error:RemoteFailure }`（`RemoteFailure = { code, message, details }`）。
- `InvocationDescriptor` 含 `service`（Cordis key）、`namespace`、`method`、`parameters`、`result` codec 等，供生成器产出 client 侧调用。
- 协议包 `declare module '@deepseek-ai/cordis' { interface Context { typert: TypertRegistryContract } }`。

---

### 4. schemastery Config / static inject 范式

**参考文件**：
- `message-feedback/src/index.ts`（类插件 + `static Config` + `static inject`）
- `tool-workflow/src/index.ts`（函数插件 + `export const Config` + `export const inject`）

**（1）类插件（Service 子类）形式**（message-feedback）：
```typescript
import s from '@deepseek-ai/schemastery'

export interface Config { readonly maxNoteBytes: number }

export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']
  static Config: s<Config> = s.object({
    maxNoteBytes: s.number().step(1).min(1).required(),
  })
  constructor(ctx: Context, config: Config) { ... }   // config 为第二构造参数
  protected async [Service.init](): Promise<void> { ... }  // 异步 init 生命周期（如 storageDomain.open）
}
```
- `s<Config>` 是 schemastery 的泛型类型标注；`s.object({...})` 定义运行时 schema。
- `static inject = [...]` 声明 Cordis 依赖注入的 service key 数组。
- `Service.init`（symbol）作为异步初始化钩子。

**（2）函数插件形式**（tool-workflow，供对照）：
```typescript
import z from '@deepseek-ai/schemastery'

export const inject = ['tools', 'workflowEngine', 'systemPrompt']
export interface Config { toolName?: string; maxResultChars?: number }
export const Config: z<Config> = z.object({
  toolName: z.string().default('workflow'),
  maxResultChars: z.natural().min(1).default(50_000),
})
export function apply(ctx: Context, config: Config): void { ... }
```
- schemastery 可 `import s from ...` 或 `import z from ...`（同一默认导出）。
- 常用方法：`s.string()`、`s.number()`、`s.natural()`、`.default()`、`.min()`、`.step(1)`、`.required()`。

> sandore 对应：`workflow` 包 Provider 桩 `static Config` 用 schemastery；`inject` 声明 `sessions/sessionPersistence/subagents/llm/shell/fs/storageDomain` 等（design.md §7.3）。

---

### 5. package.json / tsconfig 约定（ESM、peerDependencies、tsdown build、DSH tsconfig 基座）

**参考文件**：
- `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\package.json`
- `D:\project-code\llm\deepseek-harness\packages\typert\protocol\package.json`
- `D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\package.json`
- `D:\project-code\llm\deepseek-harness\package.json`（根）
- `D:\project-code\llm\deepseek-harness\tsconfig.base.json`
- `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\tsconfig.json`
- `D:\project-code\llm\deepseek-harness\tsdown.config.ts`

**（1）单包 package.json 约定**（以 `@deepseek-ai/dsh-workflow` 为例）：
```json
{
  "name": "@deepseek-ai/dsh-workflow",
  "version": "0.1.0-rc.5",
  "publishConfig": { "access": "public" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.js", "lib/types/**/*.d.ts"],
  "peerDependencies": { "@deepseek-ai/cordis": "workspace:^", "@deepseek-ai/dsh-llm": "workspace:^", "@deepseek-ai/dsh-session": "workspace:^", ... },
  "devDependencies": { /* 镜像 peerDependencies 供内部开发 */ }
}
```
- **ESM 全量**：`"type": "module"`。
- `main`/`types` 指向 `lib`；`exports` 提供 `types`（`.d.ts`）+ `default`（`.js`）双条件，并暴露 `./types`、`./src/*`、`./package.json` 子路径。
- **peerDependencies** 声明宿主供给的 `@deepseek-ai/*` / `@deepseek-ai/cordis`（DSH 仓库内部用 `workspace:^` 协议；sandore 按 design.md 改为 npm 版本 `0.1.0-rc.5`）。
- `@deepseek-ai/schemastery` 作为**普通 `dependencies`**（非 peer）出现（见 message-feedback 的 `dependencies: { "@deepseek-ai/schemastery": "workspace:^", "zod": "^4.4.3" }`）。

**（2）根 package.json 约定**（DSH 根）：
- `private: true`、`type: module`、`packageManager: pnpm@11.7.0`、`engines.node: "^22.19.0 || >=24.0.0"`、`workspaces: ["vendor/*", "packages/*/*", ...]`。
- 构建脚本核心：`build:lib:host: tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host`；`build:lib:client: tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client`。
- 根 devDependencies：`typescript ^6.0.3`、`tsdown ^0.22.2`、`tsx ^4.22.4`（与 design.md 对 sandore 根 devDeps 的描述一致）。

**（3）tsconfig.base.json 基座**（DSH 根，各包 extends）：
```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "esnext",
    "moduleResolution": "bundler",
    "declaration": true,
    "sourceMap": true,
    "declarationMap": true,
    "composite": true,
    "incremental": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "verbatimModuleSyntax": false,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["node"]
  }
}
```
- 用 `paths` 把 `@deepseek-ai/*` 映射到各包 `src`（项目引用 + 源码级解析）；注释明确「NEVER add include/files to this file」。

**（4）单包 tsconfig 约定**（`packages/workflow/workflow/tsconfig.json`）：
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [ /* 项目引用 */ ]
}
```
- 每个包 extends 根 base；`rootDir: src`、`outDir: lib/types`（先 tsc 产出类型到 `lib/types`）。

**（5）tsdown 构建约定**（`tsdown.config.ts`）：
- `format: ['esm']`、`platform: 'node'`、`target: 'es2024'`、`dts: false`、`clean: false`；workspace 为 `['vendor/*', 'packages/*/*', 'apps/cli']`。
- host 面 entry `['lib/types/{index,invariant,startup}.js']`（tsc 产出后由 tsdown 再打包到 `lib`），并挂 `typertPlugin({ mode:'workspace', faces:['host'] })` 生成 RPC 产物。
- 命名约定：`@deepseek-ai/dsh-<name>`，包按 `packages/<group>/<pkg>/` 布局。

---

## Supplementary Exploration Result

补充探索配置：`experimental.websearch=true`、`experimental.context7=true`。

Phase 3 已从 DSH 源码（`D:\project-code\llm\deepseek-harness`）直接取得全部 5 类参考范式的充分且可用的实际代码依据，信息未出现空泛或不足，因此**未触发** websearch / context7 补充探索。
