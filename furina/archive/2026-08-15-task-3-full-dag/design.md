# Design: task-3-full-dag — 完整 DAG 能力技术设计

## Context

Task 2 已交付线性基线：`workflow` 包（schema 三层 Zod / YAML V1V2 / 定义与 Job CRUD / 存储域持久化 / Stage 级 `while` 主循环）+ `microflow` 包（`StepRunner` 仅 shell/prompt、`StageExecutor` 顺序 for 循环）。schema 层 Task 3 所需定义（五类 `CommandConfig`、`DagBranch`/`DagLoop`/`Gates`、`WorkflowTaskState` 循环/透传字段）**已全部就绪**，Task 3 的主要工作在**运行逻辑**，不在定义层。

关键现状与差距（经探索核实）：

| 落点 | 现状 | Task 3 |
|---|---|---|
| `microflow/step-runner.ts` | 仅 shell/prompt，agent/skill/mcp 抛 unsupported | agent 走可续接子代理；skill/mcp 名称校验+前缀；fillParams；stdin 注入 |
| `microflow/stage-executor.ts` | 线性 for + 合成 childId | DAG 流控接入 + 真实 childId |
| `workflow/dag-navigator.ts` | `DagNodeRef` 索引已建，仅 `tryAdvanceStage` | `resolveNextNodes`（Loop > Branches > Next > tryAdvanceStage） |
| schema/types | `FinalizeMetaSchema` 缺 V2.6 三字段；3 个结果类型未定义 | 小幅扩展 |
| errors | 缺 `FINALIZE_FAILED`/`GATE_FAILED`/`SESSION_LOST` | 补错误码 |
| 依赖 | microflow 仅 cordis+llm；workflow 缺 dsh-subagent | 补 peerDeps + 结构接缝 |
| 测试 mocks | 有 llm/shell/sessions/storage-domain，无 subagents/agents/subprocess | 新增三类桩 |

硬约束：纯插件不改 DSH 源码；零外部 Agent SDK，全用 `ctx.*` 服务；命名沿用 `ctx.sandoreEngine`/`sandore/*`（13 事件）/`sandore_*`/`sandore.*`/4 包；无 `permissionMode`（子代理继承宿主 preset，approval 固定 `never`）。

权威规格：`docs/design/task-3-full-dag/design.md`（11 节）；`docs/design/task-3-full-dag/work.md`（含用户修订：fillParams、stdin/env 注入完整实现、循环迭代上下文注入均纳入）。

## Goals / Non-Goals

**Goals:**

1. 五类 Step 全部可执行：agent（可续接子代理 + fillParams）、prompt（现状保留）、shell（stdin/env 注入增强）、skill/mcp（校验+前缀）。
2. 分支正确路由：BranchEvaluator 两阶段 + `extractExpectation`/`matchesExpectation`。
3. 循环/嵌套循环：扁平 executedSteps、ID 后缀、`loopIteration` 嵌套数组、maxIterations 硬上限、breakCondition 两阶段评估、迭代上下文注入。
4. Finalize 拆分：Assessor（fork/临时会话）完成判定+透传提取+ask 转换；GateEvaluator 独立 session 双门审查。
5. 产物收集：glob→regex、`{uuid}_output.json`、InputFrom 就近匹配。
6. DAG 调度：`resolveNextNodes` 优先级 + 跨阶段隔离。
7. 完整 DAG 端到端可跑：分支+循环+门禁+透传变量 YAML → 完成。

**Non-Goals:**

- 交互回复路径（`replyQuestion`/`replyPermission` 真实交互、PendingQuestion 注入后的等待循环）——Task 3 仅产出 `askQuestion` 载荷与 `interacting` 状态标记，回复处理属 Task 4。
- 暂停/恢复（`pauseStep`/`resumeStep`/`pauseAllSteps`/`resumeAllSteps`）、重试（`retryStep`）、崩溃恢复（`recoverInstance`/`ctx.agents.resume`）。
- 宿主主代理集成、前端 UI（Task 5）、`tool`/`ui` 包。
- `permissionMode` / 权限自动回复（DSH permission preset 继承已覆盖）。
- 跨 Stage 的 Step 级回边（循环限同 Stage 内；跨阶段由 `tryAdvanceStage` 承接）。

## Decisions

### D1. agent Step 会话模式：可续接子代理（沿用权威规格 D3）

`ctx.subagents.startContinuable({ provider, label, request })` → `ctx.agents.get(childId)` hold 引用 → `child.whenIdle()` → `finalAssistantOutput(child.session.events)`。

- **为何不用 `ctx.llm.stream()`**：Step 需要完整多轮会话（工具调用/权限/问答/冷恢复），临时流式推理无法承载；且 childId 即真实 SessionId，直接支撑 `synthetic: false` 与后续 Task 4 的 followup/interrupt。
- **为何不用一次性 `ctx.subagents.start()`**：一次性子代理跑完即 settle 销毁，无法续接；Step 需要可续接（重试/恢复预留）。
- **等待顺序（坑位规避）**：startContinuable 在 inbox 接受时 resolve（非 turn 开始），因此拿到 childId 后先确认 turn 已投递（首条提示词随 `request.prompt` 走，无需 followup），再 `await whenIdle()`；hold 住 live Agent 引用直到读出 `finalAssistantOutput`（叶子子代理 settle 后被 dispose）。
- **provider 选择**：优先 `command.providerId` > `defaultProvider`，三层回退沿用 Task 2 的 `resolveProviderModel`。

### D2. fillParams：临时会话填充（work.md 修订纳入）

agent 类型且定义 `agentParamsTemplate` 时：先 `ctx.llm.stream()` 临时会话（含禁止编辑/创建/删除文件的红线规则提示词），输入 = 展开的前置 Step 输出 + 参数模板 + 任务指令，输出为填充后参数文本 → 写入 `paramsText` → 进入结构化提示词「### 当前Step参数」子节 → 再投递给子代理。失败回退：临时会话出错时不阻塞 Step，`paramsText = agentParamsTemplate` 原文并记录告警。

### D3. shell stdin/env 注入：`ctx.subprocess.spawn()` 为主、`ctx.shell.run()` 兜底

判定规则：`command.stdin` 存在 **或** `inputFrom` 解析到内容 **或** 有非空透传变量需注入 → `ctx.subprocess.spawn()`（`stdin: { data }` 写入 JSON、`env` 合并）；否则简单命令走 `ctx.shell.run()`。分支 shell 评估同规则（透传变量替换 → 环境变量注入 → stdin 注入三步）。subprocess 接缝按 `shell.ts` 范式做本地结构类型声明（不引 DSH 运行时依赖）。

### D4. 循环扁平化与 ID 后缀（V2.3 规格）

- 每次迭代生成新 4 位 hex 后缀：`step-xxx` → `step-xxx-49aa`；`stepIdSuffixMap` 维护原始→后缀映射；`stripIdSuffix` 反查。
- 迭代条目直接推入扁平 `executedSteps`：`id`（带后缀）、`stepId`（原始）、`loopIteration: buildLoopIterationPath()`（嵌套 `[1,2]`）、`loopMeta` 由 `checkLoopBreak` 单独写入（evaluating → completed）。
- `checkLoopBreak` 优先级：`visitCount >= maxIterations` 硬上限立即 true → breakCondition 两阶段评估（agent 模式 `breakResult === 'true'` 跳出；shell 模式 `matchesExpectation(breakResult, breakExpectation)`）。
- 跳出后：`resetLoopVisitCounts(nodeId)` + `popActiveLoop()`（先迭代栈后循环栈），`exitTo` 入队；`exitTo` 省略则 `tryAdvanceStage` 自然推进。

### D5. Finalize 拆分两会话策略（V2.6 规格）

- **Assessor**：session 类型 Step（agent/prompt/skill/mcp）fork 会话（`ctx.sessions.fork(stepSessionId)`，boundary 省略取最后事件，不落未闭合 turn）；shell 类型用 `ctx.llm.stream()` 临时会话（stdout 作输入）。产出 `FinalizeAssessResult { completionType, passThroughVars, askQuestion?, forkSessionId, assessmentRaw }`。
- **GateEvaluator**：恒开独立新临时会话（`ctx.llm.stream()`），与 Assessor 完全隔离。primary（产物存在+基本完成度 → `taskStatus`）+ secondary（`secondaryEnabled` 时注入 `secondaryPrompt` → `gateStatus`）；`gatesPassed=true` 后再验证 outputTo 文件存在，失败覆盖为 false。
- **ask 路径**：`completionType='ask'` → 提取 `askQuestion` → 构造 `AskUserQuestionPayload`（对齐 DSH `ask_user_question` schema）→ Step 标记 `interacting`（Task 3 不实现等待循环，Task 4 接 InteractionManager）。
- **跳过条件**：无未解析透传变量 + 无门禁 → 直接 `{ type: 'done', completionType: 'completed' }`，零 AI 调用。

### D6. DAG 调度：resolveNextNodes 单一入口

```
resolveNextNodes(node, state):
  1. node.loop 存在 → 循环逻辑（loopTo 优先级：loop.next > 分支评估 > node.next（仅同阶段））
  2. node.branches 存在 → BranchEvaluator 评估 → 匹配 expectation 的分支（无 expectation = 并行分支始终执行）
  3. node.next 存在 → [node.next]
  4. 都无 → tryAdvanceStage()（Stage 级推进；跨阶段隔离：Step 级 next/loop/branches 目标必须同 Stage）
```

`stage-executor.ts` 的线性 for 循环改为由 `resolveNextNodes` 驱动的调度循环；`workflow-engine.ts` 的 Stage 主循环保留（Stage 完成后 `tryAdvanceStage`）。engine 与 stage-executor 的职责切分：engine 管 Stage 间推进与事件/持久化，stage-executor 管 Stage 内 Step DAG。

### D7. InputFrom 就近匹配与产物文件

- 三种路径：`stg-xxx`（Stage 级，倒序）/ `stg-xxx.step-xxx`（Step 级，从当前往前最近匹配，`idMatches` 支持后缀 `actualId === targetId || actualId.startsWith(targetId + '-')`）/ `stg-xxx.step-xxx.opt-xxx`（OutputTo 级）。
- 无 `inputFrom` 回退前一个 Step（`currentFlatIdx - 1`）。
- `outputTo` 产物写入 `{stepMessageId}_output.json`：`{ sessionId, output: { returnPrompt, artifacts: [{id, value: string[]}] } }`；glob/regex 自动区分（含 `*`/`?` 且无 regex 特征 → glob）。

### D8. 结构接缝与依赖声明

- 新增 `microflow/src/subagents.ts` 接缝（`ctx.subagents.startContinuable`/`followup`/`interrupt`/`start` + `ctx.agents.get/create/resume` + `finalAssistantOutput` 结构签名），与 `shell.ts` 同范式：本地 `interface` 声明 DSH 服务形状，运行时由宿主注入，避免硬依赖 DSH 包版本。
- `finalAssistantOutput` 的实现按 DSH 源码规则在接缝内自带（选最后一条非空 assistant message → 回退累计 text-delta → undefined），不 import DSH 内部模块。
- subprocess 接缝并入 `shell.ts`（`SubprocessRuntime` 结构类型）。
- peerDeps：microflow 补 `@deepseek-ai/dsh-subagent`/`@deepseek-ai/dsh-agent`/`@deepseek-ai/dsh-session`；workflow 补 `@deepseek-ai/dsh-subagent`。

### D9. 事件与 childId 升级

- 13 事件沿用；`step-completed.output` 已就位（Task 2），Task 3 保证 agent Step 的 output 填 `finalAssistantOutput` 结果，shell Step 填 stdout 文本块。
- `sessionMeta`：agent/skill/mcp → `{ childId: 真实 SessionId, synthetic: false, command: type }`；prompt → `{ childId: 临时会话标识, synthetic: false, command: 'prompt' }`（Task 2 走 `ctx.llm.stream()` 临时会话——保持现状，`sessionId` 记临时流标识）；shell → `{ childId: null, synthetic: false, command: 'shell' }`（无会话）。

## Risks / Trade-offs

- [startContinuable 的 resolve 时机是 inbox 接受而非 turn 开始] → 拿到 childId 后不假设 turn 已开始；`whenIdle()` 前确保首条提示词已随 `request.prompt` 投递（构造时传入，无需额外 followup）；对 idle-未开始场景，接缝层等待 `child.status === 'running'` 或首事件到达后再 `whenIdle`，超时兜底报 `STEP_TIMEOUT`。
- [叶子子代理 settle 后被 dispose，`child.session` 可能不可读] → 在 settle 前读取 `finalAssistantOutput`：`whenIdle()` resolve 后立即读 events；接缝 mock 与真实 DSH 行为对齐（whenIdle resolve 时事件已入日志）。
- [`sessions.fork` boundary 落在未闭合 turn 内会 OPEN_TURN 错误] → Assessor fork 时省略 boundary（取源最后一条事件）规避；fork 失败降级为临时会话并记录 `finalizeMeta.errorDetail`。
- [分支/循环 AI 评估输出不可控（非 JSON）] → 三级解析（JSON → regex → raw），解析失败按保守分支处理（无匹配分支时走默认 next/tryAdvanceStage），并写 `branchMeta.status='completed', result=raw` 保留现场。
- [嵌套循环扁平化后状态可读性下降] → `loopIteration` 数组 + `loopMeta` 即是审计面；持久化结构不新增容器类型，前端分组（Task 5）按 `loopIteration` 切。
- [subprocess 接缝自声明与 DSH 真实 API 漂移] → 接缝仅声明用到的最小面（spawn/resolveExecutable），字段名与 DSH 源码逐一对照；Task 4 集成期再校验。
- [全量测试依赖 mock 与真实 DSH 行为差异] → mock 严格按探索核实的 DSH 源码行为建模（inbox 接受 resolve、whenIdle 语义、finalAssistantOutput 规则）；端到端验证标准第 4 条覆盖真实组合路径。

## Migration Plan

纯新增 + 局部改造，无数据迁移。分四步落地（与 plan.json features 对应）：

1. 接缝与类型基座：subagents 接缝、subprocess 接缝、schema/types/errors 扩展、peerDeps、测试 mock 桩。
2. Step 执行层：file-utils → step-runner（agent/skill/mcp/fillParams/stdin）→ 产物收集与 InputFrom。
3. 流控层：branch-evaluator → loop-manager → dag-navigator `resolveNextNodes` + stage-executor DAG 化 + engine 接入。
4. 收尾层与端到端：finalize-manager（Assessor + Gate + 编排）→ 完整 DAG 端到端测试。

回滚：git revert 单 commit 粒度；schema 扩展均为可选字段，旧持久化状态兼容（Zod parse 时不校验缺省）。

## Open Questions

（无——范围分歧已在头脑风暴确认并回写 work.md：fillParams / stdin+env 注入 / 循环上下文注入全部纳入。）
