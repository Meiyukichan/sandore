# Spec: engine-schema — 类型体系与 YAML 解析

## ADDED Requirements

### Requirement: Zod Schema 定义层
`packages/sandore/workflow/src/schema.ts` SHALL 用 zod 定义工作流定义层 Schema 并导出对应 TS 类型（`z.infer`）：`WorkflowDefinitionSchema`（id/name/version/description/engine?/skills/mcps/agents/settings/rules?/gates?/stages/steps?）、`WorkflowStageSchema`（id/name/rules?/gates?/steps/next?/defaultExpectation?/condition?/branches?/loop?）、`WorkflowStepSchema`（id/name/command?/inputFrom/outputTo/passThroughVars/timeout/next/defaultExpectation?/condition?/branches?/loop?/rules?/gates?）。

#### Scenario: WorkflowDefinitionSchema 编译与解析
- **WHEN** 用合法 V2 定义对象调用 `WorkflowDefinitionSchema.parse()`
- **THEN** 解析成功，输出含 `settings.defaultTimeout`（默认 120）与 `settings.maxConcurrentAgents`（默认 4）的完整对象

#### Scenario: 缺少必填字段抛错
- **WHEN** 用缺少 `stages` 的对象调用 `WorkflowDefinitionSchema.parse()`
- **THEN** zod 抛出含字段路径（如 `stages`）的 ZodError

### Requirement: CommandConfig 五类型 discriminated union
`schema.ts` SHALL 定义 `CommandConfigSchema` 为 zod discriminated union（判别字段为顶层 `type`，变体字段嵌套于 `value`，对齐权威 spec YAML 示例 `command: { type: shell, value: { command } }`）：`{ type: 'agent', value: { promptText, agentParamsTemplate?, providerId?, modelId? } }` | `{ type: 'prompt', value: { promptText, providerId?, modelId? } }` | `{ type: 'shell', value: { command } }` | `{ type: 'skill', value: { promptText } }` | `{ type: 'mcp', value: { promptText } }`。

#### Scenario: shell 命令解析
- **WHEN** 解析 `{ type: 'shell', value: { command: 'echo hi' } }`
- **THEN** 判别为 shell 变体，`value.command` 字段为 `'echo hi'`

#### Scenario: 未知类型拒绝
- **WHEN** 解析 `{ type: 'docker', value: { command: '…' } }`
- **THEN** zod 抛错（判别值不在五类型内）

### Requirement: WorkflowTaskState 运行时 Schema
`schema.ts` SHALL 定义 `WorkflowTaskStateSchema`：`taskId/jobId/workflowId/cwd/status/originalInput/currentStageId/executedSteps[]/stageInfos[]/pendingInteractions/pendingQueue[]/visitCounts/passThroughVars/activeLoopIterationStack[]/activeLoopNodeId/activeLoopStack[]/pausedStepIds[]/stageContracts/createdAt/updatedAt`。**不含** `permissionMode`、`userChatMessages`、`defaultSessionMeta`、`pausedChildIds`（权限修正/迁移废弃字段；暂停登记表为 Task 4 范围）。其中 `executedSteps[]` 元素为 `ExecutedStepDefault`（Task 1 已声明于 `types.ts`），Task 2 收紧时新增 `output?: ContentBlock[]` 字段（shell 的 `stdout.text` 包装为 text block、prompt 的聚合 block 数组，与 `sandore/step-completed` 事件载荷 `output: ContentBlock[]` 一致）。

#### Scenario: 权限修正字段不存在
- **WHEN** 检查 `WorkflowTaskStateSchema` 的字段列表
- **THEN** 无 `permissionMode` 字段（权限由宿主 Session permission preset 决定）

#### Scenario: 快照 round-trip
- **WHEN** 构造一个含 2 个 `executedSteps` 的完整 state 对象 → `WorkflowTaskStateSchema.parse()` → `state.put()` → 读回 → 再 parse
- **THEN** round-trip 后对象深层相等

### Requirement: StepSessionMeta 合成占位结构
`schema.ts` SHALL 定义 `StepSessionMetaSchema = { childId: string, synthetic: boolean, command: 'shell' | 'prompt' | 'agent' | 'skill' | 'mcp' }`（替代 SDK 时代的 `{sessionId, inputJson, outputJson, partsJson}`——DSH 迁移后无这些文件）。

#### Scenario: synthetic 标记
- **WHEN** shell Step 执行完成后检查其 `executedSteps[].sessionMeta`
- **THEN** `synthetic === true` 且 `command === 'shell'`，`childId` 匹配 `step-{stepId}-{execId}` 模式

### Requirement: 存储层 Schema（三表 value）
`schema.ts` SHALL 定义三表 value schema：`WorkflowDefinitionRecordSchema { yaml: string (max 65536), name, version, description?, createdAt, updatedAt }`、`JobRecordSchema { name, workflowId, cwd?, createdAt, updatedAt }`、`state` 表 value 直接用 `WorkflowTaskStateSchema`；并导出 `sandoreDomainSpec = defineDomain({ name: 'sandore', version: 1, tables: { definitions, jobs, state } })`（`domainTable<K,V>(valueSchema)` 写法）。

#### Scenario: 域名与表名合法
- **WHEN** 模块加载时 `defineDomain` 校验 spec
- **THEN** `sandore`/`definitions`/`jobs`/`state` 全部匹配 `/^[a-z][a-z0-9_]*$/`，不抛错

#### Scenario: YAML 超限拒绝
- **WHEN** `WorkflowDefinitionRecordSchema.parse()` 收到 70KB 的 yaml 字符串
- **THEN** zod 抛错（超出 65536 上限）

### Requirement: V2 YAML 解析
`yaml-parser.ts` SHALL 导出 `parseWorkflowYaml(text: string): WorkflowDefinition`：`yaml.parseDocument(text, { prettyErrors: true })` 解析 → 检测格式（stages 子节点含 `steps[]` 为 V2）→ `WorkflowDefinitionSchema.parse()` 验证 → 引用完整性校验（`next`/`inputFrom`/`outputTo` 引用的节点 ID 存在）。YAML 语法错误抛 `SandoreError('YAML_PARSE')`；验证失败抛 `SandoreError('DEFINITION_INVALID', { cause })`。

#### Scenario: V2 示例解析
- **WHEN** 解析 `docs/engine/dynamic-workflow-engine.md` 附录 A 的 V2 示例 YAML（shell + prompt Step 的线性工作流）
- **THEN** 返回合法 `WorkflowDefinition`，含正确的 stage/step 结构与 command 判别

#### Scenario: 非法 YAML 类型化错误
- **WHEN** 解析 `stages: [ Unclosed` 这类语法错误文本
- **THEN** 抛出 `SandoreError`，`code === 'YAML_PARSE'`，message 含行列信息

#### Scenario: 引用不存在
- **WHEN** V2 YAML 中某 step 的 `next` 指向不存在的 stepId
- **THEN** 抛 `SandoreError('DEFINITION_INVALID')`，message 指明缺失引用

### Requirement: V1 自动转换
`yaml-parser.ts` SHALL 检测 V1 格式（stages 含 `scenarios[]` 三级结构）并自动 `convertLegacyToV2()`：Scenario 展平为 Step（Task 合并进 `steps[]`，Scenario 元数据并入 Step），转换后走同一 V2 验证路径。

#### Scenario: V1 三级结构转换
- **WHEN** 解析含 `stages[].scenarios[].tasks[]` 的 V1 YAML
- **THEN** 输出为两级 `stages[].steps[]` 结构，每个 task 成为独立 Step，Zod 验证通过

#### Scenario: 混合格式拒绝
- **WHEN** 同一 stage 同时含 `steps[]` 与 `scenarios[]`
- **THEN** 抛 `SandoreError('DEFINITION_INVALID')`

### Requirement: YAML 序列化
`yaml-parser.ts` SHALL 导出 `serializeWorkflowYaml(def: WorkflowDefinition): string`（DagEditor 保存/round-trip 测试用），序列化结果可被 `parseWorkflowYaml` 再次解析且深层相等。

#### Scenario: round-trip
- **WHEN** `serializeWorkflowYaml(def)` → `parseWorkflowYaml(result)`
- **THEN** 解析结果与 `def` 深层相等（含默认值填充后的规范化形式）

### Requirement: SandoreError 类型化错误
`workflow` 包 SHALL 导出 `SandoreError extends HarnessError`（`@deepseek-ai/dsh-llm`）带 `fatal: boolean` 标志与 `SandoreErrorCode` 联合类型（`YAML_PARSE`/`DEFINITION_INVALID`/`NODE_NOT_FOUND`/`CYCLE_DETECTED`/`STEP_TIMEOUT`/`STEP_EXECUTION`/`INVALID_OPERATION`/`CANCELLED`/`PERSISTENCE_FAILED`，Task 2 用到的子集）。

#### Scenario: 错误构造
- **WHEN** `new SandoreError('bad yaml', 'YAML_PARSE')`
- **THEN** `error instanceof HarnessError` 且 `error.fatal === true`（默认 fatal）

#### Scenario: 非 fatal 恢复性错误
- **WHEN** `new SandoreError('persist retry', 'PERSISTENCE_FAILED', { fatal: false })`
- **THEN** `error.fatal === false`
