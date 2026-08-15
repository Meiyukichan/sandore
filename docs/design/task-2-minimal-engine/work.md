# Task 2：引擎最小可用 — 类型 + YAML + CRUD + 持久化 + 线性执行

在 Task 1 骨架（`ctx.sandoreEngine` 抽象类 + 13 事件声明 + 4 包）之上，实现引擎最小可用：类型体系 + YAML 解析 + 定义/Job/实例 CRUD + 存储域持久化 + 线性工作流执行（shell/prompt Step）。**不含**分支/循环/agent/skill/mcp/finalize/交互/重试/崩溃恢复。

## 必读（按优先级）
1. `docs/design/task-2-minimal-engine/design.md` —— Task 2 权威规格（类型、YAML、CRUD、持久化、线性执行、验证标准）
2. `docs/engine/dsh-workflow.md` —— 插件化核心设计（§5.2 引擎移植映射、§5.3 Step 执行器映射、§5.4 持久化、§5.6/§7.2 RPC）
3. `docs/design/overall-design.md` —— 总体设计（§4.3.1 存储域三表、§7.3 持久化迁移、D1–D9）
4. DSH 源码 `D:\project-code\llm\deepseek-harness` 参考：`packages/workflow/workflow`（Service/Provider 模式）、storageDomain 用例（`ctx.storageDomain.open(spec)`）

## 硬约束（不可违反）
- **纯插件，不改任何 DSH 源码**；**零外部 Agent SDK**，全用 DSH `ctx.*` 服务
- 沿用 Task 1 的命名：`ctx.sandoreEngine` / `sandore/*` / `sandore_*`（工具）/ `sandore.*`（RPC）/ 4 包

## 产出（`workflow` + `microflow` 两包）
1. `packages/sandore/workflow/`：**类型 + YAML + CRUD + 持久化 + Stage 编排引擎**
   - `schema.ts`：全部 Zod Schema + TS 类型（WorkflowDefinition/WorkflowStage/WorkflowStep/WorkflowTaskState 等）
   - `yaml-parser.ts`：V1/V2 双格式解析 + Zod 验证（V1 自动 `convertLegacyToV2`）
   - `remote.ts`：`@Remote` RPC（`listDefinitions`/`createDefinition`/…、`listJobs`/`createJob`/…、`startInstance`/`getInstanceState`/`deleteInstance`/`abortInstance`，见 §7.2）
   - `persistence.ts`：`ctx.storageDomain.open(sandoreDomainSpec)` —— `sandore` 域三表 `definitions`（key=workflowId）/`jobs`（key=jobId）/`state`（key=instanceId）
   - `workflow-engine.ts`：`WorkflowEngineV2`（Stage 级编排主循环）+ `dag-navigator.ts`（节点索引 + `tryAdvanceStage`）
2. `packages/sandore/microflow/`：**Stage 内部执行**
   - `stage-executor.ts`：Stage 内部顺序执行 Step + StageContract 组装
   - `step-runner.ts`：shell（`ctx.shell.run()`）/ prompt（`ctx.llm.stream()`）两种类型

## 关键决策
- **D2**：Service 层只暴露 11 个实例级操作；定义/Job CRUD 放 `workflow`（Host RPC 层）
- **D3**：agent 类型 Step 用 `ctx.subagents.startContinuable()`（Task 3 才用）；Task 2 仅 shell/prompt——shell 用 `ctx.shell.run()`（简单命令）/ `ctx.subprocess.spawn()`（需 stdin 注入），prompt 用 `ctx.llm.stream()`
- **D4**：`work.json` → `state` 表（key=instanceId）；SQLite 两张表 + YAML 定义文件 + jobs.json → `definitions`/`jobs` 表（引擎不持有 SQLite 连接）
- **权限修正**：**无 `permissionMode`**——`static Config` 与 `DagStartRequest` 不加该字段；权限由宿主 Session 的 permission preset 决定（Step 子代理继承父级）
- **provider/model 三层回退**（prompt Step 缺省模型，DSH 无 SDK 默认模型需引擎自兜底）：L1 Step 定义 `providerId`+`modelId` 成对提供才用 → L2 引擎 Config `defaultProvider`/`defaultModel`（成对）→ L3 `ctx.llm.listProviders()[0]` + `listModels(provider)[0]`（记 warn）。详见 design.md §6.2
- **13 事件（D5 双发 + childId 占位）**：沿用 Task 1 的 13 个 `sandore/*` 事件（含 `childId`/`output` 增补，无 `default-session-mounted`）；发射时**双发**——`ctx.emit('sandore/…', info, …)`（Cordis 进程内，供引擎内部 `ctx.on` 监听）+ `hostSession.append('sandore/…', payload)`（Session 事件，写宿主 log 供前端折叠），封装 `emitSandoreEvent` 统一双发；**childId 占位**：shell/prompt 无子代理，`childId = step-{stepId}-{execId}` 存入 `sessionMeta = { childId, synthetic: true }`（Task 3 agent 替换为真实 SessionId，`synthetic: false`）

## 验证标准（Task 2 完成门槛）
- 能 RPC 创建/列出/删除定义与 Job；`startInstance` 创建实例并写入存储域 `state` 快照（`getInstanceState` 读回）
- 能执行「shell Step → prompt Step」线性工作流到 `completed`；`sandore/*` 事件按序发射（start → stage-start → step-start → step-completed → … → end）
- 持久化：storageDomain 读回 `state` 快照，含完整 `executedSteps` 记录
- 类型/YAML：能解析 V2 示例 YAML，非法 YAML 抛类型化错误
- **测试（vitest + 内存 mock）**：根 `package.json` 加 `"test": "vitest run"` + vitest；纯单元测试（YAML/Zod/类型化错误，零 mock）+ 轻量集成测试（线性执行，`SqliteStorageBackend(':memory:')` + fake llm adapter + mock shell）；不引入 test-support 重量级集成测试（留 Task 5）

先读 `task-2-minimal-engine/design.md` 全文，再开始实现。
