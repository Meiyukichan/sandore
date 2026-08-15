# Proposal: task-2-minimal-engine — 引擎最小可用（类型 + YAML + CRUD + 持久化 + 线性执行）

## Why

Task 1 已交付骨架（`ctx.sandoreEngine` 抽象类 + 13 事件双声明 + 4 包目录 + RPC ping 链路），但引擎本身还不能执行任何工作流。Task 2 按 `docs/design/task-2-minimal-engine/design.md`（权威规格）实现「引擎最小可用」：类型体系 + YAML 解析 + 定义/Job/实例 CRUD + 存储域持久化 + 线性工作流执行（shell/prompt Step），为 Task 3（完整 DAG：agent/分支/循环）提供执行底座。这是严格串行链（Task 1 → Task 2 → Task 3）的第二环，缺它后续 Task 无法开工。

## What Changes

- **补齐 `packages/sandore/workflow/`**（`@deepseek-ai/dsh-sandore-workflow`）：
  - `schema.ts`：全部 Zod Schema + TS 类型（`WorkflowDefinition`/`WorkflowStage`/`WorkflowStep`/`CommandConfig` 五类型/`WorkflowTaskState`/`ExecutedStepDefault` 等），收紧 Task 1 的 `unknown` 占位类型
  - `yaml-parser.ts`：V1（三级 Stage→Scenario→Task）/V2（两级 Stage→Step）双格式解析 + Zod 验证（V1 自动 `convertLegacyToV2`），非法 YAML 抛类型化错误（`SandoreError`）
  - `persistence.ts`：`ctx.storageDomain.open(sandoreDomainSpec)` —— `sandore` 域三表：`definitions`（key=workflowId）/`jobs`（key=jobId）/`state`（key=instanceId）
  - `workflow-engine.ts`：`WorkflowEngineV2` Stage 级编排主循环 + `dag-navigator.ts`（节点索引 + `tryAdvanceStage`），实现 Task 1 抽象类的实例级操作（startInstance/getState/abortInstance 等）
  - `remote.ts`：扩展 Host RPC——定义 CRUD（`listDefinitions`/`createDefinition`/`updateDefinition`/`deleteDefinition`/`getYaml`/`updateYaml`）+ Job CRUD（`listJobs`/`createJob`/`getJob`/`updateJob`/`deleteJob`）+ 实例生命周期（`listInstances`/`startInstance`/`deleteInstance`/`getInstanceState`/`abortInstance`）+ `getArtifacts`（保留 `ping`）
- **新建 `packages/sandore/microflow/src/`**（`@deepseek-ai/dsh-sandore-microflow`）：
  - `stage-executor.ts`：Stage 内部顺序执行 Step + StageContract 组装
  - `step-runner.ts`：shell（`ctx.shell.resolve()` + `ctx.shell.run()`）/ prompt（`ctx.llm.stream()`）两种 Step 执行器
- **依赖补齐**：`workflow` 包新增 `@deepseek-ai/dsh-storage-domain`（`defineDomain`/`domainTable` 来源）、`zod`（record schema）、`yaml`（YAML 解析）依赖；`microflow` 包补齐 peerDependencies + scripts
- **测试基建**：根与两包新增 vitest 配置 + 单元/集成测试（内存 mock storageDomain、fake llm/shell），覆盖验证标准（shell Step → prompt Step 线性执行到 completed）
- **已确认的 4 项实现决策**（头脑风暴确认）：
  1. LLM 路由三层回退：Step 定义 `providerId`/`modelId` 优先 → 引擎 Config `defaultProvider`/`defaultModel` 兜底 → `ctx.llm.listProviders()` 第一个
  2. `sandore/*` 事件 `ctx.emit` + `session.append` 双发（Cordis 触发源 + 宿主 Session log 持久化）
  3. `childId = step-{stepId}-{execId}` 合成占位 + `sessionMeta = { childId, synthetic: true, command: 'shell'|'prompt' }` 标记；Task 3 agent Step 替换为真实 SessionId + `synthetic: false`
  4. 测试用 vitest + 内存 mock（不依赖真实 LLM provider / shell 执行）

不做（后续 Task）：分支/循环/agent/skill/mcp/finalize/交互/暂停恢复/重试/崩溃恢复/SSE/前端 UI。不修改任何 DSH 源码；零外部 Agent SDK。

## Capabilities

### New Capabilities

- `engine-schema`: 类型体系与 YAML 解析——全部 Zod Schema + TS 类型（WorkflowDefinition/Stage/Step/CommandConfig/WorkflowTaskState 等），V1/V2 双格式 YAML 解析 + Zod 验证 + V1 自动转换 + 类型化错误
- `engine-crud`: 定义/Job/实例 CRUD 与 Host RPC——storageDomain `sandore` 域三表持久化（definitions/jobs/state）+ `@Remote` CRUD/实例生命周期/产物查询方法
- `engine-execution`: 线性工作流执行——WorkflowEngineV2 Stage 级编排主循环 + DagNavigator（nodeIndex + tryAdvanceStage）+ StageExecutor + StepRunner（shell/prompt），`sandore/*` 事件按序发射 + 存储域状态快照持久化

### Modified Capabilities

（无——Task 1 的 `engine-seam`/`engine-rpc`/`monorepo-workspace`/`ui-entry` spec 级行为不变；Task 2 收紧 `unknown` 占位类型是实现细节，不改变 Task 1 声明的接口契约）

## Impact

- **代码**：`packages/sandore/workflow/src/`（新增 4 文件 + 扩展 remote.ts + 收紧 types.ts 占位）、`packages/sandore/microflow/src/`（新建 2 文件）；Task 1 的 `SandoreEngineStub` 由真实 `WorkflowEngineV2` Provider 实现取代（抽象类与事件声明不变）
- **依赖**：`workflow/package.json` 新增 `@deepseek-ai/dsh-storage-domain`/`zod`/`yaml`；`microflow/package.json` 补 peerDependencies（`@deepseek-ai/dsh-storage`、`zod`）与 scripts；根新增 `vitest` devDependency
- **API**：`sandore.*` RPC 命名空间从 1 个方法（ping）扩展到 ~18 个方法；`ctx.sandoreEngine` 11 个方法中 Task 2 实现 3 个（`startInstance`/`getState`/`abortInstance`），其余 8 个抛「not implemented in Task 2」类型错误（Task 3/4 填充）
- **运行时**：引擎持有 `sandore` 存储域句柄（`ctx.effect` 挂 `Domain.close()` 释放）；prompt Step 依赖宿主组合已注册 LLM adapter
