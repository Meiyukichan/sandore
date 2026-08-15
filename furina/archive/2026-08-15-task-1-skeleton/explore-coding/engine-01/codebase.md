## Exploration Result

`furina config show project.sourcecode codebases` 返回的 codebases 列表为 `docs/codebase`（`project.sourcecode=src/`）。该目录在 sandore 仓库中为空（`docs/codebase` 下无任何文件），因此 Phase 3（furina-codebase 迭代探索）无结果。sandore 仓库当前为 greenfield：根目录无 `package.json`、`packages/` 目录为空，仅存在 `docs/` 与 `furina/`。故下述范式全部来自 Phase 4 的补充探索（DSH 参考源码 `D:\project-code\llm\deepseek-harness`，只读参考）。

## Supplementary Exploration Result

> 探索目标：为 sandore 工作流引擎 DSH 插件骨架 Host 后端（根 pnpm monorepo 工作区 + `packages/sandore/workflow` 包 Service seam / 13 事件双声明 / 13 类型 / Provider 桩 + `TypertRemoteService` RPC + `microflow`/`tool` 空占位）所需的 DSH 参考实现范式。以下每一条均直接对应 work.md / design.md 中引用的 DSH 源码文件，给出实际代码位置与范式结论。

---

### 1. Service Definition 范式（抽象 seam）

**权威参考文件**：`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`

这是 design.md §5.1 明确要求「仿照」的文件，其完整结构如下（已核实，行号对应）：

- L7：`import { Context, Service } from '@deepseek-ai/cordis'` —— `Service`、`Context` 都从 `@deepseek-ai/cordis` 包根导出。
- L31–91：`declare module '@deepseek-ai/cordis'` 内声明两件套：
  - `interface Context { workflowEngine: WorkflowEngine }`（把服务挂在 `ctx.<key>`）
  - `interface Events { 'workflow/start'(info: WorkflowRunInfo): void; ... }`（Cordis 事件签名，首参是身份快照 info，后续参数可选）
- L157–187：`export abstract class WorkflowEngine extends Service`，构造函数固定为 `super(ctx, 'workflowEngine')`，然后声明 `abstract` 方法。
- L203：`export default WorkflowEngine`（默认导出抽象类本身）。

**关键机制（来自 vendored Cordis）**：`D:\project-code\llm\deepseek-harness\vendor\cordis\src\service.ts`
- L11–59：`Service` 基类的构造函数 `constructor(protected ctx: Context, name: string)` 内部执行 `self.ctx.reflect.provide(name, self, ...)`，即 `super(ctx, '<key>')` 这一行就把实例注册为 `ctx.<key>`，无需再手动 `provide`。
- L13：`static readonly init: unique symbol = symbols.init` —— 类插件用 `protected async [Service.init](): Promise<void>` 声明构造完成后的异步初始化（见 workspace 包用法，下文 §5）。
- L104–114：`static [Symbol.hasInstance]` 让 `extends Service` 的类作为插件形态被 Loader 识别（类插件，含 `static inject` / `static Config`）。

**对应 sandore**：`SandoreEngine extends Service` + `constructor(ctx) { super(ctx, 'sandoreEngine') }` + 11 个 `abstract` 方法 + `declare module '@deepseek-ai/cordis'` 的 `Context`/`Events` 合并 —— 完全对齐本范式。

**类型文件拆分约定**：`workflow` 包把「浏览器安全持久化词汇」放 `src/types.ts`，把「Host-only 请求/运行句柄」放 `src/runtime-types.ts`（L14 注释：browser-safe durable vocabulary 与 host-only 分开，Client 程序不 import Agent/host Cordis 声明）。这正是 design.md §4.3 中 `types.ts` + `runtime-types.ts` 拆分、以及 §5.3 中 `DagRun/DagStartRequest` 放 runtime 侧的依据。

---

### 2. Session 事件范式（`session.append` + `SessionEventMap` 声明合并）

**权威参考文件**：
- append 调用范式：`D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\index.ts`
- 声明合并范式：`D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\types.ts`

**声明合并（types.ts L41–64）**：包通过 `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'tool-workflow/run-start': ToolWorkflowRunStartData; ... } }` 把自有事件类型合并进全局 `SessionEventMap`。事件名带 `/` 前缀（如 `tool-workflow/run-start`），data 载荷是纯数据接口（`readonly` 字段）。

**类型基础（core/session）**：
- `D:\project-code\llm\deepseek-harness\packages\core\session\src\types.ts` L336：`export type SessionEventType = keyof SessionEventMap` —— 即合并进 `SessionEventMap` 即自动扩展可 append 的事件名集合。
- L236：`SessionEventMap` 是 interface，默认含 `'turn/start'`、`'user/message'` 等内建事件。

**append 签名（core/session/src/index.ts L604–608）**：
```ts
append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: ...): SessionEvent<T>
```
`data` 类型由 `SessionEventMap[T]` 决定，所以只要声明合并了 `SessionEventMap`，`session.append('sandore/...', data)` 即获得强类型载荷。

**append 调用范式（tool-workflow/src/index.ts L75–93）**：`createWorkflowRecorder` 中把 `session.append` bind 后按窄化泛型调用（`appendRecord(type, data)`），并在 `ctx.on('workflow/agent-start', ...)` 回调里把 Cordis 事件映射为 `session.append('tool-workflow/agent-start', data)` —— 这正是「Session 事件是必需、Cordis Events 只是可选触发源」的双轨做法：引擎内部 `ctx.emit`/`ctx.on`（Cordis），对外面板/apiproxy 透传走 `session.append`。

**对应 sandore**：work.md 明确 `sandore/*` 是 Session 事件（`session.append('sandore/…', data)` + `declare module '@deepseek-ai/dsh-session/types'` 合并 `SessionEventMap`），纯数据载荷；Cordis `Events` 声明是可选触发源、不能替代 Session 事件。13 个事件需两套声明（Cordis `Events` 首参 `info: DagRunInfo`；Session `SessionEventMap` 纯数据载荷），与本节范式一致。

---

### 3. RPC 范式（`TypertRemoteService` + `@Remote`）

**权威参考文件（生产范式，design.md 要求用的正是这个）**：
- 协议定义：`D:\project-code\llm\deepseek-harness\packages\typert\protocol\src\index.ts`
- 最小服务范例：`D:\project-code\llm\deepseek-harness\packages\host\plugin-inventory\src\index.ts`
- 带 schemastery Config 的服务范例：`D:\project-code\llm\deepseek-harness\packages\goal\goal\src\index.ts`

**协议层关键事实（typert/protocol/src/index.ts）**：
- L147–161：`export abstract class TypertRemoteService<out T = never> extends Service<T>`，构造函数 `protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions)` 内部 `super(ctx, serviceKey)` 后调用 `bindTypertRemote(this, this.name, options)`；**wire namespace 默认等于 Cordis service key**（L141 `const namespace = options.namespace ?? serviceKey`）。
- L168–196：`Remote` 是方法装饰器，两种形式：`@Remote('exportName')`（带导出名，导出名必须是单个 endpoint 段，不能含 namespace/斜杠，L10/L183 校验正则 `^[A-Za-z0-9_$.-]+$`）或裸 `@Remote`（用方法名）。
- 端点命名规则：`namespace.methodName`（namespace = serviceKey）。因此 sandore 的 `class SandoreRemote extends TypertRemoteService` + `super(ctx, 'sandore')` + `@Remote('ping')` 产生端点 `sandore.ping`，与 design.md 完全一致。

**最小服务范例（plugin-inventory/src/index.ts，最贴近 sandore.ping 的骨架）**：
```ts
import type { Context, FiberState } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']
  constructor(ctx: Context) { super(ctx, 'pluginInventory') }

  @Remote('list')
  list(): PluginInventorySnapshot { ... }
}
export default PluginInventoryGateway
```

**带 Config 的服务范例（goal/goal/src/index.ts）**：
- L183：`export class GoalService extends TypertRemoteService`
- L184：`static inject = ['agents']`
- L186–188：`static Config: z<Config> = z.object({ defaultMaxGoalRounds: z.number().default(256) })`
- L193：`constructor(ctx: Context, config: Config = {}) { super(ctx, 'goals') ... }`
- L276/298/310/336/376/585：`@Remote('edit')` / `@Remote('pause')` / `@Remote('resume')` / `@Remote('complete')` / `@Remote('clear')` / `@Remote('create')` —— 每个公开方法用 `@Remote('<name>')` 标记为远端端点。
- L592：`export default GoalService`

**`harness.handle` 仅为动态原型捷径（不进 Task 1 产出）**：`D:\project-code\llm\deepseek-harness\packages\extensions\cordis-host-runner\src\index.ts` L888–899 —— 动态 Cordis 插件（`cordis_define`/`cordis_run`）的 Host 代码沙箱注入一个 `handle(method, fn)` 函数（`createSandbox(plugin.pluginId, { handle })`），把 handler 注册进 `run.handlers` Map，再由 L740–766 的 `@Remote('invoke') invoke(...)` 按 `method` 字符串分发。这是 vm 沙箱里的原型验证捷径，不是生产 RPC；生产 RPC 是上文 `TypertRemoteService + @Remote`。

---

### 4. schemastery Config 范式（`static Config` + `static inject`）

**权威参考文件**：`D:\project-code\llm\deepseek-harness\packages\goal\goal\src\index.ts`、`D:\project-code\llm\deepseek-harness\packages\workflow\tool-workflow\src\index.ts`、`D:\project-code\llm\deepseek-harness\packages\workspace\workspace\src\index.ts`

- 导入统一为 `import z from '@deepseek-ai/schemastery'`（不是 named import，也不是 zod 的 `import { z }`；DSH 中 zod 用 `import { z } from 'zod'` 区分，如 goal L10、workspace spec.ts L8）。
- 类插件配置形态（goal L184–188）：
  ```ts
  export interface Config { defaultMaxGoalRounds?: number }
  export class GoalService extends TypertRemoteService {
    static inject = ['agents']
    static Config: z<Config> = z.object({ defaultMaxGoalRounds: z.number().default(256) })
    constructor(ctx: Context, config: Config = {}) { super(ctx, 'goals') ... }
  }
  ```
- 函数插件（非类）配置形态（tool-workflow L33–43、L205）：顶层 `export interface Config` + `export const Config: z<Config> = z.object({...})` + `export function apply(ctx, config: Config)`，且 `apply` 内直接解构 `config`（schemastery 已填好 default）。tool-workflow 的 `static` 无关，但说明「`Config` 作为 schemastery schema 导出」是包级惯例（plugin `Config` 用 schemastery；domain 内 record schema 用 zod —— 见 storage-domain/src/index.ts L5–6 注释）。
- `static inject` 是**字符串数组**：`['storageDomain', 'sessionPersistence']`（workspace L93）、`['agents']`（goal L184）、`['loader']`（plugin-inventory L44）、`['tools', 'workflowEngine', 'systemPrompt']`（tool-workflow L30）。可选软依赖用 `ctx.get('name')`（design.md §7.3 备注 `ctx.subprocess`/`ctx.sandbox` 走软依赖）。

**对应 sandore**：Provider 桩 `export default class SandoreEngineStub extends SandoreEngine`，`static Config: z<Config>`（schemastery，无 permissionMode 字段）+ `static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`，完全对齐 goal/workspace 类插件形态。

---

### 5. `ctx.storageDomain.open(spec)` 范式（持久化域，Task 1 仅约定背景）

**权威参考文件**：
- 消费方：`D:\project-code\llm\deepseek-harness\packages\workspace\workspace\src\index.ts` + `src\spec.ts`
- 实现方：`D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\index.ts`

- `storage-domain/src/index.ts` L29–39：通过 `declare module '@deepseek-ai/cordis' { interface Context { storageDomain: DomainFacility } }` 挂载 `ctx.storageDomain`；L100 `async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>`。
- 域声明（workspace/spec.ts L67–75）：
  ```ts
  export const workspaceDomainSpec = defineDomain({
    name: 'workspace',
    version: 2,
    global: { schema: workspaceDomainState, initial: { initialized: false, ... } },
    tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
  })
  ```
  其中 `workspaceRecord`/`workspaceDomainState` 用 **zod**（`import { z } from 'zod'`）定义，`defineDomain`/`domainTable` 从 `@deepseek-ai/dsh-storage-domain` 导入。
- 打开与生命周期（workspace/index.ts L118–124）：
  ```ts
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()
  }
  ```
  调用方持有 domain 句柄并通过 `ctx.effect` 注册 `domain.close()` 清理；`domain.table(name)` 取 KV 表、`domain.global` 取全局单例。

**对应 sandore**：D4 决策的 `definitions`/`jobs`/`state` 三表（`sandore` 域）后续即按 `defineDomain` + `ctx.storageDomain.open(spec)` 实现；Task 1 不实现，仅类型/约定背景。

---

### 6. package.json 约定

**Host 包范例**：`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\package.json`
**Client 包范例**：`D:\project-code\llm\deepseek-harness\packages\extensions\ui-cordis\package.json`

通用字段（Host 包）：
- `"name": "@deepseek-ai/dsh-workflow"`、`"version": "0.1.0-rc.5"`、`"publishConfig": { "access": "public" }`、`"license": "MIT"`、`"repository": { "directory": "packages/workflow/workflow" }`。
- **ESM 全量**：`"type": "module"`。
- 构建产物约定：`"main": "lib/index.js"`、`"types": "lib/types/index.d.ts"`。
- `exports` 映射：`.`（types + default）、`./types`、`./invariant`、`./src/*`、`./package.json`。
- `peerDependencies`（在 DSH 仓库内用 `"workspace:^"`；**sandore 各包改为 npm 版本 `0.1.0-rc.5`**，见 work.md「依赖来源」）。workflow 包 peer 依赖含 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent` 等，与 design.md §4.2 一致。
- `devDependencies` 与 peerDependencies 同名成对出现（DSH 惯例：dev 里也写一份 workspace:^，供本地编译）。

Client 包额外字段（ui-cordis/package.json）：
- `exports["./client"]`（types → `lib/types/client/index.d.ts`，default → `lib/client.js`）。
- 顶层 `"dsh": { "client": { "inject": [...], "platform": "web" } }` 声明 Client 半（design.md §3.2 提到的 `dsh.client`）。
- `scripts.bundle: "tsdown"`（用 tsdown 打包）。
- peerDependencies 额外含 `react: "^18.2.0"`、`@deepseek-ai/dsh-client-ui-primitives` 等前端包。

**对应 sandore**：`workflow`/`microflow`/`tool` 包为 Host-only（无 `dsh.client`），`ui` 包声明 `dsh.client` + `exports["./client"]`。

---

### 7. tsconfig 约定

**根 base**：`D:\project-code\llm\deepseek-harness\tsconfig.base.json`（compilerOptions，L5–27）：
- `target: es2024`、`module: esnext`、`moduleResolution: bundler`、`declaration: true`、`composite: true`、`skipLibCheck: true`、`esModuleInterop: true`
- 关键 TS 扩展能力：`allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true`（源码内 `.ts` 后缀导入，如 `import ... from './types.ts'`）、`verbatimModuleSyntax: false`
- 严格项：`strict: true`、`noUncheckedIndexedAccess: true`、`exactOptionalPropertyTypes: true`、`noImplicitOverride: true`、`noUnusedLocals`/`noUnusedParameters: true`、`types: ["node"]`
- `paths` 把所有 `@deepseek-ai/*` 映射到源码（DSH 仓库内用；sandore 外部仓库不需要这些 paths，peer 依赖从 npm 解析）。
- 注意：该文件注释（L2–4）强调「NEVER add include/files to this file」——base 只放 compilerOptions/paths。

**包级 tsconfig**（`packages/workflow/workflow/tsconfig.json`、`packages/workflow/tool-workflow/tsconfig.json`）：
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [ { "path": "../../../vendor/cordis" }, ... ]
}
```
- 每个包 `extends` 根 base，`rootDir: src`、`outDir: lib/types`（类型输出到 `lib/types`，与 package.json 的 `"types": "lib/types/index.d.ts"` 对应）。
- 用 TS project references 声明跨包依赖。
- Client 包 extends `tsconfig.base.client.json`（ui-cordis/tsconfig.json L2）。

**对应 sandore**：design.md §4.2 要求根 `tsconfig.base.json` 供各包 extends，compilerOptions 可参照上表（strict、moduleResolution、declaration 等）；sandore 是外部仓库，不需要 DSH 的 `paths` 映射，用 npm peer 依赖 + `moduleResolution: bundler` 即可。

---

### 8. 根 monorepo 工作区约定

**权威参考文件**：`D:\project-code\llm\deepseek-harness\package.json`、`D:\project-code\llm\deepseek-harness\pnpm-workspace.yaml`

- 根 package.json：`"private": true`、`"type": "module"`、`"packageManager": "pnpm@11.7.0"`、`"engines": { "node": "^22.19.0 || >=24.0.0" }`。
- 脚本与 devDependencies 参照：DSH 根 `typecheck` 实际是 `tsc -b` 组合（L27–29 `"typecheck": "npm run build:lib:host && ..."`，底层 `tsc -b tsconfig.host.json`）；devDependencies 含 `tsdown`（`^0.22.2`）、`tsx`（`^4.22.4`）、`typescript`（`^6.0.3`）。design.md §4.2 要求 sandore 根 devDependencies 为 `typescript`/`tsdown`/`tsx`，与此一致。
- pnpm-workspace.yaml：`packages:` 列表式声明（`vendor/*`、`packages/*/*` 等），另有 `linkWorkspacePackages: true`、`overrides`（DSH 把 `@deepseek-ai/schemastery`、`@deepseek-ai/cosmokit` override 为 `link:vendor/...`）。**sandore 用 `packages: ['packages/sandore/*']`，无 overrides（不 vendored，schemastery/cordis 走 npm peer）**。

---

### 9. 其余类型/导入事实（供 13 类型与事件载荷对齐）

- `ContentBlock` 来自 `@deepseek-ai/dsh-llm`，type-only 导入：`import type { ContentBlock } from '@deepseek-ai/dsh-llm'`（tool-workflow/src/index.ts L17）。DSH 先例：`dsh-workflow` 事件里 `output: ContentBlock[]` 属同类（design.md 明确 `step-completed` 载荷用 `output: ContentBlock[]`）。
- `SessionId` 来自 `@deepseek-ai/dsh-session/types`（`import type { SessionId } from '@deepseek-ai/dsh-session/types'`，workflow/types.ts L10、tool-workflow/types.ts L8）。
- Cordis 事件订阅用 `ctx.on('workflow/agent-start', (info, agent) => ...)`（tool-workflow L95），事件签名与 `Events` 声明一致（首参 + 后续参数）。
- 服务/事件可跨包通过 `declare module '@deepseek-ai/cordis'` 与 `declare module '@deepseek-ai/dsh-session/types'` 做声明合并，消费方用 `import type {} from '<pkg>'` 触发合并（tool-workflow L27 对 `@deepseek-ai/dsh-system-prompt` 的注释即此惯例）。
