# Spec: engine-crud — 定义/Job/实例 CRUD 与 Host RPC

## ADDED Requirements

### Requirement: 存储域持久化 Provider
`packages/sandore/workflow/src/persistence.ts` SHALL 提供 `SandorePersistence`：引擎 Provider 在 `[Service.init]` 中 `await ctx.storageDomain.open(sandoreDomainSpec)` 打开域，`ctx.effect` 挂 `Domain.close()` 释放；暴露三表句柄（`definitions`/`jobs`/`state` 的 `KvTable`）与 `saveWorkflowState(state: WorkflowTaskState): Promise<void>`（`state.put(instanceId, state)` 全量覆盖）。

#### Scenario: 域打开与释放
- **WHEN** Provider 启动（`[Service.init]`）
- **THEN** `sandore` 域打开成功，三表句柄可解析；Provider 卸载时 `Domain.close()` 被调用

#### Scenario: 状态快照全量覆盖写
- **WHEN** 同一 `instanceId` 连续两次 `saveWorkflowState`
- **THEN** `state.get(instanceId)` 返回最后一次的完整快照（无残留旧字段）

### Requirement: 定义 CRUD RPC
`remote.ts` 的 `SandoreRemote` SHALL 暴露定义 CRUD：`listDefinitions(): WorkflowDefinitionRecord[]`（entries() 全量）、`createDefinition(input: { yaml }): WorkflowDefinitionRecord`（解析+Zod 验证 YAML → 生成 `wfl-{uuid}` → 存 yaml+元数据）、`updateDefinition(id, input)`（更新元数据）、`deleteDefinition(id)`（删除记录）、`getYaml(id): string`、`updateYaml(id, yaml)`（重新验证后覆盖）。

#### Scenario: 创建定义往返
- **WHEN** `createDefinition({ yaml: <合法 V2 YAML> })` 后调用 `listDefinitions()`
- **THEN** 列表含新记录（`wfl-` 前缀 id、yaml 文本、name 来自解析结果），`getYaml(id)` 返回原文

#### Scenario: 非法 YAML 创建拒绝
- **WHEN** `createDefinition({ yaml: 'stages: [ broken' })`
- **THEN** 抛 `SandoreError`（`YAML_PARSE` 或 `DEFINITION_INVALID`），`definitions` 表无新记录

#### Scenario: 更新非法 YAML 拒绝
- **WHEN** 对已有定义 `updateYaml(id, <非法 YAML>)`
- **THEN** 抛 `SandoreError`，存储中的 yaml 保持旧值

#### Scenario: 删除定义
- **WHEN** `deleteDefinition(id)` 后 `listDefinitions()`
- **THEN** 该记录不在列表中；重复删除幂等（第二次 delete 返回 false/not-found 不抛错）

### Requirement: Job CRUD RPC
`SandoreRemote` SHALL 暴露 Job CRUD：`listJobs(workflowId?)`（可选过滤）、`createJob(input: { name, workflowId, cwd? })`（校验 workflowId 存在于 definitions 表，自动生成 jobId）、`getJob(id)`、`updateJob(id, input)`、`deleteJob(id)`。

#### Scenario: 创建 Job 校验定义存在
- **WHEN** `createJob({ name: 'x', workflowId: 'wfl-nonexistent' })`
- **THEN** 抛 `SandoreError`（`INVALID_OPERATION` 或等价类型化错误）

#### Scenario: 按工作流过滤
- **WHEN** 两个 Job 分别关联 workflowA/workflowB，调用 `listJobs(workflowA)`
- **THEN** 仅返回关联 workflowA 的 Job

### Requirement: 实例生命周期 RPC
`SandoreRemote` SHALL 暴露实例生命周期：`listInstances(jobId?)`（从 `state` 表 `entries()` 派生，可选按 jobId 过滤，返回 `{instanceId, jobId, workflowId, status, createdAt, updatedAt}` 摘要）、`startInstance(input: { jobId, originalInput, cwd? })`（转发 `ctx.sandoreEngine.startInstance`，返回 `DagRun`）、`getInstanceState(jobId?, instanceId): WorkflowTaskState`、`deleteInstance(instanceId)`（state 表删除）、`abortInstance(instanceId)`（转发引擎，非运行态抛错）。

#### Scenario: startInstance 写入 state 快照
- **WHEN** `startInstance({ jobId, originalInput: '测试' })`
- **THEN** 返回 `{ instanceId, status }`；`state` 表立即可读回该 instanceId 的快照（`getInstanceState` 返回含 `originalInput` 的完整状态）

#### Scenario: 实例清单派生
- **WHEN** 两个 Job 各启动一个实例后 `listInstances(jobA)`
- **THEN** 仅返回 jobA 的实例摘要

#### Scenario: deleteInstance 移除快照
- **WHEN** `deleteInstance(instanceId)` 后 `getInstanceState`
- **THEN** 抛 not-found 类型化错误；`listInstances` 不再含该实例

#### Scenario: abortInstance 非运行态拒绝
- **WHEN** 对 `completed` 状态实例调用 `abortInstance`
- **THEN** 抛 `SandoreError('INVALID_OPERATION')`

### Requirement: 产物查询 RPC
`SandoreRemote` SHALL 暴露 `getArtifacts(instanceId, stageId?)`：从 `state` 表读取实例快照，遍历 `executedSteps[]` 与 `stageContracts` 构建产物条目（`{ stepId, stageId, outputToId, files, returnPrompt? }`），可按 stageId 过滤。

#### Scenario: 产物条目构建
- **WHEN** 一个含 shell Step（outputTo 产物文件）+ prompt Step 的 completed 实例调用 `getArtifacts(instanceId)`
- **THEN** 返回两个 Stage 的产物条目，prompt Step 的 `returnPrompt` 在条目中

### Requirement: Provider/Model 转发 RPC
`SandoreRemote` SHALL 暴露 `listProviders()`/`listModels(provider)`（直接转发 `ctx.llm.listProviders()`/`ctx.llm.listModels(provider)`）。

#### Scenario: 转发透传
- **WHEN** mock llm 注册 1 个 provider/1 个 model
- **THEN** `listProviders().length === 1` 且 `listModels(providerId)` 返回该 model

### Requirement: ping 保留
`SandoreRemote` SHALL 保留 Task 1 的 `sandore.ping` 方法（健康检查往返），返回结构不变。

#### Scenario: ping 往返
- **WHEN** `host.call('sandore.ping')`
- **THEN** 返回 `{ pong: true, service: 'sandore', time: <ISO> }`
