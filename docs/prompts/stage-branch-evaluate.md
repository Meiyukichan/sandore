# Stage 级路由判断提示词（buildStageBranchPrompt）

> 源码：`packages/sandore/workflow/src/dag-navigator.ts:303`（`buildStageBranchPrompt`，private）
> 场景：Stage 级 `branch.condition`（AI 条件：agent/prompt/skill/mcp）——当前 Stage 完成后评估是否推进到目标 Stage；**一次性会话**（`ctx.llm.stream`，不 fork——Stage 无单一 step 会话可 fork），StageContract 摘要拼进提示词作 context。provider/model 三层回退（条件定义 → 引擎配置 → ctx.llm 目录兜底）。
> 输出：`extractShouldExecute` 解析 → `{"shouldExecute": bool}`；shell 条件走 `matchesExpectation(label)` 不经过本模板。

## 占位符参数

| 参数 | 来源 | 说明 |
|------|------|------|
| `{{taskText}}` | 条件 `value.promptText` | Stage 分支判断任务（原样注入） |
| `{{contractSummary}}` | `summarizeStageContract`（见 `stage-contract-summary.md`） | 当前 Stage 完成契约摘要（Stage 名/状态/产物/透传变量） |

## 模板全文

```text
你是严谨准确的工作流 Stage 路由 Agent，你的任务是根据当前 Stage 的完成契约与分支条件，判断是否应推进到该分支的目标 Stage。

## 你的任务
{{taskText}}

## 当前 Stage 完成契约
{{contractSummary}}

## 返回格式
请仅返回 JSON，格式为：{"shouldExecute": true} 或 {"shouldExecute": false}，其中 shouldExecute 表示是否应推进到该分支的目标 Stage。

## 红线规则
- 禁止编辑、创建或删除任何文件
- 禁止过度思考，你的职责是尽快判断分支并返回结果
```

## 拼接顺序（源码逐元素）

1. `STAGE_BRANCH_PROMPT_HEADER`（上文首行）
2. 空行 → `## 你的任务` → `{{taskText}}` → 空行
3. `## 当前 Stage 完成契约` → `{{contractSummary}}` → 空行
4. `## 返回格式` → shouldExecute JSON 要求行（「是否应推进到该分支的目标 Stage」措辞）
5. 空行 → `## 红线规则` → `STAGE_BRANCH_RED_LINES` 两条
