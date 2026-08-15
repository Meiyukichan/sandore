# Spec: loop-management — 循环与嵌套循环管理

## ADDED Requirements

### Requirement: 活跃循环栈与迭代路径栈
系统 SHALL 维护 `activeLoopStack: string[]`（活跃循环节点栈）与 `activeLoopIterationStack: number[]`（嵌套迭代路径栈）：进入循环时 push（迭代计数初始化为 1），跳出时 pop（先迭代栈后循环栈）；`activeLoopNodeId` getter SHALL 返回栈顶循环节点 ID。

#### Scenario: 进入与退出循环
- **WHEN** 调度器首次进入带 `loop` 的节点并确定 loopTo 目标
- **THEN** `pushActiveLoop(loopToNodeId)` 压栈（`activeLoopStack=[nodeId]`、`activeLoopIterationStack=[1]`）；跳出时 pop 后两栈均为空

### Requirement: 循环迭代 ID 后缀机制
系统 SHALL 为循环内每次迭代生成 4 位 hex 后缀：`getActualStepId(originalStepId)` 返回 `原始ID-4位hex`，`stripIdSuffix(id)` 去除后缀还原原始 ID，`stepIdSuffixMap` 维护原始 → 后缀映射；同一次迭代内同一原始 ID SHALL 使用同一后缀。

#### Scenario: 迭代生成后缀 ID
- **WHEN** Step `step-abc` 在循环第 1 次迭代执行
- **THEN** executedSteps 条目 `id` 为 `step-abc-49aa` 形式（4 位 hex），`stepId` 为 `step-abc`，再次进入该 Step（同迭代）不生成新后缀

### Requirement: 扁平 executedSteps 与 loopIteration 路径
系统 SHALL 将循环迭代条目直接推入扁平 `executedSteps`（不创建循环容器）：每个条目含 `id`（带后缀）、`stepId`（原始 ID）、`loopIteration: number[]`（`buildLoopIterationPath()` 构建，嵌套如 `[1,2]`）、`loopMeta`（由 `checkLoopBreak` 两阶段写入：`evaluating` → `completed`）。`incrementLoopIteration()` SHALL 递增最内层迭代计数。

#### Scenario: 单层循环迭代路径
- **WHEN** Step 在单层循环第 2 次迭代执行
- **THEN** 条目 `loopIteration = [2]`

#### Scenario: 嵌套循环迭代路径
- **WHEN** 外层循环第 1 次迭代内、内层循环第 2 次迭代中的 Step 完成
- **THEN** 条目 `loopIteration = [1, 2]`

### Requirement: checkLoopBreak 跳出检测
系统 SHALL 按优先级检测循环跳出：① `visitCount >= maxIterations` 硬上限立即返回 true；② 配置了 `breakCondition` 时两阶段评估（agent/prompt/skill/mcp 模式 `extractBreakResult(result) === 'true'` 跳出；shell 模式 `matchesExpectation(breakResult, breakExpectation)` 跳出）。评估上下文 SHALL 注入 `<input>`/`<output>`/`<artifacts>` XML 块（output 截前 4000 字符、缩进 4 格）。

#### Scenario: maxIterations 硬上限
- **WHEN** 循环节点 visitCount 达到 `maxIterations`
- **THEN** 立即跳出（不发起 AI 评估），`resetLoopVisitCounts` + `popActiveLoop` 后按 `exitTo`（或 tryAdvanceStage）推进

#### Scenario: AI breakCondition 判定跳出
- **WHEN** breakCondition 为 agent 类型且评估输出 `"shouldBreak": true`
- **THEN** 跳出循环，loopMeta 写入 `completed` 与评估结果

#### Scenario: shell breakExpectation 匹配
- **WHEN** breakCondition 为 shell 类型且 stdout 匹配 `breakExpectation`
- **THEN** 跳出循环

### Requirement: 循环迭代上下文注入
系统 SHALL 向循环内 Step 注入迭代上下文：Shell 模式注入环境变量 `in-loop-turn`（当前迭代序号，1-based，不在循环中为 0）与 `all-loop-turn`（活跃循环 `maxIterations`，不在循环中为 0）；Agent 会话模式在 `replacePassThroughVars` 中支持 `${in-loop-turn}`/`${all-loop-turn}` 替换。

#### Scenario: Shell 环境变量注入
- **WHEN** 循环内（第 3 次迭代，maxIterations=5）执行 shell Step
- **THEN** 子进程环境变量含 `in-loop-turn=3`、`all-loop-turn=5`

#### Scenario: Agent 提示词变量替换
- **WHEN** 循环内 Step 提示词含 `${in-loop-turn}`/`${all-loop-turn}`
- **THEN** 分别替换为当前迭代序号与 maxIterations；不在循环中时替换为 `0`

### Requirement: 循环目标优先级与跨阶段隔离
系统 SHALL 按 `loop.next` > 分支评估结果 > `node.next`（仅同阶段）的优先级确定循环内跳转目标；Step 级 `next`/`loop`/`branches` 的目标 SHALL 限于同 Stage 内（跨阶段推进仅经 `tryAdvanceStage`）；`exitTo` 省略时 SHALL 由 `tryAdvanceStage()` 自然推进。

#### Scenario: loop.next 优先
- **WHEN** 循环节点同时配置 `loop.next` 与 `node.next`
- **THEN** 循环内跳转目标为 `loop.next`

#### Scenario: 跨阶段目标被隔离
- **WHEN** Step 的 `next` 指向另一 Stage 的节点
- **THEN** 调度器不执行跨 Stage 跳转，由 Stage 完成后 `tryAdvanceStage` 按 Stage 级 next 推进
