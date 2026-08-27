# 参数模板填充提示词（buildFillParamsPrompt）

> 源码：`packages/sandore/microflow/src/step-runner.ts:279`（`buildFillParamsPrompt`）
> 场景：agent 定义含 `agentParamsTemplate` 时，先经 fillParams 临时会话（`llm.stream` 直调）按模板填充参数，结果作为「### 当前Step参数」注入主执行提示词。
> 输出：填充后的模板文本（`{{paramsText}}`）。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{originalInput}}` | 引擎 `request.originalInput` | 用户原始需求 |
| `{{前置Steps输出与产物}}` | `renderPreviousOutputs`（见 `step-previous-outputs.md`） | （可选）有前置输出时注入 |
| `{{template}}` | agent 定义 `agentParamsTemplate` | 待填充的参数模板（含 `${xxx}` 占位符） |

## 模板全文

```text
## 输入信息
### 用户原始需求
{{originalInput}}

（可选，有前置输出时注入，见 step-previous-outputs.md：）
{{前置Steps输出与产物}}

## 参数模板
{{template}}

## 你的任务
你的唯一任务是根据这个参数模板，然后根据（## 输入信息）中的信息，
或者你可以进行一定程度的探索后，将参数模板的内容按照模板格式填充后返回这个结果！

## 红线规则
- 禁止编辑或者创建或者删除任何文件
- 禁止过度探索，你的任务是根据已有信息，做足够探索后尽快返回这个参数模板结果
- 不要过度思考，你的职责不是设计或者开发
```

## 拼接顺序（源码逐元素）

1. `## 输入信息` → `### 用户原始需求` → `{{originalInput}}`
2. （可选）`renderPreviousOutputs` 输出
3. 空行 → `## 参数模板` → `{{template}}` → 空行
4. `## 你的任务` → `FILL_PARAMS_TASK`（上文任务指令）→ 空行
5. `## 红线规则` → `FILL_PARAMS_RED_LINES` 三条
