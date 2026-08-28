# 循环跳出解析失败纠正提示（buildBreakCorrectionHint）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts`（`buildBreakCorrectionHint` + `explainBreakResultParse`）
> 场景：循环跳出 `shouldBreak` 输出不可解析时，给**同一个 fork 子代理** `followup(hint)` 重试（上限 `MAX_BREAK_EVAL_RETRIES = 2` 次，对齐批量条件分支）；降级（llm.stream）路径同样追加该提示；重试耗尽 warn + 按「不跳出」处理。
> 输出：同 loop-break 模板（`{"shouldBreak": true}` / `{"shouldBreak": false}`）。
> 说明：**动态携带解析失败原因**——`explainBreakResultParse` 诊断具体失败点（非合法 JSON / 缺 shouldBreak 字段 / 非布尔值），拼接进提示首句；格式与 loop-break.md 返回格式节完全一致。

## 模板全文（占位：`{{原因}}` = 解析失败诊断）

```text
未能从你的上一轮输出中解析出 shouldBreak：{{原因}}。请仅返回 JSON，格式如下：
```json
{"shouldBreak": true}
```
或
```json
{"shouldBreak": false}
```
其中，`shouldBreak` 表示是否应该跳出当前循环。
```

## 失败原因诊断（explainBreakResultParse）

| 场景 | 原因文本 |
|------|----------|
| JSON 布尔 / 字符串 `true\|false` / regex 命中 | 无（解析成功，不触发纠正） |
| 输出非合法 JSON 且无 shouldBreak 匹配 | `输出中未找到 shouldBreak 布尔值` |
| JSON 合法但缺 shouldBreak 字段 | `输出 JSON 中缺少 shouldBreak 字段` |
| shouldBreak 存在但非布尔（字符串 `"maybe"` 等） | `shouldBreak 不是布尔值（应为 true 或 false）` |
