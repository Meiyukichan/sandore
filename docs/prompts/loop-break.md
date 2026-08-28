# 循环跳出判断提示词（buildBreakPrompt）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts`（`buildBreakPrompt`）
> 场景：循环 `breakCondition`（agent/prompt/skill/mcp 四类 AI 条件）；判断走 fork 当前 step 会话 + 全量历史注入（fork 失败降级一次性临时会话，降级时注入 step 执行输出 v6 块）。
> 输出：`extractBreakResult` 三级解析 → `{"shouldBreak": bool}`（供 LoopManager 复用）。
> 注意：**不复用**条件分支 shouldExecute 模板——循环跳出与条件分支分场景字段互不复用。
> **2026-08-25：本文件头部为修正版（对齐 branch-evaluate-batch.md v6 结构骨架），下半部分为原版 v1（保留供对照）。**

## 修正版（2026-08-25 讨论定稿）

### 模板全文（修正版，fork 版——无降级上下文）

```text
当前 Step 已执行完成。请判断是否应该跳出当前循环。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 本次循环跳出判断要达成的**唯一目标**。
- `## 跳出条件` —— 用户配置的跳出条件。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
根据 `## 跳出条件` 与执行上下文，判断是否应该跳出当前循环。

## 跳出条件
{{taskText}}

## 返回格式
请仅返回 JSON，格式如下：
```json
{"shouldBreak": true}
```
或
```json
{"shouldBreak": false}
```

其中，`shouldBreak` 表示是否应该跳出当前循环。

## 红线规则
- 禁止编辑、创建或删除任何文件
```

### 降级版（fork 不可用时注入 step 执行输出）

fork 降级（临时会话无 fork 历史）时，提示词插入 `## 参考信息` 节（v6 `<ReferenceInfo>` 块，含当前 step 执行输出），头部三点列表同步加「参考信息」点——与 branch-evaluate-batch.md 降级版一致。

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | `breakCondition.value.promptText` | 跳出条件（原样注入；`${xxx}` 透传变量已替换——值为空保留占位符） |
| `{{stepId}}` | `BranchEvalOptions.stepId` | 降级上下文块内当前 step id |

### 设计要点（修正版）

- **结构骨架对齐 branch-evaluate-batch v6**：时序开场（当前 Step 已执行完成）+ 头部三点 + 分节；删除固定角色声明（「你是严谨准确的循环跳出判断Agent」）。
- **三点 = 你的任务 / 跳出条件 / 返回格式**——与 batch 对齐：条件单独成节（v1 把条件放「你的任务」节内），框架任务节只描述「根据条件判断是否跳出」。
- **返回格式对齐 batch**：`请仅返回 JSON，格式如下：` + ```json 围栏（true/false 两例）+ 解释行——与 branch-evaluate-batch.md 返回格式节同形态。
- **执行机制**：`startBreakAi` → `dispatchAi`（fork 子代理继承 step 完整历史；降级临时会话注入 step 输出 v6 块，同 batch）。
- **红线规则精简**：仅保留**客观可执行的只读约束**（`禁止编辑、创建或删除任何文件`，与 batch 一致）；删除两条主观性红线——「禁止过度思考，尽快判断」（效率引导，主观不可验证）与「未完成目标禁止擅自跳出」（语义判断标准模糊，AI 无法客观执行；跳出与否应由 `breakCondition` 条件本身决定）。
- 变量替换：`taskText` 经 `replacePassThroughVars` 替换（空值保留占位符，同 batch）。

### 与 v1 差异摘要

| # | 项 | v1 | 修正版 |
|---|-----|-----|--------|
| 1 | 角色声明 | 「你是严谨准确的循环跳出判断Agent」 | 删除（不注入角色） |
| 2 | 头部 | 角色声明直接开场 | 时序开场 + 行动引导 + 三点职责列表 |
| 3 | 分节 | 你的任务（含条件）/ 返回格式 / 红线 | 你的任务（框架）/ **跳出条件（独立节）** / 返回格式 / 红线 |
| 4 | 降级上下文 | 无 | 降级时注入 step 执行输出 v6 块（同 batch） |
| 5 | 红线 | 三条（只读 + 效率 + 未完成禁跳出） | 精简为一条（只读约束；主观性两条删除，与 batch 一致） |

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts:247`（`buildBreakPrompt`）
> 场景：循环 `breakCondition`（agent/prompt/skill/mcp 四类 AI 条件）；判断走 fork 当前 step 会话 + 全量历史注入（fork 失败降级一次性临时会话）。
> 输出：`extractBreakResult` 三级解析 → `{"shouldBreak": bool}`（供 LoopManager 复用）。
> 注意：**不复用**条件分支 shouldExecute 模板——循环跳出与条件分支分场景字段互不复用。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | `breakCondition.value.promptText` | 跳出条件判断任务（原样注入；`${xxx}` 透传变量已替换） |

## 模板全文

```text
你是严谨准确的循环跳出判断Agent，你的任务是根据用户配置的跳出条件与当前循环体的输入输出，判断是否应该跳出当前循环。

## 你的任务
{{taskText}}

## 返回格式
请仅返回 JSON，格式为：{"shouldBreak": true} 或 {"shouldBreak": false}，其中 shouldBreak 表示是否应该跳出当前循环。

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度思考，你的职责是尽快判断是否跳出并返回结果
- 如果当前循环体实际未完成目标，禁止擅自判定跳出
```

## 拼接顺序（源码逐元素）

1. `BREAK_PROMPT_HEADER`（上文首行）
2. 空行 → `## 你的任务` → `{{taskText}}` → 空行
3. `## 返回格式` → shouldBreak JSON 要求行
4. 空行 → `## 红线规则` → `BREAK_RED_LINES` 三条
