# 批量条件分支评估提示词（buildBatchBranchPrompt）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts:195`（`buildBatchBranchPrompt`）
> 场景：Step 级多条 AI 条件分支一次 fork 批量评估（`evaluateConditions` 批量路径——**生产唯一路径**）；`branchId` = 分支 `next`（唯一且与路由目标一致），`executeCondition` 取 condition 的 `promptText`（回退 label → next）。
> 输出：`extractShouldExecuteBatch` 三层解析 → `{"shouldExecute": ["branchId1", "branchId2"]}`；解析失败最多 2 次 followup 纠正（见 branch-evaluate-batch-correction.md）。
> 注意：逐条模板（branch-evaluate-single.md）为遗留接口（生产不用，仅 spec 覆盖）。
> **2026-08-25：本文件头部为修正版（对齐 step-execute.md v6 结构骨架），下半部分为原版 v1（保留供对照）。**

## 修正版（2026-08-25 讨论定稿）

### 模板全文（修正版，fork 版——无降级上下文）

```text
当前 Step 已执行完成。请根据它的执行过程，判断下列分支中哪些满足其执行条件。必须先明确以下三点，再开始执行：
- `## 你的任务` —— 本次分支判断要达成的**唯一目标**。
- `## 分支执行条件` —— 需要判断的分支及其执行条件。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
根据 `## 分支执行条件` 与执行上下文，判断哪些分支满足其执行条件。

## 分支执行条件
```json
[
    {
        "branchId": "{{branchId1}}",
        "executeCondition": "{{executeCondition1}}"
    },
    {
        "branchId": "{{branchId2}}",
        "executeCondition": "{{executeCondition2}}"
    }
]
```

## 返回格式
请仅返回 JSON，格式如下：
```json
{"shouldExecute": ["branchId1", "branchId2"]}
```

其中，`shouldExecute` 为满足其 `executeCondition` 条件的分支的 `branchId` 列表。

## 红线规则
- 禁止编辑、创建或删除任何文件
```

### 降级版（fork 不可用时注入 step 执行输出）

fork 降级（事件源缺失/无闭合 turn/创建抛错 → `llm.stream` 临时会话，无 fork 历史）时，提示词插入 `## 参考信息` 节（v6 `<ReferenceInfo>` 块，含当前 step 执行输出），头部三点列表同步加「参考信息」点：

```text
- `## 你的任务` —— 本次分支判断要达成的**唯一目标**。
- `## 分支执行条件` —— 需要判断的分支及其执行条件。
- `## 参考信息` —— 当前 Step 的执行输出，按需查阅。
- `## 返回格式` —— 必须返回的 JSON 格式。

## 你的任务
根据 `## 分支执行条件` 与执行上下文，判断哪些分支满足其执行条件。

## 参考信息
<ReferenceInfo>
  <Reference title="你正在执行的Step: {{stepId}} (id: {{stepId}})">
    <Output>
      {{step 执行输出（finalAssistantOutput 提取，转义后）}}
    </Output>
  </Reference>
</ReferenceInfo>
```

事件源缺失/无输出时降级提示词退回 fork 版（无参考信息节）。

### 占位符参数（修正版）

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{branchId}}` | `branch.next` | 分支 id（与路由目标一致） |
| `{{executeCondition}}` | `condition.value.promptText`（回退 label → next） | 分支执行条件文本；**经 `replacePassThroughVars` 替换 `${xxx}` 透传变量**（值为空/未定义保留占位符） |
| `{{stepId}}` | `BranchEvalOptions.stepId` | 降级上下文块内当前 step id |

### 设计要点（修正版）

- **结构骨架对齐 step-execute v6**：头部「先明确以下三点」+ 分节；删除固定角色声明（「你是严谨准确的DAG分支评估Agent」）。
- **开场表述执行机制（时序）**：判断发生在 **Step 执行完成之后**（Phase D 路由）——fork 成功时判断者（`forkStepSubagent` 重建的宿主子代理）继承当前 step 完整执行历史；**降级（临时会话无历史）时按 v6 格式注入 step 执行输出**（`buildDegradedContext`：事件 → `finalAssistantOutput` 提取 → `<ReferenceInfo>` 块），弥补上下文缺失。
- **透传变量替换**：`executeCondition` 经 `replacePassThroughVars` 替换（loop 上下文变量经 `resolvePassThroughVars` 解析）；**值为空保留占位符**（防路径粘连，模型可见「变量未解析」）。
- **三点 = 你的任务 / 分支执行条件 / 返回格式**（降级时插入「参考信息」点）；无用户指令/任务规则。
- **红线规则暂保留**（讨论点）：判断子代理带完整工具，只读约束（禁止编辑文件）防误操作。

### 与 v1 差异摘要

| # | 项 | v1 | 修正版 |
|---|-----|-----|--------|
| 1 | 角色声明 | 「你是严谨准确的DAG分支评估Agent」 | 删除（不注入角色） |
| 2 | 头部 | 角色声明直接开场 | 时序开场 + 行动引导 + 三点职责列表 |
| 3 | 分节 | 分支执行条件 / 返回格式 / 红线 | 新增 `## 你的任务` 节；**降级时插入 `## 参考信息`（v6 块）** |
| 4 | 变量替换 | 无（executeCondition 原样） | `replacePassThroughVars` 替换（空值保留占位符） |
| 5 | 红线 | 一条（禁止编辑文件） | 暂保留（讨论中） |

---

## 原版 v1（保留，供对照）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts:195`（`buildBatchBranchPrompt`）
> 场景：Step 级多条 AI 条件分支一次 fork 批量评估（`evaluateConditions` 批量路径）；`branchId` = 分支 `next`（唯一且与路由目标一致），`executeCondition` 取 condition 的 `promptText`（回退 label → next）。
> 输出：`extractShouldExecuteBatch` 三层解析 → `{"shouldExecute": ["branchId1", "branchId2"]}`；解析失败最多 2 次 followup 纠正（见 branch-evaluate-batch-correction.md）。
> 注意：逐条模板（branch-evaluate-single.md）保持不动（startAi/evaluate 两阶段接口依赖）。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{branchId}}` | `branch.next` | 分支 id（与路由目标一致） |
| `{{executeCondition}}` | `condition.value.promptText`（回退 label → next） | 分支执行条件文本 |

## 模板全文

```text
你是严谨准确的DAG分支评估Agent，你的任务是根据`分支执行条件`与上下文，判断哪些分支满足其执行条件。

## 分支执行条件
```json
[
    {
        "branchId": "{{branchId1}}",
        "executeCondition": "{{executeCondition1}}"
    },
    {
        "branchId": "{{branchId2}}",
        "executeCondition": "{{executeCondition2}}"
    }
]
```

## 返回格式
请仅返回 JSON，格式如下：
```json
{"shouldExecute": ["branchId1", "branchId2"]}
```

其中，`shouldExecute` 为满足其 `executeCondition` 条件的分支的 `branchId` 列表。

## 红线规则
- 禁止编辑、创建或删除任何文件
```

## 拼接顺序（源码逐元素）

1. 头部行（上文首行）
2. 空行 → `## 分支执行条件` → ``` json 围栏（`JSON.stringify(branches.map(b => ({branchId: b.next, executeCondition})) , null, 4)`）
3. 空行 → `## 返回格式` → `请仅返回 JSON，格式如下：` → ``` json 围栏 `{"shouldExecute": ["branchId1", "branchId2"]}`
4. 空行 → `其中，shouldExecute 为满足其 executeCondition 条件的分支的 branchId 列表。`
5. 空行 → `## 红线规则` → `- 禁止编辑、创建或删除任何文件`
