# 循环跳出判断提示词（buildBreakPrompt）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts:247`（`buildBreakPrompt`）
> 场景：循环 `breakCondition`（agent/prompt/skill/mcp 四类 AI 条件）；判断走 fork 当前 step 会话 + 全量历史注入（fork 失败降级一次性临时会话）。
> 输出：`extractBreakResult` 三级解析 → `{"shouldBreak": bool}`（供 LoopManager 复用）。
> 注意：**不复用**条件分支 shouldExecute 模板——循环跳出与条件分支分场景字段互不复用。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | `breakCondition.value.promptText` | 跳出条件判断任务（原样注入；`${xxx}` 透传变量已替换） |

## 模板全文

```text
你是严谨准确的循环跳出判断Agent，你的任务是根据用户配置的跳出条件与当前循环体的输入输出，判断是否应该跳出当前循环。

## 你的任务
{{taskText}}

## 返回格式
请仅返回 JSON，格式为：{"shouldBreak": true} 或 {"shouldBreak": false}，其中 shouldBreak 表示是否应该跳出当前循环。

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度思考，你的职责是尽快判断是否跳出并返回结果
- 如果当前循环体实际未完成目标，禁止擅自判定跳出
```

## 拼接顺序（源码逐元素）

1. `BREAK_PROMPT_HEADER`（上文首行）
2. 空行 → `## 你的任务` → `{{taskText}}` → 空行
3. `## 返回格式` → shouldBreak JSON 要求行
4. 空行 → `## 红线规则` → `BREAK_RED_LINES` 三条
