# secondary 门禁解析失败纠正提示（buildSecondaryGateCorrectionHint）

> 源码：`packages/sandore/microflow/src/finalize-manager.ts`（`buildSecondaryGateCorrectionHint` + `explainSecondaryGateParse`）
> 场景：secondary 门禁输出不可解析（非合法 `done`/`error`）时，给**同一个门禁子代理** `followup(hint)` 重试（上限 `MAX_SECONDARY_GATE_RETRIES = 2` 次，对齐 batch/loop-break/Phase B retry）；重试耗尽按不通过处理。
> 输出：同门禁模板（`{"gateStatus": "done" | "error", "gateDetail": "..."}`）。
> 说明：**动态携带解析失败原因**——`explainSecondaryGateParse` 诊断具体失败点（非合法 JSON / 缺 gateStatus 字段 / gateStatus 非 done|error）；**合法 `error`（不通过）不算解析失败、不重试**。

## 模板全文（占位：`{{原因}}` = 解析失败诊断）

```text
未能从你的输出中解析出门禁审查结果：{{原因}}。请仅返回 JSON，格式如下：
```json
{"gateStatus": "done", "gateDetail": "..."}
```
或
```json
{"gateStatus": "error", "gateDetail": "..."}
```
其中，`gateStatus` 为审查结论（`done` = 通过，`error` = 不通过），`gateDetail` 为审查说明。
```

## 失败原因诊断（explainSecondaryGateParse）

| 场景 | 原因文本 |
|------|----------|
| `gateStatus` 为 `done` / `error` | 无（合法结论，不触发纠正；`error` 为合法不通过） |
| 输出非合法 JSON（裸 + fence 剥离后均失败） | `输出既不是合法 JSON，也不包含门禁审查结果` |
| JSON 合法但缺 gateStatus 字段 | `输出缺少 gateStatus 字段` |
| gateStatus 存在但非 done/error（如 `"yes"`） | `gateStatus 必须是 done 或 error` |
