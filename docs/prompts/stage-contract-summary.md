# Stage 完成契约摘要（summarizeStageContract）

> 源码：`packages/sandore/workflow/src/dag-navigator.ts:327`（`summarizeStageContract`，private）
> 场景：汇总 Stage 契约为紧凑文本，供 Stage 级 AI 条件作 context（stage-branch-evaluate.md）与 shell 条件 stdin；避免全量 JSON 转储。
> 说明：`errorDetail` 仅存在时输出；`artifacts`/`passThroughVars` 为空时对应节省略；产物无文本摘要时用 `(无文本摘要)`。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{stageName}}` | `contract.stageName` | Stage 名称 |
| `{{stageId}}` | `contract.stageId` | Stage id |
| `{{status}}` | `contract.status` | Stage 状态 |
| `{{errorDetail}}` | `contract.errorDetail` | （可选）错误详情 |
| `{{stepId}}` | `artifact.stepId` | 产物来源 Step id |
| `{{outputToId}}` | `artifact.outputToId` | 产物输出目标 Step id |
| `{{returnPrompt}}` | `artifact.returnPrompt` | 产物文本摘要（缺失时 `(无文本摘要)`） |
| `{{name}}` / `{{value}}` | `contract.passThroughVars` 条目 | 透传变量名与已解析值 |

## 模板全文

```text
Stage: {{stageName}}（{{stageId}}）
状态: {{status}}
（可选）错误: {{errorDetail}}
（有产物时：）
产物:
- step {{stepId1}} → {{outputToId1}}: {{returnPrompt1}}
- step {{stepId2}} → {{outputToId2}}: (无文本摘要)
（有透传变量时：）
透传变量:
- {{name1}}: {{value1}}
- {{name2}}: {{value2}}
```

## 拼接顺序（源码逐元素）

1. `Stage: {{stageName}}（{{stageId}}）` → `状态: {{status}}`
2. （可选）`错误: {{errorDetail}}`
3. （artifacts 非空）`产物:` → 每产物 `- step {{stepId}} → {{outputToId}}: {{returnPrompt 或 (无文本摘要)}}`
4. （passThroughVars 非空）`透传变量:` → 每变量 `- {{name}}: {{value}}`
