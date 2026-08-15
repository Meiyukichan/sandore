# Furina Explore — specification 探索结果

## Explore Content（需求理解）

### What
为 sandore DAG 工作流引擎落地 DSH 插件的 Task 2 第一步「schema-01（类型体系与 YAML 解析）」：在 `packages/sandore/workflow/` 内实现 `errors.ts`（`SandoreError extends HarnessError`，带 `fatal` 标志，对齐 DSH `HarnessError`/`WorkflowError`）、`schema.ts`（三层 Zod Schema：定义层 CommandConfig 五类型 discriminated union、运行时 `WorkflowTaskState`（无 `permissionMode`）、存储层 `sandoreDomainSpec` 用 `defineDomain`/`domainTable<K,V>`）、`yaml-parser.ts`（V1 三级 Stage→Scenario→Task 自动 `convertLegacyToV2` 转 V2 两级 Stage→Step；V2 YAML 示例见 `docs/engine/dynamic-workflow-engine.md` 附录 A）。本探索只做研究理解，不写任何实现代码。

### Boundaries
范围锁定在「DSH 参考实现范式」+「sandore 权威规格」，共 5 个具体问题：
1. `SandoreError` 的精确形状——`HarnessError` 基类（`@deepseek-ai/dsh-llm`）与 `WorkflowError` 的 `fatal` 标志范式。
2. `CommandConfig` 五类型 discriminated union 的判别字段结构（顶层 `type`、变体字段嵌套 `value`）。
3. `WorkflowTaskState` 字段清单（权限修正后**无 `permissionMode`**），及 `ExecutedStepDefault`/`StepSessionMeta` 的收紧结构。
4. `sandoreDomainSpec` 的 `defineDomain`/`domainTable<K,V>` 精确写法（三表 `definitions`/`jobs`/`state`）。
5. `yaml-parser.ts` 的 V1/V2 双格式检测与 `convertLegacyToV2` 转换，以及 DSH 中 YAML 解析的精确用法（`yaml` 包 `parseDocument` + `YAMLError`）。

### Goal
为 `docs/design/task-2-minimal-engine/work.md` 与 `design.md`、`furina/changes/task-2-minimal-engine/specs/engine-schema/spec.md` 中的 schema-01 需求提供准确、可落地的 DSH 参考范式依据（精确文件路径 + 代码形状），确保编码时错误层级、Zod Schema、存储域 spec、YAML 解析与 DSH 先例对齐。

---

## 关键结论速览

| 议题 | 权威/参考源（绝对路径） | schema-01 落点 |
|---|---|---|
| `HarnessError` 基类（`code` + `cause` + `name=new.target.name`） | `D:\project-code\llm\deepseek-harness\packages\llm\llm\src\error.ts` | `errors.ts` 的 `SandoreError` 基 |
| `WorkflowError` 的 `fatal` 标志范式（`options?.fatal ?? true` + `isFatalWorkflowError`） | `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`（L108-148） | `SandoreError extends HarnessError` + `fatal` |
| `defineDomain`/`domainTable<K,V>` 精确 API | `D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\spec.ts`、`src\index.ts`、`src\domain.ts` | `schema.ts` 的 `sandoreDomainSpec` |
| `defineDomain` 实例（先例） | `packages\workspace\workspace\src\spec.ts`、`packages\feedback\message-feedback\src\spec.ts` | 三表 `definitions`/`jobs`/`state` |
| 域名/表名校验正则 `UNIT_NAME_RE` | `D:\project-code\llm\deepseek-harness\packages\storage\storage\src\backend.ts`（`/^[a-z][a-z0-9_]*$/`） | `sandore`/`definitions`/`jobs`/`state` 全部匹配 |
| YAML 解析精确用法（`yaml` 包 `parseDocument`/`YAMLError`） | `packages\skill\skill-filesystem\src\index.ts`（`parse as parseYaml`）、`packages\credentials\credentials-local\src\index.ts`（`parseDocument` + `describeYamlError`）、`packages\settings\settings-file\src\index.ts` | `yaml-parser.ts` |
| V2 YAML 全字段示例（5 种 CommandConfig 判别结构） | `D:\project-code\llm\sandore\docs\engine\dynamic-workflow-engine.md` 附录 A.1（L5095-5295） | `WorkflowDefinitionSchema.parse()` 验证目标 |
| V1 YAML 三级结构 + `convertLegacyToV2` | 同上 附录 A.2（L5297-5325） | V1 自动转换 |
| `WorkflowTaskState` 权限修正字段清单 | `docs\design\overall-design.md` §4.3.1（L282-304）、`specs\engine-schema\spec.md` | 无 `permissionMode`/`userChatMessages`/`defaultSessionMeta`/`pausedChildIds` |
| schema-01 权威验收规格 | `D:\project-code\llm\sandore\furina\changes\task-2-minimal-engine\specs\engine-schema\spec.md` | 编码/测试直接对齐 |

---

## 1. errors.ts — SandoreError 范式（对齐 DSH HarnessError/WorkflowError 的 fatal 标志）

### 1.1 参考源
- `D:\project-code\llm\deepseek-harness\packages\llm\llm\src\error.ts`（`HarnessError` 基类）
- `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`（`WorkflowError extends HarnessError` + `fatal` + `WorkflowErrorCode` + `isFatalWorkflowError`）

### 1.2 `HarnessError` 基类（`@deepseek-ai/dsh-llm` 导出）

```ts
export class HarnessError extends Error {
  /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
  readonly code: string
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name   // name 默认取子类构造函数名
  }
}
```

关键约定：
- `code` 是稳定、可编程路由的失败类（区别于人类可读的 `message`）；`message` 之外的 `cause` 链通过标准 `ErrorOptions` 支持。
- `name` 默认 `new.target.name`（即子类名）；DSH 内部 `HarnessError` 从 `@deepseek-ai/dsh-llm` 导出（`packages/workflow/workflow/src/index.ts` 顶部 `import { HarnessError } from '@deepseek-ai/dsh-llm'`）。
- 同文件还导出 `isHarnessError(value): value is HarnessError`（`instanceof` 窄化）与 `errorChain(value)`（渲染 cause 链，仅诊断用，勿 parse）。

### 1.3 `WorkflowError` 的 `fatal` 标志范式（schema-01 直接照抄形状）

```ts
export type WorkflowErrorCode =
  | 'SCRIPT_PARSE'
  | 'META_INVALID'
  | 'INVALID_ARGUMENT'
  // ...（closed union）

export class WorkflowError extends HarnessError {
  /** Whether combinators must propagate this error instead of nulling the item. */
  readonly fatal: boolean
  constructor(message: string, code: WorkflowErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'WorkflowError'
    this.fatal = options?.fatal ?? true   // 默认 fatal=true
  }
}

export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal
}
```

关键约定（schema-01 的 `SandoreError` 应对齐）：
- `SandoreError extends HarnessError`（不是 `extends Error`），从而 `instanceof HarnessError` 为真（spec 验收：`error instanceof HarnessError` 且 `error.fatal === true`）。
- `readonly fatal: boolean`，构造器第三参 `options?: ErrorOptions & { fatal?: boolean }`，`this.fatal = options?.fatal ?? true`（**默认 fatal**）。
- 显式 `this.name = 'SandoreError'`（或复用 `new.target.name`）。
- `code` 类型为 closed union `SandoreErrorCode`（spec `engine-schema` 指定：`YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`CANCELLED`/`PERSISTENCE_FAILED`，Task 2 只用子集）。
- 可选导出 `isFatalSandoreError(error): boolean`（`error instanceof SandoreError && error.fatal`），供调度层 catch 点区分「致命传播 vs 单项置 null」。

> 设计文档背景：`docs/engine/dynamic-workflow-engine.md` §19.3/§20.1 描述原 sandore 的 SDK 层错误层级 `WorkflowError → NotFoundError/ConflictError/ValidationError/InvalidStateError`（`code: NOT_FOUND/CONFLICT/VALIDATION/INVALID_STATE`）。但 **DSH 化后**（spec `engine-schema` Requirement: SandoreError）统一为一个 `SandoreError extends HarnessError` + `SandoreErrorCode` 联合 + `fatal` 标志，不再继承原 SDK 四子类层级——编码以 spec `engine-schema` 为准。

---

## 2. schema.ts — 三层 Zod Schema

> 关键 split（DSH 先例明确，见 `packages/storage/storage-domain/src/index.ts` 顶部注释）：**域 record schema 用 `zod`（`z` from `'zod'`，`z.infer` 派生类型），插件 `Config` 用 schemastery**。sandore `workflow` 包现有 `static Config` 用 `z from '@deepseek-ai/schemastery'`（`src/index.ts`），而 `schema.ts` 的 record schema 用 `import { z } from 'zod'`（sandore lockfile 已可解析 `zod@4.4.3`，为 `@deepseek-ai/dsh-storage-domain` 的依赖）。

### 2.1 定义层 — CommandConfig 五类型 discriminated union

**判别字段结构**（spec `engine-schema` + 附录 A.1 权威 YAML）：判别字段为**顶层 `type`**，变体字段**嵌套于 `value`**：

```yaml
command:
  type: shell
  value:
    command: "npm run lint 2>&1"
```

五种变体（字段表，来源 `docs/design/task-2-minimal-engine/design.md` §2.1）：

| 类型 | `value` 内字段 | 用途 |
|------|------|------|
| `agent` | `promptText`（Agent 名称）+ `agentParamsTemplate?` + `providerId?` + `modelId?` | AI Agent + 自动参数填充 |
| `prompt` | `promptText` + `providerId?` + `modelId?` | 纯提示词模板 |
| `shell` | `command` | Shell 命令执行 |
| `skill` | `promptText`（Skill 名称） | 技能调用 |
| `mcp` | `promptText`（MCP 名称） | MCP 工具调用 |

Zod 形状（discriminated union，判别字段顶层 `type`）：
```ts
const commandConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent'),  value: z.object({ promptText: z.string(), agentParamsTemplate: z.string().optional(), providerId: z.string().optional(), modelId: z.string().optional() }) }),
  z.object({ type: z.literal('prompt'), value: z.object({ promptText: z.string(), providerId: z.string().optional(), modelId: z.string().optional() }) }),
  z.object({ type: z.literal('shell'),  value: z.object({ command: z.string() }) }),
  z.object({ type: z.literal('skill'),  value: z.object({ promptText: z.string() }) }),
  z.object({ type: z.literal('mcp'),    value: z.object({ promptText: z.string() }) }),
])
export type CommandConfig = z.infer<typeof commandConfigSchema>
```

> **V2.4 变更**：`agent` 类型从旧 `agentTemplate` 改为 `promptText` 存 Agent 名称；`skill`/`mcp` 用 `promptText` 存对应名称。旧版 `PromptConfig`（`AgentTemplate`/`PromptTemplate`/`Bash`/`SkillTemplate`/`McpTemplate`）仍兼容，由 `commandToPromptType()`/`promptToCommandType()` 转换（对应 `prompt↔PromptTemplate`、`shell↔Bash`、`agent↔AgentTemplate`、`skill↔SkillTemplate`、`mcp↔McpTemplate`，见 `dynamic-workflow-engine.md` §3.1 L352-364）——Task 2 仅 shell/prompt 执行，但 Schema 需定义全部五类型。

**定义层其余 Schema**（spec `engine-schema` Requirement: Zod Schema 定义层）：
- `WorkflowDefinitionSchema`：`id`/`name`/`version`/`description`/`engine?`/`skills`/`mcps`/`agents`/`settings`/`rules?`/`gates?`/`stages`/`steps?`。
  - `settings: WorkflowSettings = { defaultTimeout: number(默认120), maxConcurrentAgents: number(默认4) }`（`DEFAULT_SETTINGS` 来自 `design.md` §2.1 L163-172）。
- `WorkflowStageSchema`：`id`/`name`/`rules?`/`gates?`/`steps`/`next?`/`defaultExpectation?`/`condition?`/`branches?`/`loop?`。
- `WorkflowStepSchema`：`id`/`name`/`command?`/`inputFrom`/`outputTo`/`passThroughVars`/`timeout`/`next`/`defaultExpectation?`/`condition?`/`branches?`/`loop?`/`rules?`/`gates?`。

辅助类型（`design.md` §2.1/§2.3）：
- `DagBranch = { expectation?: string; next: string; label?: string }`（省略 `expectation` = 并行分支）。
- `DagLoop = { breakCondition?: CommandConfig; breakExpectation?: string; next?: string; maxIterations: number; exitTo?: string }`。
- `InputFromItem = { id: string; path?: string; regex?: string }`（附录 A.1 示例同时展示 `path` 与 `regex` 两种）。
- `OutputToItem = { id: string; path?: string; regex?: string }`。
- `PassThroughVar = { name: string; value: string; description: string; refresh?: boolean }`（V2.4.2 新增 `refresh`）。
- `Gates = { maxRetries?: number; maxTokens?: number; primary?: { enabled: boolean }; secondary?: { enabled: boolean; prompt?: string }; need_confirm?: boolean }`。
- `rules`：workflow 级为 `Record<string, string>` 键值对；stage/step 级为 `string[]` 键引用数组（指向 workflow.rules 键）。

### 2.2 运行时 — WorkflowTaskState（无 permissionMode）

spec `engine-schema` Requirement: WorkflowTaskState 权威字段清单：

```
taskId / jobId / workflowId / cwd
status / originalInput / currentStageId
executedSteps[] / stageInfos[] / pendingInteractions / pendingQueue[]
visitCounts / passThroughVars
activeLoopIterationStack[] / activeLoopNodeId / activeLoopStack[] / pausedStepIds[]
stageContracts / createdAt / updatedAt
```

**权限修正明确排除**（spec 验收 Scenario「权限修正字段不存在」）：
- **无 `permissionMode`**（原 V2.3 字段，`design.md` §2.2 L196 仍列出，但 `work.md` 关键决策 + `overall-design.md` §4.3.1 L295 标注「迁移到 DSH 后废弃：权限由宿主 Session 的 permission preset 决定，Step 子代理继承父级」）。
- 无 `userChatMessages`、无 `defaultSessionMeta`（`overall-design.md` §4.3.1 L301-302 标注迁移后废弃）。
- 无 `pausedChildIds`（暂停登记表为 Task 4 范围，spec `engine-schema` 明确排除）。

`ExecutedStepDefault` 收紧（Task 1 已在 `packages/sandore/workflow/src/types.ts` 声明占位 `unknown` 的 13 个基础类型，接口名不变）：
- Task 2 收紧时新增 `output?: ContentBlock[]`（shell 的 `stdout.text` 包装为 text block、prompt 的聚合 block 数组，与 `sandore/step-completed` 事件载荷 `output: ContentBlock[]` 一致，`import type { ContentBlock } from '@deepseek-ai/dsh-llm'`）。

**StepSessionMeta 合成占位结构**（spec `engine-schema` Requirement，替代 SDK 时代 `{sessionId, inputJson, outputJson, partsJson}`）：
```ts
StepSessionMetaSchema = z.object({
  childId: z.string(),
  synthetic: z.boolean(),
  command: z.enum(['shell', 'prompt', 'agent', 'skill', 'mcp']),
})
```
- 占位规则（`work.md` 关键决策）：`childId = step-{stepId}-{execId}`（`execId` = 本次执行唯一短 id，如 `randomUUID().slice(0, 8)`）；shell/prompt 无子代理，`synthetic: true`；Task 3 agent 用真实 SessionId，`synthetic: false`。

### 2.3 存储层 — sandoreDomainSpec（defineDomain/domainTable<K,V>）

**参考源 API 形状**（`packages/storage/storage-domain/src/spec.ts`）：
```ts
import type { ZodType } from 'zod'
import { UNIT_NAME_RE, type KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

export interface DomainTableSpec<K extends string = string, V = unknown> {
  readonly valueSchema: ZodType<V>
  readonly __key?: K          // 幻影 key 类型载体，运行时不存在
}
export interface DomainSpec {
  readonly name: string       // 须匹配 UNIT_NAME_RE
  readonly version: number
  readonly global?: DomainGlobalSpec<unknown>
  readonly tables: Record<string, DomainTableSpec>
}
export function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V> {
  return { valueSchema: schema }
}
export function defineDomain<S extends DomainSpec>(spec: S): S {
  // 校验 name/version(非负整数)/各表名/global 不接受 null，失败 loud 抛错
  return spec
}
```

**`UNIT_NAME_RE`**（`packages/storage/storage/src/backend.ts` L10，`@deepseek-ai/dsh-storage` 导出）：
```ts
export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
```
→ `sandore`/`definitions`/`jobs`/`state` 全部匹配（spec 验收 Scenario「域名与表名合法」）。

**先例实例**（`packages/workspace/workspace/src/spec.ts`、`packages/feedback/message-feedback/src/spec.ts`）：
```ts
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: { schema: workspaceDomainState, initial: { ... } },   // 可选 global 单例
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
```

**schema-01 的 sandoreDomainSpec**（spec `engine-schema` Requirement: 存储层 Schema，三表 value）：
```ts
// 三表 value schema：
//   WorkflowDefinitionRecordSchema = z.object({ yaml: z.string().max(65536), name, version, description?, createdAt, updatedAt })
//   JobRecordSchema              = z.object({ name, workflowId, cwd?, createdAt, updatedAt })
//   state 表 value 直接用 WorkflowTaskStateSchema
export const sandoreDomainSpec = defineDomain({
  name: 'sandore',
  version: 1,
  tables: {
    definitions: domainTable<string, WorkflowDefinitionRecord>(workflowDefinitionRecordSchema),
    jobs:        domainTable<string, JobRecord>(jobRecordSchema),
    state:       domainTable<string, WorkflowTaskState>(workflowTaskStateSchema),
  },
})
```

> 注意：`overall-design.md` §4.3.1 草图里 `WorkflowDefinitionRecordSchema` 注释为 `{ yaml, name, version, engine, skills, mcps, agents, rules, gates, createdAt, updatedAt }`（源自原 SQLite `WorkflowRecord`，见 `dynamic-workflow-engine.md` L4685-4700）；但 **spec `engine-schema` 是更新的权威要求**：`{ yaml: string (max 65536), name, version, description?, createdAt, updatedAt }`（YAML 文本作为 JSON string 存 value，`z.string().max(65536)` 设上限防失控，先例 `message-feedback` note 封顶 8KB）。编码以 spec 为准。

**三表语义**（`docs/design/dsh-workflow.md` §5.4 / `design.md` §4.1）：
| 表 | key | value | 用途 |
|---|---|---|---|
| `definitions` | `workflowId`（`wfl-{uuid}`） | `WorkflowDefinitionRecord`（YAML 文本 + 元数据） | `entries()` 列全部定义 |
| `jobs` | `jobId`（uuid） | `JobRecord` | `entries()` 列全部 Job |
| `state` | `instanceId`（如 `20250720-143000-abc`） | `WorkflowTaskState` 快照 | 全量覆盖写入，崩溃恢复整体读出 |

**Domain 打开与表句柄**（`packages/storage/storage-domain/src/domain.ts`）——Task 2 后续 `persistence.ts` 会用到，schema-01 只需 spec：
```ts
export interface KvTable<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}
export interface Domain<S extends DomainSpec> {
  readonly name: string
  readonly global: DomainGlobalHandleOf<S>
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>
  close(): Promise<void>
}
// 打开：const domain = await ctx.storageDomain.open(sandoreDomainSpec)
// 取值：const defs = domain.table('definitions')  →  defs.get(id) / defs.entries()
```

---

## 3. yaml-parser.ts — V1/V2 双格式 + convertLegacyToV2

### 3.1 DSH 中 YAML 解析的精确用法

DSH 使用 **`yaml` 包（eemeli/yaml）**，不是 `js-yaml`（sandore lockfile 目前只有 `js-yaml@4.3.1`，为 `@deepseek-ai/cordis-plugin-include` 的依赖；`yaml` 包需 schema-01 新增为直接依赖）。

三种参考用法：
- `packages/skill/skill-filesystem/src/index.ts` L20/L918：`import { parse as parseYaml } from 'yaml'` → `parseYaml(yaml) as unknown`。
- `packages/settings/settings-file/src/index.ts` L15：`import { Document, parseDocument } from 'yaml'`。
- `packages/credentials/credentials-local/src/index.ts` L43/L160-164（spec `engine-schema` 指定的 `parseDocument(text, { prettyErrors: true })` 范式）：

```ts
import { Document, parseDocument, type YAMLError } from 'yaml'

function describeYamlError(error: YAMLError): string {
  const at = error.linePos?.[0]
  const where = at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`
  return `${error.code}${where}`
}

const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
if (document.errors.length > 0) {
  throw new Error(`invalid document: ${document.errors.map(describeYamlError).join('; ')}`)
}
```

要点（schema-01 对齐）：
- `parseDocument(text, { prettyErrors: true })` 返回 `Document`，其 `document.errors: YAMLError[]` 收集语法错误（`prettyErrors` 才填充 `linePos`，`error.code` + `error.linePos[0].line/col`）。
- **不要**直接 `parse()`（其 `throws`）；用 `parseDocument` + 检查 `.errors`，再 `document.toJS()` 得 JS 值。
- spec `engine-schema` 要求：YAML 语法错误抛 `SandoreError('YAML_PARSE')`（message 含行列信息，可用 `describeYamlError` 形状）；Zod 验证失败抛 `SandoreError('DEFINITION_INVALID', { cause })`。

### 3.2 V2 格式（附录 A.1，L5095-5295）——判别结构权威示例

- 顶层：`id`/`name`/`version`/`description`/`engine`/`skills[]`/`mcps[]`/`agents[]`/`settings{defaultTimeout,maxConcurrentAgents}`/`rules{...}`/`gates{...}`/`stages[]`/`steps[]`。
- `stages[].steps[]` 仅含 **ID + 流控字段**（`id`/`next`/`defaultExpectation`/`condition`/`branches`/`loop`），Step 完整定义放**顶层 `steps[]`**，通过 ID 交叉引用。
- 5 种 CommandConfig 判别结构（见 §2.1）：`command: { type: shell|prompt|agent|skill|mcp, value: {...} }`。
- 简化「shell Step → prompt Step」线性工作流的 V2 最小示例（验证标准用的形态）：
```yaml
id: wfl-xxx
name: demo
version: "1.0.0"
description: shell -> prompt
stages:
  - id: stg-1
    name: 分析
    steps:
      - id: step-1
        next: step-2
  - id: stg-2
    name: 推理
    steps:
      - id: step-2
steps:
  - id: step-1
    name: lint
    command: { type: shell, value: { command: "npm run lint 2>&1" } }
  - id: step-2
    name: 报告
    command: { type: prompt, value: { promptText: "生成报告", providerId: ..., modelId: ... } }
```

### 3.3 V1 格式（附录 A.2，L5297-5325）——三级 Stage→Scenario→Task

```yaml
id: code-review-workflow
name: 代码审查工作流
version: "1.0.0"
settings:
  defaultTimeout: 60
stages:
  - id: stg-analyze
    name: 代码分析
    scenarios:
      - id: sce-static-analysis
        name: 静态分析
        tasks:
          - id: tsk-lint
            name: 代码规范检查
            prompt:            # ← V1 用 prompt（PromptConfig），type 为大写旧名
              type: Bash
              value:
                command: "npm run lint 2>&1"
            outputTo:
              - id: opt-lint-report
                path: "reports/lint.txt"
        next: sce-deep-review
```

- V1 三级：`Stage → scenarios[] → tasks[]`；V2 两级：`Stage → steps[]`。
- V1 的 Step 用 `prompt`（`PromptConfig`，type 为大写 `Bash`/`PromptTemplate`/`AgentTemplate`/`SkillTemplate`/`McpTemplate`），V2 用 `command`（`CommandConfig`，type 为小写 `shell`/`prompt`/`agent`/`skill`/`mcp`）。
- 解析器通过 `convertLegacyToV2()` 自动转换（spec `engine-schema`）：Scenario 展平为 Step（Task 合并进 `steps[]`，Scenario 元数据并入 Step），转换后走同一 V2 验证路径；转换含 `promptToCommandType()`（`Bash→shell` 等）。
- spec 验收：同一 stage 同时含 `steps[]` 与 `scenarios[]` → 抛 `SandoreError('DEFINITION_INVALID')`（混合格式拒绝）。

### 3.4 parseWorkflowYaml 主流程（spec `engine-schema` Requirement）

```
parseWorkflowYaml(text): WorkflowDefinition
  1. yaml.parseDocument(text, { prettyErrors: true })
     → document.errors.length > 0 → throw SandoreError('YAML_PARSE')
  2. 检测格式：stages 子节点含 steps[] = V2；含 scenarios[] = V1
  3. V1 → convertLegacyToV2() 转两级
  4. WorkflowDefinitionSchema.parse() 验证（失败 → SandoreError('DEFINITION_INVALID', { cause })）
  5. 引用完整性校验：next / inputFrom / outputTo 引用的节点 ID 存在（失败 → SandoreError('DEFINITION_INVALID')）
serializeWorkflowYaml(def): string   // 序列化，round-trip 可再 parse 且深层相等
```

---

## 4. 附：schema-01 涉及的关键 DSH 依赖与落点对照

| 依赖包 | 用途 | 现状（sandore） |
|---|---|---|
| `@deepseek-ai/dsh-llm`（`HarnessError`、`ContentBlock`） | `errors.ts` 基类 + `ExecutedStepDefault.output` 类型 | 已是 `workflow` 包 peer/devDependency |
| `@deepseek-ai/dsh-storage-domain`（`defineDomain`/`domainTable`/`Domain`/`KvTable`） | `sandoreDomainSpec` | lockfile 已可解析 `0.1.0-rc.6`（作为 message-feedback/session-projection 等 peer），schema-01 需加为直接依赖 |
| `zod`（`z`/`z.infer`，`zod@4.4.3`） | `schema.ts` 三表 record schema | lockfile 已可解析（storage-domain 依赖），需加为直接依赖 |
| `yaml`（`parseDocument`/`YAMLError`，eemeli/yaml） | `yaml-parser.ts` | **lockfile 尚无**（仅 `js-yaml@4.3.1` 间接依赖），需加为直接依赖 |
| `@deepseek-ai/schemastery` | 插件 `Config`（`static Config`） | 已存在（`src/index.ts`），与 `zod` 分工不同源 |
