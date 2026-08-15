# crud-02 探索结果（codebase.md）

> 探索任务：crud-02（定义/Job/实例 CRUD + 存储域持久化 + Host RPC）实现所需的
> 当前项目状态与 DSH 参考范式/精确 API 签名。
> 语言：中文。本文件仅记录现状与事实，不含实现方案或代码。

---

## Exploration Result

### Phase 1 获取 codebases list

```bash
furina config show project.sourcecode codebases
```

结果：

- `project.sourcecode=src/`
- `codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]`

### Phase 3 结论（codebases list 探索）

- `docs/codebase` 目录为空（无文件）。
- `src/` 目录不存在/为空（`find D:/project-code/llm/sandore/src -type f` 无结果）。
- 因此 codebases list 本身无可探索内容，全部有效信息通过 Phase 4 补充探索获得（见下）。

---

## Supplementary Exploration Result

### 1. 需求理解（Phase 2）

- **What**：在 `packages/sandore/workflow/` 包内实现 Task 2 的 crud-02（对应实现蓝图
  `docs/engine/dsh-workflow-implementation.md` 的 **T4**）：
  1. `persistence.ts`：用 `ctx.storageDomain.open(sandoreDomainSpec)` 打开 `sandore` 域
     三表（`definitions`/`jobs`/`state`），走 `[Service.init]` 生命周期，用
     `Domain.close()` 释放；
  2. `remote.ts`：用 `TypertRemoteService` + `@Remote` 装饰器实现定义 CRUD
     （`listDefinitions`/`createDefinition`/`updateDefinition`/`deleteDefinition`/
     `getYaml`/`updateYaml`）+ Job CRUD + 实例生命周期（`listInstances`/
     `startInstance`/`deleteInstance`/`getInstanceState`/`abortInstance`）+
     `getArtifacts` + `listProviders`/`listModels`；
  3. 测试用内存 mock storageDomain。
- **Boundaries**：`packages/sandore/workflow/`（含其 spec 测试）；参考源码在
  `D:\project-code\llm\deepseek-harness`（DSH）。
- **Goal**：摸清当前 Task 1 骨架状态 + 拿到 DSH 侧 `storageDomain` open/close、
  `@Remote` CRUD、`KvTable` 接口的精确签名，作为实现依据。
- **Project Context**：sandore 是 DSH 插件 monorepo（pnpm workspace，`packages/sandore/*`
  四包）。Task 1 骨架已完成。crud-02 落在「存储域持久化 + Host RPC」架构层，依赖
  `@deepseek-ai/dsh-storage-domain` 与 `@deepseek-ai/dsh-typert-protocol`，遵循 DSH
  的 Service + 存储域 + Remote 组合范式。

---

### 2. 当前项目状态（Task 1 骨架，已存在代码）

根目录：`D:\project-code\llm\sandore`
- `package.json`：`"test": "vitest run"`，devDeps 含 `typescript`/`tsdown`/`tsx`/`vitest`（已就绪）。
- `vitest.config.ts`：`include: ['packages/**/*.spec.ts']`。
- `pnpm-workspace.yaml`：`packages: - packages/sandore/*`。
- `tsconfig.base.json`：`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、
  `noImplicitOverride` 等（实现时需遵守严格类型约束）。

已存在的 `workflow` 包文件（`D:\project-code\llm\sandore\packages\sandore\workflow\src\`）：

| 文件 | 现状 |
|---|---|
| `index.ts` | `abstract class SandoreEngine extends Service`（11 个实例级方法）+ 13 个 `sandore/*` 事件双声明（Cordis Events + Session `SessionEventMap`）+ `SandoreEngineStub`（默认导出）。`SandoreEngineStub.static inject = ['sessions','sessionPersistence','subagents','llm','shell','fs','storageDomain']`。 |
| `types.ts` | browser-safe 类型：`DagRunInfo`/`DagStartRequest`/`DagRun`/`DagRunStatus`/`DagInstanceState`/`ExecutedStepDefault`/`StageInfo`/`StageContract`/`PendingQuestion`/`PendingPermission` 等。 |
| `schema.ts` | **三层 Zod Schema 已全部就绪**，含 `WorkflowDefinitionRecordSchema`、`JobRecordSchema`、`WorkflowTaskStateSchema`，**且已定义 `sandoreDomainSpec`**（见下）。 |
| `errors.ts` | `SandoreError extends HarnessError`（稳定 `code` + `fatal` 标志）。 |
| `yaml-parser.ts` | `parseWorkflowYaml` / `serializeWorkflowYaml`（V1/V2 + Zod + 引用完整性校验）。 |
| `remote.ts` | **仅 `SandoreRemote extends TypertRemoteService` + `@Remote('ping')` 桩**（crud-02 需扩展）。 |
| `schema.spec.ts` / `yaml-parser.spec.ts` | 已有单元测试。 |

其它包：
- `packages/sandore/microflow/`、`packages/sandore/tool/`：占位（`src` 目录为空）。
- `packages/sandore/ui/`：Task 1 的按钮/面板 + `host.call('sandore.ping')`。

关键点：**`schema.ts` 已经定义好 `sandoreDomainSpec`**，crud-02 的 `persistence.ts`
直接复用即可，无需重新声明域。

`schema.ts` 中已有的存储层定义（原文）：

```typescript
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const WorkflowDefinitionRecordSchema = z.object({
  yaml: z.string().max(65536),   // YAML 文本，JSON string 存 value，上限 64KB
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const JobRecordSchema = z.object({
  name: z.string(),
  workflowId: z.string(),
  cwd: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

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

`WorkflowTaskStateSchema` 字段（`state` 表 value）：`taskId`(=instanceId)/`jobId`/
`workflowId`/`cwd`/`status`/`originalInput`/`currentStageId`/`executedSteps`/
`stageInfos`/`pendingInteractions`/`pendingQueue`/`visitCounts`/`passThroughVars`/
`activeLoopIterationStack`/`activeLoopNodeId`/`activeLoopStack`/`pausedStepIds`/
`stageContracts`/`createdAt`/`updatedAt`（无 `permissionMode`/`userChatMessages`/
`defaultSessionMeta`，已被 spec 测试锁定）。

`remote.ts` 现有内容（crud-02 要在此扩展）：

```typescript
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export class SandoreRemote extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'sandore')   // wire namespace = 'sandore'，端点形如 sandore.<method>
  }

  @Remote('ping')
  ping(): PingResponse { ... }
}
```

注意：现有 `remote.ts` 只 `import type { Context }`，且 `SandoreRemote` 无
`static inject`。crud-02 若要在 Remote 内使用 `this.ctx.storageDomain` /
`this.ctx.llm` 与 `[Service.init]`，需补 `Service` 符号导入（`@deepseek-ai/cordis`）
并声明 `static inject`（对齐 message-feedback 范式）。

---

### 3. DSH 参考范式（精确签名，均来自 `D:\project-code\llm\deepseek-harness`）

#### 3.1 WorkspaceRegistry 的 storageDomain open/close 范式

文件：`D:\project-code\llm\deepseek-harness\packages\workspace\workspace\src\index.ts`

```typescript
import { Context, Service } from '@deepseek-ai/cordis'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'

export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')  // 同步 disposer
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()
    // ... 恢复/校验/重建缓存
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }
}
```

要点：
- `[Service.init]` 是 Cordis `Service` 上的 symbol 计算属性名，写法
  `protected async [Service.init](): Promise<void>`。
- 打开域后立即注册 disposer：`this.ctx.effect(() => () => domain.close(), '<label>')`。
- `domain.table('<name>')` 拿到 `KvTable`，存到私有字段；用 `requireTable()` 做
  「未初始化即抛错」的守护。

#### 3.2 message-feedback 的 @Remote CRUD 范式（含异步关闭）

文件：`D:\project-code\llm\deepseek-harness\packages\feedback\message-feedback\src\index.ts`

```typescript
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']

  private table?: KvTable<SessionId, MessageFeedbackRow>
  private mutationAdmissionOpen = true

  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
    this.maxNoteBytes = resolveMaxNoteBytes(config.maxNoteBytes)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(messageFeedbackDomainSpec)
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await Promise.all(this.operationTails.values())
      await domain.close()
    }, 'message-feedback.domainClose')   // 异步 disposer：先排空在途写再 close
    this.table = domain.table('sessions')
  }

  @Remote('list')
  async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> {
    const row = this.requireTable().get(request.sessionId)
    // ...
  }

  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> {
    // ... await table.put(key, value)
  }

  @Remote('delete')
  delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult> {
    // ... await table.put(...) / 依赖 table.get(...)
  }

  private requireTable(): KvTable<SessionId, MessageFeedbackRow> {
    if (this.table === undefined) throw new Error('message-feedback: durable domain is not initialized')
    return this.table
  }
}
```

要点：
- Remote 服务**直接继承 `TypertRemoteService`**（不再单独 extends Service），
  `constructor` 里 `super(ctx, '<namespace>')`。
- Remote 方法上的 `@Remote('<exportName>')` 即端点方法名；完整端点 = `<namespace>.<exportName>`。
- 读用 `table.get(key)`（同步）；写用 `await table.put(key, value)`；
  删除用 `await table.delete(key)`（返回 boolean）。
- 关闭域用异步 disposer `this.ctx.effect(() => async () => { ...; await domain.close() }, label)`。

#### 3.3 KvTable 接口精确签名

文件：`D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\domain.ts`

```typescript
export interface KvTable<K extends string, V> {
  get(key: K): V | undefined                         // 同步内存读；缺失返回 undefined
  entries(): IterableIterator<[K, V]>                // 快照迭代器 [key, value]
  keys(): IterableIterator<K>                        // 快照迭代器 key
  readonly size: number                              // 当前记录数
  put(key: K, value: V): Promise<void>               // 插入/全量覆盖
  delete(key: K): Promise<boolean>                   // 存在→true（有写+事件）；缺失→false（无写无事件）
  update(key: K, fn: (current: V) => V): Promise<V>  // 原子读改写；key 缺失抛 DomainError('missing-key')
}
```

`Domain` 接口精确签名（同文件）：

```typescript
export interface Domain<S extends DomainSpec> {
  readonly name: string
  readonly global: DomainGlobalHandleOf<S>                    // 无 global 声明时为 never
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>
  close(): Promise<void>                                      // 幂等；调用方拥有该句柄
}
```

`DomainFacility`（`...\storage-domain\src\index.ts`）：

```typescript
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
get(name: string): DomainImpl | undefined
async closeAll(): Promise<void>
```

`defineDomain` / `domainTable`（`...\storage-domain\src\spec.ts`）：

```typescript
function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>
function defineDomain<S extends DomainSpec>(spec: S): S   // 校验 name/version/table 名 & global 不接受 null
```

`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`：域名与表名必须小写字母开头、仅小写字母/数字/下划线
（`sandore` 与 `definitions`/`jobs`/`state` 均满足）。

#### 3.4 TypertRemoteService / Remote 装饰器精确签名

文件：`D:\project-code\llm\deepseek-harness\packages\typert\protocol\src\index.ts`

```typescript
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  readonly typertRemote: TypertGatewayBinding<this>
  protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions = {})
}

// 装饰器两种形态：
@Remote('methodName')   // 以显式 export name 注册（推荐，端点方法名 = 该字符串）
@Remote                 // 以被装饰方法名注册
```

- `TypertRemoteService` 内部 `bindTypertRemote(this, this.name, options)`；`options.namespace`
  缺省 = serviceKey。因此 `super(ctx, 'sandore')` → namespace `sandore`，端点
  `sandore.<method>`。
- 端点名必须匹配 `/^[A-Za-z0-9_$.-]+$/`（`isTypertRemoteSegment`）。

#### 3.5 ctx.llm 的 listProviders / listModels 精确签名

文件：`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\index.ts` 与 `src\types.ts`

```typescript
// 同步
listProviders(): LlmProviderInfo[]
// LlmProviderInfo = { id: string; name: string }

// 异步
listModels(provider: string): Promise<LlmModelInfo[]>
// LlmModelInfo = { provider: string; id: string; name: string; description?: string; inputModalities?: readonly ModelModality[] }
```

---

### 4. 存储域测试 mock 范式（DSH 参考）

#### 4.1 MemoryStorageBackend（测试辅助，非发布面）

文件：`D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\tests\helpers\memory-backend.ts`

- `class MemoryMediaPool`：共享介质池（`media: Map<string, MemoryMedium>`、
  `versions: Map<string, number>`、可注入写失败 `failNextWrites`）。
- `class MemoryStorageBackend implements StorageBackend`：`readonly kv: KvFacet`，构造
  `(pool: MemoryMediaPool = new MemoryMediaPool())`，实现 `close()`。
- 该文件位于 `tests/`（**不随包发布**），DSH 其它包（如 workspace）的测试通过**相对路径
  import** 复用；sandore 测试需要**自行复制一份同构的内存 backend**，或改用
  `SqliteStorageBackend(':memory:')`。

#### 4.2 用 DomainFacility + MemoryStorageBackend 组装测试 harness

文件：`D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\tests\domain.spec.ts`

```typescript
async function harness(options?) {
  const ctx = new Context()
  await ctx.plugin(Storage)                                  // 来自 @deepseek-ai/dsh-storage
  const backend = new MemoryStorageBackend(options?.pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {}, ...options?.config })
  ctx.storage.mount('domain', facility)                      // 挂载（使 domain/changed 事件 invariant 生效）
  return { ctx, backend, facility }
}

// 用法：
const domain = await facility.open(spec)
const table = domain.table('items')
await table.put('a', { label: 'x', count: 1 })
await table.put('b', { label: 'y', count: 2 })
expect(table.size).toBe(2)
expect([...table.keys()].sort()).toEqual(['a', 'b'])
expect(new Map(table.entries()).get('a')).toEqual({ label: 'x', count: 1 })
await expect(table.update('ghost', v => v)).rejects.toMatchObject({ code: 'missing-key' })
await expect(table.delete('a')).resolves.toBe(true)
await expect(table.delete('a')).resolves.toBe(false)
```

对 crud-02 测试的启示：可构造一个 `DomainFacility`（或直接用 `new DomainFacility(ctx, { backend: 'memory' })`
且不 mount，domain.spec.ts 中「routeless」用例证明 unmounted facility 也能 `open`），
把它作为 `ctx.storageDomain` 的 mock 注入给 `persistence.ts`/`remote.ts`；或提供 fake
`ctx.storageDomain = { open: (spec) => facility.open(spec) }`。

#### 4.3 SqliteStorageBackend(':memory:')（design.md 提到的替代）

文件：`D:\project-code\llm\deepseek-harness\packages\storage\storage-sqlite\src\index.ts`

```typescript
export interface Config {
  path: string                    // ':memory:' 打开进程内数据库（测试用）
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // 默认 'wal'
}
export class SqliteStorageBackend implements StorageBackend {
  readonly kv: KvFacet
  constructor(config: Config)
  close(): Promise<void>
}
```

注册方式（`apply`）：`ctx.storage.backend.register('sqlite', backend)`，`backend = new SqliteStorageBackend({ path: ':memory:' })`。

---

### 5. 设计文档关键规格（RPC 清单与范围）

文件：`D:\project-code\llm\sandore\docs\design\task-2-minimal-engine\design.md`（§6.1/§6.2）
与 `D:\project-code\llm\sandore\docs\design\overall-design.md`（§4.3.1/§7.3）。

Host RPC 完整清单（design.md §6.2 表格，Task 2 范围子集）：

| 方法 | 对应原 REST |
|---|---|
| `listDefinitions` / `createDefinition` / `updateDefinition` / `deleteDefinition` / `getYaml` / `updateYaml` | `/api/workflows/defines/*` |
| `listJobs` / `createJob` / `getJob` / `updateJob` / `deleteJob` | `/api/workflows/jobs/*` |
| `listInstances` / `startInstance` / `deleteInstance` / `getInstanceState` / `abortInstance` | `/jobs/:id/instances/*` |
| `getArtifacts` | `.../artifacts` |
| `listProviders` / `listModels` | `/providers/*` |

- **决策 D2**：`ctx.sandoreEngine` Service 层只暴露 11 个实例级操作；定义/Job CRUD 放在
  Host RPC 层（`workflow` 包的 `remote.ts`）。
- 端点全名 = `sandore.<method>`（如 `sandore.listDefinitions`），前端 `host.call('sandore.listDefinitions', {})`。
- 原 CRUD 函数签名（design.md §4.4–§4.7，来自 dynamic-workflow-engine §19.6）：
  - 定义：`createWorkflowDef(data) → WorkflowRecord`、`listWorkflowDefs() → WorkflowRecord[]`、
    `getWorkflowDef(id) → WorkflowRecord & { yaml }`、`updateWorkflowDef(id, data) → WorkflowRecord`、
    `deleteWorkflowDef(id) → void`、`getWorkflowYaml(id) → string`、`updateWorkflowYaml(id, yaml) → void`。
  - Job：`createJobDef(data) → JobRecord`（自动 UUID，校验 workflowId 存在）、
    `listJobDefs(workflowId?) → JobRecord[]`、`getJobDef(id) → JobRecord`、
    `updateJobDef(id, data) → JobRecord`、`deleteJobDef(id) → void`。
  - 实例：`listInstances(jobId)`、`startInstance(jobId, data)`、
    `deleteInstance(jobId, instanceId)`、`getInstanceState(jobId, instanceId) → WorkflowTaskState`、
    `abortInstance(jobId, instanceId) → { instanceId, status }`。
  - 产物：`getInstanceArtifacts(jobId, instanceId, stageId?) → InstanceArtifactsData`。
- 存储域三表映射（overall-design.md §4.3.1 / design.md §4.1 D4）：
  - `definitions` key=`workflowId`（`wfl-{uuid}`），value=`WorkflowDefinitionRecord`（YAML 文本 + 元数据）。
  - `jobs` key=`jobId`，value=`JobRecord`。
  - `state` key=`instanceId`（如 `20250720-143000-abc`），value=`WorkflowTaskState`（全量覆盖写）。
  - 实例清单从 `state` 表派生（`entries()`/`keys()`）。
- 验证标准（work.md/design.md §7）：RPC 创建/列出/删除定义与 Job；`startInstance` 创建实例并写
  `state` 快照；`getInstanceState` 读回；测试用 `vitest` + 内存 mock storageDomain。

---

### 6. 实现依据小结（事实，非方案）

1. **`sandoreDomainSpec` 已存在**（`schema.ts`），`persistence.ts` 直接 `import { sandoreDomainSpec } from './schema.ts'` 复用。
2. **Record 类型已存在**：`WorkflowDefinitionRecord` / `JobRecord` / `WorkflowTaskState` 均由 `z.infer` 派生并导出。
3. **打开域范式**（WorkspaceRegistry / message-feedback）：`[Service.init]` 内
   `const domain = await this.ctx.storageDomain.open(spec)` → `this.ctx.effect(() => () => domain.close(), label)`
   （或异步 disposer）→ `this.table = domain.table('...')`。
4. **@Remote CRUD 范式**（message-feedback / goal）：类继承 `TypertRemoteService`，
   `super(ctx, 'sandore')`，方法加 `@Remote('name')`；读 `table.get`，写 `await table.put`，
   删 `await table.delete`，原子改 `await table.update`。
5. **KvTable 精确签名** 见 §3.3（`get/entries/keys/size/put/delete/update`）。
6. **`listProviders`/`listModels`** 直接复用 `ctx.llm.listProviders()`（同步，`{id,name}[]`）与
   `ctx.llm.listModels(provider)`（异步，`Promise<LlmModelInfo[]>`）。
7. **测试 mock**：DSH 的 `MemoryStorageBackend` 在 `tests/helpers/` 不发布，sandore 测试需
   自备等价内存 backend（或 `SqliteStorageBackend({ path: ':memory:' })`），再用
   `DomainFacility` 组装 `ctx.storageDomain`。
