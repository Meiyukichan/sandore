# Task 3：完整 DAG — agent/skill/mcp Step + 分支 + 循环 + Finalize

在 Task 2 线性执行（shell/prompt）之上，补齐完整 DAG 能力：agent/skill/mcp Step（可续接子代理会话）+ 分支评估 + 循环/嵌套循环 + Finalize 拆分（透传变量 + 完成判定/ask + 门禁审查）。

## 必读（按优先级）
1. `docs/design/task-3-full-dag/design.md` —— Task 3 权威规格（Command 映射、InputFrom/OutputTo、分支/循环、Finalize 拆分、验证标准）
2. `docs/engine/dsh-workflow.md` —— 插件化核心设计（§5.3 Step 执行器映射、§5.3A SDK 全量映射、§5.2 引擎移植映射）
3. `docs/design/overall-design.md` —— 总体设计（D1–D9、§4.3.1 存储域）
4. DSH 源码 `D:\project-code\llm\deepseek-harness` 参考：`packages/workflow/workflow`（子代理模式）、`ctx.subagents`/`ctx.agents`（`startContinuable`/`whenIdle`/`finalAssistantOutput`）、`ctx.llm.stream`

## 硬约束（不可违反）
- **纯插件，不改任何 DSH 源码**；**零外部 Agent SDK**，全用 DSH `ctx.*` 服务
- 命名沿用：`ctx.sandoreEngine` / `sandore/*`（13 事件）/ `sandore_*`（工具）/ `sandore.*`（RPC）/ 4 包

## 产出（`microflow` 为主 + `workflow` 调度）
1. `packages/sandore/microflow/`：**Stage 内部执行能力补全**
   - `step-runner.ts`：agent 类型（`ctx.subagents.startContinuable()` + `child.whenIdle()` 等待 + `finalAssistantOutput(child.session.events)` 读输出）；skill/mcp（工作流级 `skills`/`mcps` 数组名称校验 + prompt 前缀）
   - `branch-evaluator.ts`：两阶段（start/collect），agent 分支用 `ctx.llm.stream()`，shell 分支用 `ctx.shell.run()`；`extractExpectation`/`matchesExpectation`
   - `loop-manager.ts`：`activeLoopStack`/`activeLoopIterationStack`、ID 后缀、`checkLoopBreak`（maxIterations + breakCondition）、扁平 `executedSteps` + `loopIteration`/`loopMeta`
   - `finalize-manager.ts`：`FinalizeAssessor`（fork 会话完成判定 + 透传变量提取 + ask 转换）+ `GateEvaluator`（独立新 session 双门审查）
   - `file-utils.ts`：变量替换 + glob→regex 转换 + OutputTo 产物搜索
2. `packages/sandore/workflow/`：**DAG 调度**
   - `dag-navigator.ts`：`resolveNextNodes` 优先级 Loop > Branches > Next > `tryAdvanceStage`（跨阶段隔离）

## 关键决策
- **D3**：agent 类型 Step 用**可续接子代理**（`ctx.subagents.startContinuable()`），非临时 `ctx.llm.stream()`；分支评估/finalize 的一次性只读临时会话用 `ctx.llm.stream()` 或一次性 `ctx.subagents.start()`
- **等待轮完成**：`child.whenIdle()`（先 `followup` 再 `await whenIdle`，再读 `finalAssistantOutput`）——DSH 权威 per-turn 等待原语
- **shell stdin 注入**：`ctx.subprocess.spawn()`（提供原始 stdio），简单命令才用 `ctx.shell.run()`
- **权限**：无 `permissionMode`；Step 子代理继承宿主 Session 的 permission preset（approval 固定 `never`）
- **事件**：沿用 13 个 `sandore/*` 事件；`step-completed` 增补 `output`（`finalAssistantOutput` 最终结果）

## 验证标准（Task 3 完成门槛）
- agent Step 可续接子代理真实跑一轮，`inputFrom` 引用前置输出正确，产物收集到 `{uuid}_output.json`
- 分支正确路由；循环迭代路径 `loopIteration` 正确（嵌套为数组 `[1,2]`）、maxIterations 硬上限生效
- Finalize：透传变量提取 + `completionType`（completed/ask）+ 门禁审查 + `ask` → `AskUserQuestionPayload`
- 完整 DAG 端到端：带分支 + 循环 + 门禁 + 透传变量的 YAML → 执行 → 正确路由/迭代/收尾 → 工作流完成

先读 `task-3-full-dag/design.md` 全文，再开始实现。
