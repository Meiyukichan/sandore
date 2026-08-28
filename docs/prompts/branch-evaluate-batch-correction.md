# 批量分支解析失败纠正提示（buildShouldExecuteCorrectionHint）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts`（`buildShouldExecuteCorrectionHint` + `explainShouldExecuteBatchParse`）
> 场景：批量分支判断输出不可解析时，给**同一个 fork 子代理** `followup(hint)` 重试（上限 `MAX_BRANCH_EVAL_RETRIES = 2` 次）；降级（llm.stream）路径同样追加该提示；无占位符。
> 输出：同批量模板（`{"shouldExecute": ["branchId1", "branchId2"]}`）。
> 说明：**动态携带解析失败原因**——`explainShouldExecuteBatchParse` 诊断具体失败点（非合法 JSON / 缺 shouldExecute 字段 / 非字符串数组 / 数组内容不可解析），拼接进提示首句；格式与批量模板返回格式节完全一致（```json 围栏 + 同措辞）。

## 模板全文（占位：`{{原因}}` = 解析失败诊断）

```text
未能从你的上一轮输出中解析出 shouldExecute 数组：{{原因}}。请仅返回 JSON，格式如下：
```json
{"shouldExecute": ["branchId1", "branchId2"]}
```
其中，`shouldExecute` 为满足执行条件的分支的 `branchId` 列表。若没有分支满足条件，请返回：
```json
{"shouldExecute": []}
```
```

## 失败原因诊断（explainShouldExecuteBatchParse）

| 场景 | 原因文本 |
|------|----------|
| JSON 解析成功且 shouldExecute 为字符串数组 | 无（解析成功，不触发纠正） |
| 输出非合法 JSON（含 fence 剥离后）且无 shouldExecute 数组 | `输出既不是合法 JSON，也不包含 shouldExecute 数组` |
| JSON 合法但缺 shouldExecute 字段 | `输出 JSON 中缺少 shouldExecute 字段` |
| shouldExecute 存在但非字符串数组（布尔/数字/对象等） | `shouldExecute 不是字符串数组（应为分支 id 列表，如 ["branchId1", "branchId2"]）` |
| 文本中含 shouldExecute 数组标记但内容不可解析 | `shouldExecute 数组内容无法解析为字符串列表` |
