# schema-01（类型体系与 YAML 解析）— 代码库探索结果

> 探索类型：codebase（代码库材料探索）
> 探索对象：`docs/design/task-2-minimal-engine/work.md` 中 schema-01 的落点——`errors.ts`（SandoreError）、`schema.ts`（三层 Zod Schema）、`yaml-parser.ts`（V1/V2 双格式解析）
> 探索日期：2026-08-15

---

## Exploration Result

（Phase 3：furina-codebase explore）

`furina config show project.sourcecode codebases` 返回：

```
project.sourcecode=src/
codebases=[{"path":"docs/codebase","description":"codebase dir of current project, you MUST explore it when using optix-explore skill"}]
```

- `project.sourcecode` 指向 `src/`，该目录**不存在**；唯一 codebase 元素 `docs/codebase` 为**空目录**，无 `toc.md` 文档树，furina-codebase 的 explore 指令无对象可导航。**Phase 3 无匹配结果**，转入 Phase 4 手动补充探索。

---

## Supplementary Exploration Result

（Phase 4：手动补充探索 — 目标：DSH 的 HarnessError/WorkflowError/zod/storage-domain/yaml 精确用法 + sandore 规格中 schema-01 的字段级定义）

### 1. errors.ts —— SandoreError（对齐 DSH HarnessError / WorkflowError 的 fatal 标志）

#### 1.1 基类 `HarnessError`（DSH 源码精确签名）

来源：`D:\project-code\llm\deepseek-harness\packages\llm\llm\src\error.ts`（从 `@deepseek-ai/dsh-llm` 导出，`packages/llm/llm/src/index.ts` 第 36 行 `export * from './error.ts'`）。

```typescript
export class HarnessError extends Error {
  /** Stable machine-routable failure class (e.g. RATE_LIMIT); route on this, never by parsing message. */
  readonly code: string
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
```

关键点：
- 携带稳定 `code: string`（机器可路由），与人类可读 `message` 分离；`name` 默认取子类构造名。
- 通过标准 `ErrorOptions` 支持 `cause` 链式。

#### 1.2 `WorkflowError`（fatal 标志的精确范式）

来源：`D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts` 第 130–148 行。

```typescript
export class WorkflowError extends HarnessError {
  readonly fatal: boolean
  constructor(message: string, code: WorkflowErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'WorkflowError'
    this.fatal = options?.fatal ?? true   // ★ fatal 默认 true
  }
}

export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal
}
```

关键点（schema-01 的 SandoreError 必须对齐）：
- `fatal` 是 `readonly` 字段，**默认 `true`**（`options?.fatal ?? true`）；构造后显式 `this.name = 'WorkflowError'`。
- 配套 `isFatalWorkflowError(error): boolean` 守卫（`instanceof` + `error.fatal`），供 catch 点显式区分「致命（re-throw）」vs「普通 item 失败（null 化）」。
- `WorkflowErrorCode` 是字符串字面量联合（`'SCRIPT_PARSE' | 'META_INVALID' | ...`），注释明确「Every WorkflowErrorCode is fatal; the flag exists so the distinction is explicit at every catch site」。

#### 1.3 `SandoreError` 目标形态（规格已给出完整定义）

来源：`D:\project-code\llm\sandore\docs\design\overall-design.md` §4.4（第 325–360 行）。

```typescript
import { HarnessError } from '@deepseek-ai/dsh-llm'

export class SandoreError extends HarnessError {
  readonly fatal: boolean
  constructor(message: string, code: SandoreErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'SandoreError'
    this.fatal = options?.fatal ?? true
  }
}

export type SandoreErrorCode =
  // 定义/解析错误（fatal）
  | 'YAML_PARSE'              // YAML 解析失败
  | 'DEFINITION_INVALID'      // Zod 校验失败
  | 'NODE_NOT_FOUND'          // DAG 节点不存在
  | 'CYCLE_DETECTED'          // DAG 环检测
  // 运行时错误（fatal）
  | 'STEP_TIMEOUT'
  | 'STEP_EXECUTION'
  | 'FINALIZE_FAILED'
  | 'GATE_FAILED'
  // 恢复性错误（non-fatal）
  | 'SESSION_LOST'
  | 'PERSISTENCE_FAILED'
  // 操作错误
  | 'INVALID_OPERATION'
  | 'CANCELLED'
```

落点结论：
- `SandoreError extends HarnessError`，`HarnessError` 从 `@deepseek-ai/dsh-llm` 导入（该包已是 `packages/sandore/workflow/package.json` 的 peer/devDependency，版本 `0.1.0-rc.6`）。
- schema-01 直接相关的错误码是 `YAML_PARSE` 与 `DEFINITION_INVALID`（yaml-parser 抛的类型化错误）。
- overall-design §6.8 明确：DSH 的 `WorkflowError` 有 `fatal` 标志，`SandoreError` 应对齐此模式。

---

### 2. schema.ts —— 三层 Zod Schema

#### 2.1 关键前提：zod 与 schemastery 的分工（DSH 权威约定）

来源：`D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\spec.ts` 头注释 + `src\index.ts` 头注释。

- **record schema（存储域 valueSchema / 数据模型）用真实 `zod`**：`import { z } from 'zod'`，zod 版本 `^4.4.3`（`packages/storage/storage-domain/package.json`、`packages/host/apiproxy/package.json` 均 `"zod": "^4.4.3"`）。
- **插件 `Config` 用 schemastery**：`import z from '@deepseek-ai/schemastery'`。
- 分工原文（spec.ts）：*「Record schemas are zod（`z.infer` keeps types un-duplicated and the same schemas later project to RPC wire schemas）; plugin `Config` stays schemastery.」*

落点结论：`schema.ts` 的三层 schema（CommandConfig / WorkflowTaskState / 域表 record schema）**全部用 `zod`**（`z.object` / `z.discriminatedUnion` / `z.infer`），**不用 schemastery**。当前 `packages/sandore/workflow/src/index.ts` 里的 `z`（schemastery）只用于 `static Config`，二者可共存于不同模块。

#### 2.2 第一层：`CommandConfig` 五类型 discriminated union（判别字段顶层 `type`、变体字段嵌套 `value`）

**这是 exploreContent 的核心精确点，与 design.md §2.1 的扁平表格不同**——真实结构从 `docs/engine/dynamic-workflow-engine.md` 附录 A（第 5093–5295 行）的 YAML 逐字段确认：

```yaml
command:
  type: shell
  value:
    command: "npm run lint 2>&1"
```

五变体字段明细（附录 A YAML 全覆盖）：

| `type` | `value` 字段 | 备注 |
|---|---|---|
| `shell` | `{ command: string }` | 命令文本 |
| `prompt` | `{ promptText: string; providerId?: string; modelId?: string }` | 纯提示词 |
| `agent` | `{ promptText: string; agentParamsTemplate?: string; providerId?: string; modelId?: string }` | `promptText` = Agent 名称（须在 `agents` 数组） |
| `skill` | `{ promptText: string; providerId?: string }` | `promptText` = Skill 名称 |
| `mcp` | `{ promptText: string }` | `promptText` = MCP 名称 |

对应的 zod 形态（判别字段顶层 `type`、变体字段整体嵌套 `value`）：

```typescript
export const commandConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shell'),  value: z.object({ command: z.string() }) }),
  z.object({ type: z.literal('prompt'), value: z.object({
    promptText: z.string(), providerId: z.string().optional(), modelId: z.string().optional(),
  }) }),
  z.object({ type: z.literal('agent'),  value: z.object({
    promptText: z.string(), agentParamsTemplate: z.string().optional(),
    providerId: z.string().optional(), modelId: z.string().optional(),
  }) }),
  z.object({ type: z.literal('skill'),  value: z.object({ promptText: z.string(), providerId: z.string().optional() }) }),
  z.object({ type: z.literal('mcp'),    value: z.object({ promptText: z.string() }) }),
])
```

`z.discriminatedUnion('type', [...])` 的 DSH 参考用法见 `D:\project-code\llm\deepseek-harness\packages\host\apiproxy\src\api\events.schema.ts`（第 43–67 行 `z.discriminatedUnion('type', [...])` 等），以及 `workspace/src/spec.ts` 第 37 行 `z.discriminatedUnion('operation', [...])`。

**V1 legacy `PromptConfig`（旧类型名，供 convertLegacyToV2 使用）**：`PromptTemplate` / `Bash` / `AgentTemplate` / `SkillTemplate` / `McpTemplate`（首字母大写，同样 `type` 顶层 + `value` 嵌套）。附录 A.2 V1 YAML 示例：

```yaml
tasks:
  - id: tsk-lint
    name: 代码规范检查
    prompt:
      type: Bash
      value:
        command: "npm run lint 2>&1"
```

类型互转（dynamic-workflow-engine.md §3.1）：
- `commandToPromptType(cmd): PromptConfig`：`prompt → PromptTemplate`、`shell → Bash`、`agent → AgentTemplate`、`skill → SkillTemplate`、`mcp → McpTemplate`、其他 → `PromptTemplate`。
- `promptToCommandType(prompt): CommandConfig`：反向（`Bash → shell` 等）。

#### 2.3 第二层：`WorkflowTaskState`（无 `permissionMode`）

来源：`docs/design/task-2-minimal-engine/design.md` §2.2（第 174–205 行）+ `docs/design/overall-design.md` §4.3.1（第 282–306 行）。

**无 `permissionMode`**：design.md §2.2 原文列有 `permissionMode: 'bypassPermissions' | 'acceptEdits' | 'default'`（V2.3 新增），但 work.md「权限修正」+ overall-design §4.3.1（第 295 行）明确标记「迁移到 DSH 后废弃：权限由宿主 Session 的 permission preset 决定，Step 子代理继承父级」。schema 中**不设该字段**。

字段清单（迁移后形态，overall-design §4.3.1 第 285–303 行）：

```
WorkflowTaskState
  ├── taskId (= instanceId), jobId, workflowId, cwd
  ├── status: DagRunStatus（7 种：pending|running|interacting|completed|failed|aborted|paused）
  ├── originalInput: string
  ├── currentStageId: string
  ├── executedSteps[]: ExecutedStepDefault（扁平数组）
  ├── stageInfos[]: StageInfo（全量 stage 列表）
  ├── pendingQueue[]: string
  ├── visitCounts: Record<string, number>（仅 loop 节点）
  ├── passThroughVars: Record<string, { value, description, refresh? }>
  ├── activeLoopStack[]: string
  ├── activeLoopIterationStack[]: number
  ├── pausedStepIds[]: string
  ├── stageContracts: Record<string, StageContract>（V2.6）
  ├── pausedChildIds: string[]           ← 迁移后改名（暂停登记表）
  ├── defaultSessionMeta?: …             ← 迁移后废弃（D9）
  ├── userChatMessages[]: …              ← 迁移后废弃（用户消息由宿主 Session log 承载）
  └── createdAt, updatedAt
```

- `ExecutedStepDefault` 已在 Task 1 `packages/sandore/workflow/src/types.ts` 里定形（含 `type:'default'`、`stepId?`、`stageId`、`name`、`status`、`command?`、`inputFrom?`、`outputTo?`、`passThroughVars?`、`sessionMeta?`、`finalizeMeta?`、`visitCount`、`branchMeta?`、`error?`、`loopIteration?`、`loopMeta?`、`retryHistory?`、`parentSessionId?` 等），Task 2 在 schema.ts 收紧为 zod，其中 `command?: CommandConfig`（第一层）、`inputFrom?`/`outputTo?`/`passThroughVars?` 收紧为真实结构。
- `StageInfo`/`StepStatus`/`StageContract` 等辅助类型亦已在 Task 1 types.ts 定形，schema.ts 直接对应出 zod schema。
- `WorkflowTaskState` 与 Task 1 已有的 `DagInstanceState` 是**两个不同对象**：`DagInstanceState`（types.ts）是精简版 Service 返回值；`WorkflowTaskState`（schema.ts）是存储域 `state` 表 value 的完整快照，字段更多。

#### 2.4 第三层：`sandoreDomainSpec`（`defineDomain` / `domainTable<K,V>`）

来源：`docs/design/overall-design.md` §4.3.1（第 239–276 行）+ `docs/engine/dsh-workflow.md` §5.4（第 567–587 行）+ DSH `packages/storage/storage-domain/src/spec.ts`。

**注意：design 草图的 `{ key, value }` 是伪代码**，DSH 真实 API 是 `domainTable<K, V>(schema: ZodType<V>)`（`K` 为幽灵类型/品牌字符串，运行时不存在；value schema 为 zod）。`defineDomain` 校验 `name`/`version`/表名匹配 `UNIT_NAME_RE`，且校验 global schema 不接受 `null`。

真实落点形态：

```typescript
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const sandoreDomainSpec = defineDomain({
  name: 'sandore',      // 满足 UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
  version: 1,
  tables: {
    definitions: domainTable<WorkflowId, WorkflowDefinitionRecord>(workflowDefinitionRecordSchema),
    jobs:        domainTable<JobId, JobRecord>(jobRecordSchema),
    state:       domainTable<InstanceId, WorkflowTaskState>(workflowTaskStateSchema),
  },
})
```

- `defineDomain<S extends DomainSpec>(spec: S): S`（spec.ts 第 79 行）——校验 name/version/表名，global schema 若 `safeParse(null).success` 抛错。
- `domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V>`（spec.ts 第 63 行）——返回 `{ valueSchema: schema }`。
- `DomainSpec = { name: string; version: number; global?; tables: Record<string, DomainTableSpec> }`；`DomainTableSpec<K,V> = { valueSchema: ZodType<V>; __key?: K }`。

三表 Key/Value（overall-design §4.3.1 第 270–274 行）：

| Table | Key | Value |
|---|---|---|
| `definitions` | `workflowId`（`wfl-{uuid}`） | `WorkflowDefinitionRecord`（`{ yaml, name, version, engine, skills, mcps, agents, rules, gates, createdAt, updatedAt }`，YAML 文本用 `z.string().max(N)` 设上限） |
| `jobs` | `jobId`（uuid） | `JobRecord`（`{ name, workflowId, cwd, enabled, createdAt, ... }`） |
| `state` | `instanceId`（如 `20250720-143000-abc`） | `WorkflowTaskState`（完整运行时状态快照，全量覆盖写入） |

DSH `Domain`/`KvTable` 用法（`packages/storage/storage-domain/src/index.ts` + `domain.ts`，schema-01 只需声明 spec，供 persistence.ts 使用）：

```typescript
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>   // 异步；域名全局唯一，重复 open 抛 already-open
// Domain<S>.table<N>(name): KvTable<TableKeyOf<S,N>, TableValueOf<S,N>>
// KvTable: get(key) / entries() / keys() / size / put(key,value) / delete(key) / update(key,fn)
```

参考完整先例：`D:\project-code\llm\deepseek-harness\packages\workspace\workspace\src\spec.ts`（`defineDomain` + `domainTable` + zod record 的完整例子）。

#### 2.5 依赖缺口（schema-01 实现前必补）

当前 `packages/sandore/workflow/package.json` 的 peer/devDependencies 为：`@deepseek-ai/cordis`、`dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-storage`、`dsh-typert-protocol`、`schemastery`。schema-01 需要以下**未声明**的依赖（但已在 `pnpm-lock.yaml` 中传递存在，直接声明即可）：

| 缺失依赖 | 用途 |
|---|---|
| `zod`（`^4.4.3`，lockfile 已有 `zod@4.4.3`） | `schema.ts` 的 `z.object`/`z.discriminatedUnion`/`z.infer` |
| `@deepseek-ai/dsh-storage-domain`（`0.1.0-rc.6`，lockfile 已有） | `defineDomain`/`domainTable`/`KvTable`/`Domain`（与 `dsh-storage` 是不同包） |
| `yaml`（DSH 用 `^2.4.2`/`^2.9.0`） | `yaml-parser.ts` 的 YAML 解析 |

---

### 3. yaml-parser.ts —— V1/V2 双格式解析 + `convertLegacyToV2`

#### 3.1 YAML 库的 DSH 精确用法

DSH 用 `yaml` 包（非 `js-yaml` 亦非手写）：

- `D:\project-code\llm\deepseek-harness\packages\skill\skill-filesystem\src\index.ts` 第 20 行：`import { parse as parseYaml } from 'yaml'`
- `D:\project-code\llm\deepseek-harness\packages\settings\settings-file\src\index.ts` 第 15 行：`import { Document, parseDocument } from 'yaml'`
- `D:\project-code\llm\deepseek-harness\packages\credentials\credentials-local\src\index.ts` 第 43 行：`import { Document, parseDocument, type YAMLError } from 'yaml'`（`YAMLError` 类型用于类型化错误）

版本：`yaml@^2.9.0`（settings-file）、`yaml@^2.4.2`（skill-filesystem）。

#### 3.2 解析函数与转换职责

来源：`docs/engine/dsh-workflow-implementation.md` T3（第 70–82 行）+ `docs/engine/dynamic-workflow-engine.md` §23.6（第 5027–5063 行）。

- 入口 `parseWorkflowYaml(yaml: string): WorkflowDefinition`：YAML 解析 → zod 校验 → 返回 `WorkflowDefinition`。
- **V1（三级 Stage→Scenario→Task）自动 `convertLegacyToV2()`** 转 V2（两级 Stage→Step）。V1 的 Task 字段是 `prompt`（PromptConfig 旧类型名），V2 的 Step 字段是 `command`（CommandConfig 新类型名）。
- V1→V2 迁移（§23.6）：自动检测 V1 格式，将 `scenarios[].tasks[]` 转为 `steps[]`，映射旧版类型名（`Bash` → `shell` 等）。
- 命令类型转换：`commandToPromptType(cmd)` / `promptToCommandType(prompt)`（§3.1）。

#### 3.3 V2 YAML 示例位置（解析的输入规格）

V2 完整示例在 `docs/engine/dynamic-workflow-engine.md` 附录 A（第 5093–5295 行），覆盖：
- 顶层 `id/name/version/description/engine/skills/mcps/agents/settings/rules/gates`
- `stages[]`（Stage 级 `id/name/rules/gates/next/condition/branches/loop/steps[]`，其中 `steps[]` 仅 `id` + 流控字段）
- 顶层 `steps[]`（完整 Step 定义，与 `stages[].steps[]` 按 `id` 交叉引用；含 `command`（5 种 type + `value`）、`inputFrom`（`id/path?/regex?`）、`outputTo`（`id/path?/regex?`）、`passThroughVars`（`name/value/description/refresh?`）、`timeout/rules/gates`）

V1 示例在附录 A.2（第 5297–5325 行）：`stages > scenarios > tasks`，Task 用 `prompt: { type: Bash, value: { command } }` + `outputTo`，Scenario 用 `next`。

#### 3.4 遗留别名（schema 命名对齐）

来源：`docs/engine/dynamic-workflow-engine.md` §3.5（第 714–731 行），`@deprecated` 别名保留兼容存量：

| 旧名 | 新名 |
|---|---|
| `WorkflowScenario` / `WorkflowScenarioSchema` | `WorkflowStep` / `WorkflowStepSchema` |
| `WorkflowTask` / `WorkflowTaskSchema` | `WorkflowStep` / `WorkflowStepSchema` |
| `ExecutedScenarioDefault` / `ExecutedScenarioDefaultSchema` | `ExecutedStepDefault` / `ExecutedStepDefaultSchema` |
| `ExecutedStepItem` / `ExecutedStepItemSchema` | `ExecutedStepDefault` / `ExecutedStepDefaultSchema` |
| `TaskStateItem` | `ExecutedStepDefault` |
| `InputFromSchema` / `InputFrom` | `InputFromItemSchema` / `InputFromItem` |
| `OutputFromSchema` / `OutputTo` | `OutputToItemSchema` / `OutputToItem` |
| `TaskSessionMetaSchema` / `TaskSessionMeta` | `StepSessionMetaSchema` / `StepSessionMeta` |

#### 3.5 非法 YAML 抛类型化错误

- 非法 YAML（parse 失败）→ 抛 `SandoreError`，`code = 'YAML_PARSE'`（fatal）。
- zod 校验失败（`z.ZodError`）→ 抛 `SandoreError`，`code = 'DEFINITION_INVALID'`（fatal），可挂 `cause`（`HarnessError` 的 `ErrorOptions.cause`）。
- `dsh-workflow-implementation.md` T3 Done 标准原文：「非法 YAML 抛类型化错误（`ValidationError`）」。

---

### 4. schema-01 落点小结

| 文件 | 落点 | 关键约束 |
|---|---|---|
| `packages/sandore/workflow/src/errors.ts` | `SandoreError extends HarnessError`（`import { HarnessError } from '@deepseek-ai/dsh-llm'`）+ `SandoreErrorCode` | `fatal` readonly 默认 `true`；`this.name = 'SandoreError'`；配套 `isFatalSandoreError`（对齐 `isFatalWorkflowError`） |
| `packages/sandore/workflow/src/schema.ts` | 三层 zod：`CommandConfig`（`z.discriminatedUnion('type', …)` + 嵌套 `value`）→ `WorkflowTaskState`（无 `permissionMode`）→ `sandoreDomainSpec`（`defineDomain` + `domainTable<K,V>`） | 用真实 `zod`（`import { z } from 'zod'`，非 schemastery）；record schema 用 zod、`Config` 才用 schemastery |
| `packages/sandore/workflow/src/yaml-parser.ts` | `parseWorkflowYaml(yaml): WorkflowDefinition`；V1 自动 `convertLegacyToV2`；`commandToPromptType`/`promptToCommandType` | 用 `yaml` 包（`parse`/`parseDocument`/`type YAMLError`）；非法 YAML 抛 `YAML_PARSE`、校验失败抛 `DEFINITION_INVALID` |
