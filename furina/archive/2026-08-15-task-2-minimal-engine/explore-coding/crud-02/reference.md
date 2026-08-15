## Exploration Result

> 探索类型：reference。`furina config show exploration.reference` 返回空数组 `[]`，无显式配置的参考材料清单；但 exploreContent 本身点名了本地参考源（`docs/design/task-2-minimal-engine/work.md`、DSH 源码 `D:\project-code\llm\deepseek-harness` 中 WorkspaceRegistry 的 storageDomain open/close 范式、message-feedback 的 @Remote CRUD 范式、KvTable 接口 entries/put/delete/update 精确签名、以及 sandore 项目内 `specs/engine-crud/spec.md` 的权威验收规格）。以下为对这些点名参考源的实际探索结果。

---

### 0. 需求理解（Phase 2）

- **What**：为 sandore DAG 工作流引擎 DSH 插件的 Task 2 第二步「crud-02（定义/Job/实例 CRUD + 存储域持久化 + Host RPC）」落地参考依据——新增 `packages/sandore/workflow/src/persistence.ts`（`SandorePersistence`，`ctx.storageDomain.open(sandoreDomainSpec)` 打开 sandore 域三表 + `Domain.close()` 释放 + 三表 `KvTable` 句柄 + `saveWorkflowState`）并扩展 `packages/sandore/workflow/src/remote.ts`（`SandoreRemote`，`TypertRemoteService` + `@Remote` 装饰器实现定义 CRUD / Job CRUD / 实例生命周期 / getArtifacts / listProviders / listModels，保留 `ping`）。
- **Boundaries**：范围锁定在「DSH 参考实现范式」+「sandore 权威规格」两个层面——storageDomain 域打开/关闭生命周期、`[Service.init]` 生命周期、`KvTable`/`Domain` 精确接口、`TypertRemoteService`/`@Remote` 装饰器精确用法、sandore 既有 Task 1 骨架（schema.ts / types.ts / remote.ts / index.ts / errors.ts）、engine-crud spec 与 plan.json 的精确验收、测试用内存 mock storageDomain 与 `ctx.llm.listProviders/listModels` 精确签名。
- **Goal**：为 crud-02 编码提供准确、可落地的 DSH 先例依据（精确文件路径 + 代码形状），确保域打开/关闭、三表读写、RPC 方法注册与 DSH 先例对齐。

---

### 1. storageDomain 域打开/关闭范式（WorkspaceRegistry）

**DSH 精确源码** — `D:\project-code\llm\deepseek-harness\packages\workspace\workspace\src\index.ts`（第 92–140、633–636 行）

```ts
import { Context, Service } from '@deepseek-ai/cordis'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'

export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  // ...

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()
    // ...
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }
}
```

关键范式点：
- **依赖声明**：`static inject = ['storageDomain', ...]`（`storageDomain` 是硬依赖，供 `this.ctx.storageDomain` 使用）。
- **生命周期钩子**：`protected async [Service.init](): Promise<void>`——`[Service.init]` 是 Cordis `Service` 基类的静态 symbol（`Service.init`，见 `D:\project-code\llm\deepseek-harness\vendor\cordis\src\service.ts` 第 13 行 `static readonly init: unique symbol = symbols.init`），类插件（Service Provider）构造后自动调用该实例方法完成启动。
- **打开域**：`const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)`（`DomainFacility.open` 是 async，返回 `Domain<S>`）。
- **挂释放**：`this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')`——`ctx.effect(execute, label)` 的 `execute` 返回一个同步 disposer（`() => domain.close()`），disposer 在 owning fiber 卸载时（逆序）执行；标签 `'workspace.domainClose'` 仅用于 `getEffects()` 诊断。
- **取表句柄**：`this.table = domain.table('workspaces')`；句柄稳定（重复调用返回同一实例）。
- **requireTable 守护**：私有 `requireTable()` 在 `this.table === undefined`（尚未 `[Service.init]` 完成）时抛错，避免「未初始化就读表」。

**`ctx.effect` 精确签名**（`D:\project-code\llm\deepseek-harness\vendor\cordis\src\fiber.ts` 第 74–90、415–418 行）：

```ts
export type Disposable<T = any> = () => T
export type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>
// SyncEffect = Disposable<T> | Iterable<Disposable<T>>
// AsyncEffect = Promise<Disposable<T>> | AsyncIterable<Disposable<T>>

effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

- `execute` 返回值可以是「单个同步 disposer」或「异步 disposer（`() => Promise<void>`）」；二者都是合法形态（Workspace 用同步形态 `() => () => domain.close()`，message-feedback 用异步形态 `() => async () => { ...; await domain.close() }`）。

---

### 2. `[Service.init]` + `ctx.effect` 异步释放范式（message-feedback）

**DSH 精确源码** — `D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts`（第 150–181、375–380 行）

```ts
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']

  private table?: KvTable<SessionId, MessageFeedbackRow>
  private mutationAdmissionOpen = true

  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
    // ...
  }

  /** Open and own the one message-feedback sidecar domain. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(messageFeedbackDomainSpec)
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await Promise.all(this.operationTails.values())
      await domain.close()
    }, 'message-feedback.domainClose')
    this.table = domain.table('sessions')
  }

  private requireTable(): KvTable<SessionId, MessageFeedbackRow> {
    if (this.table === undefined) {
      throw new Error('message-feedback: durable domain is not initialized')
    }
    return this.table
  }
}
```

关键差异点（相对 Workspace 的同步形态）：
- `this.ctx.effect(() => async () => { ...; await domain.close() }, 'message-feedback.domainClose')` 返回一个**异步 disposer**：卸载时先停收新变更、drain 已排队操作尾，再 `await domain.close()`。sandore 的 `SandorePersistence` 若只需释放域，可任选同步/异步两种形态（`close()` 本身返回 `Promise<void>`）。
- **`TypertRemoteService` 本身也是 `Service`**：`static inject` 与 `protected async [Service.init]()` 都可直接在该类上声明（即 RPC 服务类可直接持有 storageDomain 生命周期，不必另起一个 Service）。

---

### 3. `KvTable` / `Domain` / `DomainFacility` 精确接口

**DSH 精确源码** — `D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\domain.ts`（第 42–119 行）

```ts
export interface KvTable<K extends string, V> {
  get(key: K): V | undefined                       // 同步读内存，缺省返回 undefined
  entries(): IterableIterator<[K, V]>              // 快照迭代器（非 live view）
  keys(): IterableIterator<K>                      // 快照键迭代器
  readonly size: number                            // 当前记录数
  put(key: K, value: V): Promise<void>             // 插入或全量覆盖（无部分合并）
  delete(key: K): Promise<boolean>                 // true=存在并删除；false=已缺席（不写不发事件）
  update(key: K, fn: (current: V) => V): Promise<V> // 原子 read-modify-write；键缺失抛 missing-key
}

export interface Domain<S extends DomainSpec> {
  readonly name: string
  readonly global: DomainGlobalHandleOf<S>          // spec 未声明 global 时为 never
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>
  close(): Promise<void>                            // 幂等；释放后端 unit、释放域名
}
```

精确语义（`domain.ts` 头注释 + 实现，与 crud-02 直接相关）：
- **读同步、写落盘再改内存**：`get`/`entries`/`keys`/`size` 同步读内存；每个写操作在域的单写链上排队，「先 await 后端持久化成功，再改内存，再发 `domain/changed`」——后端写失败内存不变（读写不分离）。域关闭后读抛 `DomainError('closed')`。
- **`entries()` 是快照**：迭代期间排队的写入不影响本次迭代（`([...this.records.entries()] as [K,V][])[Symbol.iterator]()`）。
- **`delete(key)` 的幂等语义**：存在才删（返回 `true`）；已缺席返回 `false`，**不写、不发事件**（对应 engine-crud spec「重复删除幂等，第二次 delete 返回 false/not-found 不抛错」）。
- **`update(key, fn)` 原子 RMW**：键缺失抛 `DomainError('missing-key', ...)`（`DomainError` 从 `@deepseek-ai/dsh-storage-domain` 导出）。
- **`close()` 幂等**：`disposal ??= this.runClose()`；消费方（Service Provider）拥有该调用，通常作为自己的 `ctx.effect` disposer；facility 卸载时会 `closeAll()` 兜底关掉未释放的域。

**`DomainFacility.open` 精确语义**（`D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\index.ts` 第 84–156 行）：

```ts
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
```

- 严格顺序：拒绝已打开名称（`already-open`）→ 解析后端路由（`backend-not-found`）→ 要求后端 `kv` facet（`facet-unsupported`）→ 打开 unit（`version-mismatch`/`malformed-medium` 透传）→ **对每条已存记录走 spec 的 zod schema 校验**（`invalid-record`，含 offending table+key）→ 构造 domain。
- 生命周期原文：*「Lifecycle: the CALLER owns the returned handle and closes it via `Domain.close()` (typically as its own `ctx.effect` disposer)」*——sandore 的 `SandorePersistence` 正应遵守「调用方持句柄、`ctx.effect` 挂 `close()` 释放」。

**sandore 侧既有的域 spec（Task 1 骨架已就绪）** — `D:\project-code\llm\sandore\packages\sandore\workflow\src\schema.ts`（第 325–334 行）：

```ts
export const sandoreDomainSpec = defineDomain({
  name: 'sandore',
  version: 1,
  tables: {
    definitions: domainTable<string, WorkflowDefinitionRecord>(WorkflowDefinitionRecordSchema),
    jobs: domainTable<string, JobRecord>(JobRecordSchema),
    state: domainTable<string, WorkflowTaskState>(WorkflowTaskStateSchema),
  },
})
```

- `WorkflowDefinitionRecordSchema` = `{ yaml: z.string().max(65536), name, version, description?, createdAt, updatedAt }`（`definitions` 表 value，key=workflowId）。
- `JobRecordSchema` = `{ name, workflowId, cwd?, createdAt, updatedAt }`（`jobs` 表 value，key=jobId）。
- `state` 表 value = `WorkflowTaskStateSchema`（完整运行时状态快照，key=instanceId）。
- `defineDomain`/`domainTable` 从 `@deepseek-ai/dsh-storage-domain` 导入；域名/表名满足 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`D:\project-code\llm\deepseek-harness\packages\storage\storage\src\backend.ts` 第 10 行）。

---

### 4. `TypertRemoteService` + `@Remote` 装饰器精确用法

**DSH 精确源码** — `D:\project-code\llm\deepseek-harness\packages\typert\protocol\src\index.ts`（第 147–196 行）

```ts
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  readonly typertRemote: TypertGatewayBinding<this>
  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}

// @Remote 两个重载：
//   @Remote('exportName') —— 显式导出方法名（endpoint method 与实现成员名可不同）
//   @Remote              —— 导出名默认为方法名（直接作方法装饰器）
export function Remote(exportName: string): RemoteMethodDecorator
```

精确语义：
- **命名空间 = serviceKey**：`super(ctx, 'sandore')` 即 wire namespace 为 `sandore`，`@Remote('listDefinitions')` 即端点 `sandore.listDefinitions`；Client 侧 `host.call('sandore.listDefinitions', ...)`。
- **装饰器约束**：`Remote` 要求「public instance method + string 名」——private/static/symbol 名会抛 `TypeError('typert-protocol: Remote decorators require a public instance method with a string name')`（第 235–237 行）。
- **导出名规则**：`Remote('ping') ping()` 即端点 `sandore.ping`；`Remote('list') async list(...)` 即 `sandore.list`。方法可 sync 或 async（message-feedback 的 `list` 是 `async`，`put`/`delete` 返回 `Promise`）。
- **命名校验**：endpoint segment 需匹配 `TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`（第 10 行）。

**sandore 侧既有 RPC 骨架（Task 1 已就绪，crud-02 需扩展）** — `D:\project-code\llm\sandore\packages\sandore\workflow\src\remote.ts`：

```ts
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export class SandoreRemote extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'sandore')
  }

  @Remote('ping')
  ping(): PingResponse {
    return { pong: true, service: 'sandore', time: new Date().toISOString() }
  }
}

export default SandoreRemote
```

- 当前 `SandoreRemote extends TypertRemoteService`、`super(ctx, 'sandore')`、`@Remote('ping')` 已存在；crud-02 在此基础上新增 `@Remote('listDefinitions')` 等方法，**保留 ping**（engine-crud spec「ping 保留」要求返回结构 `{ pong: true, service: 'sandore', time: <ISO> }` 不变）。

**message-feedback 的 @Remote CRUD 范式**（`D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts` 第 189–295 行）——注意 message-feedback 的 RPC 参数是**单对象 request**（`list(request)`/`put(request)`/`delete(request)`），而 sandore 的 engine-crud spec 用**多位置参数**（`listDefinitions()`/`createDefinition(input)`/`updateDefinition(id, input)`/`listJobs(workflowId?)`/`getInstanceState(jobId?, instanceId)`），`@Remote` 对参数形状本身无约束（参数经 Typert 生成的 codec 序列化），sandore 以 api.yaml + engine-crud spec 的签名表为准。

---

### 5. sandore 现状：Task 1 骨架关键落点（crud-02 需对接）

**`packages/sandore/workflow/src/types.ts`**（已有，crud-02 的返回类型来源）：
- `DagRunInfo` = `{ taskId, workflowId, jobId }`
- `DagStartRequest` = `{ workflowId, jobId, originalInput, cwd? }`（**无 permissionMode**，已对齐权限修正）
- `DagRun` = `{ instanceId: string, status: DagRunStatus }`
- `DagRunStatus` = `'pending' | 'running' | 'interacting' | 'completed' | 'failed' | 'aborted' | 'paused'`
- `DagInstanceState`（Service 层 `getState` 的返回，精简版，与存储域 `WorkflowTaskState` 不同）
- `StageContract` / `ExecutedStepDefault` / `StageInfo` / `StepStatus` 等

**`packages/sandore/workflow/src/schema.ts`**（已有，crud-02 的存储 value schema 来源）：
- `WorkflowDefinitionRecord` / `JobRecord` / `WorkflowTaskState` 类型均由 `z.infer` 派生。
- `sandoreDomainSpec` 三表 spec 已就绪（见 §3）。

**`packages/sandore/workflow/src/index.ts`**（已有，crud-02 的引擎 seam 来源）：
- `SandoreEngine extends Service`，`static inject = ['sessions', 'sessionPersistence', 'subagents', 'llm', 'shell', 'fs', 'storageDomain']`（含 `storageDomain`），`static Config`（schemastery，含 `defaultTimeoutMs`/`maxConcurrentSteps`）。
- `SandoreEngine.startInstance(request: DagStartRequest): DagRun` / `abortInstance(instanceId): Promise<void>` / `getState(instanceId): DagInstanceState` 为 RPC 转发目标。
- 当前 default export 为 `SandoreEngineStub`（11 个方法抛 not implemented）；execution-03（Task 2 第三步）将换成 `SandoreEngineRuntime`。

**`packages/sandore/workflow/src/errors.ts`**（已有）：`SandoreError extends HarnessError` + `SandoreErrorCode`（含 `YAML_PARSE`/`DEFINITION_INVALID`/`INVALID_OPERATION`/`PERSISTENCE_FAILED` 等）+ `isFatalSandoreError`。crud-02 的 not-found / 非法操作错误用 `SandoreError` 表达（engine-crud spec 多处要求「抛 SandoreError」）。

**依赖现状**（`packages/sandore/workflow/package.json`，schema-01 已补齐）：`dependencies` 含 `yaml`/`zod`；peer/devDependencies 含 `@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-storage` 等（版本均 `0.1.0-rc.6`）——crud-02 所需依赖已就绪，无新增缺口。

---

### 6. engine-crud 权威验收规格（`specs/engine-crud/spec.md` + `plan.json` + `api.yaml`）

**`D:\project-code\llm\sandore\furina\changes\task-2-minimal-engine\specs\engine-crud\spec.md`** 的关键 Requirement（原文，已完整读取）：

1. **存储域持久化 Provider**：`persistence.ts` SHALL 提供 `SandorePersistence`——Provider 在 `[Service.init]` 中 `await ctx.storageDomain.open(sandoreDomainSpec)` 打开域，`ctx.effect` 挂 `Domain.close()` 释放；暴露三表句柄（`definitions`/`jobs`/`state` 的 `KvTable`）与 `saveWorkflowState(state: WorkflowTaskState): Promise<void>`（`state.put(instanceId, state)` 全量覆盖）。
2. **定义 CRUD RPC**：`listDefinitions(): WorkflowDefinitionRecord[]`（entries() 全量）、`createDefinition(input: { yaml })`（解析+Zod 验证 YAML → 生成 `wfl-{uuid}` → 存 yaml+元数据）、`updateDefinition(id, input)`、`deleteDefinition(id)`、`getYaml(id): string`、`updateYaml(id, yaml)`（重新验证后覆盖）。
3. **Job CRUD RPC**：`listJobs(workflowId?)`、`createJob(input: { name, workflowId, cwd? })`（校验 workflowId 存在于 definitions 表）、`getJob(id)`、`updateJob(id, input)`、`deleteJob(id)`。
4. **实例生命周期 RPC**：`listInstances(jobId?)`（从 state 表 `entries()` 派生，返回 `{instanceId, jobId, workflowId, status, createdAt, updatedAt}` 摘要）、`startInstance(input: { jobId, originalInput, cwd? })`（转发 `ctx.sandoreEngine.startInstance`，返回 `DagRun`）、`getInstanceState(jobId?, instanceId): WorkflowTaskState`、`deleteInstance(instanceId)`、`abortInstance(instanceId)`（转发引擎，非运行态抛错）。
5. **产物查询 RPC**：`getArtifacts(instanceId, stageId?)`（从 state 表读快照，遍历 `executedSteps[]` + `stageContracts` 构建 `{ stepId, stageId, outputToId, files, returnPrompt? }` 条目，可按 stageId 过滤）。
6. **Provider/Model 转发 RPC**：`listProviders()` / `listModels(provider)`（转发 `ctx.llm.listProviders()` / `ctx.llm.listModels(provider)`）。
7. **ping 保留**：`@Remote('ping')` 返回 `{ pong: true, service: 'sandore', time: <ISO> }`。

**关键语义（spec Scenario 原文提炼）**：
- `deleteDefinition`/`deleteJob` **不级联删除实例**（`plan.json` crud-02 description 明确）；`deleteDefinition`/`deleteJob`/`deleteInstance` 重复删除幂等（返回 false/not-found，不抛错）。
- `createDefinition` 非法 YAML → 抛 `SandoreError`（`YAML_PARSE`/`DEFINITION_INVALID`），`definitions` 表无新记录；`updateYaml` 非法 YAML → 抛错且存储 yaml 保持旧值（「先验证再覆盖」顺序）。
- `createJob` 校验 `workflowId` 存在（不存在抛 `SandoreError('INVALID_OPERATION')` 或等价类型化错误）。
- `startInstance` 返回 `{ instanceId, status }`，`state` 表立即可读回含 `originalInput` 的完整快照。
- `getInstanceState` 不存在 → 抛 not-found 类型化错误；`abortInstance` 对 `completed` 态 → 抛 `SandoreError('INVALID_OPERATION')`。

**`plan.json` crud-02 的 files / tasks**（`D:\project-code\llm\sandore\furina\changes\task-2-minimal-engine\plan.json`）：

- files：`packages/sandore/workflow/src/persistence.ts`、`packages/sandore/workflow/src/remote.ts`、`packages/sandore/workflow/src/persistence.spec.ts`、`packages/sandore/workflow/src/remote.spec.ts`、`tests/mocks/storage-domain.ts`。
- tasks：2.1 persistence.ts → 2.2 tests/mocks/storage-domain.ts（内存 mock，Map 版 KvTable）→ 2.3 定义 CRUD → 2.4 Job CRUD → 2.5 实例生命周期 + getArtifacts + listProviders/listModels（保留 ping）→ 2.6 单测全绿。
- description 关键句：**「RPC 层只做 zod 参数校验 + 转发到引擎/存储域，无业务逻辑」**；`listInstances` 从 state 表 `entries()` 按 jobId 过滤派生摘要；`deleteDefinition/deleteJob` 不级联删除实例。

**`api.yaml`**（`D:\project-code\llm\sandore\furina\changes\task-2-minimal-engine\api.yaml`）已完整描述 20 个 RPC 方法的参数/返回 shape（swagger 2.0，basePath `/sandore`，每个 path 段对应 RPC 方法名），其中关键 wire 形状：`WorkflowDefinitionRecord`（含 `id`=key）、`JobRecord`（含 `id`=key）、`DagRun`（`{instanceId, status}`）、`InstanceSummary`（`{instanceId, jobId, workflowId, status, createdAt, updatedAt}`）、`ArtifactEntry`（`{stepId, stageId, outputToId?, files, returnPrompt?}`）。

---

### 7. 测试基建 + 内存 mock storageDomain

**根测试基建（schema-01 已建立）**：
- `D:\project-code\llm\sandore\package.json`：`"test": "vitest run"`，devDeps 含 `vitest ^4.1.8`。
- `D:\project-code\llm\sandore\vitest.config.ts`：`include: ['packages/**/*.spec.ts']`，`environment: 'node'`（`persistence.spec.ts`/`remote.spec.ts` 落在 `packages/sandore/workflow/src/` 下，被 include 覆盖；`tests/mocks/*` 是 import 目标，非独立 spec）。
- 既有 spec 范式（`packages/sandore/workflow/src/schema.spec.ts`）：`import { describe, expect, it } from 'vitest'`，源码 import 带 `.ts` 后缀（`from './schema.ts'`）。

**内存 mock storageDomain（plan 指定 `tests/mocks/storage-domain.ts`，Map 版 KvTable）**：
- plan crud-02 task 2.2 明确「内存 mock storageDomain，Map 版 KvTable」——即测试不拉起真实 `DomainFacility`/`DomainImpl`，而是提供一个符合 `KvTable<K,V>` 接口的 Map 实现（`get`/`entries`/`keys`/`size`/`put`/`delete`/`update`），并 mock `ctx.storageDomain.open()` 返回带 `table(name)`/`close()` 的 `Domain` 形状。
- DSH 真实内存后端的参考（如需走真实 storage-domain 而非手写 mock）：`@deepseek-ai/dsh-storage-sqlite` 的 `SqliteStorageBackend` 支持 `path: ':memory:'`（`D:\project-code\llm\deepseek-harness\packages\storage\storage-sqlite\src\index.ts` 第 27–33 行 Config 注释「The special value `:memory:` opens an in-process database (tests)」）。work.md 验证标准原文也并列提到「`SqliteStorageBackend(':memory:')` + fake llm adapter + mock shell」与「内存 mock DSH 服务」。

**`ctx.llm.listProviders()` / `listModels()` 精确签名**（`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\index.ts` 第 419–421、581 行）：

```ts
listProviders(): LlmProviderInfo[]                 // 同步，返回注册序的 provider 元数据数组
async listModels(provider: string): Promise<LlmModelInfo[]>  // 异步
```

- `listProviders()` 返回 `[...this.adapters.values()].map(({ provider }) => ({ ...provider }))`（每个元素至少含 `id`/`name`）。
- `listModels(provider)` 返回 `Promise<LlmModelInfo[]>`（model 元素含 `provider`/`id`/`name`/`inputModalities` 等，adapter 偏好序）；LlmAdapter 默认实现返回 `Promise.resolve([])`。
- 因此 `listProviders`/`listModels` RPC 是**同步/异步透传**：`listProviders()` 直接转 `ctx.llm.listProviders()`，`listModels(provider)` 转 `ctx.llm.listModels(provider)`（engine-crud spec「转发透传」Scenario：mock llm 注册 1 provider/1 model 时 `listProviders().length === 1` 且 `listModels(providerId)` 返回该 model）。

---

## Supplementary Exploration Result

无需补充探索：`experimental.websearch=true`、`experimental.context7=true`，但 Phase 3 已从本地点名参考源（`docs/design/task-2-minimal-engine/work.md`、DSH 源码 WorkspaceRegistry / message-feedback / storage-domain / typert-protocol / cordis / llm、sandore 项目内 `specs/engine-crud/spec.md`、`plan.json`、`api.yaml`、Task 1 骨架源码）获取到充足且精确的信息，无需联网检索。
