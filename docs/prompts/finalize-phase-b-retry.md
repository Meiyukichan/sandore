# Phase B JSON 重试纠正提示（buildFinalizeRetryHint）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts`（`buildFinalizeRetryHint` + `explainFinalizeResultParse`）
> 场景：Phase B 收尾输出不可解析时，给**同一个 fork 子代理** `followup(hint)` 重试（上限 `MAX_FINALIZE_JSON_RETRIES = 3` 次，超限报错 Step 落 failed）；无占位符。
> 输出：同 Phase B 模板（`{"passThroughVars": {...}, "compressedOutput": "..."}`）。
> 说明：**动态携带解析失败原因**——`explainFinalizeResultParse` 诊断具体失败点（非合法 JSON / 缺 compressedOutput 字段或非字符串），拼接进提示首句；格式与 Phase B 返回格式节一致。

## 模板全文（占位：`{{原因}}` = 解析失败诊断）

```text
未能从你的输出中解析出合法的收尾处理 JSON：{{原因}}。请严格按以下格式返回（用 ```json 代码围栏包裹，围栏内只放 JSON）：
```json
{"passThroughVars": {}, "compressedOutput": "..."}
```
```

## 失败原因诊断（explainFinalizeResultParse）

| 场景 | 原因文本 |
|------|----------|
| JSON 解析成功（含 fence 剥离）且 compressedOutput 为字符串 | 无（解析成功，不触发纠正） |
| 输出非合法 JSON（裸 + fence 剥离后均失败） | `输出既不是合法 JSON，也不包含收尾处理字段` |
| JSON 合法但 compressedOutput 缺失或非字符串 | `输出缺少 compressedOutput 字段（或不是字符串）` |
