# Spec: dag-scheduling — DAG 调度（resolveNextNodes）

## ADDED Requirements

### Requirement: resolveNextNodes 优先级调度
系统 SHALL 提供 `resolveNextNodes(node, state)` 作为 Step 级调度单一入口，按优先级：① Loop（`node.loop` 存在 → 循环逻辑：loopTo 优先级 `loop.next` > 分支评估 > `node.next` 仅同阶段）；② Branches（`node.branches` 存在 → BranchEvaluator 评估 → 路由到 expectation 匹配的分支；省略 `expectation` 的分支为并行分支始终执行）；③ Next（`node.next` 存在 → `[node.next]`）；④ `tryAdvanceStage()`（Stage 级推进）。无匹配分支时 SHALL 走默认推进（node.next 或 tryAdvanceStage）并保留评估现场（`branchMeta`）。

#### Scenario: 分支路由
- **WHEN** 节点配置两个带 expectation 的分支，BranchEvaluator 输出匹配第二个分支
- **THEN** `resolveNextNodes` 返回第二个分支的 `next` 节点

#### Scenario: 并行分支
- **WHEN** 分支列表含无 `expectation` 的分支
- **THEN** 该分支始终纳入下一批执行节点

#### Scenario: 无匹配回退
- **WHEN** 评估输出不匹配任何带 expectation 的分支
- **THEN** 走 `node.next`（如存在）或 `tryAdvanceStage()`，`branchMeta` 记录原始评估结果

### Requirement: 跨阶段隔离
系统 SHALL 将 Step 级跳转目标限于同 Stage 内：`node.next`/`loop` 目标/`branches[].next` 指向其他 Stage 时 SHALL 不执行跨 Stage 跳转，由 Stage 完成后 `tryAdvanceStage()` 按 Stage 级 `next`（或定义数组顺序）推进。

#### Scenario: Step next 指向同 Stage
- **WHEN** Step 的 `next` 指向同 Stage 内另一 Step
- **THEN** 正常跳转

#### Scenario: 循环退出省略 exitTo
- **WHEN** 循环跳出且 `loop.exitTo` 省略
- **THEN** 由 `tryAdvanceStage()` 自然推进到下一 Stage

### Requirement: stage-executor DAG 化
系统 SHALL 将 `StageExecutor` 的线性 for 循环改为 `resolveNextNodes` 驱动的调度循环：从 Stage 首节点（或恢复现场节点）开始，逐节点解析下一批节点入队执行；每 Step 完成后经 `onPersist` 逐条持久化（沿用 Task 2 钩子）；并行分支 SHALL 全部执行后汇合。

#### Scenario: 分支汇合
- **WHEN** 两个并行分支各自完成并指向同一汇合节点
- **THEN** 汇合节点只执行一次

### Requirement: 真实子代理 childId 接入
系统 SHALL 将 `sessionMeta.childId` 从合成占位升级为真实子代理 SessionId：agent/skill/mcp 类型为 `startContinuable` 返回的 childId（`synthetic: false`）；prompt 为临时会话标识；shell 无会话（`childId: null`）。`step-completed` 事件的 `output` SHALL 填最终输出（agent 系：`finalAssistantOutput` 结果；shell：stdout 文本块）。

#### Scenario: agent Step 事件载荷
- **WHEN** agent Step 完成
- **THEN** `sandore/step-completed` 事件含真实 childId 的 sessionMeta 与 `output: ContentBlock[]`（子代理最终输出）
