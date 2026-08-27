# 批量条件分支评估提示词（buildBatchBranchPrompt）

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
