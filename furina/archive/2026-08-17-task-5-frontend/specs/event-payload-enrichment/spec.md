# Spec: event-payload-enrichment

## ADDED Requirements

### Requirement: step-* 事件 payload 含 step 名称
6 个 `sandore/step-*` Session 事件（`step-start`/`step-completed`/`step-failed`/`step-paused`/`step-resumed`/`step-retried`）payload SHALL 含必填字段 `name: string`（该 Step 定义的人类可读名称，来自引擎闭包内的 step 定义），使前端讨论节点折叠态零 RPC 补偿即可显示可读名称。

#### Scenario: 事件携带名称
- **WHEN** 引擎 append 任一 `sandore/step-*` 事件
- **THEN** payload 含 `name` 字段且为非空字符串（如 `分析`），与被执行 Step 定义的 `name` 一致

### Requirement: step-* 事件 payload 含循环迭代路径
处于循环内的 Step 触发 `sandore/step-*` 事件时，payload SHALL 含可选字段 `loopIteration?: number[]`（末尾位置，嵌套循环路径语义：`[1,2]` = 第 1 次循环第 2 次迭代）；非循环 Step SHALL 省略该字段。

#### Scenario: 循环内 Step 事件
- **WHEN** 循环体内 Step 的第 2 次迭代触发 `sandore/step-start`
- **THEN** payload 含 `loopIteration: [2]`（或嵌套时的完整路径数组）

#### Scenario: 非循环 Step 事件
- **WHEN** 不在任何循环内的 Step 触发 `sandore/step-completed`
- **THEN** payload 不含 `loopIteration` 键

### Requirement: 双声明类型同步
`seam.ts` 的 Cordis `Events` 声明与 `SessionEventMap` 合并声明 SHALL 同步更新 `name`/`loopIteration` 字段；既有引擎测试断言 SHALL 更新以覆盖新字段。

#### Scenario: 类型声明一致
- **WHEN** TypeScript 编译 `workflow` 包
- **THEN** 6 个事件的两种声明（Cordis Events / SessionEventMap）payload 类型均含 `name: string` 与 `loopIteration?: number[]`

#### Scenario: 引擎测试覆盖
- **WHEN** 运行 `workflow` 包 vitest
- **THEN** step 事件相关测试断言 name（及循环场景下的 loopIteration）存在且全绿
