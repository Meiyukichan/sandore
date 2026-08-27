# Phase B JSON 重试纠正提示（FINALIZE_JSON_RETRY_HINT）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts:451`（`FINALIZE_JSON_RETRY_HINT`）
> 场景：Phase B 收尾输出不可解析时，给**同一个 fork 子代理** `followup(hint)` 重试（上限 `MAX_FINALIZE_JSON_RETRIES = 3` 次，超限报错 Step 落 failed）；无占位符。
> 输出：同 Phase B 模板（`{"passThroughVars": {...}, "compressedOutput": "..."}`）。

## 模板全文

```text
未能从你的输出中解析出合法的收尾处理 JSON。请严格按以下格式返回（用 ```json ``` 代码围栏包裹，围栏内只放 JSON）：
```json
{"passThroughVars": {}, "compressedOutput": "..."}
```
```
