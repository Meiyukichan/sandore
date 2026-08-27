# 逐条条件分支评估提示词（buildBranchPrompt）

> 源码：`packages/sandore/microflow/src/branch-evaluator.ts:152`（`buildBranchPrompt`）
> 场景：Step 级单分支条件判断（agent/prompt/skill/mcp 四类 AI 条件，`startAi`/`evaluate` 两阶段接口）；判断走 fork 当前 step 会话 + 全量历史注入（fork 失败降级一次性临时会话）。
> 输出：`extractShouldExecute` 两层解析 → `{"shouldExecute": bool}`；解析失败触发重试或按 false 处理。
> 注意：与批量模板（branch-evaluate-batch.md）字段互不复用；循环跳出走专用 shouldBreak 模板（loop-break.md）。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | 条件 `condition.value.promptText`（`BranchEvalOptions`） | 分支判断任务（原样注入；`${xxx}` 透传变量已替换） |
| `{{label}}` | `branch.label ?? branch.next` | 每个候选分支展示名；分支列表为空时注入 `（无显式分支，请依据任务判断返回 shouldExecute）` |

## 模板全文

```text
你是严谨准确的DAG分支评估Agent，你的任务是根据分支条件与上下文，判断本次执行应路由到哪个分支。

## 你的任务
{{taskText}}

## 候选分支
（无显式分支，请依据任务判断返回 shouldExecute）
- {{label1}}
- {{label2}}

## 返回格式
请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否执行当前候选分支。

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度思考，你的职责是尽快判断分支并返回结果
```

## 拼接顺序（源码逐元素）

1. `BRANCH_PROMPT_HEADER`（上文首行）
2. 空行 → `## 你的任务` → `{{taskText}}` → 空行
3. `## 候选分支`：无分支 → 占位提示行；有分支 → 每分支 `- {{label ?? next}}`
4. 空行 → `## 返回格式` → shouldExecute JSON 要求行
5. 空行 → `## 红线规则` → `BRANCH_RED_LINES` 两条
