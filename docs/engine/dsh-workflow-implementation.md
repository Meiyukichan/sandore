# 工作流引擎 DSH 插件 — 从零实现拆分计划

> 版本: 0.1.0 | 状态: 实施蓝图 | 最后更新: 2025-07-20
> 前置: [dsh-workflow.md](dsh-workflow.md)（插件化设计）、[dynamic-workflow-engine.md](dynamic-workflow-engine.md)（引擎 v2.6）

## 拆分总览

从零实现拆分为 **13 个 Task、5 个阶段**，每个 Task 有独立可验证的 Done 标准，依赖关系线性递增（后续 Task 不阻塞前序的验证）。

| 阶段 | Task | 标题 | 里程碑（阶段完成即可验证） |
|---|---|---|---|
| **P1 骨架** | T1 | 仓库脚手架 + Service Definition（`sandore` 包） | 包能编译、类型/事件契约定型 |
| | T2 | 最小端到端链路（Provider 桩 + API 桩 + Client 按钮/tab + RPC） | 前端出现「工作流」按钮和视图 tab，RPC 往返通 |
| **P2 引擎最小可用** | T3 | 类型体系 + YAML 解析（V1/V2 + Zod） | 能解析 YAML 为 `WorkflowDefinition`，非法 YAML 报错 |
| | T4 | 定义/Job/实例 CRUD + 引擎骨架 + 存储域持久化 | 能 RPC 创建/列出定义与 Job，实例写入状态快照 |
| | T5 | 线性工作流执行（StageExecutor + shell/prompt Step） | 能跑通一个线性 shell/prompt 工作流 → completed |
| **P3 完整 DAG** | T6 | agent/skill/mcp Step（子代理会话 + 输入 + 产物） | 能执行 agent 类型 Step，产物收集正确 |
| | T7 | 分支评估 + 循环 + 嵌套循环 | 能执行带分支/循环的工作流，迭代路径正确 |
| | T8 | Finalize 拆分（透传变量 + 完成判定/ask + 门禁） | 透传变量提取、门禁审查、ask→askUserQuestion |
| **P4 生命周期** | T9 | 交互（问答/权限/ask）+ 暂停/恢复/中止 | 能暂停/恢复 Step，问答/权限可回复 |
| | T10 | 重试（continue/revert/fork）+ 崩溃恢复 | 能重试失败 Step，重启后恢复 running/交互实例 |
| | T11 | 消息聚合 + 宿主主代理（多 session 讨论数据，D9） | 讨论数据可派生，完成后宿主 Session 自然降级为自由对话 |
| **P5 前端 + 固化** | T12 | WorkflowList + DagEditor（前端列表 + 编排器） | 能通过 UI 创建/编辑工作流定义 |
| | T13 | RunView（多 session 讨论 + 产物 + 交互）+ 挂载固化 | 完整 UI 可用，固化到 cordis.yml，测试齐 |

---

## 阶段 P1 — 骨架与端到端链路

### T1 — 仓库脚手架 + Service Definition

- **目标**：建立 monorepo 包结构，固化 `ctx.sandoreEngine` 的接口契约与事件词汇。
- **范围**：
  - 新建 `packages/sandore/workflow/`（`package.json`、`tsconfig.json`、`src/index.ts`、`src/types.ts`、`src/runtime-types.ts`）。
  - `abstract class SandoreEngine extends Service`（`super(ctx, 'sandoreEngine')`）+ `declare module` 声明 `Context.sandoreEngine` 与 `sandore/*` 事件。
  - 类型定义：`WorkflowDefinition`/`WorkflowStage`/`WorkflowStep`/`DagRun`/`DagStartRequest`/`DagResult`/`StageContract`/`FinalizeAssessResult`/`GateEvalResult`/`DefaultSessionMeta`/`AskUserQuestionPayload`（对齐 dynamic-workflow-engine.md §3）。
- **不做**：具体引擎实现、任何 DSH 服务调用。
- **Done 标准**：`pnpm run typecheck` 通过；`SandoreEngine` 可被 import；事件声明可被 `ctx.on('sandore/start', ...)` 类型推导。
- **依赖**：无（起点）。

### T2 — 最小端到端链路（验证 slot 注入 + RPC）

- **目标**：用最小桩跑通「按钮 → tab → host.call → Host 桩 → 返回」整条链路，验证设计决策 D1/D2/D6 可行性。
- **范围**：
  - `workflow`（空 Provider，`export default class ... extends SandoreEngine`，`static Config` 声明）。
  - `workflow`（`@Remote` 注册最小 `sandore.ping` 方法：`SandoreRemote extends TypertRemoteService`，`super(ctx, 'sandore')` + `@Remote('ping')`；`harness.handle` 仅作动态原型验证捷径，不进入产出）。
  - `ui`（Client 插件）：`sidebar.footer.action` 按钮 + 点击展开 WorkflowPanel 占位（D6）+ `host.call('sandore.ping')`。
- **不做**：真实引擎逻辑、真实 CRUD。
- **Done 标准**：挂载后 sidebar 设置上方出现「工作流」按钮；点击展开 WorkflowPanel；`host.call('sandore.ping')` 返回 Host 桩值。
- **依赖**：T1。

---

## 阶段 P2 — 引擎最小可用

### T3 — 类型体系 + YAML 解析

- **目标**：完整实现 `WorkflowDefinition` 的 Zod Schema 与 YAML 解析（V1/V2 双格式 + 兼容转换）。
- **范围**：
  - `sandore` 包的 `types.ts`：全部 Zod Schema + TS 类型（CommandConfig 五种类型、DagBranch/DagLoop、InputFrom/OutputTo、PassThroughVar、Gates、Rules、StageContract 等）。
  - 新建 `workflow/src/yaml-parser.ts`：`parseWorkflowYaml(yaml): WorkflowDefinition`，V1（stage/scenario/task）自动 `convertLegacyToV2()`。
  - 命令类型转换 `commandToPromptType`/`promptToCommandType`。
- **不做**：执行引擎、持久化。
- **Done 标准**：能解析 dynamic-workflow-engine.md 附录 A 的 V2 示例 YAML；V1 示例 YAML 能转换；非法 YAML 抛类型化错误（`ValidationError`）。
- **依赖**：T1。

### T4 — 定义/Job/实例 CRUD + 引擎骨架 + 存储域持久化

- **目标**：实现 `workflow` 的定义/Job CRUD + `workflow` 的实例生命周期骨架 + `work.json` 状态快照持久化。
- **范围**：
  - `workflow`：`listDefinitions/create/update/delete/getYaml/updateYaml` + `listJobs/createJob/...` + `startInstance/getInstanceState/deleteInstance/abortInstance`。
  - 引擎骨架：`DagRun`（id/meta/result/cancel/dispose，对齐 DSH `WorkflowRun` 模式）、实例注册表（`Map<instanceId, DagRun>`）。
  - 持久化：`ctx.storageDomain.open(sandoreStateSpec)`（schema 验证 KV，key=instanceId），`buildState()/persistState()`。
- **不做**：Step 执行、DAG 调度、讨论数据。
- **Done 标准**：能 RPC 创建/列出/删除定义与 Job；`startInstance` 创建实例并写入存储域状态快照（`getInstanceState` 能读回）。
- **依赖**：T2、T3。

### T5 — 线性工作流执行（StageExecutor + shell/prompt Step）

- **目标**：跑通第一个真实执行链路——线性 Stage→Step 工作流（无分支/循环）。
- **范围**：
  - `workflow`：`WorkflowEngineV2`（Stage 级编排主循环）+ `StageExecutor`（Stage 内部顺序执行 Step）+ `WorkflowDagNavigator`（节点索引 + `isStageAllDone` + `tryAdvanceStage` + `finalizeStageContract`）。
  - `WorkflowStepRunner` 先支持 **shell** 与 **prompt** 两种类型：shell 用 `ctx.shell.resolve()/run()`（简单命令）或 `ctx.subprocess.spawn()`（stdin 注入）；prompt 用 `ctx.llm.stream()`。
  - `sandore/*` 事件发射（start/stage-start/stage-completed/step-start/step-completed/end）。
- **不做**：agent/skill/mcp 类型、分支、循环、finalize、交互、恢复。
- **Done 标准**：能执行一个「shell Step → prompt Step」的线性工作流，实例状态 `running → completed`，`sandore/*` 事件按序发射，产物写入实例目录。
- **依赖**：T4。

---

## 阶段 P3 — 完整 DAG 能力

### T6 — agent/skill/mcp Step（子代理会话 + 输入构建 + 产物收集）

- **目标**：补齐 Step 执行器的 agent 类型（核心），以及 skill/mcp 类型。
- **范围**：
  - agent 类型：`ctx.subagents.startContinuable()`（parent=工作流宿主，首条结构化提示词投递）→ 监听 `subagent/end`/Session 事件等待 idle → 从子代理 Session 派生输出（`readOutput`）。
  - `buildStepInputMessages()`：jobRequirement + 前置 Step 输出（`inputFrom` 路径解析 + `resolvePathSegments` 就近匹配）+ `replacePassThroughVars`。
  - `collectStepArtifacts()`：outputTo 的 path/regex/glob 产物收集（`ctx.fs` + `findFilesByGlob/Regex`）。
  - skill/mcp：名称校验（工作流级 `skills`/`mcps` 数组）+ prompt 前缀。
- **不做**：分支、循环、finalize。
- **Done 标准**：能执行 agent 类型 Step（子代理真实跑一轮），`inputFrom` 引用前置输出正确，产物收集到 `{uuid}_output.json`。
- **依赖**：T5。

### T7 — 分支评估 + 循环 + 嵌套循环

- **目标**：实现 DAG 的 `condition`+`branches` 与 `loop` 调度。
- **范围**：
  - `BranchEvaluator`：两阶段（start/collect），agent 分支用 `ctx.llm.stream()`，shell 分支用 `ctx.shell.run()`；`extractExpectation`/`extractBreakResult` 解析；`matchesExpectation`。
  - `WorkflowLoopManager`：`activeLoopStack`/`activeLoopIterationStack`、ID 后缀（`loopIdSuffix`）、`checkLoopBreak`（maxIterations + breakCondition）、扁平 `executedSteps` + `loopIteration`/`loopMeta`。
  - `resolveNextNodes` 优先级：Loop > Branches > Next > tryAdvanceStage（跨阶段隔离）。
- **不做**：finalize、交互、重试。
- **Done 标准**：能执行「条件分支」与「循环（含嵌套）」工作流，分支走向正确、循环迭代路径 `loopIteration` 正确、maxIterations 硬上限生效。
- **依赖**：T6。

### T8 — Finalize 拆分（透传变量 + 完成判定/ask + 门禁）

- **目标**：实现 v2.6 的收尾拆分（`FinalizeAssessor` + `GateEvaluator`）+ 透传变量系统。
- **范围**：
  - `FinalizeAssessor`（收尾第 1 部分）：fork 会话（session 类型 Step 用 `ctx.sessions.create({seed})` fork，shell 用临时 `ctx.llm.stream()`）→ 完成判定（`completed`/`ask`）+ 透传变量提取，合并为 `FinalizeAssessResult`。
  - `ask` 转换：`completionType='ask'` → 构造 `AskUserQuestionPayload`（对齐 DSH `ask_user_question` schema）→ 注入交互（T9 先接桩）。
  - `GateEvaluator`（收尾第 2 部分）：独立新 session，primary/secondary 双门审查，返回 `GateEvalResult`。
  - `passThroughVars` Map（`initPassThroughVars`/`replaceVars`/`extractVarValues`/`refresh` 标志）+ `resolveOutputToVars` 延迟解析。
- **不做**：交互的真正回复链路（T9）、重试。
- **Done 标准**：Step 完成后能提取透传变量值；门禁失败 Step 标记 failed；`ask` 判定能产出 `AskUserQuestionPayload`。
- **依赖**：T7。

---

## 阶段 P4 — 生命周期能力

### T9 — 交互（问答/权限/ask）+ 暂停/恢复/中止

- **目标**：实现 `WorkflowInteractionManager` + `WorkflowLifecycleManager`，对接 DSH 交互 seam。
- **范围**：
  - 交互：`pendingQuestions`/`pendingPermissions` Map；`addPendingQuestion/Permission` → `sandore/question`/`sandore/permission` 事件；`replyQuestion/replyPermission`。askUserQuestion（T8 产出）与 SDK 原生 question 统一走此管道。
  - 权限：DSH permission presets（子代理继承宿主 Session 的 `sandbox/mode` + `approval/policy`，approval 固定 `never`），不实现 `permissionMode`（bypassPermissions/acceptEdits/default）与手写 `autoReplyPermission`。
  - 生命周期：`pauseStep`（`ctx.subagents.interrupt()` + 会话快照 + `renameStepMessage`）、`resumeStep`（`ctx.subagents.followup()`）、`pauseAll/resumeAll/abort`。
- **不做**：重试（T10）、崩溃恢复（T10）。
- **Done 标准**：运行中的 Step 能暂停/恢复；问答/权限请求能推到前端并经 RPC 回复后继续；askUserQuestion 能走通。
- **依赖**：T8。

### T10 — 重试（continue/revert/fork）+ 崩溃恢复

- **目标**：实现失败 Step 的三种重试模式 + 崩溃恢复（断点续传）。
- **范围**：
  - 重试：`retryFromStep`（销毁旧引擎 → 建新引擎 → `enqueueNode(mode:'retry')`）+ `runner.retry(mode, ...)`（continue=`followup`；revert=`sessions.create({seed: 前缀})` 回退；fork=`sessions.create({seed: fork前缀})`）。
  - 崩溃恢复：`WorkflowRecoveryManager`（A–H 八阶段）+ `restoreFromState()` + `recoverOrphanedInstances()`（启动扫描存储域）。
  - running/interacting → `mode:'recover'` 恢复；paused → 保留等待手动恢复；shell/无 sessionId → 标记 failed。
- **不做**：默认会话（T11）。
- **Done 标准**：失败 Step 能用三种模式重试；进程重启后 running/interacting 实例能恢复继续执行。
- **依赖**：T9。

### T11 — 消息聚合 + 宿主主代理（多 session 讨论数据）

- **目标**：实现 chat.json 语义的 Session 事件化 + 多 session 讨论数据聚合（D8/D9）。
- **范围**：
  - 消息聚合：工作流宿主 Session 承载 `sandore/*` 事件（Step 消息 + 用户消息 + 暂停/恢复 + 循环迭代），`buildSessionParts` 组合。
  - 宿主主代理（D9）：`completed` 后宿主 Session 自然降级为自由对话 agent，**不实现 `DefaultSessionManager`**（无 `mountDefaultSession`/`default-session-mounted` 事件/空闲清理/`buildSessionParts` 注入默认会话）。
  - 讨论查询：`getDiscussion` 从宿主 Session 派生（骨架）+ 子代理 Session 派生（内容）。
- **不做**：前端渲染（T13）。
- **Done 标准**：`getDiscussion` 返回多 session 组合的时间线骨架；宿主 Session 完成后可继续自由对话（主代理自然降级，无额外挂载）。
- **依赖**：T10。

---

## 阶段 P5 — 前端与固化

### T12 — WorkflowList + DagEditor（前端列表 + 编排器）

- **目标**：实现工作流 UI 的列表态与编排态。
- **范围**：
  - `WorkflowList`：定义/Job/实例列表 + CRUD 入口（复用 `ui-primitives`，`host.call` 拉数据）。
  - `DagEditor`：Stage DAG 简化可视化（ui-primitives 节点列表 + 连线示意）+ Step 编辑（命令/输入/输出/透传变量/门禁）+ YAML 预览/保存（`host.call('sandore.updateYaml')`）。
  - 风格：`ctx.theme` + `ctx.locale`（D7 决策）。
- **不做**：执行页（T13）、React Flow 完整 DAG（后续增强）。
- **Done 标准**：能通过 UI 创建/编辑/保存工作流定义，列表实时反映 CRUD。
- **依赖**：T4（CRUD 就绪）、T3（类型）。

### T13 — RunView（多 session 讨论 + 产物 + 交互）+ 挂载固化

- **目标**：实现执行页 + 把插件固化到 cordis.yml 静态组合 + 补齐测试与文档。
- **范围**：
  - `RunView`：执行轨迹（executedSteps + stageInfos 只读）+ **多 session 组合讨论时间线**（§6.4：宿主 Session 骨架 + 子代理 Session 内容，参考 `ui-workflow-run`）+ 产物面板 + 交互/暂停/恢复/重试控件。
  - 挂载固化：cordis.yml 静态组合（`workflow` + `microflow` + `tool` + `ui`），移除动态插件原型。
  - 测试：单元测试（引擎调度/YAML/循环/收尾）+ 关键路径 snapshot/e2e；文档同步。
- **不做**：V3 的 Router/Telecom 等（见 dsh-workflow.md §11）。
- **Done 标准**：完整 UI 可用（列表→编排→执行→讨论→交互）；插件随 cordis.yml 稳定加载；测试与文档齐备。
- **依赖**：T11、T12。

---

## 依赖关系图

```
T1 ──► T2 ──► T3 ──► T4 ──► T5 ──► T6 ──► T7 ──► T8 ──► T9 ──► T10 ──► T11 ──► T13
                          │                                          │
                          └────────────► T12 ───────────────────────┘
```

- **关键并行点**：T12（前端列表/编排器）只依赖 T3/T4，可在 T5–T11 进行时并行开发（前后端并行）。
- **关键串行链**：T5→T6→T7→T8→T9→T10→T11 是引擎核心的严格递增依赖（先跑通线性，再补 DAG，再补收尾，再补生命周期）。

---

## 每个阶段的验证点（增量合入门槛）

| 阶段 | 验证点 |
|---|---|
| P1 | 前端有按钮/tab，RPC 往返通（端到端链路成立） |
| P2 | 能执行线性 shell/prompt 工作流到 completed（引擎最小可用） |
| P3 | 能执行带分支/循环/门禁/透传变量的完整 DAG 工作流 |
| P4 | 暂停/恢复/重试/崩溃恢复/消息聚合（宿主主代理延续）全链路可用 |
| P5 | UI 完整 + 挂载固化 + 测试齐备 |

> **测试策略**（对齐 DSH 约定）：测试随功能走——每个 Task 的 Done 标准里隐含对应单元测试；P5 补关键路径 snapshot/e2e。覆盖率 CI 门槛（每包 100%）在 T13 统一收敛，而非每个 Task 强制。
