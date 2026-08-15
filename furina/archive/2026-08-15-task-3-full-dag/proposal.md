# Proposal: task-3-full-dag — 完整 DAG 能力（agent/skill/mcp Step + 分支 + 循环 + Finalize）

## Why

Task 2 已交付线性执行基线（shell/prompt Step + Stage 顺序推进），但 `agent`/`skill`/`mcp` 三类 Step 直接抛 `unsupported step command type`，且无分支路由、无循环、无 Finalize 收尾——工作流只能走「直线」。Task 3 补齐完整 DAG 能力，使 sandore 能执行带分支 / 循环 / 门禁 / 透传变量的真实工作流 YAML。

## What Changes

- **agent/skill/mcp Step 执行**（改造 `microflow/src/step-runner.ts`）：agent 类型走可续接子代理（`ctx.subagents.startContinuable()` → `ctx.agents.get(childId)` → `child.whenIdle()` → `finalAssistantOutput(child.session.events)`），有 `agentParamsTemplate` 时先 `fillParams`（临时 `ctx.llm.stream()` 按模板填充参数）；skill/mcp 做工作流级 `skills`/`mcps` 数组名称校验 + prompt 前缀，不匹配回退纯提示词。
- **shell stdin 注入**（改造 step-runner + branch-evaluator）：有 `inputFrom` 时用 `ctx.subprocess.spawn()` 将解析的 JSON 数组写入子进程 stdin，非空透传变量注入环境变量；简单命令仍走 `ctx.shell.run()`。
- **分支评估**（新建 `microflow/src/branch-evaluator.ts`）：两阶段 start/collect；agent/prompt/skill/mcp 分支用 `ctx.llm.stream()` 临时会话，shell 分支用 `ctx.shell.run()`/`ctx.subprocess.spawn()`（透传变量替换 + 环境变量 + stdin 注入）；`extractExpectation`（JSON→regex→raw）/`extractBreakResult`（public，供循环跳出用）/`matchesExpectation`。
- **循环/嵌套循环**（新建 `microflow/src/loop-manager.ts`）：`activeLoopStack`/`activeLoopIterationStack`、4 位 hex ID 后缀（`stepIdSuffixMap`）、扁平 `executedSteps` + `loopIteration: number[]`（嵌套如 `[1,2]`）+ `loopMeta`、`checkLoopBreak`（maxIterations 硬上限 + breakCondition 两阶段评估）、循环迭代上下文注入（Shell 环境变量 `in-loop-turn`/`all-loop-turn` + Agent `${in-loop-turn}`/`${all-loop-turn}` 变量替换）。
- **Finalize 拆分**（新建 `microflow/src/finalize-manager.ts`）：`FinalizeAssessor`（session 类型 Step fork 会话 `ctx.sessions.fork`，shell 类型临时会话；完成判定 `completionType: completed|ask` + 透传变量提取 + ask 转 `AskUserQuestionPayload`）+ `GateEvaluator`（独立新 session 双门审查 primary/secondary + 产物存在验证）。
- **文件工具**（新建 `microflow/src/file-utils.ts`）：`${xxx}` 透传变量替换（含 `in-loop-turn`/`all-loop-turn`）、glob→regex 转换（`*`→`[^/]*`、`**`→`.*`、`?`→`[^/]`）、`findFilesByGlob`/`findFilesByRegex`/`walkDir` 产物搜索、`{uuid}_output.json` 读写。
- **DAG 调度**（改造 `workflow/src/dag-navigator.ts`）：新增 `resolveNextNodes`，优先级 Loop > Branches > Next > `tryAdvanceStage`（跨阶段隔离）；`stage-executor.ts`/`workflow-engine.ts` 接入分支/循环/finalize 流控与真实子代理 childId。
- **schema/types/errors/依赖扩展**：`FinalizeMetaSchema` 补 `completionType`/`assessResult`/`gateResult`；新增 `FinalizeAssessResult`/`GateEvalResult`/`FinalizeOutcome` 类型；`SandoreErrorCode` 补 `FINALIZE_FAILED`/`GATE_FAILED`/`SESSION_LOST`；microflow/workflow 补 `@deepseek-ai/dsh-subagent` 等 peerDependencies 与 `ctx.subagents`/`ctx.agents`/`ctx.subprocess` 结构类型接缝。

## Capabilities

### New Capabilities

- `agent-step-execution`: agent 类型 Step 执行——可续接子代理（startContinuable/whenIdle/finalAssistantOutput）、fillParams 参数填充、skill/mcp 名称校验与 prompt 前缀、shell stdin/环境变量注入、透传变量替换与结构化提示词。
- `branch-evaluation`: 分支条件两阶段评估（start/collect）——AI 临时会话与 shell 两条路径、extractExpectation/extractBreakResult/matchesExpectation 解析、透传变量/环境变量/stdin 三注入。
- `loop-management`: 循环与嵌套循环——活跃循环栈、迭代路径栈、ID 后缀机制、扁平 executedSteps、checkLoopBreak（maxIterations + breakCondition）、循环迭代上下文注入。
- `finalize-management`: Step 收尾拆分——FinalizeAssessor（fork 会话/临时会话完成判定 + 透传变量提取 + ask 转换）+ GateEvaluator（独立 session 双门审查 + 产物验证）+ finalizeStep 编排。
- `artifact-collection`: 产物收集与输入解析——glob→regex、文件搜索、`{uuid}_output.json` 读写、InputFrom 就近匹配与回退。
- `dag-scheduling`: DAG 调度——resolveNextNodes 优先级（Loop > Branches > Next > tryAdvanceStage）、跨阶段隔离、Stage/Step 统一节点索引驱动。

### Modified Capabilities

（无——Task 2 归档 specs 均为定义/CRUD/持久化/线性执行层面，Task 3 全部为新增能力，不改已有 spec 的需求层。）

## Impact

- **代码**：`packages/sandore/microflow/`（改造 step-runner.ts/stage-executor.ts/errors.ts/index.ts，新建 branch-evaluator.ts/loop-manager.ts/finalize-manager.ts/file-utils.ts）；`packages/sandore/workflow/`（改造 dag-navigator.ts/workflow-engine.ts/schema.ts/types.ts/errors.ts/shell.ts；tests/mocks 新增 subagents/agents/subprocess 桩）。
- **API/事件**：沿用 13 个 `sandore/*` 事件（`step-completed` 的 `output` 已在 Task 2 就位）；无新增 RPC；`sessionMeta` 由合成 childId 升级为真实子代理 SessionId（`synthetic: false`）。
- **依赖**：`microflow`/`workflow` 补 `@deepseek-ai/dsh-subagent`/`@deepseek-ai/dsh-agent`/`@deepseek-ai/dsh-session` peerDependencies 声明（结构类型接缝范式，运行时由宿主提供）。
- **不改**：DSH 源码（纯插件）、Task 4 范围（交互回复/暂停恢复/重试/崩溃恢复）、Task 5 前端。
