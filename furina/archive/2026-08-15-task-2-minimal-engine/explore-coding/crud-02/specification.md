# Furina Explore — crud-02 探索结果

> 探索类型：specification（规格材料探索）
> 项目路径：D:\project-code\llm\sandore
> 探索内容：crud-02 —— persistence.ts（`ctx.storageDomain.open(sandoreDomainSpec)` + `[Service.init]` 生命周期 + `Domain.close()`）+ remote.ts（`TypertRemoteService` + `@Remote` 定义/Job/实例 CRUD）+ 内存 mock storageDomain 测试
> 说明：`furina config show exploration.specification` 返回 `[]`（空配置），故按 exploreContent 直接探索 `docs/design/*` 与 DSH 源码 `D:\project-code\llm\deepseek-harness`。

---

## 1. 需求理解（Phase 2）

- **What**：实现 crud-02 —— 工作流引擎的「定义/Job/实例 CRUD + 存储域持久化 + Host RPC」。`persistence.ts` 负责用 `ctx.storageDomain.open(sandoreDomainSpec)` 打开 `sandore` 域（三表 `definitions`/`jobs`/`state`）并管理其生命周期；`remote.ts` 用 `TypertRemoteService` + `@Remote` 装饰器暴露 Host RPC（定义 CRUD、Job CRUD、实例生命周期、getArtifacts、listProviders/listModels）。测试用内存 mock storageDomain。
- **Boundaries**：仅 `packages/sandore/workflow` 包内的 `persistence.ts` 与 `remote.ts` 两个文件（及其测试）；不涉及 microflow 的 Stage/Step 执行逻辑。
- **Goal**：精确掌握（1）`storageDomain` open/close 的 DSH 标准范式；（2）`@Remote` CRUD 的 DSH 标准范式；（3）`KvTable` 接口精确签名；（4）内存 mock storageDomain 的测试范式；（5）现有 sandore 包中已就绪的 schema/类型。

---

## 2. 当前 sandore workflow 包现状（已存在的文件）

`packages/sandore/workflow/src/` 当前文件（Task 1 骨架 + Task 2 部分已就绪）：

| 文件 | 现状 |
|---|---|
| `index.ts` | `SandoreEngine extends Service` 抽象类（11 个实例级方法）+ `SandoreEngineStub` Provider 桩（`static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`，`Config` 用 schemastery）+ 13 个 `sandore/*` 事件双声明（Cordis `Events` + Session `SessionEventMap`）。**未含 `defaultProvider/defaultModel`**（Task 2 §6.4 需补）。 |
| `types.ts` | 纯类型：`DagRunInfo/DagStartRequest/DagRun/DagRunStatus/DagInstanceState/ExecutedStepDefault/StageInfo/StepStatus/StageContract/PendingQuestion/AskUserQuestionPayload/PendingPermission/DagResultInfo`。`DagStartRequest` 无 `permissionMode`。 |
| `schema.ts` | **已定义** `sandoreDomainSpec`（三表 `definitions`/`jobs`/`state`）与三层 Zod Schema（定义层/运行时层/存储层），见 §3。 |
| `yaml-parser.ts` | `parseWorkflowYaml`（V1/V2 双格式 + Zod 验证 + 引用完整性）+ `serializeWorkflowYaml`。 |
| `errors.ts` | `SandoreError extends HarnessError`（`fatal` 标志，默认 true）+ `SandoreErrorCode` + `isFatalSandoreError`。 |
| `remote.ts` | **仅 `sandore.ping` 桩**：`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')` + `@Remote('ping')`。**crud-02 需扩为完整 CRUD**。 |
| `persistence.ts` | **尚不存在**（crud-02 需新建）。 |

根 `package.json` **已含** `"test": "vitest run"` + `devDependencies.vitest`（Task 2 验证标准已满足前置）。

---

## 3. `sandoreDomainSpec` 三表 Schema（已在 schema.ts 中定义，勿重复创建）

来源：`packages/sandore/workflow/src/schema.ts`（第 304–334 行）。

```ts
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

// 定义记录（definitions 表 value）：YAML 文本封顶 65536
export const WorkflowDefinitionRecordSchema = z.object({
  yaml: z.string().max(65536),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// Job 记录（jobs 表 value）
export const JobRecordSchema = z.object({
  name: z.string(),
  workflowId: z.string(),
  cwd: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// state 表 value = WorkflowTaskStateSchema（运行时完整快照）

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

要点：
- key 均为 `string`（definitions 表 key=workflowId、jobs 表 key=jobId、state 表 key=instanceId）。
- `sandoreDomainSpec` 无 `global`（Workspace 域有 `global`，本域不需要）。
- 派生类型 `WorkflowDefinitionRecord` / `JobRecord` 已 `z.infer` 导出。

---

## 4. `KvTable` 接口精确签名（DSH `@deepseek-ai/dsh-storage-domain`）

来源：`D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\domain.ts`（第 42–90 行）。**这是 crud-02 读写三表的权威 API。**

```ts
export interface KvTable<K extends string, V> {
  get(key: K): V | undefined                                        // 同步内存读；缺省返回 undefined
  entries(): IterableIterator<[K, V]>                              // 快照迭代器（非活视图）
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>                             // 整条覆盖（无部分合并）
  delete(key: K): Promise<boolean>                                 // true=曾存在，false=已缺省（不写不发事件）
  update(key: K, fn: (current: V) => V): Promise<V>                // 原子 RMW；缺 key 抛 {code:'missing-key'}
}
```

`Domain` 句柄：

```ts
export interface Domain<S extends DomainSpec> {
  readonly name: string
  readonly global: DomainGlobalHandleOf<S>                          // 本 spec 未声明 global → never（不可访问）
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>
  close(): Promise<void>                                           // 幂等；拒绝新写、排空已排队写、释放后端、释放域名
}
```

`DomainFacility.open` 语义（`src/index.ts` 第 100–156 行）：拒绝重复域名（`already-open`）、解析路由、要求后端 `kv` facet、打开 unit、按 spec 的 zod schema 校验每条已存记录（`invalid-record`）。**调用方拥有句柄并通过 `Domain.close()` 释放**（通常作为 `ctx.effect` 的 disposer）；每次 `put`/`delete` 后发 `domain/changed` 事件。

`defineDomain` / `domainTable`（`src/spec.ts`）：

```ts
export function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>
export function defineDomain<S extends DomainSpec>(spec: S): S   // 模块加载期校验 name/version/table 名合法
```

---

## 5. 范式 A：WorkspaceRegistry 的 storageDomain open/close

来源：`D:\project-code\llm\deepseek-harness\packages\workspace\workspace\src\index.ts`（第 92–140 行）。**persistence.ts 应照此范式。**

```ts
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>

  constructor(ctx: Context) { super(ctx, 'workspaceRegistry') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')   // ★ 释放
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()
    // ...bootstrap/rebuild
  }
}
```

关键点：
- `[Service.init]()` 是 Cordis Service 生命周期钩子（`static readonly init: unique symbol`，见 `vendor/cordis/src/service.ts` 第 13 行）；Provider 在 start 时被调用，是打开域的时机。
- `ctx.storageDomain.open(spec)` 返回 `Promise<Domain<S>>`，需 `await`。
- `ctx.effect(() => () => domain.close(), 'name')` 注册同步 disposer；`domain.close()` 返回 `Promise<void>`（Cordis effect 支持同步/异步 disposer）。
- `requireTable()` 保护：`this.table` 未初始化时抛错（防止 `[Service.init]` 前访问）。

---

## 6. 范式 B：message-feedback 的 `@Remote` CRUD + `TypertRemoteService`

来源：`D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts`（第 150–297 行）。**remote.ts 应照此范式。**

```ts
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']
  static Config: s<Config> = s.object({ maxNoteBytes: s.number().step(1).min(1).required() })

  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')   // ★ super 第二个参数 = wire namespace
    ...
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(messageFeedbackDomainSpec)
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await Promise.all(this.operationTails.values())
      await domain.close()
    }, 'message-feedback.domainClose')   // ★ 异步 disposer 亦可
    this.table = domain.table('sessions')
  }

  @Remote('list')   async list(request): Promise<Result> { ... }
  @Remote('put')    put(request): Promise<Result> { ... }
  @Remote('delete') delete(request): Promise<Result> { ... }
}
```

`TypertRemoteService` + `Remote` 精确定义（`packages/typert/protocol/src/index.ts`）：

```ts
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  readonly typertRemote: TypertGatewayBinding<this>
  protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}

export function Remote(exportName: string): RemoteMethodDecorator   // 命名端点
// 也可直接 @Remote（无参，端点名 = 方法名）
```

- 端点拼装：`super(ctx, 'sandore')` 定 wire namespace，`@Remote('ping')` 定 method → `sandore.ping`。前端 `host.call('sandore.listDefinitions', ...)`。
- `@Remote` 只接受 public 实例方法 + string 名；可返回 `Promise` 或同步值。
- `Remote`/`TypertRemoteService` 已列在 workflow 包 `peerDependencies`（`@deepseek-ai/dsh-typert-protocol: 0.1.0-rc.6`）。

---

## 7. RPC 方法清单与签名（来自设计文档）

### 7.1 定义 CRUD（design.md §4.4 / dsh-workflow.md §7.2）

| 方法 | 语义 |
|---|---|
| `listDefinitions()` | 列全部定义（`definitions` 表 `entries()`） |
| `createDefinition(data)` | 创建定义 + 初始 YAML；Zod 校验 `CreateWorkflowDefSchema` |
| `updateDefinition(id, data)` | 更新定义元数据 |
| `deleteDefinition(id)` | 删除定义 |
| `getYaml(id)` | 读 YAML 文本 |
| `updateYaml(id, yaml)` | 写 YAML + 更新 timestamp |

原 `dynamic-workflow-engine` 签名（§4.4 表）：`createWorkflowDef(data)→WorkflowRecord`、`listWorkflowDefs()→WorkflowRecord[]`、`getWorkflowDef(id)→WorkflowRecord & {yaml}`、`updateWorkflowDef(id,data)→WorkflowRecord`、`deleteWorkflowDef(id)→void`、`getWorkflowYaml(id)→string`、`updateWorkflowYaml(id,yaml)→void`。

### 7.2 Job CRUD（design.md §4.5）

`createJob(data)`（自动生成 UUID，校验 workflowId 存在）/ `listJobs(workflowId?)` / `getJob(id)` / `updateJob(id, data)` / `deleteJob(id)`。

### 7.3 实例生命周期（design.md §4.6）

| 方法 | 签名语义 |
|---|---|
| `listInstances(jobId)` | 列实例（从 `state` 表按 jobId 过滤派生，或从活跃引擎丰富状态） |
| `startInstance(jobId, data)` | `data: { originalInput, cwd?, stagePath? }`（无 permissionMode）→ 生成 `YYYYMMDD-HHmmss-xxx` 实例 ID → 写 `state` 快照 → 引擎异步执行 |
| `deleteInstance(jobId, instanceId)` | 删除 `state` 条目 |
| `getInstanceState(jobId, instanceId)` | 三层回退：内存活跃引擎 → `state` 表读出 → 直接读 |
| `abortInstance(jobId, instanceId)` | 验证非终态 → `engine.abort()` → `{ instanceId, status }` |

### 7.4 其他（exploreContent 明确列出）

- `getArtifacts(jobId, instanceId, stageId?)` — 遍历扁平 `executedSteps` 构建产物条目。
- `listProviders()` / `listModels(provider)` — **直接复用 `ctx.llm`**（见 §8）。

> 注：暂停/恢复/重试/交互/讨论为 Task 4；`getDiscussion`/`addChatMessage` 等非 crud-02 范围（work.md 明确 crud-02 只做定义 CRUD + Job CRUD + 实例生命周期 + getArtifacts + listProviders/listModels）。

---

## 8. `ctx.llm.listProviders()/listModels()` 精确签名

来源：`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\index.ts`（第 419、581 行）与 `types.ts`。

```ts
listProviders(): LlmProviderInfo[]                              // 同步
async listModels(provider: string): Promise<LlmModelInfo[]>     // 异步

interface LlmProviderInfo { id: string; name: string }
interface LlmModelInfo {
  provider: string; id: string; name: string;
  description?: string; inputModalities?: readonly ModelModality[]
}
```

`remote.ts` 的 `listProviders`/`listModels` 即透传这两个调用（`this.ctx.llm`）。

---

## 9. 内存 mock storageDomain 测试范式

DSH 官方测试辅助类（**非发布面**，位于 `tests/` 下，可相对路径 import）：

来源：`D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\tests\helpers\memory-backend.ts` + `tests\domain.spec.ts`。

```ts
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'  // 可复制进 workflow/tests/

async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  ctx.storage.mount('domain', facility)          // 或 ctx.provide('storageDomain', facility)
  return { ctx, facility, backend }
}
```

- `MemoryStorageBackend` 实现完整 `KvUnit`（`putRecord`/`deleteRecord`/`setGlobal`/`loadAll`/`close`）；`MemoryMediaPool` 共享介质可模拟重启，`failNextWrites` 注入写失败。
- 测试断言范式：`table.put/get/entries/keys/size/update/delete`；`domain.close()` 幂等且排空队列、拒绝后续写（`{code:'closed'}`）；`domain/changed` 按序发射。
- crud-02 测试约定（design.md §7.1）：纯单元（YAML/Zod/类型化错误，零 mock）+ 轻量集成（CRUD + 持久化 + 线性执行，用内存 mock storageDomain + fake `ctx.llm` adapter + mock `ctx.shell`）。work.md 明确「测试用内存 mock storageDomain」。

---

## 10. 关键约束与落点结论

1. **persistence.ts 落点**：新建 `packages/sandore/workflow/src/persistence.ts`，导出一个 `Service`（持有 `KvTable` 引用），按 WorkspaceRegistry/message-feedback 范式实现 `protected async [Service.init]()`：`await this.ctx.storageDomain.open(sandoreDomainSpec)` + `this.ctx.effect(() => () => domain.close(), 'sandore.domainClose')` + `domain.table('definitions'|'jobs'|'state')`；提供 `requireTable()` 保护。`sandoreDomainSpec` 已在 `schema.ts` 就绪，勿重复定义。
2. **remote.ts 落点**：扩展现有 `SandoreRemote`（`super(ctx, 'sandore')`），用 `@Remote('listDefinitions')` 等装饰方法实现 §7 的 RPC 清单；方法内通过 persistence 层/存储域三表读写；`listProviders/listModels` 透传 `ctx.llm`。
3. **依赖注入**：`storageDomain` 已在 Provider `static inject` 中；`@deepseek-ai/dsh-storage-domain` / `@deepseek-ai/dsh-typert-protocol` 已在 workflow 包 `peerDependencies`。
4. **配置修正**：Task 2 §6.4 要求 `SandoreEngineRuntime.Config` 增加 `defaultProvider/defaultModel`（成对才用，L2 兜底），当前 `index.ts` 的 `SandoreEngineStub.Config` 尚未含这两个字段（属后续引擎实现，crud-02 可留意）。
