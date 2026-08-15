# Design: task-2-minimal-engine — 引擎最小可用

> `docs\design\task-2-minimal-engine\work.md`和`docs\design\task-2-minimal-engine\design.md`这个当前阶段总体任务，写代码前都需要参考

## Context

Task 1 已交付：`packages/sandore/workflow/src/index.ts`（`SandoreEngine` 抽象类 + 13 事件双声明 + `SandoreEngineStub` 桩）、`types.ts`（13 基础类型，`CommandConfig` 等 9 个深层类型为 `unknown` 占位）、`remote.ts`（仅 `sandore.ping`）；`microflow` 包为空占位。

本设计的**权威规格**是 `docs/design/task-2-minimal-engine/design.md`（下称「权威 spec」），文件结构、类型字段、方法签名、执行流程均以其为准，此处不逐字复述——只记录架构决策、与权威 spec 的差异澄清、以及头脑风暴确认的 4 项实现决策。

**探索已核实的 DSH API 事实**（`D:\project-code\llm\deepseek-harness` 源码）：

| API | 精确签名 | 注意点 |
|---|---|---|
| 存储域 | `ctx.storageDomain.open(spec): Promise<Domain<S>>`；`defineDomain({name,version,tables})`；`domainTable<K,V>(zodSchema)` | record schema 用 **zod**（非 schemastery）；域/表名须匹配 `/^[a-z][a-z0-9_]*$/`；`open` 异步、域名全局唯一；调用方负责 `Domain.close()` |
| KvTable | `get/put/delete/update/entries/keys/size`；`put` 全量覆盖、`Promise<void>` | 读内存同步、写走域写链（durability-first） |
| shell | `ctx.shell.resolve(request): ShellExecSpec` → `ctx.shell.run(spec): Promise<ShellRunResult>` | 非零退出/超时/中止**resolve** 为 result 而非 reject；`ShellRunResult{exitCode, stdout: CollectedOutput{text,truncated}, stderr, timedOut, aborted}`；`ShellExecRequest` 实际有 `stdin`/`env` 字段 |
| llm | `ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>` | `GenerateOptions` 需 `provider`+`model`+`messages: Message[]`；chunk 聚合用 `block-start`/`text-delta`/`block-end`/`finish`（`finish.reason.kind: 'error'` 为终端失败） |
| RPC | `TypertRemoteService` + `@Remote('method')`，`super(ctx, 'sandore')` | 方法可 async；`@Remote` 装饰器要求 public instance method |
| Session | `session.append('sandore/…', data)`（SessionEventMap 声明合并） | Task 2 宿主 Session 的创建时机：`startInstance` 时若无宿主 Session 则 `ctx.sessions.create()` |
| 错误 | `HarnessError(message, code)`（`@deepseek-ai/dsh-llm`） | `SandoreError extends HarnessError` + `fatal` 标志（对齐 DSH `WorkflowError`） |

**依赖缺口**（必须补齐）：`workflow` 包缺 `@deepseek-ai/dsh-storage-domain@0.1.0-rc.6`、`zod@^4.4.3`、`yaml`；`microflow` 包无 src/scripts/peerDeps；仓库无测试框架。

## Goals / Non-Goals

**Goals:**

- 能 RPC 创建/列出/删除定义与 Job；`startInstance` 创建实例并写入存储域 `state` 快照（`getInstanceState` 读回）
- 能执行「shell Step → prompt Step」线性工作流到 `completed`；`sandore/*` 事件按序发射（start → stage-start → step-start → step-completed → … → stage-completed → end）
- 持久化：storageDomain 读回 `state` 快照，含完整 `executedSteps` 记录
- 类型/YAML：能解析 V2 示例 YAML（`docs/engine/dynamic-workflow-engine.md` 附录 A），非法 YAML 抛类型化错误
- vitest + 内存 mock 全覆盖（类型/解析/CRUD/线性执行）

**Non-Goals:**

- 分支/循环（BranchEvaluator/LoopManager）、并发分支
- agent/skill/mcp Step（Task 3；用 `ctx.subagents.startContinuable()`）
- finalize（FinalizeAssessor/GateEvaluator）、门禁、透传变量提取
- 交互（问答/权限）、暂停/恢复、重试、崩溃恢复、默认会话（Task 4）
- SSE 推送、前端 UI（Task 5）
- 修改任何 DSH 源码；引入任何外部 Agent SDK

## Decisions

### D-T2-1 包与模块边界（沿用权威 spec §1/附录 B）

```
workflow（Host）                          microflow（Host）
├── index.ts      抽象类+事件（Task1 不变） ├── index.ts      export StageExecutor 等
├── types.ts      收紧 unknown 占位          ├── stage-executor.ts
├── schema.ts     全部 Zod Schema+类型       └── step-runner.ts
├── yaml-parser.ts V1/V2 解析
├── persistence.ts sandore 域三表
├── workflow-engine.ts Stage 编排 Provider
├── dag-navigator.ts nodeIndex+推进
└── remote.ts     @Remote CRUD（扩 ping）
```

- 运行时依赖单向 `workflow → microflow`（workflow 实例化 StageExecutor 执行 Stage）；`microflow → workflow` 仅 `import type`（编译期擦除，打破循环）——对齐 dsh-workflow.md §4.2。
- `schema.ts` 放 `workflow`（权威 spec 附录 B：`engine/internal/engine/types.ts` → `workflow/src/schema.ts`）；microflow 通过 type-only import 消费。

### D-T2-2 存储：`sandore` 域三表（权威 spec §4.1，D4）

- `sandoreDomainSpec = defineDomain({ name: 'sandore', version: 1, tables: { definitions, jobs, state } })`
- **修正**（与总体设计草图的差异）：实际 API 是 `domainTable<K,V>(zodSchema)` 而非 `{ key, value }` 写法；三表 value schema 用 zod 定义于 `schema.ts`
- `definitions`：key=`workflowId`（`wfl-{uuid}`），value=`WorkflowDefinitionRecord { yaml, name, version, description?, createdAt, updatedAt }`（YAML 文本存 value，`z.string().max(65536)` 上限）
- `jobs`：key=`jobId`，value=`JobRecord { name, workflowId, cwd?, createdAt, updatedAt }`
- `state`：key=`instanceId`（`YYYYMMDD-HHmmss-xxx` 时间戳格式，权威 spec §4.6），value=`WorkflowTaskState`（Zod schema 全量校验）
- 域句柄生命周期：`WorkflowEngineV2` Provider 在 `[Service.init]` 中 `open`，`ctx.effect` 挂 `Domain.close()` 释放（对齐 DSH `WorkspaceRegistry` 范式）
- 实例清单从 `state` 表 `entries()` 按 `jobId` 过滤派生（不维护 jobs.json 索引）

### D-T2-3 类型体系分层（权威 spec §2）

- `schema.ts` 分三层：**定义层**（WorkflowDefinition/Stage/Step/CommandConfig/InputFromItem/OutputToItem/PassThroughVar/Gates/DagBranch/DagLoop）→ **运行时层**（WorkflowTaskState/ExecutedStepDefault/StageInfo/StepStatus/StageContract/StepSessionMeta）→ **存储层**（WorkflowDefinitionRecord/JobRecord，即三表 value）
- `CommandConfig` 五类型以 zod discriminated union 实现（判别字段为顶层 `type`，变体字段嵌套于 `value`，对齐权威 spec YAML 示例 `command: { type: shell, value: { command } }`）：`{ type: 'shell', value: { command } } | { type: 'prompt', value: { promptText, providerId?, modelId? } } | { type: 'agent', value: { promptText, agentParamsTemplate?, providerId?, modelId? } } | { type: 'skill', value: { promptText } } | { type: 'mcp', value: { promptText } }`，但 Task 2 运行时只执行 shell/prompt，agent/skill/mcp 解析合法、执行时抛 `SandoreError('STEP_EXECUTION', …, { detail: 'not implemented until Task 3' })`
- `types.ts` 的 `unknown` 占位收紧为 `import type { … } from './schema.ts'` 的真实结构（Task 1 声明的 13 个基础类型接口名不变）
- 权威 spec §2.2 的 `WorkflowTaskState.permissionMode` **不实现**（权限修正：无 permissionMode）；`userChatMessages`/`defaultSessionMeta` 同样不进 Task 2 的 state schema（迁移后废弃字段）

### D-T2-4 YAML 解析（权威 spec §3）

- 用 `yaml` 包（DSH 同款 `yaml@^2.9.0`）`parseDocument(text, { prettyErrors: true })`；YAML 语法错误 → `SandoreError('YAML_PARSE', …)`
- **V2 检测**：stages 的子节点有 `steps[]`（两级）→ V2；有 `scenarios[]`（三级）→ V1，`convertLegacyToV2()` 把 Scenario→扁平 Step（Task 合并进 steps，Scenario 名称并入 Step name/description）
- **Zod 验证**：`WorkflowDefinitionSchema.parse()` 失败 → `SandoreError('DEFINITION_INVALID', …, { cause: zodError })`
- 命名约束：workflowId `wfl-{uuid}`、stageId `stg-*`、stepId `step-*`、outputTo id `opt-*`、inputFrom 引用须存在（校验 reference 完整性：`next`/`inputFrom`/`outputTo` 指向的节点存在，否则 `DEFINITION_INVALID`）
- `parseWorkflowYaml(text): WorkflowDefinition`（同步）+ `serializeWorkflowYaml(def): string`（DagEditor 保存/测试用）

### D-T2-5 线性执行编排（权威 spec §5.5–5.7）

执行链（Task 2 仅线性：每 Stage 顺序执行其 Steps，Stage 间跟 `next`）：

```
startInstance(request)
  1. 读定义（definitions 表）→ parseWorkflowYaml → WorkflowDefinition
  2. 生成 instanceId = YYYYMMDD-HHmmss-xxx；初始化 WorkflowTaskState（pending）
  3. state.put(instanceId, snapshot)；创建宿主 Session（若组合提供 sessions 服务）
  4. fire-and-forget execute()（不 await 引擎主循环，RPC 立即返回 DagRun）
  5. execute()：
     a. status→running；emit sandore/start
     b. Stage 循环（线性）：
        i.  emit sandore/stage-start
        ii. StageExecutor.execute(stage)：Stage 内顺序执行每个 Step：
            - emit sandore/step-start（childId 合成，见 D-T2-7）
            - StepRunner.run(step)：shell → ctx.shell.resolve+run；
              prompt → ctx.llm.stream（结构化提示词，权威 spec §6.2 模板）
            - 成功：executedSteps.push(记录) + emit sandore/step-completed
            - 失败：status→failed + emit sandore/step-failed + end(failed)
        iii. 组装 StageContract → emit sandore/stage-completed
        iv. tryAdvanceStage()：isStageAllDone → 跟 Stage.next 或完成
     c. 全部完成 → status=completed → emit sandore/end
     d. 每个状态变化后 persistState()（state.put 全量覆盖）
```

- **失败语义**：Step 失败（shell 非零退出 / llm finish error / 超时）→ 整个实例 `failed`（线性无重试）；`error` 记入 `executedSteps[].error` + `stageInfos[].status='failed'`
- **abort**：`abortInstance` 设置 abort 标志，运行中 Step 的 AbortSignal 触发（shell signal / llm signal），主循环退出 → `aborted` 终态 + `sandore/aborted` 事件
- **超时**：Step timeout（定义的分钟数）映射为 AbortController deadline；`defaultTimeoutMs`（Config）兜底
- `pendingQueue`/`visitCounts` 等 DAG 字段在 state schema 中保留（Task 3 用），线性执行时 `pendingQueue` 存当前待执行 stepId

### D-T2-6 RPC 层（权威 spec §6，D2）

`remote.ts` 的 `SandoreRemote` 扩展为（保留 `ping`）：

| 组 | 方法 |
|---|---|
| 定义 | `listDefinitions` / `createDefinition` / `updateDefinition` / `deleteDefinition` / `getYaml` / `updateYaml` |
| Job | `listJobs` / `createJob` / `getJob` / `updateJob` / `deleteJob` |
| 实例 | `listInstances` / `startInstance` / `deleteInstance` / `getInstanceState` / `abortInstance` |
| 产物 | `getArtifacts` |
| Provider | `listProviders` / `listModels`（转发 `ctx.llm`） |

- RPC 层只做参数校验（zod）+ 转发到引擎/存储域，无业务逻辑（对齐 D2：Service 只暴露实例级操作，CRUD 在 RPC 层）
- `createDefinition(yaml)` 内部：解析+验证 YAML → 存 `definitions`（yaml 文本 + 元数据）；非法 YAML 向 Client 抛 `SandoreError`
- `startInstance({ jobId, originalInput, cwd? })`：校验 Job 存在 → 转发 `ctx.sandoreEngine.startInstance` → 返回 `DagRun`
- `deleteJob`/`deleteDefinition` 不级联删除实例（state 表记录保留，权威 spec 未定义级联）

### D-T2-7 事件与 childId（头脑风暴决策 2+3）

- **双发**：每次状态变化 `ctx.emit('sandore/…', info, …)`（Cordis 触发源）+ `session.append('sandore/…', payload)`（宿主 Session log，前端折叠/透传用）。发射用安全包装（对齐 DSH `emitWorkflowEvent`：try/catch 包含 listener 异常）
- **childId 合成规则**：`childId = step-{stepId}-{execId}`（`execId` = crypto.randomUUID() 前 8 位）；`executedSteps[].sessionMeta = { childId, synthetic: true, command: 'shell' | 'prompt' }`
  - `synthetic: true` 标记占位语义：Task 5 前端 renderer 据此区分「真实子代理可跳转 `ctx.sessions.open(childId)`」vs「占位仅内联展示」
  - Task 3 agent Step 用 `ctx.subagents.startContinuable()` 真实 SessionId + `synthetic: false`，语义边界一条线划清
- `StepSessionMeta` schema 相应扩展：`{ childId, synthetic: boolean, command: string }`（替代权威 spec §2.3 的 SDK 文件追踪字段 `{sessionId, inputJson, outputJson, partsJson}`——那是 `@codeagent/sdk` 时代产物，DSH 迁移后无这些文件）

### D-T2-8 LLM 路由三层回退（头脑风暴决策 1）

prompt Step 的 provider/model 解析顺序：

1. Step 定义 `command.value.providerId` + `command.value.modelId`（都写则用）
2. 引擎 Config `defaultProvider` + `defaultModel`（schemastery optional）
3. `ctx.llm.listProviders()[0]` 的 id（再取 `listModels(provider)[0].id` 兜底 model）

全部失败 → `SandoreError('STEP_EXECUTION', 'no LLM provider available')`。回退链在 StepRunner 内实现，配置常量收敛在 Config（「No hardcoded tunables」）。

### D-T2-9 prompt 结构化提示词（权威 spec §6.2 模板，简化版）

Task 2 实现 V2.5 模板的核心 section（主头部 + `## 你的任务` + `## 参考信息`（用户原始需求）+ `## 前置Steps输出与产物`（returnPrompt 逐行缩进 + artifacts 文件列表））；省略「用户补充信息」「任务规则」「agent 参数」（Task 3/4 范围）。llm.stream 输出聚合：收集 `block-end` 的 text block → `ContentBlock[]`（即 `step-completed` 事件的 `output`）。

### D-T2-10 测试策略（头脑风暴决策 4）

- 根 devDependencies 加 `vitest`；`workflow`/`microflow` 包各自 `*.spec.ts`（vitest workspace 由根 `vitest.config.ts` 统一）
- **mock 层**（测试基建，`tests/mocks/`）：
  - 内存 `storageDomain`：实现 `open(spec)` → 内存 `Map` 版 `KvTable`（put/delete/entries 全套），域名校验对齐真实实现
  - fake `llm`：`stream()` 返回预设 chunk 序列（`block-start`/`text-delta`/`block-end`/`finish(stop)`），可注入失败场景（finish error）
  - fake `shell`：`resolve()` 透传、`run()` 返回预设 `ShellRunResult`（成功/非零退出/超时可配置）
  - fake `sessions`：记录 `append` 调用（事件序断言用）
- 测试分层：schema/yaml-parser 单测（类型化错误、V1/V2 转换、引用完整性）→ persistence/CRUD 单测（三表读写、实例派生）→ 引擎集成测试（mock 服务 + 完整 startInstance → completed 线性流、事件序断言、持久化读回）

## Risks / Trade-offs

- [`open()` 异步 + 域名唯一 → 测试并行冲突] → mock 内存域避免真实 open；真实域测试（若有）串行 + 唯一域名后缀
- [`CollectedOutput.truncated` 丢失 shell 输出头部] → StepRunner 记录 `truncated` 标志进 executedSteps（错误诊断可回溯 spillPath）
- [llm 无 adapter 时 prompt Step 抛错 → 测试不可运行] → 三层回退 + mock llm 注入；真实组合下 Config 显式指定
- [fire-and-forget execute() 的未处理 rejection] → 主循环整体 try/catch，失败转 `failed` 终态 + persist + 事件
- [YAML `yaml` 包与 `js-yaml` 选型] → 用 `yaml`（DSH 同款，维护活跃，`parseDocument` 保留行列错误信息）
- [`exactOptionalPropertyTypes` + zod optional 字段交互] → zod `.optional()` 输出 `T | undefined` 与 TS 交互注意点：持久化记录构造时显式展开条件字段（`...x === undefined ? {} : { x }` 模式，对齐 DSH 源码风格）
- [Task 1 的 `SandoreEngineStub` 被真实 Provider 取代 → 挂载行为变化] → 保留 Stub 导出（测试/骨架场景），新增 `SandoreEngineRuntime extends SandoreEngine` 作为 default export（对齐权威 spec §6.4 命名）；cordis.yml 挂载不变（包 default export 切换为 Runtime）

## Migration Plan

1. 补依赖（`pnpm add`）→ 2. schema.ts + yaml-parser.ts（+单测）→ 3. persistence.ts + remote CRUD（+单测）→ 4. microflow StepRunner/StageExecutor（+单测）→ 5. workflow-engine.ts + dag-navigator.ts（+集成测试）→ 6. typecheck 全绿 + 全量测试
回滚：单 git commit 粒度，任一环节失败 revert 该 feature 即可（feature 间依赖单向）。

## Open Questions

（无——权威规格已覆盖；4 项实现决策已在头脑风暴确认）
