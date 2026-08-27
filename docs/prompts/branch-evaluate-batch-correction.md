# 批量分支解析失败纠正提示（SHOULD_EXECUTE_CORRECTION_HINT）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts:143`（`SHOULD_EXECUTE_CORRECTION_HINT`）
> 场景：批量分支判断输出不可解析时，给**同一个 fork 子代理** `followup(correctionHint)` 重试（上限 `MAX_BRANCH_EVAL_RETRIES = 2` 次）；无占位符。
> 输出：同批量模板（`{"shouldExecute": ["branchId1", "branchId2"]}`）。

## 模板全文

```text
未能从你的上一轮输出中解析出 shouldExecute 数组，请仅返回 JSON：{"shouldExecute": ["branchId1", "branchId2"]}，其中 branchId 为满足执行条件的分支。若没有分支满足条件，请返回 {"shouldExecute": []}。
```
