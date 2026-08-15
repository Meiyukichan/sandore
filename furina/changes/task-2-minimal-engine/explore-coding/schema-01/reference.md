## Exploration Result

> 探索类型：reference。`furina config show exploration.reference` 返回空数组 `[]`，无显式配置的参考材料清单；但 exploreContent 本身点名了本地参考源（`docs/design/task-2-minimal-engine/work.md`、`docs/engine/dynamic-workflow-engine.md` 附录 A、DSH 源码 `D:\project-code\llm\deepseek-harness` 中 zod / storage-domain / yaml / HarnessError 的精确用法），以下为对这些点名参考源的实际探索结果。

---

### 1. SandoreError 对齐 DSH HarnessError / WorkflowError 的 fatal 标志

**DSH `HarnessError`（基类）精确源码** — `D:\project-code\llm\deepseek-harness\packages\llm\llm\src\error.ts`

```ts
export class HarnessError extends Error {
  readonly code: string
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
```

关键点：
- `code` 是稳定、可机器路由的字符串（区分于人类可读的 `message`），路由时**只按 `code` 判断，永不解析 message**。
- 支持标准 `ErrorOptions` 的 `cause` 链；`name` 默认取子类构造函数名（`new.target.name`）。
- 包导出辅助：`isHarnessError(value): value is HarnessError`（`instanceof` 判定，跨 realm 的 duck-typed 对象不判定为 HarnessError）、`errorChain(value): string`（渲染 cause 链）。

**DSH `WorkflowError`（带 fatal 标志）精确源码** — `D:\project-code\llm\deepseek-harness\packages\workflow\workflow\src\index.ts`

```ts
export class WorkflowError extends HarnessError {
  readonly fatal: boolean
  constructor(message: string, code: WorkflowErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'WorkflowError'
    this.fatal = options?.fatal ?? true
  }
}

export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal
}
```

关键点（sandore 的 `SandoreError` 应照此对齐）：
- `fatal` 是 `readonly` 布尔字段，**默认 `true`**（`options?.fatal ?? true`），`name` 显式写死为类名。
- 语义：`fatal` 驱动组合子纪律 —— fatal 错误（拼错选项、触发上限、schema 错误）必须让脚本**响亮失败**（re-throw），普通子运行失败才映射为 `null`。
- 导出 `isFatalWorkflowError()` 辅助：`instanceof` + `.fatal` 判定，fatal 性通过宿主 `instanceof` 判定（脚本 realm 无法伪造）。

**sandore 侧要求**（权威规格 `D:\project-code\llm\sandore\furina\changes\task-2-minimal-engine\specs\engine-schema\spec.md` §SandoreError 类型化错误）：
- `SandoreError extends HarnessError`（`@deepseek-ai/dsh-llm`）。
- `SandoreErrorCode` 联合类型：`YAML_PARSE | DEFINITION_INVALID | NODE_NOT_FOUND | CYCLE_DETECTED | STEP_TIMEOUT | STEP_EXECUTION | INVALID_OPERATION | CANCELLED | PERSISTENCE_FAILED`（Task 2 用到子集）。
- 构造：`new SandoreError('bad yaml', 'YAML_PARSE')` → `error instanceof HarnessError` 且 `error.fatal === true`（默认 fatal）；`new SandoreError(..., { fatal: false })` → `fatal === false`（恢复性错误）。

---

### 2. schema.ts 三层 Zod Schema

**zod 库选择**（精确）：DSH 里 record schema（存储域 value、业务数据）用 **zod v4**（`packages/storage/storage-domain/package.json` 依赖 `"zod": "^4.4.3"`）；插件 `Config` 才用 `@deepseek-ai/schemastery`。当前 sandore `workflow/src/index.ts` 里的 `import z from '@deepseek-ai/schemastery'` 是给 `SandoreConfig`（插件 Config）用的，**schema.ts 应 `import { z } from 'zod'`**，二者不可混用。

**三层结构**（权威规格 `specs/engine-schema/spec.md` + `docs/design/task-2-minimal-engine/design.md` §2/§4.1）：

**Layer 1 定义层**（`WorkflowDefinitionSchema` / `WorkflowStageSchema` / `WorkflowStepSchema`）：
- `WorkflowDefinitionSchema`：`id/name/version/description/engine?/skills/mcps/agents/settings/rules?/gates?/stages/steps?`；`settings` 含 `defaultTimeout`（默认 120）与 `maxConcurrentAgents`（默认 4，V2.5 已停用但仍保留）。
- `WorkflowStageSchema`：`id/name/rules?/gates?/steps/next?/defaultExpectation?/condition?/branches?/loop?`。
- `WorkflowStepSchema`：`id/name/command?/inputFrom/outputTo/passThroughVars/timeout/next/defaultExpectation?/condition?/branches?/loop?/rules?/gates?`。
- 导出对应 TS 类型用 `z.infer`（DSH 存储域同样用 `z.infer` 保持类型不重复）。

**CommandConfig 五类型 discriminated union**（`CommandConfigSchema`）：
- 判别字段为**顶层 `type`**，变体字段嵌套于 `value`（对齐权威 YAML 示例 `command: { type: shell, value: { command } }`）：
  - `{ type: 'agent', value: { promptText, agentParamsTemplate?, providerId?, modelId? } }`
  - `{ type: 'prompt', value: { promptText, providerId?, modelId? } }`
  - `{ type: 'shell', value: { command } }`
  - `{ type: 'skill', value: { promptText } }`
  - `{ type: 'mcp', value: { promptText } }`
- 未知 type（如 `docker`）必须被 zod 拒绝。
- 注意：V2.4 变更后 `agent`/`skill`/`mcp` 均用 `promptText` 存对应名称（Agent 名/Skill 名/MCP 名），不再用 `agentTemplate`。

**Layer 2 运行时状态**（`WorkflowTaskStateSchema`）：
- 字段：`taskId/jobId/workflowId/cwd/status/originalInput/currentStageId/executedSteps[]/stageInfos[]/pendingInteractions/pendingQueue[]/visitCounts/passThroughVars/activeLoopIterationStack[]/activeLoopNodeId/activeLoopStack[]/pausedStepIds[]/stageContracts/createdAt/updatedAt`。
- **不含** `permissionMode`（权限修正：权限由宿主 Session permission preset 决定）、`userChatMessages`、`defaultSessionMeta`、`pausedChildIds`。
- `executedSteps[]` 元素为 `ExecutedStepDefault`（Task 1 已声明于 `types.ts`）；Task 2 收紧时**新增 `output?: ContentBlock[]` 字段**（shell 的 `stdout.text` 包装为 text block、prompt 的聚合 block 数组，与 `sandore/step-completed` 事件载荷 `output: ContentBlock[]` 一致）。

**Layer 3 存储层三表 value**（`sandoreDomainSpec`）：
- `WorkflowDefinitionRecordSchema`：`{ yaml: string (max 65536), name, version, description?, createdAt, updatedAt }`（`z.string().max(65536)` 设上限防失控）。
- `JobRecordSchema`：`{ name, workflowId, cwd?, createdAt, updatedAt }`。
- `state` 表 value 直接用 `WorkflowTaskStateSchema`。
- `sandoreDomainSpec = defineDomain({ name: 'sandore', version: 1, tables: { definitions, jobs, state } })`，用 `domainTable<K,V>(valueSchema)` 写法。

**StepSessionMetaSchema**（合成占位结构，替代 SDK 时代 `{sessionId, inputJson, outputJson, partsJson}`）：
```ts
{ childId: string, synthetic: boolean, command: 'shell' | 'prompt' | 'agent' | 'skill' | 'mcp' }
```
- `synthetic === true` 表示占位 childId（shell/prompt 无真实子代理），`childId` 匹配 `step-{stepId}-{execId}` 模式。

---

### 3. storage-domain 精确用法（defineDomain / domainTable\<K,V\>）

**DSH 精确源码** — `D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\spec.ts`

```ts
import type { ZodType } from 'zod'

export interface DomainTableSpec<K extends string = string, V = unknown> {
  readonly valueSchema: ZodType<V>
  readonly __key?: K   // phantom 载体，运行时不存在，仅编译期投影
}

export interface DomainSpec {
  readonly name: string          // 必须匹配 UNIT_NAME_RE
  readonly version: number       // 非负整数；medium 版本不一致 open 时拒绝
  readonly global?: DomainGlobalSpec<unknown>
  readonly tables: Record<string, DomainTableSpec>
}

export function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V> {
  return { valueSchema: schema }
}

export function defineDomain<S extends DomainSpec>(spec: S): S {
  if (!UNIT_NAME_RE.test(spec.name)) { throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`) }
  if (!Number.isInteger(spec.version) || spec.version < 0) { throw new Error(...) }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) { throw new Error(...) }
  }
  // global schema 不能接受 null（null 是 medium 的 "never written" 哨兵）
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) { throw new Error(...) }
  return spec
}
```

- `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`packages/storage/storage/src/backend.ts`）。`sandore`/`definitions`/`jobs`/`state` 均匹配，`defineDomain` 模块加载时不抛错。
- 注意：`DomainTableSpec` 的 `K` 是 phantom 键类型（通常 branded string），仅编译期投影；键在 medium 上是 plain string。

**DSH 精确源码（open 入口与 Domain API）** — `D:\project-code\llm\deepseek-harness\packages\storage\storage-domain\src\index.ts` + `src\domain.ts`

```ts
// ctx.storageDomain: DomainFacility（open 单域名强制 single-open）
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
```

`Domain<S>` 句柄 API：
- `domain.name: string`
- `domain.global`（spec 未声明 global 则为 `never`）
- `domain.table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>`
- `domain.close(): Promise<void>`

`KvTable<K, V>` API：`get(key): V | undefined`、`entries(): IterableIterator<[K, V]>`、`keys()`、`size`、`put(key, value): Promise<void>`、`delete(key): Promise<boolean>`、`update(key, fn: (current: V) => V): Promise<V>`（原子 read-modify-write）。

- 读同步（内存态）；写先落 medium 再改内存再发 `domain/changed` 事件；写入失败内存不变。
- 打开时对每个已存 record 走 `valueSchema.parse(raw)`，失败抛 `DomainError('invalid-record', ...)`。
- sandore 的 CRUD 映射（`docs/engine/dsh-workflow.md` §5.4）：`definitions` 表 key=`workflowId`，`entries()` 列全部定义；`jobs` 表 key=`jobId`；`state` 表 key=`instanceId`，value 引擎状态快照（Zod 校验，崩溃恢复整读）；某 Job 实例清单从 `state` 表 `entries()` 按 `jobId` 过滤派生。

---

### 4. yaml-parser.ts（V1/V2 双格式 + Zod 验证 + 自动 convertLegacyToV2）

**DSH YAML 解析精确模式**（`D:\project-code\llm\deepseek-harness\packages\settings\settings-file\src\index.ts`，用 `yaml` npm 包 `^2.9.0`/`^2.4.2`）：

```ts
import { Document, parseDocument } from 'yaml'

const document = parseDocument(text, { prettyErrors: true })
if (document.errors.length > 0) {
  // error.linePos?.[0] 给行列；error.code 给错误码
  // `${error.code} at line ${line}, column ${col}`
}
const root = document.toJS() ?? {}
```

- 用 `document.errors`（数组，非 try/catch 单个错误）收集语法错误；`prettyErrors: true` 填充 `error.linePos`。
- 序列化侧：`yaml` 包的 `stringify` / 可变 `Document`（`patchNode` 保留注释）实现 `serializeWorkflowYaml`。

**V2 YAML 权威示例**（`D:\project-code\llm\sandore\docs\engine\dynamic-workflow-engine.md` 附录 A，行 5093 起）：
- 顶层：`id/name/version/description/engine/skills/mcps/agents/settings/rules/gates/stages/steps`。
- `stages[]`：Stage 级流控字段（`next/defaultExpectation/condition/branches/loop/rules/gates`）+ 内部 `steps[]`（**仅 ID + 流控字段**）。
- 顶层 `steps[]`：完整 Step 定义（`name/command/inputFrom/outputTo/passThroughVars/timeout/rules/gates`），与 `stages[].steps[]` **通过 ID 交叉引用**。
- command 判别示例：
  ```yaml
  command:
    type: shell
    value:
      command: "npm run lint 2>&1"
  ```
  `agent`/`prompt`/`skill`/`mcp` 同理（`value.promptText` 等）。

**V1 权威示例**（附录 A.2）：
- 三级 `stages[].scenarios[].tasks[]`；task 用 `prompt: { type: Bash, value: { command } }`（旧 PromptConfig 类型，如 `Bash`）。
- 解析器通过 `convertLegacyToV2()` 自动转 V2 内部模型：Scenario 展平为 Step（Task 合并进 `steps[]`，Scenario 元数据并入 Step），转换后走同一 V2 验证路径。
- 转换函数（`design.md` §3.1）：`commandToPromptType`（`prompt→PromptTemplate`、`shell→Bash`、`agent→AgentTemplate`、`skill→SkillTemplate`、`mcp→McpTemplate`）与 `promptToCommandType`（反向）。

**解析流程与错误码**（权威规格 `specs/engine-schema/spec.md` §V2 YAML 解析 / §V1 自动转换 / §YAML 序列化）：
- `parseWorkflowYaml(text: string): WorkflowDefinition`：`yaml.parseDocument(text, { prettyErrors: true })` → 检测格式（stages 子节点含 `steps[]` 为 V2；含 `scenarios[]` 为 V1 → `convertLegacyToV2()`）→ `WorkflowDefinitionSchema.parse()` → 引用完整性校验（`next`/`inputFrom`/`outputTo` 引用的节点 ID 存在）。
- YAML 语法错误 → 抛 `SandoreError('YAML_PARSE')`（message 含行列信息）；验证失败/引用不存在/混合格式 → 抛 `SandoreError('DEFINITION_INVALID', { cause })`。
- 混合格式（同一 stage 同时含 `steps[]` 与 `scenarios[]`）→ `SandoreError('DEFINITION_INVALID')`。
- `serializeWorkflowYaml(def: WorkflowDefinition): string`：序列化结果可被 `parseWorkflowYaml` 再次解析且深层相等（round-trip）。

---

### 5. 现有 Task 1 骨架现状（schema-01 需对接的落点）

当前 `packages/sandore/workflow/src/` 三文件（Task 1 骨架）：

- `types.ts`：已有 `DagRunInfo`/`DagStartRequest`（**无 permissionMode**，已对齐权限修正）/`DagRun`/`DagRunStatus`/`DagInstanceState`/`ExecutedStepDefault`/`StageInfo`/`StepStatus`/`StageContract`/`PendingQuestion`/`AskUserQuestionPayload`/`PendingPermission`/`DagResultInfo`。以下占位类型为 `unknown`，Task 2 收紧为真实结构（**接口名不变**）：`CommandConfig`/`InputFromItem`/`OutputToItem`/`PassThroughVar`/`StepSessionMeta`/`FinalizeMeta`/`BranchMeta`/`SessionMessage`/`RetryRecord`。
- `index.ts`：`SandoreEngine extends Service`（13 个 `sandore/*` 事件双声明 + `SandoreConfig` + `SandoreEngineStub`），`import z from '@deepseek-ai/schemastery'` 仅用于 `SandoreConfig`。
- `remote.ts`：`SandoreRemote`（`super(ctx, 'sandore')` + `@Remote('ping')` 桩）。

依赖缺口（`packages/sandore/workflow/package.json` peerDependencies 现含 `@deepseek-ai/dsh-storage`、`@deepseek-ai/schemastery`，**缺**）：schema.ts 需 `zod`（DSH 用 `^4.4.3`）、`@deepseek-ai/dsh-storage-domain`（`defineDomain`/`domainTable` 所在包，DSH 版本 `0.1.0-rc.5`）；yaml-parser.ts 需 `yaml`（DSH 用 `^2.9.0`）。

工程约束（`tsconfig.base.json`）：`strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + `allowImportingTsExtensions`/`rewriteRelativeImportExtensions`（DSH 内 import 带 `.ts` 后缀，如 `from './types.ts'`）。

---

## Supplementary Exploration Result

无需补充探索：`experimental.websearch=true`、`experimental.context7=true`，但 Phase 3 已从本地点名参考源（`work.md`/`design.md`/`engine-schema/spec.md`/`dynamic-workflow-engine.md` 附录 A/`dsh-workflow.md` §5.4/DSH 源码 zod、storage-domain、yaml、HarnessError/WorkflowError）获取到充足且精确的信息，无需联网检索。
